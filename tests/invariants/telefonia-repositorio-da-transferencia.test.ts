/**
 * O BANCO DA TRANSFERÊNCIA DO LADO DO WORKER (lib/channels/telefonia/repositorio.ts,
 * migrations 0290 e 0291) — cada função medida no Postgres real, com a outra
 * organização ao lado para provar que nenhuma escrita a alcança:
 *
 *  - `transferenciaAberta` só devolve a aberta DESTA organização e DESTA ligação
 *    (a ordem da ARI é ponteiro: um id de outra organização não volta);
 *  - `encerrarTransferencia` fecha uma vez só, e não fecha a de outra organização;
 *  - `recusarTransferenciaOrfa` exige o PAR (transferência, ligação);
 *  - `cancelarTransferenciasAbertas` fecha todas as abertas (reinício do worker);
 *  - `marcarTocandoNaTransferencia` mexe só no `ringing_user_id` — a ligação
 *    segue `connected`;
 *  - `passarLigacao` troca o dono sem mexer em `answered_at`;
 *  - `moverParaOTime` leva a ligação e a conversa ao time (soltando o dono da
 *    conversa, com o evento `team_transfer`), e não move para time arquivado nem
 *    de outra organização;
 *  - `timeDaLigacao` cai no time da conversa quando a ligação não tem;
 *  - `pessoaEmLigacao` e `disponiveisNoTime` enxergam quem está do outro lado de
 *    uma ligação interna (`peer_user_id`, 0291);
 *  - `registrarNaConversa` grava a corrente de transferências com os nomes.
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

const ORG = "c0de0292-0000-4000-8000-00000000000a";
const OUTRA = "c0de0292-0000-4000-8000-00000000000b";
const ANA = "c0de0292-1111-4000-8000-000000000001";
const BIA = "c0de0292-1111-4000-8000-000000000002";
const CAIO = "c0de0292-1111-4000-8000-000000000003";
const TIME = "c0de0292-2222-4000-8000-000000000001";
const ARQUIVADO = "c0de0292-2222-4000-8000-000000000002";
const TIME_OUTRA = "c0de0292-2222-4000-8000-000000000003";
const NUMERO = "c0de0292-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0292-5555-4000-8000-000000000002";
const CONTATO = "c0de0292-6666-4000-8000-000000000001";
const CONVERSA = "c0de0292-7777-4000-8000-000000000001";
const LIGACAO = "c0de0292-8888-4000-8000-000000000001";
const LIGACAO_OUTRA = "c0de0292-8888-4000-8000-000000000002";
const INTERNA = "c0de0292-8888-4000-8000-000000000003";
const T1 = "c0de0292-9999-4000-8000-000000000001";
const T_OUTRA = "c0de0292-9999-4000-8000-000000000002";
const T2 = "c0de0292-9999-4000-8000-000000000003";

const um = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => (await pool.query<T>(q, p)).rows[0]!;

beforeAll(async () => {
  await pool.query(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}', 'ana-0292@invariant.test', '{"full_name":"Ana"}'),
      ('${BIA}', 'bia-0292@invariant.test', '{"full_name":"Bia"}'),
      ('${CAIO}', 'caio-0292@invariant.test', '{"full_name":"Caio"}')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'transf-repo-a', 'Repo A', 'Repo A'), ('${OUTRA}', 'transf-repo-b', 'Repo B', 'Repo B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}', '${ORG}', 'agent', now()), ('${BIA}', '${ORG}', 'agent', now()), ('${CAIO}', '${ORG}', 'agent', now()),
      ('${ANA}', '${OUTRA}', 'agent', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug, archived_at) values
      ('${TIME}', '${ORG}', 'Suporte', 'suporte-0292', null),
      ('${ARQUIVADO}', '${ORG}', 'Antigo', 'antigo-0292', now()),
      ('${TIME_OUTRA}', '${OUTRA}', 'Suporte B', 'suporte-0292', null)
      on conflict (id) do nothing;
    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG}', '${TIME}', '${BIA}'), ('${ORG}', '${TIME}', '${CAIO}')
      on conflict do nothing;
    insert into public.attendant_availability (organization_id, user_id, is_available) values
      ('${ORG}', '${BIA}', true), ('${ORG}', '${CAIO}', true)
      on conflict (organization_id, user_id) do update set is_available = true;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO}', '${ORG}', 'sip_trunk', '\\x00', 'WORKING', 'Repo A', '+556130000293',
            'voip.exemplo-0292.com.br', 5060, 'udp', 'u0292a', '\\x00'),
           ('${NUMERO_OUTRA}', '${OUTRA}', 'sip_trunk', '\\x00', 'WORKING', 'Repo B', '+556130000294',
            'voip.exemplo-0292.com.br', 5060, 'udp', 'u0292b', '\\x00')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, phone_number, source) values
      ('${CONTATO}', '${ORG}', 'Cliente', '+5561999990292', 'phone_call')
      on conflict (id) do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id, assigned_to_user_id)
    values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${NUMERO}', 'phone', 'open', false, 0, null, '${ANA}')
      on conflict (id) do nothing;
    insert into public.voice_calls
      (id, organization_id, channel_session_id, contact_id, conversation_id, provider, sip_call_ref, direction,
       peer_phone, status, owner_user_id, answered_at)
    values ('${LIGACAO}', '${ORG}', '${NUMERO}', '${CONTATO}', '${CONVERSA}', 'sip_trunk', 'ref-0292-a', 'inbound',
            '+5561999990292', 'connected', '${ANA}', now() - interval '1 minute'),
           ('${LIGACAO_OUTRA}', '${OUTRA}', '${NUMERO_OUTRA}', null, null, 'sip_trunk', 'ref-0292-b', 'inbound',
            '+5561999990293', 'connected', '${ANA}', now())
      on conflict (id) do nothing;
    insert into public.voice_call_transfers (id, organization_id, voice_call_id, requested_by, from_user_id, to_user_id, to_team_id, kind) values
      ('${T1}', '${ORG}', '${LIGACAO}', '${ANA}', '${ANA}', '${BIA}', null, 'blind'),
      ('${T_OUTRA}', '${OUTRA}', '${LIGACAO_OUTRA}', '${ANA}', '${ANA}', null, '${TIME_OUTRA}', 'blind')
      on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("a transferência aberta (a ordem é ponteiro)", () => {
  it("volta só com a organização e a ligação certas", async () => {
    expect(await repo.transferenciaAberta(pool, ORG, LIGACAO, T1)).toEqual({
      id: T1,
      kind: "blind",
      fromUserId: ANA,
      toUserId: BIA,
      toTeamId: null,
    });
    expect(await repo.transferenciaAberta(pool, OUTRA, LIGACAO, T1)).toBeNull();
    expect(await repo.transferenciaAberta(pool, ORG, LIGACAO_OUTRA, T1)).toBeNull();
    expect(await repo.transferenciaAberta(pool, ORG, LIGACAO, T_OUTRA)).toBeNull();
  });

  it("encerrar fecha uma vez só, e não alcança a de outra organização", async () => {
    await repo.encerrarTransferencia(pool, ORG, T_OUTRA, { desfecho: "answered", motivo: null, atendidaPor: BIA });
    expect((await um<{ status: string }>(`select status from voice_call_transfers where id = $1`, [T_OUTRA])).status).toBe("open");

    await repo.encerrarTransferencia(pool, ORG, T1, { desfecho: "answered", motivo: null, atendidaPor: BIA });
    await repo.encerrarTransferencia(pool, ORG, T1, { desfecho: "missed", motivo: "x", atendidaPor: null });
    const t = await um<{ status: string; outcome: string; answered_by: string }>(
      `select status, outcome, answered_by from voice_call_transfers where id = $1`,
      [T1],
    );
    expect(t).toEqual({ status: "ended", outcome: "answered", answered_by: BIA });
    expect(await repo.transferenciaAberta(pool, ORG, LIGACAO, T1)).toBeNull();
  });

  it("a órfã exige o par (transferência, ligação)", async () => {
    await repo.recusarTransferenciaOrfa(pool, T_OUTRA, LIGACAO, "ligacao_desconhecida");
    expect((await um<{ status: string }>(`select status from voice_call_transfers where id = $1`, [T_OUTRA])).status).toBe("open");
    await repo.recusarTransferenciaOrfa(pool, T_OUTRA, LIGACAO_OUTRA, "ligacao_desconhecida");
    expect(await um(`select status, outcome, reason from voice_call_transfers where id = $1`, [T_OUTRA])).toEqual({
      status: "ended",
      outcome: "refused",
      reason: "ligacao_desconhecida",
    });
  });

  it("o reinício do worker cancela todas as abertas", async () => {
    await pool.query(
      `insert into voice_call_transfers (id, organization_id, voice_call_id, from_user_id, to_user_id, kind)
       values ($1, $2, $3, $4, $5, 'attended')`,
      [T2, ORG, LIGACAO, ANA, CAIO],
    );
    expect(await repo.cancelarTransferenciasAbertas(pool, "worker_reiniciou")).toBeGreaterThanOrEqual(1);
    expect(await um(`select outcome, reason from voice_call_transfers where id = $1`, [T2])).toEqual({
      outcome: "cancelled",
      reason: "worker_reiniciou",
    });
  });
});

describe("a ligação durante a transferência", () => {
  it("'tocando' na transferência não tira a ligação de connected", async () => {
    await repo.marcarTocandoNaTransferencia(pool, ORG, LIGACAO, BIA);
    expect(await um(`select status, ringing_user_id from voice_calls where id = $1`, [LIGACAO])).toEqual({
      status: "connected",
      ringing_user_id: BIA,
    });
    // O ocupado: Bia, tocando, não está livre para a fila do time.
    expect(await repo.pessoaEmLigacao(pool, ORG, BIA)).toBe(true);
    const livres = await repo.disponiveisNoTime(pool, ORG, TIME, new Date());
    expect(livres.map((c) => c.userId)).not.toContain(BIA);
    // De outra organização, não conta.
    await repo.marcarTocandoNaTransferencia(pool, OUTRA, LIGACAO, CAIO);
    expect((await um<{ r: string }>(`select ringing_user_id as r from voice_calls where id = $1`, [LIGACAO])).r).toBe(BIA);
  });

  it("passar a ligação troca o dono e mantém a hora em que o cliente foi atendido", async () => {
    const antes = await um<{ answered_at: Date }>(`select answered_at from voice_calls where id = $1`, [LIGACAO]);
    await repo.passarLigacao(pool, ORG, LIGACAO, BIA);
    const depois = await um<{ owner_user_id: string; ringing_user_id: string | null; answered_at: Date }>(
      `select owner_user_id, ringing_user_id, answered_at from voice_calls where id = $1`,
      [LIGACAO],
    );
    expect(depois.owner_user_id).toBe(BIA);
    expect(depois.ringing_user_id).toBeNull();
    expect(depois.answered_at.toISOString()).toBe(antes.answered_at.toISOString());
  });

  it("mover para o time leva a ligação e a conversa, e solta o dono da conversa com o evento", async () => {
    expect(await repo.timeDaLigacao(pool, ORG, LIGACAO)).toBeNull();
    await repo.moverParaOTime(pool, ORG, LIGACAO, CONVERSA, TIME);
    expect((await um<{ team_id: string }>(`select team_id from voice_calls where id = $1`, [LIGACAO])).team_id).toBe(TIME);
    expect(await um(`select team_id, assigned_to_user_id from conversations where id = $1`, [CONVERSA])).toEqual({
      team_id: TIME,
      assigned_to_user_id: null,
    });
    expect(
      await um(
        `select from_user_id, reason from conversation_assignment_events where conversation_id = $1 order by created_at desc limit 1`,
        [CONVERSA],
      ),
    ).toEqual({ from_user_id: ANA, reason: "team_transfer" });
    expect(await repo.timeDaLigacao(pool, ORG, LIGACAO)).toBe(TIME);
  });

  it("não move para time arquivado nem de outra organização", async () => {
    await repo.moverParaOTime(pool, ORG, LIGACAO, CONVERSA, ARQUIVADO);
    await repo.moverParaOTime(pool, ORG, LIGACAO, CONVERSA, TIME_OUTRA);
    expect((await um<{ team_id: string }>(`select team_id from voice_calls where id = $1`, [LIGACAO])).team_id).toBe(TIME);
  });

  it("o time da ligação cai no da conversa quando a ligação não tem", async () => {
    await pool.query(`update voice_calls set team_id = null where id = $1`, [LIGACAO]);
    expect(await repo.timeDaLigacao(pool, ORG, LIGACAO)).toBe(TIME);
    expect(await repo.timeDaLigacao(pool, OUTRA, LIGACAO)).toBeNull();
  });
});

describe("o ocupado da ligação interna (0291)", () => {
  it("quem está do outro lado de uma interna não está livre", async () => {
    await pool.query(`update voice_calls set status = 'ended', ringing_user_id = null where id = $1`, [LIGACAO]);
    expect(await repo.pessoaEmLigacao(pool, ORG, CAIO)).toBe(false);
    await pool.query(
      `insert into voice_calls (id, organization_id, provider, sip_call_ref, direction, peer_phone, status, owner_user_id, peer_user_id)
       values ($1, $2, 'sip_trunk', 'interna-0292', 'internal', '203', 'connected', $3, $4)`,
      [INTERNA, ORG, ANA, CAIO],
    );
    expect(await repo.pessoaEmLigacao(pool, ORG, CAIO)).toBe(true);
    expect(await repo.pessoaEmLigacao(pool, OUTRA, CAIO)).toBe(false);
    const livres = await repo.disponiveisNoTime(pool, ORG, TIME, new Date());
    expect(livres.map((c) => c.userId)).not.toContain(CAIO);
    await pool.query(`update voice_calls set status = 'ended' where id = $1`, [INTERNA]);
  });
});

describe("a corrente no registro da ligação", () => {
  it("registrarNaConversa grava as transferências com os nomes, sem as recusadas", async () => {
    await pool.query(
      `insert into voice_call_transfers (organization_id, voice_call_id, from_user_id, to_team_id, kind, status, outcome, reason, ended_at, answered_by, created_at)
       values ($1, $2, $3, $4, 'blind', 'ended', 'queue_answered', null, now(), $5, now() + interval '1 second'),
              ($1, $2, $3, null, 'blind', 'ended', 'refused', 'destino_offline', now(), null, now() + interval '2 second')`,
      [ORG, LIGACAO, BIA, TIME, CAIO],
    );
    const l = (await repo.encerrarLigacao(pool, ORG, LIGACAO, "cliente_desligou")) ?? (await um(`select * from voice_calls where id = $1`, [LIGACAO]));
    await repo.registrarNaConversa(pool, l as repo.LigacaoDoBanco, "atendida", 60_000);
    const m = await um<{ metadata: { voice_call: { transferencias: unknown[] } } }>(
      `select metadata from messages where organization_id = $1 and external_id = $2`,
      [ORG, `ligacao:${LIGACAO}`],
    );
    expect(m.metadata.voice_call.transferencias).toEqual([
      { tipo: "blind", desfecho: "answered", de_nome: "Ana", para_nome: "Bia", para_time: null, atendida_por_nome: "Bia" },
      { tipo: "attended", desfecho: "cancelled", de_nome: "Ana", para_nome: "Caio", para_time: null, atendida_por_nome: null },
      { tipo: "blind", desfecho: "queue_answered", de_nome: "Bia", para_nome: null, para_time: "Suporte", atendida_por_nome: "Caio" },
    ]);
  });
});
