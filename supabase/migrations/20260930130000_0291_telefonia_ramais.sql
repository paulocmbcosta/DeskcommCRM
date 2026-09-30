-- 0291 — telefonia, fase 2, versão 3: ramais.
--
-- Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md,
-- §12 (emenda de 2026-09-30: D11, D18, D22, D23), que prevalece sobre §3.3.
-- Plano: docs/superpowers/plans/2026-09-30-telefonia-v2-v3-transferencia-e-ramais.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `phone_extensions`: o NÚMERO do ramal de cada pessoa na organização
--    (201, 202…). É endereço para humanos: a identidade SIP do navegador segue
--    `ramal-<user_id>` (plano, I10), e o worker traduz número → pessoa aqui.
--    - `number`: 2 a 4 dígitos, sem começar por 0 (D22 — o 0 é o prefixo de
--      saída da operadora); único na organização;
--    - uma linha por pessoa na organização (a chave primária).
-- 2. `fn_proximo_ramal(org)`: o menor número livre a partir de 201 (D11).
-- 3. Gatilho em `user_organizations` (`security definer`, trava por
--    organização com `pg_advisory_xact_lock`, para duas admissões simultâneas
--    não disputarem o mesmo número): quem GANHA papel de atendimento (agent,
--    manager, admin, sem `revoked_at`) recebe ramal; quem PERDE (viewer,
--    revogado, removido) o LIBERA (D22).
-- 4. Backfill de quem já existe, na ordem de entrada na organização.
-- 5. `voice_calls` aceita a ligação INTERNA (D23): `direction = 'internal'`,
--    sem número da empresa (`channel_session_id` nulo — só ela), com
--    `peer_user_id` = quem recebe. Só na linha do telefone (`sip_trunk`): a do
--    WaCalls a REST escreve com o JWT do agent, e ninguém pode forjar por ela
--    uma ligação interna.
--
-- RLS só de leitura (`tenant_isolation_phone_extensions_select`), GRANT só de
-- SELECT: a escrita é da API (organização da SESSÃO), do gatilho e da migration.
--
-- Idempotente: `if not exists`, CHECKs e constraints só quando faltam (a do
-- `direction` só é refeita enquanto não conhece `internal`), backfill com
-- `on conflict do nothing`. Sem BEGIN/COMMIT (o runner envolve em transação).

-- 1. phone_extensions --------------------------------------------------------------
create table if not exists public.phone_extensions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  "number"        text not null,
  updated_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id),
  unique (organization_id, "number")
);

do $chk_ramais$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.phone_extensions'::regclass
                    and conname = 'phone_extensions_number_check') then
    -- Número fora da régua (só com o CHECK derrubado à mão) sai: o gatilho e o
    -- backfill abaixo devolvem um válido a quem ainda tem papel de atendimento.
    delete from public.phone_extensions where "number" !~ '^[1-9][0-9]{1,3}$';
    alter table public.phone_extensions add constraint phone_extensions_number_check
      check ("number" ~ '^[1-9][0-9]{1,3}$');
  end if;
end $chk_ramais$;

-- 2. o próximo número livre ---------------------------------------------------------
create or replace function public.fn_proximo_ramal(p_org uuid)
returns text language sql stable set search_path = public as $$
  select g.n::text
    from generate_series(201, 9999) as g(n)
   where not exists (select 1 from public.phone_extensions e
                      where e.organization_id = p_org and e."number" = g.n::text)
   order by g.n
   limit 1
$$;
revoke execute on function public.fn_proximo_ramal(uuid) from public, anon, authenticated;
grant execute on function public.fn_proximo_ramal(uuid) to service_role;

-- 3. o gatilho: ganhou papel de atendimento → ramal; perdeu → libera ----------------
create or replace function public.fn_ramal_por_papel()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org     uuid := coalesce(new.organization_id, old.organization_id);
  v_user    uuid := coalesce(new.user_id, old.user_id);
  v_atende  boolean := tg_op <> 'DELETE' and new.revoked_at is null and new.role in ('agent', 'manager', 'admin');
  v_numero  text;
begin
  -- Uma organização por vez: duas admissões simultâneas não pegam o mesmo número.
  perform pg_advisory_xact_lock(hashtext('phone_extensions'), hashtext(v_org::text));
  if v_atende then
    if not exists (select 1 from public.phone_extensions where organization_id = v_org and user_id = v_user) then
      v_numero := public.fn_proximo_ramal(v_org);
      -- Sem número livre (9.799 ramais) a pessoa fica sem ramal — nunca sem a admissão.
      if v_numero is not null then
        insert into public.phone_extensions (organization_id, user_id, "number")
        values (v_org, v_user, v_numero)
        on conflict do nothing;
      end if;
    end if;
  else
    delete from public.phone_extensions where organization_id = v_org and user_id = v_user;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
