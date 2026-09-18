-- ---- pausa do atendente com motivo, limite por time e fila que acorda (migration 0267) ----
--
-- O rodízio já sabia de três coisas: quem está disponível (`is_available`),
-- quanto cada um aguenta (`capacity`) e em que horário. Faltavam três, e todas
-- aparecem no mesmo dia numa operação com equipe:
--
--   1. PAUSA COM MOTIVO. "Indisponível" era um booleano: banheiro, almoço,
--      reunião e "fui embora" tinham a mesma cara, e nenhum deixava rastro. Quem
--      gere equipe precisa saber QUANTO tempo se passa em pausa e POR QUÊ.
--   2. LIMITE POR TIME. `capacity` é da pessoa, vale para tudo que ela atende. O
--      setor de Suporte querer "no máximo 5 por atendente" não tinha onde morar.
--   3. A FILA QUE ACORDA. Conversa sem elegível é reagendada com recuo — depois
--      de `max_retries`, para 15 minutos. Voltar da pausa já acordava a fila
--      (`trg_routing_availability_changed`); FECHAR uma conversa, que é o outro
--      jeito de abrir vaga, não acordava ninguém: o 6º cliente esperava o
--      relógio, com um atendente livre na frente dele.
--
-- A pausa NÃO é um terceiro estado de `is_available`. Ela é indisponibilidade com
-- explicação: `is_available=false` + `paused_at`/`pause_reason`. Tudo que já lia
-- `is_available` — o carregador de elegíveis, a revalidação do claim, o painel de
-- equipe — continua certo sem saber que pausa existe. É por isso que são colunas
-- ao lado, e não um enum no lugar.

alter table public.attendant_availability add column if not exists paused_at    timestamptz;
alter table public.attendant_availability add column if not exists pause_reason text;
alter table public.attendant_availability add column if not exists pause_note   text;

alter table public.attendance_teams add column if not exists max_concurrent integer;
do $do$ begin
  alter table public.attendance_teams add constraint attendance_teams_max_concurrent_check
    check (max_concurrent is null or max_concurrent > 0);
exception when duplicate_object then null; end $do$;

-- O histórico de pausas. `pause_reason` é vocabulário ABERTO (exceção documentada
-- no CLAUDE.md): os motivos de uma operação mudam ("treinamento NR-10", "visita
-- técnica"), e um CHECK aqui prenderia o produto ao vocabulário do primeiro
-- cliente. O conjunto padrão vive em `lib/atendimento/pausa.ts`.
create table if not exists public.attendant_pause_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null,
  reason          text not null,
  note            text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  ended_by        text,
  constraint attendant_pause_log_ended_by_check
    check (ended_by is null or ended_by in ('self','manager','system')),
  -- FK COMPOSTA: impossível registrar pausa de quem não é da organização.
  foreign key (organization_id, user_id)
    references public.user_organizations(organization_id, user_id) on delete cascade
);
create unique index if not exists attendant_pause_log_uma_aberta
  on public.attendant_pause_log(organization_id, user_id) where ended_at is null;
create index if not exists attendant_pause_log_org_inicio
  on public.attendant_pause_log(organization_id, started_at desc);

alter table public.attendant_pause_log enable row level security;
revoke all on public.attendant_pause_log from public, anon, authenticated, service_role;
grant select on public.attendant_pause_log to authenticated, service_role;

