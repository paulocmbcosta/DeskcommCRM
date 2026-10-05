-- 0293 — encerramento: assunto por time e resumo do atendimento
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
-- Encerrar um atendimento era um `confirm()` do navegador. O atendimento fechava
-- com protocolo, time e autor (0266) — e sem dizer do que tratou. Não havia como
-- responder "quais assuntos geram mais atendimento", e o histórico do cliente
-- listava protocolos mudos.
--
-- Medido numa instalação em produção (2026-10-05, 14 dias): 1.063 encerramentos,
-- todos por pessoa, 32% deles sem time.
--
-- Desenho: docs/superpowers/specs/2026-10-05-janela-de-encerramento-design.md
--
-- ─── As peças ───────────────────────────────────────────────────────────────
--   atendimento_assuntos ........... o cadastro, POR TIME, de quem administra.
--   atendimentos.assunto_id ........ o assunto do atendimento (um só).
--   atendimentos.closure_summary ... o resumo escrito por quem atendeu.
--   fn_atendimento_encerrar ........ a PORTA ÚNICA do encerramento por pessoa:
--                                    valida, fecha e grava, na mesma transação.
--
-- O registro é COLUNA de `atendimentos`, e não tabela: é um por atendimento e
-- nasce e morre com ele (DIRC). O time do atendimento NÃO muda: `team_id` segue
-- sendo quem estava com a conversa (fato); o setor do assunto vem do cadastro
-- (classificação). Gravar o setor escolhido em `conversations.team_id` emitiria
-- `team_changed` e acordaria o roteamento — é o gesto de encaminhar, e ninguém
-- encaminhou.
--
-- Idempotente e portável: `if not exists`, `create or replace`, constraints e
-- gatilho criados só se faltarem (sem pedir trava em tabela quente a cada
-- `update.sh`). Sem backfill: classificar o passado seria inventar.

-- ---------------------------------------------------------------------------
-- O cadastro. Arquivar, nunca apagar: o assunto continua nomeando o passado.
-- A FK COMPOSTA torna impossível pendurar um assunto no time de outra
-- organização (mesmo desenho de `attendance_team_members`, 0263).
-- ---------------------------------------------------------------------------
create table if not exists public.atendimento_assuntos (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  team_id         uuid not null,
  name            text not null,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint atendimento_assuntos_nome_check check (char_length(btrim(name)) between 1 and 60),
  unique (organization_id, id),
  foreign key (organization_id, team_id)
    references public.attendance_teams(organization_id, id) on delete cascade
);

-- Um nome por time, sem diferenciar maiúscula nem espaço nas pontas. Vale também
-- contra os arquivados: criar de novo um nome arquivado o REATIVA (ver a função).
create unique index if not exists atendimento_assuntos_nome_unico_por_time
  on public.atendimento_assuntos(team_id, lower(btrim(name)));
create index if not exists atendimento_assuntos_org_time
  on public.atendimento_assuntos(organization_id, team_id);

alter table public.atendimento_assuntos enable row level security;
revoke all on public.atendimento_assuntos from public, anon, authenticated, service_role;
grant select on public.atendimento_assuntos to authenticated, service_role;

-- Policy só de SELECT, e GRANT só de SELECT: a tabela não tem escrita pela REST
-- por nenhum dos dois portões. É o formato de `attendance_teams` depois da
-- correção dela — uma policy `for all` só com tenancy é a dívida de RBAC que
-- `tests/invariants/rbac-config-ia-canais.test.ts` não deixa crescer.
drop policy if exists tenant_isolation_atendimento_assuntos_all on public.atendimento_assuntos;
drop policy if exists tenant_isolation_atendimento_assuntos_select on public.atendimento_assuntos;
create policy tenant_isolation_atendimento_assuntos_select on public.atendimento_assuntos for select to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- ---------------------------------------------------------------------------
-- O registro, no próprio atendimento.
-- ---------------------------------------------------------------------------
alter table public.atendimentos add column if not exists assunto_id uuid;
alter table public.atendimentos add column if not exists closure_summary text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'atendimentos_assunto_id_fkey'
                   and conrelid = 'public.atendimentos'::regclass) then
    alter table public.atendimentos add constraint atendimentos_assunto_id_fkey
      foreign key (assunto_id) references public.atendimento_assuntos(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'atendimentos_closure_summary_check'
                   and conrelid = 'public.atendimentos'::regclass) then
    alter table public.atendimentos add constraint atendimentos_closure_summary_check
      check (closure_summary is null or char_length(closure_summary) <= 2000);
  end if;
