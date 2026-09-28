-- 0288 — telefonia, fase 2, versão 1: URA (menu de voz) e falas.
--
-- Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md
-- (§3.1, §4, §5.1, §5.2). Fase 1: docs/specs/20-spec-telefonia-sip.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `phone_prompts` — uma linha por fala SALVA (menu, tecla inválida, aguarde,
--    ninguém atendeu, fora do horário, aviso de instabilidade). O áudio mora no
--    bucket privado `phone-prompts`, em `<org>/<sha256(modelo, voz, texto)>.ulaw`;
--    a linha diz qual texto, qual voz e se está pronta (`ready`) ou falhou
--    (`failed` + o motivo em `error`). A v1 só grava `ready`: a linha nasce no
--    "Salvar e usar" de uma prévia que já está no Storage (desenho D15) — a
--    prévia em si é só objeto no Storage, sem linha. `failed` fica reservado.
--    O CHECK do caminho amarra o arquivo à organização e ao hash: o worker
--    escreve esse caminho no disco, e um valor gravado por fora (psql, um clone
--    antigo) não aponta para fora da pasta da organização.
-- 2. `phone_settings` — uma linha por organização: a voz da ElevenLabs e as três
--    falas gerais (aguarde, ninguém atendeu, fora do horário).
-- 3. `phone_menus` + `phone_menu_options` — o menu é da ORGANIZAÇÃO (D2) e serve a
--    vários números. FK COMPOSTA para `attendance_teams(organization_id, id)`: é o
--    que torna impossível, e não só improvável, uma opção levar ao time de outra
--    organização. `accepts_extension` nasce aqui e só é usada na versão 3.
-- 4. `channel_sessions.sip_menu_id` — o número aponta para um time OU um menu,
--    nunca os dois (CHECK). Linha com os dois (impossível até aqui) mantém o time.
-- 5. `attendance_teams.phone_emergency_*` — o aviso de instabilidade é do TIME
--    (D7): a fala, desde quando está ligado, até quando (nulo = até alguém
--    desligar) e quem ligou. CHECK de coerência; linha incoerente é desligada
--    ANTES de o CHECK entrar.
-- 6. `voice_calls` — o que o menu fez (`menu_id`, `menu_digit`, `menu_outcome`) e
--    quando o cliente ouviu o aviso inteiro (`emergency_heard_at`). `end_reason`
--    ganha `after_hours` sem migration: é coluna de vocabulário aberto.
-- 7. `agent_inbox_items.kind` ganha `phone_prompt_unplayable` (a fala não tocou
--    e a ligação seguiu sem ela) e `phone_emergency_expired` (o aviso venceu e
--    desligou sozinho). No baseline, quem muda é o bloco ÚNICO da constraint.
-- 8. Bucket PRIVADO `phone-prompts`, sem policy em `storage.objects`: só o
--    cliente de serviço (API e worker) lê e grava.
--
-- Segurança: as quatro tabelas novas têm RLS com UMA policy,
-- `tenant_isolation_<tabela>_select` (`for select`, leitura para membros da
-- organização), e GRANT só de SELECT — a escrita é da API, com a organização
-- resolvida da sessão, e do worker, os dois pela conexão direta ao Postgres.
-- `for select` e não `for all`: com o GRANT só de leitura, uma policy ALL seria
-- largura sem consumidor, e `tests/invariants/rbac-config-ia-canais.test.ts`
-- reprova tabela NOVA com policy ALL só-tenancy — a mesma forma de
-- `attendance_teams`, `atendimentos` e `attendant_pause_log`. O `revoke`
-- explícito é o que protege no Supabase real: o default ACL de `public` concede
-- tudo a tabela nova, e só acrescentar GRANT não retira nada.
-- Nenhuma função nova.
--
-- Idempotente e auto-curativa: `if not exists` em tabela, coluna e índice;
-- CHECKs com drop + add depois de corrigir o dado que os violaria; policies com
-- drop + create; gatilhos com `create or replace`; bucket com `on conflict`.
-- O trecho entre os marcadores `[apêndice 0288]` é copiado, sem mudança, para o
-- apêndice do baseline.sql.

