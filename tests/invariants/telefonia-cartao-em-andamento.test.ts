/**
 * O CARTÃO "LIGAÇÃO EM ANDAMENTO" CONTRA POSTGRES REAL (fila visível, entrega 1).
 *
 * O registro da ligação na conversa (`ligacao:<voice_call_id>`) só entrava quando
 * a ligação ACABAVA: enquanto o atendente falava, a conversa não tinha posição na
 * lista nem onde escrever uma nota. Agora o cartão nasce quando a recebida é
 * atendida (`abrirCartaoDaLigacao`, com `metadata.voice_call.em_andamento`), e o
 * fim (`registrarNaConversa`) COMPLETA a mesma mensagem em vez de inserir outra.
 *
 * O controlador é provado com um banco de mentira (controle.test.ts); aqui se
 * prova o SQL, no schema de verdade — com os triggers da conversa e do
 * atendimento —, sempre com DUAS organizações (o worker usa `pg.Pool` fora da
 * RLS, e a única catraca é o `organization_id` de cada escrita):
 *
 *  1. atender cria UMA mensagem de sistema em andamento, com quem atendeu (o nome
 *     cadastrado ou, sem ele, o e-mail), e a conversa ganha posição e prévia;
 *  2. chamar de novo não duplica: na transferência, troca só o nome de quem está
 *     com a ligação — e o time que alguém escolheu pela tela no meio fica;
 *  3. na PRIMEIRA vez, a conversa vai para o time que recebeu a ligação;
 *  4. nada a fazer: outra organização, ligação feita, ainda tocando, sem conversa;
 *  5. quem já ligou antes: a conversa encerrada reabre com atendimento e
 *     protocolo novos, e o cartão nasce DENTRO dele;
 *  6. o fim completa o MESMO cartão, mesclando no banco (o que outro escritor
 *     gravou no metadado continua), e o fim reenviado não reescreve nada;
 *  7. a perdida, que nunca teve cartão aberto, continua sendo inserida no fim;
 *  8. o cartão que ficou em andamento com a ligação já encerrada é fechado pela
 *     passada, em cada organização — e o recém-encerrado fica para o fim normal.
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

const ORG = "c0de0295-0000-4000-8000-00000000000a";
const OUTRA = "c0de0295-0000-4000-8000-00000000000b";
const ANA = "c0de0295-1111-4000-8000-000000000001";
const BRUNO = "c0de0295-1111-4000-8000-000000000002";
/** Sem nome cadastrado: só o e-mail. */
const CAIO = "c0de0295-1111-4000-8000-000000000003";
const DANI = "c0de0295-1111-4000-8000-000000000004";
const SUPORTE = "c0de0295-2222-4000-8000-000000000001";
const FINANCEIRO = "c0de0295-2222-4000-8000-000000000002";
const TIME_OUTRA = "c0de0295-2222-4000-8000-000000000003";
const NUMERO = "c0de0295-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0295-5555-4000-8000-000000000002";

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-cartao@invariant.test', '{"full_name":"Ana do Cartão"}'),
       ($2, 'bruno-cartao@invariant.test', '{"full_name":"Bruno do Cartão"}'),
       ($3, 'caio-cartao@invariant.test', '{}'),
       ($4, 'dani-cartao@invariant.test', '{"full_name":"Dani do Cartão"}')
     on conflict (id) do nothing`,
    [ANA, BRUNO, CAIO, DANI],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'cartao-0295-a', 'Cartão 0295 A', 'Cartão A'), ($2, 'cartao-0295-b', 'Cartão 0295 B', 'Cartão B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $5, 'agent', now()), ($2, $5, 'agent', now()), ($3, $5, 'agent', now()), ($4, $6, 'agent', now())
     on conflict do nothing`,
    [ANA, BRUNO, CAIO, DANI, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug) values
       ($1, $4, 'Suporte', 'suporte-0295'), ($2, $4, 'Financeiro', 'financeiro-0295'),
       ($3, $5, 'Suporte B', 'suporte-0295')
     on conflict (id) do nothing`,
    [SUPORTE, FINANCEIRO, TIME_OUTRA, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Cartão A', '+556130000295',
        'voip.exemplo-0295.com.br', 5060, 'udp', 'u0295a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Cartão B', '+556130000296',
        'voip.exemplo-0296.com.br', 5060, 'udp', 'u0295b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

let contatos = 0;

/** Um contato novo de `org` (telefone único por chamada): cada caso tem a própria conversa. */
async function contato(org: string): Promise<string> {
  contatos += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.contacts (organization_id, name, phone_number, source)
     values ($1, $2, $3, 'phone_call') returning id`,
    [org, `Cliente do cartão ${contatos}`, `+55619777${String(contatos).padStart(5, "0")}`],
  );
  return rows[0]!.id;
}

