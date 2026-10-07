/**
 * AS ORDENS DA FILA DO TELEFONE — O SCHEMA, CONTRA POSTGRES REAL (migration 0296).
 *
 * "Atender" e "Mover" na aba Telefone não agem sozinhos: a rota confere e GRAVA o
 * pedido numa linha de `voice_call_queue_orders`, avisa o worker, e o worker relê
 * a linha pelo id antes de agir (o mesmo desenho da transferência, 0290). A linha
 * é o que impede dois atendentes de puxarem a mesma ligação, e o que a tela lê
 * para dizer "Ana está atendendo…".
 *
 * Aqui não se prova rota nem worker (eles nem existem quando este arquivo entra):
 * prova-se o SCHEMA que o `install.sh` e o `update.sh` deixam, e por isso toda
 * semeadura é SQL puro:
 *
 *  1. a tabela tem as colunas do desenho, e uma ordem nova nasce aberta, sem
 *     desfecho e sem fim;
 *  2. as catracas: tipo, situação e desfecho só do vocabulário; aberta não tem
 *     fim e encerrada tem;
 *  3. UMA ABERTA POR LIGAÇÃO, no banco: dois cliques simultâneos em "Atender" não
 *     abrem duas. Encerrada a primeira, a próxima abre;
 *  4. NENHUM PONTEIRO ATRAVESSA ORGANIZAÇÃO: a ordem de A não aponta para a
 *     ligação nem para o time de B (FK composta); apagar o time não apaga a
 *     história, e apagar a ligação leva as ordens dela;
 *  5. ISOLAMENTO: com o JWT de um membro, A lê as de A e nenhuma de B (e B,
 *     nenhuma de A) — com controle positivo nos dois lados;
 *  6. A REST SÓ LÊ: `anon`, `authenticated` e `service_role` não inserem, não
 *     alteram, não apagam e não truncam; `anon` nem lê. A escrita é da API e do
 *     worker, pela conexão direta;
 *  7. o item 6 vale NO BANCO QUE O CLIENTE TEM: toda tabela nova de `public` nasce
 *     com tudo concedido aos três papéis (o default ACL do Supabase, que o corpo
 *     do próprio baseline regrava). Medido com controle: sem o bloco, a tabela
 *     aceita a escrita de `service_role`; com ele, não;
 *  8. o bloco do baseline se cura sozinho: o que foi derrubado volta, e uma linha
 *     fora da regra não quebra a reaplicação (o que o `update.sh` faz);
 *  9. o arquivo de `supabase/migrations/` chega ao mesmo lugar que o bloco do
 *     baseline — `pnpm test:db` aplica só o baseline, e sem este caso nenhum gate
 *     executaria o arquivo que o Supabase CLI aplica.
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

const A = "c0de0296-0000-4000-8000-00000000000a";
const B = "c0de0296-0000-4000-8000-00000000000b";
/** Agent de A. */
const ANA = "c0de0296-1111-4000-8000-00000000000a";
/** Agent de A também: quem perde a corrida do "Atender". */
const BIA = "c0de0296-1111-4000-8000-0000000000a2";
/** Agent de B. */
const CAIO = "c0de0296-1111-4000-8000-00000000000b";
/** Tem conta e não é de organização nenhuma. */
const DE_FORA = "c0de0296-1111-4000-8000-0000000000ff";
const SUPORTE_A = "c0de0296-2222-4000-8000-00000000000a";
const FINANCEIRO_A = "c0de0296-2222-4000-8000-0000000000a2";
const SUPORTE_B = "c0de0296-2222-4000-8000-00000000000b";
const NUMERO_A = "c0de0296-5555-4000-8000-00000000000a";
const NUMERO_B = "c0de0296-5555-4000-8000-00000000000b";

const TABELA = "public.voice_call_queue_orders";
const CHECK_DO_TIPO = "voice_call_queue_orders_kind_check";
const CHECK_DA_SITUACAO = "voice_call_queue_orders_status_check";
const CHECK_DO_DESFECHO = "voice_call_queue_orders_outcome_check";
const CHECK_DO_FIM = "voice_call_queue_orders_fim_check";
const CHECKS = [CHECK_DO_FIM, CHECK_DO_TIPO, CHECK_DO_DESFECHO, CHECK_DA_SITUACAO];
const UMA_ABERTA = "voice_call_queue_orders_uma_aberta";
const DA_LIGACAO = "voice_call_queue_orders_da_ligacao";
const POLICY = "tenant_isolation_voice_call_queue_orders_select";
const PAPEIS_DA_REST = ["anon", "authenticated", "service_role"] as const;
type Papel = (typeof PAPEIS_DA_REST)[number];

/** `check_violation`: um CHECK recusando a linha. */
const VIOLA_CHECK = "23514";
/** `unique_violation`. */
const JA_EXISTE = "23505";
/** `foreign_key_violation`. */
const VIOLA_FK = "23503";
/** `not_null_violation`. */
const FALTA_VALOR = "23502";
/** `insufficient_privilege`: quem barra é o GRANT, antes de qualquer policy. */
const SEM_PRIVILEGIO = "42501";

