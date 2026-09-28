-- 0286 — telefonia SIP: o número da operadora como canal, e a ligação como conversa.
--
-- Spec: docs/specs/20-spec-telefonia-sip.md. O atendente faz e recebe ligação
-- pelo CRM, pelos números SIP que o cliente já contratou. O Asterisk carrega o
-- áudio; o worker do CRM decide quem toca e registra tudo.
--
-- ─── O que muda no schema, e por que cada peça ─────────────────────────────
--
-- 1. `channel_sessions` ganha o provider `sip_trunk` e as colunas do tronco:
--    servidor, porta, transporte, usuário, senha CIFRADA e o time que recebe as
--    ligações. Um número = uma linha, como cada número oficial da Meta — é o que
--    dá "conectar mais de um número" sem tabela nova, e herda de graça a
--    unicidade `(organization_id, phone_number)` dos ativos, o arquivamento e a
--    tela de Conexões.
--
--    A senha vai por `fn_encrypt_oauth` (pgcrypto, chave só no servidor), o
--    mesmo caminho do token da Meta nesta mesma tabela. Nenhuma coluna guarda a
--    senha em claro, e nenhuma rota a devolve: a tela só ESCREVE.
--
--    `sip_team_id` é o time que recebe as ligações daquele número. `on delete
--    set null`: apagar o time não apaga o número; ele passa a tocar para
--    ninguém, e a tela mostra isso.
--
--    Unicidade de `(servidor, usuário)` entre os ativos, na instalação inteira:
--    duas linhas registrando a mesma conta disputariam as ligações recebidas —
--    a operadora entrega a INVITE a UM dos registros, e metade das ligações
--    iria parar na organização errada.
--
-- 2. `voice_calls` deixa de ser só do WaCalls. `provider` diz de onde veio a
--    ligação; `sip_call_ref` é o id dela no Asterisk; `wacalls_call_id` passa a
--    aceitar nulo, e um CHECK exige a referência certa de cada provider (a mesma
--    forma de `channel_sessions_provider_ref_check`). `conversation_id` liga a
--    ligação à conversa em que ela aparece; `team_id` guarda para que time ela
--    foi; `ringing_user_id` diz a quem ela está tocando AGORA — é o que faz o
--    banner de chamada recebida aparecer só para essa pessoa, e o que impede o
--    distribuidor de tocar duas ligações ao mesmo tempo para ela.
--
--    Default `provider = 'wacalls'`: toda linha existente é do WaCalls, e o
--    código do WaCalls continua inserindo sem saber que a coluna existe.
--
-- 3. `conversations.channel` aceita `'phone'` — o MEIO, não o provider (ver o
--    comentário da 0272). Ampliar CHECK não exige corrigir linha nenhuma.
--
-- Idempotente e auto-curativa: colunas com `if not exists`, CHECKs recriados
-- (drop + add), índices com `if not exists`. Nenhum dado a corrigir antes das
-- constraints: todas as linhas existentes já as satisfazem (provider 'wacalls'
-- com `wacalls_call_id` preenchido, que era NOT NULL até aqui).

alter table public.channel_sessions
  add column if not exists sip_server text,
  add column if not exists sip_port integer,
  add column if not exists sip_transport text,
  add column if not exists sip_username text,
  add column if not exists sip_password_encrypted bytea,
  add column if not exists sip_team_id uuid references public.attendance_teams(id) on delete set null;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_sip_transport_check;
alter table public.channel_sessions
  add constraint channel_sessions_sip_transport_check
  check (sip_transport is null or sip_transport = any (array['udp'::text, 'tcp'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_sip_port_check;
alter table public.channel_sessions
  add constraint channel_sessions_sip_port_check
  check (sip_port is null or (sip_port between 1 and 65535));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'site_widget'::text, 'sip_trunk'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'        and waha_session_name    is not null) or
    (provider = 'meta_cloud'  and meta_phone_number_id is not null) or
    (provider = 'zernio'      and zernio_account_id    is not null) or
    (provider = 'wacalls'     and wacalls_session_id   is not null) or
    (provider = 'site_widget' and site_widget_key      is not null) or
    (provider = 'sip_trunk'   and sip_username         is not null and sip_server is not null)
  );

create unique index if not exists channel_sessions_sip_conta_unique
  on public.channel_sessions (lower(sip_server), sip_username)
  where sip_username is not null and archived_at is null;

create index if not exists idx_channel_sessions_sip_team
  on public.channel_sessions (sip_team_id)
  where sip_team_id is not null;

comment on column public.channel_sessions.sip_server is
  'Servidor SIP da operadora (host ou IP), para o registro do tronco. NULL em canal que não é telefonia.';
comment on column public.channel_sessions.sip_username is
  'Usuário da conta SIP na operadora. Com sip_server, é a identidade do tronco — única entre os ativos da instalação: duas linhas registrando a mesma conta disputariam as ligações recebidas. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.sip_password_encrypted is
  'Senha da conta SIP cifrada com fn_encrypt_oauth (pgcrypto, chave só no servidor). Nenhuma rota a devolve; a tela só escreve.';
comment on column public.channel_sessions.sip_team_id is
  'Time que recebe as ligações deste número. NULL = ninguém atende (a tela mostra); apagar o time não apaga o número.';

alter table public.voice_calls
  add column if not exists provider text not null default 'wacalls',
  add column if not exists sip_call_ref text,
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists team_id uuid references public.attendance_teams(id) on delete set null,
  add column if not exists ringing_user_id uuid references auth.users(id) on delete set null;

alter table public.voice_calls alter column wacalls_call_id drop not null;

alter table public.voice_calls
  drop constraint if exists voice_calls_provider_check;
alter table public.voice_calls
  add constraint voice_calls_provider_check
  check (provider = any (array['wacalls'::text, 'sip_trunk'::text]));

alter table public.voice_calls
  drop constraint if exists voice_calls_provider_ref_check;
alter table public.voice_calls
  add constraint voice_calls_provider_ref_check check (
    (provider = 'wacalls'   and wacalls_call_id is not null) or
    (provider = 'sip_trunk' and sip_call_ref    is not null)
  );

create unique index if not exists voice_calls_org_sip_call_ref_unique
  on public.voice_calls (organization_id, sip_call_ref)
  where sip_call_ref is not null;

create index if not exists idx_voice_calls_conversation
  on public.voice_calls (conversation_id)
  where conversation_id is not null;

-- "Em outra ligação": a pergunta do distribuidor a cada toque. Parcial nas
-- ligações vivas — o histórico inteiro não entra no índice.
create index if not exists idx_voice_calls_vivas_por_atendente
  on public.voice_calls (organization_id, owner_user_id)
  where status <> 'ended';

comment on column public.voice_calls.provider is
  'De onde veio a ligação: wacalls (voz do WhatsApp) ou sip_trunk (telefonia SIP, spec 20). Default wacalls: toda linha anterior à 0286 é do WaCalls.';
comment on column public.voice_calls.sip_call_ref is
  'Id da ligação no Asterisk (linkedid da perna que a originou). Único por organização — é a chave de idempotência dos eventos do worker.';
comment on column public.voice_calls.ringing_user_id is
  'A quem a ligação recebida está tocando agora. Só o banner dessa pessoa aparece; o distribuidor não toca outra ligação para ela enquanto isto estiver preenchido.';

alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
  check (channel = any (array['whatsapp'::text, 'site_chat'::text, 'phone'::text]));

notify pgrst, 'reload schema';
