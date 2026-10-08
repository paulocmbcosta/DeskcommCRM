import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { sql } from "./gov-helpers";

/**
 * Paginação de `listMessagesHandler` — o contrato de leitura da thread.
 *
 * POR QUE ESTE ARQUIVO EXISTE: `/api/v1/conversations/[id]/messages` é API
 * versionada com auth dual (cookie e Bearer), consumida também pela tool MCP
 * `crm_get_conversation_history`, e até aqui não tinha NENHUM teste. A direção
 * da consulta é a única coisa que decide se o atendente vê o que o cliente
 * acabou de escrever: com `ascending: true` a primeira página trazia as `limit`
 * mensagens mais ANTIGAS, e numa conversa maior que o limite as novas ficavam
 * atrás do cursor — invisíveis. Sem teste, esse comportamento volta no próximo
 * refactor sem ninguém perceber.
 *
 * O QUE DISCRIMINA: `main` (asc) e a correção (desc) são dois esquemas de
 * paginação internamente consistentes — a maioria das propriedades óbvias passa
 * nos DOIS. Só duas ficam vermelhas sem a correção, e estão marcadas
 * `[DISCRIMINA]` abaixo: "a primeira página traz as mais recentes" e "o cursor
 * anda para o passado". As demais são regressão (defendem o que já valia:
 * ordem de saída, cobertura sem buraco, has_more, cursor inválido, isolamento).
 * Um teste que passa nos dois estados não prova correção nenhuma — por isso a
 * distinção está escrita, e não subentendida.
 *
 * LIMITAÇÃO DECLARADA (mesma de event-log-drain.test.ts e
 * webhooks-trigger-events.test.ts): o harness sobe só um Postgres cru, sem
 * PostgREST. `FakeQuery` traduz a cadeia supabase-js em SQL e roda no container
 * via `docker exec psql`. Logo a string `.or()` do cursor é interpretada pelo
 * NOSSO parser, não pelo parser real do PostgREST. Para não testar apenas a
 * fidelidade da tradução, cada asserção de conteúdo é conferida contra um
 * ORÁCULO independente — a página esperada é calculada por um `sql()` escrito à
 * mão, não pelo duplo.
 */

// ---------------------------------------------------------------------------
// duplo mínimo do PostgrestQueryBuilder — só o que listMessagesHandler usa
// ---------------------------------------------------------------------------

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Divide por vírgulas de TOPO, ignorando as que estão dentro de `and(...)`. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let atual = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  if (atual) out.push(atual);
  return out;
}

/**
 * Traduz um nó PostgREST em SQL. Só os dois formatos que o cursor emite:
 * `and(a,b)` e `col.op.valor`.
 *
 * O split é nos DOIS PRIMEIROS pontos, não em todos: o valor é um timestamp
 * ISO-8601 (`2026-08-03T16:14:00.000Z`) e contém ponto — um `split(".")` ingênuo
 * o partiria ao meio e o teste passaria a comparar lixo.
 */
function orNodeToSql(node: string): string {
  const n = node.trim();
  if (n.startsWith("and(") && n.endsWith(")")) {
    return `(${splitTopLevel(n.slice(4, -1)).map(orNodeToSql).join(" and ")})`;
  }
  const i = n.indexOf(".");
  const j = n.indexOf(".", i + 1);
  if (i < 0 || j < 0) throw new Error(`FakeQuery: cláusula .or() irreconhecível: ${node}`);
  const col = n.slice(0, i);
  const op = n.slice(i + 1, j);
  const val = n.slice(j + 1);
  const sqlOp = { lt: "<", gt: ">", lte: "<=", gte: ">=", eq: "=" }[op];
  // fail-closed: um operador desconhecido tem que ESTOURAR, nunca virar `true`.
  // Duplo que "concorda" com o que não entendeu deixa o teste verde e cego.
  if (!sqlOp) throw new Error(`FakeQuery: operador .or() não suportado: ${op}`);
  return `${col} ${sqlOp} ${sqlString(val)}`;
}

type Res = { data: unknown; error: { message: string } | null };

