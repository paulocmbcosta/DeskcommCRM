-- 0273 · O rodízio respeita a IA que está atendendo.
--
-- Medido em produção em 2026-09-21 (v1.34.1, organização em `round_robin`, agente
-- publicado no canal oficial): o cron de roteamento entregava a conversa ao
-- atendente online dois segundos depois de ela nascer — `fn_channel_routing_claim`
-- grava `assignee_kind = 'user'` — e o motor pulava o turno por
-- `conversa_de_humano` (`lib/ai/elegibilidade/gate.ts`). Soltar a conversa não
-- adiantava: `fn_routing_assignment_changed` pedia o rodízio de novo e ele
-- reatribuía em menos de um minuto. Com qualquer atendente online, a IA não
-- respondia NINGUÉM.
--
-- O fluxo definido pelo dono do produto: a IA atende primeiro; a conversa só entra
-- no rodízio quando SAI da IA — a transferência para um time cala a IA e pede o
-- rodízio daquele time (`performHumanHandoff`), ou a IA não vai atendê-la (nenhum
-- agente automático no canal, contato fora da lista de teste, passagem já feita).
--
-- Esta função é a metade SQL da pergunta que o rodízio (`lib/routing/worker.ts`)
-- faz antes de distribuir: há IA AUTOMÁTICA no ar neste canal? A outra metade é a
-- trava de elegibilidade da conversa, que continua sendo a do motor (TypeScript).
--
-- "No ar" é a régua da tela (`lib/ai/agents/no-ar.ts`): não arquivado, não pausado,
-- com versão publicada — e, como no portão de capacidade do drain
-- (`lib/agent-engine/edge/crm/drain.ts`), a versão ligada ao canal OU um roteador
-- ativo no canal que a alcança (fallback ou membro). Agente ASSISTIDO alcançando o
-- canal ⇒ quem envia é uma pessoa (o drain desliga a trava e segue o assistido),
-- então a resposta é NÃO e o rodízio distribui.
--
-- `security invoker`: não há nada a esconder de quem já lê essas tabelas, e quem
-- chama é o service role do cron. Os dois revokes de sempre (CLAUDE.md, item 9 da
-- doutrina de migrations): o default privilege do baseline concede EXECUTE a anon
-- em toda função nova, e o Postgres concede a PUBLIC ao criar.
--
-- Idempotente: `create or replace`, revokes e grant repetíveis. Sem dado a corrigir.

create or replace function public.fn_ia_automatica_no_canal(p_org uuid, p_channel uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  with no_ar as (
    select a.id, a.operation_mode, v.channel_session_id
      from public.ai_agents a
      join public.ai_agent_versions v
        on v.id = a.published_version_id and v.organization_id = a.organization_id
     where a.organization_id = p_org
       and a.archived_at is null
       and a.paused_at is null
       and v.status = 'published'
  ),
  alcanca_o_canal as (
    select n.operation_mode
      from no_ar n
     where n.channel_session_id = p_channel
        or exists (
             select 1
               from public.ai_routers r
              where r.organization_id = p_org
                and r.channel_session_id = p_channel
                and r.is_active
                and (r.fallback_agent_id = n.id
                     or exists (select 1 from public.ai_router_members m
                                 where m.router_id = r.id and m.agent_id = n.id))
           )
  )
  select exists (select 1 from alcanca_o_canal where operation_mode = 'automatic')
     and not exists (select 1 from alcanca_o_canal where operation_mode = 'assisted');
$$;

comment on function public.fn_ia_automatica_no_canal(uuid, uuid) is
  'O rodízio pergunta antes de distribuir: há IA automática no ar neste canal? Sim + conversa elegível (gate.ts) ⇒ a IA atende e ninguém recebe a conversa (migration 0273).';

revoke execute on function public.fn_ia_automatica_no_canal(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.fn_ia_automatica_no_canal(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
