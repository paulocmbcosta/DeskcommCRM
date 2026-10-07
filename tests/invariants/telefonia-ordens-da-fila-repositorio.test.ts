/**
 * O BANCO DAS ORDENS DA FILA DO LADO DO WORKER (lib/channels/telefonia/repositorio.ts,
 * migration 0296) — "atender" e "mover", pedidos pela aba Telefone.
 *
 * O controlador é provado com um banco de mentira (controle.test.ts); aqui se
 * prova o SQL, no schema de verdade, sempre com a OUTRA organização ao lado: o
 * worker usa `pg.Pool` fora da RLS, e a única catraca é o `organization_id` (e
 * o id da ligação) de cada leitura e de cada escrita.
 *
 *  1. `ordemDaFilaAberta` só devolve a aberta DESTA organização e DESTA ligação
 *     (o evento da ARI é ponteiro: o id de outra organização não volta) — e a
 *     IDADE dela, medida no relógio do banco (o worker não executa a que venceu);
 *  2. `encerrarOrdemDaFila` fecha uma vez só, com cada desfecho do vocabulário,
 *     e não fecha a de outra organização;
 *  3. `recusarOrdemDaFilaOrfa` exige o PAR (ordem, ligação);
 *  4. `cancelarOrdensDaLigacao` fecha só as abertas daquela ligação, naquela
 *     organização — e libera a próxima ordem (uma aberta por ligação);
 *  5. `cancelarOrdensDaFilaAbertas` fecha todas as abertas (reinício do worker),
 *     e não reescreve as que já tinham acabado;
 *  6. `registrarNaConversa` leva ao cartão, em `fila`, as ordens que ACONTECERAM
 *     (`done`), com os nomes — na ligação perdida e na que tinha o cartão "em
 *     andamento"; sem ordem nenhuma a chave não existe; e a leitura que falha
 *     não derruba o registro. O nome é o da régua única do banco
 *     (`fn_nome_do_usuario`): de quem não cadastrou nome, o que vem antes do
 *     `@` — o e-mail inteiro do colega nunca vai para a conversa.
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

const ORG = "c0de0299-0000-4000-8000-00000000000a";
const OUTRA = "c0de0299-0000-4000-8000-00000000000b";
const ANA = "c0de0299-1111-4000-8000-000000000001";
const CAIO = "c0de0299-1111-4000-8000-000000000002";
const ZE = "c0de0299-1111-4000-8000-000000000003";
/** Membro de A que nunca cadastrou o nome: só tem o e-mail. */
const SEM_NOME = "c0de0299-1111-4000-8000-000000000004";
const EMAIL_SEM_NOME = "duda.pereira-0299@invariant.test";
const SUPORTE = "c0de0299-2222-4000-8000-000000000001";
const FINANCEIRO = "c0de0299-2222-4000-8000-000000000002";
const TIME_OUTRA = "c0de0299-2222-4000-8000-000000000003";
const NUMERO = "c0de0299-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0299-5555-4000-8000-000000000002";
const CONTATO = "c0de0299-6666-4000-8000-000000000001";
const CONVERSA = "c0de0299-7777-4000-8000-000000000001";

const um = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => (await pool.query<T>(q, p)).rows[0]!;

let ligacoes = 0;
/** Uma recebida que espera na fila (ou já atendida por `dono`). Com conversa só na organização A. */
async function novaLigacao(org: string, p: { dono?: string } = {}): Promise<string> {
  const n = ++ligacoes;
  const daA = org === ORG;
  const { id } = await um<{ id: string }>(
    `insert into public.voice_calls
       (organization_id, channel_session_id, contact_id, conversation_id, provider, sip_call_ref, direction,
        peer_phone, status, team_id, queued_at, owner_user_id, answered_at)
     values ($1, $2, $3, $4, 'sip_trunk', $5, 'inbound', $6, $7, $8, now(), $9, $10)
     returning id`,
    [
      org,
      daA ? NUMERO : NUMERO_OUTRA,
      daA ? CONTATO : null,
      daA ? CONVERSA : null,
      `ref-0299-${n}`,
      `+55619777${String(n).padStart(5, "0")}`,
      p.dono ? "connected" : "ringing",
      daA ? SUPORTE : TIME_OUTRA,
      p.dono ?? null,
      p.dono ? new Date() : null,
    ],
  );
  return id;
}

