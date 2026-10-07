-- ---- telefonia: as ordens da fila — atender e mover (migration 0296) ----
--
-- A aba Telefone (0295) MOSTRA a fila; quem coordena o atendimento ainda não
-- age nela: numa queda de internet (o pico de um provedor) não há como puxar
-- para si a ligação que espera há mais tempo, nem mandar para a fila de outro
-- time a que caiu no time errado. Desenho:
-- docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md §4.3.
--
-- ─── O que entra, e por que cada peça ──────────────────────────────────────
--
-- `voice_call_queue_orders`: uma linha por ORDEM pedida sobre uma ligação que
-- espera na fila. O desenho é o da transferência (0290, §12.4 da fase 2): a
-- rota confere e GRAVA o pedido, avisa o worker por um evento, e o worker relê
-- a linha pelo id — com a organização da ligação que ele tem em memória — e
-- revalida antes de agir. O que atravessa o evento é só um id; quem pediu, o
-- quê e para onde saem do banco, não do que o navegador mandou.
--
--  - `kind`: `pull` (um atendente puxa a ligação para o próprio ramal — o botão
--    "Atender") ou `move` (gerente/admin manda a ligação para a fila de outro
--    time — "Mover");
--  - `requested_by`: quem pediu. `to_user_id`: no `pull`, o ramal que vai tocar
--    (é quem pediu). `to_team_id` e `from_team_id`: no `move`, para onde vai e
--    de onde saiu; no `pull`, `from_team_id` é o time em que a ligação esperava;
--  - `status`: `open` enquanto acontece, `ended` quando acaba; `ended_at`
--    preenchido exatamente quando acaba;
--  - `outcome`, só no fim: `done` (a pessoa atendeu, ou a ligação mudou de
--    time), `no_answer` (quem puxou não atendeu a tempo: a ligação volta ao
--    rodízio de onde estava), `refused` (a rota ou o worker recusou; o porquê
--    em `reason`) ou `cancelled` (a ligação acabou antes, ou o worker reiniciou);
--  - `reason`: vocabulário ABERTO, sem CHECK (cresce com o worker, e é texto
--    para a tela e o log).
--
-- Tabela própria, e não tipos novos em `voice_call_transfers`: aquela pressupõe
-- ligação ATENDIDA e um dono de origem, e o cartão da ligação lê a corrente dela
-- como transferências.
--
-- Uma ordem aberta por ligação, no banco: índice único parcial
-- `(voice_call_id) where status = 'open'`. Dois atendentes clicando "Atender"
-- na mesma ligação não abrem duas — o segundo recebe "Ana já está atendendo".
--
-- A ligação por FK COMPOSTA com a organização (`voice_calls (organization_id,
-- id)`, o alvo que a 0290 criou): o próprio banco recusa a ordem de uma
-- organização apontando para a ligação de outra. Os dois times, idem, com
-- `set null` só da coluna: apagar o time não apaga a história da ordem.
--
-- ─── Quem lê e quem escreve ────────────────────────────────────────────────
--
-- RLS só de leitura (`tenant_isolation_voice_call_queue_orders_select`) e GRANT
-- só de SELECT: a escrita é da API (o pedido, com a organização da SESSÃO) e do
-- worker (o desfecho), os dois pela conexão direta — nunca da REST.
--
-- O `revoke all` é o que protege, e não o `grant select` enumerado: todo
-- projeto Supabase tem um default ACL que concede TUDO em tabela nova de
-- `public` a `anon`, `authenticated` e `service_role` (o corpo do baseline o
-- regrava), e GRANT só acrescenta. Sem o `revoke`, `service_role` — que ignora
-- RLS — gravaria e apagaria a ordem de qualquer organização pela REST. Medido
-- com controle em tests/invariants/telefonia-ordens-da-fila-schema.test.ts.
--
-- ─── Idempotência ──────────────────────────────────────────────────────────
--
-- `create ... if not exists`; `drop policy if exists` antes do `create`. Cada
-- CHECK só quando falta, NOT VALID, e validado enquanto estiver assim: a tabela
-- nasce com os quatro, então linha fora da regra só existe se alguém derrubou
-- um deles à mão — e aí o CHECK volta valendo para toda linha nova e o
-- `update.sh` AVISA, em vez de quebrar. Não há cura de dado: não se inventa o
-- tipo nem o desfecho de um pedido. Sem BEGIN/COMMIT (o runner envolve em
-- transação). Nenhuma função nova.

