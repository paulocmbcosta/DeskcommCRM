/**
 * O PEDIDO DE TRANSFERÊNCIA E O DIRETÓRIO (lado da API; migrations 0290/0291) —
 * medidos no Postgres real, com a outra organização ao lado:
 *
 *  - o diretório dá a cada pessoa a situação de D17 (disponível, em ligação, em
 *    pausa, fora do horário, offline), o ramal, os times; e cada time com os
 *    livres e aberto/fora do horário. Ninguém de outra organização aparece;
 *  - `pedirTransferencia`: só a ligação do telefone desta organização, atendida
 *    e não interna; só o dono ou gerente+; consultada só para pessoa; pessoa
 *    disponível; time no horário; uma por vez (o índice decide a corrida);
 *  - `consultaAberta`: só a consultada aberta, só quem transferiu ou gerente+.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lerDiretorio } from "@/lib/channels/telefonia/diretorio";
import { consultaAberta, pedirTransferencia, recusarPedidoSemWorker } from "@/lib/channels/telefonia/pedido-de-transferencia";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0293-0000-4000-8000-00000000000a";
const OUTRA = "c0de0293-0000-4000-8000-00000000000b";
const ANA = "c0de0293-1111-4000-8000-000000000001"; // dona da ligação
const BIA = "c0de0293-1111-4000-8000-000000000002"; // disponível
const CAIO = "c0de0293-1111-4000-8000-000000000003"; // em pausa
const DAVI = "c0de0293-1111-4000-8000-000000000004"; // fora do horário dele
const EVA = "c0de0293-1111-4000-8000-000000000005"; // gerente, disponível
const FABIO = "c0de0293-1111-4000-8000-000000000006"; // offline
const GUTO = "c0de0293-1111-4000-8000-000000000007"; // viewer
const ZE = "c0de0293-1111-4000-8000-000000000008"; // da outra organização
const TIME = "c0de0293-2222-4000-8000-000000000001";
const FECHADO = "c0de0293-2222-4000-8000-000000000002";
const TIME_OUTRA = "c0de0293-2222-4000-8000-000000000003";
const NUMERO = "c0de0293-5555-4000-8000-000000000001";
const LIGACAO = "c0de0293-8888-4000-8000-000000000001";
const TOCANDO = "c0de0293-8888-4000-8000-000000000002";
const INTERNA = "c0de0293-8888-4000-8000-000000000003";
/** Segunda-feira, 10h em Brasília. */
const AGORA = new Date("2026-09-28T13:00:00Z");
const DOMINGO_CEDO = `'{"timezone":"America/Sao_Paulo","windows":[{"dow":0,"start":"08:00","end":"09:00"}]}'::jsonb`;
const ONLINE = new Set([ANA, BIA, CAIO, DAVI, EVA, GUTO, ZE]);

const pedido = (p: Partial<Parameters<typeof pedirTransferencia>[1]> = {}) =>
  pedirTransferencia(pool, {
    org: ORG,
    userId: ANA,
    papel: "agent",
    vcId: LIGACAO,
    modo: "direta",
    para: { user_id: BIA },
    agora: AGORA,
    online: ONLINE,
    ...p,
  });

beforeAll(async () => {
  const pessoas = [ANA, BIA, CAIO, DAVI, EVA, FABIO, GUTO, ZE];
  await pool.query(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ${pessoas.map((u, i) => `('${u}', 'p${i}-0293@invariant.test', '{"full_name":"Pessoa ${i}"}')`).join(", ")}
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'pedido-0293-a', 'Pedido A', 'Pedido A'), ('${OUTRA}', 'pedido-0293-b', 'Pedido B', 'Pedido B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}', '${ORG}', 'agent', now()), ('${BIA}', '${ORG}', 'agent', now()), ('${CAIO}', '${ORG}', 'agent', now()),
      ('${DAVI}', '${ORG}', 'agent', now()), ('${EVA}', '${ORG}', 'manager', now()), ('${FABIO}', '${ORG}', 'agent', now()),
      ('${GUTO}', '${ORG}', 'viewer', now()), ('${ZE}', '${OUTRA}', 'agent', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug, schedule) values
      ('${TIME}', '${ORG}', 'Suporte', 'suporte-0293', '{}'::jsonb),
      ('${FECHADO}', '${ORG}', 'Financeiro', 'financeiro-0293', ${DOMINGO_CEDO}),
      ('${TIME_OUTRA}', '${OUTRA}', 'Suporte B', 'suporte-0293', '{}'::jsonb)
      on conflict (id) do nothing;
    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG}', '${TIME}', '${BIA}'), ('${ORG}', '${TIME}', '${CAIO}'), ('${ORG}', '${FECHADO}', '${BIA}')
      on conflict do nothing;
    insert into public.attendant_availability (organization_id, user_id, is_available, schedule) values
      ('${ORG}', '${ANA}', true, '{}'), ('${ORG}', '${BIA}', true, '{}'), ('${ORG}', '${CAIO}', false, '{}'),
      ('${ORG}', '${DAVI}', true, ${DOMINGO_CEDO}), ('${ORG}', '${EVA}', true, '{}'), ('${ORG}', '${FABIO}', true, '{}'),
      ('${OUTRA}', '${ZE}', true, '{}')
      on conflict (organization_id, user_id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO}', '${ORG}', 'sip_trunk', '\\x00', 'WORKING', 'Pedido A', '+556130000295',
            'voip.exemplo-0293.com.br', 5060, 'udp', 'u0293', '\\x00')
      on conflict (id) do nothing;
    insert into public.voice_calls
      (id, organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, owner_user_id, answered_at, peer_user_id)
    values ('${LIGACAO}', '${ORG}', '${NUMERO}', 'sip_trunk', 'ref-0293-a', 'inbound', '+5561999990295', 'connected', '${ANA}', now(), null),
           ('${TOCANDO}', '${ORG}', '${NUMERO}', 'sip_trunk', 'ref-0293-b', 'inbound', '+5561999990296', 'ringing', null, null, null),
           ('${INTERNA}', '${ORG}', null, 'sip_trunk', 'ref-0293-c', 'internal', '202', 'ended', '${EVA}', now(), '${BIA}')
      on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("o diretório", () => {
  it("dá a situação de D17 a cada pessoa de atendimento, com o ramal — e só desta organização", async () => {
    const d = await lerDiretorio(pool, ORG, ANA, AGORA, ONLINE);
    const situacao = Object.fromEntries(d.pessoas.map((p) => [p.user_id, p.situacao]));
    expect(situacao).toEqual({
      [ANA]: "em_ligacao",
      [BIA]: "disponivel",
      [CAIO]: "em_pausa",
      [DAVI]: "fora_do_horario",
      [EVA]: "disponivel",
      [FABIO]: "offline",
    });
    expect(d.meu_ramal).toMatch(/^2\d\d$/);
    expect(d.pessoas.find((p) => p.user_id === BIA)!.times.map((t) => t.nome)).toEqual(["Financeiro", "Suporte"]);
  });

  it("os times: livres (só os disponíveis) e aberto/fora do horário", async () => {
    const d = await lerDiretorio(pool, ORG, ANA, AGORA, ONLINE);
    expect(d.times).toEqual([
      { id: FECHADO, nome: "Financeiro", situacao: "fora_do_horario", disponiveis: 0 },
      { id: TIME, nome: "Suporte", situacao: "aberto", disponiveis: 1 },
    ]);
  });
});

