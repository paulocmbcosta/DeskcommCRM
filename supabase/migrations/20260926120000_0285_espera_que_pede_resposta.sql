-- 0285 — A espera que pede resposta.
--
-- A Assistente (Jev) dispensa a espera quando a fala do cliente não pede
-- resposta ("ok, obrigado"). A dispensa é a RPC `fn_dispensar_espera` (mais
-- abaixo), chamada pelo worker `workers/espera-da-assistente.ts`: um UPDATE em
-- `espera_desde` condicionado a nada ter mudado, com o evento na mesma
-- transação. Toda entrada do cliente desfaz a dispensa
-- (`fn_mark_conversation_message`). Este trigger:
--   · não ressuscita espera dispensada num UPDATE de status;
--   · desfaz a dispensa quando o cliente escreve de novo (conta da nova);
--   · limpa dispensa e trava humana quando o ciclo termina (resposta/encerramento).
-- As colunas novas ficam FORA da lista de colunas do trigger de propósito: o
-- UPDATE da dispensa e o da religada não o disparam.

alter table public.conversations add column if not exists espera_dispensada_ate   timestamptz;
alter table public.conversations add column if not exists espera_dispensada_desde timestamptz;
alter table public.conversations add column if not exists espera_mantida_em       timestamptz;

comment on column public.conversations.espera_dispensada_ate is
  'A last_inbound_at que a Assistente julgou não pedir resposta. Não-nula = dispensa ativa (espera_desde nulo). Migration 0285.';
comment on column public.conversations.espera_dispensada_desde is
  'O espera_desde suspenso pela dispensa, devolvido por "Contar mesmo assim". Migration 0285.';
comment on column public.conversations.espera_mantida_em is
  'Quando um humano mandou contar mesmo assim: a Assistente não dispensa até o ciclo de espera terminar. Migration 0285.';

create or replace function public.fn_conversations_espera_desde()
returns trigger language plpgsql set search_path = public as $$
declare
  v_sem_resposta boolean :=
    new.last_inbound_at is not null
    and (new.last_outbound_at is null or new.last_inbound_at > new.last_outbound_at)
    and (new.service_closed_at is null or new.last_inbound_at > new.service_closed_at)
    and new.status not in ('closed', 'resolved', 'archived');
  v_dispensada boolean :=
    v_sem_resposta
    and new.espera_dispensada_ate is not null
    and new.last_inbound_at <= new.espera_dispensada_ate;
begin
  if not v_dispensada then
    new.espera_dispensada_ate := null;
    new.espera_dispensada_desde := null;
  end if;
  if not v_sem_resposta then
    new.espera_mantida_em := null;
  end if;

  if not v_sem_resposta or v_dispensada then
    new.espera_desde := null;
  elsif tg_op = 'INSERT' then
    new.espera_desde := coalesce(new.espera_desde, new.last_inbound_at);
  elsif old.espera_desde is null then
    new.espera_desde := new.last_inbound_at;
  else
    new.espera_desde := old.espera_desde;
  end if;
  return new;
end; $$;

revoke execute on function public.fn_conversations_espera_desde() from public, anon, authenticated;

-- ---- 0285: toda entrada do cliente desfaz a dispensa ----
-- O carimbo do provedor vem em SEGUNDOS e `last_inbound_at` é um `greatest`:
-- uma fala nova no mesmo segundo da dispensada — ou uma fala atrasada, com
-- carimbo anterior — não mudava `last_inbound_at`, e o trigger lia "ainda é a
-- fala dispensada". Na dúvida a espera conta: toda entrada zera a dispensa, e
-- o trigger (disparado por `last_inbound_at` na lista do SET) volta a contar
-- a partir de `last_inbound_at`. Mesmo corpo da versão anterior (apêndice
-- "Agregados não podem tornar mensagem atrasada um sinal operacional recente"),
-- só com as duas atribuições novas; assinatura, security e grants iguais.
create or replace function public.fn_mark_conversation_message(p_conv uuid,p_direction text,p_preview text,p_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid;
begin
 select * into c from public.conversations where id=p_conv;
 if not found then return; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=p_conv for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_direction='inbound' and p_at<=c.service_closed_at then return; end if;
 update public.conversations set
  last_message_at=greatest(last_message_at,p_at),
  last_message_preview=case when last_message_at is null or p_at>=last_message_at then p_preview else last_message_preview end,
  last_inbound_at=case when p_direction='inbound' then greatest(last_inbound_at,p_at) else last_inbound_at end,
  last_outbound_at=case when p_direction='outbound' then greatest(last_outbound_at,p_at) else last_outbound_at end,
  unread_count_for_assignee=case when p_direction='inbound' then unread_count_for_assignee+1 when p_direction='outbound' then 0 else unread_count_for_assignee end,
  espera_dispensada_ate=case when p_direction='inbound' then null else espera_dispensada_ate end,
  espera_dispensada_desde=case when p_direction='inbound' then null else espera_dispensada_desde end
 where id=p_conv and organization_id=c.organization_id;
 update public.contacts set last_activity_at=greatest(last_activity_at,p_at)
 where id=c.contact_id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) to service_role;

