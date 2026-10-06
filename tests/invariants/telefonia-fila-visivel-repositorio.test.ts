/**
 * O REPOSITÓRIO GRAVA A FILA DO TELEFONE, CONTRA POSTGRES REAL (fila visível, entrega 2 — 0295).
 *
 * A fila do telefone vivia só na memória do worker. Agora ele grava em
 * `voice_calls` quando a ligação passou a esperar por uma pessoa (`queued_at`, a
 * ordem de chegada) e quando a espera sem ninguém livre esgota
 * (`queue_deadline_at`, o "cai em" da aba Telefone), e lê de `attendance_teams`
 * a espera máxima do time (`phone_queue_max_wait_seconds`).
 *
 * O controlador é provado com um banco de mentira (controle.test.ts); aqui se
 * prova o SQL, no schema de verdade, sempre com DUAS organizações (o worker usa
 * `pg.Pool` fora da RLS, e a única catraca é o `organization_id` de cada escrita):
 *
 *  1. `timeParaAFila` devolve o teto do time — `null` sem configuração, e o
 *     configurado depois; o time de outra organização não existe, e não tem teto;
 *  2. `marcarNaFila` guarda a PRIMEIRA vez; não escreve na ligação de outra
 *     organização nem na que já acabou;
 *  3. `marcarPrazoDaFila` grava o prazo no relógio do BANCO; `null` o apaga; e
 *     não escreve na ligação de outra organização;
 *  4. `marcarAtendida` apaga o prazo (quem foi atendido não cai por espera) e
 *     preserva a ordem de chegada.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repo from "@/lib/channels/telefonia/repositorio";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0296-0000-4000-8000-00000000000a";
const OUTRA = "c0de0296-0000-4000-8000-00000000000b";
const ANA = "c0de0296-1111-4000-8000-000000000001";
const SUPORTE = "c0de0296-2222-4000-8000-000000000001";
const TIME_OUTRA = "c0de0296-2222-4000-8000-000000000002";
const NUMERO = "c0de0296-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0296-5555-4000-8000-000000000002";
const AGORA = new Date();

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-fila@invariant.test', '{"full_name":"Ana da Fila"}')
     on conflict (id) do nothing`,
    [ANA],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'fila-0296-a', 'Fila 0296 A', 'Fila A'), ($2, 'fila-0296-b', 'Fila 0296 B', 'Fila B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $2, 'agent', now())
     on conflict do nothing`,
    [ANA, ORG],
  );
  await pool.query(
    // Agenda sem janelas = 24/7: os dois times estão ABERTOS a qualquer hora em que o teste rode.
    `insert into public.attendance_teams (id, organization_id, name, slug, schedule) values
       ($1, $3, 'Suporte', 'suporte-0296', '{}'::jsonb), ($2, $4, 'Suporte B', 'suporte-0296', '{}'::jsonb)
     on conflict (id) do nothing`,
    [SUPORTE, TIME_OUTRA, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Fila A', '+556130000396',
        'voip.exemplo-0396.com.br', 5060, 'udp', 'u0296a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Fila B', '+556130000397',
        'voip.exemplo-0397.com.br', 5060, 'udp', 'u0296b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

/** Uma recebida de `org`, ainda tocando, sem contato nem conversa (aqui só importa a linha da ligação). */
function recebida(org: string, numero: string, time: string): Promise<string> {
  return repo.criarLigacao(pool, {
    organizationId: org, troncoId: numero, sipCallRef: `canal-${Math.random().toString(36).slice(2)}`,
    direcao: "inbound", numeroDoOutroLado: "+5561988887777", contactId: null, conversationId: null,
    teamId: time, status: "ringing",
  });
}

/** A fila como o banco a tem: os dois instantes e a distância de cada um até o `now()` do banco, em segundos. */
async function fila(vc: string) {
  const { rows } = await pool.query<{
    queued_at: Date | null;
    queue_deadline_at: Date | null;
    desde_a_entrada_s: string | null;
    ate_o_prazo_s: string | null;
  }>(
    `select queued_at, queue_deadline_at,
            extract(epoch from (now() - queued_at)) as desde_a_entrada_s,
            extract(epoch from (queue_deadline_at - now())) as ate_o_prazo_s
       from public.voice_calls where id = $1`,
    [vc],
  );
  const r = rows[0]!;
  return {
    entrouEm: r.queued_at,
    prazo: r.queue_deadline_at,
    desdeAEntradaS: r.desde_a_entrada_s === null ? null : Number(r.desde_a_entrada_s),
    ateOPrazoS: r.ate_o_prazo_s === null ? null : Number(r.ate_o_prazo_s),
  };
}