end $do$;

-- Os dois índices que existiam são por conversa; o painel de assuntos lê por período.
create index if not exists atendimentos_org_fechamento
  on public.atendimentos(organization_id, closed_at) where closed_at is not null;
create index if not exists atendimentos_assunto
  on public.atendimentos(assunto_id) where assunto_id is not null;

comment on column public.atendimentos.closure_summary is
  'Resumo do atendimento, escrito por quem encerrou. Texto livre sobre o cliente: é dado pessoal, zerado por trg_redigir_encerramentos_ao_anonimizar e NUNCA copiado para payload de evento nem para o audit log.';
comment on column public.atendimentos.assunto_id is
  'O assunto do atendimento (atendimento_assuntos). O setor do assunto vem do cadastro; atendimentos.team_id continua sendo o time que estava com a conversa.';

-- ---------------------------------------------------------------------------
-- Cadastro: criar/renomear e arquivar/reativar. Os portões (papel, suporte, MFA)
-- são os de `fn_save_attendance_team`, e estão no BANCO: a rota é a primeira
-- barreira, não a única.
-- ---------------------------------------------------------------------------
create or replace function public.fn_save_atendimento_assunto(
  p_org uuid, p_team uuid, p_assunto uuid, p_name text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_arquivado timestamptz; v_nome text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'assunto_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'assunto_mfa_required' using errcode='42501'; end if;
  if v_nome = '' or char_length(v_nome) > 60 then
    raise exception 'assunto_invalid_name' using errcode='22023'; end if;
  if not exists (select 1 from public.attendance_teams where organization_id = p_org and id = p_team) then
    raise exception 'assunto_team_not_found' using errcode='P0002'; end if;

  if p_assunto is null then
    select id, archived_at into v_id, v_arquivado
      from public.atendimento_assuntos
     where organization_id = p_org and team_id = p_team and lower(btrim(name)) = lower(v_nome)
       for update;
    if v_id is null then
      insert into public.atendimento_assuntos(organization_id, team_id, name)
      values (p_org, p_team, v_nome) returning id into v_id;
    elsif v_arquivado is null then
      raise exception 'assunto_duplicado' using errcode='23505';
    else
      -- O nome existia arquivado: volta o MESMO assunto, e os atendimentos que
      -- já o citavam continuam citando.
      update public.atendimento_assuntos set archived_at = null, name = v_nome, updated_at = now()
       where id = v_id;
    end if;
  else
    -- Renomear não muda o assunto de time: o `team_id` entra no predicado.
    update public.atendimento_assuntos set name = v_nome, updated_at = now()
     where organization_id = p_org and team_id = p_team and id = p_assunto
    returning id into v_id;
    if v_id is null then raise exception 'assunto_not_found' using errcode='P0002'; end if;
  end if;
  return jsonb_build_object('id', v_id, 'team_id', p_team, 'name', v_nome);
end;
$$;
revoke execute on function public.fn_save_atendimento_assunto(uuid,uuid,uuid,text) from public, anon;
grant  execute on function public.fn_save_atendimento_assunto(uuid,uuid,uuid,text) to authenticated;

create or replace function public.fn_archive_atendimento_assunto(p_org uuid, p_assunto uuid, p_arquivar boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'assunto_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'assunto_mfa_required' using errcode='42501'; end if;
  update public.atendimento_assuntos
     set archived_at = case when coalesce(p_arquivar, true) then coalesce(archived_at, now()) else null end,
         updated_at = now()
   where organization_id = p_org and id = p_assunto returning id into v_id;
  if v_id is null then raise exception 'assunto_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('id', v_id, 'archived', coalesce(p_arquivar, true));
end;
$$;
revoke execute on function public.fn_archive_atendimento_assunto(uuid,uuid,boolean) from public, anon;
grant  execute on function public.fn_archive_atendimento_assunto(uuid,uuid,boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- A PORTA ÚNICA do encerramento por pessoa.
--
-- A regra de obrigatoriedade mora AQUI, e não na tela nem na rota: a conversa
-- fecha por duas portas da API (POST /close e PATCH com status terminal), e
-- regra aplicada por chamador é regra que a terceira porta esquece — a mesma
-- razão de a linha do tempo ser escrita por trigger (0266).
--
-- Toma a trava do contato ANTES de ler o atendimento aberto, na mesma ordem de
-- `fn_service_status` (trava do contato → linha da conversa). Sem isso, dois
-- atendentes fechando ao mesmo tempo poderiam gravar o registro de um sobre o
-- fechamento do outro. A trava é de transação e reentrante.
--
-- Omitir assunto ou resumo NÃO apaga o que o atendimento já tinha: é o que faz
-- "Reabrir e fechar de novo" não perder o registro.
--
-- O RESUMO NÃO ENTRA no payload do evento: é texto livre sobre o cliente (mesma
-- regra do motivo da passagem, no trigger da 0266).
-- ---------------------------------------------------------------------------
create or replace function public.fn_atendimento_encerrar(
  p_org uuid, p_conversation uuid, p_expected bigint, p_actor uuid,
  p_assunto uuid, p_resumo text, p_status text default 'closed'
) returns public.conversations language plpgsql security definer set search_path=public as $$
declare
  c                public.conversations;
  v_at             uuid;
  v_assunto        uuid;
  v_resumo         text;
  v_cfg            jsonb;
  v_exigir_assunto boolean;
  v_exigir_resumo  boolean;
  v_assunto_nome   text;
  v_time_nome      text;
begin
  if p_status is null or p_status not in ('closed','resolved','archived') then
    raise exception 'invalid_status' using errcode='22023'; end if;

  select * into c from public.conversations where id = p_conversation and organization_id = p_org;
  if not found then raise exception 'service_not_found' using errcode='P0002'; end if;
  perform public.fn_service_lock(p_org, c.contact_id);
  select * into c from public.conversations where id = p_conversation and organization_id = p_org for no key update;

  -- Já encerrada (outro atendente fechou primeiro, ou é troca entre estados
  -- terminais): o registro de quem fechou fica como está.
  if c.status in ('closed','resolved','archived') then
    return public.fn_service_status_com_ator(p_org, p_conversation, p_status, p_expected, p_actor, false);
  end if;

  select a.id, a.assunto_id, a.closure_summary into v_at, v_assunto, v_resumo
    from public.atendimentos a
   where a.conversation_id = p_conversation and a.organization_id = p_org and a.closed_at is null;

  -- Conversa de grupo não tem atendimento (o trigger da 0266 a pula): não há
  -- onde gravar, então não há o que exigir.
  if v_at is null then
    return public.fn_service_status_com_ator(p_org, p_conversation, p_status, p_expected, p_actor, false);
  end if;

  if p_assunto is not null then
    if not exists (
      select 1 from public.atendimento_assuntos s
        join public.attendance_teams t on t.id = s.team_id and t.organization_id = s.organization_id
       where s.id = p_assunto and s.organization_id = p_org
         and s.archived_at is null and t.archived_at is null
    ) then
      raise exception 'encerramento_assunto_invalido' using errcode='22023';
    end if;
    v_assunto := p_assunto;
  end if;
  v_resumo := coalesce(nullif(btrim(coalesce(p_resumo, '')), ''), v_resumo);

  select settings->'atendimento'->'encerramento' into v_cfg from public.organizations where id = p_org;
  -- Comparação de jsonb, e não cast: `settings` não é validado por escritor
  -- nenhum, e um valor torto ali não pode impedir uma conversa de fechar.
  v_exigir_assunto := coalesce(v_cfg->'exigir_assunto' = 'true'::jsonb, false);
  v_exigir_resumo  := coalesce(v_cfg->'exigir_resumo'  = 'true'::jsonb, false);

  if char_length(coalesce(v_resumo, '')) > 2000 then
    raise exception 'encerramento_resumo_longo' using errcode='22023'; end if;
  -- Sem assunto ATIVO cadastrado não há o que exigir: ligar o interruptor antes
  -- de cadastrar não pode travar o encerramento da organização inteira.
  if v_exigir_assunto and v_assunto is null and exists (
    select 1 from public.atendimento_assuntos s
      join public.attendance_teams t on t.id = s.team_id and t.organization_id = s.organization_id
     where s.organization_id = p_org and s.archived_at is null and t.archived_at is null
  ) then
    raise exception 'encerramento_assunto_obrigatorio' using errcode='22023';
  end if;
  if v_exigir_resumo and char_length(coalesce(v_resumo, '')) < 10 then
    raise exception 'encerramento_resumo_obrigatorio' using errcode='22023'; end if;

  c := public.fn_service_status_com_ator(p_org, p_conversation, p_status, p_expected, p_actor, false);

  update public.atendimentos set assunto_id = v_assunto, closure_summary = v_resumo
   where id = v_at and organization_id = p_org;

  if v_assunto is not null then
    select s.name, t.name into v_assunto_nome, v_time_nome
      from public.atendimento_assuntos s
      left join public.attendance_teams t on t.id = s.team_id
     where s.id = v_assunto;
    update public.conversation_events
       set payload = payload || jsonb_build_object('assunto_id', v_assunto, 'assunto', v_assunto_nome, 'assunto_time', v_time_nome)
     where id = (select e.id from public.conversation_events e
                  where e.atendimento_id = v_at and e.type = 'closed'
                  order by e.created_at desc, e.id desc limit 1);
  end if;
  return c;
end;
$$;
revoke execute on function public.fn_atendimento_encerrar(uuid,uuid,bigint,uuid,uuid,text,text) from public, anon, authenticated;
grant  execute on function public.fn_atendimento_encerrar(uuid,uuid,bigint,uuid,uuid,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- Os números. Sem seletor de linha além da organização e do período.
-- Só service_role: quem lê é gerente ou administrador, que enxergam todas as
-- conversas da organização — a RLS por linha aqui só custaria (0283).
-- ---------------------------------------------------------------------------
create or replace function public.fn_metricas_de_assuntos(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (
  assunto_id uuid, assunto_nome text, assunto_team_id uuid, assunto_team_nome text,
  atendimento_team_id uuid, atendimento_team_nome text, total bigint
) language sql stable security definer set search_path=public as $$
  select a.assunto_id, s.name, s.team_id, ts.name, a.team_id, ta.name, count(*)::bigint
    from public.atendimentos a
    left join public.atendimento_assuntos s on s.id = a.assunto_id and s.organization_id = a.organization_id
    left join public.attendance_teams ts on ts.id = s.team_id and ts.organization_id = a.organization_id
    left join public.attendance_teams ta on ta.id = a.team_id and ta.organization_id = a.organization_id
   where a.organization_id = p_org
     and a.closed_at is not null and a.closed_at >= p_from and a.closed_at < p_to
   group by a.assunto_id, s.name, s.team_id, ts.name, a.team_id, ta.name;
$$;
revoke execute on function public.fn_metricas_de_assuntos(uuid,timestamptz,timestamptz) from public, anon, authenticated;
grant  execute on function public.fn_metricas_de_assuntos(uuid,timestamptz,timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- LGPD: anonimizar o contato zera o resumo dos atendimentos dele.
--
-- TRIGGER na transição `is_anonymized false → true`, pelo motivo escrito nas
-- migrations 0174 e 0184: é o último fato da anonimização, roda na mesma
-- transação e alcança QUALQUER caminho que anonimize. O assunto fica — é
-- estatística, não dado da pessoa.
-- ---------------------------------------------------------------------------
create or replace function public.fn_redigir_encerramentos_do_contato_anonimizado()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.atendimentos a
     set closure_summary = null
   where a.organization_id = new.organization_id
     and a.closure_summary is not null
     and a.conversation_id in (select c.id from public.conversations c
                                where c.organization_id = new.organization_id and c.contact_id = new.id);
  return new;
end;
$$;
revoke execute on function public.fn_redigir_encerramentos_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_encerramentos_do_contato_anonimizado() to service_role;

do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_redigir_encerramentos_ao_anonimizar'
                   and tgrelid = 'public.contacts'::regclass) then
    create trigger trg_redigir_encerramentos_ao_anonimizar
      after update of is_anonymized on public.contacts
      for each row
      when (new.is_anonymized is true and old.is_anonymized is distinct from true)
      execute function public.fn_redigir_encerramentos_do_contato_anonimizado();
  end if;
end $do$;

notify pgrst, 'reload schema';