const ROTULO = "-- ---- telefonia: as ordens da fila — atender e mover (migration 0296) ----";
const MIGRATION = "supabase/migrations/20261007020000_0296_telefonia_ordens_da_fila.sql";

/** O bloco da 0296, como o `update.sh` o reaplica: do rótulo até o próximo rótulo do apêndice. */
function blocoDoBaseline(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0296 não encontrado no baseline");
  if (baseline.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0296 repetido no baseline");
  const fim = baseline.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0296 não encontrado");
  return baseline.slice(inicio, fim);
}

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

/**
 * O comando como um papel da REST — `authenticated` com o JWT de `usuario`, que é
 * a forma do PostgREST —, desfeito no fim. Devolve as linhas alcançadas, ou a recusa.
 */
async function comoPapel(papel: Papel, usuario: string | null, comando: string): Promise<{ linhas: number } | Recusa> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    if (usuario) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuario })]);
    }
    const r = await c.query(comando);
    return { linhas: r.rowCount ?? 0 };
  } catch (e) {
    const erro = e as { code?: string; constraint?: string };
    return { codigo: erro.code, constraint: erro.constraint };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

let ligacoes = 0;

/** Uma ligação RECEBIDA do telefone, esperando por uma pessoa — por SQL puro, como o worker a deixa. */
async function ligacaoNaFila(org: string = A): Promise<string> {
  ligacoes += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, team_id, queued_at)
     values ($1, $2, 'sip_trunk', $3, 'inbound', '+5561977770296', 'ringing', $4, now())
     returning id`,
    [org, org === A ? NUMERO_A : NUMERO_B, `ordem-0296-${ligacoes}`, org === A ? SUPORTE_A : SUPORTE_B],
  );
  return rows[0]!.id;
}

interface Ordem {
  org?: string;
  ligacao: string;
  kind?: string | null;
  por?: string | null;
  para_pessoa?: string | null;
  para_time?: string | null;
  de_time?: string | null;
  status?: string;
  outcome?: string | null;
  /** `true` = encerrada agora. */
  fim?: boolean;
}

/** Uma ordem, pela conexão direta (o caminho da API e do worker). Sem `status`, nasce aberta: "Atender" da Ana. */
async function ordem(o: Ordem): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ${TABELA}
       (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id, status, outcome, ended_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $10::boolean then now() end)
     returning id`,
    [
      o.org ?? A,
      o.ligacao,
      o.kind === undefined ? "pull" : o.kind,
      o.por === undefined ? ANA : o.por,
      o.para_pessoa === undefined ? null : o.para_pessoa,
      o.para_time ?? null,
      o.de_time ?? null,
      o.status ?? "open",
      o.outcome ?? null,
      o.fim ?? false,
    ],
  );
  return rows[0]!.id;
}

const encerrar = (id: string, outcome = "done") =>
  pool.query(`update ${TABELA} set status = 'ended', outcome = $2, ended_at = now() where id = $1`, [id, outcome]);

const linha = async (id: string) =>
  (
    await pool.query<{
      organization_id: string; status: string; outcome: string | null; reason: string | null;
      to_team_id: string | null; from_team_id: string | null; created_at: Date | null; ended_at: Date | null;
    }>(
      `select organization_id, status, outcome, reason, to_team_id, from_team_id, created_at, ended_at
         from ${TABELA} where id = $1`,
      [id],
    )
  ).rows[0];

/** Os CHECKs da tabela, `nome → validado`. */
const checks = async () =>
  Object.fromEntries(
    (
      await pool.query<{ conname: string; convalidated: boolean }>(
        `select conname, convalidated from pg_constraint
          where contype = 'c' and conrelid = '${TABELA}'::regclass order by conname`,
      )
    ).rows.map((r) => [r.conname, r.convalidated]),
  );

const oidsDosChecks = async () =>
  (
    await pool.query<{ ref: string }>(
      `select conname || ':' || oid as ref from pg_constraint
        where contype = 'c' and conrelid = '${TABELA}'::regclass order by conname`,
    )
  ).rows.map((r) => r.ref);

/** Privilégio concedido DIRETAMENTE na tabela aos papéis da REST e a PUBLIC. */
const concedidos = async (tabela = "voice_call_queue_orders") =>
  (
    await pool.query<{ p: string }>(
      `select grantee || ':' || string_agg(privilege_type, ',' order by privilege_type) as p
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1
          and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
        group by grantee order by grantee`,
      [tabela],
    )
  ).rows.map((r) => r.p);

/** O privilégio EFETIVO — inclui o herdado de PUBLIC, que a consulta acima, filtrada por grantee, não vê. */
const efetivos = async () =>
  (
    await pool.query<{ p: string }>(
      `select papel || ':' || priv as p
         from unnest(array['anon', 'authenticated', 'service_role']) papel,
              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
        where has_table_privilege(papel, '${TABELA}', priv)
        order by papel, priv`,
    )
  ).rows.map((r) => r.p);

