-- ---- o atendimento novo começa do zero (migration 0269) ----
--
-- A conversa é UMA por cliente e canal; o atendimento é o episódio dentro dela
-- (0266). Quando o cliente volta depois de encerrado, `fn_service_inbound` reabre
-- a conversa e o trigger da 0266 abre atendimento NOVO, com protocolo novo. Duas
-- das três camadas já começavam limpas: o que o atendente vê (recorte por
-- atendimento) e o que a IA lê (`get-lead-context` filtra por `service_revision`).
-- A terceira não: o ESTADO DE ROTEAMENTO atravessava o encerramento.
--
-- Medido no corpo da 0222: a reabertura zera dono e agente de IA, e NÃO toca
-- `team_id`, `bot_silenced_until`, `last_handoff_at` nem `contacts.force_human`.
-- Cliente que falou de financeiro na segunda e volta pedindo suporte na quarta
-- reabria NA FILA DO FINANCEIRO, e — se houve passagem para uma pessoa — com a
-- IA muda, sem triagem. `fn_service_status` só limpa o silêncio ao fechar quando
-- NÃO houve passagem, e ninguém além de "Devolver ao automático" solta a trava
-- do contato.
--
-- Decisão do dono do produto: ENCERRAR o atendimento é a devolução. A regra
-- "depois que uma pessoa assume, só uma pessoa devolve à IA" continua valendo
-- DENTRO do atendimento; o que acabou, acabou.
--
-- O reset mora AQUI, no banco, e não em quem ingere: a reabertura acontece neste
-- trigger para os três provedores (WAHA, Meta, Zernio), e reset por chamador é
-- reset que o quarto esquece. "Reabrir" pelo atendente (`p_retomar`) e contato
-- iniciado pela empresa (`fn_service_begin`) NÃO passam por este ramo, de
-- propósito: reabrir é CONTINUAR o mesmo atendimento, com o time que ele tinha.
--
-- Corpo idêntico ao da 0222, mais o bloco do ramo `reopened`.
create or replace function public.fn_service_inbound(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.messages; c public.conversations; d public.demandas; reopened boolean; pre_contact uuid; havia_passagem boolean := false;
begin
 select * into m from public.messages where id = p_message;
 if not found or m.direction <> 'inbound' or m.service_revision is not null then return; end if;
 select * into c from public.conversations where id = m.conversation_id;
 if not found or c.organization_id is distinct from m.organization_id
    or c.channel_session_id is distinct from m.channel_session_id
    or not exists(select 1 from public.channel_sessions where id=m.channel_session_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then return; end if;
 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if m.sent_at <= c.service_closed_at then return; end if;
 reopened := c.status in ('closed','resolved','archived');
 if not reopened then
   select x.* into d from public.demandas x join public.demanda_conversas dc on dc.demanda_id=x.id
    where x.id=c.current_demanda_id and x.organization_id=c.organization_id and x.contact_id=c.contact_id
      and dc.organization_id=c.organization_id and dc.conversation_id=c.id
      and dc.service_revision=c.service_revision and x.fechada_em is null;
 end if;
 if d.id is null then
   insert into public.demandas(organization_id,contact_id,aberta_em,origem,estado,dono_kind,proximo_passo)
    values(c.organization_id,c.contact_id,m.sent_at,'inbound','aberta','ia','Responder à nova mensagem do cliente') returning * into d;
 end if;
 if reopened then
   -- ATENDIMENTO NOVO COMEÇA DO ZERO (migration 0269). O cliente voltou depois de
   -- encerrado: o que o atendimento ANTERIOR decidiu — para que time foi, que a
   -- IA se calasse — não é decisão sobre ESTE. Sem isto, quem falou de financeiro
   -- na segunda e volta pedindo suporte na quarta cai na fila do Financeiro, com
   -- a triagem automática muda.
   havia_passagem := c.last_handoff_at is not null or c.bot_silenced_until is not null
     or exists(select 1 from public.contacts ct where ct.id=c.contact_id and ct.organization_id=c.organization_id and ct.force_human);
   update public.conversations set status='open', status_changed_at=clock_timestamp(),
     service_revision=service_revision+1,service_started_at=m.sent_at,
     assigned_to_user_id=null,assigned_at=null,assignee_kind=null,active_ai_agent_id=null,
     team_id=null,bot_silenced_until=null,last_handoff_at=null,last_handoff_reason=null,
     current_demanda_id=d.id where id=c.id and organization_id=c.organization_id returning * into c;
   -- A trava do CONTATO só sai se nenhuma OUTRA conversa dele está com passagem
   -- para uma pessoa em aberto: ela vale para o cliente inteiro, e soltá-la aqui
   -- não pode religar a IA por cima de quem está atendendo no outro número.
   update public.contacts ct set force_human=false
    where ct.id=c.contact_id and ct.organization_id=c.organization_id and ct.force_human
      and not exists(select 1 from public.conversations o
        where o.organization_id=c.organization_id and o.contact_id=c.contact_id and o.id<>c.id
          and o.status not in ('closed','resolved','archived') and o.last_handoff_at is not null);
   -- O follow-up pausado pela passagem precisa saber que ela acabou: este é o
   -- MESMO sinal que "Devolver ao automático" emite, e sem ele a inscrição fica
   -- em `paused_handoff` para sempre. Só quando havia passagem a encerrar.
   if havia_passagem then
     perform public.emit_event('ai.handoff_resolved','conversation',c.id,
       jsonb_build_object('conversation_id',c.id,'contact_id',c.contact_id,'organization_id',c.organization_id),
       jsonb_build_object('source','service.novo_atendimento'),c.organization_id);
   end if;

 else
   update public.conversations set
     service_revision=service_revision+case when current_demanda_id is not null and current_demanda_id<>d.id then 1 else 0 end,
     service_started_at=case when current_demanda_id is not null and current_demanda_id<>d.id then m.sent_at else coalesce(service_started_at,m.sent_at) end,
     current_demanda_id=d.id
    where id=c.id and organization_id=c.organization_id returning * into c;
 end if;
 insert into public.demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
  values(c.organization_id,d.id,c.id,c.service_revision) on conflict(demanda_id,conversation_id)
  do update set service_revision=excluded.service_revision;
 update public.messages set service_revision=c.service_revision,demanda_id=d.id,demanda_revision=d.revision
  where id=m.id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_service_inbound(uuid) from public,anon,authenticated;
grant execute on function public.fn_service_inbound(uuid) to service_role;

-- A linha do tempo não conta o reset como gesto: corpo idêntico ao da 0266, mais
-- `v_abrindo` calando "time mudou" e "automático voltou" na abertura.
create or replace function public.fn_atendimento_acompanha_conversa()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_terminal_antes boolean := false;
  v_terminal_agora boolean;
  v_calado_antes   boolean := false;
  v_calado_agora   boolean;
  v_ator      uuid;
  v_ator_nome text;
  v_ator_kind text := 'system';
  v_at        uuid;
  v_protocolo text;
  v_retomar   boolean;
  v_time_para text;
  v_time_de   text;
  v_abrindo   boolean := false;
begin
  if new.is_group or coalesce(new.group_chat_id, '') like '%@g.us' then return new; end if;

  begin
    v_terminal_agora := new.status in ('closed','resolved','archived');
    if tg_op = 'UPDATE' then
      v_terminal_antes := old.status in ('closed','resolved','archived');
    end if;

    -- QUEM fez. `auth.uid()` cobre as rotas que usam o client do usuário
    -- (assumir, transferir, liberar, time, pausar). Fechar e reabrir passam pelo
    -- service role, então o ator chega pela GUC que `fn_service_status_com_ator`
    -- grava na mesma transação. Sem nenhum dos dois, foi o sistema.
    begin
      v_ator := coalesce(auth.uid(), nullif(current_setting('deskcomm.ator_user_id', true), '')::uuid);
    exception when others then v_ator := null;
    end;
    if v_ator is not null then
      select nullif(raw_user_meta_data->>'full_name', '') into v_ator_nome from auth.users where id = v_ator;
      v_ator_kind := 'user';
    end if;

    if tg_op = 'INSERT' then
      v_protocolo := public.fn_proximo_protocolo(new.organization_id, coalesce(new.service_started_at, new.created_at, clock_timestamp()));
      insert into public.atendimentos(organization_id, conversation_id, protocol, started_at, closed_at, closed_status)
      values (new.organization_id, new.id, v_protocolo, coalesce(new.service_started_at, new.created_at, clock_timestamp()),
              case when v_terminal_agora then clock_timestamp() end,
              case when v_terminal_agora then new.status end)
      returning id into v_at;
      update public.conversations set protocol = v_protocolo where id = new.id and organization_id = new.organization_id;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'opened', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('protocol', v_protocolo, 'channel', new.channel));
      return new;
    end if;

    select id, protocol into v_at, v_protocolo from public.atendimentos
     where conversation_id = new.id and closed_at is null;

    if not v_terminal_antes and v_terminal_agora then
      update public.atendimentos
         set closed_at = coalesce(new.service_closed_at, clock_timestamp()), closed_status = new.status,
             closed_by_user_id = v_ator, closed_by_name = v_ator_nome,
             assigned_to_user_id = new.assigned_to_user_id, assigned_to_user_name = new.assigned_to_user_name,
             team_id = new.team_id
       where id = v_at;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'closed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('protocol', coalesce(v_protocolo, new.protocol), 'status', new.status));

    elsif v_terminal_antes and not v_terminal_agora then
      v_retomar := coalesce(current_setting('deskcomm.retomar_atendimento', true), '') = '1';
      v_at := null;
      if v_retomar then
        -- "Reabrir" é CONTINUAR o mesmo atendimento: o protocolo não muda.
        update public.atendimentos
           set closed_at = null, closed_status = null, closed_by_user_id = null, closed_by_name = null
         where id = (select id from public.atendimentos where conversation_id = new.id
                      order by started_at desc, created_at desc limit 1)
        returning id, protocol into v_at, v_protocolo;
        if v_at is not null then
          insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
          values (new.organization_id, new.id, v_at, 'reopened', v_ator_kind, v_ator, v_ator_nome,
                  jsonb_build_object('protocol', v_protocolo));
        end if;
      end if;
      if v_at is null then
        -- O cliente voltou (ou alguém iniciou contato): atendimento NOVO.
        -- Aberto pendurado é estado legado; fecha antes, senão o índice único recusa.
        update public.atendimentos set closed_at = clock_timestamp(), closed_status = coalesce(closed_status, old.status)
         where conversation_id = new.id and closed_at is null;
        v_protocolo := public.fn_proximo_protocolo(new.organization_id, clock_timestamp());
        insert into public.atendimentos(organization_id, conversation_id, protocol, started_at)
        values (new.organization_id, new.id, v_protocolo, coalesce(new.service_started_at, clock_timestamp()))
        returning id into v_at;
        update public.conversations set protocol = v_protocolo where id = new.id and organization_id = new.organization_id;
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'opened', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('protocol', v_protocolo, 'channel', new.channel, 'retorno', true));
      end if;

    elsif v_terminal_antes and v_terminal_agora and new.status is distinct from old.status then
      update public.atendimentos set closed_status = new.status
       where id = (select id from public.atendimentos where conversation_id = new.id
                    order by started_at desc, created_at desc limit 1);
    end if;

    -- O SETOR mudou. Encaminhar solta o dono na mesma instrução, e por isso o
    -- ramo do dono, logo abaixo, cala quando o time mudou: dois eventos para um
    -- gesto é ruído.
    -- Na ABERTURA de um atendimento novo o time e o silêncio são zerados na mesma
    -- instrução (migration 0269). Isso é o atendimento começando limpo, não um
    -- gesto de alguém: a linha "Novo atendimento aberto" já conta a história, e
    -- "devolvida à fila geral" + "devolvida ao automático" logo abaixo seriam
    -- duas linhas para um fato que ninguém praticou.
    v_abrindo := v_terminal_antes and not v_terminal_agora;

    if new.team_id is distinct from old.team_id and not v_abrindo then
      select name into v_time_para from public.attendance_teams where id = new.team_id;
      select name into v_time_de   from public.attendance_teams where id = old.team_id;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'team_changed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('to_team_id', new.team_id, 'to_team_name', v_time_para,
                                 'from_team_id', old.team_id, 'from_team_name', v_time_de));
    end if;

    if new.assigned_to_user_id is distinct from old.assigned_to_user_id then
      if new.assigned_to_user_id is not null then
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'assigned', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('to_user_id', new.assigned_to_user_id, 'to_user_name', new.assigned_to_user_name,
                                   'from_user_id', old.assigned_to_user_id, 'from_user_name', old.assigned_to_user_name));
      elsif new.team_id is not distinct from old.team_id and not (v_terminal_antes and not v_terminal_agora) then
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'released', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('from_user_id', old.assigned_to_user_id, 'from_user_name', old.assigned_to_user_name));
      end if;
    end if;

    -- A passagem do automático para uma pessoa. O motivo livre NÃO entra no
    -- payload: ele pode ser texto escrito por atendente sobre o cliente.
    if new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'handoff', 'ai', null, null, '{}'::jsonb);
    end if;

    -- O automático calou ou voltou — só quando ESTE foi o gesto. Assumir cala na
    -- mesma instrução (o evento é "assumiu"); passar para humano também (o
    -- evento é a passagem); fechar e liberar limpam o silêncio (idem).
    v_calado_antes := old.bot_silenced_until is not null and old.bot_silenced_until > clock_timestamp();
    v_calado_agora := new.bot_silenced_until is not null and new.bot_silenced_until > clock_timestamp();
    if v_calado_agora is distinct from v_calado_antes
       and new.assigned_to_user_id is not distinct from old.assigned_to_user_id
       and new.last_handoff_at is not distinct from old.last_handoff_at
       and not v_terminal_agora and not v_abrindo then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, case when v_calado_agora then 'ai_paused' else 'ai_resumed' end,
              v_ator_kind, v_ator, v_ator_nome, '{}'::jsonb);
    end if;

    if new.snooze_until is not null and new.snooze_until is distinct from old.snooze_until then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'snoozed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('until', new.snooze_until));
    end if;
  exception when others then
    raise warning 'fn_atendimento_acompanha_conversa: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.fn_atendimento_acompanha_conversa() from public, anon, authenticated;

notify pgrst, 'reload schema';
