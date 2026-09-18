import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * PAUSA COM MOTIVO, TETO POR TIME E A FILA QUE ACORDA (migration 0267).
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. Pausar exige motivo, registra o histórico e tira a pessoa do rodízio — e
 *    VOLTAR, por qualquer caminho, encerra a pausa. O caso que já quebrou: quem
 *    volta pelo PATCH da tela de Equipe escreve `is_available`, não `paused_at`;
 *    com `update of paused_at` no trigger, a pausa ficava aberta para sempre.
 * 2. O atendente só muda o PRÓPRIO status; o gestor muda o de qualquer um.
 * 3. O claim do rodízio recusa quem está em pausa, e recusa quem está no TETO do
 *    time — dentro da transação, não só no TypeScript.
 * 4. Fechar uma conversa que tinha dono ADIANTA quem esperava na fila, sem criar
 *    evento novo para quem não esperava (o defeito de inflar `event_log`).
 * 5. O histórico de pausas não vaza: a pessoa lê o seu, o gestor lê o da equipe,
 *    o colega e o vizinho leem zero; ninguém escreve pela REST.
 *
 * Todo caso que escreve depois do seed roda em `begin … rollback`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

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

const ORG_A = "a2670000-0000-4000-8000-0000000000a1";
const ORG_B = "a2670000-0000-4000-8000-0000000000b1";
const ANA = "a2670000-0000-4000-8000-0000000000a2"; // agent de A
const CAIO = "a2670000-0000-4000-8000-0000000000a3"; // agent de A (o colega)
const BIA = "a2670000-0000-4000-8000-0000000000a4"; // manager de A
const BETO = "a2670000-0000-4000-8000-0000000000b2"; // agent de B
const SESSAO = "a2670000-0000-4000-8000-0000000000a5";
const TIME = "a2670000-0000-4000-8000-0000000000a6";
const CONTATO_1 = "a2670000-0000-4000-8000-0000000000c1";
const CONTATO_2 = "a2670000-0000-4000-8000-0000000000c2";

const jwt = (user: string) =>
  `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}"}', false);`;
const semJwt = `reset role; select set_config('request.jwt.claims', '', false);`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}',  'ana-0267@invariant.test',  '{"full_name":"Ana"}'),
      ('${CAIO}', 'caio-0267@invariant.test', '{"full_name":"Caio"}'),
      ('${BIA}',  'bia-0267@invariant.test',  '{"full_name":"Bia"}'),
      ('${BETO}', 'beto-0267@invariant.test', '{"full_name":"Beto"}')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0267-a', 'Org A 0267', 'Org A 0267'),
      ('${ORG_B}', 'inv-0267-b', 'Org B 0267', 'Org B 0267')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}',  '${ORG_A}', 'agent',   now()),
      ('${CAIO}', '${ORG_A}', 'agent',   now()),
      ('${BIA}',  '${ORG_A}', 'manager', now()),
      ('${BETO}', '${ORG_B}', 'agent',   now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status) values
      ('${SESSAO}', '${ORG_A}', 'inv-0267-a', '\\x00'::bytea, 'WORKING') on conflict (id) do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug, max_concurrent) values
      ('${TIME}', '${ORG_A}', 'Suporte', 'suporte', 1) on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTATO_1}', '${ORG_A}', 'Cliente 1', '+5561900002671'),
      ('${CONTATO_2}', '${ORG_A}', 'Cliente 2', '+5561900002672')
      on conflict (id) do nothing;
  `);
});

describe("pausar, e voltar por qualquer caminho", () => {
  it("pausa registra motivo e observação; a linha de disponibilidade fica indisponível", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(ANA)}
        select public.fn_attendant_set_status('${ORG_A}', 'online');
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'almoco', 'volto 13h');
        ${semJwt}
        select '@@' || is_available || '|' || pause_reason || '|' || (paused_at is not null) from public.attendant_availability where user_id='${ANA}';
        select '@@' || reason || '|' || note || '|' || (ended_at is null) from public.attendant_pause_log where user_id='${ANA}';
        rollback;
      `),
    );
    expect(out).toEqual(["false|almoco|true", "almoco|volto 13h|true"]);
  });

  it("pausa SEM motivo é recusada pelo banco", () => {
    expect(
      erroAoRodar(`begin; ${jwt(ANA)} select public.fn_attendant_set_status('${ORG_A}', 'paused'); rollback;`),
    ).toMatch(/attendant_pause_reason_required/);
  });

  it("voltar pela RPC encerra a pausa, e diz que foi a própria pessoa", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(ANA)}
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'banheiro');
        select public.fn_attendant_set_status('${ORG_A}', 'online');
        ${semJwt}
        select '@@' || (ended_at is not null) || '|' || coalesce(ended_by, 'NULO') from public.attendant_pause_log where user_id='${ANA}';
        select '@@' || is_available || '|' || (paused_at is null) from public.attendant_availability where user_id='${ANA}';
        rollback;
      `),
    );
    expect(out).toEqual(["true|self", "true|true"]);
  });

  it("⭐ voltar pelo UPDATE direto (o PATCH da tela de Equipe) TAMBÉM encerra a pausa", () => {
    // Quem escreve ali é `is_available`; `paused_at` é zerado pelo trigger BEFORE.
    // Com `after update OF paused_at`, o trigger de registro nunca disparava.
    const out = linhas(
      sql(`
        begin;
        ${jwt(ANA)}
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'reuniao');
        update public.attendant_availability set is_available = true where organization_id='${ORG_A}' and user_id='${ANA}';
        ${semJwt}
        select '@@' || (ended_at is not null) from public.attendant_pause_log where user_id='${ANA}';
        select '@@' || (paused_at is null) || '|' || (pause_reason is null) from public.attendant_availability where user_id='${ANA}';
        rollback;
      `),
    );
    expect(out).toEqual(["true", "true|true"]);
  });

  it("trocar o motivo fecha a pausa anterior e abre outra — nunca duas abertas", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(ANA)}
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'banheiro');
        select pg_sleep(0.01);
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'almoco');
        ${semJwt}
        select '@@' || count(*) || '|' || count(*) filter (where ended_at is null) from public.attendant_pause_log where user_id='${ANA}';
        rollback;
      `),
    );
    expect(out).toEqual(["2|1"]);
  });
});

