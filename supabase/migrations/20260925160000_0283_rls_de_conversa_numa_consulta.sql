-- 0283_rls_de_conversa_numa_consulta — a regra de visibilidade de conversa
-- deixa de custar ~15 ms POR LINHA.
--
-- Medido em produção (2026-09-25, 102 conversas, 19 usuários): como
-- `authenticated`, `select count(*) from conversations` levava 1,4–1,5 s para
-- um atendente, e o pool de conexões esgotava ("Timed out acquiring
-- connection") com a recontagem das abas e o Realtime avaliando a policy a
-- cada linha, para cada navegador aberto. O corpo ANTERIOR à 0281 medido ao
-- lado custava o mesmo (1,37 s): o custo não era o modo por time, era a forma —
-- `fn_is_platform_admin()` + `fn_user_role_in_org()` DUAS vezes, cada uma uma
-- `security definer` com `set search_path`, chamadas de dentro de outra, por
-- linha.
--
-- O corpo novo lê o papel numa consulta só. A regra não muda:
--   * administrador da plataforma → true (é o que `fn_is_platform_admin()`
--     decidia primeiro — `exists` em `platform_admins` ativo);
--   * não é membro → false; viewer/manager/admin → true;
--   * agent → o `case` do modo (o mesmo da 0281).
-- Para quem não é administrador da plataforma, `fn_user_role_in_org` só lia
-- `user_organizations` (o contexto de suporte é portão de `platform_admins`,
-- 0278) — então a leitura direta é equivalente.
--
-- Medido no banco de produção, com as mesmas 102 linhas e o mesmo resultado
-- (36 para o atendente, 102 para o admin): atendente 1.469 → 120 ms; admin
-- 281 → 78 ms.
--
-- Mesma assinatura, mesmo retorno, mesmos grants. Idempotente.

create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid,
  p_team_id uuid
) returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_modo text;
begin
  if v_uid is null then
    return false;
  end if;
  if exists (select 1 from public.platform_admins pa
              where pa.user_id = v_uid and pa.revoked_at is null) then
    return true;
  end if;

  select uo.role into v_role
    from public.user_organizations uo
   where uo.user_id = v_uid and uo.organization_id = p_org and uo.revoked_at is null
   limit 1;
  if v_role is null then
    return false;                                                    -- não é membro
  end if;
  if v_role in ('viewer','manager','admin') then
    return true;
  end if;
  if p_assigned_to_user_id = v_uid then
    return true;                                                     -- as suas
  end if;

  select coalesce(o.settings->>'visibility_mode', 'own_and_unassigned') into v_modo
    from public.organizations o where o.id = p_org;

  return case coalesce(v_modo, 'own_and_unassigned')
    when 'all' then true
    when 'own_and_unassigned' then p_assigned_to_user_id is null
    when 'own_and_team_queue' then p_assigned_to_user_id is null and p_team_id is not null
      and exists (select 1 from public.attendance_team_members m
                   where m.organization_id = p_org and m.team_id = p_team_id
                     and m.user_id = v_uid)
    when 'own_and_team' then p_team_id is not null
      and exists (select 1 from public.attendance_team_members m
                   where m.organization_id = p_org and m.team_id = p_team_id
                     and m.user_id = v_uid)
    else false
  end;
end;
$$;

revoke execute on function public.fn_can_view_conversation(uuid, uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_conversation(uuid, uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
