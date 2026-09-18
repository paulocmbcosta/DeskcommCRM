-- ---- atendimentos: protocolo por atendimento e linha do tempo da conversa (migration 0266) ----
--
-- Telecom (e qualquer operação regulada) exige NÚMERO DE PROTOCOLO por
-- atendimento. O episódio de atendimento já existia no schema — `service_revision`,
-- `service_started_at`, `service_closed_at` (migration 0222) —, mas só como
-- carimbo na linha da conversa: não tinha identidade, não tinha número e não
-- deixava histórico. Esta migration dá ao episódio uma LINHA.
--
-- ═══ Por que NÃO é "uma linha de `conversations` por atendimento" ═══
--
-- `uniq_conversations_1to1_per_contact_session` garante UMA conversa por
-- (organização, contato, canal), e essa garantia sustenta a ingestão
-- (`fn_upsert_wa_conversation` é um `on conflict` nela), o motor de agentes, o
-- follow-up, os casos e a fronteira de serviço. A conversa é o FIO do canal; o
-- atendimento é o EPISÓDIO dentro dele. Quebrar a unicidade para ganhar
-- protocolo trocaria uma coluna nova por uma reescrita da ingestão.
--
-- O que o atendente vê é o que ele pediu: fechou, some da fila; o cliente
-- voltou, nasce atendimento NOVO com protocolo NOVO; o anterior fica no
-- histórico do contato, navegável e achável pelo número.
--
-- ═══ As três peças ═══
--
--   atendimentos ................ uma linha por episódio, com o protocolo.
--   conversation_events ......... a linha do tempo da CONVERSA. `crm_lead_activities`
--                                 exige `lead_id`, então conversa sem negócio não
--                                 deixava rastro nenhum — nem de transferência
--                                 para time, nem de encerramento.
--   conversations.protocol ...... o protocolo VIGENTE, desnormalizado para a lista
--                                 e a busca não pagarem um join por linha. Fonte
--                                 da verdade: `atendimentos`. Quem escreve os dois
--                                 é a mesma função, na mesma transação.
--
-- Quem alimenta tudo é UM trigger em `conversations`. Não é o TypeScript de
-- propósito: a conversa muda de estado por cinco caminhos (rotas, RPC de
-- roteamento, `fn_service_inbound`, o motor de agentes via pg, MCP), e evento
-- emitido por chamador é evento que o sexto caminho esquece.

create table if not exists public.atendimento_protocol_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia             date not null,
  ultimo          integer not null default 0,
  primary key (organization_id, dia)
);

create table if not exists public.atendimentos (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  conversation_id       uuid not null references public.conversations(id) on delete cascade,
  protocol              text not null,
  started_at            timestamptz not null default now(),
  closed_at             timestamptz,
  closed_status         text,
  closed_by_user_id     uuid references auth.users(id) on delete set null,
  closed_by_name        text,
  assigned_to_user_id   uuid references auth.users(id) on delete set null,
  assigned_to_user_name text,
  team_id               uuid references public.attendance_teams(id) on delete set null,
  created_at            timestamptz not null default now(),
  constraint atendimentos_closed_status_check
    check (closed_status is null or closed_status in ('closed','resolved','archived')),
  constraint atendimentos_protocolo_unico unique (organization_id, protocol)
);

-- No máximo UM atendimento aberto por conversa: é o que torna "o atendimento
-- vigente" uma pergunta com uma resposta.
create unique index if not exists atendimentos_um_aberto_por_conversa
  on public.atendimentos(conversation_id) where closed_at is null;
create index if not exists atendimentos_org_conversa_inicio
  on public.atendimentos(organization_id, conversation_id, started_at desc);

create table if not exists public.conversation_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  atendimento_id  uuid references public.atendimentos(id) on delete set null,
  -- Vocabulário ABERTO de propósito (exceção documentada no CLAUDE.md): a linha
  -- do tempo ganha tipo novo a cada feature, e um CHECK aqui faria o `update.sh`
  -- de um clone depender da ordem em que o código e o banco chegam. O
  -- vocabulário vive em `lib/inbox/eventos-da-conversa.ts`.
  type            text not null,
  actor_kind      text not null default 'system',
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_name      text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint conversation_events_actor_kind_check check (actor_kind in ('user','ai','system'))
);

create index if not exists conversation_events_conversa_quando
  on public.conversation_events(conversation_id, created_at);

