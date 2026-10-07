/**
 * A FILA VISÍVEL DO TELEFONE — O SCHEMA, CONTRA POSTGRES REAL (migration 0295).
 *
 * A fila do telefone vivia só na memória do worker: quem coordena o atendimento
 * não via quantos clientes esperavam nem de que time. A 0295 põe no banco os três
 * fatos que a aba Telefone e o worker passam a usar:
 *
 *  - `voice_calls.queued_at`: quando a ligação passou a esperar por uma PESSOA
 *    (depois do menu e dos avisos) — a ordem de chegada da fila;
 *  - `voice_calls.queue_deadline_at`: quando a espera sem ninguém livre esgota —
 *    o "cai em 1:18" da tela;
 *  - `attendance_teams.phone_queue_max_wait_seconds`: a espera máxima do time.
 *
 * Aqui não se prova nenhuma função do worker (ela nem existe ainda quando este
 * arquivo entra): prova-se o SCHEMA que o `install.sh` e o `update.sh` deixam, e
 * por isso toda semeadura é SQL puro, sem passar pelo repositório:
 *
 *  1. as três colunas existem, com o tipo certo, nulas e sem default — a 0295 não
 *     faz backfill, e ligação anterior a ela não tem ordem de chegada inventada;
 *  2. as duas de `voice_calls` são só da linha do TELEFONE (CHECK): a linha do
 *     WaCalls, que a REST escreve com o JWT do agent, recusa cada uma delas — no
 *     INSERT e no UPDATE, para o agent e para o worker;
 *  3. o teto do time aceita nulo (o padrão) e de 30 a 1800 s; fora disso, recusa;
 *  4. os dois índices parciais que a aba lê a cada mudança existem, e são parciais
 *     (o histórico não entra em nenhum dos dois);
 *  5. o bloco do baseline se cura sozinho: com o CHECK derrubado e uma linha fora
 *     da regra, reaplicá-lo limpa a linha e recria o CHECK — sem tocar no que
 *     estava certo;
 *  6. a REST não escreve nenhuma das três: a linha do telefone é só-leitura para
 *     o agent, e `attendance_teams` só tem GRANT de leitura;
 *  7. o arquivo de `supabase/migrations/` chega ao mesmo lugar que o bloco do
 *     baseline: num banco devolvido à 0294, aplicá-lo cria tudo, e reaplicá-lo
 *     não quebra — `pnpm test:db` aplica só o baseline, e sem este caso nenhum
 *     gate executaria o arquivo que o Supabase CLI aplica.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de1295-0000-4000-8000-00000000000a";
const ANA = "c0de1295-1111-4000-8000-000000000001";
const SUPORTE = "c0de1295-2222-4000-8000-000000000001";
const FINANCEIRO = "c0de1295-2222-4000-8000-000000000002";
const NUMERO = "c0de1295-5555-4000-8000-000000000001";
const CHECK_DA_FILA = "voice_calls_fila_so_no_telefone_check";
const CHECK_DO_TETO = "attendance_teams_phone_queue_max_wait_check";
/** `check_violation`, o SQLSTATE de um CHECK recusando a linha. */
const VIOLA_CHECK = "23514";

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-fila@invariant.test', '{"full_name":"Ana da Fila"}')
     on conflict (id) do nothing`,
    [ANA],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'fila-0295-a', 'Fila 0295 A', 'Fila A')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $2, 'agent', now())
     on conflict do nothing`,
    [ANA, ORG],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug) values
       ($1, $3, 'Suporte', 'suporte-fila-0295'), ($2, $3, 'Financeiro', 'financeiro-fila-0295')
     on conflict (id) do nothing`,
    [SUPORTE, FINANCEIRO, ORG],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $2, 'sip_trunk', '\\x00', 'STARTING', 'Fila A', '+556130001295',
        'voip.exemplo-1295.com.br', 5060, 'udp', 'u1295a', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

let ligacoes = 0;

/** Uma ligação RECEBIDA do telefone, tocando, como o worker a cria — por SQL puro. */
async function doTelefone(): Promise<string> {
  ligacoes += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, team_id)
     values ($1, $2, 'sip_trunk', $3, 'inbound', '+5561988881295', 'ringing', $4)
     returning id`,
    [ORG, NUMERO, `fila-1295-${ligacoes}`, SUPORTE],
  );
  return rows[0]!.id;
}