/** O pedido que a rota grava: `pull` (para o ramal de quem pediu) ou `move` (para a fila de `paraTime`). */
async function novaOrdem(p: {
  org: string;
  vc: string;
  kind: "pull" | "move";
  quem: string;
  deTime?: string | null;
  paraTime?: string | null;
}): Promise<string> {
  const { id } = await um<{ id: string }>(
    `insert into public.voice_call_queue_orders
       (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [p.org, p.vc, p.kind, p.quem, p.kind === "pull" ? p.quem : null, p.paraTime ?? null, p.deTime ?? null],
  );
  return id;
}

const ordem = (id: string) =>
  um<{ status: string; outcome: string | null; reason: string | null; ended_at: Date | null }>(
    `select status, outcome, reason, ended_at from public.voice_call_queue_orders where id = $1`,
    [id],
  );

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-0299@invariant.test', '{"full_name":"Ana"}'),
       ($2, 'caio-0299@invariant.test', '{"full_name":"Caio"}'),
       ($3, 'ze-0299@invariant.test', '{"full_name":"Zé de B"}'),
       ($4, $5, '{}')
     on conflict (id) do nothing`,
    [ANA, CAIO, ZE, SEM_NOME, EMAIL_SEM_NOME],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'ordens-repo-0299-a', 'Ordens Repo A', 'Ordens A'), ($2, 'ordens-repo-0299-b', 'Ordens Repo B', 'Ordens B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $4, 'manager', now()), ($2, $4, 'agent', now()), ($3, $5, 'agent', now()), ($6, $4, 'agent', now())
     on conflict do nothing`,
    [ANA, CAIO, ZE, ORG, OUTRA, SEM_NOME],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug) values
       ($1, $4, 'Suporte', 'suporte-0299'), ($2, $4, 'Financeiro', 'financeiro-0299'), ($3, $5, 'Suporte B', 'suporte-0299')
     on conflict (id) do nothing`,
    [SUPORTE, FINANCEIRO, TIME_OUTRA, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'WORKING', 'Ordens A', '+556130002991', 'voip.exemplo-0299a.com.br', 5060, 'udp', 'u0299a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'WORKING', 'Ordens B', '+556130002992', 'voip.exemplo-0299b.com.br', 5060, 'udp', 'u0299b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.contacts (id, organization_id, name, phone_number, source) values
       ($1, $2, 'Cliente', '+5561999990299', 'phone_call')
     on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into public.conversations
       (id, organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
     values ($1, $2, $3, $4, 'phone', 'open', false, 0, $5)
     on conflict (id) do nothing`,
    [CONVERSA, ORG, CONTATO, NUMERO, SUPORTE],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("a ordem aberta (o evento é ponteiro)", () => {
  it("volta só com a organização e a ligação certas — e com o que a ordem pede, lido do banco", async () => {
    const vc = await novaLigacao(ORG);
    const outraLigacao = await novaLigacao(ORG);
    const vcDeB = await novaLigacao(OUTRA);
    const puxar = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO, deTime: SUPORTE });
    const mover = await novaOrdem({ org: ORG, vc: outraLigacao, kind: "move", quem: ANA, deTime: SUPORTE, paraTime: FINANCEIRO });
    const deB = await novaOrdem({ org: OUTRA, vc: vcDeB, kind: "pull", quem: ZE });

    expect(await repo.ordemDaFilaAberta(pool, ORG, vc, puxar)).toEqual({
      id: puxar,
      kind: "pull",
      requestedBy: CAIO,
      toUserId: CAIO,
      toTeamId: null,
      idadeMs: expect.any(Number),
    });
    expect(await repo.ordemDaFilaAberta(pool, ORG, outraLigacao, mover)).toEqual({
      id: mover,
      kind: "move",
      requestedBy: ANA,
      toUserId: null,
      toTeamId: FINANCEIRO,
      idadeMs: expect.any(Number),
    });
    // A organização errada, a ligação errada, e a ordem de outra organização: nada.
    expect(await repo.ordemDaFilaAberta(pool, OUTRA, vc, puxar)).toBeNull();
    expect(await repo.ordemDaFilaAberta(pool, ORG, outraLigacao, puxar)).toBeNull();
    expect(await repo.ordemDaFilaAberta(pool, ORG, vc, deB)).toBeNull();
    expect(await repo.ordemDaFilaAberta(pool, ORG, vcDeB, deB)).toBeNull();
    // A própria organização de B a lê.
    expect((await repo.ordemDaFilaAberta(pool, OUTRA, vcDeB, deB))?.id).toBe(deB);
  });

  it("a idade da ordem vem do relógio do BANCO: a recém-gravada tem quase zero, e a de 31 s atrás, 31 s", async () => {
    const vc = await novaLigacao(ORG);
    const outraLigacao = await novaLigacao(ORG);
    const nova = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });
    const velha = await novaOrdem({ org: ORG, vc: outraLigacao, kind: "pull", quem: CAIO });
    await pool.query(`update public.voice_call_queue_orders set created_at = now() - interval '31 seconds' where id = $1`, [velha]);

    const idadeDaNova = (await repo.ordemDaFilaAberta(pool, ORG, vc, nova))!.idadeMs;
    const idadeDaVelha = (await repo.ordemDaFilaAberta(pool, ORG, outraLigacao, velha))!.idadeMs;
    // Número (e não o texto que o `pg` devolve para `numeric`), em milissegundos.
    expect(typeof idadeDaNova).toBe("number");
    expect(idadeDaNova).toBeGreaterThanOrEqual(0);
    expect(idadeDaNova).toBeLessThan(10_000);
    expect(idadeDaVelha).toBeGreaterThanOrEqual(31_000);
    expect(idadeDaVelha).toBeLessThan(41_000);
  });

  it("encerrar fecha uma vez só, e não alcança a de outra organização", async () => {
    const vc = await novaLigacao(ORG);
    const vcDeB = await novaLigacao(OUTRA);
    const minha = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });
    const deB = await novaOrdem({ org: OUTRA, vc: vcDeB, kind: "pull", quem: ZE });

    await repo.encerrarOrdemDaFila(pool, ORG, deB, { desfecho: "done", motivo: null });
    expect(await ordem(deB)).toMatchObject({ status: "open", outcome: null, ended_at: null });

    await repo.encerrarOrdemDaFila(pool, ORG, minha, { desfecho: "refused", motivo: "destino_em_ligacao" });
    const fechada = await ordem(minha);
    expect(fechada).toMatchObject({ status: "ended", outcome: "refused", reason: "destino_em_ligacao" });
    expect(fechada.ended_at).toBeInstanceOf(Date);
    // A segunda escrita não reescreve o desfecho nem a hora.
    await repo.encerrarOrdemDaFila(pool, ORG, minha, { desfecho: "done", motivo: null });
    expect(await ordem(minha)).toEqual(fechada);
    // Fechada, deixa de ser "a ordem aberta".
    expect(await repo.ordemDaFilaAberta(pool, ORG, vc, minha)).toBeNull();
  });

  it.each(["done", "refused", "no_answer", "cancelled"] as const)(
    "o desfecho '%s' que o worker grava cabe no CHECK da tabela",
    async (desfecho) => {
      const vc = await novaLigacao(ORG);
      const id = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });
      await repo.encerrarOrdemDaFila(pool, ORG, id, { desfecho, motivo: null });
      expect(await ordem(id)).toMatchObject({ status: "ended", outcome: desfecho, reason: null });
    },
  );

  it("a órfã exige o par (ordem, ligação)", async () => {
    const vc = await novaLigacao(ORG);
    const outraLigacao = await novaLigacao(ORG);
    const id = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });

    await repo.recusarOrdemDaFilaOrfa(pool, id, outraLigacao, "ligacao_desconhecida");
    expect(await ordem(id)).toMatchObject({ status: "open" });

    await repo.recusarOrdemDaFilaOrfa(pool, id, vc, "ligacao_desconhecida");
    const recusada = await ordem(id);
    expect(recusada).toMatchObject({ status: "ended", outcome: "refused", reason: "ligacao_desconhecida" });
    // Idempotente: a que já fechou não muda.
    await repo.recusarOrdemDaFilaOrfa(pool, id, vc, "outro_motivo");
    expect(await ordem(id)).toEqual(recusada);
  });
});

describe("o fim da ligação e o reinício do worker", () => {
  it("o fim da ligação cancela só as ordens abertas DELA, na organização dela — e libera a próxima", async () => {
    const vc = await novaLigacao(ORG);
    const vizinha = await novaLigacao(ORG);
    const vcDeB = await novaLigacao(OUTRA);
    const antiga = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });
    await repo.encerrarOrdemDaFila(pool, ORG, antiga, { desfecho: "no_answer", motivo: null });
    const aberta = await novaOrdem({ org: ORG, vc, kind: "pull", quem: ANA });
    const daVizinha = await novaOrdem({ org: ORG, vc: vizinha, kind: "pull", quem: CAIO });
    const deB = await novaOrdem({ org: OUTRA, vc: vcDeB, kind: "pull", quem: ZE });

    // Com a organização errada, não alcança nada — nem a ligação de A, nem a de B.
    expect(await repo.cancelarOrdensDaLigacao(pool, OUTRA, vc, "ligacao_encerrada")).toBe(0);
    expect(await repo.cancelarOrdensDaLigacao(pool, ORG, vcDeB, "ligacao_encerrada")).toBe(0);
    expect(await ordem(aberta)).toMatchObject({ status: "open" });
    expect(await ordem(deB)).toMatchObject({ status: "open" });

    expect(await repo.cancelarOrdensDaLigacao(pool, ORG, vc, "ligacao_encerrada")).toBe(1);
    expect(await ordem(aberta)).toMatchObject({ status: "ended", outcome: "cancelled", reason: "ligacao_encerrada" });
    // A que já tinha acabado guarda o desfecho dela; a da ligação vizinha e a de B seguem abertas.
    expect(await ordem(antiga)).toMatchObject({ status: "ended", outcome: "no_answer", reason: null });
    expect(await ordem(daVizinha)).toMatchObject({ status: "open" });
    expect(await ordem(deB)).toMatchObject({ status: "open" });
    // Sem ordem aberta, não há o que cancelar.
    expect(await repo.cancelarOrdensDaLigacao(pool, ORG, vc, "ligacao_encerrada")).toBe(0);

    // Uma aberta por ligação: fechada a anterior, a seguinte entra.
    const seguinte = await novaOrdem({ org: ORG, vc, kind: "move", quem: ANA, deTime: SUPORTE, paraTime: FINANCEIRO });
    expect((await repo.ordemDaFilaAberta(pool, ORG, vc, seguinte))?.kind).toBe("move");
  });

  it("o reinício do worker cancela TODAS as abertas, das duas organizações — e não reescreve as que já tinham acabado", async () => {
    // Os casos de cima deixam ordens abertas: fecha-as antes, para contar só as deste.
    await repo.cancelarOrdensDaFilaAbertas(pool, "arrumacao_do_teste");
    const vc = await novaLigacao(ORG);
    const outraLigacao = await novaLigacao(ORG);
    const vcDeB = await novaLigacao(OUTRA);
    const feita = await novaOrdem({ org: ORG, vc, kind: "pull", quem: CAIO });
    await repo.encerrarOrdemDaFila(pool, ORG, feita, { desfecho: "done", motivo: null });
    const antes = await ordem(feita);
    const abertaA = await novaOrdem({ org: ORG, vc, kind: "pull", quem: ANA });
    const abertaA2 = await novaOrdem({ org: ORG, vc: outraLigacao, kind: "move", quem: ANA, deTime: SUPORTE, paraTime: FINANCEIRO });
    const abertaB = await novaOrdem({ org: OUTRA, vc: vcDeB, kind: "pull", quem: ZE });

    expect(await repo.cancelarOrdensDaFilaAbertas(pool, "worker_reiniciou")).toBe(3);
    for (const id of [abertaA, abertaA2, abertaB]) {
      expect(await ordem(id)).toMatchObject({ status: "ended", outcome: "cancelled", reason: "worker_reiniciou" });
    }
    expect(await ordem(feita)).toEqual(antes);
    expect(await repo.cancelarOrdensDaFilaAbertas(pool, "worker_reiniciou")).toBe(0);
  });
});

describe("as ordens no cartão da ligação", () => {
  const filaDoCartao = async (vc: string) =>
    (
      await um<{ metadata: { voice_call: { fila?: unknown; em_andamento?: unknown; desfecho: string } } }>(
        `select metadata from public.messages where organization_id = $1 and external_id = $2`,
        [ORG, `ligacao:${vc}`],
      )
    ).metadata.voice_call;

  /** Uma ordem que já acabou, com a hora do pedido escolhida (a ordem do cartão é a dos pedidos). */
  async function ordemAcabada(p: {
    vc: string;
    kind: "pull" | "move";
    quem: string | null;
    desfecho: repo.DesfechoDaOrdemDaFila;
    deTime?: string | null;
    paraTime?: string | null;
    segundos: number;
  }) {
    await pool.query(
      `insert into public.voice_call_queue_orders
         (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id, status, outcome, ended_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'ended', $8, now(), now() + make_interval(secs => $9))`,
      [ORG, p.vc, p.kind, p.quem, p.kind === "pull" ? p.quem : null, p.paraTime ?? null, p.deTime ?? null, p.desfecho, p.segundos],
    );
  }

  it("a ligação perdida leva em `fila` as ordens que ACONTECERAM, na ordem dos pedidos e com os nomes — as outras ficam de fora", async () => {
    const vc = await novaLigacao(ORG);
    await ordemAcabada({ vc, kind: "pull", quem: CAIO, desfecho: "refused", deTime: SUPORTE, segundos: 1 });
    await ordemAcabada({ vc, kind: "move", quem: ANA, desfecho: "done", deTime: SUPORTE, paraTime: FINANCEIRO, segundos: 2 });
    await ordemAcabada({ vc, kind: "pull", quem: CAIO, desfecho: "no_answer", deTime: FINANCEIRO, segundos: 3 });
    await ordemAcabada({ vc, kind: "move", quem: ANA, desfecho: "done", deTime: FINANCEIRO, paraTime: SUPORTE, segundos: 4 });
    await ordemAcabada({ vc, kind: "pull", quem: CAIO, desfecho: "cancelled", deTime: SUPORTE, segundos: 5 });
    // A que ainda está aberta quando a ligação é registrada também não aconteceu.
    await novaOrdem({ org: ORG, vc, kind: "pull", quem: ANA, deTime: SUPORTE });

    const l = (await repo.encerrarLigacao(pool, ORG, vc, "fila_esgotada"))!;
    await repo.registrarNaConversa(pool, l, "perdida", null);

    const registro = await filaDoCartao(vc);
    expect(registro.desfecho).toBe("perdida");
    expect(registro.fila).toEqual([
      { tipo: "move", por_nome: "Ana", de_time: "Suporte", para_time: "Financeiro" },
      { tipo: "move", por_nome: "Ana", de_time: "Financeiro", para_time: "Suporte" },
    ]);
  });

  it("a ligação puxada e atendida: o cartão 'em andamento' é completado com a puxada — quem pediu apagado vira nome nulo, não some a linha", async () => {
    const vc = await novaLigacao(ORG, { dono: CAIO });
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    expect((await filaDoCartao(vc)).em_andamento).toBe(true);
    await ordemAcabada({ vc, kind: "pull", quem: CAIO, desfecho: "done", deTime: SUPORTE, segundos: 1 });
    await ordemAcabada({ vc, kind: "pull", quem: null, desfecho: "done", deTime: null, segundos: 2 });

    const l = (await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou"))!;
    await repo.registrarNaConversa(pool, l, "atendida", 30_000);

    const registro = await filaDoCartao(vc);
    expect(registro.em_andamento).toBeUndefined();
    expect(registro.fila).toEqual([
      { tipo: "pull", por_nome: "Caio", de_time: "Suporte", para_time: null },
      { tipo: "pull", por_nome: null, de_time: null, para_time: null },
    ]);
  });

  it("quem puxou ou moveu sem nome cadastrado aparece pelo que vem antes do @ — o e-mail do colega NÃO vai para a conversa", async () => {
    const vc = await novaLigacao(ORG);
    await ordemAcabada({ vc, kind: "pull", quem: SEM_NOME, desfecho: "done", deTime: SUPORTE, segundos: 1 });
    await ordemAcabada({ vc, kind: "move", quem: SEM_NOME, desfecho: "done", deTime: SUPORTE, paraTime: FINANCEIRO, segundos: 2 });
    const l = (await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou"))!;
    await repo.registrarNaConversa(pool, l, "perdida", null);

    const registro = await filaDoCartao(vc);
    expect(registro.fila).toEqual([
      { tipo: "pull", por_nome: "duda.pereira-0299", de_time: "Suporte", para_time: null },
      { tipo: "move", por_nome: "duda.pereira-0299", de_time: "Suporte", para_time: "Financeiro" },
    ]);
    expect(JSON.stringify(registro.fila)).not.toContain("@");
    expect(JSON.stringify(registro.fila)).not.toContain(EMAIL_SEM_NOME);
  });

  it("sem ordem que tenha acontecido, o registro não leva a chave `fila`", async () => {
    const vc = await novaLigacao(ORG);
    await ordemAcabada({ vc, kind: "pull", quem: CAIO, desfecho: "refused", deTime: SUPORTE, segundos: 1 });
    const l = (await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou"))!;
    await repo.registrarNaConversa(pool, l, "perdida", null);
    expect(await filaDoCartao(vc)).not.toHaveProperty("fila");
  });

  it("as ordens de outra ligação não entram no cartão desta", async () => {
    const vc = await novaLigacao(ORG);
    const vizinha = await novaLigacao(ORG);
    await ordemAcabada({ vc: vizinha, kind: "move", quem: ANA, desfecho: "done", deTime: SUPORTE, paraTime: FINANCEIRO, segundos: 1 });
    const l = (await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou"))!;
    await repo.registrarNaConversa(pool, l, "perdida", null);
    expect(await filaDoCartao(vc)).not.toHaveProperty("fila");
  });

  it("a leitura das ordens falha: o registro da ligação sai mesmo assim, sem a chave", async () => {
    const vc = await novaLigacao(ORG);
    await ordemAcabada({ vc, kind: "move", quem: ANA, desfecho: "done", deTime: SUPORTE, paraTime: FINANCEIRO, segundos: 1 });
    const l = (await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou"))!;
    // O mesmo banco, com a leitura das ordens — e só ela — fora do ar.
    const semAsOrdens = {
      query: <R extends pg.QueryResultRow = pg.QueryResultRow>(texto: string, valores?: unknown[]) =>
        texto.includes("voice_call_queue_orders")
          ? Promise.reject<pg.QueryResult<R>>(new Error("banco fora do ar"))
          : pool.query<R>(texto, valores),
    };
    await repo.registrarNaConversa(semAsOrdens, l, "perdida", null);
    const registro = await filaDoCartao(vc);
    expect(registro.desfecho).toBe("perdida");
    expect(registro).not.toHaveProperty("fila");
  });
});
