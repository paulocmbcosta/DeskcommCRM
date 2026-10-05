import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { runBeforeSend, type Gate } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * O ENVIO DA IA NÃO PODE SEGURAR TRAVA DE TABELA — CONTRA UM POSTGRES DE VERDADE.
 *
 * ─── O defeito que este arquivo existe para ter pegado ─────────────────────
 *
 * Em 2026-10-05 o `update.sh` deixou uma instalação 16 minutos sem responder. A
 * cadeia `runBeforeSend` abria a transação, pegava o advisory lock do número e
 * LIA o estado (`channel_sessions`, `contacts`, `conversations`, …) pela conexão
 * da própria transação. O Postgres segura trava de tabela até o FIM da
 * transação, e esta só fechava depois do envio — atraso humano, bolhas, POST.
 * Nesse intervalo:
 *
 *   1. o `alter table public.channel_sessions add column if not exists …` do
 *      baseline pedia `AccessExclusiveLock` e esperava a transação;
 *   2. `persistTrace` — um `insert into before_send_traces` por OUTRA conexão do
 *      pool — precisava de `RowShareLock` em `channel_sessions` (checagem da FK) e
 *      entrava na fila atrás do `ALTER`;
 *   3. a transação só fecha depois que o `persistTrace` volta.
 *
 * Um dos três elos mora no cliente, então o detector de deadlock do Postgres não
 * vê ciclo nenhum: as três sessões ficam paradas para sempre, e atrás do `ALTER`
 * enfileira todo o resto do sistema, inclusive o cache de esquema do PostgREST.
 *
 * ─── Por que aqui, e não em tests/unit ─────────────────────────────────────
 *
 * Os dublês de `tests/unit` devolvem `{ rows: [] }` para qualquer string: nenhum
 * deles sabe o que é uma trava. A propriedade é do par (código, Postgres), e só
 * existe com os dois de verdade.
 *
 * ─── O que cada caso prova, e a sabotagem que o derruba ────────────────────
 *
 * Voltar UMA leitura de `runBeforeSend` para a conexão da transação (trocar
 * `leitura` por `client` em `loadChannelProvider`) reprova os dois primeiros
 * casos. O terceiro é o CONTROLE da direção oposta: tirar o advisory lock
 * "resolveria" os dois primeiros e quebraria a serialização por número — é ele
 * que fica vermelho nesse caso.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

/** É por este nome que a sonda acha, em `pg_stat_activity`, as sessões do "worker". */
const APP_DO_MOTOR = "inv-envio-sem-trava-motor";
/** O pool do motor: a conexão da transação + as leituras + o segundo envio em espera. */
const motor = new pg.Pool({ connectionString: URL, max: 6, application_name: APP_DO_MOTOR });
/** Quem faz o papel do `update.sh` e das sondas — nunca disputa conexão com o motor. */
const operador = new pg.Pool({ connectionString: URL, max: 3, application_name: "inv-envio-sem-trava-operador" });

const ORG = "5e0d1a00-0000-4000-8000-000000000001";
const CANAL = "5e0d1a00-0000-4000-8000-00000000000a";
const CONTATO = "5e0d1a00-0000-4000-8000-00000000000b";
const JOB = "5e0d1a00-0000-4000-8000-00000000000c";

const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Um `send` que ESTACIONA: é dentro dele que a transação do envio fica aberta. */
function envioEstacionado() {
  let entrou!: () => void;
  let soltar!: () => void;
  const noEnvio = new Promise<void>((resolve) => (entrou = resolve));
  const liberado = new Promise<void>((resolve) => (soltar = resolve));
  let chamado = false;
  return {
    noEnvio,
    soltar,
    foiChamado: () => chamado,
    send: async () => {
      chamado = true;
      entrou();
      await liberado;
      return { kind: "sent" as const, idempotencyKey: "k", messageId: "m" };
    },
  };
}

/**
 * Envios estacionados deste caso. Uma asserção que falha ANTES do `soltar()`
 * deixaria a transação aberta com o advisory lock do número — e os casos
 * seguintes pendurariam esperando por ela, reprovando por timeout em vez de
 * pelo motivo. O `afterEach` solta e espera todos, tenha o caso passado ou não.
 */