/**
 * Tudo o que a 0296 deixa no catálogo: colunas, constraints, índices, RLS,
 * policies, privilégios e comentários. Dois bancos com o mesmo retrato têm a
 * mesma tabela.
 */
async function retrato() {
  const q = async (texto: string) => (await pool.query(texto)).rows;
  return {
    colunas: await q(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'voice_call_queue_orders' order by ordinal_position`,
    ),
    constraints: await q(
      `select conname, contype, convalidated, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = '${TABELA}'::regclass order by conname`,
    ),
    indices: await q(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'voice_call_queue_orders' order by indexname`,
    ),
    rls: await q(`select relrowsecurity, relforcerowsecurity from pg_class where oid = '${TABELA}'::regclass`),
    policies: await q(
      `select policyname, permissive, roles::text as roles, cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = 'voice_call_queue_orders' order by policyname`,
    ),
    privilegios: await q(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'voice_call_queue_orders' order by grantee, privilege_type`,
    ),
    comentarios: await q(
      `select a.attname, col_description(a.attrelid, a.attnum) as texto
         from pg_attribute a
        where a.attrelid = '${TABELA}'::regclass and a.attnum > 0 and not a.attisdropped
          and col_description(a.attrelid, a.attnum) is not null
        union all
       select '(tabela)', obj_description('${TABELA}'::regclass, 'pg_class')
        order by 1`,
    ),
  };
}

/** Uma ordem ENCERRADA em cada organização: o que a leitura de cada membro tem de achar (e a do vizinho, não). */
let ordemDeA: string;
let ordemDeB: string;

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'ordem-0296-ana@invariant.test'), ($2, 'ordem-0296-bia@invariant.test'),
       ($3, 'ordem-0296-caio@invariant.test'), ($4, 'ordem-0296-de-fora@invariant.test')
     on conflict (id) do nothing`,
    [ANA, BIA, CAIO, DE_FORA],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'ordem-0296-a', 'Ordem 0296 A', 'Ordem A'), ($2, 'ordem-0296-b', 'Ordem 0296 B', 'Ordem B')
     on conflict (id) do nothing`,
    [A, B],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $4, 'agent', now()), ($2, $4, 'agent', now()), ($3, $5, 'agent', now())
     on conflict do nothing`,
    [ANA, BIA, CAIO, A, B],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug) values
       ($1, $4, 'Suporte', 'suporte-0296'), ($2, $4, 'Financeiro', 'financeiro-0296'), ($3, $5, 'Suporte', 'suporte-0296')
     on conflict (id) do nothing`,
    [SUPORTE_A, FINANCEIRO_A, SUPORTE_B, A, B],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Ordem A', '+556130000296',
        'voip.exemplo-0296.com.br', 5060, 'udp', 'u0296a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Ordem B', '+556130000297',
        'voip.exemplo-0296.com.br', 5060, 'udp', 'u0296b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO_A, NUMERO_B, A, B],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("a tabela tem as colunas do desenho", () => {
  it("nome, tipo, nulidade e default de cada uma", async () => {
    const { rows } = await pool.query<{
      column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'voice_call_queue_orders' order by ordinal_position`,
    );
    expect(rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable === "NO" ? "not null" : "null"}`)).toEqual([
      "id uuid not null",
      "organization_id uuid not null",
      "voice_call_id uuid not null",
      "kind text not null",
      "requested_by uuid null",
      "to_user_id uuid null",
      "to_team_id uuid null",
      "from_team_id uuid null",
      "status text not null",
      "outcome text null",
      "reason text null",
      "created_at timestamp with time zone not null",
      "ended_at timestamp with time zone null",
    ]);
    const padrao = Object.fromEntries(rows.filter((r) => r.column_default !== null).map((r) => [r.column_name, r.column_default]));
    expect(padrao).toEqual({ id: "gen_random_uuid()", status: "'open'::text", created_at: "now()" });
  });

  it("uma ordem nova nasce aberta, sem desfecho, sem motivo e sem fim", async () => {
    const ligacao = await ligacaoNaFila();
    const { rows } = await pool.query<{ id: string }>(
      `insert into ${TABELA} (organization_id, voice_call_id, kind) values ($1, $2, 'pull') returning id`,
      [A, ligacao],
    );
    const l = await linha(rows[0]!.id);
    expect(l).toMatchObject({ status: "open", outcome: null, reason: null, ended_at: null });
    expect(l?.created_at).toBeInstanceOf(Date);
    await encerrar(rows[0]!.id);
  });

  it("organização, ligação e tipo são obrigatórios", async () => {
    const ligacao = await ligacaoNaFila();
    const inserir = (org: string | null, vc: string | null, kind: string | null) =>
      recusa(() =>
        pool.query(`insert into ${TABELA} (organization_id, voice_call_id, kind) values ($1, $2, $3)`, [org, vc, kind]),
      );
    expect(await inserir(null, ligacao, "pull")).toMatchObject({ codigo: FALTA_VALOR });
    expect(await inserir(A, null, "pull")).toMatchObject({ codigo: FALTA_VALOR });
    expect(await inserir(A, ligacao, null)).toMatchObject({ codigo: FALTA_VALOR });
  });
});

describe("as catracas do schema", () => {
  it("os quatro CHECKs existem e estão validados", async () => {
    expect(await checks()).toEqual(Object.fromEntries(CHECKS.map((c) => [c, true])));
  });

  it.each(["pull", "move"])("o tipo `%s` entra", async (kind) => {
    const id = await ordem({ ligacao: await ligacaoNaFila(), kind });
    expect(await linha(id)).toMatchObject({ status: "open" });
  });

  it.each(["transfer", "PULL", ""])("o tipo `%s` é recusado", async (kind) => {
    expect(await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), kind }))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DO_TIPO,
    });
  });

  it.each(["pending", "closed", ""])("a situação `%s` é recusada", async (status) => {
    expect(await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), status, fim: true }))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DA_SITUACAO,
    });
  });

  it.each(["done", "refused", "no_answer", "cancelled"])("o desfecho `%s` entra", async (outcome) => {
    const id = await ordem({ ligacao: await ligacaoNaFila(), status: "ended", outcome, fim: true });
    expect(await linha(id)).toMatchObject({ status: "ended", outcome });
  });

  it.each(["answered", "missed", "talvez", ""])("o desfecho `%s` é recusado", async (outcome) => {
    expect(
      await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), status: "ended", outcome, fim: true })),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_DESFECHO });
  });

  it("e por UPDATE também: a ordem aberta não fecha com desfecho inventado", async () => {
    const id = await ordem({ ligacao: await ligacaoNaFila() });
    expect(await recusa(() => encerrar(id, "talvez"))).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_DESFECHO });
    expect(await linha(id)).toMatchObject({ status: "open", outcome: null, ended_at: null });
  });

  it("aberta não tem fim", async () => {
    expect(await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), status: "open", fim: true }))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DO_FIM,
    });
  });

  it("encerrada tem fim — no INSERT e no UPDATE que fecha", async () => {
    expect(
      await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), status: "ended", outcome: "done", fim: false })),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_FIM });

    const id = await ordem({ ligacao: await ligacaoNaFila() });
    expect(
      await recusa(() => pool.query(`update ${TABELA} set status = 'ended', outcome = 'done' where id = $1`, [id])),
    ).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_FIM });
    expect(await recusa(() => pool.query(`update ${TABELA} set ended_at = now() where id = $1`, [id]))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DO_FIM,
    });
    // Controle positivo: fechando as três coisas juntas, entra.
    await encerrar(id, "no_answer");
    const l = await linha(id);
    expect(l).toMatchObject({ status: "ended", outcome: "no_answer" });
    expect(l?.ended_at).toBeInstanceOf(Date);
  });

  it("o motivo é vocabulário aberto: texto livre, sem CHECK", async () => {
    const id = await ordem({ ligacao: await ligacaoNaFila() });
    await pool.query(
      `update ${TABELA} set status = 'ended', outcome = 'refused', reason = 'um_motivo_que_ainda_nao_existe', ended_at = now()
        where id = $1`,
      [id],
    );
    expect(await linha(id)).toMatchObject({ outcome: "refused", reason: "um_motivo_que_ainda_nao_existe" });
  });
});

describe("uma ordem aberta por ligação", () => {
  it("a segunda aberta na mesma ligação é recusada — outro tipo, outra pessoa, tanto faz", async () => {
    const ligacao = await ligacaoNaFila();
    await ordem({ ligacao, kind: "pull", por: ANA, para_pessoa: ANA });
    expect(await recusa(() => ordem({ ligacao, kind: "pull", por: BIA, para_pessoa: BIA }))).toEqual({
      codigo: JA_EXISTE, constraint: UMA_ABERTA,
    });
    expect(await recusa(() => ordem({ ligacao, kind: "move", por: BIA, para_time: FINANCEIRO_A }))).toEqual({
      codigo: JA_EXISTE, constraint: UMA_ABERTA,
    });
  });

  it("encerrada a primeira, a segunda entra — e a história das duas fica", async () => {
    const ligacao = await ligacaoNaFila();
    const primeira = await ordem({ ligacao, por: ANA, para_pessoa: ANA });
    expect(await recusa(() => ordem({ ligacao, por: BIA, para_pessoa: BIA }))).toMatchObject({ codigo: JA_EXISTE });
    await encerrar(primeira, "no_answer");
    const segunda = await ordem({ ligacao, por: BIA, para_pessoa: BIA });
    expect(await linha(segunda)).toMatchObject({ status: "open" });
    const { rows } = await pool.query(`select status from ${TABELA} where voice_call_id = $1 order by created_at, status`, [ligacao]);
    expect(rows.map((r) => r.status).sort()).toEqual(["ended", "open"]);
  });

  it("a trava é da LIGAÇÃO, não da organização: outra ligação tem a sua ordem aberta", async () => {
    const [uma, outra] = [await ligacaoNaFila(), await ligacaoNaFila()];
    await ordem({ ligacao: uma });
    const id = await ordem({ ligacao: outra });
    expect(await linha(id)).toMatchObject({ status: "open" });
  });

  it("os dois índices: o único parcial das abertas e o da história da ligação", async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'voice_call_queue_orders' and indexname in ($1, $2)
        order by indexname`,
      [UMA_ABERTA, DA_LIGACAO],
    );
    const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(def[UMA_ABERTA]).toMatch(/^CREATE UNIQUE INDEX /);
    expect(def[UMA_ABERTA]).toContain("(voice_call_id)");
    // Parcial: a história (as encerradas) não entra na trava.
    expect(def[UMA_ABERTA]).toMatch(/WHERE \(status = 'open'::text\)$/);
    expect(def[DA_LIGACAO]).toContain("(organization_id, voice_call_id, created_at)");
    expect(def[DA_LIGACAO]).not.toMatch(/UNIQUE|WHERE/);
  });
});

