import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * CADA ATENDIMENTO TEM UM PROTOCOLO, E A CONVERSA TEM LINHA DO TEMPO (migration 0266).
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. A conversa nasce com protocolo, pela MESMA porta da ingestão
 *    (`fn_upsert_wa_conversation`) — e o upsert repetido, que é o que cada
 *    mensagem seguinte faz, NÃO queima número. É a razão de o protocolo nascer no
 *    AFTER e não num BEFORE INSERT, e só se mede contando o contador.
 * 2. Fechar guarda QUEM fechou, mesmo passando pelo service role (o autor chega
 *    por GUC local à transação).
 * 3. O cliente escreve de novo → atendimento NOVO, protocolo NOVO; o anterior
 *    fica fechado, com o número dele. Medido pelo INSERT de mensagem inbound,
 *    que é o caminho real (`fn_service_inbound`), não por um `update` de status.
 * 4. "Reabrir" do atendente CONTINUA o mesmo atendimento: protocolo não muda.
 * 5. A linha do tempo registra o que aconteceu, com autor — inclusive o
 *    encaminhamento para time, que antes não deixava rastro em tela nenhuma.
 * 6. Isolamento: o vizinho lê ZERO linhas das duas tabelas; o contador não é
 *    legível por ninguém pela REST; ninguém escreve nas três pela REST.
 *
 * ═══ Por que arquivo próprio ═══
 *
 * A garantia é comportamento (trigger + RPC), não só leitura isolada — o molde
 * de `TABLES` em `rls-isolation.test.ts` mediria a catraca de fora e creditaria
 * a pilha inteira. As três tabelas entram em `PROVA_PROPRIA` de
 * `rls-completude-varredura.test.ts` citando este arquivo.
 *
 * Todo caso que escreve depois do seed roda em `begin … rollback`, para o
 * veredito não depender da ordem em que o vitest resolveu rodar os casos.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** `-q` tira o COMMAND TAG (`BEGIN`/`ROLLBACK`) do stdout — ver o molde em `times-nao-vazam…`. */
function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-q", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function erroAoRodar(script: string): string {
  try {
    sql(script);
    return "";
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return String(e.stderr ?? e.message ?? err);
  }
}

const linhas = (out: string) => out.split("\n").filter((l) => l.startsWith("@@")).map((l) => l.slice(2));

const ORG_A = "a2660000-0000-4000-8000-0000000000a1";
const ORG_B = "a2660000-0000-4000-8000-0000000000b1";
const ANA = "a2660000-0000-4000-8000-0000000000a2"; // agent de A
const BIA = "a2660000-0000-4000-8000-0000000000a3"; // manager de A
const BETO = "a2660000-0000-4000-8000-0000000000b2"; // agent de B
const SESSAO_A = "a2660000-0000-4000-8000-0000000000a4";
const SESSAO_B = "a2660000-0000-4000-8000-0000000000b4";
const CONTATO_A = "a2660000-0000-4000-8000-0000000000a5";
const CONTATO_A2 = "a2660000-0000-4000-8000-0000000000a6";
const CONTATO_B = "a2660000-0000-4000-8000-0000000000b5";
const TIME_A = "a2660000-0000-4000-8000-0000000000a7";

