-- 0279 · `conversations.espera_desde` (a PRIMEIRA mensagem do cliente ainda sem
-- resposta) e transferência para time silenciando a IA.
--
-- ─── espera_desde ──────────────────────────────────────────────────────────
-- O termômetro do Inbox media desde `last_inbound_at` — a ÚLTIMA entrada. Quem
-- manda "oi" às 10h00 e "alguém aí?" às 10h09 aparecia esperando há 1 min, e o
-- cliente mais insistente parecia o mais recente. `lib/inbox/espera.ts` já
-- escrevia o limite ("medir desde a primeira sem resposta pede uma coluna que
-- ainda não existe"); esta é a coluna.
--
-- É DERIVADA das duas colunas que `fn_mark_conversation_message` já grava, por
-- trigger BEFORE — nenhuma função de ingestão (WAHA, Meta, Zernio, chat do site)
-- precisa mudar, e nenhum caminho novo de escrita consegue esquecê-la:
--   · não espera (sem entrada, saída ≥ entrada, ou status terminal) → null;
--   · passou a esperar e estava null → a entrada que abriu a espera;
--   · já esperando → mantém (é justamente a primeira sem resposta).
-- Trigger sem HTTP, sem leitura de outra tabela: só a própria linha.
--
-- ─── transferência para time silencia a IA ─────────────────────────────────
-- `fn_conversation_set_team` soltava o dono e pedia roteamento, mas deixava o
-- robô no comando: a conversa "transferida para o Suporte" seguia `automatico`,
-- fora da Fila e fora do selo "Na fila". Time não tem agente de IA — quem
-- transfere para um time está pedindo gente. Grava o mesmo `'infinity'` do
-- handoff da IA (`lib/agent-engine/agent/human-handoff.ts`); "Devolver ao
-- automático" continua sendo a volta. Tirar do time (`p_team` nulo) não mexe.
--
-- Idempotente: `add column if not exists`, `create or replace`, `drop trigger if
-- exists`, backfill que só toca linha divergente.

alter table public.conversations add column if not exists espera_desde timestamptz;

comment on column public.conversations.espera_desde is
  'Primeira mensagem do cliente ainda sem resposta (null = ninguém deve resposta). Mantida por trg_conversations_espera_desde a partir de last_inbound_at/last_outbound_at/status (migration 0279).';

create or replace function public.fn_conversations_espera_desde()
returns trigger language plpgsql set search_path = public as $$
declare
  -- A entrada tem de ser DESTE atendimento: posterior ao último encerramento.
  -- Sem isso, o "obrigado" que ficou sem resposta antes de encerrar reabria a
  -- espera de uma semana atrás no instante em que a conversa reabre (o status
  -- muda antes de a mensagem nova gravar `last_inbound_at`).
  v_espera boolean :=
    new.last_inbound_at is not null
    and (new.last_outbound_at is null or new.last_inbound_at > new.last_outbound_at)
    and (new.service_closed_at is null or new.last_inbound_at > new.service_closed_at)
    and new.status not in ('closed', 'resolved', 'archived');
begin
  if not v_espera then
    new.espera_desde := null;
  elsif tg_op = 'INSERT' then
    new.espera_desde := coalesce(new.espera_desde, new.last_inbound_at);
  elsif old.espera_desde is null then
    -- Saiu de "não espera" para "espera": começa na entrada que abriu a espera,
    -- nunca num valor que sobrou de outro ciclo.
    new.espera_desde := new.last_inbound_at;
  else
    -- Já esperando: mantém a PRIMEIRA sem resposta, que é o ponto da coluna.
    new.espera_desde := old.espera_desde;
  end if;
  return new;
end; $$;

revoke execute on function public.fn_conversations_espera_desde() from public, anon, authenticated;

-- Só cria se faltar: `drop` + `create` pegaria trava exclusiva de
-- `conversations` a cada `update.sh` (o mesmo cuidado do bloco da 0269). O
-- corpo da função é `create or replace` acima — é ele que evolui.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_conversations_espera_desde'
       and tgrelid = 'public.conversations'::regclass
  ) then
    create trigger trg_conversations_espera_desde
      before insert or update of last_inbound_at, last_outbound_at, status on public.conversations
      for each row execute function public.fn_conversations_espera_desde();
  end if;
end $$;

-- Backfill: quem espera hoje recebe a última entrada (a primeira sem resposta não
-- foi guardada antes desta migration — é a melhor aproximação que o dado permite).
update public.conversations
   set espera_desde = case
     when last_inbound_at is not null
      and (last_outbound_at is null or last_inbound_at > last_outbound_at)
      and (service_closed_at is null or last_inbound_at > service_closed_at)
      and status not in ('closed', 'resolved', 'archived')
     then coalesce(espera_desde, last_inbound_at)
   end
 where espera_desde is distinct from case
     when last_inbound_at is not null
      and (last_outbound_at is null or last_inbound_at > last_outbound_at)
      and (service_closed_at is null or last_inbound_at > service_closed_at)
      and status not in ('closed', 'resolved', 'archived')
     then coalesce(espera_desde, last_inbound_at)
   end;

create index if not exists conversations_org_espera_desde
  on public.conversations (organization_id, espera_desde)
  where espera_desde is not null;

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

  -- Para um time: a IA sai do comando (migration 0279). Time não tem agente de
  -- IA; quem transfere para um setor está pedindo gente.
  update public.conversations
     set team_id = p_team, assigned_to_user_id = null, assignee_kind = null,
         bot_silenced_until = case when p_team is not null then 'infinity'::timestamptz
                                   else bot_silenced_until end,
         updated_at = now()
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

notify pgrst, 'reload schema';