describe("nenhum ponteiro atravessa organização", () => {
  it("controle positivo: ligação e times da PRÓPRIA organização entram", async () => {
    const id = await ordem({ ligacao: await ligacaoNaFila(A), kind: "move", para_time: FINANCEIRO_A, de_time: SUPORTE_A });
    expect(await linha(id)).toMatchObject({ organization_id: A, to_team_id: FINANCEIRO_A, from_team_id: SUPORTE_A });
  });

  it("a ordem de A não aponta para a ligação de B", async () => {
    const r = await recusa(async () => ordem({ org: A, ligacao: await ligacaoNaFila(B) }));
    expect(r).toMatchObject({ codigo: VIOLA_FK });
    expect(r?.constraint).toContain("voice_call_id_fkey");
  });

  it("nem a de B para a ligação de A", async () => {
    const r = await recusa(async () => ordem({ org: B, ligacao: await ligacaoNaFila(A), por: CAIO }));
    expect(r).toMatchObject({ codigo: VIOLA_FK });
    expect(r?.constraint).toContain("voice_call_id_fkey");
  });

  it("a ordem de A não move para o time de B", async () => {
    const r = await recusa(async () => ordem({ ligacao: await ligacaoNaFila(A), kind: "move", para_time: SUPORTE_B }));
    expect(r).toMatchObject({ codigo: VIOLA_FK });
    expect(r?.constraint).toContain("to_team_id_fkey");
  });

  it("nem diz que saiu do time de B", async () => {
    const r = await recusa(async () =>
      ordem({ ligacao: await ligacaoNaFila(A), kind: "move", para_time: FINANCEIRO_A, de_time: SUPORTE_B }),
    );
    expect(r).toMatchObject({ codigo: VIOLA_FK });
    expect(r?.constraint).toContain("from_team_id_fkey");
  });

  it("apagar o time não apaga a história: só a coluna do time fica nula, a organização fica", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.attendance_teams (organization_id, name, slug) values
         ($1, 'Extinto de destino', 'extinto-destino-0296'), ($1, 'Extinto de origem', 'extinto-origem-0296')
       returning id`,
      [A],
    );
    const [destino, origem] = [rows[0]!.id, rows[1]!.id];
    const id = await ordem({ ligacao: await ligacaoNaFila(), kind: "move", para_time: destino, de_time: origem });
    await encerrar(id);

    await pool.query("delete from public.attendance_teams where id = $1", [destino]);
    expect(await linha(id)).toMatchObject({ organization_id: A, to_team_id: null, from_team_id: origem, outcome: "done" });
    await pool.query("delete from public.attendance_teams where id = $1", [origem]);
    expect(await linha(id)).toMatchObject({ organization_id: A, to_team_id: null, from_team_id: null, outcome: "done" });
  });

  it("apagar a ligação leva as ordens dela, e só as dela", async () => {
    const [some, fica] = [await ligacaoNaFila(), await ligacaoNaFila()];
    const daQueSome = await ordem({ ligacao: some });
    const daQueFica = await ordem({ ligacao: fica });
    await pool.query("delete from public.voice_calls where id = $1", [some]);
    expect(await linha(daQueSome)).toBeUndefined();
    expect(await linha(daQueFica)).toMatchObject({ status: "open" });
  });
});

describe("isolamento entre organizações (JWT de membro, como a REST)", () => {
  beforeAll(async () => {
    ordemDeA = await ordem({ org: A, ligacao: await ligacaoNaFila(A), por: ANA, para_pessoa: ANA });
    await encerrar(ordemDeA);
    ordemDeB = await ordem({ org: B, ligacao: await ligacaoNaFila(B), por: CAIO, para_pessoa: CAIO });
    await encerrar(ordemDeB);
  });

  const lidas = async (usuario: string, org: string) => {
    const r = await comoPapel("authenticated", usuario, `select 1 from ${TABELA} where organization_id = '${org}'`);
    if (!("linhas" in r)) throw new Error(`a leitura foi recusada: ${JSON.stringify(r)}`);
    return r.linhas;
  };

  it("o membro de A lê as de A e NENHUMA de B; o de B, nenhuma de A", async () => {
    expect(await lidas(ANA, A)).toBeGreaterThan(0);
    expect(await lidas(ANA, B)).toBe(0);
    expect(await lidas(CAIO, A)).toBe(0);
    expect(await lidas(CAIO, B)).toBeGreaterThan(0);
  });

  it("sem filtro nenhum, cada um só enxerga a própria organização", async () => {
    const orgsDe = async (usuario: string) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuario })]);
        const { rows } = await c.query<{ organization_id: string }>(`select distinct organization_id from ${TABELA}`);
        return rows.map((r) => r.organization_id);
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    expect(await orgsDe(ANA)).toEqual([A]);
    expect(await orgsDe(CAIO)).toEqual([B]);
  });

  it("pelo id, a ordem do vizinho não existe", async () => {
    expect(await comoPapel("authenticated", ANA, `select 1 from ${TABELA} where id = '${ordemDeA}'`)).toEqual({ linhas: 1 });
    expect(await comoPapel("authenticated", ANA, `select 1 from ${TABELA} where id = '${ordemDeB}'`)).toEqual({ linhas: 0 });
    expect(await comoPapel("authenticated", CAIO, `select 1 from ${TABELA} where id = '${ordemDeA}'`)).toEqual({ linhas: 0 });
  });

  it("quem tem conta e não é de organização nenhuma não lê nada", async () => {
    expect(await comoPapel("authenticated", DE_FORA, `select 1 from ${TABELA}`)).toEqual({ linhas: 0 });
  });

  it("a RLS está ligada e a leitura é a única policy", async () => {
    const { rows: rls } = await pool.query(`select relrowsecurity from pg_class where oid = '${TABELA}'::regclass`);
    expect(rls[0]?.relrowsecurity).toBe(true);
    const { rows } = await pool.query<{ policyname: string; cmd: string; roles: string }>(
      `select policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'public' and tablename = 'voice_call_queue_orders'`,
    );
    expect(rows).toEqual([{ policyname: POLICY, cmd: "SELECT", roles: "{authenticated}" }]);
  });
});

describe("a REST só lê — a escrita é da API e do worker", () => {
  let ligacao: string;
  let aberta: string;

  beforeAll(async () => {
    ligacao = await ligacaoNaFila(A);
    aberta = await ordem({ ligacao: await ligacaoNaFila(A), por: ANA, para_pessoa: ANA });
  });

  it.each(PAPEIS_DA_REST)("%s não insere, não altera, não apaga e não trunca", async (papel) => {
    // `authenticated` vai com o JWT da Ana, que É de A e ENXERGA a linha: a recusa
    // abaixo é do GRANT, e não de a linha estar escondida dela.
    const usuario = papel === "authenticated" ? ANA : null;
    for (const comando of [
      `insert into ${TABELA} (organization_id, voice_call_id, kind, requested_by, to_user_id)
         values ('${A}', '${ligacao}', 'pull', '${ANA}', '${ANA}')`,
      `update ${TABELA} set status = 'ended', outcome = 'done', ended_at = now() where id = '${aberta}'`,
      `update ${TABELA} set to_user_id = '${BIA}' where organization_id = '${A}'`,
      `delete from ${TABELA} where id = '${aberta}'`,
      `truncate ${TABELA}`,
    ]) {
      expect(await comoPapel(papel, usuario, comando), `${papel}: ${comando}`).toMatchObject({ codigo: SEM_PRIVILEGIO });
    }
    // E nada mudou: a ordem segue aberta, do jeito que a API a gravou.
    expect(await linha(aberta)).toMatchObject({ status: "open", outcome: null, ended_at: null });
  });

  it("anon não lê; authenticated e service_role leem", async () => {
    expect(await comoPapel("anon", null, `select 1 from ${TABELA}`)).toMatchObject({ codigo: SEM_PRIVILEGIO });
    expect(await comoPapel("authenticated", ANA, `select 1 from ${TABELA} where id = '${aberta}'`)).toEqual({ linhas: 1 });
    expect(await comoPapel("service_role", null, `select 1 from ${TABELA} where id = '${aberta}'`)).toEqual({ linhas: 1 });
  });

  it("no catálogo: só SELECT, só para authenticated e service_role — nem direto, nem herdado de PUBLIC", async () => {
    expect(await concedidos()).toEqual(["authenticated:SELECT", "service_role:SELECT"]);
    expect(await efetivos()).toEqual(["authenticated:SELECT", "service_role:SELECT"]);
  });
});

describe("sob o default ACL de tabelas do Supabase", () => {
  // No Supabase (e neste banco, desde a linha `ALTER DEFAULT PRIVILEGES … GRANT ALL
  // ON TABLES` do corpo do baseline), tabela nova de `public` nasce com TUDO
  // concedido aos três papéis da REST. Enumerar `grant select` não tira nada: quem
  // protege a tabela é o `revoke` do bloco. Os dois controles abaixo provam que o
  // defeito EXISTE sem ele — sem isso, os casos de cima poderiam estar verdes num
  // banco onde a tabela nunca foi concedida.
  it("controle: neste banco, tabela nova de `public` nasce com tudo para anon, authenticated e service_role", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("create table public.sonda_do_default_acl_0296 (id int)");
      const { rows } = await c.query<{ p: string }>(
        `select grantee || ':' || string_agg(privilege_type, ',' order by privilege_type) as p
           from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'sonda_do_default_acl_0296'
            and grantee in ('anon', 'authenticated', 'service_role')
          group by grantee order by grantee`,
      );
      // Os sete do pg15, o piso; um Postgres mais novo concede outros além deles.
      const concedido = Object.fromEntries(rows.map((r) => [r.p.split(":")[0], r.p.split(":")[1]!.split(",")]));
      expect(Object.keys(concedido)).toEqual(["anon", "authenticated", "service_role"]);
      for (const papel of PAPEIS_DA_REST) {
        expect(concedido[papel], papel).toEqual(
          expect.arrayContaining(["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]),
        );
      }
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("controle: com o que a tabela tinha ao nascer, service_role grava e apaga a ordem de qualquer organização", async () => {
    const ligacao = await ligacaoNaFila(A);
    const alvo = await ordem({ ligacao: await ligacaoNaFila(A) });
    await pool.query(`grant all on table ${TABELA} to anon, authenticated, service_role`);
    try {
      // service_role ignora RLS: sem o GRANT negado, nada mais o segura.
      expect(
        await comoPapel(
          "service_role",
          null,
          `insert into ${TABELA} (organization_id, voice_call_id, kind) values ('${A}', '${ligacao}', 'pull')`,
        ),
      ).toEqual({ linhas: 1 });
      expect(await comoPapel("service_role", null, `delete from ${TABELA} where id = '${alvo}'`)).toEqual({ linhas: 1 });
      // E `anon` passa a alcançar a tabela (a RLS devolve zero linhas, mas o GRANT está lá).
      expect(await comoPapel("anon", null, `select 1 from ${TABELA}`)).toEqual({ linhas: 0 });
    } finally {
      await pool.query(blocoDoBaseline());
    }
  });

  it("reaplicado o bloco, a tabela volta a só-leitura: o `revoke` é o que protege", async () => {
    const alvo = await ordem({ ligacao: await ligacaoNaFila(A) });
    await pool.query(`grant all on table ${TABELA} to anon, authenticated, service_role`);
    expect((await efetivos()).length).toBe(21); // 3 papéis × 7 privilégios: a simulação pegou
    await pool.query(blocoDoBaseline());

    expect(await concedidos()).toEqual(["authenticated:SELECT", "service_role:SELECT"]);
    expect(await efetivos()).toEqual(["authenticated:SELECT", "service_role:SELECT"]);
    expect(await comoPapel("service_role", null, `delete from ${TABELA} where id = '${alvo}'`)).toMatchObject({
      codigo: SEM_PRIVILEGIO,
    });
    expect(await comoPapel("anon", null, `select 1 from ${TABELA}`)).toMatchObject({ codigo: SEM_PRIVILEGIO });
    expect(await linha(alvo)).toMatchObject({ status: "open" });
  });
});

describe("o bloco do baseline se cura sozinho", () => {
  it("o instrumento está vivo: o recorte pegou o bloco inteiro, e só ele", () => {
    // Sem isto, um recorte que parasse cedo reaplicaria meio bloco, e os casos
    // abaixo passariam (ou falhariam) pelo motivo errado.
    const bloco = blocoDoBaseline();
    for (const nome of [...CHECKS, UMA_ABERTA, DA_LIGACAO, POLICY]) expect(bloco).toContain(nome);
    expect(bloco).toContain("create table if not exists public.voice_call_queue_orders");
    expect(bloco).toContain("enable row level security");
    expect(bloco).toMatch(/revoke all on public\.voice_call_queue_orders from/);
    expect(bloco.match(/^-- ---- /gm)).toHaveLength(1);
    // O bloco fica ANTES da varredura de anon, que tem de ser o último do apêndice.
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    expect(baseline.indexOf(ROTULO)).toBeLessThan(baseline.indexOf("-- ---- VARREDURA anon:"));
  });

  it("num banco são, reaplicar não reconstrói nada: os mesmos CHECKs (mesmo oid), o mesmo retrato", async () => {
    const [antes, oids] = [await retrato(), await oidsDosChecks()];
    const bloco = blocoDoBaseline();
    await pool.query(bloco);
    await pool.query(bloco);
    expect(await oidsDosChecks()).toEqual(oids);
    expect(await retrato()).toEqual(antes);
  });

  it("derrubados os CHECKs, os índices, a policy, a RLS e o `revoke`: tudo volta, e as ordens ficam", async () => {
    const antes = await retrato();
    const ordens = (await pool.query(`select count(*)::int as n from ${TABELA}`)).rows[0]!.n as number;
    expect(ordens).toBeGreaterThan(0);

    await pool.query(`
      alter table ${TABELA} drop constraint ${CHECK_DO_TIPO}, drop constraint ${CHECK_DA_SITUACAO},
        drop constraint ${CHECK_DO_DESFECHO}, drop constraint ${CHECK_DO_FIM};
      drop index public.${UMA_ABERTA}, public.${DA_LIGACAO};
      drop policy ${POLICY} on ${TABELA};
      alter table ${TABELA} disable row level security;
      grant all on table ${TABELA} to anon, authenticated, service_role;`);
    // Controle: o estrago foi feito — senão o retrato igual abaixo não prova cura nenhuma.
    expect(await checks()).toEqual({});
    expect(await retrato()).not.toEqual(antes);

    await pool.query(blocoDoBaseline());

    expect(await retrato()).toEqual(antes);
    expect(await checks()).toEqual(Object.fromEntries(CHECKS.map((c) => [c, true])));
    expect((await pool.query(`select count(*)::int as n from ${TABELA}`)).rows[0]!.n).toBe(ordens);
    // E as catracas recriadas recusam de novo.
    expect(await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), kind: "transfer" }))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DO_TIPO,
    });
    const ligacao = await ligacaoNaFila();
    await ordem({ ligacao });
    expect(await recusa(() => ordem({ ligacao }))).toEqual({ codigo: JA_EXISTE, constraint: UMA_ABERTA });
  });

  it("CHECK derrubado e linha fora da regra: reaplicar não quebra, o CHECK volta valendo para linha nova, e valida quando a linha é consertada", async () => {
    await pool.query(`alter table ${TABELA} drop constraint ${CHECK_DO_TIPO}`);
    const torta = await ordem({ ligacao: await ligacaoNaFila(), kind: "tipo_de_outra_versao" });

    const bloco = blocoDoBaseline();
    // O `update.sh` reaplica o baseline inteiro; um erro aqui seria o aviso "restaure o backup" na VPS do cliente.
    await pool.query(bloco);
    await pool.query(bloco);

    // Voltou — ainda sem validar, porque a linha velha o viola; os outros três seguem validados.
    expect(await checks()).toEqual({
      [CHECK_DO_FIM]: true, [CHECK_DO_TIPO]: false, [CHECK_DO_DESFECHO]: true, [CHECK_DA_SITUACAO]: true,
    });
    // A linha velha não foi apagada nem reescrita: não se inventa o tipo de um pedido.
    expect((await pool.query(`select kind from ${TABELA} where id = $1`, [torta])).rows[0]?.kind).toBe("tipo_de_outra_versao");
    // E ele já recusa linha nova.
    expect(await recusa(async () => ordem({ ligacao: await ligacaoNaFila(), kind: "tipo_de_outra_versao" }))).toEqual({
      codigo: VIOLA_CHECK, constraint: CHECK_DO_TIPO,
    });

    // Consertada a linha, a reaplicação seguinte valida.
    await pool.query(`delete from ${TABELA} where id = $1`, [torta]);
    await pool.query(bloco);
    expect(await checks()).toEqual(Object.fromEntries(CHECKS.map((c) => [c, true])));
  });
});

