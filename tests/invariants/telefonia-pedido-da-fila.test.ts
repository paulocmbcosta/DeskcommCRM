/**
 * OS PEDIDOS DA FILA DO TELEFONE, CONTRA POSTGRES REAL (lado da API; migration 0296).
 *
 * `pedirAtender` e `pedirMover` são o que as rotas `POST /telefonia/chamadas/[id]/atender`
 * e `…/mover` chamam antes de emitir a ordem ao worker. A conexão é a do app, FORA
 * da RLS: a única catraca entre uma organização e a outra é o `organization_id`
 * de cada consulta — por isso aqui há sempre DUAS organizações, cada uma com
 * número, time, gente e ligação na fila.
 *
 *  1. só se age sobre a ligação RECEBIDA do TELEFONE desta organização, viva,
 *     não atendida e que já espera por uma pessoa (`queued_at`). A de outra
 *     organização, a feita, a interna e a do WaCalls respondem igual à que não
 *     existe — e NADA é gravado;
 *  2. atender: o ramal de quem pede está registrado e a pessoa não está em outra
 *     ligação; a ordem gravada puxa para QUEM PEDIU;
 *  3. a corrida de dois cliques: o índice único parcial decide — uma ordem entra,
 *     a outra é `ja_ha_ordem`, com o nome de quem pediu a primeira (pela régua de
 *     nome da fila: nunca o e-mail);
 *  4. mover: o time é desta organização, ativo, diferente do atual e dentro do
 *     horário;
 *  5. `recusarOrdemSemWorker` só fecha a ordem ABERTA desta organização;
 *  6. `lerOrdemParaATela` é presa à organização.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  lerOrdemParaATela,
  pedirAtender,
  pedirMover,
  recusarOrdemSemWorker,
} from "@/lib/channels/telefonia/pedido-da-fila";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de02f2-0000-4000-8000-00000000000a";
const OUTRA = "c0de02f2-0000-4000-8000-00000000000b";
const ANA = "c0de02f2-1111-4000-8000-000000000001"; // atendente, online e livre
/** Sem nome cadastrado: só o e-mail — na recusa ela aparece pelo que vem antes do `@`. */
const BIA = "c0de02f2-1111-4000-8000-000000000002"; // atendente, online e livre
const CAIO = "c0de02f2-1111-4000-8000-000000000003"; // sem o telefone conectado
const DAVI = "c0de02f2-1111-4000-8000-000000000004"; // online, falando em outra ligação
const EVA = "c0de02f2-1111-4000-8000-000000000005"; // gerente
const FABIO = "c0de02f2-1111-4000-8000-000000000006"; // online, com outra ligação TOCANDO para ele
const ZE = "c0de02f2-1111-4000-8000-000000000007"; // da outra organização, online e livre
const SUPORTE = "c0de02f2-2222-4000-8000-000000000001";
const VENDAS = "c0de02f2-2222-4000-8000-000000000002";
const FECHADO = "c0de02f2-2222-4000-8000-000000000003";
const ARQUIVADO = "c0de02f2-2222-4000-8000-000000000004";
const TIME_OUTRA = "c0de02f2-2222-4000-8000-000000000005";
const NUMERO = "c0de02f2-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de02f2-5555-4000-8000-000000000002";
const NAO_EXISTE = "c0de02f2-9999-4000-8000-000000000009";
const NOME_DA_ANA = "Ana da Fila";
const EMAIL_DA_BIA = "bia-pedido-fila@invariant.test";
const BIA_NA_FILA = "bia-pedido-fila";
/** Segunda-feira, 10h em Brasília: o time FECHADO (só domingo cedo) está fora do horário. */
const AGORA = new Date("2026-09-28T13:00:00Z");
/** Domingo, 8h30 em Brasília: dentro da janela do time FECHADO. */
const DOMINGO_CEDO = new Date("2026-09-27T11:30:00Z");
const SO_DOMINGO_CEDO = `{"timezone":"America/Sao_Paulo","windows":[{"dow":0,"start":"08:00","end":"09:00"}]}`;
/** Os ramais registrados: todo mundo, menos o Caio. */
const ONLINE = new Set([ANA, BIA, DAVI, EVA, FABIO, ZE]);