alter table public.conversations add column if not exists protocol text;
create index if not exists conversations_org_protocol
  on public.conversations(organization_id, protocol) where protocol is not null;

alter table public.atendimento_protocol_counters enable row level security;
alter table public.atendimentos                  enable row level security;
alter table public.conversation_events           enable row level security;

-- O contador não tem leitor fora das funções abaixo: RLS ligada, ZERO policies,
-- nenhum grant. As outras duas são lidas pela tela e escritas só por trigger e
-- RPC `security definer` — o grant (só SELECT) é o portão estreito.
revoke all on public.atendimento_protocol_counters from public, anon, authenticated, service_role;
revoke all on public.atendimentos, public.conversation_events from public, anon, authenticated, service_role;
grant select on public.atendimentos, public.conversation_events to authenticated, service_role;

-- O escopo é HERDADO da conversa (molde de `cae_select`, migration 0173): o
-- `exists` aplica a RLS de `conversations`, então org em `visibility_mode='own'`
-- não vaza o histórico de uma conversa que o atendente não enxerga.
drop policy if exists tenant_isolation_atendimentos_select on public.atendimentos;
create policy tenant_isolation_atendimentos_select on public.atendimentos for select to authenticated
 using (
   public.fn_is_platform_admin()
   or (organization_id in (select public.fn_user_org_ids())
       and exists (select 1 from public.conversations c where c.id = atendimentos.conversation_id))
 );

drop policy if exists tenant_isolation_conversation_events_select on public.conversation_events;
create policy tenant_isolation_conversation_events_select on public.conversation_events for select to authenticated
 using (
   public.fn_is_platform_admin()
   or (organization_id in (select public.fn_user_org_ids())
       and exists (select 1 from public.conversations c where c.id = conversation_events.conversation_id))
 );

-- ---------------------------------------------------------------------------
-- O número. AAAAMMDD + sequência do dia, por organização, no fuso dela.
-- Só dígitos: é o formato que o cliente consegue ditar por telefone.
-- ---------------------------------------------------------------------------
create or replace function public.fn_proximo_protocolo(p_org uuid, p_quando timestamptz)
returns text language plpgsql security definer set search_path=public as $$
declare v_fuso text; v_dia date; v_n integer;
begin
  select timezone into v_fuso from public.organizations where id = p_org;
  -- `organizations.timezone` não é validado por escritor nenhum: um fuso que o
  -- Postgres recusa não pode impedir uma conversa de nascer.
  begin
    v_dia := (coalesce(p_quando, clock_timestamp()) at time zone coalesce(nullif(btrim(v_fuso), ''), 'America/Sao_Paulo'))::date;
  exception when others then
    v_dia := (coalesce(p_quando, clock_timestamp()) at time zone 'America/Sao_Paulo')::date;
  end;
  insert into public.atendimento_protocol_counters(organization_id, dia, ultimo)
  values (p_org, v_dia, 1)
  on conflict (organization_id, dia)
  do update set ultimo = public.atendimento_protocol_counters.ultimo + 1
  returning ultimo into v_n;
  -- `lpad` TRUNCA acima da largura: o milionésimo atendimento do dia colidiria
  -- com o centésimo-milésimo.
  return to_char(v_dia, 'YYYYMMDD') || case when v_n < 1000000 then lpad(v_n::text, 6, '0') else v_n::text end;
end;
$$;
revoke execute on function public.fn_proximo_protocolo(uuid, timestamptz) from public, anon, authenticated;

