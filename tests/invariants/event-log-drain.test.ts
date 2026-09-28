import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { registerHandler, type EventRow, type HandlerResult } from "@/lib/event-log/dispatcher";
import { drainEventLog } from "@/lib/event-log/drain";
import { GOV_ORG, seedGov, sql, lastLine } from "./gov-helpers";

/**
 * Drain genérico do event_log (Task 2, spec webhooks/automação 2026-07-17).
 *
 * Este harness (scripts/test-db.sh) sobe SÓ um Postgres cru — sem PostgREST,
 * sem HTTP — então não existe um `SupabaseClient` real pra passar a
 * `drainEventLog(admin, ...)` (mesma limitação documentada em
 * webhooks-rls.test.ts). `fakeAdminClient()` abaixo é um double mínimo do
 * shape que `drain.ts` efetivamente usa (`.from().select()/.update()` +
 * filtros `.eq/.lte/.in/.or/.order/.limit`), traduzido pra SQL via o mesmo
 * `sql()` (docker exec psql) que o resto da suíte usa — não testa nada além
 * da lógica do drain em si.
 */

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => sqlString(String(x))).join(",")}]::text[]`;
  return sqlString(String(v));
}

type FilterOp = "eq" | "neq" | "lte" | "lt" | "in" | "or";
interface Filter {
  op: FilterOp;
  col?: string;
  val?: unknown;
  raw?: string;
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private mode: "select" | "update" | "insert" | null = null;
  private single = false;
  private selectCols = "*";
  private selectAfterUpdate = false;
  private updateData: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;

  constructor(private table: string) {}

  select(cols: string): this {
    if (this.mode === "update") {
      this.selectAfterUpdate = true;
      this.selectCols = cols;
      return this;
    }
    this.mode = "select";
    this.selectCols = cols;
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.mode = "update";
    this.updateData = data;
    return this;
  }

  /**
   * `insert`, `neq` e `maybeSingle` entraram com o reaper que conta a queda:
   * o evento que morre por ela abre o aviso `event_dead`, e o aviso é escrito
   * por `avisarEventoMorto` (`drain.ts`) com esses três métodos. Sem eles o
   * dublê lançava dentro do `try` do aviso, o aviso falhava CALADO, e o teste
   * que quer ver o aviso não teria como vê-lo.
   */
  insert(data: Record<string, unknown>): this {
    this.mode = "insert";
    this.updateData = data;
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ op: "neq", col, val });
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: "eq", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: "lte", col, val });
    return this;
  }

  /**
   * `lt` entrou quando o dreno passou a devolver evento preso em `processing`
   * (`.lt("updated_at", agora - 10min)`). Sem este método o dublê estoura com
   * "lt is not a function" e `drainEventLog` aborta ANTES de fazer qualquer
   * coisa — os casos abaixo reprovam todos, acusando a lógica do dreno por um
   * buraco do instrumento. Foi exatamente assim que a regressão apareceu.
   */
  lt(col: string, val: unknown): this {
    this.filters.push({ op: "lt", col, val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filters.push({ op: "in", col, val });
    return this;
  }

  or(raw: string): this {
    this.filters.push({ op: "or", raw });
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private buildWhere(): string {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((f) => {
      if (f.op === "eq") return `${f.col} = ${sqlLiteral(f.val)}`;
      if (f.op === "neq") return `${f.col} <> ${sqlLiteral(f.val)}`;
      if (f.op === "lte") return `${f.col} <= ${sqlLiteral(f.val)}`;
      if (f.op === "lt") return `${f.col} < ${sqlLiteral(f.val)}`;
      if (f.op === "in") return `${f.col} in (${(f.val as unknown[]).map(sqlLiteral).join(",")})`;
      if (f.op === "or") {
        // Parses PostgREST-style "col.is.null,col.lte.<iso>" (the only shape drain.ts emits).
        const parts = f.raw!.split(",").map((p) => {
          const [col, kind, arg] = p.split(".") as [string, string, string];
          if (kind === "is" && arg === "null") return `${col} is null`;
          if (kind === "lte") return `${col} <= ${sqlLiteral(arg)}`;
          throw new Error(`fakeAdminClient: unsupported .or() clause: ${p}`);
        });
        return `(${parts.join(" or ")})`;
      }
      throw new Error(`unsupported filter op: ${f.op}`);
    });
    return ` where ${clauses.join(" and ")}`;
  }

  private toSql(): string {
    if (this.mode === "select") {
      let q = `select ${this.selectCols} from public.${this.table}${this.buildWhere()}`;
      if (this.orderCol) q += ` order by ${this.orderCol} ${this.orderAsc ? "asc" : "desc"}`;
      if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
      return q;
    }
    if (this.mode === "update") {
      const setClauses = Object.entries(this.updateData!)
        .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
        .join(", ");
      let q = `update public.${this.table} set ${setClauses}${this.buildWhere()}`;
      if (this.selectAfterUpdate) q += ` returning ${this.selectCols}`;
      return q;
    }
    if (this.mode === "insert") {
      const cols = Object.keys(this.updateData!);
      const vals = cols.map((c) => sqlLiteral(this.updateData![c]));
      return `insert into public.${this.table} (${cols.join(", ")}) values (${vals.join(", ")})`;
    }
    throw new Error("fakeAdminClient: no mode set (.select()/.update() not called)");
  }

  private async execute(): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      const needsRows = this.mode === "select" || this.selectAfterUpdate;
      if (needsRows) {
        // json_agg over a multi-column row inserts line breaks between fields
        // (Postgres row_to_json formatting) — parse the whole trimmed output,
        // not just its last line (lastLine() is for single-line scalars).
        // UPDATE ... RETURNING can't be wrapped as `from (update ...) t` (not
        // valid SQL) — needs a CTE instead.
        const inner = this.toSql();
        const wrapped =
          this.mode === "update"
            ? `with w as (${inner}) select coalesce(json_agg(w), '[]') from w;`
            : `select coalesce(json_agg(t), '[]') from (${inner}) t;`;
        const out = sql(wrapped);
        const linhas = JSON.parse(out) as unknown[];
        return { data: this.single ? (linhas[0] ?? null) : linhas, error: null };
      }
      sql(`${this.toSql()};`);
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function fakeAdminClient(): SupabaseClient {
  return { from: (table: string) => new FakeQuery(table) } as unknown as SupabaseClient;
}

function emitDrainCase(mode: string, eventType = "test.drain_case"): string {
  const out = sql(
    `select public.emit_event('${eventType}', 'test', null, '{"mode":"${mode}"}'::jsonb, '{}'::jsonb, '${GOV_ORG}');`,
  );
  return lastLine(out);
}

function rowState(id: string): {
  status: string;
  attempts: number;
  consumed_by: string[];
  last_error: string | null;
  next_attempt_at: string | null;
} {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (
       select status, attempts, consumed_by, last_error, next_attempt_at
       from public.event_log where id = '${id}'
     ) t;`,
  );
  const rows = JSON.parse(out);
  if (!rows.length) throw new Error(`event_log row ${id} not found`);
  return rows[0];
}