-- [apêndice 0288: início]
-- 1. phone_prompts ----------------------------------------------------------
create table if not exists public.phone_prompts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind            text not null,
  "text"          text not null,
  voice_id        text not null,
  model_id        text not null,
  content_hash    text not null,
  storage_path    text,
  duration_ms     integer,
  status          text not null,
  error           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

-- Cura antes dos CHECKs: a tabela é nova, e só uma linha gravada por fora os violaria.
update public.phone_prompts
   set status = 'failed', error = coalesce(error, 'erro_do_provedor'), storage_path = null, duration_ms = null
 where storage_path is not null
   and storage_path <> organization_id::text || '/' || content_hash || '.ulaw';
update public.phone_prompts
   set status = 'failed', error = coalesce(error, 'erro_do_provedor')
 where status = 'ready' and (storage_path is null or duration_ms is null or duration_ms <= 0);

alter table public.phone_prompts drop constraint if exists phone_prompts_kind_check;
alter table public.phone_prompts add constraint phone_prompts_kind_check
  check (kind in ('menu', 'invalid', 'waiting', 'nobody', 'after_hours', 'emergency'));
alter table public.phone_prompts drop constraint if exists phone_prompts_status_check;
alter table public.phone_prompts add constraint phone_prompts_status_check
  check (status in ('ready', 'failed'));
alter table public.phone_prompts drop constraint if exists phone_prompts_text_check;
alter table public.phone_prompts add constraint phone_prompts_text_check
  check (char_length("text") between 1 and 1000);
alter table public.phone_prompts drop constraint if exists phone_prompts_hash_check;
alter table public.phone_prompts add constraint phone_prompts_hash_check
  check (content_hash ~ '^[0-9a-f]{64}$');
alter table public.phone_prompts drop constraint if exists phone_prompts_storage_path_check;
alter table public.phone_prompts add constraint phone_prompts_storage_path_check
  check (storage_path is null or storage_path = organization_id::text || '/' || content_hash || '.ulaw');
alter table public.phone_prompts drop constraint if exists phone_prompts_ready_check;
alter table public.phone_prompts add constraint phone_prompts_ready_check
  check (status <> 'ready' or (storage_path is not null and duration_ms is not null and duration_ms > 0));

create index if not exists phone_prompts_org on public.phone_prompts (organization_id);
create index if not exists phone_prompts_caminho_pronto on public.phone_prompts (storage_path) where status = 'ready';

-- 2. phone_settings -----------------------------------------------------------
create table if not exists public.phone_settings (
  organization_id       uuid primary key references public.organizations(id) on delete cascade,
  voice_id              text,
  model_id              text not null default 'eleven_multilingual_v2',
  waiting_prompt_id     uuid references public.phone_prompts(id) on delete set null,
  nobody_prompt_id      uuid references public.phone_prompts(id) on delete set null,
  after_hours_prompt_id uuid references public.phone_prompts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- 3. phone_menus + phone_menu_options ----------------------------------------
create table if not exists public.phone_menus (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  prompt_id         uuid references public.phone_prompts(id) on delete set null,
  invalid_prompt_id uuid references public.phone_prompts(id) on delete set null,
  default_team_id   uuid not null,
  accepts_extension boolean not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, default_team_id) references public.attendance_teams(organization_id, id)
);
alter table public.phone_menus drop constraint if exists phone_menus_name_check;
alter table public.phone_menus add constraint phone_menus_name_check
  check (char_length(btrim(name)) between 1 and 80);

create table if not exists public.phone_menu_options (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  menu_id         uuid not null,
  digit           text not null,
  team_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (menu_id, digit),
  foreign key (organization_id, menu_id) references public.phone_menus(organization_id, id) on delete cascade,
  foreign key (organization_id, team_id) references public.attendance_teams(organization_id, id)
);
delete from public.phone_menu_options where digit !~ '^[0-9]$';
alter table public.phone_menu_options drop constraint if exists phone_menu_options_digit_check;
alter table public.phone_menu_options add constraint phone_menu_options_digit_check
  check (digit ~ '^[0-9]$');

create index if not exists phone_menus_org on public.phone_menus (organization_id) where archived_at is null;
create index if not exists phone_menu_options_team on public.phone_menu_options (organization_id, team_id);

