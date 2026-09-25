import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * Migration 0281 — o atendente enxerga o TIME, não a fila geral; e o aviso de
 * mensagem vai para quem a conversa é.
 *
 * Cenário (uma organização, dois times):
 *   Suporte = { A, B }     Vendas = { C }     M = manager
 *
 *   c1  dono A, time Suporte      c4  sem dono, time Vendas
 *   c2  sem dono, time Suporte    c5  dono B, time Suporte
 *   c3  sem dono, SEM time (fila geral)
 *
 * Cada modo é medido pelo que A e C leem de verdade com o JWT deles — a mesma
 * régua que o PostgREST e o Realtime aplicam.
 */

const ORG = "7e7e0281-0000-4000-8000-000000000001";
const A = "7e7e0281-1111-4000-8000-00000000000a";
const B = "7e7e0281-1111-4000-8000-00000000000b";
const C = "7e7e0281-1111-4000-8000-00000000000c";
const M = "7e7e0281-1111-4000-8000-00000000000d";
const SESSION = "7e7e0281-2222-4000-8000-000000000001";
const SUPORTE = "7e7e0281-3333-4000-8000-000000000001";
const VENDAS = "7e7e0281-3333-4000-8000-000000000002";
// Um contato por conversa: a conversa é 1:1 por contato+canal.
const contato = (n: number) => `7e7e0281-4444-4000-8000-00000000000${n}`;
const c = (n: number) => `7e7e0281-5555-4000-8000-00000000000${n}`;
const MSG_C5 = "7e7e0281-6666-4000-8000-000000000005";
const PIPE = "7e7e0281-7777-4000-8000-000000000001";
const STAGE = "7e7e0281-7777-4000-8000-000000000002";
const LEAD_B = "7e7e0281-8888-4000-8000-00000000000b";
const LEAD_SEM_DONO = "7e7e0281-8888-4000-8000-000000000000";

const TODAS = [1, 2, 3, 4, 5].map((n) => `'${c(n)}'`).join(",");

function modo(m: string): void {
  sql(`update public.organizations
         set settings = jsonb_set(settings, '{visibility_mode}', to_jsonb('${m}'::text))
       where id = '${ORG}';`);
}

function quaisVe(user: string): number {
  return countAs(user, `select count(*) from public.conversations where id in (${TODAS});`);
}

function ve(user: string, n: number): boolean {
  return countAs(user, `select count(*) from public.conversations where id = '${c(n)}';`) === 1;
}

function destinatarios(n: number): string[] {
  const out = sql(`select coalesce(string_agg(u::text, ',' order by u::text), '')
                     from public.fn_destinatarios_do_aviso_de_mensagem('${ORG}', '${c(n)}') u;`);
  const last = lastLine(out);
  return last ? last.split(",") : [];
}