describe("pedirTransferencia", () => {
  it("dona pede para pessoa disponível: grava aberta com quem pediu e de quem sai", async () => {
    const r = await pedido();
    expect(r).toMatchObject({ ok: true, kind: "blind", fromUserId: ANA });
    const t = (await pool.query(`select status, requested_by, from_user_id, to_user_id from voice_call_transfers where id = $1`, [r.ok && r.id])).rows[0];
    expect(t).toEqual({ status: "open", requested_by: ANA, from_user_id: ANA, to_user_id: BIA });
    // Uma por vez: a segunda, com a primeira aberta, é recusada pelo banco.
    expect(await pedido({ para: { team_id: TIME } })).toEqual({ ok: false, motivo: "ja_ha_transferencia" });
    if (r.ok) await recusarPedidoSemWorker(pool, ORG, r.id);
    expect((await pool.query(`select outcome, reason from voice_call_transfers where id = $1`, [r.ok && r.id])).rows[0]).toEqual({
      outcome: "refused",
      reason: "telefonia_indisponivel",
    });
  });

  it("gerente pede pela ligação de outra pessoa; agente que não é dono, não", async () => {
    expect(await pedido({ userId: BIA, papel: "agent" })).toEqual({ ok: false, motivo: "sem_permissao" });
    const r = await pedido({ userId: EVA, papel: "manager", para: { team_id: TIME } });
    expect(r).toMatchObject({ ok: true, fromUserId: ANA });
    if (r.ok) await recusarPedidoSemWorker(pool, ORG, r.id);
  });

  it.each([
    [{ user_id: CAIO }, "destino_em_pausa"],
    [{ user_id: DAVI }, "destino_fora_do_horario"],
    [{ user_id: FABIO }, "destino_offline"],
    [{ user_id: GUTO }, "destino_invalido"],
    [{ user_id: ZE }, "destino_invalido"],
    [{ user_id: ANA }, "destino_e_voce"],
    [{ team_id: FECHADO }, "time_fora_do_horario"],
    [{ team_id: TIME_OUTRA }, "destino_invalido"],
  ])("destino %o → %s", async (para, motivo) => {
    expect(await pedido({ para })).toEqual({ ok: false, motivo });
  });

  it("consultada só para pessoa", async () => {
    expect(await pedido({ modo: "consultada", para: { team_id: TIME } })).toEqual({ ok: false, motivo: "consultada_so_para_pessoa" });
  });

  it("ligação não atendida, interna, de outra organização", async () => {
    expect(await pedido({ vcId: TOCANDO })).toEqual({ ok: false, motivo: "ligacao_nao_atendida" });
    expect(await pedido({ vcId: INTERNA })).toEqual({ ok: false, motivo: "ligacao_interna" });
    expect(await pedido({ org: OUTRA })).toEqual({ ok: false, motivo: "ligacao_inexistente" });
  });
});

describe("consultaAberta (completar / voltar)", () => {
  it("só a consultada aberta desta ligação, só quem transferiu ou gerente+", async () => {
    expect(await consultaAberta(pool, { org: ORG, userId: ANA, papel: "agent", vcId: LIGACAO })).toEqual({
      ok: false,
      motivo: "sem_transferencia_aberta",
    });
    const r = await pedido({ modo: "consultada" });
    expect(r.ok).toBe(true);
    expect(await consultaAberta(pool, { org: ORG, userId: ANA, papel: "agent", vcId: LIGACAO })).toMatchObject({ ok: true });
    expect(await consultaAberta(pool, { org: ORG, userId: BIA, papel: "agent", vcId: LIGACAO })).toEqual({
      ok: false,
      motivo: "sem_permissao",
    });
    expect(await consultaAberta(pool, { org: ORG, userId: EVA, papel: "manager", vcId: LIGACAO })).toMatchObject({ ok: true });
    expect(await consultaAberta(pool, { org: OUTRA, userId: ANA, papel: "admin", vcId: LIGACAO })).toMatchObject({ ok: false });
  });
});
