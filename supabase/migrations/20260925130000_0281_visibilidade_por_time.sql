-- 0281_visibilidade_por_time — o atendente enxerga o TIME, não a fila geral.
--
-- Pedido do dono do produto (2026-09-25): "ele vê as conversas dele e as do
-- time que não têm dono, para ele poder ali ajudar". O `visibility_mode`
-- (0035) só sabia três coisas — `all`, `own_and_unassigned`, `own` —, e a do
-- meio entregava ao atendente a fila INTEIRA da organização: a do setor dele,
-- a dos outros setores e a fila geral, que é trabalho de quem distribui.
--
-- Dois modos novos, só para o papel `agent` (viewer/manager/admin seguem vendo
-- a organização inteira, como sempre):
--
--   own_and_team_queue  as suas + as SEM DONO dos times de que ele é membro
--   own_and_team        as suas + TODAS dos seus times (as dos colegas também)
--
-- Nos dois, a conversa sem time (`team_id is null`) e sem dono — a fila geral —
-- só aparece para gerente e administrador. "Time da conversa" é
-- `conversations.team_id` (0263), o setor para onde ela foi encaminhada; o
-- atendente a quem uma conversa foi atribuída continua enxergando-a sempre.
--
-- ─── Onde a regra mora ─────────────────────────────────────────────────────
-- `fn_agent_sees_conversation(usuário, org, dono, time)` é o switch do modo,
-- para QUALQUER usuário — o que as duas políticas de entrega (meet e resposta
-- aprovada) e os destinatários do aviso precisam, porque decidem por outra
-- pessoa, não por `auth.uid()`. Até aqui as políticas de entrega repetiam o
-- `case` do modo em SQL inline, e um modo novo as deixaria para trás sem erro.
-- A RLS (`fn_can_view_conversation` de 3 argumentos) mantém a sua cópia inline
-- por custo por linha — ver o comentário dentro dela.
--
-- `fn_can_view_conversation` ganha a sobrecarga de 3 argumentos (com o time).
-- A de 2 argumentos NÃO é removida — corpo de plpgsql não registra dependência,
-- e um chamador esquecido quebraria em runtime — mas passa a delegar com time
-- NULO: nos modos por time ela nega a conversa sem dono, que é o lado seguro.
-- Todo chamador conhecido é regravado abaixo para a de 3.
--
-- Leads (`fn_can_view_lead`): lead não tem time. Em `own_and_team` o atendente
-- vê os seus e os dos colegas de time; em `own_and_team_queue`, só os seus — o
-- lead sem dono é da mesma natureza da fila geral.
--
-- Idempotente, portável em psql puro, sem BEGIN/COMMIT.