-- 4. channel_sessions.sip_menu_id ---------------------------------------------
alter table public.channel_sessions
  add column if not exists sip_menu_id uuid references public.phone_menus(id) on delete set null;
update public.channel_sessions
   set sip_menu_id = null
 where sip_team_id is not null and sip_menu_id is not null;
alter table public.channel_sessions drop constraint if exists channel_sessions_sip_destino_check;
alter table public.channel_sessions add constraint channel_sessions_sip_destino_check
  check (not (sip_team_id is not null and sip_menu_id is not null));
create index if not exists idx_channel_sessions_sip_menu
  on public.channel_sessions (sip_menu_id) where sip_menu_id is not null;

-- 5. attendance_teams.phone_emergency_* -----------------------------------------
alter table public.attendance_teams
  add column if not exists phone_emergency_prompt_id uuid references public.phone_prompts(id) on delete set null,
  add column if not exists phone_emergency_active_since timestamptz,
  add column if not exists phone_emergency_expires_at timestamptz,
  add column if not exists phone_emergency_activated_by uuid references auth.users(id) on delete set null;
update public.attendance_teams
   set phone_emergency_active_since = null, phone_emergency_expires_at = null, phone_emergency_activated_by = null
 where (phone_emergency_active_since is null and phone_emergency_expires_at is not null)
    or (phone_emergency_expires_at is not null and phone_emergency_expires_at <= phone_emergency_active_since);
alter table public.attendance_teams drop constraint if exists attendance_teams_phone_emergency_check;
alter table public.attendance_teams add constraint attendance_teams_phone_emergency_check check (
  (phone_emergency_active_since is null and phone_emergency_expires_at is null)
  or (phone_emergency_active_since is not null
      and (phone_emergency_expires_at is null or phone_emergency_expires_at > phone_emergency_active_since))
);
create index if not exists attendance_teams_aviso_com_prazo
  on public.attendance_teams (phone_emergency_expires_at) where phone_emergency_expires_at is not null;

-- 6. voice_calls ----------------------------------------------------------------
alter table public.voice_calls
  add column if not exists menu_id uuid references public.phone_menus(id) on delete set null,
  add column if not exists menu_digit text,
  add column if not exists menu_outcome text,
  add column if not exists emergency_heard_at timestamptz;
update public.voice_calls set menu_digit = null where menu_digit is not null and menu_digit !~ '^[0-9]$';
update public.voice_calls set menu_outcome = null
 where menu_outcome is not null and menu_outcome not in ('chosen', 'default_no_input', 'default_invalid');
alter table public.voice_calls drop constraint if exists voice_calls_menu_digit_check;
alter table public.voice_calls add constraint voice_calls_menu_digit_check
  check (menu_digit is null or menu_digit ~ '^[0-9]$');
alter table public.voice_calls drop constraint if exists voice_calls_menu_outcome_check;
alter table public.voice_calls add constraint voice_calls_menu_outcome_check
  check (menu_outcome is null or menu_outcome in ('chosen', 'default_no_input', 'default_invalid'));
create index if not exists idx_voice_calls_menu_recentes
  on public.voice_calls (menu_id, started_at) where menu_id is not null;

-- 7. RLS, GRANT e policies ------------------------------------------------------
alter table public.phone_prompts      enable row level security;
alter table public.phone_settings     enable row level security;
alter table public.phone_menus        enable row level security;
alter table public.phone_menu_options enable row level security;

revoke all on public.phone_prompts, public.phone_settings, public.phone_menus, public.phone_menu_options
  from public, anon, authenticated, service_role;
grant select on public.phone_prompts, public.phone_settings, public.phone_menus, public.phone_menu_options
  to authenticated, service_role;

