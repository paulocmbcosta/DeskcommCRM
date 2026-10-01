-- 0290 — telefonia, fase 2, versão 2: transferência de ligação.
--
-- Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md,
-- §12 (emenda de 2026-09-30), que prevalece sobre §3.2. Plano:
-- docs/superpowers/plans/2026-09-30-telefonia-v2-v3-transferencia-e-ramais.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `voice_calls` ganha `unique (organization_id, id)`: é o alvo da FK
--    COMPOSTA que a transferência aponta para a ligação — o próprio banco recusa
--    uma transferência de uma organização apontando para a ligação de outra.
-- 2. `voice_call_transfers`: uma linha por transferência pedida.
--    - quem pediu (`requested_by` — o dono da ligação, ou gerente/admin), de quem
--      a ligação sai (`from_user_id`) e o destino: uma pessoa (`to_user_id`) OU
--      um time (`to_team_id`), exatamente um;
--    - `kind`: `blind` (direta) ou `attended` (consultada — só para pessoa, D9);
--    - `status`: `open` enquanto acontece, `ended` quando acaba; e o `outcome`,
--      preenchido SÓ no fim: `answered` (a pessoa atendeu), `returned` (voltou a
--      quem transferiu), `queue_answered` (alguém do time pegou na fila),
--      `missed` (ninguém pegou — vira "Ligar de volta"), `refused` (o worker
--      recusou na revalidação, com `reason`) ou `cancelled` (o cliente desligou,
--      quem transferiu voltou ao cliente, ou o worker reiniciou);
--    - `reason`: vocabulário ABERTO, sem CHECK (o motivo da recusa ou do
--      cancelamento — cresce com o worker, e é texto para o log e o painel);
--    - `answered_by`: quem ficou com a ligação no fim.
--    Uma por vez em cada ligação, também no banco: índice único parcial
--    `(voice_call_id) where status = 'open'` — dois cliques simultâneos em
--    "Transferir" não abrem duas.
-- 3. RLS só de leitura (`tenant_isolation_voice_call_transfers_select`), GRANT
--    só de SELECT: a escrita é da API (cliente de serviço, organização da
--    SESSÃO) e do worker (conexão direta), nunca da REST.
--
-- Idempotente: `create ... if not exists`, CHECKs e FKs só quando faltam. Sem
-- BEGIN/COMMIT (o runner envolve em transação).

-- 1. voice_calls: o alvo da FK composta ----------------------------------------
do $uq_ligacao$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass
                    and conname = 'voice_calls_organization_id_id_key') then
    alter table public.voice_calls
      add constraint voice_calls_organization_id_id_key unique (organization_id, id);
  end if;
end $uq_ligacao$;

-- 2. voice_call_transfers --------------------------------------------------------
create table if not exists public.voice_call_transfers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  voice_call_id   uuid not null,
  requested_by    uuid references auth.users(id) on delete set null,
  from_user_id    uuid references auth.users(id) on delete set null,
  to_user_id      uuid references auth.users(id) on delete set null,
  to_team_id      uuid,
  kind            text not null,
  status          text not null default 'open',
  outcome         text,
  reason          text,
  answered_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  ended_at        timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, voice_call_id) references public.voice_calls (organization_id, id) on delete cascade,
  -- set null só da coluna: apagar o time não apaga a história da transferência.
  foreign key (organization_id, to_team_id) references public.attendance_teams (organization_id, id)
    on delete set null (to_team_id)
);

do $chk_transferencias$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_transfers'::regclass
                    and conname = 'voice_call_transfers_kind_check') then
    alter table public.voice_call_transfers add constraint voice_call_transfers_kind_check
      check (kind in ('blind', 'attended'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_transfers'::regclass
                    and conname = 'voice_call_transfers_status_check') then
    alter table public.voice_call_transfers add constraint voice_call_transfers_status_check
      check (status in ('open', 'ended'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_transfers'::regclass
                    and conname = 'voice_call_transfers_outcome_check') then
    alter table public.voice_call_transfers add constraint voice_call_transfers_outcome_check
      check (
        (status = 'open' and outcome is null and ended_at is null)
        -- `outcome is not null` explícito: `null in (...)` é NULL, e CHECK com NULL passa.
        or (status = 'ended' and ended_at is not null and outcome is not null
            and outcome in ('answered', 'returned', 'queue_answered', 'missed', 'refused', 'cancelled'))
      );
  end if;

  -- Exatamente um destino — no pedido. O time apagado depois (set null) deixa a
  -- linha ENCERRADA sem destino; por isso o CHECK só vale enquanto ela está aberta.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_transfers'::regclass
                    and conname = 'voice_call_transfers_destino_check') then
    alter table public.voice_call_transfers add constraint voice_call_transfers_destino_check
      check (status <> 'open' or ((to_user_id is null) <> (to_team_id is null)));
  end if;

  -- D9: a consultada é só para pessoa.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_call_transfers'::regclass
                    and conname = 'voice_call_transfers_consultada_check') then
    alter table public.voice_call_transfers add constraint voice_call_transfers_consultada_check
      check (kind <> 'attended' or to_team_id is null);
  end if;
end $chk_transferencias$;

create unique index if not exists voice_call_transfers_uma_aberta
  on public.voice_call_transfers (voice_call_id) where status = 'open';
create index if not exists voice_call_transfers_da_ligacao
  on public.voice_call_transfers (organization_id, voice_call_id, created_at);
create index if not exists voice_call_transfers_para_pessoa_aberta
  on public.voice_call_transfers (organization_id, to_user_id) where status = 'open';

-- 3. RLS, GRANT e policy ------------------------------------------------------------
alter table public.voice_call_transfers enable row level security;

revoke all on public.voice_call_transfers from public, anon, authenticated, service_role;
grant select on public.voice_call_transfers to authenticated, service_role;

drop policy if exists tenant_isolation_voice_call_transfers_all on public.voice_call_transfers;
drop policy if exists tenant_isolation_voice_call_transfers_select on public.voice_call_transfers;
create policy tenant_isolation_voice_call_transfers_select on public.voice_call_transfers for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- 4. Comentários -------------------------------------------------------------------
comment on table public.voice_call_transfers is
  'Transferências de ligação do telefone (fase 2, versão 2). Aberta (status open) enquanto acontece — no máximo uma por ligação (índice voice_call_transfers_uma_aberta) —, encerrada com outcome. Escrita só pela API (pedido) e pelo worker (desfecho); pela REST é só leitura. A corrente vai para o cartão da ligação em messages.metadata.voice_call.transferencias.';
comment on column public.voice_call_transfers.outcome is
  'answered (a pessoa atendeu), returned (voltou a quem transferiu), queue_answered (alguém do time pegou), missed (ninguém pegou: "Ligar de volta"), refused (o worker recusou; o porquê em reason), cancelled (o cliente desligou, quem transferiu voltou ao cliente, ou o worker reiniciou). NULL enquanto aberta.';
comment on column public.voice_call_transfers.reason is
  'Vocabulário aberto, sem CHECK: o motivo de refused/cancelled (destino_offline, destino_em_ligacao, ligacao_nao_atendida, voltou_ao_cliente, cliente_desligou, worker_reiniciou…). Lido pelo painel e pelo log.';

notify pgrst, 'reload schema';
