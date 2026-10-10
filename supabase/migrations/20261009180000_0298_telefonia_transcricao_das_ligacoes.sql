-- 0298 — telefonia: transcrição e resumo das ligações gravadas (F4 da spec 20).
--
-- Desenho: docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `phone_settings` ganha a política da organização:
--    - `transcription_enabled` (desligada por padrão: custa por minuto e manda o
--      áudio a um provedor de IA — quem instala decide);
--    - `transcription_enabled_at`, o instante em que foi ligada. É a régua do "só
--      daqui para frente": a ligação que terminou ANTES disso não é transcrita,
--      nem pela passada que repõe um pedido perdido.
-- 2. `voice_call_transcripts` — a transcrição, 1:1 com a ligação.
--    NÃO mora em `messages.media_derived_text` (o caminho do áudio do WhatsApp),
--    por três razões medidas no estudo de 2026-10-09:
--    - aquele campo corta em 8.000 caracteres (~9 min de conversa), e as ligações
--      longas são justamente as que mais pedem leitura;
--    - `messages` é lida pela REST e levada inteira pelo Realtime a qualquer
--      membro que enxergue a conversa — inclusive o `viewer`, que NÃO pode ouvir
--      a gravação (a escuta é de atendente para cima, e auditada). A transcrição é
--      o mesmo conteúdo por escrito;
--    - não tem estrutura: aqui os trechos guardam o tempo e quem falou.
--    Por isso a tabela é SERVER-SIDE ONLY: RLS ligada sem policies e grants
--    revogados de `anon`/`authenticated` (o desenho de `platform_meta_app`). Quem
--    escreve é o worker do telefone; quem lê é a rota da leitura auditada, que
--    confere o papel e a visibilidade da conversa antes de abrir.
--    `status` é a FONTE DA VERDADE do ciclo (`pending` → `ready` | `empty` |
--    `failed`); a projeção para o cartão fica em
--    `messages.metadata.voice_call.transcricao` — só a situação, nunca o texto.
-- 3. Anonimizar o contato apaga as transcrições das ligações dele. O sinal é
--    `contacts.is_anonymized`, que os DOIS caminhos de anonimização gravam (a
--    cascata do worker de LGPD e o botão da ficha). Trigger de coluna, com WHEN:
--    não pesa nas escritas comuns de `contacts`. Só age para quem anonimiza de
--    verdade (função definer ou service key); o membro que escreve o campo
--    direto pela REST não apaga nada — o porquê no bloco 3.
-- 4. A mensagem da ligação que é apagada leva a transcrição junto — a função
--    `fn_gravacao_da_mensagem_apagada` (0289) passa a apagar também a linha daqui,
--    e por isso passa a ser SECURITY DEFINER (o porquê no bloco 4).
--    `create or replace`, sem tocar no trigger: nenhuma trava em `messages`.
-- 5. `agent_inbox_items.kind` ganha `phone_transcription_failed`: a transcrição
--    de uma ligação não saiu (falta a chave, o provedor recusou todas as
--    tentativas). Sem ele a falha ficaria só no log do worker.
--
-- Idempotente: `add column if not exists`, `create table if not exists`,
-- `create or replace function`, e o trigger só é criado quando falta (criar de
-- novo a cada reaplicação do baseline pediria uma trava em `contacts` por nada).
-- Sem BEGIN/COMMIT (o runner envolve em transação).

-- 1. phone_settings -----------------------------------------------------------
alter table public.phone_settings
  add column if not exists transcription_enabled boolean not null default false,
  add column if not exists transcription_enabled_at timestamptz;

comment on column public.phone_settings.transcription_enabled is
  'Transcreve e resume as ligações gravadas desta organização. Desligada por padrão. Só vale para a ligação gravada (recording_enabled) que terminou depois de transcription_enabled_at. Lido pelo worker do telefone.';
comment on column public.phone_settings.transcription_enabled_at is
  'Quando a transcrição foi ligada pela última vez. Régua do "só daqui para frente": ligação que terminou antes disto não é transcrita.';

