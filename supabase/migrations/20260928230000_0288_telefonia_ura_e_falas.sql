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
--    vários números. `accepts_extension` nasce aqui e só é usada na versão 3.
-- 4. `channel_sessions.sip_menu_id` — o número aponta para um time OU um menu,
--    nunca os dois (CHECK). Linha com os dois (impossível até aqui) mantém o time.
-- 5. `attendance_teams.phone_emergency_*` — o aviso de instabilidade é do TIME
--    (D7): a fala, desde quando está ligado, até quando (nulo = até alguém
--    desligar) e quem ligou. CHECK de coerência; linha incoerente é desligada
--    ANTES de o CHECK entrar.
-- 6. `voice_calls` — o que o menu fez (`menu_id`, `menu_digit`, `menu_outcome`) e
--    quando o cliente ouviu o aviso inteiro (`emergency_heard_at`). `end_reason`
--    ganha `after_hours` sem migration: é coluna de vocabulário aberto. Essas
--    quatro colunas são da ligação do TELEFONE: um CHECK as mantém nulas fora de
--    `provider = 'sip_trunk'`, e a policy de escrita pela REST da 0235
--    (`voice_calls_write`) passa a valer só para `provider = 'wacalls'` — ver
--    "Segurança", abaixo.
-- 7. `agent_inbox_items.kind` ganha `phone_prompt_unplayable` (a fala não tocou
--    e a ligação seguiu sem ela), `phone_emergency_expired` (o aviso venceu e
--    desligou sozinho) e `phone_menu_team_archived` (quem ligou caiu no time
--    padrão de um menu, e esse time está arquivado). No baseline, quem muda é o
--    bloco ÚNICO da constraint.
-- 8. Bucket PRIVADO `phone-prompts`, sem policy em `storage.objects`: só o
--    cliente de serviço (API e worker) lê e grava.
--
-- FK COMPOSTA em TODA referência nova entre tabelas da organização — e no time
-- do número (`sip_team_id`), que a 0286 criou com FK SIMPLES e `set null`: o
-- destino é um time OU um menu, e as duas metades ganham a mesma catraca:
-- `(organization_id, <coluna>) → <alvo>(organization_id, id)`. É o que torna
-- impossível, e não só improvável, um número tocar o menu de outra organização,
-- uma opção levar ao time de outra, ou um menu tocar a fala de outra — mesmo
-- pela REST, que escreve `channel_sessions` (admin) e `voice_calls` (agent) com
-- o JWT do usuário. A leitura já filtra a organização; a FK faz o BANCO recusar.
--
--   referência                                   alvo              on delete
--   channel_sessions.sip_menu_id                 phone_menus       set null (sip_menu_id)
--   channel_sessions.sip_team_id (da 0286)       attendance_teams  set null (sip_team_id)
--   voice_calls.menu_id                          phone_menus       set null (menu_id)
--   phone_menus.prompt_id / invalid_prompt_id    phone_prompts     set null (a coluna)
--   phone_settings.{waiting,nobody,after_hours}_prompt_id
--                                                phone_prompts     set null (a coluna)
--   attendance_teams.phone_emergency_prompt_id   phone_prompts     set null (a coluna)
--   phone_menus.default_team_id                  attendance_teams  no action
--   phone_menu_options.team_id                   attendance_teams  no action
--   phone_menu_options.menu_id                   phone_menus       cascade
--
-- `set null (coluna)` (pg15+, o piso) e não `set null`: numa FK composta o
-- `set null` puro anularia TAMBÉM o `organization_id`, que é `not null` — o
-- apagamento do alvo estouraria em vez de soltar o ponteiro. `no action` onde a
-- coluna é `not null`: time é arquivado, não apagado, e na exclusão da
-- organização as duas pontas saem no MESMO comando, que é quando o `no action`
-- confere. `cascade` na opção: ela não existe sem o menu. `MATCH SIMPLE` (o
-- padrão) deixa passar a coluna nula, que é o "sem menu"/"sem fala".
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
-- `voice_calls` é o caso oposto: o WaCalls AINDA grava por ela pela REST, com o
-- JWT do agent (a rota que disca, a reconciliação com a ponte, a de atender), e
-- nenhum e2e cobre isso — então NÃO há revoke nem grant por coluna. Até aqui a
-- policy de escrita da 0235 alcançava também a ligação do telefone, e um agent
-- forjava o desfecho do menu (revisão de segurança da fase 2). Agora ela vale só
-- para `provider = 'wacalls'`, no `using` E no `with check`, com o mesmo papel e a
-- mesma organização; e o CHECK `voice_calls_menu_so_no_telefone_check` barra
-- coluna do menu numa linha do WaCalls, para todo mundo. As FKs simples da
-- 0235/0286 em `voice_calls` (`team_id`, `conversation_id`, `ringing_user_id`)
-- ainda aceitam id de outra organização numa linha do WaCalls pela REST: fora
-- desta migration, nas pendências. Gate:
-- `tests/invariants/telefonia-voice-calls-pela-rest.test.ts`.
-- Nenhuma função nova.
--
-- Idempotente e auto-curativa: `if not exists` em tabela, coluna e índice.
--
-- CHECKs: cada um é criado SÓ quando falta (bloco `do` que confere `pg_constraint`
-- pelo NOME) — reaplicar o baseline não os derruba, não trava a tabela e não a
-- varre (em `voice_calls`, que cresce com o histórico, isso pesa a cada
-- `update.sh`). Mudou a definição? Nome novo, nunca edição da antiga. Ao criar
-- pela primeira vez: onde há correção segura, o dado que violaria é CURADO antes
-- (caminho do áudio e fala `ready` sem arquivo → `failed`; `status` fora do
-- vocabulário → `failed`; nome do menu acima de 80 → cortado; tecla fora de 0–9
-- → opção apagada, desfecho/tecla da ligação → nulo; número com time E menu →
-- fica o time; aviso incoerente → desligado). O CHECK nasce `NOT VALID` e é
-- VALIDADO logo em seguida (bloco 6b), fora do lock exclusivo. Onde não há
-- correção segura (`kind`, `text`, `content_hash`, nome vazio), uma linha que
-- viola deixa o CHECK `NOT VALID` — ele vale para toda linha nova — com um
-- WARNING no log, e cada `update.sh` seguinte tenta validá-lo de novo. A tabela
-- nunca fica sem o CHECK, e nunca em silêncio.
--
-- FKs compostas por um bloco `do` que confere o catálogo (um clone que já tenha a
-- FK SIMPLES de um rascunho desta migration sai com a composta, e o ponteiro para
-- outra organização vira nulo antes); a do time do número (`sip_team_id`, que a
-- 0286 criou simples em TODO clone) num bloco próprio, com `lock_timeout` de 3 s
-- e WARNING da contagem de números que ficaram sem time (7b); policies com drop +
-- create; gatilhos com `create or replace`; bucket com `on conflict`.
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