const calls: string[] = [];
registerHandler({
  key: "test-drain-handler",
  events: ["test.drain_case"],
  async handle(row: EventRow): Promise<HandlerResult> {
    calls.push(row.id);
    const mode = String(row.payload.mode ?? "ok");
    if (mode === "error") return { consumer_key: "test-drain-handler", status: "error", detail: "boom" };
    if (mode === "retry")
      return {
        consumer_key: "test-drain-handler",
        status: "retry",
        retry_at: new Date(Date.now() + 3600_000).toISOString(),
      };
    return { consumer_key: "test-drain-handler", status: "ok" };
  },
});

// Segundo handler no mesmo event_type "test.drain_multi": um sempre erra,
// outro sempre pede retry (+1h) — cobre o mix retry+error num mesmo tick.
registerHandler({
  key: "test-drain-multi-err",
  events: ["test.drain_multi"],
  async handle(): Promise<HandlerResult> {
    return { consumer_key: "test-drain-multi-err", status: "error", detail: "multi-boom" };
  },
});
registerHandler({
  key: "test-drain-multi-retry",
  events: ["test.drain_multi"],
  async handle(): Promise<HandlerResult> {
    return {
      consumer_key: "test-drain-multi-retry",
      status: "retry",
      retry_at: new Date(Date.now() + 3600_000).toISOString(),
    };
  },
});