-- Evento escrito por quem SABE de algo que a linha da conversa não conta
-- (pesquisa enviada, por exemplo). Só service_role; a organização é reconferida.
create or replace function public.fn_conversation_event_add(
  p_org uuid, p_conversation uuid, p_type text, p_actor uuid default null, p_payload jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_at uuid; v_nome text;
begin
  if coalesce(btrim(p_type), '') = '' then raise exception 'event_invalid_type' using errcode='22023'; end if;
  if not exists (select 1 from public.conversations where id = p_conversation and organization_id = p_org) then
    raise exception 'conversation_not_found' using errcode='P0002';
  end if;
  select id into v_at from public.atendimentos
   where conversation_id = p_conversation order by (closed_at is null) desc, started_at desc limit 1;
  if p_actor is not null then
    select nullif(raw_user_meta_data->>'full_name', '') into v_nome from auth.users where id = p_actor;
  end if;
  insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
  values (p_org, p_conversation, v_at, btrim(p_type), case when p_actor is null then 'system' else 'user' end, p_actor, v_nome, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.fn_conversation_event_add(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.fn_conversation_event_add(uuid, uuid, text, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- O trigger. Acompanha a conversa e mantém atendimento + linha do tempo.
--
-- ⚠️ TUDO aqui roda dentro de um `exception when others`: esta função está no
-- caminho de TODA mensagem que abre ou reabre conversa, e a linha do tempo não
-- pode derrubar a operação que ela descreve. Falha vira WARNING no log do
-- Postgres; o que ficou sem atendimento é curado pelo backfill idempotente
-- abaixo, que o `update.sh` re-aplica a cada atualização.
--
-- ⚠️ O protocolo nasce no AFTER, e não num BEFORE INSERT: `fn_upsert_wa_conversation`
-- é `insert … on conflict do update`, e o Postgres dispara BEFORE INSERT para a
-- linha PROPOSTA mesmo quando o conflito a descarta — cada mensagem recebida
-- queimaria um número do contador.
-- ---------------------------------------------------------------------------
create or replace function public.fn_atendimento_acompanha_conversa()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_terminal_antes boolean := false;
  v_terminal_agora boolean;
  v_calado_antes   boolean := false;
  v_calado_agora   boolean;
  v_ator      uuid;
  v_ator_nome text;
  v_ator_kind text := 'system';
  v_at        uuid;
  v_protocolo text;
  v_retomar   boolean;
  v_time_para text;
  v_time_de   text;
begin
  if new.is_group or coalesce(new.group_chat_id, '') like '%@g.us' then return new; end if;

  begin
    v_terminal_agora := new.status in ('closed','resolved','archived');
    if tg_op = 'UPDATE' then
      v_terminal_antes := old.status in ('closed','resolved','archived');
    end if;

    -- QUEM fez. `auth.uid()` cobre as rotas que usam o client do usuário
    -- (assumir, transferir, liberar, time, pausar). Fechar e reabrir passam pelo
    -- service role, então o ator chega pela GUC que `fn_service_status_com_ator`
    -- grava na mesma transação. Sem nenhum dos dois, foi o sistema.
    begin
      v_ator := coalesce(auth.uid(), nullif(current_setting('deskcomm.ator_user_id', true), '')::uuid);
    exception when others then v_ator := null;
    end;
    if v_ator is not null then
      select nullif(raw_user_meta_data->>'full_name', '') into v_ator_nome from auth.users where id = v_ator;
      v_ator_kind := 'user';
    end if;

    if tg_op = 'INSERT' then
      v_protocolo := public.fn_proximo_protocolo(new.organization_id, coalesce(new.service_started_at, new.created_at, clock_timestamp()));
      insert into public.atendimentos(organization_id, conversation_id, protocol, started_at, closed_at, closed_status)
      values (new.organization_id, new.id, v_protocolo, coalesce(new.service_started_at, new.created_at, clock_timestamp()),
              case when v_terminal_agora then clock_timestamp() end,
              case when v_terminal_agora then new.status end)
      returning id into v_at;
      update public.conversations set protocol = v_protocolo where id = new.id and organization_id = new.organization_id;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'opened', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('protocol', v_protocolo, 'channel', new.channel));
      return new;
    end if;

    select id, protocol into v_at, v_protocolo from public.atendimentos
     where conversation_id = new.id and closed_at is null;

    if not v_terminal_antes and v_terminal_agora then
      update public.atendimentos
         set closed_at = coalesce(new.service_closed_at, clock_timestamp()), closed_status = new.status,
             closed_by_user_id = v_ator, closed_by_name = v_ator_nome,
             assigned_to_user_id = new.assigned_to_user_id, assigned_to_user_name = new.assigned_to_user_name,
             team_id = new.team_id
       where id = v_at;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'closed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('protocol', coalesce(v_protocolo, new.protocol), 'status', new.status));

    elsif v_terminal_antes and not v_terminal_agora then
      v_retomar := coalesce(current_setting('deskcomm.retomar_atendimento', true), '') = '1';
      v_at := null;
      if v_retomar then
        -- "Reabrir" é CONTINUAR o mesmo atendimento: o protocolo não muda.
        update public.atendimentos
           set closed_at = null, closed_status = null, closed_by_user_id = null, closed_by_name = null
         where id = (select id from public.atendimentos where conversation_id = new.id
                      order by started_at desc, created_at desc limit 1)
        returning id, protocol into v_at, v_protocolo;
        if v_at is not null then
          insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
          values (new.organization_id, new.id, v_at, 'reopened', v_ator_kind, v_ator, v_ator_nome,
                  jsonb_build_object('protocol', v_protocolo));
        end if;
      end if;
      if v_at is null then
        -- O cliente voltou (ou alguém iniciou contato): atendimento NOVO.
        -- Aberto pendurado é estado legado; fecha antes, senão o índice único recusa.
        update public.atendimentos set closed_at = clock_timestamp(), closed_status = coalesce(closed_status, old.status)
         where conversation_id = new.id and closed_at is null;
        v_protocolo := public.fn_proximo_protocolo(new.organization_id, clock_timestamp());
        insert into public.atendimentos(organization_id, conversation_id, protocol, started_at)
        values (new.organization_id, new.id, v_protocolo, coalesce(new.service_started_at, clock_timestamp()))
        returning id into v_at;
        update public.conversations set protocol = v_protocolo where id = new.id and organization_id = new.organization_id;
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'opened', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('protocol', v_protocolo, 'channel', new.channel, 'retorno', true));
      end if;

    elsif v_terminal_antes and v_terminal_agora and new.status is distinct from old.status then
      update public.atendimentos set closed_status = new.status
       where id = (select id from public.atendimentos where conversation_id = new.id
                    order by started_at desc, created_at desc limit 1);
    end if;

    -- O SETOR mudou. Encaminhar solta o dono na mesma instrução, e por isso o
    -- ramo do dono, logo abaixo, cala quando o time mudou: dois eventos para um
    -- gesto é ruído.
    if new.team_id is distinct from old.team_id then
      select name into v_time_para from public.attendance_teams where id = new.team_id;
      select name into v_time_de   from public.attendance_teams where id = old.team_id;
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'team_changed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('to_team_id', new.team_id, 'to_team_name', v_time_para,
                                 'from_team_id', old.team_id, 'from_team_name', v_time_de));
    end if;

    if new.assigned_to_user_id is distinct from old.assigned_to_user_id then
      if new.assigned_to_user_id is not null then
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'assigned', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('to_user_id', new.assigned_to_user_id, 'to_user_name', new.assigned_to_user_name,
                                   'from_user_id', old.assigned_to_user_id, 'from_user_name', old.assigned_to_user_name));
      elsif new.team_id is not distinct from old.team_id and not (v_terminal_antes and not v_terminal_agora) then
        insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
        values (new.organization_id, new.id, v_at, 'released', v_ator_kind, v_ator, v_ator_nome,
                jsonb_build_object('from_user_id', old.assigned_to_user_id, 'from_user_name', old.assigned_to_user_name));
      end if;
    end if;

    -- A passagem do automático para uma pessoa. O motivo livre NÃO entra no
    -- payload: ele pode ser texto escrito por atendente sobre o cliente.
    if new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'handoff', 'ai', null, null, '{}'::jsonb);
    end if;

    -- O automático calou ou voltou — só quando ESTE foi o gesto. Assumir cala na
    -- mesma instrução (o evento é "assumiu"); passar para humano também (o
    -- evento é a passagem); fechar e liberar limpam o silêncio (idem).
    v_calado_antes := old.bot_silenced_until is not null and old.bot_silenced_until > clock_timestamp();
    v_calado_agora := new.bot_silenced_until is not null and new.bot_silenced_until > clock_timestamp();
    if v_calado_agora is distinct from v_calado_antes
       and new.assigned_to_user_id is not distinct from old.assigned_to_user_id
       and new.last_handoff_at is not distinct from old.last_handoff_at
       and not v_terminal_agora then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, case when v_calado_agora then 'ai_paused' else 'ai_resumed' end,
              v_ator_kind, v_ator, v_ator_nome, '{}'::jsonb);
    end if;

    if new.snooze_until is not null and new.snooze_until is distinct from old.snooze_until then
      insert into public.conversation_events(organization_id, conversation_id, atendimento_id, type, actor_kind, actor_user_id, actor_name, payload)
      values (new.organization_id, new.id, v_at, 'snoozed', v_ator_kind, v_ator, v_ator_nome,
              jsonb_build_object('until', new.snooze_until));
    end if;
  exception when others then
    raise warning 'fn_atendimento_acompanha_conversa: % (%)', sqlerrm, sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.fn_atendimento_acompanha_conversa() from public, anon, authenticated;

