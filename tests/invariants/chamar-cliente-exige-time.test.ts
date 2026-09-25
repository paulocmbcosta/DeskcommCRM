import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Migration 0284 — quem chama o cliente escolhe o time e fica como dono.
 *
 * `fn_conversation_iniciar_no_time` é a barreira que vale (a rota e a tela só
 * repetem a regra para recusar cedo). Cada caso chama a função como o PostgREST
 * chamaria: papel `authenticated` com o JWT de quem clicou.
 *
 * Cenário (uma organização, dois times):
 *   Suporte = { A }   Vendas = { C }   D = agent sem time   M = manager
 */

const ORG = "7e7e0284-0000-4000-8000-000000000001";
const OUTRA = "7e7e0284-0000-4000-8000-000000000002";
const A = "7e7e0284-1111-4000-8000-00000000000a";
const C = "7e7e0284-1111-4000-8000-00000000000c";
const D = "7e7e0284-1111-4000-8000-00000000000d";
const M = "7e7e0284-1111-4000-8000-00000000000e";
const SESSION = "7e7e0284-2222-4000-8000-000000000001";
const SUPORTE = "7e7e0284-3333-4000-8000-000000000001";
const VENDAS = "7e7e0284-3333-4000-8000-000000000002";
const contato = (n: number) => `7e7e0284-4444-4000-8000-00000000000${n}`;
const k = (n: number) => `7e7e0284-5555-4000-8000-00000000000${n}`;

const containerName = process.env.TEST_DB_CONTAINER as string;

/** Chama a função como `authenticated`; devolve o jsonb ou o erro do psql. */
function iniciarComo(user: string, conv: string, team: string | null, org = ORG) {
  const p = team ? `'${team}'` : "null";
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      {
        input: `set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
          select public.fn_conversation_iniciar_no_time('${org}', '${conv}', ${p});`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { ok: true as const, data: JSON.parse(lastLine(out.trim())) as Record<string, unknown>, erro: "" };
  } catch (err) {
    return { ok: false as const, data: null, erro: String((err as { stderr?: string }).stderr ?? err) };
  }
}

function linha(n: number) {
  const out = sql(`select json_build_object(
      'team_id', team_id, 'dono', assigned_to_user_id, 'silenciada', coalesce(bot_silenced_until = 'infinity', false))
    from public.conversations where id = '${k(n)}';`);
  return JSON.parse(lastLine(out.trim())) as { team_id: string | null; dono: string | null; silenciada: boolean };
}

beforeAll(() => {
  const membros: Array<[string, string]> = [[A, "agent"], [C, "agent"], [D, "agent"], [M, "manager"]];
  sql(`
    ${membros.map(([id], i) => `insert into auth.users (id, email) values ('${id}', 'ct-${i}@invariant.test');`).join("\n")}
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'chamar-time', 'Chamar Time Org', 'Chamar Time'),
      ('${OUTRA}', 'chamar-outra', 'Outra Org', 'Outra');
    ${membros.map(([id, role]) => `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${id}', '${ORG}', '${role}', now());`).join("\n")}
    do $ct$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'chamar-time', '\\x00'::bytea);
    exception when unique_violation then null; end $ct$;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${SUPORTE}', '${ORG}', 'Suporte', 'suporte'),
      ('${VENDAS}', '${ORG}', 'Vendas', 'vendas');
    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG}', '${SUPORTE}', '${A}'),
      ('${ORG}', '${VENDAS}', '${C}');
    insert into public.contacts (id, organization_id, display_name) values
      ${[1, 2, 3, 4, 5, 6].map((n) => `('${contato(n)}', '${ORG}', 'Contato ${n}')`).join(",\n      ")};
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_to_user_name) values
      ('${k(1)}', '${ORG}', '${contato(1)}', '${SESSION}', 'open', null, null),
      ('${k(2)}', '${ORG}', '${contato(2)}', '${SESSION}', 'open', null, null),
      ('${k(3)}', '${ORG}', '${contato(3)}', '${SESSION}', 'open', null, null),
      ('${k(4)}', '${ORG}', '${contato(4)}', '${SESSION}', 'claimed', '${C}', 'Carla Vendas'),
      ('${k(5)}', '${ORG}', '${contato(5)}', '${SESSION}', 'open', null, null),
      ('${k(6)}', '${ORG}', '${contato(6)}', '${SESSION}', 'open', null, null);
  `);
});

describe("fn_conversation_iniciar_no_time — time obrigatório e dono = quem chamou", () => {
  it("atendente abre no SEU time e fica dono; a IA é calada e o evento nomeia quem fez", () => {
    const r = iniciarComo(A, k(1), SUPORTE);
    expect(r.erro).toBe("");
    expect(r.data).toMatchObject({ team_id: SUPORTE, assigned_to_user_id: A });
    expect(linha(1)).toEqual({ team_id: SUPORTE, dono: A, silenciada: true });
    const ev = sql(`select to_user_id || '|' || changed_by || '|' || reason
                      from public.conversation_assignment_events where conversation_id = '${k(1)}';`);
    expect(lastLine(ev.trim())).toBe(`${A}|${A}|claim`);
  });

  it("atendente NÃO abre num time de que não é membro — e a linha não muda", () => {
    const r = iniciarComo(A, k(2), VENDAS);
    expect(r.ok).toBe(false);
    expect(r.erro).toContain("team_not_member");
    expect(linha(2)).toEqual({ team_id: null, dono: null, silenciada: false });
  });

  it("com time ativo na organização, sem time é recusado", () => {
    const r = iniciarComo(A, k(3), null);
    expect(r.ok).toBe(false);
    expect(r.erro).toContain("team_required");
    expect(linha(3).dono).toBeNull();
  });

  it("conversa com OUTRO dono é recusada, com o nome dele, e nada muda", () => {
    const r = iniciarComo(A, k(4), SUPORTE);
    expect(r.ok).toBe(false);
    expect(r.erro).toContain("conversation_owned");
    expect(r.erro).toContain("Carla Vendas");
    expect(linha(4)).toMatchObject({ team_id: null, dono: C });
  });

  it("atendente sem time nenhum escolhe qualquer time ativo", () => {
    const r = iniciarComo(D, k(5), VENDAS);
    expect(r.erro).toBe("");
    expect(linha(5)).toMatchObject({ team_id: VENDAS, dono: D });
  });

  it("gestor escolhe qualquer time ativo, mesmo sem ser membro", () => {
    const r = iniciarComo(M, k(6), SUPORTE);
    expect(r.erro).toBe("");
    expect(linha(6)).toMatchObject({ team_id: SUPORTE, dono: M });
  });

  it("organização de que a pessoa não é membro: recusa antes de tocar em qualquer linha", () => {
    const r = iniciarComo(A, k(2), SUPORTE, OUTRA);
    expect(r.ok).toBe(false);
    expect(r.erro).toContain("iniciar_forbidden");
  });

  it("anon não executa a função", () => {
    const out = sql(`select has_function_privilege('anon',
      'public.fn_conversation_iniciar_no_time(uuid,uuid,uuid)', 'execute');`);
    expect(lastLine(out.trim())).toBe("f");
  });
});