/** O INSERT da linha do WaCalls (o default de `provider`), como o agent o faz pela REST, com colunas a mais. */
const insertDoWacalls = (colunas: string, valores: string) => `
  insert into public.voice_calls
    (organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status, created_by, owner_user_id${colunas})
  values ('${ORG}', '${NUMERO}', 'wa-1295-' || gen_random_uuid(), 'inbound', '+5561999991295', 'ringing', '${ANA}', '${ANA}'${valores})`;

/** O que ficou na linha: as duas colunas da fila e, pelo relógio do BANCO, quanto uma está da outra. */
const naLinha = async (id: string) =>
  (
    await pool.query<{ queued_at: Date | null; queue_deadline_at: Date | null; espera_ms: string | null }>(
      `select queued_at, queue_deadline_at,
              round(extract(epoch from (queue_deadline_at - queued_at)) * 1000) as espera_ms
         from public.voice_calls where id = $1`,
      [id],
    )
  ).rows[0]!;

const tetoDoTime = async (id: string) =>
  (
    await pool.query<{ teto: number | null }>(
      "select phone_queue_max_wait_seconds as teto from public.attendance_teams where id = $1",
      [id],
    )
  ).rows[0]!.teto;

type Recusa = { codigo: string | undefined; constraint: string | undefined };

/** O que o Postgres respondeu a uma escrita que tinha de ser recusada (ou `null`, se ela passou). */
async function recusa(escrita: () => Promise<unknown>): Promise<Recusa | null> {
  try {
    await escrita();
    return null;
  } catch (e) {
    const erro = e as { code?: string; constraint?: string };
    return { codigo: erro.code, constraint: erro.constraint };
  }
}

/** A DML como `authenticated` com o JWT de `usuario` (o PostgREST), desfeita no fim. */
async function comoMembro(usuario: string, dml: string): Promise<{ linhas: number } | Recusa> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuario })]);
    const r = await c.query(dml);
    return { linhas: r.rowCount ?? 0 };
  } catch (e) {
    const erro = e as { code?: string; constraint?: string };
    return { codigo: erro.code, constraint: erro.constraint };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

const validado = async (tabela: string, check: string) =>
  (
    await pool.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conrelid = $1::regclass and conname = $2",
      [tabela, check],
    )
  ).rows[0]?.convalidated;

/** Os índices da 0295 que existem agora, em ordem de nome. */
const indicesDaFila = async () =>
  (
    await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and indexname in ('idx_voice_calls_recebidas_vivas', 'idx_voice_calls_perdidas_recentes')
        order by indexname`,
    )
  ).rows.map((r) => r.indexname);

describe("as três colunas existem, nulas e sem default", () => {
  it("`queued_at` e `queue_deadline_at` em voice_calls, `phone_queue_max_wait_seconds` em attendance_teams", async () => {
    const { rows } = await pool.query<{
      table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (
            ('voice_calls', 'queued_at'), ('voice_calls', 'queue_deadline_at'),
            ('attendance_teams', 'phone_queue_max_wait_seconds'))`,
    );
    const colunas = Object.fromEntries(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    expect(Object.keys(colunas).sort()).toEqual([
      "attendance_teams.phone_queue_max_wait_seconds",
      "voice_calls.queue_deadline_at",
      "voice_calls.queued_at",
    ]);
    expect(colunas["voice_calls.queued_at"]).toMatchObject({
      data_type: "timestamp with time zone", is_nullable: "YES", column_default: null,
    });
    expect(colunas["voice_calls.queue_deadline_at"]).toMatchObject({
      data_type: "timestamp with time zone", is_nullable: "YES", column_default: null,
    });
    expect(colunas["attendance_teams.phone_queue_max_wait_seconds"]).toMatchObject({
      data_type: "integer", is_nullable: "YES", column_default: null,
    });
  });

  it("linha nova nasce sem ordem de chegada, sem prazo e sem teto: nada é inventado", async () => {
    const id = await doTelefone();
    expect(await naLinha(id)).toMatchObject({ queued_at: null, queue_deadline_at: null });
    // Um time criado agora, e não o da semeadura: outros casos deste arquivo gravam teto neles.
    const { rows } = await pool.query<{ id: string }>(
      "insert into public.attendance_teams (organization_id, name, slug) values ($1, 'Recém-criado', 'recem-criado-fila-0295') returning id",
      [ORG],
    );
    expect(await tetoDoTime(rows[0]!.id)).toBeNull();
  });
});