const estacionados: Array<{ soltar: () => void; emCurso: Promise<unknown> }> = [];

function enviar(envio: ReturnType<typeof envioEstacionado>, gates: readonly Gate[] = []) {
  const emCurso = rodar(envio.send, gates);
  estacionados.push({ soltar: envio.soltar, emCurso });
  return emCurso;
}

function rodar(send: () => Promise<{ kind: "sent"; idempotencyKey: string; messageId: string }>, gates: readonly Gate[]) {
  return runBeforeSend({
    pool: motor,
    log,
    tenantId: ORG,
    leadId: CONTATO,
    jobId: JOB,
    channelSessionId: CANAL,
    body: "oi",
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date(),
    rng: () => 0,
    sleep: async () => {},
    // Sem gates por padrão: o que está sob prova é o TRANSPORTE (quem segura o
    // quê enquanto o envio acontece), não o veredito de gate nenhum. As leituras
    // de estado rodam do mesmo jeito — é `runBeforeSend` que as faz, não os gates.
    gates,
    send,
  });
}

/** As transações ABERTAS do motor, com o que cada uma segura. */
async function transacoesDoMotor() {
  const { rows } = await operador.query<{ advisory: string; relacoes: string; quais: string[] | null }>(
    `select count(*) filter (where l.locktype = 'advisory')::text as advisory,
            count(*) filter (where l.locktype = 'relation')::text as relacoes,
            array_agg(l.relation::regclass::text) filter (where l.locktype = 'relation') as quais
       from pg_stat_activity a
       join pg_locks l on l.pid = a.pid
      where a.application_name = $1
        and a.state = 'idle in transaction'
        and (l.database is null or l.database = (select oid from pg_database where datname = current_database()))
      group by a.pid`,
    [APP_DO_MOTOR],
  );
  return rows.map((r) => ({ advisory: Number(r.advisory), relacoes: Number(r.relacoes), quais: r.quais ?? [] }));
}

beforeAll(async () => {
  await operador.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-envio-sem-trava', 'Org Envio LTDA', 'Org Envio')`,
    [ORG],
  );
  await operador.query(
    `insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
     values ($1, $2, '\\x00', 'envio-sem-trava')`,
    [CANAL, ORG],
  );
  await operador.query(`insert into contacts (id, organization_id) values ($1, $2)`, [CONTATO, ORG]);
  await operador.query(
    `insert into job_queue (id, organization_id, kind, contact_id) values ($1, $2, 'inbound_turn', $3)`,
    [JOB, ORG, CONTATO],
  );
});

beforeEach(async () => {
  await operador.query("delete from before_send_traces where organization_id = $1", [ORG]);
  await operador.query("delete from pacing_ledger where organization_id = $1", [ORG]);
});

afterEach(async () => {
  for (const e of estacionados) e.soltar();
  await Promise.allSettled(estacionados.map((e) => e.emCurso));
  estacionados.length = 0;
});

afterAll(async () => {
  await motor.end();
  await operador.end();
});