create or replace function public.fn_agent_sees_conversation(
  p_user uuid,
  p_org uuid,
  p_assigned uuid,
  p_team uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when p_user is null then false
    when p_assigned = p_user then true                                -- as suas
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned is null            -- fila inteira
         when 'own_and_team_queue' then p_assigned is null and p_team is not null
           and exists (select 1 from public.attendance_team_members m
                        where m.organization_id = p_org and m.team_id = p_team
                          and m.user_id = p_user)                     -- fila do time
         when 'own_and_team' then p_team is not null
           and exists (select 1 from public.attendance_team_members m
                        where m.organization_id = p_org and m.team_id = p_team
                          and m.user_id = p_user)                     -- tudo do time
         else false                                                   -- 'own'
       end
  end;
$$;

revoke execute on function public.fn_agent_sees_conversation(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.fn_agent_sees_conversation(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid,
  p_team_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  -- O `case` do modo é REPETIDO aqui, e não delegado a
  -- `fn_agent_sees_conversation`, por custo: esta função roda POR LINHA na RLS
  -- de conversations e, via `exists`, na de messages. Uma `security definer`
  -- chamando outra não é incorporada ao plano (incidente da 0278). As duas
  -- cópias são medidas com as mesmas frases em
  -- tests/invariants/visibilidade-por-time.test.ts (RLS e destinatários).
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false        -- não é membro
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_assigned_to_user_id = auth.uid() then true                 -- as suas
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to_user_id is null
         when 'own_and_team_queue' then p_assigned_to_user_id is null and p_team_id is not null
           and exists (select 1 from public.attendance_team_members m
                        where m.organization_id = p_org and m.team_id = p_team_id
                          and m.user_id = auth.uid())
         when 'own_and_team' then p_team_id is not null
           and exists (select 1 from public.attendance_team_members m
                        where m.organization_id = p_org and m.team_id = p_team_id
                          and m.user_id = auth.uid())
         else false
       end
  end;
$$;

revoke execute on function public.fn_can_view_conversation(uuid, uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_conversation(uuid, uuid, uuid) to authenticated, service_role;

-- A de 2 argumentos vira delegação com time nulo (ver cabeçalho).
create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.fn_can_view_conversation(p_org, p_assigned_to_user_id, null::uuid);
$$;

revoke execute on function public.fn_can_view_conversation(uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_conversation(uuid, uuid) to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    public.fn_can_view_conversation(organization_id, assigned_to_user_id, team_id)
  );

create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false        -- não é membro
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_owner_user_id = auth.uid() then true                       -- os seus
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null
         when 'own_and_team' then p_owner_user_id is not null
           and exists (select 1
                         from public.attendance_team_members eu
                         join public.attendance_team_members colega
                           on colega.team_id = eu.team_id
                          and colega.organization_id = eu.organization_id
                        where eu.organization_id = p_org
                          and eu.user_id = auth.uid()
                          and colega.user_id = p_owner_user_id)       -- dos colegas
         else false                                    -- 'own' e 'own_and_team_queue'
       end
  end;
$$;

revoke execute on function public.fn_can_view_lead(uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_lead(uuid, uuid) to authenticated, service_role;

-- ─── Aviso de mensagem: de quem é a conversa ───────────────────────────────
-- O push do servidor (`lib/notifications/push.handler.ts`) mandava TODA
-- mensagem recebida para TODA inscrição da organização — sem olhar dono nem
-- visibilidade: o atendente recebia na tela de bloqueio o texto de conversa que
-- a RLS não o deixava abrir. A pergunta "quem recebe" passa a ser do banco, com
-- a mesma régua da RLS, mais a escolha de cada pessoa:
--
--   user_organizations.message_alert_scope
--     'mine'         só as conversas atribuídas a mim
--     'all_visible'  toda conversa que eu enxergo
--     null           o padrão do papel: 'mine' para agent, 'all_visible' para
--                    os demais (comportamento de antes para gestor/admin)
alter table public.user_organizations
  add column if not exists message_alert_scope text;

do $do$ begin
  alter table public.user_organizations
    add constraint user_organizations_message_alert_scope_check
    check (message_alert_scope is null or message_alert_scope in ('mine','all_visible'));
exception when duplicate_object then null; end $do$;

-- Quem recebe o aviso de uma mensagem nesta conversa. Só service_role: o
-- chamador é o handler do event_log, que já resolveu a organização do evento.
create or replace function public.fn_destinatarios_do_aviso_de_mensagem(
  p_org uuid,
  p_conversation uuid
) returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select u.user_id
    from public.conversations c
    join public.user_organizations u
      on u.organization_id = c.organization_id and u.revoked_at is null
   where c.organization_id = p_org
     and c.id = p_conversation
     and (u.role in ('viewer','manager','admin')
          or public.fn_agent_sees_conversation(u.user_id, p_org, c.assigned_to_user_id, c.team_id))
     and case coalesce(u.message_alert_scope,
                       case when u.role = 'agent' then 'mine' else 'all_visible' end)
           when 'mine' then c.assigned_to_user_id = u.user_id
           else true
         end;
$$;

revoke execute on function public.fn_destinatarios_do_aviso_de_mensagem(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.fn_destinatarios_do_aviso_de_mensagem(uuid, uuid) to service_role;

-- A própria pessoa escolhe; ninguém escolhe pelos outros. `auth.uid()` é o
-- único seletor de linha — não há parâmetro de usuário para forjar.
create or replace function public.fn_definir_escopo_de_aviso(
  p_org uuid,
  p_scope text
) returns integer
language plpgsql security definer
set search_path = public
as $$
declare n integer;
begin
  if p_scope is not null and p_scope not in ('mine','all_visible') then
    raise exception 'message_alert_scope_invalido' using errcode = '22023';
  end if;
  update public.user_organizations
     set message_alert_scope = p_scope, updated_at = now()
   where organization_id = p_org and user_id = auth.uid() and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.fn_definir_escopo_de_aviso(uuid, text) from public, anon;
grant  execute on function public.fn_definir_escopo_de_aviso(uuid, text) to authenticated;


-- ─── Chamadores regravados para a sobrecarga com time ──────────────────────
-- Corpos copiados da definição vigente (baseline), com UMA mudança cada: a
-- chamada passa `team_id`, e as duas políticas de entrega trocam o `case` do
-- modo repetido em SQL por `fn_agent_sees_conversation`.

create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; actor uuid;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id,team_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  actor:=auth.uid();
  if actor is null or not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_source_kind:=case when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id,c.team_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
 end if;
 return new;
end; $$;
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;

create or replace function public.fn_meet_delivery_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
  join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
  join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
  join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
  join public.organizations o on o.id=a.organization_id and o.status='active'
  where cs.archived_at is null and a.meeting_delivery->>'channel_session_id'=cs.id::text and j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
   and a.contact_id=j.contact_id and not c.is_anonymized and not c.is_blocked and a.status<>'cancelled' and a.meeting_state='ready' and a.meeting_url is not null
   and a.meeting_request_id::text=j.payload->>'meeting_request_id' and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation'
   and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'state'='queued'
   and exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null)
   and (a.meeting_delivery->'authorized_by'->>'kind'='ai_agent' or
    (a.meeting_delivery->'authorized_by'->>'kind'='user' and a.meeting_delivery->'authorized_by'->>'id'=a.owner_user_id::text and exists(
     select 1 from public.user_organizations u where u.organization_id=p_org and u.user_id=a.owner_user_id and u.revoked_at is null and u.role in ('agent','manager','admin')
      and (u.role in ('manager','admin') or public.fn_agent_sees_conversation(u.user_id,p_org,v.assigned_to_user_id,v.team_id)))))
   and a.meeting_delivery->'service_boundary'=j.payload->'service_boundary' and public.fn_meet_boundary_current(j.payload->'service_boundary'));
$$;
revoke all on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) to service_role;

create or replace function public.fn_meet_action(p_org uuid,p_id uuid,p_revision text,p_request uuid,p_action text,p_conversation uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; b jsonb; destination_channel uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'meet_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() or not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=auth.uid() and revoked_at is null) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled' or a.location_kind<>'google_meet'
  or exists(select 1 from public.contacts where id=a.contact_id and organization_id=p_org and is_anonymized) then raise exception 'meet_stale' using errcode='40001';end if;
 if p_action='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='40001';end if;
  if a.meeting_state='ready' then return false;end if;
  if a.meeting_state<>'failed' then
   update public.calendar_appointments set meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;return true;
  end if;
  -- Tempo/timeout não provam rejeição. Somente failure recebido gira solicitação.
  update public.calendar_appointments set meeting_request_id=case when meeting_last_error='google_failure' and meeting_received_at is not null then gen_random_uuid() else meeting_request_id end,
   meeting_requested_at=case when meeting_last_error='google_failure' and meeting_received_at is not null then null else meeting_requested_at end,
   meeting_received_at=case when meeting_last_error='google_failure' then null else meeting_received_at end,
   meeting_state='pending',meeting_attempts=0,meeting_last_error=null,meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 elsif p_action='deliver' then
  if a.contact_id is null then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  select channel_session_id into destination_channel from public.conversations where organization_id=p_org and id=p_conversation and contact_id=a.contact_id and not is_group and public.fn_can_view_conversation(organization_id,assigned_to_user_id,team_id) for update;
  if not found then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='40001';end if;
  if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
   if a.meeting_delivery->>'state' in ('waiting_for_link','sent') then return false;end if;
   if a.meeting_delivery->>'state'='queued' and a.meeting_delivery_job_id is not null then
    -- Recuperação humana de job morto conserva ledger/identidade. Não duplicar
    -- uma mensagem aceita antes do crash nem reconstruir fronteira antiga.
    update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=0,run_after=now(),last_error=null
     where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('dead','failed','done');
    return found;
   end if;
  end if;
  update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded' where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  update public.calendar_appointments set meeting_delivery=jsonb_build_object('state','waiting_for_link','generation',gen_random_uuid(),'service_boundary',b,'authorized_by',jsonb_build_object('kind','user','id',auth.uid()),'source_operation_id',gen_random_uuid()),meeting_delivery_job_id=null where organization_id=p_org and id=p_id;
 else raise exception 'meet_action_invalid' using errcode='22023';end if;
 return true;
end;$$;
revoke all on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) from public,anon;
grant execute on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) to authenticated;

create or replace function public.fn_reply_action(p_org uuid,p_id uuid,p_revision text,p_action text,p_body text default null,p_feedback text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare d public.ai_reply_drafts;contact uuid;jid uuid;a uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) or not public.fn_session_mfa_proven() then raise exception 'reply_forbidden' using errcode='42501';end if;
 select contact_id,agent_id into contact,a from public.ai_reply_drafts where organization_id=p_org and id=p_id;
 if contact is null then raise exception 'reply_forbidden' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.ai_agents where organization_id=p_org and id=a for share;
 perform 1 from public.conversations c join public.ai_reply_drafts r on r.organization_id=c.organization_id and r.conversation_id=c.id where r.organization_id=p_org and r.id=p_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id,c.team_id) for share of c;
 if not found then raise exception 'reply_forbidden' using errcode='42501';end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and id=p_id for update;
 if d.status in('approved','sending','sent') and p_action='approve' and d.approved_by=auth.uid() and d.approved_body=p_body then return d.send_job_id;end if;
 if d.revision::text is distinct from p_revision or d.status<>'pending' or not public.fn_reply_context_current(p_org,p_id) then raise exception 'reply_stale' using errcode='40001';end if;
 if p_action='reject' then
 update public.ai_reply_drafts set status='dismissed',feedback=jsonb_build_object('decision','rejected','reason',left(p_feedback,1000)),revision=revision+1,updated_at=now() where id=p_id and organization_id=p_org;return null;
 elsif p_action='approve' then
 if p_body is null or length(trim(p_body))=0 or length(p_body)>12000 then raise exception 'reply_body_invalid' using errcode='22023';end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after) values(jid,p_org,contact,'approved_reply',jsonb_build_object('draft_id',d.id,'service_boundary',d.service_boundary),now());
 update public.ai_reply_drafts set status='approved',edited_body=p_body,approved_body=p_body,approved_by=auth.uid(),approved_at=now(),approved_support_session_id=case when public.fn_support_context()->>'organization_id'=p_org::text then (public.fn_support_context()->>'id')::uuid else null end,send_job_id=jid,
 feedback=jsonb_build_object('decision',case when p_body is distinct from original_body then 'edited' else 'approved' end,'reason',left(p_feedback,1000),'correction',case when p_body is distinct from original_body then p_body else null end),revision=revision+1,updated_at=now()
 where id=p_id and organization_id=p_org;return jid;
 end if;
 raise exception 'reply_action_invalid' using errcode='22023';