class FakeQuery implements PromiseLike<Res> {
  private cols = "*";
  private eqs: Array<{ col: string; val: unknown }> = [];
  private ors: string[] = [];
  // ACUMULA os order: o handler encadeia .order("sent_at").order("id") e o
  // desempate por id é o que segura a borda da página quando há sent_at igual.
  // Guardar um só (como fazem os outros duplos do repo) apagaria o desempate
  // em silêncio e a asserção de borda viraria placebo.
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitN?: number;

  constructor(private table: string) {}

  select(cols: string): this {
    this.cols = cols;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs.push({ col, val });
    return this;
  }
  or(raw: string): this {
    this.ors.push(`(${splitTopLevel(raw).map(orNodeToSql).join(" or ")})`);
    return this;
  }
  order(col: string, opts: { ascending: boolean }): this {
    this.orders.push({ col, asc: opts.ascending });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private toSql(): string {
    const where = [
      ...this.eqs.map((f) => `${f.col} = ${sqlString(String(f.val))}`),
      ...this.ors,
    ];
    let q = `select ${this.cols} from public.${this.table}`;
    if (where.length) q += ` where ${where.join(" and ")}`;
    if (this.orders.length) {
      q += ` order by ${this.orders.map((o) => `${o.col} ${o.asc ? "asc" : "desc"}`).join(", ")}`;
    }
    if (this.limitN !== undefined) q += ` limit ${this.limitN}`;
    return q;
  }

  private async execute(): Promise<Res> {
    try {
      const out = sql(`select coalesce(json_agg(t), '[]') from (${this.toSql()}) t;`);
      return { data: JSON.parse(out), error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<T1 = Res, T2 = never>(
    onfulfilled?: ((v: Res) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function fakeAdminClient(): SupabaseClient {
  return { from: (t: string) => new FakeQuery(t) } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// fixture — namespace próprio (aaaabbbb-) para não colidir com os irmãos
// ---------------------------------------------------------------------------

const ORG = "aaaabbbb-1111-4000-8000-000000000001";
const ORG_VIZINHA = "aaaabbbb-1111-4000-8000-0000000000ff";
const CONTACT = "aaaabbbb-2222-4000-8000-000000000001";
// Contato próprio: `uniq_conversations_1to1_per_contact_session` proíbe duas
// conversas para o mesmo par (contato, sessão).
const CONTACT_CURTA = "aaaabbbb-2222-4000-8000-0000000000ff";
const SESSION = "aaaabbbb-3333-4000-8000-000000000001";
const CONV = "aaaabbbb-4444-4000-8000-000000000001";
const CONV_CURTA = "aaaabbbb-4444-4000-8000-0000000000ff";
const USER = "aaaabbbb-5555-4000-8000-000000000001";
const CURTA_TOTAL = 3;

const TOTAL = 64;
const LIMIT = 50;
/** As 4 últimas nascem com o MESMO sent_at, atravessando a borda da 1ª página. */
const EMPATADAS = 4;
const BASE_MS = Date.parse("2026-08-03T16:00:00.000Z");

/**
 * id decrescente enquanto sent_at cresce: se o handler ordenasse pela coluna
 * errada (só id, ou id antes de sent_at), a página sairia diferente. Com id
 * alinhado a sent_at o teste não conseguiria distinguir as duas hipóteses.
 */
function msgId(i: number): string {
  return `aaaabbbb-6666-4000-8000-${String(TOTAL - i).padStart(12, "0")}`;
}

function sentAt(i: number): string {
  // As EMPATADAS últimas compartilham o instante da primeira delas.
  const idx = i >= TOTAL - EMPATADAS ? TOTAL - EMPATADAS : i;
  return new Date(BASE_MS + idx * 60_000).toISOString();
}

function corpo(i: number): string {
  return `msg-${String(i + 1).padStart(2, "0")}`;
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "invariante-messages-list",
};

beforeAll(() => {
  const linhas = Array.from({ length: TOTAL }, (_, i) =>
    `('${msgId(i)}','${ORG}','${CONV}','${SESSION}','${CONTACT}','text',` +
    // NUNCA status='queued' + sent_via='ai': agent-watchdog.test.ts varre
    // exatamente essa combinação no banco COMPARTILHADO da suíte e apagaria
    // estas linhas no meio do arquivo.
    `'${i % 2 === 0 ? "inbound" : "outbound"}','${i % 2 === 0 ? "received" : "sent"}',` +
    `'${i % 2 === 0 ? "crm" : "user"}','${corpo(i)}','${sentAt(i)}')`,
  ).join(",\n      ");

  const linhasCurta = Array.from({ length: CURTA_TOTAL }, (_, i) =>
    `('aaaabbbb-7777-4000-8000-${String(i).padStart(12, "0")}','${ORG}','${CONV_CURTA}','${SESSION}',` +
    `'${CONTACT_CURTA}','text','inbound','received','crm','curta-${i + 1}',` +
    `'${new Date(BASE_MS + i * 60_000).toISOString()}')`,
  ).join(",\n      ");

  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-msgs-list', 'Invariante Mensagens LTDA', 'Invariante Mensagens'),
      ('${ORG_VIZINHA}', 'inv-msgs-vizinha', 'Vizinha LTDA', 'Vizinha')
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name, phone_number) values
      ('${CONTACT}', '${ORG}', 'Contato Invariante', '+5511900000064'),
      ('${CONTACT_CURTA}', '${ORG}', 'Contato Conversa Curta', '+5511900000003')
      on conflict (id) do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
      values ('${SESSION}', '${ORG}', 'inv-msgs-session', '\\x00'::bytea, 'WORKING')
      on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV}', '${ORG}', '${CONTACT}', '${SESSION}', 'open'),
      ('${CONV_CURTA}', '${ORG}', '${CONTACT_CURTA}', '${SESSION}', 'open')
      on conflict (id) do nothing;

    delete from public.messages where conversation_id in ('${CONV}', '${CONV_CURTA}');

    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type,
       direction, status, sent_via, body, sent_at)
    values
      ${linhas};

    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type,
       direction, status, sent_via, body, sent_at)
    values
      ${linhasCurta};
  `);
});

/** Oráculo independente: a resposta esperada sai de SQL escrito à mão. */
function maisRecentesPorSql(n: number): string[] {
  const out = sql(`
    select string_agg(body, ',' order by sent_at asc, id asc) from (
      select body, sent_at, id from public.messages
      where conversation_id = '${CONV}' and organization_id = '${ORG}'
      order by sent_at desc, id desc
      limit ${n}
    ) t;
  `).trim();
  return out ? out.split(",") : [];
}

describe("listMessagesHandler — paginação da thread", () => {
  it("[DISCRIMINA] a primeira página traz as mensagens MAIS RECENTES", async () => {
    const r = await listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT });

    expect(r.messages).toHaveLength(LIMIT);
    expect(r.has_more).toBe(true);

    // A mais recente da conversa TEM que estar na primeira página — é o que o
    // atendente abre. Com `ascending: true` esta linha fica vermelha: a página
    // vinha com msg-01..msg-50 e a mais nova ficava atrás do cursor.
    const corpos = r.messages.map((m) => m.body);
    expect(corpos).toContain(corpo(TOTAL - 1));
    expect(corpos).not.toContain(corpo(0));

    // Conferido contra o oráculo (SQL à mão), não contra o próprio duplo.
    expect(corpos).toEqual(maisRecentesPorSql(LIMIT));
  });

  it("[DISCRIMINA] o cursor anda para o PASSADO (a página seguinte é anterior no tempo)", async () => {
    const p1 = await listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT });
    expect(p1.cursor).toBeTruthy();

    const p2 = await listMessagesHandler(fakeAdminClient(), ctx, CONV, {
      limit: LIMIT,
      cursor: p1.cursor!,
    });

    expect(p2.messages.length).toBeGreaterThan(0);

    // Toda mensagem da página 2 é ANTERIOR (ou igual no instante, com id menor)
    // à mais antiga da página 1. Com o cursor `gt.` da main, a página 2 andaria
    // para o futuro e esta comparação inverte.
    const maisAntigaP1 = p1.messages[0]!;
    for (const m of p2.messages) {
      expect(Date.parse(m.sent_at)).toBeLessThanOrEqual(Date.parse(maisAntigaP1.sent_at));
    }
    expect(p2.messages.map((m) => m.body)).toContain(corpo(0));

    // E não há sobreposição entre as páginas.
    const idsP1 = new Set(p1.messages.map((m) => m.id));
    expect(p2.messages.some((m) => idsP1.has(m.id))).toBe(false);
  });

  it("a resposta sai cronológica (antigo → novo), como o consumidor MCP espera", async () => {
    // Contrato de API, não de tela: o ChatThread re-ordena, mas
    // `crm_get_conversation_history` entrega o array cru ao agente.
    const r = await listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT });
    const ts = r.messages.map((m) => Date.parse(m.sent_at));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("paginar até o fim cobre TODAS as mensagens, sem buraco e sem duplicata", async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;

    do {
      const r = await listMessagesHandler(fakeAdminClient(), ctx, CONV, {
        limit: LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      vistos.push(...r.messages.map((m) => m.body!));
      cursor = r.cursor;
      // guarda de laço: cursor que não converge é bug, não teste lento.
      expect(++paginas).toBeLessThanOrEqual(5);
    } while (cursor);

    // Cobre a borda com sent_at EMPATADO: sem o desempate por id, uma das
    // empatadas apareceria duas vezes ou sumiria na virada de página.
    expect(new Set(vistos).size).toBe(TOTAL);
    expect(vistos).toHaveLength(TOTAL);
    expect(new Set(vistos)).toEqual(new Set(Array.from({ length: TOTAL }, (_, i) => corpo(i))));
  });

  it("has_more é false e o cursor é null na última página", async () => {
    const p1 = await listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT });
    const ultima = await listMessagesHandler(fakeAdminClient(), ctx, CONV, {
      limit: LIMIT,
      cursor: p1.cursor!,
    });

    expect(ultima.messages).toHaveLength(TOTAL - LIMIT);
    expect(ultima.has_more).toBe(false);
    expect(ultima.cursor).toBeNull();
  });

  it("cursor inválido vira ApiError 400 invalid_cursor (não 500, não página silenciosa)", async () => {
    await expect(
      listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT, cursor: "%%nao-e-base64%%" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });

    // base64url válido, mas com payload que não tem o shape do cursor.
    const enganoso = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    await expect(
      listMessagesHandler(fakeAdminClient(), ctx, CONV, { limit: LIMIT, cursor: enganoso }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("filtra por organization_id: a org vizinha não lê a thread", async () => {
    const r = await listMessagesHandler(
      fakeAdminClient(),
      { ...ctx, organization_id: ORG_VIZINHA },
      CONV,
      { limit: LIMIT },
    );
    expect(r.messages).toHaveLength(0);
    expect(r.has_more).toBe(false);
  });

  it("conversa mais curta que o limite volta inteira, cronológica e sem cursor", async () => {
    const r = await listMessagesHandler(fakeAdminClient(), ctx, CONV_CURTA, { limit: LIMIT });
    expect(r.messages).toHaveLength(CURTA_TOTAL);
    expect(r.has_more).toBe(false);
    expect(r.cursor).toBeNull();
    // O `.reverse()` da correção não pode inverter a conversa curta: quem cabe
    // numa página só tem que sair na mesma ordem de sempre (antigo → novo).
    expect(r.messages.map((m) => m.body)).toEqual(["curta-1", "curta-2", "curta-3"]);
  });
});

// ---------------------------------------------------------------------------
// a transcrição do áudio — o que a listagem entrega ao balão
// ---------------------------------------------------------------------------

/**
 * O balão do Inbox mostra a transcrição do áudio (`messages.media_derived_text`),
 * e ela só chega lá se a consulta da listagem PEDIR a coluna. Um nome errado no
 * `select` não aparece em teste de componente nenhum — o objeto é montado à
 * mão —, e em produção vira 400 do PostgREST na conversa inteira. Aqui a lista
 * de colunas roda contra o `baseline.sql` de verdade.
 *
 * E o inverso, que é o que importa para a privacidade: o derivado existe também
 * em imagem e PDF, sobrevive ao "apagar para todos" e à anonimização do contato
 * (`fn_lgpd_cascade_redact_contact` zera a mídia, não o derivado). Nesses três
 * casos ele NÃO pode sair. As linhas abaixo ficam vermelhas se
 * `soATranscricaoDoAudio` sair do caminho da listagem.
 */
describe("listMessagesHandler — a transcrição do áudio", () => {
  const CONTACT_AUDIO = "aaaabbbb-2222-4000-8000-0000000000aa";
  const CONV_AUDIO = "aaaabbbb-4444-4000-8000-0000000000aa";
  const TRANSCRICAO = "Oi, eu queria a segunda via do boleto.";
  const id = (n: number) => `aaaabbbb-8888-4000-8000-${String(n).padStart(12, "0")}`;
  const quando = (n: number) => new Date(BASE_MS + n * 60_000).toISOString();

  beforeAll(() => {
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number) values
        ('${CONTACT_AUDIO}', '${ORG}', 'Contato do Áudio', '+5511900000065')
        on conflict (id) do nothing;

      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
        ('${CONV_AUDIO}', '${ORG}', '${CONTACT_AUDIO}', '${SESSION}', 'open')
        on conflict (id) do nothing;

      delete from public.messages where conversation_id = '${CONV_AUDIO}';

      insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type,
         direction, status, sent_via, body, sent_at,
         media_storage_path, media_derived_text, media_derived_status, revoked_at)
      values
        ('${id(1)}','${ORG}','${CONV_AUDIO}','${SESSION}','${CONTACT_AUDIO}','audio',
         'inbound','received','crm','audio-transcrito','${quando(1)}',
         '${ORG}/${CONV_AUDIO}/${id(1)}.ogg','${TRANSCRICAO}','ready',null),
        ('${id(2)}','${ORG}','${CONV_AUDIO}','${SESSION}','${CONTACT_AUDIO}','image',
         'inbound','received','crm','imagem-descrita','${quando(2)}',
         '${ORG}/${CONV_AUDIO}/${id(2)}.jpg','Foto de um comprovante de pagamento.','ready',null),
        ('${id(3)}','${ORG}','${CONV_AUDIO}','${SESSION}','${CONTACT_AUDIO}','audio',
         'inbound','received','crm','audio-apagado','${quando(3)}',
         '${ORG}/${CONV_AUDIO}/${id(3)}.ogg','Fala que o cliente apagou.','ready','${quando(4)}'),
        ('${id(4)}','${ORG}','${CONV_AUDIO}','${SESSION}','${CONTACT_AUDIO}','audio',
         'inbound','received','crm','audio-sem-arquivo','${quando(5)}',
         null,'Fala de um contato anonimizado.','ready',null),
        ('${id(5)}','${ORG}','${CONV_AUDIO}','${SESSION}','${CONTACT_AUDIO}','audio',
         'inbound','received','crm','audio-ainda-sem-texto','${quando(6)}',
         '${ORG}/${CONV_AUDIO}/${id(5)}.ogg',null,null,null);
    `);
  });

  async function porCorpo() {
    const r = await listMessagesHandler(fakeAdminClient(), ctx, CONV_AUDIO, { limit: LIMIT });
    return new Map(r.messages.map((m) => [m.body, m]));
  }

  it("o áudio transcrito sai com o texto e o estado", async () => {
    const m = (await porCorpo()).get("audio-transcrito");
    expect(m?.media_derived_text).toBe(TRANSCRICAO);
    expect(m?.media_derived_status).toBe("ready");
  });

  it("o áudio ainda sem derivado sai com os dois campos nulos (a tela decide pelo relógio)", async () => {
    const m = (await porCorpo()).get("audio-ainda-sem-texto");
    expect(m).toBeDefined();
    expect(m?.media_derived_text).toBeNull();
    expect(m?.media_derived_status).toBeNull();
  });

  it.each(["imagem-descrita", "audio-apagado", "audio-sem-arquivo"])(
    "%s: o derivado está no banco e NÃO sai na listagem",
    async (corpoDaLinha) => {
      // A fixture tem o texto — senão o teste passaria sem provar nada.
      const noBanco = sql(`
        select media_derived_text is not null from public.messages
        where conversation_id = '${CONV_AUDIO}' and body = '${corpoDaLinha}';
      `).trim();
      expect(noBanco).toBe("t");

      const m = (await porCorpo()).get(corpoDaLinha);
      expect(m).toBeDefined();
      expect(m?.media_derived_text).toBeNull();
      expect(m?.media_derived_status).toBeNull();
    },
  );
});
