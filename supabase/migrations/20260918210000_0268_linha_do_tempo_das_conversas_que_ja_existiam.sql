-- ---- a linha do tempo das conversas que já existiam (migration 0268) ----
--
-- Forward-fix da 0266 (já aplicada, então não se edita). O backfill dela deu um
-- ATENDIMENTO, com protocolo, a cada conversa que já existia — mas não escreveu
-- evento nenhum. Medido em produção logo depois da v1.30.0: 12 conversas, 12
-- protocolos, ZERO linhas em `conversation_events`. Quem abrisse a aba "Linha do
-- tempo" de qualquer conversa antiga lia "Nada registrado neste atendimento
-- ainda." sobre um atendimento que tinha dia e hora de abertura conhecidos.
--
-- Só entram os DOIS fatos que o banco de fato observou: quando o atendimento
-- começou (`started_at`) e, se for o caso, quando terminou (`closed_at`) — com o
-- carimbo ORIGINAL, não o de agora. Quem assumiu, para que time foi, quando o
-- automático parou: nada disso tem registro confiável no legado, e linha
-- inventada é pior que linha ausente.
--
-- `backfill: true` no payload é o que deixa a tela dizer só o que sabe: no
-- encerramento legado não se afirma "por quem" nem "automaticamente".
--
-- Idempotente pelo `not exists` POR TIPO: o atendimento criado depois da 0266 já
-- tem o seu `opened` (escrito pelo trigger) e não ganha um segundo; o legado que
-- foi fechado depois da atualização já tem o `closed` do trigger e ganha só o
-- `opened` que faltava.
insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, payload, created_at)
select a.organization_id, a.conversation_id, a.id, 'opened', 'system',
       jsonb_build_object('protocol', a.protocol, 'channel', c.channel, 'backfill', true), a.started_at
  from public.atendimentos a
  join public.conversations c on c.id = a.conversation_id
 where not exists (select 1 from public.conversation_events e where e.atendimento_id = a.id and e.type = 'opened');

insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload, created_at)
select a.organization_id, a.conversation_id, a.id, 'closed',
       case when a.closed_by_user_id is null then 'system' else 'user' end, a.closed_by_user_id, a.closed_by_name,
       jsonb_build_object('protocol', a.protocol, 'status', coalesce(a.closed_status, 'closed'), 'backfill', true), a.closed_at
  from public.atendimentos a
 where a.closed_at is not null
   and not exists (select 1 from public.conversation_events e where e.atendimento_id = a.id and e.type = 'closed');