describe("o teto de espera do time vem na leitura da entrada na fila", () => {
  it("sem configuração é null (o padrão); configurado, é o que está no banco", async () => {
    expect(await repo.timeParaAFila(pool, ORG, SUPORTE, AGORA)).toEqual({ situacao: "aberto", aviso: null, esperaMaximaS: null });

    await pool.query(`update public.attendance_teams set phone_queue_max_wait_seconds = 600 where id = $1`, [SUPORTE]);
    expect(await repo.timeParaAFila(pool, ORG, SUPORTE, AGORA)).toEqual({ situacao: "aberto", aviso: null, esperaMaximaS: 600 });
  });

  it("o time de outra organização não existe nesta — e o teto dele não vaza", async () => {
    await pool.query(`update public.attendance_teams set phone_queue_max_wait_seconds = 900 where id = $1`, [TIME_OUTRA]);
    // Visto de A, o time de B não existe: indisponível, sem teto.
    expect(await repo.timeParaAFila(pool, ORG, TIME_OUTRA, AGORA)).toEqual({ situacao: "indisponivel", aviso: null, esperaMaximaS: null });
    // Visto de B, é o dele.
    expect(await repo.timeParaAFila(pool, OUTRA, TIME_OUTRA, AGORA)).toEqual({ situacao: "aberto", aviso: null, esperaMaximaS: 900 });
  });
});

describe("a ordem de chegada (queued_at)", () => {
  it("grava o instante do banco — e a segunda chamada NÃO o move", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    expect((await fila(vc)).entrouEm).toBeNull();

    await repo.marcarNaFila(pool, ORG, vc);
    const primeira = await fila(vc);
    expect(primeira.entrouEm).not.toBeNull();
    expect(primeira.desdeAEntradaS!).toBeGreaterThanOrEqual(0);
    expect(primeira.desdeAEntradaS!).toBeLessThan(5);

    await new Promise((r) => setTimeout(r, 50));
    await repo.marcarNaFila(pool, ORG, vc);
    expect((await fila(vc)).entrouEm!.getTime()).toBe(primeira.entrouEm!.getTime());
  });

  it("com a organização errada não grava nada", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.marcarNaFila(pool, OUTRA, vc);
    expect((await fila(vc)).entrouEm).toBeNull();
  });

  it("na ligação que já acabou não grava", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.marcarNaFila(pool, ORG, vc);
    expect((await fila(vc)).entrouEm).toBeNull();
  });
});

describe("o prazo da fila (queue_deadline_at)", () => {
  it("é o now() do BANCO mais o que falta no relógio do worker", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.marcarPrazoDaFila(pool, ORG, vc, 90_000);
    const f = await fila(vc);
    expect(f.prazo).not.toBeNull();
    // Medido no banco, contra o relógio dele: 90 s menos o tempo entre as duas consultas.
    expect(f.ateOPrazoS!).toBeGreaterThan(88);
    expect(f.ateOPrazoS!).toBeLessThanOrEqual(90);
    // O prazo não inventa a ordem de chegada.
    expect(f.entrouEm).toBeNull();
  });

  it("com null, apaga", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.marcarPrazoDaFila(pool, ORG, vc, 90_000);
    await repo.marcarPrazoDaFila(pool, ORG, vc, null);
    expect((await fila(vc)).prazo).toBeNull();
  });

  it("com a organização errada não grava — nem apaga", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.marcarPrazoDaFila(pool, OUTRA, vc, 90_000);
    expect((await fila(vc)).prazo).toBeNull();

    await repo.marcarPrazoDaFila(pool, ORG, vc, 90_000);
    await repo.marcarPrazoDaFila(pool, OUTRA, vc, null);
    expect((await fila(vc)).prazo).not.toBeNull();
  });

  it("na ligação que já acabou não grava", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.marcarPrazoDaFila(pool, ORG, vc, 90_000);
    expect((await fila(vc)).prazo).toBeNull();
  });
});

describe("atender tira a ligação da espera", () => {
  it("apaga o prazo e preserva a ordem de chegada", async () => {
    const vc = await recebida(ORG, NUMERO, SUPORTE);
    await repo.marcarNaFila(pool, ORG, vc);
    await repo.marcarPrazoDaFila(pool, ORG, vc, 90_000);
    const antes = await fila(vc);
    expect(antes.prazo).not.toBeNull();

    await repo.marcarAtendida(pool, ORG, vc, ANA);
    const depois = await fila(vc);
    expect(depois.prazo).toBeNull();
    expect(depois.entrouEm!.getTime()).toBe(antes.entrouEm!.getTime());
  });
});