describe("a ordem de chegada e o prazo são só da linha do telefone", () => {
  it("a linha do telefone aceita as duas — e o prazo fica a exatos 120 s da chegada, no relógio do banco", async () => {
    const id = await doTelefone();
    await pool.query(
      "update public.voice_calls set queued_at = now(), queue_deadline_at = now() + interval '120 seconds' where id = $1",
      [id],
    );
    const l = await naLinha(id);
    expect(l.queued_at).toBeInstanceOf(Date);
    expect(l.queue_deadline_at).toBeInstanceOf(Date);
    expect(Number(l.espera_ms)).toBe(120_000);
    // Cada uma sozinha também vale: na fila com gente livre não há prazo correndo.
    await pool.query("update public.voice_calls set queue_deadline_at = null where id = $1", [id]);
    expect(await naLinha(id)).toMatchObject({ queue_deadline_at: null });
    expect((await naLinha(id)).queued_at).toBeInstanceOf(Date);
  });

  it("a linha do WaCalls recusa `queued_at` — para o agent pela REST e para o worker", async () => {
    // Controle positivo: sem a coluna, o INSERT do WaCalls entra como hoje.
    expect(await comoMembro(ANA, insertDoWacalls("", ""))).toEqual({ linhas: 1 });
    expect(await comoMembro(ANA, insertDoWacalls(", queued_at", ", now()"))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
    expect(await recusa(() => pool.query(insertDoWacalls(", queued_at", ", now()")))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
  });

  it("a linha do WaCalls recusa `queue_deadline_at` — para o agent pela REST e para o worker", async () => {
    expect(await comoMembro(ANA, insertDoWacalls(", queue_deadline_at", ", now() + interval '2 minutes'"))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
    expect(
      await recusa(() => pool.query(insertDoWacalls(", queue_deadline_at", ", now() + interval '2 minutes'"))),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA });
  });

  it("nem por UPDATE: a linha do WaCalls que já existe não entra na fila depois", async () => {
    const { rows } = await pool.query<{ id: string }>(`${insertDoWacalls("", "")} returning id`);
    const id = rows[0]!.id;
    // A REST alcança esta linha (é do WaCalls, da organização da Ana) — quem recusa é o CHECK.
    expect(await comoMembro(ANA, `update public.voice_calls set status = 'connected' where id = '${id}'`)).toEqual({ linhas: 1 });
    expect(await comoMembro(ANA, `update public.voice_calls set queued_at = now() where id = '${id}'`)).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
    expect(
      await comoMembro(ANA, `update public.voice_calls set queue_deadline_at = now() where id = '${id}'`),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA });
    expect(await naLinha(id)).toMatchObject({ queued_at: null, queue_deadline_at: null });
  });

  it("o CHECK está validado: vale para o histórico, não só para a linha nova", async () => {
    expect(await validado("public.voice_calls", CHECK_DA_FILA)).toBe(true);
  });
});

describe("a espera máxima do time fica entre 30 s e 30 min", () => {
  it.each([30, 120, 1800])("aceita %i s", async (segundos) => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = $2 where id = $1", [FINANCEIRO, segundos]);
    expect(await tetoDoTime(FINANCEIRO)).toBe(segundos);
  });

  it("aceita nulo: é o padrão de sempre", async () => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 300 where id = $1", [FINANCEIRO]);
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = null where id = $1", [FINANCEIRO]);
    expect(await tetoDoTime(FINANCEIRO)).toBeNull();
  });

  it.each([29, 1801, 0, -5])("recusa %i s, e o que estava gravado não muda", async (segundos) => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 600 where id = $1", [FINANCEIRO]);
    expect(
      await recusa(() =>
        pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = $2 where id = $1", [FINANCEIRO, segundos]),
      ),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_TETO });
    expect(await tetoDoTime(FINANCEIRO)).toBe(600);
  });

  it("o CHECK está validado", async () => {
    expect(await validado("public.attendance_teams", CHECK_DO_TETO)).toBe(true);
  });
});

describe("os dois índices da aba Telefone existem, e são parciais", () => {
  const indice = async (nome: string) =>
    (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'voice_calls' and indexname = $1",
        [nome],
      )
    ).rows[0]?.indexdef;

  it("as recebidas vivas da organização, por ordem de início", async () => {
    const def = await indice("idx_voice_calls_recebidas_vivas");
    expect(def).toBeDefined();
    expect(def).toContain("(organization_id, started_at)");
    // Parcial: ligação encerrada e ligação feita ficam de fora.
    expect(def).toMatch(/WHERE .*status <> 'ended'/);
    expect(def).toMatch(/WHERE .*direction = 'inbound'/);
  });

  it("as perdidas recentes da organização, da mais nova para a mais velha", async () => {
    const def = await indice("idx_voice_calls_perdidas_recentes");
    expect(def).toBeDefined();
    expect(def).toContain("(organization_id, ended_at DESC)");
    // Parcial: só a recebida que acabou sem ninguém atender.
    expect(def).toMatch(/WHERE .*direction = 'inbound'/);
    expect(def).toMatch(/WHERE .*answered_at IS NULL/);
    expect(def).toMatch(/WHERE .*ended_at IS NOT NULL/);
  });
});