interface Semente {
  org?: string;
  numero?: string | null;
  provider?: "sip_trunk" | "wacalls";
  direcao?: "inbound" | "outbound" | "internal";
  status?: "ringing" | "connected" | "ended";
  time?: string | null;
  /** Já espera por uma pessoa (`queued_at`)? O padrão é sim. */
  naFila?: boolean;
  atendida?: boolean;
  acabou?: boolean;
  tocando?: string;
  dono?: string;
  colega?: string;
}

let ligacoes = 0;

/** Uma linha de `voice_calls`, por SQL direto. Sem nada: recebida pelo telefone de A, viva, na fila do Suporte. */
async function ligacao(s: Semente = {}): Promise<string> {
  ligacoes += 1;
  const provider = s.provider ?? "sip_trunk";
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, wacalls_call_id, direction, peer_phone, status,
        team_id, queued_at, answered_at, ended_at, ringing_user_id, owner_user_id, peer_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             case when $10 then now() - interval '30 seconds' end,
             case when $11 then now() - interval '10 seconds' end,
             case when $12 then now() end,
             $13, $14, $15)
     returning id`,
    [
      s.org ?? ORG,
      s.numero === undefined ? NUMERO : s.numero,
      provider,
      provider === "sip_trunk" ? `pedido-fila-${ligacoes}` : null,
      provider === "wacalls" ? `wa-pedido-fila-${ligacoes}` : null,
      s.direcao ?? "inbound",
      `+55619777${String(ligacoes).padStart(5, "0")}`,
      s.status ?? "ringing",
      s.time === undefined ? SUPORTE : s.time,
      s.naFila ?? true,
      s.atendida ?? false,
      s.acabou ?? false,
      s.tocando ?? null,
      s.dono ?? null,
      s.colega ?? null,
    ],
  );
  return rows[0]!.id;
}

interface OrdemGravada {
  organization_id: string;
  kind: string;
  requested_by: string | null;
  to_user_id: string | null;
  to_team_id: string | null;
  from_team_id: string | null;
  status: string;
  outcome: string | null;
  reason: string | null;
  fechada: boolean;
}

/** Todas as ordens de uma ligação, de QUALQUER organização — é assim que se vê que nada foi gravado. */
async function ordensDa(vcId: string): Promise<OrdemGravada[]> {
  const { rows } = await pool.query<OrdemGravada>(
    `select organization_id, kind, requested_by, to_user_id, to_team_id, from_team_id, status, outcome, reason,
            ended_at is not null as fechada
       from public.voice_call_queue_orders where voice_call_id = $1 order by created_at, id`,
    [vcId],
  );
  return rows;
}

const totalDeOrdens = async () =>
  Number((await pool.query<{ n: string }>(`select count(*) as n from public.voice_call_queue_orders`)).rows[0]!.n);

const atender = (p: Partial<Parameters<typeof pedirAtender>[1]> & { vcId: string }) =>
  pedirAtender(pool, { org: ORG, userId: ANA, online: ONLINE, ...p });
const mover = (p: Partial<Parameters<typeof pedirMover>[1]> & { vcId: string }) =>
  pedirMover(pool, { org: ORG, userId: EVA, teamId: VENDAS, agora: AGORA, ...p });

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-pedido-fila@invariant.test', $8::jsonb),
       ($2, $9, '{}'),
       ($3, 'caio-pedido-fila@invariant.test', '{"full_name":"Caio da Fila"}'),
       ($4, 'davi-pedido-fila@invariant.test', '{"full_name":"Davi da Fila"}'),
       ($5, 'eva-pedido-fila@invariant.test', '{"full_name":"Eva da Fila"}'),
       ($6, 'fabio-pedido-fila@invariant.test', '{"full_name":"Fabio da Fila"}'),
       ($7, 'ze-pedido-fila@invariant.test', '{"full_name":"Zé de B"}')
     on conflict (id) do nothing`,
    [ANA, BIA, CAIO, DAVI, EVA, FABIO, ZE, JSON.stringify({ full_name: NOME_DA_ANA }), EMAIL_DA_BIA],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'pedido-fila-a', 'Pedido da Fila A', 'Fila A'), ($2, 'pedido-fila-b', 'Pedido da Fila B', 'Fila B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $8, 'agent', now()), ($2, $8, 'agent', now()), ($3, $8, 'agent', now()), ($4, $8, 'agent', now()),
       ($5, $8, 'manager', now()), ($6, $8, 'agent', now()), ($7, $9, 'agent', now())
     on conflict do nothing`,
    [ANA, BIA, CAIO, DAVI, EVA, FABIO, ZE, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug, schedule, archived_at) values
       ($1, $6, 'Suporte', 'suporte-pedido-fila', '{}'::jsonb, null),
       ($2, $6, 'Vendas', 'vendas-pedido-fila', '{}'::jsonb, null),
       ($3, $6, 'Financeiro', 'financeiro-pedido-fila', $8::jsonb, null),
       ($4, $6, 'Antigo', 'antigo-pedido-fila', '{}'::jsonb, now()),
       ($5, $7, 'Vendas B', 'vendas-pedido-fila', '{}'::jsonb, null)
     on conflict (id) do nothing`,
    [SUPORTE, VENDAS, FECHADO, ARQUIVADO, TIME_OUTRA, ORG, OUTRA, SO_DOMINGO_CEDO],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'WORKING', 'Fila A', '+556130009721', 'voip.exemplo-02f2a.com.br', 5060, 'udp', 'u02f2a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'WORKING', 'Fila B', '+556130009722', 'voip.exemplo-02f2b.com.br', 5060, 'udp', 'u02f2b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
  // Quem está ocupado, a suíte inteira: o Davi fala com um cliente, e outra ligação toca para o Fabio.
  await ligacao({ status: "connected", atendida: true, dono: DAVI });
  await ligacao({ tocando: FABIO });
});