-- A própria pessoa vê as suas; gestor vê as da equipe. Pausa é dado de jornada de
-- trabalho — colega não tem por que ler o almoço do outro.
drop policy if exists tenant_isolation_attendant_pause_log_select on public.attendant_pause_log;
create policy tenant_isolation_attendant_pause_log_select on public.attendant_pause_log for select to authenticated
 using (
   public.fn_is_platform_admin()
   or (organization_id in (select public.fn_user_org_ids())
       and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
 );

-- ---------------------------------------------------------------------------
-- A COERÊNCIA mora em trigger, não em quem chama: `attendant_availability` é
-- escrita por três caminhos (a RPC abaixo, o PATCH da tela de Equipe e o cron de
-- sinal de vida), e "ficou disponível" tem de ENCERRAR a pausa nos três.
-- ---------------------------------------------------------------------------
create or replace function public.fn_attendant_pause_coerente()
returns trigger language plpgsql set search_path=public as $$
begin
  -- Disponível e em pausa ao mesmo tempo não existe: disponível vence.
  if new.is_available then
    new.paused_at := null; new.pause_reason := null; new.pause_note := null;
  end if;
  if new.paused_at is null then
    new.pause_reason := null; new.pause_note := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_attendant_pause_coerente() from public, anon, authenticated;

create or replace function public.fn_attendant_pause_registra()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_quem text;
begin
  -- O sinal de vida escreve nesta tabela a cada minuto, por atendente: sem
  -- mudança de pausa não há o que registrar.
  if tg_op = 'UPDATE' and new.paused_at is not distinct from old.paused_at then return new; end if;
  if tg_op = 'INSERT' and new.paused_at is null then return new; end if;
  begin
    v_quem := case when auth.uid() is null then 'system' when auth.uid() = new.user_id then 'self' else 'manager' end;
    -- Saiu da pausa (ou trocou de pausa): fecha a que estava aberta.
    if tg_op = 'UPDATE' and old.paused_at is not null
       and (new.paused_at is null or new.paused_at is distinct from old.paused_at) then
      update public.attendant_pause_log set ended_at = clock_timestamp(), ended_by = v_quem
       where organization_id = new.organization_id and user_id = new.user_id and ended_at is null;
    end if;
    -- Entrou em pausa.
    if new.paused_at is not null and (tg_op = 'INSERT' or old.paused_at is distinct from new.paused_at) then
      update public.attendant_pause_log set ended_at = clock_timestamp(), ended_by = v_quem
       where organization_id = new.organization_id and user_id = new.user_id and ended_at is null;
      insert into public.attendant_pause_log(organization_id, user_id, reason, note, started_at)
      values (new.organization_id, new.user_id, coalesce(nullif(btrim(new.pause_reason), ''), 'outro'), new.pause_note, new.paused_at);
    end if;
  exception when others then
    -- O registro da pausa não pode impedir alguém de pausar nem de voltar.
    raise warning 'fn_attendant_pause_registra: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.fn_attendant_pause_registra() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_attendant_pause_coerente'
                   and tgrelid = 'public.attendant_availability'::regclass) then
    create trigger trg_attendant_pause_coerente before insert or update on public.attendant_availability
      for each row execute function public.fn_attendant_pause_coerente();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_attendant_pause_registra'
                   and tgrelid = 'public.attendant_availability'::regclass) then
    -- SEM lista de colunas, de propósito: `update of paused_at` só dispara quando
    -- a coluna está no SET do comando, e quem encerra a pausa pelo PATCH da tela
    -- de Equipe escreve `is_available` — é o trigger BEFORE acima que zera
    -- `paused_at`. Medido: com a lista, voltar por aquele caminho deixava a pausa
    -- aberta no histórico para sempre. A função sai cedo quando nada mudou.
    create trigger trg_attendant_pause_registra after insert or update on public.attendant_availability
      for each row execute function public.fn_attendant_pause_registra();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- O gesto do atendente: online, em pausa (com motivo) ou offline.