const jwt = (user: string) =>
  `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}"}', false);`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}',  'ana-0266@invariant.test',  '{"full_name":"Ana Atendente"}'),
      ('${BIA}',  'bia-0266@invariant.test',  '{"full_name":"Bia Gestora"}'),
      ('${BETO}', 'beto-0266@invariant.test', '{"full_name":"Beto Vizinho"}')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0266-a', 'Org A 0266', 'Org A 0266'),
      ('${ORG_B}', 'inv-0266-b', 'Org B 0266', 'Org B 0266')
      on conflict (id) do nothing;
    -- 'all': o que se mede aqui é o isolamento entre ORGANIZAÇÕES; o escopo por
    -- dono dentro da org é herdado da policy de conversations e tem teste próprio.
    update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"all"}'::jsonb
     where id in ('${ORG_A}', '${ORG_B}');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}',  '${ORG_A}', 'agent',   now()),
      ('${BIA}',  '${ORG_A}', 'manager', now()),
      ('${BETO}', '${ORG_B}', 'agent',   now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status) values
      ('${SESSAO_A}', '${ORG_A}', 'inv-0266-a', '\\x00'::bytea, 'WORKING'),
      ('${SESSAO_B}', '${ORG_B}', 'inv-0266-b', '\\x00'::bytea, 'WORKING')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTATO_A}',  '${ORG_A}', 'Cliente A',  '+5561900002661'),
      ('${CONTATO_A2}', '${ORG_A}', 'Cliente A2', '+5561900002662'),
      ('${CONTATO_B}',  '${ORG_B}', 'Cliente B',  '+5561900002663')
      on conflict (id) do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A}', '${ORG_A}', 'Cobrança', 'cobranca')
      on conflict (id) do nothing;
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A}');
    select public.fn_upsert_wa_conversation('${ORG_B}', '${CONTATO_B}', '${SESSAO_B}');
  `);
});

const conversaDe = (org: string, contato: string) =>
  sql(`select id from public.conversations where organization_id='${org}' and contact_id='${contato}';`);

describe("o protocolo nasce com a conversa", () => {
  it("formato AAAAMMDD + 6 dígitos, e espelhado no atendimento aberto", () => {
    const [conv, at] = linhas(
      sql(`
        select '@@' || protocol from public.conversations where organization_id='${ORG_A}' and contact_id='${CONTATO_A}';
        select '@@' || a.protocol || '|' || (a.closed_at is null) from public.atendimentos a
          join public.conversations c on c.id = a.conversation_id
         where c.organization_id='${ORG_A}' and c.contact_id='${CONTATO_A}';
      `),
    );
    expect(conv).toMatch(/^\d{8}\d{6}$/);
    expect(at).toBe(`${conv}|true`);
  });

  it("o upsert repetido da ingestão NÃO queima número do contador", () => {
    const out = linhas(
      sql(`
        begin;
        select '@@' || coalesce(sum(ultimo), 0) from public.atendimento_protocol_counters where organization_id='${ORG_A}';
        select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A}');
        select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A}');
        select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A}');
        select '@@' || coalesce(sum(ultimo), 0) from public.atendimento_protocol_counters where organization_id='${ORG_A}';
        rollback;
      `),
    );
    expect(out[1]).toBe(out[0]);
  });

  it("duas organizações têm sequências independentes", () => {
    const out = linhas(
      sql(`
        select '@@' || count(*) from public.atendimento_protocol_counters where organization_id='${ORG_A}';
        select '@@' || count(*) from public.atendimento_protocol_counters where organization_id='${ORG_B}';
      `),
    );
    expect(Number(out[0])).toBeGreaterThan(0);
    expect(Number(out[1])).toBeGreaterThan(0);
  });

  it("fuso inválido na organização não impede a conversa de nascer", () => {
    const out = linhas(
      sql(`
        begin;
        update public.organizations set timezone = 'America/Asunción' where id='${ORG_A}';
        select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A2}', '${SESSAO_A}');
        select '@@' || coalesce(protocol, 'NULO') from public.conversations where organization_id='${ORG_A}' and contact_id='${CONTATO_A2}';
        rollback;
      `),
    );
    expect(out[0]).toMatch(/^\d{14}$/);
  });
});

describe("o ciclo: fechar, o cliente voltar, reabrir", () => {
  it("fechar guarda quem fechou; o cliente voltar abre protocolo NOVO; reabrir mantém", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        select '@@' || protocol from public.conversations where id='${conv}';
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        select '@@' || closed_status || '|' || coalesce(closed_by_name, 'NULO') from public.atendimentos where conversation_id='${conv}';

        insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
        values ('${ORG_A}', '${conv}', '${SESSAO_A}', '${CONTATO_A}', 'text', 'inbound', 'received', 'ai', 'voltei', clock_timestamp());
        select '@@' || status || '|' || protocol from public.conversations where id='${conv}';
        select '@@' || count(*) || '|' || count(*) filter (where closed_at is null) from public.atendimentos where conversation_id='${conv}';

        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${BIA}', false)).id;
        select '@@' || (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${BIA}', true)).protocol;
        select '@@' || count(*) || '|' || count(*) filter (where closed_at is null) from public.atendimentos where conversation_id='${conv}';
        rollback;
      `),
    );
    const [primeiro, fechado, reaberta, contagem, retomado, contagemFinal] = out;
    expect(fechado).toBe("closed|Ana Atendente");
    const [status, segundo] = (reaberta ?? "").split("|");
    expect(status).toBe("open");
    expect(segundo).toMatch(/^\d{14}$/);
    expect(segundo).not.toBe(primeiro);
    expect(contagem).toBe("2|1");
    // Reabrir CONTINUA o segundo: mesmo número, nenhuma linha nova.
    expect(retomado).toBe(segundo);
    expect(contagemFinal).toBe("2|1");
  });

  it("a linha do tempo conta a história, com autor — inclusive o time", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${jwt(BIA)}
        select public.fn_conversation_set_team('${ORG_A}', '${conv}', '${TIME_A}');
        reset role;
        ${jwt(ANA)}
        select count(*) from public.fn_conversation_assign('${ORG_A}', '${conv}', '${ANA}', 'claim', null, false);
        reset role;
        select set_config('request.jwt.claims', '', false);
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        select '@@' || type || '|' || actor_kind || '|' || coalesce(actor_name, '-') || '|' || coalesce(payload->>'to_team_name', payload->>'to_user_name', payload->>'status', '')
          from public.conversation_events where conversation_id='${conv}' order by created_at, type;
        rollback;
      `),
    );
    expect(out).toContain("team_changed|user|Bia Gestora|Cobrança");
    expect(out).toContain("assigned|user|Ana Atendente|Ana Atendente");
    expect(out).toContain("closed|user|Ana Atendente|closed");
    // Assumir cala o automático na MESMA instrução: o evento é "assumiu", não dois.
    expect(out.filter((l) => l.startsWith("ai_paused"))).toEqual([]);
  });
});

describe("o atendimento novo começa do zero (migration 0269)", () => {
  const SESSAO_A2 = "a2660000-0000-4000-8000-0000000000a8";

  /** A conversa no estado em que uma passagem para humano a deixa: time, IA calada, contato travado. */
  const comPassagemParaOFinanceiro = (conv: string) => `
    update public.conversations set team_id='${TIME_A}', bot_silenced_until='infinity',
           last_handoff_at=clock_timestamp(), last_handoff_reason='pediu boleto'
     where id='${conv}';
    update public.contacts set force_human=true where id='${CONTATO_A}';
  `;
  const clienteVolta = (conv: string, corpo: string) => `
    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
    values ('${ORG_A}', '${conv}', '${SESSAO_A}', '${CONTATO_A}', 'text', 'inbound', 'received', 'ai', '${corpo}', clock_timestamp());
  `;
  const estado = (conv: string) => `
    select '@@' || status || '|' || coalesce(team_id::text, 'SEM_TIME') || '|' || coalesce(bot_silenced_until::text, 'IA_LIGADA') || '|' || coalesce(last_handoff_at::text, 'SEM_PASSAGEM')
      from public.conversations where id='${conv}';
    select '@@' || force_human from public.contacts where id='${CONTATO_A}';
  `;

  it("⭐ financeiro na segunda, suporte na quarta: a volta do cliente zera time, silêncio da IA e a trava do contato", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${comPassagemParaOFinanceiro(conv)}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        -- CONTROLE: fechado, o estado da passagem ainda está lá (é o defeito que se media).
        ${estado(conv)}
        ${clienteVolta(conv, "agora é suporte")}
        ${estado(conv)}
        rollback;
      `),
    );
    const [fechada, travadoAntes, reaberta, travadoDepois] = out;
    expect(fechada).toMatch(new RegExp(`^closed\\|${TIME_A}\\|infinity\\|`));
    expect(travadoAntes).toBe("true");
    expect(reaberta).toBe("open|SEM_TIME|IA_LIGADA|SEM_PASSAGEM");
    expect(travadoDepois).toBe("false");
  });

  it("avisa o follow-up que a passagem acabou — e só quando havia passagem", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const contar = `select '@@' || count(*) from public.event_log where organization_id='${ORG_A}' and event_type='ai.handoff_resolved' and entity_id='${conv}';`;
    const out = linhas(
      sql(`
        begin;
        ${comPassagemParaOFinanceiro(conv)}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        ${clienteVolta(conv, "voltei")}
        ${contar}
        -- Segundo ciclo, SEM passagem: fecha e o cliente volta. Nenhum sinal novo.
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        ${clienteVolta(conv, "voltei de novo")}
        ${contar}
        rollback;
      `),
    );
    expect(out).toEqual(["1", "1"]);
  });

  it("CONTROLE: 'Reabrir' pelo atendente CONTINUA o atendimento — time e silêncio ficam", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${comPassagemParaOFinanceiro(conv)}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${ANA}', true)).id;
        ${estado(conv)}
        rollback;
      `),
    );
    expect(out[0]).toMatch(new RegExp(`^open\\|${TIME_A}\\|infinity\\|`));
    expect(out[1]).toBe("true");
  });

  it("outra conversa do MESMO cliente com passagem em aberto: a trava do contato NÃO é solta", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
          values ('${SESSAO_A2}', '${ORG_A}', 'inv-0269-a2', '\\x00'::bytea, 'WORKING');
        select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A2}') as outra \\gset
        update public.conversations set last_handoff_at=clock_timestamp(), bot_silenced_until='infinity' where id=:'outra';
        ${comPassagemParaOFinanceiro(conv)}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        ${clienteVolta(conv, "voltei pelo primeiro número")}
        select '@@' || force_human from public.contacts where id='${CONTATO_A}';
        -- A conversa que voltou começa limpa de qualquer jeito; a OUTRA segue calada.
        select '@@' || coalesce(team_id::text, 'SEM_TIME') from public.conversations where id='${conv}';
        select '@@' || coalesce(bot_silenced_until::text, 'IA_LIGADA') from public.conversations where id=:'outra';
        rollback;
      `),
    );
    expect(out).toEqual(["true", "SEM_TIME", "infinity"]);
  });

  it("a linha do tempo conta a volta como UM fato: nem 'fila geral' nem 'automático voltou'", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${comPassagemParaOFinanceiro(conv)}
        delete from public.conversation_events where conversation_id='${conv}';
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        ${clienteVolta(conv, "voltei")}
        select '@@' || type || coalesce('|' || (payload->>'retorno'), '') from public.conversation_events where conversation_id='${conv}' order by created_at, type;
        rollback;
      `),
    );
    expect(out).toEqual(["closed", "opened|true"]);
  });
});

describe("o legado ganha as duas linhas que o banco observou (migration 0268)", () => {
  // O bloco é EXTRAÍDO do baseline — o que o `update.sh` do self-hoster aplica —,
  // e não reescrito aqui: copiar o SQL para dentro do teste mediria a cópia.
  const baseline = readFileSync("supabase/baseline.sql", "utf8");
  const inicio = baseline.indexOf("-- ---- a linha do tempo das conversas que já existiam (migration 0268) ----");
  const bloco = baseline.slice(inicio, baseline.indexOf("-- ---- VARREDURA anon:", inicio));

  it("o instrumento acha o bloco (guarda de vacuidade)", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(bloco).toContain("insert into public.conversation_events");
  });

  it("atendimento SEM evento (o estado de quem atualizou) ganha 'opened' e 'closed' com o carimbo ORIGINAL", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        -- Reproduz o legado: atendimento fechado no passado, e nenhuma linha do tempo.
        update public.atendimentos set started_at = '2026-03-10 20:40:00+00', closed_at = '2026-03-10 21:15:00+00', closed_status = 'closed'
         where conversation_id='${conv}';
        delete from public.conversation_events where conversation_id='${conv}';
        ${bloco}
        select '@@' || type || '|' || actor_kind || '|' || (payload->>'backfill') || '|' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
          from public.conversation_events where conversation_id='${conv}' order by created_at;
        -- Idempotente: a segunda aplicação não duplica.
        ${bloco}
        select '@@' || count(*) from public.conversation_events where conversation_id='${conv}';
        rollback;
      `),
    );
    expect(out).toEqual([
      "opened|system|true|2026-03-10 20:40",
      "closed|system|true|2026-03-10 21:15",
      "2",
    ]);
  });

  it("atendimento que JÁ tem o 'opened' do trigger não ganha um segundo", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${bloco}
        select '@@' || count(*) filter (where type='opened') from public.conversation_events where conversation_id='${conv}';
        rollback;
      `),
    );
    expect(out).toEqual(["1"]);
  });
});

describe("isolamento entre organizações e o portão de escrita", () => {
  it("controle positivo: quem é da organização lê o atendimento e os eventos dela", () => {
    const out = linhas(
      sql(`
        ${jwt(ANA)}
        select '@@' || count(*) from public.atendimentos where organization_id='${ORG_A}';
        select '@@' || count(*) from public.conversation_events where organization_id='${ORG_A}';
      `),
    );
    expect(Number(out[0])).toBeGreaterThan(0);
    expect(Number(out[1])).toBeGreaterThan(0);
  });

  it("o vizinho lê ZERO, nos dois sentidos", () => {
    const out = linhas(
      sql(`
        ${jwt(BETO)}
        select '@@' || count(*) from public.atendimentos where organization_id='${ORG_A}';
        select '@@' || count(*) from public.conversation_events where organization_id='${ORG_A}';
        reset role;
        ${jwt(ANA)}
        select '@@' || count(*) from public.atendimentos where organization_id='${ORG_B}';
        select '@@' || count(*) from public.conversation_events where organization_id='${ORG_B}';
      `),
    );
    expect(out).toEqual(["0", "0", "0", "0"]);
  });

  it.each(["anon", "authenticated", "service_role"])("%s não escreve nas tabelas pela REST", (papel) => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    for (const dml of [
      `insert into public.atendimentos (organization_id, conversation_id, protocol) values ('${ORG_A}', '${conv}', '99999999000001')`,
      `update public.atendimentos set protocol = '1' where organization_id='${ORG_A}'`,
      `delete from public.conversation_events where organization_id='${ORG_A}'`,
      `insert into public.conversation_events (organization_id, conversation_id, type) values ('${ORG_A}', '${conv}', 'forjado')`,
    ]) {
      expect(erroAoRodar(`begin; set role ${papel}; ${dml}; rollback;`)).toMatch(/permission denied/);
    }
  });

  it.each(["anon", "authenticated", "service_role"])("%s não lê nem escreve o contador", (papel) => {
    expect(erroAoRodar(`set role ${papel}; select count(*) from public.atendimento_protocol_counters;`)).toMatch(
      /permission denied/,
    );
  });

  it("as funções não são executáveis por anon nem authenticated", () => {
    const out = linhas(
      sql(`
        select '@@' || p.proname || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname in
           ('fn_proximo_protocolo','fn_conversation_event_add','fn_atendimento_acompanha_conversa','fn_service_status_com_ator')
         order by 1;
      `),
    );
    expect(out).toHaveLength(4);
    for (const l of out) expect(l).toMatch(/\|false\|false$/);
  });

  it("evento de aplicação recusa conversa de outra organização", () => {
    const convB = conversaDe(ORG_B, CONTATO_B);
    expect(
      erroAoRodar(`begin; select public.fn_conversation_event_add('${ORG_A}', '${convB}', 'survey_sent', null, '{}'::jsonb); rollback;`),
    ).toMatch(/conversation_not_found/);
  });
});

describe("quem encerra aparece pelo nome, mesmo sem nome cadastrado (migration 0270)", () => {
  /**
   * O usuário que o gate NÃO tinha: sem `full_name`. Em produção (2026-09-19) os
   * dois usuários da instalação eram assim — cadastro com `email_verified` e
   * `locale`, nada mais —, e todo encerramento saía sem autor. Os três usuários
   * de cima têm `full_name`, então a suíte só media o caminho feliz.
   */
  const CAIO = "a2660000-0000-4000-8000-0000000000a9";
  const prepara = `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${CAIO}', 'caio.semnome@invariant.test', '{"email_verified":true,"locale":"pt-BR"}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${CAIO}', '${ORG_A}', 'agent', now()) on conflict do nothing;
  `;

  it("⭐ usuário SEM full_name encerra: o atendimento e a linha do tempo dizem quem foi", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${prepara}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${CAIO}', false)).id;
        select '@@' || coalesce(a.closed_by_name, 'SEM_NOME') from public.atendimentos a
         where a.conversation_id='${conv}' order by a.closed_at desc nulls last limit 1;
        select '@@' || coalesce(e.actor_name, 'SEM_NOME') from public.conversation_events e
         where e.conversation_id='${conv}' and e.type='closed' order by e.created_at desc limit 1;
        rollback;
      `),
    );
    expect(out).toEqual(["caio.semnome", "caio.semnome"]);
  });

  it("CONTROLE: quem TEM nome cadastrado segue aparecendo pelo nome, não pelo e-mail", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${ANA}', false)).id;
        select '@@' || coalesce(a.closed_by_name, 'SEM_NOME') from public.atendimentos a
         where a.conversation_id='${conv}' order by a.closed_at desc nulls last limit 1;
        rollback;
      `),
    );
    expect(out).toEqual(["Ana Atendente"]);
  });

  it("assumir sem nome cadastrado: o payload de 'assumida' leva o nome, e o atendimento guarda quem atendia", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${prepara}
        update public.conversations set assigned_to_user_id='${CAIO}', assigned_to_user_name=null, status='claimed'
         where id='${conv}';
        select '@@' || coalesce(e.payload->>'to_user_name', 'SEM_NOME') from public.conversation_events e
         where e.conversation_id='${conv}' and e.type='assigned' order by e.created_at desc limit 1;
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${CAIO}', false)).id;
        select '@@' || coalesce(a.assigned_to_user_name, 'SEM_NOME') from public.atendimentos a
         where a.conversation_id='${conv}' order by a.closed_at desc nulls last limit 1;
        rollback;
      `),
    );
    expect(out).toEqual(["caio.semnome", "caio.semnome"]);
  });

  it("o backfill preenche o que já foi gravado em branco — e reaplicar não muda nada", () => {
    // O bloco é LIDO da migration, não reescrito aqui: teste com SQL próprio
    // provaria o SQL do teste.
    const migration = readFileSync(
      "supabase/migrations/20260919110000_0270_quem_encerra_aparece_pelo_nome.sql",
      "utf8",
    );
    const backfill = migration.slice(
      migration.indexOf("-- O que já foi gravado em branco."),
      migration.indexOf("notify pgrst"),
    );
    expect(backfill).toContain("update public.conversation_events");

    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${prepara}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'closed', null, '${CAIO}', false)).id;
        -- O estado que a 0266 deixou em produção: o id de quem fez, e o nome em branco.
        update public.conversation_events set actor_name=null where conversation_id='${conv}' and actor_user_id='${CAIO}';
        update public.atendimentos set closed_by_name=null where conversation_id='${conv}' and closed_by_user_id='${CAIO}';
        -- CONTROLE: um nome que JÁ existe não pode ser sobrescrito pelo backfill.
        update public.conversation_events set actor_name='Nome Que Já Estava'
         where id = (select id from public.conversation_events where conversation_id='${conv}' and type='opened' order by created_at limit 1);
        ${backfill}
        select '@@' || coalesce(a.closed_by_name, 'SEM_NOME') from public.atendimentos a
         where a.conversation_id='${conv}' and a.closed_by_user_id='${CAIO}' limit 1;
        select '@@' || count(*) from public.conversation_events
         where conversation_id='${conv}' and actor_user_id='${CAIO}' and actor_name is null;
        select '@@' || count(*) from public.conversation_events where conversation_id='${conv}' and actor_name='Nome Que Já Estava';
        -- Idempotência: a segunda passada não acha nada para mudar.
        ${backfill}
        select '@@' || coalesce(a.closed_by_name, 'SEM_NOME') from public.atendimentos a
         where a.conversation_id='${conv}' and a.closed_by_user_id='${CAIO}' limit 1;
        rollback;
      `),
    );
    expect(out).toEqual(["caio.semnome", "0", "1", "caio.semnome"]);
  });

  it("a régua de nome não é executável por anon nem authenticated", () => {
    const out = linhas(
      sql(`
        select '@@' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='fn_nome_do_usuario';
      `),
    );
    expect(out).toEqual(["false|false"]);
  });
});