describe("a REST não escreve nenhuma das três", () => {
  it("a linha do telefone o agent não altera: ninguém forja a própria posição na fila", async () => {
    const id = await doTelefone();
    // Controle positivo: a Ana ENXERGA a linha — o zero abaixo é a policy de escrita, não a de leitura.
    expect(await comoMembro(ANA, `select 1 from public.voice_calls where id = '${id}'`)).toEqual({ linhas: 1 });
    expect(
      await comoMembro(ANA, `update public.voice_calls set queued_at = now() - interval '10 minutes' where id = '${id}'`),
    ).toEqual({ linhas: 0 });
    expect(
      await comoMembro(ANA, `update public.voice_calls set queue_deadline_at = now() + interval '1 hour' where id = '${id}'`),
    ).toEqual({ linhas: 0 });
    expect(await naLinha(id)).toMatchObject({ queued_at: null, queue_deadline_at: null });
  });

  it("o teto do time o agent lê e não grava: `attendance_teams` só tem GRANT de leitura", async () => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 240 where id = $1", [SUPORTE]);
    // Controle positivo: a leitura passa — a recusa abaixo é da ESCRITA.
    expect(
      await comoMembro(ANA, `select 1 from public.attendance_teams where id = '${SUPORTE}' and phone_queue_max_wait_seconds = 240`),
    ).toEqual({ linhas: 1 });
    const r = await comoMembro(ANA, `update public.attendance_teams set phone_queue_max_wait_seconds = 1800 where id = '${SUPORTE}'`);
    // 42501 = insufficient_privilege: quem barra é o GRANT, antes de qualquer policy.
    expect(r).toMatchObject({ codigo: "42501" });
    expect(await tetoDoTime(SUPORTE)).toBe(240);
  });
});