-- A própria pessoa muda o seu; gestor muda o de qualquer membro.
-- ---------------------------------------------------------------------------
create or replace function public.fn_attendant_set_status(
  p_org uuid, p_status text, p_reason text default null, p_note text default null, p_user uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_alvo uuid; v_linha public.attendant_availability;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'agent') or not public.fn_support_write_allowed(p_org)
   then raise exception 'attendant_forbidden' using errcode='42501'; end if;
  v_alvo := coalesce(p_user, auth.uid());
  if v_alvo <> auth.uid() and not public.fn_role_at_least(p_org, 'manager')
   then raise exception 'attendant_forbidden' using errcode='42501'; end if;
  if p_status not in ('online', 'paused', 'offline')
   then raise exception 'attendant_invalid_status' using errcode='22023'; end if;
  if p_status = 'paused' and coalesce(btrim(p_reason), '') = ''
   then raise exception 'attendant_pause_reason_required' using errcode='22023'; end if;
  if not exists (select 1 from public.user_organizations where organization_id = p_org and user_id = v_alvo
                  and revoked_at is null and role in ('agent','manager','admin'))
   then raise exception 'attendant_not_found' using errcode='P0002'; end if;

  insert into public.attendant_availability(organization_id, user_id, is_available, paused_at, pause_reason, pause_note, last_heartbeat_at, updated_at)
  values (p_org, v_alvo, p_status = 'online',
          case when p_status = 'paused' then clock_timestamp() end,
          case when p_status = 'paused' then btrim(p_reason) end,
          case when p_status = 'paused' then nullif(btrim(coalesce(p_note, '')), '') end,
          case when p_status = 'online' then clock_timestamp() end, clock_timestamp())
  on conflict (organization_id, user_id) do update set
    is_available = excluded.is_available,
    paused_at = excluded.paused_at, pause_reason = excluded.pause_reason, pause_note = excluded.pause_note,
    last_heartbeat_at = coalesce(excluded.last_heartbeat_at, public.attendant_availability.last_heartbeat_at),
    updated_at = clock_timestamp()
  returning * into v_linha;

  return jsonb_build_object(
    'user_id', v_linha.user_id, 'status', p_status, 'is_available', v_linha.is_available,
    'paused_at', v_linha.paused_at, 'pause_reason', v_linha.pause_reason, 'pause_note', v_linha.pause_note,
    'capacity', v_linha.capacity);
