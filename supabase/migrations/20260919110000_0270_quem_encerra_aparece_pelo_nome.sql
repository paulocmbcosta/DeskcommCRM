-- ---- quem encerra aparece pelo nome, mesmo sem nome cadastrado (migration 0270) ----
--
-- Medido em produção em 2026-09-19, numa instalação real: quatro atendimentos
-- encerrados PELA TELA, depois da 0266, com `actor_kind = 'user'` e
-- `actor_name` NULO — a aba Fechadas dizia "Fechada" sem dizer por quem, e a
-- linha do tempo dizia "Conversa encerrada" sem autor. Numa operação que
-- responde por protocolo, "quem encerrou" é o dado.
--
-- A causa: o trigger da 0266 lia o nome SÓ de `raw_user_meta_data->>'full_name'`,
-- e os dois usuários daquela instalação não têm essa chave (o cadastro deles tem
-- `email_verified` e `locale`, nada mais — conta criada antes de o
-- `bootstrap-owner.ts` gravar `full_name`). O gate estava verde porque o teste
-- criava todo usuário COM `full_name`: media o caminho feliz, que não é o de quem
-- instalou cedo.
--
-- O conserto tem duas metades:
--   1. `fn_nome_do_usuario(uuid)` — UMA régua: o nome cadastrado e, na falta
--      dele, o que vem antes do `@` do e-mail. É a mesma escada que a tela de
--      Equipe já usa (`full_name ?? email`), só que sem gravar o endereço inteiro
--      em mais duas tabelas. `security definer` porque lê `auth.users`; fechada a
--      anon e authenticated — só os triggers a chamam.
--   2. BACKFILL idempotente do que já foi gravado em branco: o autor dos
--      eventos, quem encerrou e quem atendia em cada atendimento, e os nomes
--      dentro do payload de "assumida"/"liberada". Só preenche o que está NULO e
--      tem o id ao lado — reaplicar não muda nada.
--
-- O que NÃO muda: `conversations.assigned_to_user_name` (0202) segue lendo só
-- `full_name`. Quem quer o nome de verdade em todas as telas cadastra em
-- Configurações › Perfil; esta migration garante que, enquanto não cadastra, o
-- protocolo não fica sem autor.
create or replace function public.fn_nome_do_usuario(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
           nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
           nullif(split_part(coalesce(u.email, ''), '@', 1), '')
         )
    from auth.users u
   where u.id = p_user;
$$;
revoke execute on function public.fn_nome_do_usuario(uuid) from public, anon, authenticated;
grant execute on function public.fn_nome_do_usuario(uuid) to service_role;

-- Corpo idêntico ao da 0269, trocando as quatro leituras de nome pela régua única.
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
      -- 0270: o nome cadastrado e, na falta dele, o início do e-mail — nunca em branco.
      v_ator_nome := public.fn_nome_do_usuario(v_ator);
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
             assigned_to_user_id = new.assigned_to_user_id, assigned_to_user_name = coalesce(nullif(new.assigned_to_user_name, ''), public.fn_nome_do_usuario(new.assigned_to_user_id)),
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
                jsonb_build_object('to_user_id', new.assigned_to_user_id, 'to_user_name', coalesce(nullif(new.assigned_to_user_name, ''), public.fn_nome_do_usuario(new.assigned_to_user_id)),
                                   'from_user_id', old.assigned_to_user_id, 'from_user_name', coalesce(nullif(old.assigned_to_user_name, ''), public.fn_nome_do_usuario(old.assigned_to_user_id))));
      elsif new.team_id is not distinct from old.team_id and not (v_terminal_antes and not v_terminal_agora) then
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'released', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('from_user_id', old.assigned_to_user_id, 'from_user_name', coalesce(nullif(old.assigned_to_user_name, ''), public.fn_nome_do_usuario(old.assigned_to_user_id))));
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

-- O que já foi gravado em branco. Cada UPDATE só toca linha com o NOME nulo e o
-- ID presente: reaplicar (o `update.sh` reaplica o baseline inteiro) não muda nada.
update public.conversation_events e
   set actor_name = public.fn_nome_do_usuario(e.actor_user_id)
 where e.actor_name is null and e.actor_user_id is not null
   and public.fn_nome_do_usuario(e.actor_user_id) is not null;

update public.atendimentos a
   set closed_by_name = public.fn_nome_do_usuario(a.closed_by_user_id)
 where a.closed_by_name is null and a.closed_by_user_id is not null
   and public.fn_nome_do_usuario(a.closed_by_user_id) is not null;

update public.atendimentos a
   set assigned_to_user_name = public.fn_nome_do_usuario(a.assigned_to_user_id)
 where a.assigned_to_user_name is null and a.assigned_to_user_id is not null
   and public.fn_nome_do_usuario(a.assigned_to_user_id) is not null;

update public.conversation_events e
   set payload = jsonb_set(e.payload, '{to_user_name}', to_jsonb(public.fn_nome_do_usuario((e.payload->>'to_user_id')::uuid)))
 where e.type = 'assigned'
   and nullif(e.payload->>'to_user_name', '') is null
   and (e.payload->>'to_user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and public.fn_nome_do_usuario((e.payload->>'to_user_id')::uuid) is not null;

update public.conversation_events e
   set payload = jsonb_set(e.payload, '{from_user_name}', to_jsonb(public.fn_nome_do_usuario((e.payload->>'from_user_id')::uuid)))
 where e.type in ('assigned', 'released')
   and nullif(e.payload->>'from_user_name', '') is null
   and (e.payload->>'from_user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and public.fn_nome_do_usuario((e.payload->>'from_user_id')::uuid) is not null;

notify pgrst, 'reload schema';