afterAll(async () => {
  await pool.end();
});

describe("pedirAtender", () => {
  it("quem está livre e online puxa a ligação que espera: a ordem aberta é PARA quem pediu, com o time de onde sai", async () => {
    const vc = await ligacao();
    const r = await atender({ vcId: vc });
    expect(r).toEqual({ ok: true, id: expect.any(String), timeId: SUPORTE });
    expect(await ordensDa(vc)).toEqual([
      {
        organization_id: ORG,
        kind: "pull",
        requested_by: ANA,
        to_user_id: ANA,
        to_team_id: null,
        from_team_id: SUPORTE,
        status: "open",
        outcome: null,
        reason: null,
        fechada: false,
      },
    ]);
  });

  it("a ligação que TOCA para outra pessoa também pode ser puxada; a sem time sai com o time nulo", async () => {
    const tocando = await ligacao({ tocando: DAVI });
    expect(await atender({ vcId: tocando })).toMatchObject({ ok: true, timeId: SUPORTE });
    const semTime = await ligacao({ time: null });
    expect(await atender({ vcId: semTime, userId: BIA })).toMatchObject({ ok: true, timeId: null });
    expect((await ordensDa(semTime))[0]).toMatchObject({ requested_by: BIA, to_user_id: BIA, from_team_id: null });
  });

  it("ligação de B pedida por A: `ligacao_inexistente`, e NADA é gravado — nem em A, nem em B", async () => {
    const deB = await ligacao({ org: OUTRA, numero: NUMERO_OUTRA, time: TIME_OUTRA });
    const antes = await totalDeOrdens();
    expect(await atender({ vcId: deB })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    // Nem a gerente de A, nem com a própria pessoa de B dizendo que é de A.
    expect(await atender({ vcId: deB, userId: EVA })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await atender({ vcId: deB, userId: ZE })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await ordensDa(deB)).toEqual([]);
    expect(await totalDeOrdens()).toBe(antes);

    // E o contrário: a de A, pedida com a organização B.
    const deA = await ligacao();
    expect(await atender({ vcId: deA, org: OUTRA, userId: ZE })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await ordensDa(deA)).toEqual([]);

    // O controle: a ligação de B ESTÁ na fila — quem é de B, com a organização B, a puxa.
    expect(await atender({ vcId: deB, org: OUTRA, userId: ZE })).toMatchObject({ ok: true, timeId: TIME_OUTRA });
    expect((await ordensDa(deB)).map((o) => o.organization_id)).toEqual([OUTRA]);
  });

  it.each<[string, Semente, string]>([
    ["encerrada", { status: "ended", acabou: true }, "ligacao_encerrada"],
    ["já atendida", { status: "connected", atendida: true, dono: DAVI }, "ligacao_ja_atendida"],
    ["fora da fila (no menu ou nos avisos)", { naFila: false }, "ligacao_fora_da_fila"],
    ["feita (mesmo viva e com `queued_at`)", { direcao: "outbound" }, "ligacao_inexistente"],
    ["interna", { direcao: "internal", numero: null, time: null, naFila: false, status: "ended", acabou: true, dono: EVA, colega: CAIO }, "ligacao_inexistente"],
    ["de outro provider (WaCalls)", { provider: "wacalls", naFila: false }, "ligacao_inexistente"],
  ])("ligação %s → recusada, e nada é gravado", async (_nome, semente, motivo) => {
    const vc = await ligacao(semente);
    expect(await atender({ vcId: vc })).toEqual({ ok: false, motivo });
    expect(await ordensDa(vc)).toEqual([]);
  });

  it("ligação que não existe: `ligacao_inexistente`", async () => {
    expect(await atender({ vcId: NAO_EXISTE })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
  });

  it("quem pede sem o telefone conectado: `voce_offline`", async () => {
    const vc = await ligacao();
    expect(await atender({ vcId: vc, userId: CAIO })).toEqual({ ok: false, motivo: "voce_offline" });
    // O ramal é o de QUEM PEDE: outra pessoa online não serve.
    expect(await atender({ vcId: vc, userId: ANA, online: new Set([BIA, EVA]) })).toEqual({ ok: false, motivo: "voce_offline" });
    expect(await ordensDa(vc)).toEqual([]);
  });

  it("quem pede em outra ligação — falando, ou com outra tocando para ele: `voce_em_ligacao`", async () => {
    const vc = await ligacao();
    expect(await atender({ vcId: vc, userId: DAVI })).toEqual({ ok: false, motivo: "voce_em_ligacao" });
    expect(await atender({ vcId: vc, userId: FABIO })).toEqual({ ok: false, motivo: "voce_em_ligacao" });
    expect(await ordensDa(vc)).toEqual([]);
  });

  it("uma por vez: com a ordem de alguém aberta, a segunda é `ja_ha_ordem`, com o NOME de quem pediu a primeira", async () => {
    const vc = await ligacao();
    expect(await atender({ vcId: vc, userId: ANA })).toMatchObject({ ok: true });
    expect(await atender({ vcId: vc, userId: BIA })).toEqual({ ok: false, motivo: "ja_ha_ordem", por: NOME_DA_ANA });
    // Mover com alguém já puxando: a mesma recusa, com o mesmo nome.
    expect(await mover({ vcId: vc })).toEqual({ ok: false, motivo: "ja_ha_ordem", por: NOME_DA_ANA });
    expect((await ordensDa(vc)).map((o) => [o.kind, o.requested_by, o.status])).toEqual([["pull", ANA, "open"]]);
  });

  it("o nome de quem pediu sai pela régua da fila: sem nome cadastrado, o começo do e-mail — NUNCA o endereço", async () => {
    const vc = await ligacao();
    expect(await atender({ vcId: vc, userId: BIA })).toMatchObject({ ok: true });
    const r = await atender({ vcId: vc, userId: ANA });
    expect(r).toEqual({ ok: false, motivo: "ja_ha_ordem", por: BIA_NA_FILA });
    expect(JSON.stringify(r)).not.toContain(EMAIL_DA_BIA);
  });

  it("a corrida de dois cliques ao mesmo tempo: uma entra, a outra é `ja_ha_ordem` — e fica UMA ordem aberta", async () => {
    for (let i = 0; i < 5; i += 1) {
      const vc = await ligacao();
      const [a, b] = await Promise.all([atender({ vcId: vc, userId: ANA }), atender({ vcId: vc, userId: BIA })]);
      const [ganhou, perdeu] = a.ok ? [a, b] : [b, a];
      expect(ganhou.ok).toBe(true);
      expect(perdeu).toEqual({ ok: false, motivo: "ja_ha_ordem", por: a.ok ? NOME_DA_ANA : BIA_NA_FILA });
      const gravadas = await ordensDa(vc);
      expect(gravadas).toHaveLength(1);
      expect(gravadas[0]).toMatchObject({ status: "open", requested_by: a.ok ? ANA : BIA });
    }
  });

  it("a ordem aberta numa ligação não trava as outras; e, fechada, deixa a próxima entrar", async () => {
    const uma = await ligacao();
    const outra = await ligacao();
    const r = await atender({ vcId: uma });
    expect(r.ok).toBe(true);
    expect(await atender({ vcId: outra, userId: BIA })).toMatchObject({ ok: true });
    if (r.ok) await recusarOrdemSemWorker(pool, ORG, r.id);
    expect(await atender({ vcId: uma, userId: BIA })).toMatchObject({ ok: true });
    expect((await ordensDa(uma)).map((o) => o.status)).toEqual(["ended", "open"]);
  });
});

describe("pedirMover", () => {
  it("gerente move a ligação que espera para outro time: a ordem aberta leva de onde e para onde", async () => {
    const vc = await ligacao();
    const r = await mover({ vcId: vc });
    expect(r).toEqual({ ok: true, id: expect.any(String), deTimeId: SUPORTE });
    expect(await ordensDa(vc)).toEqual([
      {
        organization_id: ORG,
        kind: "move",
        requested_by: EVA,
        to_user_id: null,
        to_team_id: VENDAS,
        from_team_id: SUPORTE,
        status: "open",
        outcome: null,
        reason: null,
        fechada: false,
      },
    ]);
    // Com a ordem de MOVER aberta ninguém "está atendendo": a recusa vem sem nome.
    expect(await atender({ vcId: vc })).toEqual({ ok: false, motivo: "ja_ha_ordem", por: null });
    expect(await mover({ vcId: vc, teamId: FECHADO, agora: DOMINGO_CEDO })).toEqual({ ok: false, motivo: "ja_ha_ordem", por: null });
  });

  it("a ligação sem time vai para um time: sai de `null`", async () => {
    const vc = await ligacao({ time: null });
    expect(await mover({ vcId: vc })).toMatchObject({ ok: true, deTimeId: null });
    expect((await ordensDa(vc))[0]).toMatchObject({ from_team_id: null, to_team_id: VENDAS });
  });

  it.each<[string, string, string]>([
    ["de outra organização", TIME_OUTRA, "destino_invalido"],
    ["arquivado", ARQUIVADO, "destino_invalido"],
    ["que não existe", NAO_EXISTE, "destino_invalido"],
    ["o mesmo em que a ligação já está", SUPORTE, "ja_esta_nesse_time"],
    ["fora do horário", FECHADO, "time_fora_do_horario"],
  ])("time %s → recusada, e nada é gravado", async (_nome, teamId, motivo) => {
    const vc = await ligacao();
    expect(await mover({ vcId: vc, teamId })).toEqual({ ok: false, motivo });
    expect(await ordensDa(vc)).toEqual([]);
  });

  it("o horário é o do relógio de quem chama: no domingo cedo o mesmo time recebe", async () => {
    const vc = await ligacao();
    expect(await mover({ vcId: vc, teamId: FECHADO, agora: DOMINGO_CEDO })).toMatchObject({ ok: true, deTimeId: SUPORTE });
    expect((await ordensDa(vc))[0]).toMatchObject({ kind: "move", to_team_id: FECHADO });
  });

  it("ligação de B movida por A: `ligacao_inexistente`, nada gravado — mesmo apontando para o time de B", async () => {
    const deB = await ligacao({ org: OUTRA, numero: NUMERO_OUTRA, time: null });
    const antes = await totalDeOrdens();
    expect(await mover({ vcId: deB })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await mover({ vcId: deB, teamId: TIME_OUTRA })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await ordensDa(deB)).toEqual([]);
    expect(await totalDeOrdens()).toBe(antes);

    // A de A, pedida com a organização B: nem com o time de B.
    const deA = await ligacao();
    expect(await mover({ vcId: deA, org: OUTRA, userId: ZE, teamId: TIME_OUTRA })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
    expect(await ordensDa(deA)).toEqual([]);

    // O controle: quem é de B, com a organização B, move a de B para o time de B — e o time de A não serve para ela.
    expect(await mover({ vcId: deB, org: OUTRA, userId: ZE, teamId: VENDAS })).toEqual({ ok: false, motivo: "destino_invalido" });
    expect(await mover({ vcId: deB, org: OUTRA, userId: ZE, teamId: TIME_OUTRA })).toMatchObject({ ok: true, deTimeId: null });
    expect((await ordensDa(deB)).map((o) => [o.organization_id, o.to_team_id])).toEqual([[OUTRA, TIME_OUTRA]]);
  });

  it.each<[string, Semente, string]>([
    ["encerrada", { status: "ended", acabou: true }, "ligacao_encerrada"],
    ["já atendida", { status: "connected", atendida: true, dono: DAVI }, "ligacao_ja_atendida"],
    ["fora da fila (no menu ou nos avisos)", { naFila: false }, "ligacao_fora_da_fila"],
    ["feita (mesmo viva e com `queued_at`)", { direcao: "outbound" }, "ligacao_inexistente"],
    ["de outro provider (WaCalls)", { provider: "wacalls", naFila: false }, "ligacao_inexistente"],
  ])("ligação %s → recusada, e nada é gravado", async (_nome, semente, motivo) => {
    const vc = await ligacao(semente);
    expect(await mover({ vcId: vc })).toEqual({ ok: false, motivo });
    expect(await ordensDa(vc)).toEqual([]);
  });

  it("dois gerentes movendo ao mesmo tempo: uma ordem entra, a outra é `ja_ha_ordem`", async () => {
    const vc = await ligacao();
    const [a, b] = await Promise.all([mover({ vcId: vc, teamId: VENDAS }), mover({ vcId: vc, teamId: FECHADO, agora: DOMINGO_CEDO })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(a.ok ? b : a).toEqual({ ok: false, motivo: "ja_ha_ordem", por: null });
    expect(await ordensDa(vc)).toHaveLength(1);
  });
});

describe("recusarOrdemSemWorker", () => {
  it("fecha a ordem ABERTA desta organização como recusada — e só ela", async () => {
    const vc = await ligacao();
    const r = await atender({ vcId: vc });
    if (!r.ok) throw new Error("a ordem devia ter entrado");

    // Com a organização errada, nada muda.
    await recusarOrdemSemWorker(pool, OUTRA, r.id);
    expect((await ordensDa(vc))[0]).toMatchObject({ status: "open", outcome: null, reason: null, fechada: false });

    await recusarOrdemSemWorker(pool, ORG, r.id);
    expect((await ordensDa(vc))[0]).toMatchObject({
      status: "ended",
      outcome: "refused",
      reason: "telefonia_indisponivel",
      fechada: true,
    });
  });

  it("não reescreve a ordem que o worker já fechou", async () => {
    const vc = await ligacao();
    const r = await atender({ vcId: vc });
    if (!r.ok) throw new Error("a ordem devia ter entrado");
    await pool.query(
      `update public.voice_call_queue_orders set status = 'ended', outcome = 'done', ended_at = now() where id = $1`,
      [r.id],
    );
    await recusarOrdemSemWorker(pool, ORG, r.id);
    expect((await ordensDa(vc))[0]).toMatchObject({ status: "ended", outcome: "done", reason: null });
  });
});

describe("lerOrdemParaATela", () => {
  it("devolve a ordem desta organização — e, para a outra, é como se não existisse", async () => {
    const vc = await ligacao();
    const r = await mover({ vcId: vc });
    if (!r.ok) throw new Error("a ordem devia ter entrado");

    expect(await lerOrdemParaATela(pool, ORG, r.id)).toEqual({
      id: r.id,
      kind: "move",
      status: "open",
      outcome: null,
      reason: null,
      requested_by: EVA,
      to_team_id: VENDAS,
    });
    expect(await lerOrdemParaATela(pool, OUTRA, r.id)).toBeNull();
    expect(await lerOrdemParaATela(pool, ORG, NAO_EXISTE)).toBeNull();

    await recusarOrdemSemWorker(pool, ORG, r.id);
    expect(await lerOrdemParaATela(pool, ORG, r.id)).toMatchObject({
      status: "ended",
      outcome: "refused",
      reason: "telefonia_indisponivel",
    });
  });

  it("a ordem de B não é lida com a organização A", async () => {
    const deB = await ligacao({ org: OUTRA, numero: NUMERO_OUTRA, time: TIME_OUTRA });
    const r = await atender({ vcId: deB, org: OUTRA, userId: ZE });
    if (!r.ok) throw new Error("a ordem de B devia ter entrado");
    expect(await lerOrdemParaATela(pool, ORG, r.id)).toBeNull();
    expect(await lerOrdemParaATela(pool, OUTRA, r.id)).toMatchObject({ id: r.id, kind: "pull", requested_by: ZE });
  });
});