-- ---- 0285: a dispensa, numa transação só ----
-- O worker chama isto DEPOIS de o Jev responder. Condicional a nada ter mudado
-- desde a leitura: a mesma espera, a mesma última entrada, sem trava humana e
-- — o que o carimbo em segundos não enxerga — nenhuma entrada gravada DEPOIS
-- da mensagem que disparou a pergunta (`messages.created_at` é do servidor, em
-- microssegundos). A linha da conversa é travada ANTES dessa conferência: uma
-- entrada que chegar depois espera o commit e, pelo `fn_mark_conversation_message`
-- acima, desfaz a dispensa. O evento `espera_dispensada` entra na MESMA
-- transação — dispensa sem evento (ou evento sem dispensa) não existe.
create or replace function public.fn_dispensar_espera(
  p_org uuid, p_conversation uuid, p_espera_desde timestamptz, p_last_inbound_at timestamptz,
  p_mensagem uuid, p_payload jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_criada timestamptz; v_enviada timestamptz;
begin
  perform 1 from public.conversations
   where id = p_conversation and organization_id = p_org
   for no key update;
  if not found then return false; end if;

  select created_at, sent_at into v_criada, v_enviada from public.messages
   where id = p_mensagem and organization_id = p_org and conversation_id = p_conversation and direction = 'inbound';
  if not found then return false; end if;

  -- `and m.sent_at >= v_enviada - interval '1 day'` usa o
  -- `idx_messages_conversation_sent (conversation_id, sent_at desc)`; sem ele
  -- este EXISTS varre a conversa inteira por `created_at`, que não tem índice,
  -- segurando o `for no key update` da conversa acima. A janela de 1 dia é
  -- generosa contra o relógio do provedor (`last_inbound_at` já é um
  -- `greatest`) e ainda assim segura: uma entrada rara que ficasse FORA da
  -- janela e comitasse só depois deste SELECT chegaria depois do lock e, pelo
  -- `fn_mark_conversation_message`, desfaria a dispensa — o pior caso é a
  -- espera voltar a ser contada, nunca ela sumir.
  if exists (
    select 1 from public.messages m
     where m.organization_id = p_org and m.conversation_id = p_conversation
       and m.direction = 'inbound' and m.id <> p_mensagem and m.created_at >= v_criada
       and m.sent_at >= v_enviada - interval '1 day'
  ) then
    return false;
  end if;

  update public.conversations
     set espera_dispensada_desde = espera_desde,
         espera_dispensada_ate   = last_inbound_at,
         espera_desde            = null
   where id = p_conversation and organization_id = p_org
     and espera_desde = p_espera_desde
     and last_inbound_at = p_last_inbound_at
     and espera_mantida_em is null;
  if not found then return false; end if;

  perform public.fn_conversation_event_add(p_org, p_conversation, 'espera_dispensada', null, coalesce(p_payload, '{}'::jsonb));
  return true;
end; $$;
revoke execute on function public.fn_dispensar_espera(uuid, uuid, timestamptz, timestamptz, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.fn_dispensar_espera(uuid, uuid, timestamptz, timestamptz, uuid, jsonb) to service_role;

-- ---- cura 0285: início ----
-- O backfill da 0279 (bloco "-- Backfill: quem espera hoje recebe a última
-- entrada", em supabase/baseline.sql) roda em TODO update.sh e não conhece a
-- dispensa — ela nasceu depois. Ele reescreve `espera_desde` a partir de
-- `last_inbound_at` sempre que a conversa está "sem resposta", inclusive
-- quando a dispensa está ativa (`espera_desde` nulo DE PROPÓSITO). Essa
-- reescrita não passa pelas colunas do trigger (só toca `espera_desde`), então
-- ele não dispara: sem esta cura, todo `update.sh` deixaria `espera_desde` E
-- `espera_dispensada_ate` preenchidos ao mesmo tempo — o termômetro
-- ressuscitado numa conversa que a Assistente dispensou. No baseline, este
-- bloco entra DEPOIS do apêndice da 0279 na ordem de aplicação, então desfaz
-- exatamente essa ressurreição na mesma passada. Idempotente: só toca a linha
-- que a dispensa cobre.
update public.conversations
   set espera_desde = null
 where espera_dispensada_ate is not null
   and espera_desde is not null
   and last_inbound_at <= espera_dispensada_ate;

-- Segundo passo, DEPOIS do primeiro (que já zerou a ressurreição da dispensa
-- legítima): a dispensa VENCIDA — que um banco pode carregar de antes de toda
-- entrada desfazê-la (ver fn_mark_conversation_message acima) — sai. Vencida é
-- a que convive com `espera_desde` preenchido, a que é mais velha que a última
-- entrada, ou a de conversa que não espera mais ninguém (respondida, com o
-- atendimento fechado depois da entrada, ou encerrada). A espera fica como o
-- trigger a deixaria: conta desde a última entrada se a conversa espera, nula
-- se não. Só colunas fora da lista do trigger: ele não dispara. Idempotente.
update public.conversations
   set espera_dispensada_ate   = null,
       espera_dispensada_desde = null,
       espera_desde = case
         when last_inbound_at is not null
          and (last_outbound_at is null or last_inbound_at > last_outbound_at)
          and (service_closed_at is null or last_inbound_at > service_closed_at)
          and status not in ('closed', 'resolved', 'archived')
         then coalesce(espera_desde, last_inbound_at)
       end
 where espera_dispensada_ate is not null
   and (
     espera_desde is not null
     or last_inbound_at > espera_dispensada_ate
     or not (
       last_inbound_at is not null
       and (last_outbound_at is null or last_inbound_at > last_outbound_at)
       and (service_closed_at is null or last_inbound_at > service_closed_at)
       and status not in ('closed', 'resolved', 'archived')
     )
   );
-- ---- cura 0285: fim ----
