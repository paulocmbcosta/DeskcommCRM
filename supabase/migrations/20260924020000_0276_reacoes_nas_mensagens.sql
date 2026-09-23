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
-- Na mesma entrega, duas funções de apoio: `fn_mesclar_metadata_da_mensagem`
-- (os workers de sentimento e de mídia regravavam a cópia lida de `metadata` e
-- apagariam uma reação dada no meio) e `fn_nomes_dos_usuarios` (o nome de
-- quem enviou cada mensagem, DYD-13, numa chamada por página).
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
  v_em timestamptz := coalesce(p_em, now());
begin
  if p_lado is null or p_lado not in ('contato', 'empresa') then
    raise exception 'lado_invalido: %', p_lado using errcode = '22023';
  end if;

  -- A reação é gravada SEMPRE como `{emoji, em, …}` — inclusive a remoção,
  -- que vira `emoji: ""` com horário (o leitor a ignora). É o horário que
  -- decide: uma reação mais VELHA que a gravada (reentrega da Meta depois de um
  -- 5xx, ou dois eventos em ordem invertida) não sobrescreve a nova, e uma
  -- reação atrasada não ressuscita a que o cliente já tirou.
  update public.messages m
     set metadata = jsonb_set(
           coalesce(m.metadata, '{}'::jsonb)
             || jsonb_build_object('reacoes', coalesce(m.metadata -> 'reacoes', '{}'::jsonb)),
           array['reacoes', p_lado],
           jsonb_strip_nulls(jsonb_build_object(
             'emoji', coalesce(p_emoji, ''),
             'em', v_em,
             'user_id', p_user,
             'external_id', p_external_id
           ))
         ),
         updated_at = now()
   where m.organization_id = p_org
     and case
           when p_alvo_id is not null then m.id = p_alvo_id
           else m.external_id = p_alvo_external_id
         end
     and coalesce((m.metadata #>> array['reacoes', p_lado, 'em'])::timestamptz, '-infinity'::timestamptz) <= v_em
  returning m.id into v_id;

  return v_id;
end;
$$;

comment on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) is
  'Grava (ou tira, com emoji vazio) a reação de um lado — contato ou empresa — em messages.metadata.reacoes, num UPDATE só. Um lado tem UMA reação por mensagem, como no WhatsApp: a nova substitui a anterior, e uma mais VELHA que a gravada não vale (reentrega/ordem invertida). Devolve o id da mensagem alvo, ou NULL quando ela não está nesta organização ou o evento é mais velho (migration 0276).';

revoke execute on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz) to service_role;

-- Merge atômico em `messages.metadata`. Os workers de sentimento e de mídia
-- liam a linha, esperavam segundos (LLM, download) e regravavam
-- `{...metadata_lido, chave}` — apagando o que outro escritor pôs no meio,
-- como a reação que o atendente acabou de dar. `||` no banco não tem janela.
create or replace function public.fn_mesclar_metadata_da_mensagem(p_org uuid, p_id uuid, p_patch jsonb)
returns boolean
language sql
set search_path = public
as $$
  with feito as (
    update public.messages m
       set metadata = coalesce(m.metadata, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
           updated_at = now()
     where m.organization_id = p_org and m.id = p_id
    returning 1
  )
  select exists (select 1 from feito);
$$;

comment on function public.fn_mesclar_metadata_da_mensagem(uuid, uuid, jsonb) is
  'Acrescenta chaves a messages.metadata sem ler-e-reescrever: quem regravava a cópia lida apagava a chave que outro escritor pôs no meio (migration 0276).';

revoke execute on function public.fn_mesclar_metadata_da_mensagem(uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.fn_mesclar_metadata_da_mensagem(uuid, uuid, jsonb) to service_role;

-- O nome de exibição de VÁRIOS usuários numa chamada — a régua de
-- `fn_nome_do_usuario` (0270). O histórico da conversa pedia um nome por
-- pessoa, a cada releitura; uma página tem uma chamada só.
create or replace function public.fn_nomes_dos_usuarios(p_users uuid[])
returns table (user_id uuid, nome text)
language sql
stable
set search_path = public
as $$
  select u, public.fn_nome_do_usuario(u) from unnest(p_users) as u;
$$;

comment on function public.fn_nomes_dos_usuarios(uuid[]) is
  'Nome de exibição (full_name ou o que vem antes do @ do e-mail) de vários usuários numa chamada. Só service_role: quem chama já filtrou os ids pela organização (migration 0276).';

revoke execute on function public.fn_nomes_dos_usuarios(uuid[]) from public, anon, authenticated;
grant  execute on function public.fn_nomes_dos_usuarios(uuid[]) to service_role;

notify pgrst, 'reload schema';