-- 2. voice_call_transcripts ----------------------------------------------------
create table if not exists public.voice_call_transcripts (
  voice_call_id     uuid primary key references public.voice_calls(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  status            text not null default 'pending',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  text              text,
  segments          jsonb not null default '[]'::jsonb,
  summary           text,
  language          text,
  model             text,
  audio_duration_ms integer,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint voice_call_transcripts_status_check
    check (status in ('pending', 'ready', 'empty', 'failed')),
  constraint voice_call_transcripts_segments_check
    check (jsonb_typeof(segments) = 'array')
);

create index if not exists voice_call_transcripts_pendentes
  on public.voice_call_transcripts (next_attempt_at) where status = 'pending';
create index if not exists voice_call_transcripts_org
  on public.voice_call_transcripts (organization_id);

comment on table public.voice_call_transcripts is
  'A transcrição de uma ligação gravada (1:1 com voice_calls). SERVER-SIDE ONLY: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. Escrita pelo worker do telefone; lida pela rota da leitura auditada (atendente para cima que enxerga a conversa). Apagada junto com a gravação (retenção), na anonimização do contato e quando a mensagem da ligação sai.';
comment on column public.voice_call_transcripts.status is
  'Ciclo da transcrição (fonte da verdade): pending (pedida, esperando ou em curso), ready (texto pronto), empty (a gravação não tem fala), failed (não saiu). A projeção para a tela fica em messages.metadata.voice_call.transcricao — só a situação.';
comment on column public.voice_call_transcripts.segments is
  'Os trechos, na ordem: [{inicio_ms, fim_ms, quem, texto}]. `quem` é atendente | cliente | sistema | null — ESTIMADO por IA a partir do conteúdo (a gravação mistura as duas vozes num canal). Lido só por trechosDaTranscricao (lib/telefonia/transcricao.ts).';
comment on column public.voice_call_transcripts.summary is
  'O resumo curto da ligação, escrito por IA a partir da transcrição. NULL = não houve (o passo falhou ou não havia o que resumir).';
comment on column public.voice_call_transcripts.next_attempt_at is
  'Quando a passada pode pegar esta linha. Serve de reserva: quem começa a transcrever empurra o instante para a frente, e uma falha o reagenda.';
comment on column public.voice_call_transcripts.last_error is
  'A classe da última falha (sem texto da ligação nem chave) — diagnóstico, nunca mostrado ao cliente.';

alter table public.voice_call_transcripts enable row level security;

-- O `revoke` é obrigatório: o `alter default privileges` do topo do baseline (e o
-- default ACL de todo projeto Supabase) concede tabela nova a `anon` e
-- `authenticated`. Sem policy nenhuma, a RLS já negaria as linhas; o revoke tira
-- também a tabela do alcance do PostgREST. O `service_role` entra no revoke para
-- ficar só com o que usa: o default ACL lhe daria também TRUNCATE.
revoke all on public.voice_call_transcripts from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.voice_call_transcripts to service_role;

drop trigger if exists trg_voice_call_transcripts_updated_at on public.voice_call_transcripts;
create trigger trg_voice_call_transcripts_updated_at
  before update on public.voice_call_transcripts
  for each row execute function public.fn_set_updated_at();

-- 3. anonimização do contato apaga as transcrições -----------------------------
-- SÓ para a anonimização DE VERDADE. Os dois caminhos do produto mudam
-- `is_anonymized` de dentro de uma função definer (a cascata do worker de LGPD,
-- o botão da ficha) ou com a service key: nos dois, `current_user` é o dono ou
-- `service_role`. Um membro que escreve `is_anonymized = true` direto pela REST
-- (a RLS de `contacts` hoje deixa) NÃO é anonimização — e, se apagasse as
-- transcrições, qualquer membro destruiria as de conversas que nem enxerga e,
-- voltando o campo, faria o worker transcrever tudo de novo, pagando outra vez
-- (achado da revisão de segurança). Para ele a função não faz nada.
--
-- Por isso é INVOKER, como `fn_mensagem_de_ligacao_e_do_sistema` (0289): é o
-- `current_user` de quem escreve que decide. O dono e o `service_role` têm o que
-- precisam para apagar; o membro, que não tem, nem chega ao DELETE.
create or replace function public.fn_transcricoes_do_contato_anonimizado()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    return new;
  end if;
  delete from public.voice_call_transcripts t
   using public.voice_calls v
   where v.id = t.voice_call_id
     and v.organization_id = new.organization_id
     and v.contact_id = new.id;
  -- A projeção sai junto: o cartão não pode prometer um texto que não existe.
  -- (A cascata já zera o metadado; o botão da ficha não toca em `messages`.)
  update public.messages m
     set metadata = m.metadata #- '{voice_call,transcricao}'
    from public.voice_calls v
   where v.organization_id = new.organization_id
     and v.contact_id = new.id
     and m.organization_id = v.organization_id
     and m.external_id = 'ligacao:' || v.id::text
     and m.metadata #> '{voice_call,transcricao}' is not null;
  return new;
end $$;
-- Função de trigger não é chamada por RPC (o PostgREST não expõe `returns
-- trigger`), mas a regra 9 vale para toda função nova em `public`.
revoke execute on function public.fn_transcricoes_do_contato_anonimizado() from public, anon;
grant execute on function public.fn_transcricoes_do_contato_anonimizado() to authenticated, service_role;

do $trg_anon$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.contacts'::regclass
                    and tgname = 'trg_transcricoes_do_contato_anonimizado'
                    and not tgisinternal) then
    create trigger trg_transcricoes_do_contato_anonimizado
      after update of is_anonymized on public.contacts
      for each row
      when (new.is_anonymized is true and old.is_anonymized is distinct from true)
      execute function public.fn_transcricoes_do_contato_anonimizado();
  end if;