-- Função de gatilho: ninguém a chama (o gatilho dispara com o dono). Fora de
-- `authenticated` também: é `security definer` que escreve.
revoke execute on function public.fn_ramal_por_papel() from public, anon, authenticated;
grant execute on function public.fn_ramal_por_papel() to service_role;

drop trigger if exists trg_ramal_por_papel on public.user_organizations;
create trigger trg_ramal_por_papel
  after insert or update of role, revoked_at or delete on public.user_organizations
  for each row execute function public.fn_ramal_por_papel();

-- 4. backfill -------------------------------------------------------------------------
do $backfill_ramais$
declare
  r record;
  v_numero text;
begin
  for r in
    select uo.organization_id, uo.user_id
      from public.user_organizations uo
     where uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin')
       and not exists (select 1 from public.phone_extensions e
                        where e.organization_id = uo.organization_id and e.user_id = uo.user_id)
     order by uo.organization_id, uo.created_at, uo.user_id
  loop
    v_numero := public.fn_proximo_ramal(r.organization_id);
    if v_numero is not null then
      insert into public.phone_extensions (organization_id, user_id, "number")
      values (r.organization_id, r.user_id, v_numero)
      on conflict do nothing;
    end if;
  end loop;
  -- E libera o de quem já não atende (o gatilho não existia quando o papel mudou).
  delete from public.phone_extensions e
   where not exists (select 1 from public.user_organizations uo
                      where uo.organization_id = e.organization_id and uo.user_id = e.user_id
                        and uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin'));
end $backfill_ramais$;

-- 5. voice_calls: a ligação interna ---------------------------------------------------
alter table public.voice_calls
  add column if not exists peer_user_id uuid references auth.users(id) on delete set null;

alter table public.voice_calls alter column channel_session_id drop not null;

do $chk_interna$
begin
  -- A lista só cresce (`internal`): nenhuma linha existente a viola.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_direction_check'
                    and pg_get_constraintdef(oid) like '%internal%') then
    alter table public.voice_calls drop constraint if exists voice_calls_direction_check;
    alter table public.voice_calls add constraint voice_calls_direction_check
      check (direction in ('inbound', 'outbound', 'internal'));
  end if;

  -- Sem número da empresa, só a interna. Toda linha existente tem número (a coluna era NOT NULL).
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_canal_ou_interna_check') then
    alter table public.voice_calls add constraint voice_calls_canal_ou_interna_check
      check (direction = 'internal' or channel_session_id is not null);
  end if;

  -- A interna e quem está do outro lado dela são do TELEFONE (a REST escreve a linha do WaCalls).
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_calls'::regclass and conname = 'voice_calls_interna_so_no_telefone_check') then
    update public.voice_calls set peer_user_id = null where provider <> 'sip_trunk' and peer_user_id is not null;
    alter table public.voice_calls add constraint voice_calls_interna_so_no_telefone_check
      check (provider = 'sip_trunk' or (direction <> 'internal' and peer_user_id is null));
  end if;
end $chk_interna$;

-- "Em outra ligação" também para quem está do OUTRO lado de uma interna.
create index if not exists idx_voice_calls_vivas_por_colega
  on public.voice_calls (organization_id, peer_user_id)
  where status <> 'ended' and peer_user_id is not null;

-- 6. RLS, GRANT e policy -----------------------------------------------------------
alter table public.phone_extensions enable row level security;

revoke all on public.phone_extensions from public, anon, authenticated, service_role;
grant select on public.phone_extensions to authenticated, service_role;

drop policy if exists tenant_isolation_phone_extensions_all on public.phone_extensions;
drop policy if exists tenant_isolation_phone_extensions_select on public.phone_extensions;
create policy tenant_isolation_phone_extensions_select on public.phone_extensions for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

create or replace trigger trg_phone_extensions_updated_at
  before update on public.phone_extensions for each row execute function public.fn_set_updated_at();

-- 7. Comentários -------------------------------------------------------------------
comment on table public.phone_extensions is
  'O número do ramal de cada pessoa na organização (fase 2, versão 3). Dado pelo gatilho trg_ramal_por_papel a quem ganha papel de atendimento (a partir de 201, fn_proximo_ramal) e liberado de quem perde. O admin troca pela API (Conexões › Telefone › Ramais). É endereço para humanos: a identidade SIP do navegador segue ramal-<user_id>.';
comment on column public.phone_extensions."number" is
  '2 a 4 dígitos, sem começar por 0 (o 0 é o prefixo de saída da operadora). Único na organização.';
comment on column public.voice_calls.peer_user_id is
  'Na ligação interna (direction = internal): quem recebe. É o "ocupado" do outro lado — o distribuidor e o diretório não tocam para quem está numa interna.';

notify pgrst, 'reload schema';
