-- 0280 · O SENTIMENTO DA CONVERSA — para a equipe ver, não só o robô.
--
-- O worker de sentimento (`workers/ai-sentiment-worker.ts`) classifica TODA
-- mensagem do cliente — com a IA ou com uma pessoa atendendo — e gravava a nota
-- só em `messages.metadata.sentiment_score`, mensagem por mensagem. Nenhuma tela
-- mostrava, e o único consumidor era a transferência automática. Pedido do dono
-- (2026-09-25): ver na conversa, no card e num filtro quem está insatisfeito,
-- para dar atenção.
--
-- A lista e o filtro precisam de uma COLUNA: ler a nota de cada mensagem de cada
-- card seria uma consulta por conversa. Duas colunas, as duas DO ATENDIMENTO:
--   · `sentimento_atual`  — a nota da última mensagem do cliente classificada;
--   · `sentimento_minimo` — a menor nota do atendimento em curso (o pior momento,
--     que o card sustenta mesmo depois de o cliente se acalmar um pouco);
--   · `sentimento_em`     — quando a última nota foi dada.
-- Atendimento novo (a conversa reabre: `service_started_at` avança) começa do
-- zero: a nota antiga não vale para o assunto novo.
--
-- Quem grava é `fn_registrar_sentimento_da_conversa`, chamada só pelo worker
-- (service_role). Nota de mensagem ANTERIOR à última gravada não sobrescreve o
-- atual (reprocessamento fora de ordem) — mas entra no mínimo, se for do mesmo
-- atendimento. Nota de mensagem de atendimento anterior é ignorada.
--
-- Idempotente: `add column if not exists`, `create or replace`.

alter table public.conversations add column if not exists sentimento_atual  numeric(4,3);
alter table public.conversations add column if not exists sentimento_minimo numeric(4,3);
alter table public.conversations add column if not exists sentimento_em     timestamptz;

comment on column public.conversations.sentimento_atual is
  'Nota de sentimento (0..1) da última mensagem do cliente classificada, no atendimento em curso (migration 0280).';
comment on column public.conversations.sentimento_minimo is
  'Menor nota de sentimento (0..1) do atendimento em curso (migration 0280).';

create or replace function public.fn_registrar_sentimento_da_conversa(
  p_org uuid, p_conversation uuid, p_score numeric, p_em timestamptz
) returns void language plpgsql set search_path = public as $$
declare
  c public.conversations;
  v_mesmo_atendimento boolean;
begin
  if p_score is null or p_score < 0 or p_score > 1 or p_em is null then return; end if;
  select * into c from public.conversations
   where id = p_conversation and organization_id = p_org for no key update;
  if not found then return; end if;
  -- Nota que chega depois do encerramento (worker atrasado) não reacende o selo.
  if c.status in ('closed', 'resolved', 'archived') then return; end if;
  -- Mensagem de um atendimento que já acabou não fala do atendimento de agora.
  if c.service_started_at is not null and p_em < c.service_started_at then return; end if;

  v_mesmo_atendimento := c.sentimento_em is not null
    and (c.service_started_at is null or c.sentimento_em >= c.service_started_at);

  update public.conversations set
    sentimento_minimo = case when v_mesmo_atendimento
                             then least(coalesce(sentimento_minimo, p_score), p_score)
                             else p_score end,
    sentimento_atual  = case when v_mesmo_atendimento and sentimento_em > p_em
                             then sentimento_atual else p_score end,
    sentimento_em     = case when v_mesmo_atendimento and sentimento_em > p_em
                             then sentimento_em else p_em end
  where id = p_conversation and organization_id = p_org;
end; $$;

revoke execute on function public.fn_registrar_sentimento_da_conversa(uuid, uuid, numeric, timestamptz) from public, anon, authenticated;
grant  execute on function public.fn_registrar_sentimento_da_conversa(uuid, uuid, numeric, timestamptz) to service_role;

-- Encerrar ZERA: o atendimento seguinte começa sem a nota do anterior, e a lista
-- (que filtra por coluna) não pode mostrar como insatisfeito quem voltou por
-- outro assunto. Trigger próprio, sem mexer em `fn_service_stamp_status`; criado
-- só se faltar — `drop` + `create` travaria `conversations` a cada `update.sh`.
create or replace function public.fn_conversations_sentimento_encerra()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('closed', 'resolved', 'archived')
     and old.status is distinct from new.status then
    new.sentimento_atual := null;
    new.sentimento_minimo := null;
    new.sentimento_em := null;
  end if;
  return new;
end; $$;
revoke execute on function public.fn_conversations_sentimento_encerra() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_conversations_sentimento_encerra'
       and tgrelid = 'public.conversations'::regclass
  ) then
    create trigger trg_conversations_sentimento_encerra
      before update of status on public.conversations
      for each row execute function public.fn_conversations_sentimento_encerra();
  end if;
end $$;

-- O filtro "Insatisfeitos" pede as conversas abertas com nota baixa.
create index if not exists conversations_org_sentimento_atual
  on public.conversations (organization_id, sentimento_atual)
  where sentimento_atual is not null;

notify pgrst, 'reload schema';