-- `_all` sai por nome: um clone que tenha aplicado um rascunho com a policy ALL
-- não fica com as duas.
drop policy if exists tenant_isolation_phone_prompts_all on public.phone_prompts;
drop policy if exists tenant_isolation_phone_prompts_select on public.phone_prompts;
create policy tenant_isolation_phone_prompts_select on public.phone_prompts for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_settings_all on public.phone_settings;
drop policy if exists tenant_isolation_phone_settings_select on public.phone_settings;
create policy tenant_isolation_phone_settings_select on public.phone_settings for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_menus_all on public.phone_menus;
drop policy if exists tenant_isolation_phone_menus_select on public.phone_menus;
create policy tenant_isolation_phone_menus_select on public.phone_menus for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_menu_options_all on public.phone_menu_options;
drop policy if exists tenant_isolation_phone_menu_options_select on public.phone_menu_options;
create policy tenant_isolation_phone_menu_options_select on public.phone_menu_options for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- 8. updated_at ------------------------------------------------------------------
create or replace trigger trg_phone_prompts_updated_at
  before update on public.phone_prompts for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_settings_updated_at
  before update on public.phone_settings for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_menus_updated_at
  before update on public.phone_menus for each row execute function public.fn_set_updated_at();

-- 9. Bucket privado --------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('phone-prompts', 'phone-prompts', false, 2097152, array['audio/basic'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 10. Comentários ----------------------------------------------------------------
comment on table public.phone_prompts is
  'Uma fala SALVA do telefone (URA, aguarde, ninguém atendeu, fora do horário, aviso de instabilidade). Áudio μ-law 8 kHz no bucket privado phone-prompts: gerado pela ElevenLabs SÓ na prévia da tela (a prévia é só objeto no Storage, sem linha), passa a valer no "Salvar e usar" (a linha aponta para o hash) e é copiado pelo worker para o volume telefonia-falas, que o Asterisk lê. Escrita só pela API/worker (GRANT só de SELECT). status failed está reservado: a v1 só grava ready.';
comment on column public.phone_prompts.storage_path is
  '<organization_id>/<content_hash>.ulaw no bucket phone-prompts — amarrado por CHECK, porque o worker escreve este caminho no disco. NULL só numa linha failed.';
comment on table public.phone_menus is
  'Menu de voz (URA) da organização: serve a vários números (channel_sessions.sip_menu_id). Tecla → time em phone_menu_options; quem não escolhe vai ao default_team_id. accepts_extension é da versão 3 (ramais).';
comment on column public.channel_sessions.sip_menu_id is
  'Menu de voz que atende as ligações deste número. Excludente com sip_team_id (channel_sessions_sip_destino_check). A API só aceita menu com a fala pronta.';
comment on column public.attendance_teams.phone_emergency_expires_at is
  'Quando o aviso de instabilidade do telefone desliga sozinho. NULL com active_since preenchido = até alguém desligar. O worker lê a cada ligação e desliga os vencidos a cada 60 s (auditoria phone.emergency_expired + aviso na Central).';
comment on column public.voice_calls.menu_outcome is
  'O que o menu de voz fez: chosen (tecla de uma opção), default_no_input (ninguém escolheu), default_invalid (houve tecla errada). NULL com menu_id = desligou no menu. Fonte do "últimos 7 dias" do menu.';
comment on column public.voice_calls.emergency_heard_at is
  'Quando o cliente ouviu até o fim o aviso de instabilidade do time. NULL = não havia aviso ou a ligação caiu antes. Fonte do "ouviu o aviso de instabilidade" no cartão da ligação.';
-- [apêndice 0288: fim]

-- 11. agent_inbox_items.kind — a LISTA INTEIRA: a última migration que reconstrói
--     a constraint termina igual ao baseline (tests/unit/kind-check-migration-x-baseline.test.ts).
alter table public.agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items add constraint agent_inbox_items_kind_check check (kind in (
  'appointment_outcome_required',
  'appointment_recovery_review',
  'qr_rescan',
  'routing_unassigned',
  'job_dead',
  'event_dead',
  'budget_exceeded',
  'handoff',
  'promotion_review',
  'judge_unaligned',
  'followup_dead',
  'snooze_expired',
  'next_action_ambiguous',
  'risk_backlog_seeded',
  'reactivation_expired',
  'capabilities_missing',
  'message_send_stuck',
  'midia_nao_lida',
  'channel_template_review',
  'channel_number_alert',
  'promise_unfulfilled',
  'contact_proposal_expired',
  'budget_warning',
  'conhecimento_nao_indexado',
  'voice_call_missed',
  'case_stale',
  'phone_prompt_unplayable',
  'phone_emergency_expired',
  'other'
));

notify pgrst, 'reload schema';
