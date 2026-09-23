-- 0276 · Reação com emoji nas mensagens — do cliente e do atendente.
--
-- Medido antes desta migration (2026-09-23): quando o cliente reagia a uma
-- mensagem no canal oficial, a ingestão gravava uma MENSAGEM NOVA do tipo
-- `reaction`, sem corpo — a conversa ganhava um balão vazio, a prévia da lista
-- virava "[reaction]" e o agente de IA acordava para responder a um 👍. E o
-- atendente não tinha como reagir.
--
-- A reação não é mensagem: é um estado DA mensagem alvo. No WhatsApp cada
-- lado tem UMA reação por mensagem (a nova substitui, a vazia remove), e o
-- lado da empresa é um só — o número —, não um por atendente. Por isso ela
-- mora em `messages.metadata.reacoes.{contato|empresa}` = `{emoji, em,
-- user_id?, external_id?}`, com o schema central em `lib/messaging/reacoes.ts`.
--
-- Por que uma função, e não um UPDATE da aplicação: a gravação é um
-- ler-e-reescrever de `metadata`, e fazê-lo em dois passos perderia a chave que
-- outro escritor mudou no meio. Aqui é um UPDATE só, com `jsonb_set`/`#-`.
--
-- Quem chama é o `service_role` (o webhook, cuja organização vem do token do
-- path, e a rota do atendente, que confere o acesso à mensagem pela RLS antes).
-- `security invoker` e fechada a public/anon/authenticated (item 9 da doutrina).
-- Idempotente; nenhuma tabela, coluna ou constraint nova.

create or replace function public.fn_registrar_reacao(
  p_org uuid,
  p_alvo_id uuid,
  p_alvo_external_id text,
  p_lado text,
  p_emoji text,
  p_user uuid,
  p_external_id text,
  p_em timestamptz
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_lado is null or p_lado not in ('contato', 'empresa') then
    raise exception 'lado_invalido: %', p_lado using errcode = '22023';
  end if;

  update public.messages m
     set metadata = case
           when coalesce(p_emoji, '') = '' then
             coalesce(m.metadata, '{}'::jsonb) #- array['reacoes', p_lado]
           else
             jsonb_set(
               coalesce(m.metadata, '{}'::jsonb)
                 || jsonb_build_object('reacoes', coalesce(m.metadata -> 'reacoes', '{}'::jsonb)),
               array['reacoes', p_lado],
               jsonb_strip_nulls(jsonb_build_object(
                 'emoji', p_emoji,
                 'em', coalesce(p_em, now()),
                 'user_id', p_user,
                 'external_id', p_external_id
               ))
             )
         end,
         updated_at = now()
   where m.organization_id = p_org
     and case
           when p_alvo_id is not null then m.id = p_alvo_id
           else m.external_id = p_alvo_external_id
         end
  returning m.id into v_id;

  return v_id;
end;
$$;

comment on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) is
  'Grava (ou tira, com emoji vazio) a reação de um lado — contato ou empresa — em messages.metadata.reacoes, num UPDATE só. Um lado tem UMA reação por mensagem, como no WhatsApp: a nova substitui a anterior. Devolve o id da mensagem alvo, ou NULL quando ela não está nesta organização (migration 0276).';

revoke execute on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) to service_role;

notify pgrst, 'reload schema';