end;
$$;
revoke execute on function public.fn_attendant_set_status(uuid, text, text, text, uuid) from public, anon;
grant  execute on function public.fn_attendant_set_status(uuid, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ACORDAR QUEM JÁ ESPERA — e só quem já espera.
--
-- `fn_wake_channel_routing` (0228) percorre TODA conversa aberta sem dono e pede
-- roteamento para cada uma, criando evento onde não havia. Serve para mudança
-- rara (política de canal, disponibilidade). Para "abriu uma vaga", que acontece
-- a cada conversa fechada, seria N eventos novos por fechamento — numa
-- organização em modo manual, com cem conversas conduzidas pelo automático, são
-- cem linhas de `event_log` a cada clique em Fechar, todas consumidas como
-- `skipped_manual`. Esta só ADIANTA o que já está na fila: zero linha tocada
-- quando não há ninguém esperando.
-- ---------------------------------------------------------------------------
create or replace function public.fn_routing_acorda_pendentes(p_org uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_n integer;
begin
  update public.event_log set next_attempt_at = now()
   where organization_id = p_org and event_type = 'conversation.routing_requested'
     and status = 'pending' and next_attempt_at is not null and next_attempt_at > now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.fn_routing_acorda_pendentes(uuid) from public, anon, authenticated;
grant  execute on function public.fn_routing_acorda_pendentes(uuid) to service_role;

-- O limite do time, em RPC própria: mexer na assinatura de `fn_save_attendance_team`
-- criaria uma janela em que app e banco discordam de quantos parâmetros ela tem.
create or replace function public.fn_set_attendance_team_limit(p_org uuid, p_team uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'team_mfa_required' using errcode='42501'; end if;
  if p_limit is not null and (p_limit < 1 or p_limit > 1000)
   then raise exception 'team_invalid_limit' using errcode='22023'; end if;
  update public.attendance_teams set max_concurrent = p_limit, updated_at = now()
   where organization_id = p_org and id = p_team returning id into v_id;
  if v_id is null then raise exception 'team_not_found' using errcode='P0002'; end if;
  -- Subir o limite abre vaga: quem esperava na fila do time não espera o relógio.
  perform public.fn_routing_acorda_pendentes(p_org);
  return jsonb_build_object('id', v_id, 'max_concurrent', p_limit);
end;
$$;
revoke execute on function public.fn_set_attendance_team_limit(uuid, uuid, integer) from public, anon;
grant  execute on function public.fn_set_attendance_team_limit(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- O claim revalida o LIMITE DO TIME dentro da transação, como já revalidava a
-- capacidade da pessoa. Sem isto o limite viveria só no TypeScript, e duas
-- rodadas simultâneas do worker dariam a 6ª conversa a quem tem teto de 5.
-- Corpo idêntico ao da 0228, mais o bloco do time.
-- ---------------------------------------------------------------------------
create or replace function public.fn_channel_routing_claim(p_org uuid,p_conversation uuid,p_channel uuid,p_user uuid,p_schedule jsonb default null,p_reason text default 'routing')
returns text language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid; member_id uuid; v_policy_id uuid; availability public.attendant_availability; current_load integer; team_limit integer; team_load integer;
begin
 if p_reason not in('routing','handoff') then raise exception 'routing_reason_invalid' using errcode='22023';end if;
 select contact_id into pre_contact from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return 'conversation_changed';end if;
 perform public.fn_service_lock(p_org,pre_contact);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,228));
 -- Task9: o trigger de status do canal toca conversas; ordem comum channel -> conversation.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel for share;
 if not found then return 'conversation_changed';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if not found or c.contact_id is distinct from pre_contact or c.channel_session_id is distinct from p_channel
  or c.status not in('open','pending','claimed','ai_handling') then return 'conversation_changed';end if;
 if c.assigned_to_user_id is not null then return 'already_assigned';end if;
 select id into member_id from public.user_organizations where organization_id=p_org and user_id=p_user
  and revoked_at is null and role in('agent','manager','admin') for share;
 if not found then return 'candidate_revoked';end if;
 select id into v_policy_id from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 if found and not exists(select 1 from public.channel_routing_responsibles r where r.organization_id=p_org and r.policy_id=v_policy_id and r.user_id=p_user)
 then return 'candidate_not_allowed';end if;
 select * into availability from public.attendant_availability where organization_id=p_org and user_id=p_user for share;
 if not found or not availability.is_available or (p_schedule is not null and availability.schedule is distinct from p_schedule)
 then return 'capacity_changed';end if;
 select count(*) into current_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user and status in('open','pending','claimed','ai_handling');
 if current_load>=availability.capacity then return 'capacity_changed';end if;
 if c.team_id is not null then
  select max_concurrent into team_limit from public.attendance_teams where organization_id=p_org and id=c.team_id;
  if team_limit is not null then
   select count(*) into team_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user
    and team_id=c.team_id and status in('open','pending','claimed','ai_handling');
   if team_load>=team_limit then return 'capacity_changed';end if;
  end if;
 end if;
 perform public.fn_conversation_assign(p_org,p_conversation,p_user,p_reason,null,true);
 return 'assigned';
end;
$$;
revoke all on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

-- ---------------------------------------------------------------------------
-- ABRIU VAGA: a conversa que tinha dono fechou, ou o dono a soltou. Quem espera
-- na fila é tentado AGORA, e não no próximo recuo de 15 minutos.
-- ---------------------------------------------------------------------------
create or replace function public.fn_routing_vaga_aberta()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  begin
    perform public.fn_routing_acorda_pendentes(new.organization_id);
  exception when others then
    raise warning 'fn_routing_vaga_aberta: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.fn_routing_vaga_aberta() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_routing_vaga_aberta'
                   and tgrelid = 'public.conversations'::regclass) then
    create trigger trg_routing_vaga_aberta after update of status, assigned_to_user_id on public.conversations
      for each row when (
        old.assigned_to_user_id is not null
        and old.status in ('open','pending','claimed','ai_handling')
        and (new.status in ('closed','resolved','archived')
             or new.assigned_to_user_id is distinct from old.assigned_to_user_id)
      ) execute function public.fn_routing_vaga_aberta();
  end if;
end $$;

notify pgrst, 'reload schema';