-- Fechar e reabrir COM AUTOR. As duas portas da API usam o service role (é o que
-- `fn_service_status` exige), então `auth.uid()` é nulo lá dentro e a linha do
-- tempo diria "o sistema fechou". A GUC é local à transação: não vaza para a
-- próxima chamada da mesma conexão do pool.
--
-- `p_retomar` é o "Reabrir" do atendente: continua o MESMO atendimento, com o
-- mesmo protocolo. Sem ele, sair de um estado terminal abre atendimento novo —
-- que é o que acontece quando o cliente escreve de novo.
create or replace function public.fn_service_status_com_ator(
  p_org uuid, p_conversation uuid, p_status text, p_expected bigint, p_actor uuid, p_retomar boolean default false
) returns public.conversations language plpgsql security definer set search_path=public as $$
declare c public.conversations;
begin
  perform set_config('deskcomm.ator_user_id', coalesce(p_actor::text, ''), true);
  perform set_config('deskcomm.retomar_atendimento', case when p_retomar then '1' else '' end, true);
  c := public.fn_service_status(p_org, p_conversation, p_status, p_expected);
  -- O trigger grava o protocolo DEPOIS do `returning` de `fn_service_status`.
  select * into c from public.conversations where id = p_conversation and organization_id = p_org;
  return c;