-- 1. voice_call_queue_orders -------------------------------------------------------
create table if not exists public.voice_call_queue_orders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  voice_call_id   uuid not null,
  kind            text not null,
  requested_by    uuid references auth.users(id) on delete set null,
  to_user_id      uuid references auth.users(id) on delete set null,
  to_team_id      uuid,
  from_team_id    uuid,
  status          text not null default 'open',
  outcome         text,
  reason          text,
  created_at      timestamptz not null default now(),
  ended_at        timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, voice_call_id) references public.voice_calls (organization_id, id) on delete cascade,
  -- set null só da coluna: apagar o time não apaga a história da ordem.
  foreign key (organization_id, to_team_id) references public.attendance_teams (organization_id, id)
    on delete set null (to_team_id),
  foreign key (organization_id, from_team_id) references public.attendance_teams (organization_id, id)
    on delete set null (from_team_id)
);

do $chk_ordens_0296$
declare
  pendente text;
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_queue_orders'::regclass
                    and conname = 'voice_call_queue_orders_kind_check') then
    alter table public.voice_call_queue_orders add constraint voice_call_queue_orders_kind_check
      check (kind in ('pull', 'move')) not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_queue_orders'::regclass
                    and conname = 'voice_call_queue_orders_status_check') then
    alter table public.voice_call_queue_orders add constraint voice_call_queue_orders_status_check
      check (status in ('open', 'ended')) not valid;
  end if;

  -- Nulo enquanto a ordem não acaba; preenchido, só do vocabulário.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_queue_orders'::regclass
                    and conname = 'voice_call_queue_orders_outcome_check') then
    alter table public.voice_call_queue_orders add constraint voice_call_queue_orders_outcome_check
      check (outcome is null or outcome in ('done', 'refused', 'no_answer', 'cancelled')) not valid;
  end if;

  -- Aberta não tem fim; encerrada tem.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_queue_orders'::regclass
                    and conname = 'voice_call_queue_orders_fim_check') then
    alter table public.voice_call_queue_orders add constraint voice_call_queue_orders_fim_check
      check ((status = 'open') = (ended_at is null)) not valid;
  end if;

  -- A validação só do que ainda está NOT VALID: no banco são, a reaplicação não
  -- varre a tabela de novo.
  for pendente in
    select k.conname from pg_constraint k
     where k.conrelid = 'public.voice_call_queue_orders'::regclass and k.contype = 'c' and not k.convalidated
       and k.conname in ('voice_call_queue_orders_kind_check', 'voice_call_queue_orders_status_check',
                         'voice_call_queue_orders_outcome_check', 'voice_call_queue_orders_fim_check')
     order by k.conname
  loop
    begin
      execute format('alter table public.voice_call_queue_orders validate constraint %I', pendente);
    exception when check_violation then
      raise warning '0296: voice_call_queue_orders tem linha que viola % — o CHECK vale para toda linha nova (NOT VALID); corrija a linha e o próximo update.sh o valida', pendente;
    end;
  end loop;
end $chk_ordens_0296$;

create unique index if not exists voice_call_queue_orders_uma_aberta
  on public.voice_call_queue_orders (voice_call_id) where status = 'open';
create index if not exists voice_call_queue_orders_da_ligacao
  on public.voice_call_queue_orders (organization_id, voice_call_id, created_at);

-- 2. RLS, GRANT e policy -----------------------------------------------------------
alter table public.voice_call_queue_orders enable row level security;

revoke all on public.voice_call_queue_orders from public, anon, authenticated, service_role;
grant select on public.voice_call_queue_orders to authenticated, service_role;

drop policy if exists tenant_isolation_voice_call_queue_orders_all on public.voice_call_queue_orders;
drop policy if exists tenant_isolation_voice_call_queue_orders_select on public.voice_call_queue_orders;
create policy tenant_isolation_voice_call_queue_orders_select on public.voice_call_queue_orders for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- 3. Comentários -------------------------------------------------------------------
comment on table public.voice_call_queue_orders is
  'Ordens sobre uma ligação que espera na fila do telefone: pull (um atendente a puxa para o próprio ramal) ou move (gerente/admin a manda para a fila de outro time). Aberta (status open) enquanto acontece — no máximo uma por ligação (índice voice_call_queue_orders_uma_aberta) —, encerrada com outcome. Escrita só pela API (o pedido) e pelo worker (o desfecho); pela REST é só leitura.';
comment on column public.voice_call_queue_orders.kind is
  'pull = "Atender": toca o ramal de quem pediu (to_user_id). move = "Mover": a ligação vai para a fila de to_team_id. Nos dois, from_team_id é o time em que ela esperava.';
comment on column public.voice_call_queue_orders.outcome is
  'done (a pessoa atendeu, ou a ligação mudou de time), no_answer (quem puxou não atendeu a tempo: a ligação volta ao rodízio), refused (a rota ou o worker recusou; o porquê em reason), cancelled (a ligação acabou antes, ou o worker reiniciou). NULL enquanto aberta.';
comment on column public.voice_call_queue_orders.reason is
  'Vocabulário aberto, sem CHECK: o motivo de refused/cancelled (telefonia_indisponivel, worker_reiniciou…). Lido pela tela e pelo log.';

notify pgrst, 'reload schema';