end;$$;
revoke all on function public.fn_reply_action(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_reply_action(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.fn_reply_delivery_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language sql stable security definer set search_path=public as $$
 select coalesce((select jsonb_build_object('current',true,'context_current',public.fn_reply_context_current(p_org,d.id),
 'contact_id',d.contact_id,'conversation_id',d.conversation_id,'channel_session_id',d.channel_session_id,'draft_id',d.id,'body',d.approved_body,'agent_id',d.agent_id)
 from public.job_queue j join public.ai_reply_drafts d on d.organization_id=j.organization_id and d.send_job_id=j.id and d.id::text=j.payload->>'draft_id'
 join public.conversations c on c.organization_id=d.organization_id and c.id=d.conversation_id and c.contact_id=d.contact_id
 join public.contacts p on p.organization_id=d.organization_id and p.id=d.contact_id
 join public.channel_sessions s on s.organization_id=d.organization_id and s.id=d.channel_session_id
 left join public.user_organizations u on u.organization_id=d.organization_id and u.user_id=d.approved_by and u.revoked_at is null and u.role in('agent','manager','admin')
 left join public.platform_support_sessions ss on ss.id=d.approved_support_session_id and ss.organization_id=d.organization_id and ss.actor_user_id=d.approved_by and ss.access_mode='full' and ss.ended_at is null and ss.expires_at>now()
 left join public.platform_admins pa on pa.user_id=ss.actor_user_id and pa.revoked_at is null and pa.scope='full'
 left join auth.sessions au on au.id=ss.auth_session_id and au.user_id=ss.actor_user_id and (au.not_after is null or au.not_after>now())
 join public.organizations o on o.id=d.organization_id and o.status='active'
 where j.organization_id=p_org and j.id=p_job and j.kind='approved_reply' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
 and j.contact_id=d.contact_id and d.status in('approved','sending') and d.approved_body is not null and d.service_boundary=j.payload->'service_boundary'
 and not p.is_blocked and not p.is_anonymized and s.archived_at is null and c.channel_session_id=d.channel_session_id
 and public.fn_meet_boundary_current(d.service_boundary)
 and((d.approved_support_session_id is not null and ss.id is not null and pa.user_id is not null and au.id is not null and (not(pa.mfa_required or exists(select 1 from auth.mfa_factors mf where mf.user_id=ss.actor_user_id and mf.status='verified')) or au.aal='aal2'))
 or(d.approved_support_session_id is null and u.user_id is not null and(u.role in('manager','admin') or public.fn_agent_sees_conversation(u.user_id,d.organization_id,c.assigned_to_user_id,c.team_id))))),'{"current":false}'::jsonb);
$$;
revoke all on function public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz) to service_role;

drop policy if exists tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts;
create policy tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts for select to authenticated
 using(organization_id in(select public.fn_user_org_ids()) and exists(select 1 from public.conversations c where c.organization_id=ai_reply_drafts.organization_id and c.id=conversation_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id,c.team_id)));