end;
$$;
revoke execute on function public.fn_service_status_com_ator(uuid, uuid, text, bigint, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.fn_service_status_com_ator(uuid, uuid, text, bigint, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: toda conversa 1:1 que ainda não tem atendimento ganha UM, com o
-- estado de agora. Os ciclos anteriores de uma conversa já reaberta NÃO são
-- reconstruídos — não há carimbo confiável deles, e protocolo inventado para o
-- passado seria pior que ausente. Idempotente: só toca quem não tem.
-- Em ordem de início, para a sequência do dia acompanhar o relógio.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_p text; v_terminal boolean; v_inicio timestamptz;
begin
  for r in
    select c.id, c.organization_id, c.status, c.created_at, c.service_started_at, c.service_closed_at,
           c.status_changed_at, c.assigned_to_user_id, c.assigned_to_user_name, c.team_id
      from public.conversations c
     where not c.is_group and coalesce(c.group_chat_id, '') not like '%@g.us'
       and not exists (select 1 from public.atendimentos a where a.conversation_id = c.id)
     order by c.organization_id, coalesce(c.service_started_at, c.created_at), c.id
  loop
    v_terminal := r.status in ('closed','resolved','archived');
    v_inicio := coalesce(r.service_started_at, r.created_at, clock_timestamp());
    v_p := public.fn_proximo_protocolo(r.organization_id, v_inicio);
    insert into public.atendimentos(organization_id, conversation_id, protocol, started_at, closed_at, closed_status,
                                    assigned_to_user_id, assigned_to_user_name, team_id)
    values (r.organization_id, r.id, v_p, v_inicio,
            case when v_terminal then coalesce(r.service_closed_at, r.status_changed_at, clock_timestamp()) end,
            case when v_terminal then r.status end,
            case when v_terminal then r.assigned_to_user_id end,
            case when v_terminal then r.assigned_to_user_name end,
            case when v_terminal then r.team_id end);
    update public.conversations set protocol = v_p where id = r.id and organization_id = r.organization_id;
  end loop;
end $$;

-- Criado só se faltar: `drop` + `create` a cada `update.sh` pediria uma trava na
-- tabela mais quente do produto sem mudar nada (a 0222 já pagou um deadlock
-- assim em `job_queue`).
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_atendimento_nasce_com_a_conversa'
                   and tgrelid = 'public.conversations'::regclass) then
    create trigger trg_atendimento_nasce_com_a_conversa after insert on public.conversations
      for each row execute function public.fn_atendimento_acompanha_conversa();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_atendimento_acompanha_a_conversa'
                   and tgrelid = 'public.conversations'::regclass) then
    create trigger trg_atendimento_acompanha_a_conversa after update on public.conversations
      for each row when (
        old.status is distinct from new.status
        or old.assigned_to_user_id is distinct from new.assigned_to_user_id
        or old.team_id is distinct from new.team_id
        or old.bot_silenced_until is distinct from new.bot_silenced_until
        or old.last_handoff_at is distinct from new.last_handoff_at
        or old.snooze_until is distinct from new.snooze_until
      ) execute function public.fn_atendimento_acompanha_conversa();
  end if;
end $$;

notify pgrst, 'reload schema';