// Por último de propósito: este caso apaga a tabela (e as ordens) do banco do arquivo.
describe("o arquivo da cadeia chega ao mesmo lugar que o bloco do baseline", () => {
  // `pnpm test:db` aplica só o baseline — o arquivo de `supabase/migrations/` é
  // o que o Supabase CLI aplica, e sem este caso nenhum gate o executa.
  it("num banco na 0295, aplicar a migration cria a mesma tabela; reaplicar não quebra", async () => {
    const doBaseline = await retrato();
    await pool.query(`drop table ${TABELA}`);
    // Controle: o banco voltou mesmo à 0295 — senão o que se mede abaixo é o baseline, não a migration.
    expect((await pool.query("select to_regclass($1) as t", [TABELA])).rows[0]?.t).toBeNull();

    const migration = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    await pool.query(migration);
    await pool.query(migration); // idempotente

    expect(await retrato()).toEqual(doBaseline);
    // E as regras são as mesmas: uma aberta por ligação, vocabulário fechado, REST só-leitura.
    const ligacao = await ligacaoNaFila();
    const id = await ordem({ ligacao });
    expect(await recusa(() => ordem({ ligacao, por: BIA }))).toEqual({ codigo: JA_EXISTE, constraint: UMA_ABERTA });
    expect(await recusa(() => encerrar(id, "talvez"))).toEqual({ codigo: VIOLA_CHECK, constraint: CHECK_DO_DESFECHO });
    expect(await comoPapel("authenticated", ANA, `select 1 from ${TABELA} where id = '${id}'`)).toEqual({ linhas: 1 });
    expect(await comoPapel("authenticated", CAIO, `select 1 from ${TABELA} where id = '${id}'`)).toEqual({ linhas: 0 });
    expect(await comoPapel("authenticated", ANA, `delete from ${TABELA} where id = '${id}'`)).toMatchObject({
      codigo: SEM_PRIVILEGIO,
    });
    expect(await comoPapel("anon", null, `select 1 from ${TABELA}`)).toMatchObject({ codigo: SEM_PRIVILEGIO });
  });
});