-- ─── Aviso de conversa atribuída ───────────────────────────────────────────
-- Com "só as minhas" como padrão do atendente, a PRIMEIRA mensagem de um
-- cliente novo não avisa ninguém do time: quando ela chega, a conversa ainda
-- não tem dono — o rodízio (`routing-worker`, 1×/min) atribui depois. Sem um
-- aviso na atribuição, o atendente receberia o cliente em silêncio.
--
-- Trigger SEM HTTP (doutrina): grava `conversation.assigned` no event_log, e o
-- consumidor é `lib/notifications/push.handler.ts`. Quem pega a conversa para
-- si (`changed_by = to_user_id`) não é avisado do que acabou de fazer.
create or replace function public.fn_emit_conversation_assigned_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.to_user_id is not null and new.to_user_id is distinct from new.changed_by then
    perform public.fn_log_event(
      new.organization_id, 'conversation.assigned',
      jsonb_build_object(
        'conversation_id', new.conversation_id,
        'to_user_id', new.to_user_id,
        'from_user_id', new.from_user_id,
        'reason', new.reason
      )
    );
  end if;
  return new;
end
$$;

revoke execute on function public.fn_emit_conversation_assigned_event() from public, anon, authenticated;

do $do$ begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_cae_emit_assigned'
       and tgrelid = 'public.conversation_assignment_events'::regclass
  ) then
    create trigger trg_cae_emit_assigned
      after insert on public.conversation_assignment_events
      for each row execute function public.fn_emit_conversation_assigned_event();
  end if;
end $do$;


notify pgrst, 'reload schema';