end $trg_anon$;

-- 4. a mensagem da ligação que sai leva a transcrição ---------------------------
-- Mesmo corpo da 0289 (o arquivo vai para a fila de remoção do Storage), mais a
-- transcrição. O id da ligação sai do `external_id` (`ligacao:<uuid>`), que só o
-- sistema escreve; o que não for uuid não vira consulta.
--
-- ⚠️ PASSA A SER SECURITY DEFINER, e não é detalhe. Excluir um contato pela tela
-- apaga a conversa com o JWT do membro; a mensagem da ligação sai pela cascata, e
-- o trigger AFTER de uma linha apagada por cascata roda no papel da SESSÃO — o
-- BEFORE é que roda como dono. O membro não tem (nem pode ter) privilégio em
-- `voice_call_transcripts`: como invoker, a exclusão inteira falhava com 42501
-- em toda conversa com cartão de ligação, com a transcrição ligada ou não
-- (achado da revisão; reproduzido em tests/invariants/telefonia-transcricao.test.ts).
-- Não há seletor: ela só alcança o arquivo e a transcrição da PRÓPRIA linha que
-- está saindo, e a linha de ligação um membro não apaga direto (0289).
create or replace function public.fn_gravacao_da_mensagem_apagada()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ligacao text;
begin
  if old.external_id like 'ligacao:%' and old.media_storage_path is not null then
    insert into public.storage_redaction_queue (organization_id, request_id, bucket, object_path)
    values (old.organization_id, null, 'whatsapp-media', old.media_storage_path)
    on conflict (bucket, object_path) do nothing;
  end if;
  if old.external_id like 'ligacao:%' then
    v_ligacao := substring(old.external_id from 9);
    -- `to_regclass`: aqui a tabela já existe (é criada acima), mas o corpo é o
    -- MESMO do baseline, que recria esta função no bloco da 0289 — antes de a
    -- tabela existir na primeira atualização de um banco anterior à 0298, com o
    -- sistema no ar. Sem a conferência, apagar uma conversa com cartão de ligação
    -- nesse intervalo falhava com 42P01. Sem tabela não há transcrição a levar.
    if v_ligacao ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and to_regclass('public.voice_call_transcripts') is not null then
      delete from public.voice_call_transcripts
       where voice_call_id = v_ligacao::uuid and organization_id = old.organization_id;
    end if;
  end if;
  return old;
end $$;
-- Definer que escreve: ninguém a executa por conta própria (trigger não confere
-- EXECUTE de quem dispara o comando).
revoke execute on function public.fn_gravacao_da_mensagem_apagada() from public, anon, authenticated;
grant execute on function public.fn_gravacao_da_mensagem_apagada() to service_role;

-- 5. agent_inbox_items.kind — a LISTA INTEIRA: a última migration que reconstrói
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
  'phone_transcription_failed',
  'other'
));

notify pgrst, 'reload schema';