/** Uma ligação recebida já ATENDIDA por `dono`, com conversa. Devolve os ids. */
async function ligacaoAtendida(p: {
  org: string; numero: string; contato: string; time: string | null; dono: string; statusDaConversa?: string;
}): Promise<{ vc: string; conversa: string }> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
     values ($1, $2, $3, 'phone', 'open', false, 0, $4)
     on conflict (organization_id, contact_id, channel_session_id) where is_group = false
       do update set updated_at = now()
     returning id`,
    [p.org, p.contato, p.numero, p.time],
  );
  const conversa = c[0]!.id;
  const vc = await repo.criarLigacao(pool, {
    organizationId: p.org, troncoId: p.numero, sipCallRef: `canal-${Math.random().toString(36).slice(2)}`,
    direcao: "inbound", numeroDoOutroLado: "+5561988887777", contactId: p.contato, conversationId: conversa,
    teamId: p.time, status: "ringing",
  });
  await repo.marcarAtendida(pool, p.org, vc, p.dono);
  return { vc, conversa };
}

/** A mensagem do registro da ligação `vc` (ou nenhuma). */
async function cartao(org: string, vc: string) {
  const { rows } = await pool.query<{ id: string; body: string; metadata: { voice_call: Record<string, unknown> } & Record<string, unknown>; sent_at: string | null }>(
    "select id, body, metadata, sent_at from public.messages where organization_id = $1 and external_id = $2",
    [org, `ligacao:${vc}`],
  );
  return rows;
}

describe("o cartão nasce quando a ligação é atendida", () => {
  it("cria a mensagem do registro em andamento, com quem atendeu, e a conversa sobe na lista", async () => {
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    const [m] = await cartao(ORG, vc);
    expect(m!.body).toBe("Ligação em andamento com Ana do Cartão");
    expect(m!.metadata.voice_call).toMatchObject({
      id: vc, direcao: "inbound", desfecho: "atendida", em_andamento: true, duracao_ms: null,
      atendente_id: ANA, atendente_nome: "Ana do Cartão",
    });
    const { rows } = await pool.query("select last_message_at, last_message_preview from public.conversations where id = $1", [conversa]);
    expect(rows[0].last_message_at).not.toBeNull();
    expect(rows[0].last_message_preview).toBe("Ligação em andamento com Ana do Cartão");
  });

  it("quem não tem nome cadastrado aparece pelo e-mail — nunca vazio", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: CAIO });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    expect((await cartao(ORG, vc))[0]!.metadata.voice_call.atendente_nome).toBe("caio-cartao@invariant.test");
  });

  it("chamada de novo não duplica; com outro dono (transferência), troca o nome e não mexe no time", async () => {
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    // Alguém mudou o setor da conversa pela tela no meio da ligação: a escolha fica.
    await pool.query("update public.conversations set team_id = $2 where id = $1", [conversa, FINANCEIRO]);
    await repo.passarLigacao(pool, ORG, vc, BRUNO);
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.metadata.voice_call).toMatchObject({ em_andamento: true, atendente_id: BRUNO, atendente_nome: "Bruno do Cartão" });
    expect(linhas[0]!.body).toBe("Ligação em andamento com Bruno do Cartão");
    const { rows } = await pool.query("select team_id from public.conversations where id = $1", [conversa]);
    expect(rows[0].team_id).toBe(FINANCEIRO);
  });

  it("abrir o cartão NÃO mexe no time da conversa — nem grava 'transferida para a fila do time' com a ligação já atendida", async () => {
    const c = await contato(ORG);
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: SUPORTE, dono: ANA });
    // A conversa de quem já ligou antes guarda o time do atendimento anterior.
    await pool.query("update public.conversations set team_id = $2 where id = $1", [conversa, FINANCEIRO]);
    const eventosDeTime = async () =>
      (await pool.query("select id from public.conversation_events where conversation_id = $1 and type = 'team_changed'", [conversa])).rows.length;
    const antes = await eventosDeTime();
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    const { rows } = await pool.query("select team_id from public.conversations where id = $1", [conversa]);
    expect(rows[0].team_id).toBe(FINANCEIRO);
    expect(await eventosDeTime()).toBe(antes);
  });

  it("nada a fazer: outra organização, ligação feita, ainda tocando, sem conversa", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    expect(await repo.abrirCartaoDaLigacao(pool, OUTRA, vc)).toBe(false);
    expect(await cartao(ORG, vc)).toHaveLength(0);
    expect(await cartao(OUTRA, vc)).toHaveLength(0);

    const tocando = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-tocando", direcao: "inbound",
      numeroDoOutroLado: "+5561988880001", contactId: await contato(ORG), conversationId: null, teamId: SUPORTE, status: "ringing",
    });
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, tocando)).toBe(false);

    // Atendida, mas sem conversa (número oculto): não há onde pôr o cartão.
    const semConversa = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-sem-conversa", direcao: "inbound",
      numeroDoOutroLado: "+5561988880003", contactId: null, conversationId: null, teamId: SUPORTE, status: "ringing",
    });
    await repo.marcarAtendida(pool, ORG, semConversa, ANA);
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, semConversa)).toBe(false);
    expect(await cartao(ORG, semConversa)).toHaveLength(0);

    // A FEITA atendida tem conversa e dono — e não ganha cartão em andamento: o dela é o do fim.
    const c = await contato(ORG);
    const conversaDaFeita = await repo.acharOuCriarConversa(pool, ORG, c, NUMERO, null);
    const feita = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-feita", direcao: "outbound",
      numeroDoOutroLado: "+5561988880004", contactId: c, conversationId: conversaDaFeita, teamId: null, status: "starting",
    });
    await repo.marcarAtendida(pool, ORG, feita, ANA);
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, feita)).toBe(false);
    expect(await cartao(ORG, feita)).toHaveLength(0);
  });
});

describe("quem já ligou antes: a conversa encerrada reabre com atendimento novo, e o cartão nasce dentro dele", () => {
  it("atribuir + abrir o cartão: dono é quem atendeu, protocolo novo, cartão depois do início do atendimento", async () => {
    const c = await contato(ORG);
    const { vc: antiga, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: FINANCEIRO, dono: BRUNO });
    await repo.atribuirConversa(pool, ORG, conversa, BRUNO);
    await repo.encerrarLigacao(pool, ORG, antiga, "cliente_desligou");
    await pool.query("update public.conversations set status = 'closed' where id = $1", [conversa]);
    const { rows: antes } = await pool.query<{ protocol: string }>("select protocol from public.conversations where id = $1", [conversa]);

    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: SUPORTE, dono: ANA });
    await repo.atribuirConversa(pool, ORG, conversa, ANA);
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);

    const { rows } = await pool.query<{ status: string; assigned_to_user_id: string; team_id: string; protocol: string; service_started_at: string }>(
      "select status, assigned_to_user_id, team_id, protocol, service_started_at from public.conversations where id = $1", [conversa]);
    // O time fica o do atendimento anterior (ver "abrir o cartão NÃO mexe no time").
    expect(rows[0]).toMatchObject({ status: "claimed", assigned_to_user_id: ANA, team_id: FINANCEIRO });
    expect(rows[0]!.protocol).not.toBe(antes[0]!.protocol);
    const { rows: abertos } = await pool.query("select id from public.atendimentos where conversation_id = $1 and closed_at is null", [conversa]);
    expect(abertos).toHaveLength(1);
    const [m] = await cartao(ORG, vc);
    expect(new Date(m!.sent_at!).getTime()).toBeGreaterThanOrEqual(new Date(rows[0]!.service_started_at).getTime());
  });
});

describe("o fim completa o MESMO cartão", () => {
  it("atendida: uma mensagem só, sem a marca de andamento, com a duração; e o que outro escritor gravou continua", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    // Outro escritor (reações, gravação) mexeu no metadado no meio da ligação.
    await pool.query(
      `update public.messages set metadata = jsonb_set(metadata || '{"outra_chave":1}'::jsonb, '{voice_call,de_outro}', '"fica"')
        where organization_id = $1 and external_id = $2`, [ORG, `ligacao:${vc}`]);
    const l = await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.registrarNaConversa(pool, l!, "atendida", 65_000);

    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    const v = linhas[0]!.metadata.voice_call;
    expect(v).toMatchObject({ desfecho: "atendida", duracao_ms: 65_000, atendente_nome: "Ana do Cartão", motivo: "cliente_desligou", de_outro: "fica" });
    expect("em_andamento" in v).toBe(false);
    expect(linhas[0]!.metadata.outra_chave).toBe(1);
    expect(linhas[0]!.body).toBe("Ligação recebida, atendida por Ana do Cartão · 1 min 05 s");
  });

  it("gravada: o fim marca a gravação como em processamento — e NÃO pisa a que o processamento já guardou", async () => {
    const gravada = async () => {
      const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
      await repo.abrirCartaoDaLigacao(pool, ORG, vc);
      await pool.query(
        "update public.voice_calls set recording_status = 'recording', recording_notice_at = now() where id = $1",
        [vc],
      );
      return vc;
    };
    // O caso comum: o cartão ainda não tem gravação, e o fim a põe "processando".
    const comum = await gravada();
    const l1 = await repo.encerrarLigacao(pool, ORG, comum, "cliente_desligou");
    await repo.registrarNaConversa(pool, l1!, "atendida", 9_000);
    expect((await cartao(ORG, comum))[0]!.metadata.voice_call.gravacao).toEqual({ situacao: "processando", duracao_ms: null });

    // A corrida: a passada das gravações (fora da fila serial) guarda o arquivo
    // ENTRE o fechamento da ligação e a escrita do cartão.
    const corrida = await gravada();
    const l2 = await repo.encerrarLigacao(pool, ORG, corrida, "cliente_desligou");
    await pool.query(
      `update public.messages
          set metadata = jsonb_set(metadata, '{voice_call,gravacao}', '{"situacao":"pronta","duracao_ms":9000}'::jsonb)
        where organization_id = $1 and external_id = $2`,
      [ORG, `ligacao:${corrida}`],
    );
    await repo.registrarNaConversa(pool, l2!, "atendida", 9_000);
    const v = (await cartao(ORG, corrida))[0]!.metadata.voice_call;
    expect(v.gravacao).toEqual({ situacao: "pronta", duracao_ms: 9000 });
    expect("em_andamento" in v).toBe(false);
    expect(v.duracao_ms).toBe(9_000);
  });

  it("o fim reenviado não muda nada (o cartão fechado não é reescrito)", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    const l = await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.registrarNaConversa(pool, l!, "atendida", 65_000);
    await repo.registrarNaConversa(pool, l!, "atendida", 999_000);
    expect((await cartao(ORG, vc))[0]!.metadata.voice_call.duracao_ms).toBe(65_000);
    // E abrir depois do fim não ressuscita o andamento.
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(false);
    expect("em_andamento" in (await cartao(ORG, vc))[0]!.metadata.voice_call).toBe(false);
  });

  it("a perdida (sem cartão aberto) continua sendo INSERIDA no fim, como sempre", async () => {
    const c = await contato(ORG);
    const { rows: conv } = await pool.query<{ id: string }>(
      `insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4) returning id`, [ORG, c, NUMERO, SUPORTE]);
    const vc = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-perdida", direcao: "inbound",
      numeroDoOutroLado: "+5561988880002", contactId: c, conversationId: conv[0]!.id, teamId: SUPORTE, status: "ringing",
    });
    const l = await repo.encerrarLigacao(pool, ORG, vc, "ninguem_atendeu");
    await repo.registrarNaConversa(pool, l!, "perdida", null);
    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.metadata.voice_call).toMatchObject({ desfecho: "perdida" });
    expect(linhas[0]!.body).toBe("Ligação recebida não atendida");
  });
});

describe("o cartão que ficou em andamento com a ligação já encerrada é fechado pela passada", () => {
  it("fecha o órfão de mais de um minuto, em cada organização; o recém-encerrado fica para o fim normal", async () => {
    const a = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    const b = await ligacaoAtendida({ org: OUTRA, numero: NUMERO_OUTRA, contato: await contato(OUTRA), time: TIME_OUTRA, dono: DANI });
    const recente = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    for (const x of [a, recente]) await repo.abrirCartaoDaLigacao(pool, ORG, x.vc);
    await repo.abrirCartaoDaLigacao(pool, OUTRA, b.vc);
    // A ligação fechou no banco e a escrita do cartão falhou.
    await pool.query(
      `update public.voice_calls set status = 'ended', end_reason = 'cliente_desligou',
              answered_at = now() - interval '5 minutes', ended_at = now() - interval '2 minutes'
        where id = any($1::uuid[])`, [[a.vc, b.vc]]);
    await pool.query(
      `update public.voice_calls set status = 'ended', end_reason = 'cliente_desligou',
              answered_at = now() - interval '40 seconds', ended_at = now() - interval '10 seconds'
        where id = $1`, [recente.vc]);

    expect(await repo.consertarCartoesOrfaos(pool)).toBe(2);
    const va = (await cartao(ORG, a.vc))[0]!.metadata.voice_call;
    expect("em_andamento" in va).toBe(false);
    expect(va).toMatchObject({ desfecho: "atendida", duracao_ms: 180_000, atendente_nome: "Ana do Cartão" });
    expect("em_andamento" in (await cartao(OUTRA, b.vc))[0]!.metadata.voice_call).toBe(false);
    expect((await cartao(ORG, recente.vc))[0]!.metadata.voice_call.em_andamento).toBe(true);
    // Segunda passada: nada a fazer.
    expect(await repo.consertarCartoesOrfaos(pool)).toBe(0);
  });
});
