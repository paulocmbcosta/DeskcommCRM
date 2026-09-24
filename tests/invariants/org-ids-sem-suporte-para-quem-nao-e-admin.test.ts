/**
 * `fn_user_org_ids()` e `fn_user_role_in_org()` não consultam o contexto de
 * suporte de quem NÃO é administrador da plataforma (migration 0278).
 *
 * Incidente de 2026-09-24 (produção fora do ar, 18:57–19:13 UTC): 60% do custo
 * da contagem de uma aba do Inbox era `fn_support_context()`, chamada duas vezes
 * por conversa pela RLS de `contacts` — para atendentes, com resultado sempre
 * vazio. O portão em `platform_admins` é equivalente; este arquivo prova as duas
 * metades: que a consulta cara deixou de acontecer, e que o resultado não mudou.
 * A semântica do suporte em si (ativo, readonly, sessão distinta, revogação) é
 * de `suporte-temporario.test.ts`.
 *
 * Para ver morder: reaplique o corpo antigo de `fn_user_org_ids` (o da 0220, sem
 * o `exists` em platform_admins) — o primeiro caso reprova com chamadas > 0.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const atendente = "f2770000-0000-4000-8000-000000000001";
const admin = "f2770000-0000-4000-8000-000000000002";
const sessao = "f2770000-0000-4000-8000-000000000003";
const orgA = "f2770000-0000-4000-8000-000000000004";
const orgB = "f2770000-0000-4000-8000-000000000005";

const seed = `begin;
set local track_functions = 'all';
insert into auth.users(id,email) values('${atendente}','atendente@invariant-0278.test'),('${admin}','admin@invariant-0278.test');
insert into auth.sessions(id,user_id,aal) values('${sessao}','${admin}','aal1');
insert into organizations(id,slug,display_name,legal_name) values('${orgA}','inv-0278-a','A','A'),('${orgB}','inv-0278-b','B','B');
insert into user_organizations(organization_id,user_id,role,accepted_at) values('${orgA}','${atendente}','agent',now()),('${orgA}','${admin}','admin',now());
insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values('${admin}','${admin}','full',false,'Local test');`;

const como = (usuario: string, sessaoId = sessao) =>
  `select set_config('request.jwt.claims','{"sub":"${usuario}","session_id":"${sessaoId}","aal":"aal1"}',true);`;
const assert = (condicao: string) =>
  `do $$ begin if (${condicao}) is distinct from true then raise exception 'assertion failed: %', ${JSON.stringify(condicao).replaceAll("'", "''").replace(/^"|"$/g, "'")}; end if; end $$;`;
const chamadasDoSuporte = `coalesce((select calls from pg_stat_xact_user_functions where funcname='fn_support_context'),0)`;

function prova(corpo: string) {
  expect(sql(`${seed}\n${corpo}\nrollback; select 'provado';`)).toContain("provado");
}

describe("0278 · a RLS não paga o contexto de suporte de quem não é administrador", () => {
  it("⭐ atendente: fn_user_org_ids e fn_user_role_in_org não chamam fn_support_context", () =>
    prova(`${como(atendente)}
    set local role authenticated;
    select count(*) from fn_user_org_ids();
    select fn_user_role_in_org('${orgA}');
    reset role;
    ${assert(`${chamadasDoSuporte} = 0`)}
    `));

  it("atendente: o resultado é o mesmo de antes — só a própria organização, com o próprio papel", () =>
    prova(`${como(atendente)}
    ${assert(`(select array_agg(x) from fn_user_org_ids() x) = array['${orgA}'::uuid]`)}
    ${assert(`fn_user_role_in_org('${orgA}') = 'agent'`)}
    ${assert(`fn_user_role_in_org('${orgB}') is null`)}
    `));

  it("administrador da plataforma em suporte ativo continua alcançando a organização do suporte", () =>
    prova(`select fn_start_support('${admin}','${sessao}','${orgB}','${orgA}','full',3600);
    ${como(admin)}
    ${assert(`(select count(*) from fn_user_org_ids()) = 2`)}
    ${assert(`fn_user_role_in_org('${orgB}') = 'admin'`)}
    ${assert(`${chamadasDoSuporte} > 0`)}
    `));

  it("administrador REVOGADO com sessão de suporte aberta perde o alcance, como antes", () =>
    prova(`select fn_start_support('${admin}','${sessao}','${orgB}','${orgA}','full',3600);
    update platform_admins set revoked_at = now() where user_id = '${admin}';
    ${como(admin)}
    ${assert(`(select array_agg(x) from fn_user_org_ids() x) = array['${orgA}'::uuid]`)}
    ${assert(`fn_user_role_in_org('${orgB}') is null`)}
    ${assert(`fn_user_role_in_org('${orgA}') = 'admin'`)}
    `));
});