beforeAll(() => {
  const membros: Array<[string, string]> = [
    [A, "agent"],
    [B, "agent"],
    [C, "agent"],
    [M, "manager"],
  ];
  // Banco novo por arquivo (scripts/test-db.sh): o seed roda uma vez, sem
  // `on conflict` — que tabelas com unique DEFERRABLE recusam como árbitro.
  sql(`
    ${membros.map(([id], i) => `insert into auth.users (id, email) values ('${id}', 'vt-${i}@invariant.test');`).join("\n")}
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'vis-time', 'Vis Time Org', 'Vis Time',
              jsonb_build_object('visibility_mode', 'own_and_team_queue'))
     ;
    ${membros.map(([id, role]) => `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${id}', '${ORG}', '${role}', now());`).join("\n")}
    -- DO + exception: channel_sessions tem unique DEFERRABLE, que ON CONFLICT recusa.
    do $vt$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'vis-time', '\\x00'::bytea);
    exception when unique_violation then null; end $vt$;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${SUPORTE}', '${ORG}', 'Suporte', 'suporte'),
      ('${VENDAS}', '${ORG}', 'Vendas', 'vendas');
    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG}', '${SUPORTE}', '${A}'),
      ('${ORG}', '${SUPORTE}', '${B}'),
      ('${ORG}', '${VENDAS}', '${C}');
    insert into public.contacts (id, organization_id, display_name) values
      ${[1, 2, 3, 4, 5].map((n) => `('${contato(n)}', '${ORG}', 'Contato Vis ${n}')`).join(",\n      ")};
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, team_id) values
      ('${c(1)}', '${ORG}', '${contato(1)}', '${SESSION}', 'claimed', '${A}', '${SUPORTE}'),
      ('${c(2)}', '${ORG}', '${contato(2)}', '${SESSION}', 'open', null, '${SUPORTE}'),
      ('${c(3)}', '${ORG}', '${contato(3)}', '${SESSION}', 'open', null, null),
      ('${c(4)}', '${ORG}', '${contato(4)}', '${SESSION}', 'open', null, '${VENDAS}'),
      ('${c(5)}', '${ORG}', '${contato(5)}', '${SESSION}', 'claimed', '${B}', '${SUPORTE}')
     ;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG_C5}', '${ORG}', '${c(5)}', '${SESSION}', '${contato(5)}', 'text', 'inbound', 'probe')
     ;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE}', '${ORG}', 'Vis', 'vis');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPE}', 'Novo', 'novo', 1000);
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind) values
      ('${LEAD_B}', '${ORG}', '${PIPE}', '${STAGE}', 'Lead do B', '${B}', 'user'),
      ('${LEAD_SEM_DONO}', '${ORG}', '${PIPE}', '${STAGE}', 'Lead sem dono', null, null)
     ;
  `);
});

describe("own_and_team_queue — as suas + a fila do seu time", () => {
  it("A vê a sua e a sem dono do Suporte, e mais nada", () => {
    modo("own_and_team_queue");
    expect([1, 2, 3, 4, 5].filter((n) => ve(A, n))).toEqual([1, 2]);
  });

  it("C (Vendas) vê só a fila de Vendas", () => {
    modo("own_and_team_queue");
    expect([1, 2, 3, 4, 5].filter((n) => ve(C, n))).toEqual([4]);
  });

  it("a fila geral (sem time) não aparece para atendente nenhum", () => {
    modo("own_and_team_queue");
    expect(ve(A, 3) || ve(B, 3) || ve(C, 3)).toBe(false);
  });

  it("o gerente continua vendo a organização inteira", () => {
    modo("own_and_team_queue");
    expect(quaisVe(M)).toBe(5);
  });

  it("A não lê a mensagem da conversa do colega", () => {
    modo("own_and_team_queue");
    expect(countAs(A, `select count(*) from public.messages where id = '${MSG_C5}';`)).toBe(0);
  });

  it("leads: só os seus — nem o do colega, nem o sem dono", () => {
    modo("own_and_team_queue");
    expect(
      countAs(A, `select count(*) from public.crm_leads where id in ('${LEAD_B}','${LEAD_SEM_DONO}');`),
    ).toBe(0);
  });
});

describe("own_and_team — as suas + todas do seu time", () => {
  it("A vê também a conversa do colega B, e não a de Vendas nem a fila geral", () => {
    modo("own_and_team");
    expect([1, 2, 3, 4, 5].filter((n) => ve(A, n))).toEqual([1, 2, 5]);
  });

  it("a mensagem herda: A lê a mensagem da conversa do colega", () => {
    modo("own_and_team");
    expect(countAs(A, `select count(*) from public.messages where id = '${MSG_C5}';`)).toBe(1);
  });

  it("C não vê nada do Suporte", () => {
    modo("own_and_team");
    expect([1, 2, 3, 4, 5].filter((n) => ve(C, n))).toEqual([4]);
  });

  it("leads: vê o do colega de time, não o sem dono", () => {
    modo("own_and_team");
    expect(countAs(A, `select count(*) from public.crm_leads where id = '${LEAD_B}';`)).toBe(1);
    expect(countAs(A, `select count(*) from public.crm_leads where id = '${LEAD_SEM_DONO}';`)).toBe(0);
    expect(countAs(C, `select count(*) from public.crm_leads where id = '${LEAD_B}';`)).toBe(0);
  });
});

describe("os modos antigos não mudaram", () => {
  it("own_and_unassigned: A vê a sua + toda a fila (de qualquer time e a geral)", () => {
    modo("own_and_unassigned");
    expect([1, 2, 3, 4, 5].filter((n) => ve(A, n))).toEqual([1, 2, 3, 4]);
  });

  it("own: A vê só a sua", () => {
    modo("own");
    expect([1, 2, 3, 4, 5].filter((n) => ve(A, n))).toEqual([1]);
  });

  it("all: A vê tudo", () => {
    modo("all");
    expect(quaisVe(A)).toBe(5);
  });
});

describe("a sobrecarga de 2 argumentos nega o que depende do time", () => {
  it("sem time na chamada, a fila do time vira invisível (lado seguro)", () => {
    modo("own_and_team_queue");
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${A}"}', false);
      select public.fn_can_view_conversation('${ORG}', null::uuid)::text
          || ',' || public.fn_can_view_conversation('${ORG}', null::uuid, '${SUPORTE}')::text;
    `);
    expect(lastLine(out)).toBe("false,true");
  });
});

