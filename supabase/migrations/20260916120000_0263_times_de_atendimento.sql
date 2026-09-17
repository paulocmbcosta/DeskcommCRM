-- ---- times de atendimento (migration 0263) ----
--
-- Setores como destino humano. Desenho em
-- docs/superpowers/specs/2026-09-16-times-de-atendimento-design.md
--
-- A FK COMPOSTA (organization_id, user_id) → user_organizations é o que torna
-- IMPOSSÍVEL, e não só improvável, alocar num time alguém de outra organização.

create table if not exists public.attendance_teams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  slug            text not null,
  description     text not null default '',
  schedule        jsonb not null default '{}'::jsonb,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table if not exists public.attendance_team_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  team_id         uuid not null,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (organization_id, team_id)
    references public.attendance_teams(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.user_organizations(organization_id, user_id) on delete cascade
);

create index if not exists attendance_team_members_org_user
  on public.attendance_team_members(organization_id, user_id);

alter table public.conversations add column if not exists team_id uuid;

do $do$ begin
  alter table public.conversations add constraint conversations_team_id_fkey
    foreign key (team_id) references public.attendance_teams(id) on delete set null;
exception when duplicate_object then null; end $do$;

create index if not exists conversations_org_team
  on public.conversations(organization_id, team_id) where team_id is not null;

alter table public.attendance_teams        enable row level security;
alter table public.attendance_team_members enable row level security;
revoke all on public.attendance_teams, public.attendance_team_members
  from public, anon, authenticated, service_role;
grant select on public.attendance_teams, public.attendance_team_members
  to authenticated, service_role;

-- Policy `for all` (doutrina do CLAUDE.md), GRANT só de SELECT: o grant é o
-- portão mais estreito, e é ele que impede escrita pela REST.
drop policy if exists tenant_isolation_attendance_teams_all on public.attendance_teams;
create policy tenant_isolation_attendance_teams_all on public.attendance_teams for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

drop policy if exists tenant_isolation_attendance_team_members_all on public.attendance_team_members;
create policy tenant_isolation_attendance_team_members_all on public.attendance_team_members for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- A transferência para time é um motivo NOVO no vocabulário do evento de
-- atribuição. Acrescentar valor a um IN nunca viola dado existente.
do $do$ begin
  alter table public.conversation_assignment_events drop constraint if exists conversation_assignment_events_reason_check;
  alter table public.conversation_assignment_events add constraint conversation_assignment_events_reason_check
    check (reason in ('claim','transfer','release','routing','handoff','team_transfer'));
end $do$;

-- ---------------------------------------------------------------------------
-- Escrita: só por RPC security definer, no molde de fn_set_channel_routing.
-- ---------------------------------------------------------------------------

create or replace function public.fn_save_attendance_team(
  p_org uuid, p_team uuid, p_name text, p_slug text,
  p_description text, p_schedule jsonb, p_users uuid[]
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid; requested_count integer; found_count integer;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'team_mfa_required' using errcode='42501'; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'team_invalid_name' using errcode='22023'; end if;
  if p_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then
    raise exception 'team_invalid_slug' using errcode='22023'; end if;
  if p_users is null or cardinality(p_users) > 1000 or array_position(p_users, null) is not null then
    raise exception 'team_invalid_members' using errcode='22023'; end if;

  if p_team is null then
    insert into public.attendance_teams(organization_id,name,slug,description,schedule)
    values (p_org, btrim(p_name), p_slug, coalesce(p_description,''), coalesce(p_schedule,'{}'::jsonb))
    returning id into v_id;
  else
    update public.attendance_teams
       set name=btrim(p_name), slug=p_slug, description=coalesce(p_description,''),
           schedule=coalesce(p_schedule,'{}'::jsonb), updated_at=now()
     where organization_id=p_org and id=p_team
    returning id into v_id;
    if v_id is null then raise exception 'team_not_found' using errcode='P0002'; end if;
  end if;

  select count(distinct x) into requested_count from unnest(p_users) x;
  perform 1 from public.user_organizations
   where organization_id=p_org and user_id=any(p_users) and revoked_at is null
     and role in ('agent','manager','admin') order by user_id for share;
  get diagnostics found_count = row_count;
  if found_count <> requested_count then raise exception 'team_invalid_members' using errcode='22023'; end if;

  delete from public.attendance_team_members where organization_id=p_org and team_id=v_id;
  insert into public.attendance_team_members(organization_id,team_id,user_id)
   select p_org, v_id, x from (select distinct unnest(p_users) x) u;

  return jsonb_build_object('id', v_id, 'slug', p_slug, 'user_ids', to_jsonb(p_users));
end;
$$;
revoke execute on function public.fn_save_attendance_team(uuid,uuid,text,text,text,jsonb,uuid[]) from public, anon;
grant  execute on function public.fn_save_attendance_team(uuid,uuid,text,text,text,jsonb,uuid[]) to authenticated;

create or replace function public.fn_archive_attendance_team(p_org uuid, p_team uuid, p_arquivar boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'team_mfa_required' using errcode='42501'; end if;
  update public.attendance_teams
     set archived_at = case when p_arquivar then now() else null end, updated_at = now()
   where organization_id=p_org and id=p_team returning id into v_id;
  if v_id is null then raise exception 'team_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('id', v_id, 'archived', p_arquivar);
end;
$$;
revoke execute on function public.fn_archive_attendance_team(uuid,uuid,boolean) from public, anon;
grant  execute on function public.fn_archive_attendance_team(uuid,uuid,boolean) to authenticated;

-- Transferir para time: grava o time, SOLTA o dono e pede o roteamento.
-- `fn_request_channel_routing` é idempotente (on conflict do update), então
-- chamá-la aqui e a trigger de atribuição chamá-la de novo não duplica evento.
create or replace function public.fn_conversation_set_team(p_org uuid, p_conversation uuid, p_team uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'agent')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if p_team is not null and not exists (
      select 1 from public.attendance_teams
       where organization_id=p_org and id=p_team and archived_at is null)
   then raise exception 'team_not_found' using errcode='P0002'; end if;

  select assigned_to_user_id into v_owner from public.conversations
   where organization_id=p_org and id=p_conversation for update;
  if not found then raise exception 'conversation_not_found' using errcode='P0002'; end if;

  update public.conversations
     set team_id = p_team, assigned_to_user_id = null, assignee_kind = null, updated_at = now()
   where organization_id=p_org and id=p_conversation;

  if v_owner is not null then
    insert into public.conversation_assignment_events(
      organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
    values (p_org, p_conversation, v_owner, null, auth.uid(), 'team_transfer');
  end if;

  perform public.fn_request_channel_routing(p_org, p_conversation);
  return jsonb_build_object('conversation_id', p_conversation, 'team_id', p_team, 'released_from', v_owner);
end;
$$;
revoke execute on function public.fn_conversation_set_team(uuid,uuid,uuid) from public, anon;
grant  execute on function public.fn_conversation_set_team(uuid,uuid,uuid) to authenticated;