-- CHECKs: só quando faltam, curados antes onde há correção segura, `NOT VALID` e
-- validados no bloco 6b (o porquê no cabeçalho). kind, text e hash não têm cura.
do $chk_falas$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_kind_check') then
    alter table public.phone_prompts add constraint phone_prompts_kind_check
      check (kind in ('menu', 'invalid', 'waiting', 'nobody', 'after_hours', 'emergency')) not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_status_check') then
    update public.phone_prompts
       set status = 'failed', error = coalesce(error, 'erro_do_provedor')
     where status not in ('ready', 'failed');
    alter table public.phone_prompts add constraint phone_prompts_status_check
      check (status in ('ready', 'failed')) not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_text_check') then
    alter table public.phone_prompts add constraint phone_prompts_text_check
      check (char_length("text") between 1 and 1000) not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_hash_check') then
    alter table public.phone_prompts add constraint phone_prompts_hash_check
      check (content_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;

  -- O worker escreve este caminho no disco: caminho fora da régua perde o arquivo.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_storage_path_check') then
    update public.phone_prompts
       set status = 'failed', error = coalesce(error, 'erro_do_provedor'), storage_path = null, duration_ms = null
     where storage_path is not null
       and storage_path <> organization_id::text || '/' || content_hash || '.ulaw';
    alter table public.phone_prompts add constraint phone_prompts_storage_path_check
      check (storage_path is null or storage_path = organization_id::text || '/' || content_hash || '.ulaw') not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_prompts'::regclass and conname = 'phone_prompts_ready_check') then
    update public.phone_prompts
       set status = 'failed', error = coalesce(error, 'erro_do_provedor')
     where status = 'ready' and (storage_path is null or duration_ms is null or duration_ms <= 0);
    alter table public.phone_prompts add constraint phone_prompts_ready_check
      check (status <> 'ready' or (storage_path is not null and duration_ms is not null and duration_ms > 0)) not valid;
  end if;
end $chk_falas$;

create index if not exists phone_prompts_org on public.phone_prompts (organization_id);
create index if not exists phone_prompts_caminho_pronto on public.phone_prompts (storage_path) where status = 'ready';

-- 2. phone_settings -----------------------------------------------------------
create table if not exists public.phone_settings (
  organization_id       uuid primary key references public.organizations(id) on delete cascade,
  voice_id              text,
  model_id              text not null default 'eleven_multilingual_v2',
  -- As três falas gerais: FK composta para phone_prompts no bloco 7.
  waiting_prompt_id     uuid,
  nobody_prompt_id      uuid,
  after_hours_prompt_id uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- 3. phone_menus + phone_menu_options ----------------------------------------
create table if not exists public.phone_menus (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  -- As duas falas: FK composta para phone_prompts no bloco 7.
  prompt_id         uuid,
  invalid_prompt_id uuid,
  default_team_id   uuid not null,
  accepts_extension boolean not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  -- no action: a coluna é not null (set null não cabe) e time é arquivado, não apagado.
  -- O alvo `attendance_teams(organization_id, id)` é a `unique` que a 0263 criou
  -- junto com a tabela — antes desta migration na cadeia e antes deste bloco no
  -- baseline. Sem guarda aqui de propósito: sem a unique, attendance_teams nem
  -- existiria.
  foreign key (organization_id, default_team_id) references public.attendance_teams(organization_id, id)
);
do $chk_menus$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_menus'::regclass and conname = 'phone_menus_name_check') then
    -- Nome longo demais é cortado; nome vazio não tem correção segura (NOT VALID + WARNING no 6b).
    update public.phone_menus set name = left(btrim(name), 80) where char_length(btrim(name)) > 80;
    alter table public.phone_menus add constraint phone_menus_name_check
      check (char_length(btrim(name)) between 1 and 80) not valid;
  end if;
end $chk_menus$;

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
do $chk_opcoes$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_menu_options'::regclass and conname = 'phone_menu_options_digit_check') then
    -- * e # são reservadas: a opção nessa tecla nunca seria escolhida.
    delete from public.phone_menu_options where digit !~ '^[0-9]$';
    alter table public.phone_menu_options add constraint phone_menu_options_digit_check
      check (digit ~ '^[0-9]$') not valid;
  end if;
end $chk_opcoes$;

create index if not exists phone_menus_org on public.phone_menus (organization_id) where archived_at is null;
create index if not exists phone_menu_options_team on public.phone_menu_options (organization_id, team_id);

-- 4. channel_sessions.sip_menu_id ---------------------------------------------
-- FK composta para phone_menus no bloco 7.
alter table public.channel_sessions
  add column if not exists sip_menu_id uuid;
do $chk_destino$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.channel_sessions'::regclass and conname = 'channel_sessions_sip_destino_check') then
    update public.channel_sessions
       set sip_menu_id = null
     where sip_team_id is not null and sip_menu_id is not null;
    alter table public.channel_sessions add constraint channel_sessions_sip_destino_check
      check (not (sip_team_id is not null and sip_menu_id is not null)) not valid;
  end if;
end $chk_destino$;
create index if not exists idx_channel_sessions_sip_menu
  on public.channel_sessions (sip_menu_id) where sip_menu_id is not null;

-- 5. attendance_teams.phone_emergency_* -----------------------------------------
-- FK composta de phone_emergency_prompt_id para phone_prompts no bloco 7.
alter table public.attendance_teams
  add column if not exists phone_emergency_prompt_id uuid,
  add column if not exists phone_emergency_active_since timestamptz,
  add column if not exists phone_emergency_expires_at timestamptz,
  add column if not exists phone_emergency_activated_by uuid references auth.users(id) on delete set null;
do $chk_aviso$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.attendance_teams'::regclass and conname = 'attendance_teams_phone_emergency_check') then
    update public.attendance_teams
       set phone_emergency_active_since = null, phone_emergency_expires_at = null, phone_emergency_activated_by = null
     where (phone_emergency_active_since is null and phone_emergency_expires_at is not null)
        or (phone_emergency_expires_at is not null and phone_emergency_expires_at <= phone_emergency_active_since);
    alter table public.attendance_teams add constraint attendance_teams_phone_emergency_check check (
      (phone_emergency_active_since is null and phone_emergency_expires_at is null)
      or (phone_emergency_active_since is not null
          and (phone_emergency_expires_at is null or phone_emergency_expires_at > phone_emergency_active_since))
    ) not valid;
  end if;
end $chk_aviso$;
create index if not exists attendance_teams_aviso_com_prazo
  on public.attendance_teams (phone_emergency_expires_at) where phone_emergency_expires_at is not null;

-- 6. voice_calls ----------------------------------------------------------------
-- FK composta de menu_id para phone_menus no bloco 7.
alter table public.voice_calls
  add column if not exists menu_id uuid,
  add column if not exists menu_digit text,
  add column if not exists menu_outcome text,
  add column if not exists emergency_heard_at timestamptz;
-- voice_calls cresce com o histórico: o CHECK é criado UMA vez e nunca mais
-- derrubado; a cura e a validação varrem a tabela só nessa vez.
do $chk_ligacoes$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_menu_digit_check') then
    update public.voice_calls set menu_digit = null where menu_digit is not null and menu_digit !~ '^[0-9]$';
    alter table public.voice_calls add constraint voice_calls_menu_digit_check
      check (menu_digit is null or menu_digit ~ '^[0-9]$') not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_menu_outcome_check') then
    update public.voice_calls set menu_outcome = null
     where menu_outcome is not null and menu_outcome not in ('chosen', 'default_no_input', 'default_invalid');
    alter table public.voice_calls add constraint voice_calls_menu_outcome_check
      check (menu_outcome is null or menu_outcome in ('chosen', 'default_no_input', 'default_invalid')) not valid;
  end if;

  -- O menu e o aviso de instabilidade são da ligação do TELEFONE. Fora de
  -- `sip_trunk` (a linha do WaCalls, que a REST grava com o JWT do agent) essas
  -- colunas ficam nulas — senão um agent forjava pela REST o desfecho de um menu
  -- e poluía os "últimos 7 dias" e o cartão da ligação. Cura segura: numa linha
  -- que não é do telefone elas não querem dizer nada.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_menu_so_no_telefone_check') then
    update public.voice_calls
       set menu_id = null, menu_digit = null, menu_outcome = null, emergency_heard_at = null
     where provider <> 'sip_trunk'
       and (menu_id is not null or menu_digit is not null or menu_outcome is not null or emergency_heard_at is not null);
    alter table public.voice_calls add constraint voice_calls_menu_so_no_telefone_check
      check (provider = 'sip_trunk'
             or (menu_id is null and menu_digit is null and menu_outcome is null and emergency_heard_at is null)) not valid;
  end if;
end $chk_ligacoes$;
create index if not exists idx_voice_calls_menu_recentes
  on public.voice_calls (menu_id, started_at) where menu_id is not null;

-- 6b. Validação dos CHECKs ---------------------------------------------------------
-- Só toca o CHECK que ainda está NOT VALID: no banco limpo é a primeira aplicação;
-- depois, só o de um clone com linha sem correção segura. `validate constraint`
-- varre a tabela SEM o lock exclusivo do `add`. Se uma linha ainda viola, o CHECK
-- segue valendo para linha nova e o WARNING diz qual — nunca em silêncio.
do $validar$
declare
  r record;
begin
  for r in
    select k.conrelid::regclass as tabela, k.conname
      from pg_constraint k
     where k.contype = 'c'
       and not k.convalidated
       and k.conname in (
         'phone_prompts_kind_check', 'phone_prompts_status_check', 'phone_prompts_text_check',
         'phone_prompts_hash_check', 'phone_prompts_storage_path_check', 'phone_prompts_ready_check',
         'phone_menus_name_check', 'phone_menu_options_digit_check', 'channel_sessions_sip_destino_check',
         'attendance_teams_phone_emergency_check', 'voice_calls_menu_digit_check', 'voice_calls_menu_outcome_check',
         'voice_calls_menu_so_no_telefone_check')
  loop
    begin
      execute format('alter table %s validate constraint %I', r.tabela, r.conname);
    exception when check_violation then
      raise warning '0288: % tem linha que viola % — o CHECK vale para toda linha nova (NOT VALID); corrija a linha e o próximo update.sh o valida',
        r.tabela, r.conname;
    end;
  end loop;
end $validar$;

-- 7. FKs compostas (organization_id, coluna) ------------------------------------
-- O alvo precisa de `unique (organization_id, id)`: phone_prompts e phone_menus
-- nascem com ela (acima). As referências a attendance_teams são as de
-- phone_menus e phone_menu_options e o time do número (7b), e usam a unique da
-- 0263 (ver phone_menus).

-- Uma FK por referência anulável, sempre `on delete set null (coluna)`. Para cada
-- uma: se a FK certa (nome, alvo, as duas colunas, set null só da coluna) já está
-- no catálogo, nada acontece — é o caminho de todo `update.sh` depois do
-- primeiro. Senão: sai toda outra FK que envolva a coluna (a simples de um
-- rascunho, ou uma torta), o ponteiro para outra organização (ou para linha que
-- não existe) vira nulo, e a composta entra.
do $fk$
declare
  r      record;
  c      record;
  v_rel  regclass;
  v_org  int2;
  v_col  int2;
  v_ok   boolean;
begin
  for r in
    select * from (values
      ('channel_sessions', 'sip_menu_id',               'phone_menus',   'channel_sessions_sip_menu_id_org_fkey'),
      ('voice_calls',      'menu_id',                   'phone_menus',   'voice_calls_menu_id_org_fkey'),
      ('phone_menus',      'prompt_id',                 'phone_prompts', 'phone_menus_prompt_id_org_fkey'),
      ('phone_menus',      'invalid_prompt_id',         'phone_prompts', 'phone_menus_invalid_prompt_id_org_fkey'),
      ('phone_settings',   'waiting_prompt_id',         'phone_prompts', 'phone_settings_waiting_prompt_id_org_fkey'),
      ('phone_settings',   'nobody_prompt_id',          'phone_prompts', 'phone_settings_nobody_prompt_id_org_fkey'),
      ('phone_settings',   'after_hours_prompt_id',     'phone_prompts', 'phone_settings_after_hours_prompt_id_org_fkey'),
      ('attendance_teams', 'phone_emergency_prompt_id', 'phone_prompts', 'attendance_teams_phone_emergency_prompt_id_org_fkey')
    ) as t(tabela, coluna, alvo, nome)
  loop
    v_rel := format('public.%I', r.tabela)::regclass;
    select attnum into v_org from pg_attribute where attrelid = v_rel and attname = 'organization_id';
    select attnum into v_col from pg_attribute where attrelid = v_rel and attname = r.coluna;

    select exists (
      select 1 from pg_constraint k
       where k.conrelid = v_rel
         and k.conname = r.nome
         and k.contype = 'f'
         and k.confrelid = format('public.%I', r.alvo)::regclass
         and k.conkey = array[v_org, v_col]
         and k.confdeltype = 'n'
         and k.confdelsetcols = array[v_col]
    ) into v_ok;

    for c in
      select k.conname from pg_constraint k
       where k.conrelid = v_rel and k.contype = 'f' and v_col = any (k.conkey)
         and not (v_ok and k.conname = r.nome)
    loop
      execute format('alter table public.%I drop constraint %I', r.tabela, c.conname);
    end loop;

    if not v_ok then
      execute format(
        'update public.%1$I t set %2$I = null
          where t.%2$I is not null
            and not exists (select 1 from public.%3$I x where x.id = t.%2$I and x.organization_id = t.organization_id)',
        r.tabela, r.coluna, r.alvo);
      execute format(
        'alter table public.%1$I add constraint %2$I foreign key (organization_id, %3$I)
           references public.%4$I (organization_id, id) on delete set null (%3$I)',
        r.tabela, r.nome, r.coluna, r.alvo);
    end if;
  end loop;
end $fk$;

-- 7b. O time do número: FK simples (0286) → composta, num bloco PRÓPRIO, com prazo de trava.
-- `channel_sessions.sip_team_id` não é referência nova: a 0286 a criou com FK
-- SIMPLES (`channel_sessions_sip_team_id_fkey`, `on delete set null`), que aceita
-- o time de outra organização — e `channel_sessions` é gravável pela REST (admin).
-- O destino do número é um time OU um menu, e as duas metades ganham a mesma
-- catraca: a composta, com o mesmo `set null`, agora só da coluna. O `add column
-- if not exists` da 0286 não a recria ao reaplicar: com a coluna existente, a
-- cláusula inteira (inclusive o `references`) é pulada — medido em pg15.
--
-- Fora do laço acima, e com `lock_timeout`, porque esta é a única troca que
-- acontece em TODO clone: a 0286 já está nas instalações, então o primeiro
-- update.sh depois desta versão troca a FK com o app de pé. Trocar pede
-- AccessExclusive em `channel_sessions` e em `attendance_teams`, e sem prazo o
-- ALTER esperaria atrás de qualquer leitura em curso — e todo o resto esperaria
-- atrás dele. Com 3 s: estourou, o bloco inteiro desfaz (nada pela metade) e
-- falha com uma mensagem que diz isso; o update.sh roda o baseline SEM
-- ON_ERROR_STOP, então os blocos seguintes rodam, e o próximo update.sh tenta de
-- novo. Com a composta no lugar (todo update.sh depois do primeiro), o bloco
-- volta antes de pedir trava. O `set_config(..., true)` vale até o fim da
-- transação — o bloco devolve o prazo anterior ao terminar, para não o deixar
-- valendo para o resto de uma migration aplicada numa transação só.
--
-- Número que apontava para time de OUTRA organização (ou que não existe) fica sem
-- time: é o que a composta exige, e o operador precisa saber — WARNING com a
-- contagem no log do update.
do $fk_time_do_numero$
declare
  v_rel      constant regclass := 'public.channel_sessions'::regclass;
  v_nome     constant text := 'channel_sessions_sip_team_id_org_fkey';
  v_org      int2;
  v_col      int2;
  v_ok       boolean;
  v_outras   int;
  v_anulados int;
  v_prazo    constant text := current_setting('lock_timeout');
  c          record;
begin
  select attnum into v_org from pg_attribute where attrelid = v_rel and attname = 'organization_id';
  select attnum into v_col from pg_attribute where attrelid = v_rel and attname = 'sip_team_id';

  select exists (
    select 1 from pg_constraint k
     where k.conrelid = v_rel
       and k.conname = v_nome
       and k.contype = 'f'
       and k.confrelid = 'public.attendance_teams'::regclass
       and k.conkey = array[v_org, v_col]
       and k.confdeltype = 'n'
       and k.confdelsetcols = array[v_col]
  ) into v_ok;
  select count(*) into v_outras
    from pg_constraint k
   where k.conrelid = v_rel and k.contype = 'f' and v_col = any (k.conkey)
     and not (v_ok and k.conname = v_nome);

  -- Todo update.sh depois do primeiro: nada a trocar, e nenhuma trava pedida.
  if v_ok and v_outras = 0 then
    return;
  end if;

  perform set_config('lock_timeout', '3s', true);

  for c in
    select k.conname from pg_constraint k
     where k.conrelid = v_rel and k.contype = 'f' and v_col = any (k.conkey)
       and not (v_ok and k.conname = v_nome)
  loop
    execute format('alter table public.channel_sessions drop constraint %I', c.conname);
  end loop;

  if not v_ok then
    update public.channel_sessions t
       set sip_team_id = null
     where t.sip_team_id is not null
       and not exists (select 1 from public.attendance_teams x
                        where x.id = t.sip_team_id and x.organization_id = t.organization_id);
    get diagnostics v_anulados = row_count;
    alter table public.channel_sessions add constraint channel_sessions_sip_team_id_org_fkey
      foreign key (organization_id, sip_team_id) references public.attendance_teams (organization_id, id)
      on delete set null (sip_team_id);
    -- Só depois de a composta entrar: um prazo estourado acima desfaz o `update`, e o aviso mentiria.
    if v_anulados > 0 then
      raise warning '0288: % número(s) de telefone apontavam para um time de OUTRA organização (ou que não existe) — esses números ficaram sem time (sip_team_id = null); escolha o time de novo em Conexões › Telefone', v_anulados;
    end if;
  end if;

  perform set_config('lock_timeout', v_prazo, true);
exception
  when lock_not_available then
    raise exception '0288: a troca da FK do time do número (%) esperou mais de 3 s pela trava de channel_sessions/attendance_teams e ficou para depois — nada mudou; o próximo update.sh tenta de novo', v_nome
      using errcode = 'lock_not_available';
end $fk_time_do_numero$;

-- 8. RLS, GRANT e policies ------------------------------------------------------
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

-- voice_calls: a escrita pela REST (a policy da 0235) passa a valer SÓ para a
-- linha do WaCalls, que ainda escreve por ela com a sessão do usuário —
-- app/api/v1/voice/calls/route.ts (o INSERT e a reconciliação) e
-- app/api/v1/voice/calls/[id]/accept/route.ts (o dono). A linha do telefone
-- (`sip_trunk`) é do worker e da API, pela conexão direta: pela REST ela fica
-- só-leitura, e o `with check` impede uma linha do WaCalls de virar do telefone.
-- O papel e a organização são os da 0235. Coluna do menu numa linha do WaCalls é
-- barrada pelo CHECK `voice_calls_menu_so_no_telefone_check` (bloco 6).
drop policy if exists voice_calls_write on public.voice_calls;
create policy voice_calls_write on public.voice_calls for all
  using (
    provider = 'wacalls'
    and organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    provider = 'wacalls'
    and organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

-- 9. updated_at ------------------------------------------------------------------
create or replace trigger trg_phone_prompts_updated_at
  before update on public.phone_prompts for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_settings_updated_at
  before update on public.phone_settings for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_menus_updated_at
  before update on public.phone_menus for each row execute function public.fn_set_updated_at();

-- 10. Bucket privado --------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('phone-prompts', 'phone-prompts', false, 2097152, array['audio/basic'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 11. Comentários ----------------------------------------------------------------
comment on table public.phone_prompts is
  'Uma fala SALVA do telefone (URA, aguarde, ninguém atendeu, fora do horário, aviso de instabilidade). Áudio μ-law 8 kHz no bucket privado phone-prompts: gerado pela ElevenLabs SÓ na prévia da tela (a prévia é só objeto no Storage, sem linha), passa a valer no "Salvar e usar" (a linha aponta para o hash) e é copiado pelo worker para o volume telefonia-falas, que o Asterisk lê. Escrita só pela API/worker (GRANT só de SELECT). status failed está reservado: a v1 só grava ready.';
comment on column public.phone_prompts.storage_path is
  '<organization_id>/<content_hash>.ulaw no bucket phone-prompts — amarrado por CHECK, porque o worker escreve este caminho no disco. NULL só numa linha failed.';
comment on table public.phone_menus is
  'Menu de voz (URA) da organização: serve a vários números (channel_sessions.sip_menu_id). Tecla → time em phone_menu_options; quem não escolhe vai ao default_team_id. accepts_extension é da versão 3 (ramais).';
comment on column public.channel_sessions.sip_team_id is
  'Time que recebe as ligações deste número. Excludente com sip_menu_id (channel_sessions_sip_destino_check); NULL nos dois = ninguém atende (a tela mostra). Apagar o time não apaga o número. FK composta (organization_id, sip_team_id) desde a 0288: o banco recusa time de outra organização, também pela REST.';
comment on column public.channel_sessions.sip_menu_id is
  'Menu de voz que atende as ligações deste número. Excludente com sip_team_id (channel_sessions_sip_destino_check). FK composta (organization_id, sip_menu_id): o banco recusa menu de outra organização, também pela REST. A API só aceita menu com a fala pronta.';
comment on column public.attendance_teams.phone_emergency_expires_at is
  'Quando o aviso de instabilidade do telefone desliga sozinho. NULL com active_since preenchido = até alguém desligar. O worker lê a cada ligação e desliga os vencidos a cada 60 s (auditoria phone.emergency_expired + aviso na Central).';
comment on column public.voice_calls.menu_outcome is
  'O que o menu de voz fez: chosen (tecla de uma opção), default_no_input (ninguém escolheu), default_invalid (houve tecla errada). NULL com menu_id = desligou no menu. Fonte do "últimos 7 dias" do menu.';
comment on column public.voice_calls.emergency_heard_at is
  'Quando o cliente ouviu até o fim o aviso de instabilidade do time. NULL = não havia aviso ou a ligação caiu antes. Fonte do "ouviu o aviso de instabilidade" no cartão da ligação.';
-- [apêndice 0288: fim]

-- 12. agent_inbox_items.kind — a LISTA INTEIRA: a última migration que reconstrói
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
  'phone_menu_team_archived',
  'other'
));

notify pgrst, 'reload schema';
