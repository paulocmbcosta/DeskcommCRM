-- 0272 — canal "chat do site": o widget que o dono cola no próprio site.
--
-- Até aqui todo canal de mensagem era WhatsApp por um transporte diferente
-- (QR, oficial, intermediado). Este é o primeiro que NÃO é WhatsApp: o visitante
-- escreve num balão dentro do site do cliente, e a conversa nasce no Inbox como
-- qualquer outra — com lead, agente de IA e follow-up, porque passa pelo mesmo
-- `aplicarEfeitosPosEntrada` dos outros três.
--
-- ─── O que muda no schema, e por que cada peça ─────────────────────────────
--
-- 1. `channel_sessions.site_widget_key` — o identificador PÚBLICO do widget,
--    o que vai no `<script data-widget-key="…">` colado no site. É a coluna de
--    ref deste provider (mesmo papel de `waha_session_name`/`zernio_account_id`)
--    e é o que a rota pública usa para descobrir a organização — fonte confiável
--    do tenant, nunca o corpo do pedido.
--
--    Por que NÃO reusar `webhook_path_token`: aquele é o token de um webhook
--    servidor-a-servidor, que ninguém publica. Este vai em HTML aberto na
--    internet. São dois graus de exposição, e reusar a coluna faria um vazamento
--    de um virar vazamento do outro.
--
--    ÚNICO entre TODAS as linhas, não só entre as ativas (a 0165 usa
--    `archived_at is null` para os identificadores de provider externo). A
--    diferença é deliberada: o id de um provider externo pode legitimamente ser
--    reconectado depois de arquivado; a chave de um widget é gerada por nós e
--    fica colada em sites de terceiros. Se uma chave arquivada pudesse renascer
--    noutra linha, o snippet esquecido no site de um cliente passaria a abrir
--    conversa na organização de OUTRO.
--
-- 2. `channel_sessions.site_widget_config jsonb` — título, cores, mensagem de
--    boas-vindas, posição, formulário inicial e domínios permitidos. Coluna
--    própria e não uma chave de `metadata`: `metadata` já carrega `ai_gate` e
--    o estado do modo de teste, e salvar a aparência do widget com um
--    `update … set metadata = …` apagaria os dois. O schema central é
--    `lib/channels/chat-do-site/config.ts` (Zod) — a tela e a rota pública leem por
--    ele, nunca pelo path cru (anti-pattern 6 do CLAUDE.md).
--
-- 3. `channel_sessions.site_widget_seen_at` / `site_widget_seen_host` — quando e
--    em que site o widget foi carregado pela última vez. É a prova, para o dono,
--    de que o snippet que ele colou está no ar; sem isto a tela só saberia dizer
--    "criado", nunca "instalado" (invariante 6 do sistema vivo: configuração tem
--    superfície, e o que FALTA aparece).
--
--    Duas colunas e não uma chave em `metadata`: a rota pública grava isto a
--    cada carga de página, e `metadata` guarda o gate da IA do canal. Um
--    ler-mesclar-gravar ali disputaria corrida com a RPC que abre e fecha o robô
--    ao público — e perder essa corrida reabriria (ou fecharia) a IA sem ninguém
--    pedir. `update` de coluna própria não toca em nada além dela.
--
-- 4. `conversations_channel_check` passa a aceitar `'site_chat'`. A coluna dizia
--    `channel = 'whatsapp'` porque só existia WhatsApp; gravar `'whatsapp'`
--    numa conversa que veio do site seria mentir no dado. Ampliar CHECK não
--    exige corrigir linha nenhuma: toda linha existente já satisfaz a versão
--    nova.
--
--    O valor é `'site_chat'` e NÃO o nome do provider, de propósito:
--    `conversations.channel` é o MEIO pelo qual a pessoa fala (WhatsApp, chat do
--    site), e `channel_sessions.provider` é o TRANSPORTE. Já era assim — três
--    providers diferentes gravam `'whatsapp'` aqui. Feature pode ler o meio;
--    nome de provider fora de `lib/channels/` o `lint:channels` reprova.
--
-- O token do VISITANTE não ganha coluna: o que o banco guarda é o SHA-256 dele
-- em `conversations.provider_conversation_id` (0132) — "o id que o provider dá
-- a esta thread", e aqui o provider somos nós. O texto em claro existe só no
-- navegador de quem conversa, pela mesma regra do bearer token da API.
--
-- Idempotente e auto-curativa: colunas nullable com `if not exists`, CHECKs
-- recriados (drop + add) porque precisam MUDAR num clone que já tem a versão
-- anterior, índice com `if not exists`. Nenhum dado a corrigir antes de
-- nenhuma constraint.

alter table public.channel_sessions
  add column if not exists site_widget_key text,
  add column if not exists site_widget_config jsonb,
  add column if not exists site_widget_seen_at timestamptz,
  add column if not exists site_widget_seen_host text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'site_widget'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'        and waha_session_name    is not null) or
    (provider = 'meta_cloud'  and meta_phone_number_id is not null) or
    (provider = 'zernio'      and zernio_account_id    is not null) or
    (provider = 'wacalls'     and wacalls_session_id   is not null) or
    (provider = 'site_widget' and site_widget_key      is not null)
  );

create unique index if not exists channel_sessions_site_widget_key_unique
  on public.channel_sessions (site_widget_key)
  where site_widget_key is not null;

comment on column public.channel_sessions.site_widget_key is
  'Identificador PÚBLICO do widget de chat do site — vai no snippet colado no HTML do cliente e resolve a organização na rota pública. Único entre todas as linhas (inclusive arquivadas): chave reaproveitada faria o snippet antigo de um cliente abrir conversa na organização de outro. Espelhado em lib/channels/session-ref.ts.';

comment on column public.channel_sessions.site_widget_config is
  'Aparência e comportamento do widget (título, cor, boas-vindas, posição, formulário inicial, domínios permitidos). Schema central em lib/channels/chat-do-site/config.ts; NULL em canal que não é chat do site.';

comment on column public.channel_sessions.site_widget_seen_at is
  'Última vez que o widget foi carregado num site (rota pública de configuração, no máximo uma escrita a cada 5 min). NULL = o snippet ainda não foi visto em lugar nenhum — é o que a tela de Conexões mostra como "ainda não instalado".';

comment on column public.channel_sessions.site_widget_seen_host is
  'hostname do site que carregou o widget por último (do header Origin). Só o host: caminho e query de site alheio não são nossos para guardar.';

alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
  check (channel = any (array['whatsapp'::text, 'site_chat'::text]));

notify pgrst, 'reload schema';