describe("aviso de mensagem vai para quem a conversa é", () => {
  it("conversa de A: A (padrão do atendente = só as minhas) e o gerente", () => {
    modo("own_and_team");
    sql(`update public.user_organizations set message_alert_scope = null where organization_id = '${ORG}';`);
    expect(destinatarios(1)).toEqual([A, M].sort());
  });

  it("fila do Suporte: ninguém do time por padrão; quem pede 'todas que vejo' recebe", () => {
    modo("own_and_team");
    sql(`update public.user_organizations set message_alert_scope = null where organization_id = '${ORG}';`);
    expect(destinatarios(2)).toEqual([M]);
    sql(`update public.user_organizations set message_alert_scope = 'all_visible'
          where organization_id = '${ORG}' and user_id in ('${B}', '${C}');`);
    // C pediu tudo, mas não ENXERGA a conversa do Suporte: não recebe.
    expect(destinatarios(2)).toEqual([B, M].sort());
    sql(`update public.user_organizations set message_alert_scope = null where organization_id = '${ORG}';`);
  });

  it("o gerente que escolhe 'só as minhas' deixa de receber a dos outros", () => {
    modo("own_and_team");
    sql(`update public.user_organizations set message_alert_scope = 'mine'
          where organization_id = '${ORG}' and user_id = '${M}';`);
    expect(destinatarios(1)).toEqual([A]);
    sql(`update public.user_organizations set message_alert_scope = null where organization_id = '${ORG}';`);
  });

  it("cada um define o PRÓPRIO escopo, e só valores conhecidos", () => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${A}"}', false);
      select public.fn_definir_escopo_de_aviso('${ORG}', 'all_visible');
    `);
    expect(lastLine(out)).toBe("1");
    expect(
      lastLine(sql(`select message_alert_scope from public.user_organizations
                     where organization_id = '${ORG}' and user_id = '${A}';`)),
    ).toBe("all_visible");
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${A}"}', false);
        select public.fn_definir_escopo_de_aviso('${ORG}', 'tudo');
      `),
    ).toThrow(/message_alert_scope_invalido/);
  });

  it("as funções de máquina não são alcançáveis pela sessão do usuário", () => {
    const out = sql(`
      select has_function_privilege('authenticated', 'public.fn_agent_sees_conversation(uuid,uuid,uuid,uuid)', 'execute')::text
          || ',' || has_function_privilege('anon', 'public.fn_agent_sees_conversation(uuid,uuid,uuid,uuid)', 'execute')::text
          || ',' || has_function_privilege('authenticated', 'public.fn_destinatarios_do_aviso_de_mensagem(uuid,uuid)', 'execute')::text
          || ',' || has_function_privilege('anon', 'public.fn_definir_escopo_de_aviso(uuid,text)', 'execute')::text;
    `);
    expect(lastLine(out)).toBe("false,false,false,false");
  });
});

describe("quem RECEBE uma conversa é avisado, mesmo com 'só as minhas'", () => {
  function avisosDeAtribuicao(user: string): number {
    return Number(
      lastLine(
        sql(`select count(*) from public.event_log
              where organization_id = '${ORG}' and event_type = 'conversation.assigned'
                and payload->>'to_user_id' = '${user}';`),
      ),
    );
  }

  it("transferência pelo gerente e rodízio emitem o evento para quem recebe", () => {
    sql(`insert into public.conversation_assignment_events
           (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason) values
           ('${ORG}', '${c(2)}', null, '${B}', '${M}', 'transfer'),
           ('${ORG}', '${c(4)}', null, '${C}', null, 'routing');`);
    expect(avisosDeAtribuicao(B)).toBe(1);
    expect(avisosDeAtribuicao(C)).toBe(1);
  });

  it("quem pega a conversa para si não é avisado do que acabou de fazer; soltar também não", () => {
    sql(`insert into public.conversation_assignment_events
           (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason) values
           ('${ORG}', '${c(3)}', null, '${A}', '${A}', 'claim'),
           ('${ORG}', '${c(3)}', '${A}', null, '${A}', 'release');`);
    expect(avisosDeAtribuicao(A)).toBe(0);
  });
});