describe("o envio da IA não segura trava de tabela enquanto acontece", () => {
  it("com o envio em curso, a transação aberta do motor segura SÓ o advisory lock", async () => {
    const envio = envioEstacionado();
    const emCurso = enviar(envio);
    await envio.noEnvio;

    const abertas = await transacoesDoMotor();
    // O CONTROLE vem primeiro: sem ele, "zero trava de tabela" passaria por
    // vacuidade no dia em que a transação deixasse de existir (ou de ser achada
    // pela sonda) — e esse dia é exatamente quando alguém troca o desenho.
    expect(abertas, "exatamente uma transação do motor aberta durante o envio").toHaveLength(1);
    expect(abertas[0]!.advisory, "ela segura o advisory lock do número").toBeGreaterThanOrEqual(1);
    expect(abertas[0]!.quais, "…e nenhuma trava de tabela").toEqual([]);

    envio.soltar();
    await expect(emCurso).resolves.toMatchObject({ status: "sent" });
  });

  it("o DDL do update.sh passa com o envio em curso — o comando que travou a produção", async () => {
    const envio = envioEstacionado();
    const emCurso = enviar(envio);
    await envio.noEnvio;

    const ddl = await operador.connect();
    try {
      // 2 s é o prazo do TESTE, não do kit: com a trava presa o comando morre em
      // 55P03 em vez de pendurar a suíte até o timeout do vitest.
      await ddl.query("set lock_timeout = '2s'");
      // O comando literal de `supabase/baseline.sql` que ficou 13 minutos em
      // `Lock/relation`. `add column if not exists` pede `AccessExclusiveLock`
      // ANTES de olhar se a coluna existe — por isso reaplicar o baseline pesa.
      await expect(
        ddl.query("alter table public.channel_sessions add column if not exists site_widget_key text"),
        "alter table em channel_sessions",
      ).resolves.toBeDefined();
      // A classe, sem depender de qual DDL o baseline traz amanhã: a trava que
      // todo `alter table`/`drop trigger`/`create policy` pede, nas tabelas que a
      // cadeia lê a cada envio. `contacts` foi a segunda a travar no incidente.
      await ddl.query("begin");
      await expect(
        ddl.query(
          "lock table public.channel_sessions, public.contacts, public.conversations in access exclusive mode",
        ),
        "trava exclusiva nas tabelas que a cadeia lê",
      ).resolves.toBeDefined();
      await ddl.query("rollback");
    } finally {
      await ddl.query("rollback").catch(() => {});
      ddl.release();
    }

    envio.soltar();
    await expect(emCurso).resolves.toMatchObject({ status: "sent" });

    // O envio continua inteiro: o trace da tentativa e o registro de pacing
    // (as duas escritas que ficam na transação) chegaram ao banco, e nenhuma
    // transação do motor sobrou aberta.
    const { rows } = await operador.query<{ traces: string; envios: string }>(
      `select (select count(*) from before_send_traces where organization_id = $1)::text as traces,
              (select count(*) from pacing_ledger where organization_id = $1)::text as envios`,
      [ORG],
    );
    expect(rows[0]).toEqual({ traces: "1", envios: "1" });
    expect(await transacoesDoMotor()).toEqual([]);
  });

  it("a serialização por número continua: o segundo envio espera e relê o estado do primeiro", async () => {
    // Gate espião: guarda o que CADA tentativa leu do pacing. É a prova de que a
    // leitura fora da transação continua acontecendo DEPOIS do advisory lock —
    // sem isso, os dois leriam "0 envios hoje" e estourariam o cap em 1
    // (INBOX-008, o motivo de a transação existir).
    const lidos: number[] = [];
    const espiao: Gate = {
      name: "espiao",
      evaluate: (ctx) => {
        lidos.push(ctx.pacing.state.sentToday);
        return { pass: true };
      },
    };

    const primeiro = envioEstacionado();
    const emCurso1 = enviar(primeiro, [espiao]);
    await primeiro.noEnvio;

    const segundo = envioEstacionado();
    const emCurso2 = enviar(segundo, [espiao]);

    // O segundo tem de estar ESPERANDO o advisory lock — olhado no banco, não
    // inferido de um `setTimeout`: "ainda não chamou o send" também é o que se
    // vê quando ele só não teve tempo de chegar lá.
    await expect
      .poll(
        async () => {
          const { rows } = await operador.query<{ n: string }>(
            `select count(*)::text as n from pg_stat_activity
              where application_name = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'`,
            [APP_DO_MOTOR],
          );
          return rows[0]!.n;
        },
        { timeout: 5_000, interval: 50 },
      )
      .toBe("1");
    expect(segundo.foiChamado(), "o segundo envio não saiu enquanto o primeiro está em curso").toBe(false);
    expect(lidos, "o segundo ainda não leu o estado").toEqual([0]);

    primeiro.soltar();
    await expect(emCurso1).resolves.toMatchObject({ status: "sent" });
    await segundo.noEnvio;
    // Leu DEPOIS do commit do primeiro: o envio dele já está contabilizado.
    expect(lidos).toEqual([0, 1]);

    segundo.soltar();
    await expect(emCurso2).resolves.toMatchObject({ status: "sent" });
  });
});