describe("o bloco do baseline se cura sozinho", () => {
  /** O bloco da 0295, como o `update.sh` o reaplica. */
  function blocoDoBaseline(): string {
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const inicio = baseline.indexOf("-- ---- telefonia: a fila visível (migration 0295) ----");
    const fim = baseline.indexOf("\n-- ---- ", inicio + 10);
    if (inicio < 0 || fim < 0) throw new Error("bloco da 0295 não encontrado no baseline");
    return baseline.slice(inicio, fim);
  }

  it("o instrumento está vivo: o recorte pegou o bloco inteiro, e só ele", () => {
    // Sem isto, um recorte que parasse cedo reaplicaria meio bloco, e os casos
    // abaixo passariam (ou falhariam) pelo motivo errado.
    const bloco = blocoDoBaseline();
    expect(bloco).toContain(CHECK_DA_FILA);
    expect(bloco).toContain(CHECK_DO_TETO);
    expect(bloco).toContain("idx_voice_calls_recebidas_vivas");
    expect(bloco).toContain("idx_voice_calls_perdidas_recentes");
    expect(bloco.match(/^-- ---- /gm)).toHaveLength(1);
  });

  it("CHECK da fila derrubado e linha do WaCalls na fila: reaplicar limpa a linha e recria o CHECK validado", async () => {
    expect(await validado("public.voice_calls", CHECK_DA_FILA)).toBe(true);

    await pool.query(`alter table public.voice_calls drop constraint ${CHECK_DA_FILA}`);
    const { rows: fora } = await pool.query<{ id: string }>(
      `${insertDoWacalls(", queued_at, queue_deadline_at", ", now(), now() + interval '2 minutes'")} returning id`,
    );
    const { rows: soPrazo } = await pool.query<{ id: string }>(
      `${insertDoWacalls(", queue_deadline_at", ", now() + interval '2 minutes'")} returning id`,
    );
    // A ordem de chegada e o prazo de uma ligação do telefone não podem sumir na cura.
    const doTel = await doTelefone();
    await pool.query(
      "update public.voice_calls set queued_at = now(), queue_deadline_at = now() + interval '90 seconds' where id = $1",
      [doTel],
    );

    const bloco = blocoDoBaseline();
    await pool.query(bloco);
    await pool.query(bloco); // duas vezes: reaplicar não quebra nem duplica

    expect(await validado("public.voice_calls", CHECK_DA_FILA)).toBe(true);
    expect(await naLinha(fora[0]!.id)).toMatchObject({ queued_at: null, queue_deadline_at: null });
    expect(await naLinha(soPrazo[0]!.id)).toMatchObject({ queued_at: null, queue_deadline_at: null });
    expect(Number((await naLinha(doTel)).espera_ms)).toBe(90_000);
    // E o CHECK recriado recusa de novo.
    expect(await recusa(() => pool.query(insertDoWacalls(", queued_at", ", now()")))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
  });

  it("CHECK do teto derrubado e time com 5 s: reaplicar devolve o time ao padrão, e o teto legítimo do outro fica", async () => {
    await pool.query(`alter table public.attendance_teams drop constraint ${CHECK_DO_TETO}`);
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 5 where id = $1", [SUPORTE]);
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 300 where id = $1", [FINANCEIRO]);

    const bloco = blocoDoBaseline();
    await pool.query(bloco);
    await pool.query(bloco);

    expect(await validado("public.attendance_teams", CHECK_DO_TETO)).toBe(true);
    expect(await tetoDoTime(SUPORTE)).toBeNull();
    expect(await tetoDoTime(FINANCEIRO)).toBe(300);
    expect(
      await recusa(() => pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 5 where id = $1", [SUPORTE])),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_TETO });
  });

  it("os índices derrubados voltam", async () => {
    await pool.query("drop index public.idx_voice_calls_recebidas_vivas, public.idx_voice_calls_perdidas_recentes");
    await pool.query(blocoDoBaseline());
    expect(await indicesDaFila()).toEqual(["idx_voice_calls_perdidas_recentes", "idx_voice_calls_recebidas_vivas"]);
  });
});

// Por último de propósito: este caso desfaz a 0295 inteira no banco do arquivo.
describe("o arquivo da cadeia chega ao mesmo lugar que o bloco do baseline", () => {
  // `pnpm test:db` aplica só o baseline — o arquivo de `supabase/migrations/` é
  // o que o Supabase CLI aplica, e sem este caso nenhum gate o executa.
  it("num banco na 0294, aplicar a migration cria colunas, CHECKs e índices; reaplicar não quebra", async () => {
    await pool.query(`
      drop index if exists public.idx_voice_calls_recebidas_vivas, public.idx_voice_calls_perdidas_recentes;
      alter table public.voice_calls drop constraint if exists ${CHECK_DA_FILA};
      alter table public.attendance_teams drop constraint if exists ${CHECK_DO_TETO};
      alter table public.voice_calls drop column if exists queued_at, drop column if exists queue_deadline_at;
      alter table public.attendance_teams drop column if exists phone_queue_max_wait_seconds;`);
    // Controle: o banco voltou mesmo à 0294 — senão o que se mede abaixo é o baseline, não a migration.
    expect(await validado("public.voice_calls", CHECK_DA_FILA)).toBeUndefined();
    expect(await validado("public.attendance_teams", CHECK_DO_TETO)).toBeUndefined();
    expect(await indicesDaFila()).toEqual([]);
    expect(await recusa(() => pool.query("select queued_at, queue_deadline_at from public.voice_calls limit 1"))).toMatchObject({
      codigo: "42703", // undefined_column
    });

    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20261007010000_0295_telefonia_fila_visivel.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration); // idempotente

    expect(await validado("public.voice_calls", CHECK_DA_FILA)).toBe(true);
    expect(await validado("public.attendance_teams", CHECK_DO_TETO)).toBe(true);
    expect(await indicesDaFila()).toEqual(["idx_voice_calls_perdidas_recentes", "idx_voice_calls_recebidas_vivas"]);
    // E as regras são as mesmas do baseline: o telefone aceita, o WaCalls e o teto fora da faixa não.
    const id = await doTelefone();
    await pool.query(
      "update public.voice_calls set queued_at = now(), queue_deadline_at = now() + interval '45 seconds' where id = $1",
      [id],
    );
    expect(Number((await naLinha(id)).espera_ms)).toBe(45_000);
    expect(await recusa(() => pool.query(insertDoWacalls(", queue_deadline_at", ", now()")))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_FILA,
    });
    expect(
      await recusa(() => pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 1801 where id = $1", [SUPORTE])),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_TETO });
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 1800 where id = $1", [SUPORTE]);
    expect(await tetoDoTime(SUPORTE)).toBe(1800);
  });
});
