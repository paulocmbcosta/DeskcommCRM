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

-- ─── comando_da_conversa: a outra metade do mesmo incidente ────────────────
-- Medido na mesma tarde: com a RLS de conversa já barata, o filtro das abas
-- (`?comando_da_conversa=eq.x`, 264 chamadas em 90 s) seguia em 1,2 s — o campo
-- calculado lia `contacts` DUAS vezes por linha, cada leitura sob a RLS de
-- contatos. No banco real, com zero divergência linha a linha contra a versão
-- anterior: admin 927 → 24 ms, atendente 349 → 33 ms.
-- Campo calculado do PostgREST (`?comando_da_conversa=eq.x`), avaliado POR
-- LINHA. Lia `contacts` duas vezes sob a RLS de contatos (`fn_user_org_ids()`
-- por linha): 0,9 s para 102 conversas como admin. Agora uma leitura só, sem a
-- RLS de contatos — com as guardas que ela fazia, escritas aqui: o contato é
-- da MESMA organização da conversa, e quem pergunta é membro ativo dela (ou
-- administrador da plataforma; sem usuário = chave de serviço). A função também é alcançável avulsa, com uma
-- linha forjada; as guardas valem para esse caminho também.
create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    -- `coalesce`: contato ausente (ou fora de alcance) não derruba a linha de
    -- todo filtro — viraria conversa invisível em TODAS as abas.
    coalesce(x.force_human, false),
    coalesce(x.is_blocked, false),
    now()
  )
  from (select 1) d
  left join lateral (
    select ct.force_human, ct.is_blocked
      from public.contacts ct
     where ct.id = c.contact_id
       and ct.organization_id = c.organization_id
       -- Sem usuário na sessão, quem chega aqui é service_role/postgres
       -- (anon está revogado): a chave de serviço sempre viu o contato.
       and (auth.uid() is null
            or exists (select 1 from public.user_organizations uo
                     where uo.user_id = auth.uid()
                       and uo.organization_id = c.organization_id
                       and uo.revoked_at is null)
            or exists (select 1 from public.platform_admins pa
                        where pa.user_id = auth.uid() and pa.revoked_at is null))
  ) x on true;
$function$;

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