// Handler isolado no event_type "test.drain_retry_no_backoff": pede retry SEM
// retry_at — cobre o fallback de backoff (senão busy-loop a cada tick).
registerHandler({
  key: "test-drain-retry-no-backoff",
  events: ["test.drain_retry_no_backoff"],
  async handle(): Promise<HandlerResult> {
    return { consumer_key: "test-drain-retry-no-backoff", status: "retry" };
  },
});

// Handler do evento que DERRUBA o processo. Não dá para matar o processo do
// teste, então a queda é encenada por fora (a linha volta a `processing` com
// `updated_at` velho, que é o rastro que o worker morto deixa). O handler pede
// `retry` longe para não encerrar o evento por conta própria: assim, quem conta
// tentativa é SÓ o reaper — que é o que se quer medir.
const chamadasDoVeneno: string[] = [];
registerHandler({
  key: "test-drain-veneno",
  events: ["test.drain_veneno"],
  async handle(row: EventRow): Promise<HandlerResult> {
    chamadasDoVeneno.push(row.id);
    return {
      consumer_key: "test-drain-veneno",
      status: "retry",
      retry_at: new Date(Date.now() + 3600_000).toISOString(),
    };
  },
});

/**
 * O rastro de um worker que morreu com o evento em curso: `processing`, com o
 * `updated_at` do claim, e VENCIDO — o claim só pega evento cujo
 * `next_attempt_at` já passou, então é assim que ele fica quando o processo cai.
 */
function encenarQueda(id: string): void {
  // Trigger desligado pela mesma razão do caso 9: ele reescreveria `updated_at`.
  sql(`
    alter table public.event_log disable trigger trg_event_log_touch;
    update public.event_log
       set status = 'processing', updated_at = now() - interval '30 minutes',
           next_attempt_at = null
     where id = '${id}';
    alter table public.event_log enable trigger trg_event_log_touch;
  `);
}

