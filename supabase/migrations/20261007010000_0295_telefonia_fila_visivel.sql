-- ---- telefonia: a fila visível (migration 0295) ----
--
-- A fila do telefone vivia só na memória do worker: quem coordena o atendimento
-- não via quantos clientes esperavam, de que time nem por qual número, e numa
-- queda de internet (o pico de um provedor) não havia como pôr mais gente para
-- atender. Desenho: docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md §4.2.
--
-- `voice_calls.queued_at`: quando a ligação passou a ESPERAR POR UMA PESSOA —
-- depois do menu e dos avisos, no começo dos toques. É a ordem de chegada da
-- fila (a tela ordena por ela; o worker decide a vez por ela). NULL = ainda no
-- menu ou nos avisos, ou ligação anterior a esta migration.
--
-- `voice_calls.queue_deadline_at`: quando a espera SEM NINGUÉM LIVRE esgota e a
-- ligação cai ("fila esgotada"). Gravado pelo worker quando a espera começa,
-- como `now()` do banco mais o que falta no relógio dele — o mesmo desenho da
-- 0294, para a conta não depender de os dois relógios baterem. É o "cai em
-- 1:18" da tela. Fica gravado enquanto um ramal toca (a tela só o mostra enquanto
-- ninguém toca) e é apagado quando a ligação é atendida. NULL = nunca esperou
-- sem ninguém livre, ou já foi atendida.
--
-- `attendance_teams.phone_queue_max_wait_seconds`: a espera máxima na fila do
-- telefone DESTE time, em segundos. NULL = o padrão de sempre (120). Entre 30 e
-- 1800. Quem escreve é a rota de Configurações › Times, pela conexão do app
-- (a tabela só tem GRANT de leitura para `authenticated`).
--
-- As duas colunas de `voice_calls` só na linha do TELEFONE (`provider =
-- 'sip_trunk'`), pela regra da 0288/0289/0294: a linha do WaCalls a REST
-- escreve com o JWT do atendente, e ninguém forja por ela uma ligação na fila.
--
-- Idempotente e auto-curativa: `if not exists`; CHECK só quando falta, com a
-- linha fora da regra curada ANTES; NOT VALID + validação. Sem backfill. Nenhuma
-- função, GRANT ou policy nova.

alter table public.voice_calls
  add column if not exists queued_at timestamptz,
  add column if not exists queue_deadline_at timestamptz;

do $chk_fila$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass
                    and conname = 'voice_calls_fila_so_no_telefone_check') then
    update public.voice_calls set queued_at = null, queue_deadline_at = null
     where provider <> 'sip_trunk' and (queued_at is not null or queue_deadline_at is not null);
    alter table public.voice_calls add constraint voice_calls_fila_so_no_telefone_check
      check (provider = 'sip_trunk' or (queued_at is null and queue_deadline_at is null)) not valid;
  end if;
end $chk_fila$;

alter table public.voice_calls validate constraint voice_calls_fila_so_no_telefone_check;

alter table public.attendance_teams
  add column if not exists phone_queue_max_wait_seconds integer;

do $chk_espera$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.attendance_teams'::regclass
                    and conname = 'attendance_teams_phone_queue_max_wait_check') then
    update public.attendance_teams set phone_queue_max_wait_seconds = null
     where phone_queue_max_wait_seconds is not null
       and phone_queue_max_wait_seconds not between 30 and 1800;
    alter table public.attendance_teams add constraint attendance_teams_phone_queue_max_wait_check
      check (phone_queue_max_wait_seconds is null or phone_queue_max_wait_seconds between 30 and 1800);
  end if;
end $chk_espera$;

-- A aba Telefone lê as recebidas VIVAS da organização a cada mudança, e as
-- perdidas dos últimos 30 minutos. Parciais: o histórico não entra em nenhum dos dois.
create index if not exists idx_voice_calls_recebidas_vivas
  on public.voice_calls (organization_id, started_at)
  where status <> 'ended' and direction = 'inbound';
create index if not exists idx_voice_calls_perdidas_recentes
  on public.voice_calls (organization_id, ended_at desc)
  where direction = 'inbound' and answered_at is null and ended_at is not null;

comment on column public.voice_calls.queued_at is
  'Recebida: quando passou a esperar por uma pessoa (o começo dos toques, depois do menu e dos avisos). A ordem de chegada da fila. NULL = ainda no menu/avisos, ou anterior à 0295. Só sip_trunk.';
comment on column public.voice_calls.queue_deadline_at is
  'Recebida: quando a espera sem ninguém livre esgota (o "cai em" da aba Telefone). Gravado pelo worker no relógio do banco quando a espera começa, e apagado quando a ligação é atendida; fica gravado enquanto um ramal toca (a tela só o mostra enquanto ninguém toca). NULL = nunca esperou sem ninguém livre, ou já foi atendida. Só sip_trunk.';
comment on column public.attendance_teams.phone_queue_max_wait_seconds is
  'Espera máxima na fila do telefone deste time, em segundos (30 a 1800). NULL = o padrão, 120. Lido pelo worker quando a ligação entra na fila do time.';

notify pgrst, 'reload schema';