describe("quem muda o status de quem", () => {
  it("o atendente NÃO muda o status do colega", () => {
    expect(
      erroAoRodar(`begin; ${jwt(ANA)} select public.fn_attendant_set_status('${ORG_A}', 'offline', null, null, '${CAIO}'); rollback;`),
    ).toMatch(/attendant_forbidden/);
  });

  it("o gestor muda — e o encerramento da pausa diz que foi o gestor", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(ANA)}
        select public.fn_attendant_set_status('${ORG_A}', 'paused', 'treinamento');
        reset role;
        ${jwt(BIA)}
        select public.fn_attendant_set_status('${ORG_A}', 'online', null, null, '${ANA}');
        ${semJwt}
        select '@@' || coalesce(ended_by, 'NULO') from public.attendant_pause_log where user_id='${ANA}';
        rollback;
      `),
    );
    expect(out).toEqual(["manager"]);
  });

  it("ninguém muda status em organização alheia", () => {
    expect(
      erroAoRodar(`begin; ${jwt(BETO)} select public.fn_attendant_set_status('${ORG_A}', 'online'); rollback;`),
    ).toMatch(/attendant_forbidden/);
  });
});

describe("o rodízio respeita a pausa e o teto do time", () => {
  const preparar = `
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_1}', '${SESSAO}') as c1 \\gset
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_2}', '${SESSAO}') as c2 \\gset
    update public.conversations set team_id='${TIME}' where id in (:'c1', :'c2');
    insert into public.attendant_availability(organization_id, user_id, is_available, capacity, last_heartbeat_at)
      values ('${ORG_A}', '${ANA}', true, 10, now())
      on conflict (organization_id, user_id) do update set is_available = true, capacity = 10, paused_at = null;
  `;

  it("em pausa, o claim é recusado — a conversa não vai para quem saiu", () => {
    const out = linhas(
      sql(`
        begin;
        ${preparar}
        update public.attendant_availability set is_available=false, paused_at=now(), pause_reason='almoco' where user_id='${ANA}';
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c1', '${SESSAO}', '${ANA}', null, 'routing');
        rollback;
      `),
    );
    expect(out).toEqual(["capacity_changed"]);
  });

  it("teto do time = 1: a primeira entra, a segunda ESPERA — com capacidade pessoal sobrando", () => {
    const out = linhas(
      sql(`
        begin;
        ${preparar}
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c1', '${SESSAO}', '${ANA}', null, 'routing');
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c2', '${SESSAO}', '${ANA}', null, 'routing');
        rollback;
      `),
    );
    expect(out).toEqual(["assigned", "capacity_changed"]);
  });

  it("sem teto no time, a mesma pessoa recebe as duas", () => {
    const out = linhas(
      sql(`
        begin;
        ${preparar}
        update public.attendance_teams set max_concurrent = null where id='${TIME}';
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c1', '${SESSAO}', '${ANA}', null, 'routing');
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c2', '${SESSAO}', '${ANA}', null, 'routing');
        rollback;
      `),
    );
    expect(out).toEqual(["assigned", "assigned"]);
  });

  it("fechar abre vaga: quem esperava é ADIANTADO, e ninguém novo entra na fila", () => {
    const out = linhas(
      sql(`
        begin;
        ${preparar}
        select public.fn_channel_routing_claim('${ORG_A}', :'c1', '${SESSAO}', '${ANA}', null, 'routing');
        update public.event_log set status='pending', next_attempt_at = now() + interval '15 minutes'
         where organization_id='${ORG_A}' and entity_id=:'c2' and event_type='conversation.routing_requested';
        select '@@' || count(*) filter (where next_attempt_at > now()) || '|' || count(*)
          from public.event_log where organization_id='${ORG_A}' and event_type='conversation.routing_requested' and status='pending';
        select (public.fn_service_status_com_ator('${ORG_A}', :'c1', 'closed', null, '${ANA}', false)).id;
        select '@@' || count(*) filter (where next_attempt_at > now()) || '|' || count(*)
          from public.event_log where organization_id='${ORG_A}' and event_type='conversation.routing_requested' and status='pending';
        select '@@' || public.fn_channel_routing_claim('${ORG_A}', :'c2', '${SESSAO}', '${ANA}', null, 'routing');
        rollback;
      `),
    );
    const [antes, depois, claim] = out;
    expect(antes?.split("|")[0]).toBe("1");
    // Adiantou quem esperava (0 no futuro) e NÃO criou evento: o total é o mesmo.
    expect(depois?.split("|")[0]).toBe("0");
    expect(depois?.split("|")[1]).toBe(antes?.split("|")[1]);
    expect(claim).toBe("assigned");
  });

  it("o teto do time só aceita inteiro positivo", () => {
    expect(erroAoRodar(`begin; update public.attendance_teams set max_concurrent = 0 where id='${TIME}'; rollback;`)).toMatch(
      /attendance_teams_max_concurrent_check/,
    );
  });
});

describe("o histórico de pausas não vaza e não se escreve pela REST", () => {
  const comPausa = `
    ${jwt(ANA)}
    select public.fn_attendant_set_status('${ORG_A}', 'paused', 'almoco');
    reset role;
  `;

  it("a própria pessoa lê a sua; o gestor lê a da equipe", () => {
    const out = linhas(
      sql(`
        begin;
        ${comPausa}
        ${jwt(ANA)}
        select '@@' || count(*) from public.attendant_pause_log where organization_id='${ORG_A}';
        reset role;
        ${jwt(BIA)}
        select '@@' || count(*) from public.attendant_pause_log where organization_id='${ORG_A}';
        rollback;
      `),
    );
    expect(out).toEqual(["1", "1"]);
  });

  it("o colega lê ZERO, e o vizinho de outra organização lê ZERO", () => {
    const out = linhas(
      sql(`
        begin;
        ${comPausa}
        ${jwt(CAIO)}
        select '@@' || count(*) from public.attendant_pause_log where organization_id='${ORG_A}';
        reset role;
        ${jwt(BETO)}
        select '@@' || count(*) from public.attendant_pause_log where organization_id='${ORG_A}';
        rollback;
      `),
    );
    expect(out).toEqual(["0", "0"]);
  });

  it.each(["anon", "authenticated", "service_role"])("%s não escreve no histórico", (papel) => {
    for (const dml of [
      `insert into public.attendant_pause_log (organization_id, user_id, reason) values ('${ORG_A}', '${ANA}', 'forjado')`,
      `delete from public.attendant_pause_log where organization_id='${ORG_A}'`,
    ]) {
      expect(erroAoRodar(`begin; set role ${papel}; ${dml}; rollback;`)).toMatch(/permission denied/);
    }
  });

  it("FK composta: não existe pausa de quem não é da organização", () => {
    expect(
      erroAoRodar(
        `begin; insert into public.attendant_pause_log (organization_id, user_id, reason) values ('${ORG_A}', '${BETO}', 'almoco'); rollback;`,
      ),
    ).toMatch(/violates foreign key constraint/);
  });

  it("as funções internas não são executáveis por anon; as de gesto só por authenticated", () => {
    const out = linhas(
      sql(`
        select '@@' || p.proname || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname in
           ('fn_attendant_set_status','fn_set_attendance_team_limit','fn_routing_acorda_pendentes',
            'fn_routing_vaga_aberta','fn_attendant_pause_registra','fn_attendant_pause_coerente')
         order by 1;
      `),
    );
    expect(out).toEqual([
      "fn_attendant_pause_coerente|false|false",
      "fn_attendant_pause_registra|false|false",
      "fn_attendant_set_status|false|true",
      "fn_routing_acorda_pendentes|false|false",
      "fn_routing_vaga_aberta|false|false",
      "fn_set_attendance_team_limit|false|true",
    ]);
  });
});