describe("drainEventLog — cron driver genérico do event_log (migration 0037)", () => {
  let idOk: string;
  let idError: string;
  let idDead: string;
  let idRetry: string;
  let idNoHandler: string;
  let idFuture: string;
  let idMulti: string;
  let idRetryNoBackoff: string;

  beforeAll(() => {
    seedGov();
    idOk = emitDrainCase("ok");
    idError = emitDrainCase("error");
    idDead = emitDrainCase("error");
    idRetry = emitDrainCase("retry");
    idNoHandler = emitDrainCase("ok", "test.no_handler");
    idFuture = emitDrainCase("ok");
    idMulti = emitDrainCase("n/a", "test.drain_multi");
    idRetryNoBackoff = emitDrainCase("n/a", "test.drain_retry_no_backoff");

    // Case 3: pré-seta attempts=4 — próximo erro deve levar a status='dead'.
    sql(`update public.event_log set attempts = 4 where id = '${idDead}';`);
    // Case 6: agenda pro futuro — não deve ser tocado neste tick.
    sql(`update public.event_log set next_attempt_at = now() + interval '1 hour' where id = '${idFuture}';`);
  });

  it("processa o batch e devolve um resumo consistente com os estados finais", async () => {
    const summary = await drainEventLog(fakeAdminClient(), { limit: 50 });

    // scanned = ok + error + dead + retry + multi + retry_no_backoff (6);
    // no_handler e future ficam de fora.
    expect(summary.scanned).toBe(6);
    expect(summary.done).toBe(1);
    expect(summary.retried).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.dead).toBe(1);
  });

  it("caso 1 — mode=ok: status='done', consumed_by contém a key", () => {
    const row = rowState(idOk);
    expect(row.status).toBe("done");
    expect(row.consumed_by).toContain("test-drain-handler");
  });

  it("caso 2 — mode=error: status='pending', attempts=1, next_attempt_at no futuro (backoff)", () => {
    const row = rowState(idError);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("boom");
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("caso 3 — mode=error com attempts=4 pré-setado: status='dead', last_error='...boom'", () => {
    const row = rowState(idDead);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5);
    expect(row.last_error).toContain("boom");
  });

  it("caso 4 — mode=retry: status='pending', attempts INALTERADO (0), next_attempt_at ≈ +1h", () => {
    const row = rowState(idRetry);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).not.toBeNull();
    const deltaMs = new Date(row.next_attempt_at!).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);
  });

  it("caso 5 — evento de tipo SEM handler registrado: não é tocado (segue 'pending')", () => {
    const row = rowState(idNoHandler);
    expect(row.status).toBe("pending");
    expect(row.consumed_by).toEqual([]);
    expect(calls).not.toContain(idNoHandler);
  });

  it("caso 6 — next_attempt_at no futuro: não processado neste tick", () => {
    const row = rowState(idFuture);
    expect(row.status).toBe("pending");
    expect(row.consumed_by).toEqual([]);
    expect(calls).not.toContain(idFuture);
  });

  it("caso 7 — dois handlers no mesmo tick (um error, um retry): retry vence mas preserva last_error do erro, sem contar attempt", () => {
    const row = rowState(idMulti);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.last_error).toContain("test-drain-multi-err");
    expect(row.last_error).toContain("multi-boom");
    expect(row.next_attempt_at).not.toBeNull();
    const deltaMs = new Date(row.next_attempt_at!).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);
  });

  it("caso 8 — retry sem retry_at: aplica backoff (não busy-loopa), attempts inalterado", () => {
    const row = rowState(idRetryNoBackoff);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * A linha é marcada `processing` ANTES de o handler rodar, e nada no produto
   * a devolvia: handler que não retorna — processo derrubado, OOM, ida a
   * serviço externo sem timeout — deixava o evento preso para SEMPRE.
   * `job_queue` tem reaper desde sempre; o `event_log` não tinha. Medido em
   * 2026-08-26 com o Redis do debounce inalcançável: `status=processing`,
   * `attempts=0`, `consumed_by` vazio, material do tenant nunca preparado.
   */
  it("caso 9 — evento preso em `processing` há mais de 10 min volta para `pending`", async () => {
    const preso = emitDrainCase("ok");
    // O TRIGGER `trg_event_log_touch` (BEFORE UPDATE) reescreve `updated_at =
    // now()` em TODA atualização — é exatamente ele que torna a janela do
    // reaper confiável em produção (a linha carrega o instante do claim), e é
    // ele que impede envelhecer a linha aqui pelo caminho normal. Sem
    // desligá-lo, o UPDATE abaixo grava `now()` e o reaper não acha órfão
    // nenhum: o teste reprovaria o produto por causa do instrumento.
    sql(`
      alter table public.event_log disable trigger trg_event_log_touch;
      update public.event_log
         set status = 'processing', updated_at = now() - interval '30 minutes'
       where id = '${preso}';
      alter table public.event_log enable trigger trg_event_log_touch;
    `);

    await drainEventLog(fakeAdminClient(), { limit: 50 });

    const row = rowState(preso);
    // Voltou para a fila E foi processado no MESMO tique: reclamar depois da
    // seleção faria o evento esperar o próximo, e a espera é o defeito.
    expect(row.status, "o órfão não voltou para a fila").toBe("done");
    // E a queda ficou CONTADA e ESCRITA — sem isto, o evento que derruba o
    // processo nunca chega a `dead` (ver o caso 11).
    expect(row.attempts, "a queda não contou como tentativa").toBe(1);
    expect(row.last_error).toContain("processamento interrompido");
  });

  it("caso 10 — CONTROLE: `processing` RECENTE não é reclamado", async () => {
    // Sem esta metade, o caso 9 passaria com o dreno reclamando TUDO que está
    // em `processing` — inclusive o evento que outro worker está processando
    // agora, produzindo efeito em dobro no lugar de evento parado.
    const emCurso = emitDrainCase("ok");
    // Aqui o trigger pode agir à vontade: o que se quer É o instante de agora.
    sql(`
      update public.event_log
         set status = 'processing'
       where id = '${emCurso}';
    `);

    await drainEventLog(fakeAdminClient(), { limit: 50 });

    expect(rowState(emCurso).status, "reclamou um evento que estava em curso").toBe("processing");
  });

  /**
   * O defeito medido em produção em 28/09/2026: um `media.derive_requested` de
   * PDF derrubava o worker (heap esgotado) a cada vez que era processado. O
   * reaper o devolvia sem contar, e ele derrubou o worker 9 vezes em 45 minutos
   * com `attempts=0` — nunca chegaria a `dead`, e a Central nunca soube.
   */
  it("caso 11 — o evento que derruba o processo morre na 5ª queda, COM aviso, sem 6ª rodada", async () => {
    // O aviso é deduplicado por organização: fecha os que os casos acima
    // abriram, senão o desta queda seria calado por um deles.
    sql(`update public.agent_inbox_items set status = 'resolved'
          where organization_id = '${GOV_ORG}' and kind = 'event_dead';`);
    const veneno = lastLine(
      sql(
        `select public.emit_event('test.drain_veneno', 'test', null, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}');`,
      ),
    );

    for (let queda = 1; queda <= 5; queda++) {
      encenarQueda(veneno);
      await drainEventLog(fakeAdminClient(), { limit: 50 });
      const row = rowState(veneno);
      expect(row.attempts, `queda ${queda}: a tentativa não foi contada`).toBe(queda);
      expect(row.status, `queda ${queda}`).toBe(queda < 5 ? "pending" : "dead");
    }

    // Da 1ª à 4ª queda ele volta e roda no mesmo tique (caso 9); na 5ª, não:
    // uma 6ª rodada seria derrubar o processo mais uma vez.
    expect(chamadasDoVeneno.filter((id) => id === veneno)).toHaveLength(4);
    expect(rowState(veneno).last_error).toContain("(5ª vez)");

    const avisos = JSON.parse(
      sql(`select coalesce(json_agg(t), '[]') from (
             select body from public.agent_inbox_items
              where organization_id = '${GOV_ORG}' and kind = 'event_dead' and status = 'open'
           ) t;`),
    ) as { body: string }[];
    expect(avisos, "o evento morreu calado — sem aviso na Central").toHaveLength(1);
    expect(avisos[0]!.body).toContain("test.drain_veneno");
    expect(avisos[0]!.body).toContain("processamento interrompido");
  });

  it("caso 12 — o reaper não toca em `processing` de tipo que não é deste dreno", async () => {
    // `ai_agent.dispatch_requested` passa por `processing` no dreno do
    // agent-engine, que conta a tentativa no próprio claim e tem reaper
    // próprio. Contar aqui também gastaria duas tentativas por queda.
    const alheio = emitDrainCase("ok", "test.de_outro_dreno");
    encenarQueda(alheio);

    await drainEventLog(fakeAdminClient(), { limit: 50 });

    const row = rowState(alheio);
    expect(row.status, "reclamou evento de outro dreno").toBe("processing");
    expect(row.attempts).toBe(0);
  });
});
