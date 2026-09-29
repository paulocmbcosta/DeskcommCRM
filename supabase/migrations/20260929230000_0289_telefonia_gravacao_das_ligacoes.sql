-- 0289 — telefonia: gravação das ligações (F3 da spec 20, DYD-53).
--
-- Desenho: docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `phone_settings` ganha a política da organização:
--    - `recording_enabled` (desligada por padrão: gravar é decisão consciente,
--      com aviso — e é o que o kit entrega a quem instala);
--    - `recording_retention_days` (90 por padrão, o mínimo que o Decreto
--      11.034/2022 pede para gravações de SAC; CHECK 7..3650);
--    - `recording_notice_prompt_id`, a fala geral do AVISO DE GRAVAÇÃO — FK
--      COMPOSTA para `phone_prompts`, com `set null (coluna)`, a mesma catraca
--      das outras falas gerais da 0288.
-- 2. `phone_prompts.kind` ganha `recording_notice`.
-- 3. `voice_calls` ganha o ciclo da gravação:
--    - `recording_status` (`recording` → `stored` | `failed`, e `stored` →
--      `expired` pela retenção; NULL = não gravada) — a FONTE DA VERDADE;
--    - `recording_notice_at`, quando o aviso tocou — a prova de que quem estava
--      na linha foi avisado.
--    As duas só valem na ligação do TELEFONE (`provider = 'sip_trunk'`), pelo
--    mesmo motivo das colunas da URA na 0288: a linha do WaCalls a REST escreve
--    com o JWT do agent, e ninguém pode forjar por ela uma gravação.
--    O arquivo NÃO mora aqui: ele é a mídia da mensagem da ligação
--    (`messages.media_storage_path`, bucket `whatsapp-media`). Por estar ali, a
--    anonimização do contato (0235) já o apaga, sem mudar a função da cascata.
-- 4. `agent_inbox_items.kind` ganha `phone_recording_failed`: a gravação de uma
--    ligação não pôde ser guardada em 30 min (serviço de telefonia fora, Storage
--    fora, conversor quebrado). Sem ele a falha ficaria só no log do worker.
--
-- Índices parciais: o processamento procura as gravações PENDENTES (poucas, e o
-- histórico inteiro não entra no índice), e a poda diária procura as GUARDADAS
-- por organização e fim da ligação.
--
-- Idempotente: `add column if not exists`, CHECKs e FK só quando faltam (criados
-- `NOT VALID` e validados em seguida), constraints de vocabulário reconstruídas
-- com a lista INTEIRA. Sem BEGIN/COMMIT (o runner envolve em transação).

-- 1. phone_settings -----------------------------------------------------------
alter table public.phone_settings
  add column if not exists recording_enabled boolean not null default false,
  add column if not exists recording_retention_days integer not null default 90,
  add column if not exists recording_notice_prompt_id uuid;

do $chk_retencao$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_settings'::regclass
                    and conname = 'phone_settings_recording_retention_check') then
    update public.phone_settings set recording_retention_days = 90
     where recording_retention_days not between 7 and 3650;
    alter table public.phone_settings add constraint phone_settings_recording_retention_check
      check (recording_retention_days between 7 and 3650);
  end if;
end $chk_retencao$;

do $fk_aviso$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_settings'::regclass
                    and conname = 'phone_settings_recording_notice_prompt_id_org_fkey') then
    update public.phone_settings s set recording_notice_prompt_id = null
     where s.recording_notice_prompt_id is not null
       and not exists (select 1 from public.phone_prompts p
                        where p.id = s.recording_notice_prompt_id and p.organization_id = s.organization_id);
    alter table public.phone_settings add constraint phone_settings_recording_notice_prompt_id_org_fkey
      foreign key (organization_id, recording_notice_prompt_id)
      references public.phone_prompts (organization_id, id) on delete set null (recording_notice_prompt_id);
  end if;
end $fk_aviso$;

-- 2. phone_prompts.kind --------------------------------------------------------
alter table public.phone_prompts drop constraint if exists phone_prompts_kind_check;
alter table public.phone_prompts add constraint phone_prompts_kind_check
  check (kind in ('menu', 'invalid', 'waiting', 'nobody', 'after_hours', 'emergency', 'recording_notice'));

-- 3. voice_calls ---------------------------------------------------------------
alter table public.voice_calls
  add column if not exists recording_status text,
  add column if not exists recording_notice_at timestamptz;

do $chk_gravacao$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_recording_status_check') then
    update public.voice_calls set recording_status = null
     where recording_status is not null and recording_status not in ('recording', 'stored', 'failed', 'expired');
    alter table public.voice_calls add constraint voice_calls_recording_status_check
      check (recording_status is null or recording_status in ('recording', 'stored', 'failed', 'expired')) not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_recording_so_no_telefone_check') then
    update public.voice_calls set recording_status = null, recording_notice_at = null
     where provider <> 'sip_trunk' and (recording_status is not null or recording_notice_at is not null);
    alter table public.voice_calls add constraint voice_calls_recording_so_no_telefone_check
      check (provider = 'sip_trunk' or (recording_status is null and recording_notice_at is null)) not valid;
  end if;
end $chk_gravacao$;

alter table public.voice_calls validate constraint voice_calls_recording_status_check;
alter table public.voice_calls validate constraint voice_calls_recording_so_no_telefone_check;

create index if not exists voice_calls_gravacao_pendente
  on public.voice_calls (ended_at) where recording_status = 'recording';
create index if not exists voice_calls_gravacao_guardada
  on public.voice_calls (organization_id, ended_at) where recording_status = 'stored';

comment on column public.phone_settings.recording_enabled is
  'Grava as ligações do telefone desta organização (as duas direções, só a conversa: a ponte atendente↔cliente). Só liga com o aviso de gravação pronto (a rota recusa). Lido pelo worker a cada ligação.';
comment on column public.phone_settings.recording_retention_days is
  'Por quantos dias a gravação fica guardada. A poda diária (cron data-retention) apaga o arquivo e marca voice_calls.recording_status = expired.';
comment on column public.phone_settings.recording_notice_prompt_id is
  'A fala do AVISO DE GRAVAÇÃO (phone_prompts.kind = recording_notice). Recebida: toca antes do menu/fila; se não tocar, a ligação não é gravada. Feita: toca na ponte quando o cliente atende.';
comment on column public.voice_calls.recording_status is
  'Ciclo da gravação (fonte da verdade): recording (gravando ou esperando ser guardada), stored (arquivo na mensagem da ligação), failed (perdida), expired (apagada pela retenção). NULL = não gravada. Só sip_trunk. A projeção para a tela fica em messages.metadata.voice_call.gravacao.';
comment on column public.voice_calls.recording_notice_at is
  'Quando o aviso de gravação tocou para quem estava na linha (recebida: ao fim da fala, antes do menu/fila; feita: ao atender). NULL = não houve aviso, e então a ligação não foi gravada.';

-- 4. agent_inbox_items.kind — a LISTA INTEIRA: a última migration que reconstrói
--    a constraint termina igual ao baseline (tests/unit/kind-check-migration-x-baseline.test.ts).
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
  'phone_menu_team_archived',
  'phone_recording_failed',
  'other'
));

notify pgrst, 'reload schema';
