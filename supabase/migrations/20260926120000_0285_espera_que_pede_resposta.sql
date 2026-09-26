-- 0285 — A espera que pede resposta.
--
-- A Assistente (Jev) dispensa a espera quando a fala do cliente não pede
-- resposta ("ok, obrigado"). A dispensa é um UPDATE direto em `espera_desde`
-- feito pelo worker `workers/espera-da-assistente.ts`, condicionado a nada ter
-- mudado. Este trigger:
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
