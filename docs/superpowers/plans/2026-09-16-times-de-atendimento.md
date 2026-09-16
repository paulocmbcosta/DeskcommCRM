# Times de atendimento — plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA — use `superpowers:subagent-driven-development`
> (recomendada) ou `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam
> caixa de seleção (`- [ ]`) para acompanhamento.

**Objetivo:** dar ao CRM destinos humanos por assunto (times/setores), para que a IA e as pessoas
transfiram a conversa para o setor certo, cada um com sua fila e seu horário.

**Arquitetura:** duas tabelas (`attendance_teams`, `attendance_team_members`) e uma coluna
(`conversations.team_id`). O time entra no roteamento como **campo opcional** do `RoutingScope`, e
a filtragem acontece dentro de `loadEligibleAttendants` — que já é o carregador único do worker, do
handoff v2 e do `crm_get_queue_status`, então um lugar cobre os três. O horário do time é a
interseção com o do atendente, por composição da função pura `isWithinSchedule` que já existe.

**Stack:** Next.js 16 App Router, TypeScript estrito, Supabase/Postgres com RLS, Zod, Vitest,
Playwright.

**Desenho validado:** [`docs/superpowers/specs/2026-09-16-times-de-atendimento-design.md`](../specs/2026-09-16-times-de-atendimento-design.md)

---

## Antes de começar

```bash
nvm use && pnpm install
git fetch origin && git merge --ff-only origin/main   # branch atualizada é pré-requisito, não etapa final
docker info > /dev/null && echo "Docker de pé (pnpm test:db precisa dele)"
```

⚠️ **O banco de desenvolvimento local é o de produção.** Não aplique a migration com
`supabase db push` contra ele. Toda validação de schema deste plano roda no Postgres efêmero do
`pnpm test:db`.

⚠️ **`pnpm test:unit` não aceita caminho.** O script é `vitest run` sem argumento e alcança o repo
inteiro. Rodar `vitest run tests/unit` dá um verde menor sem avisar.

---

## Estrutura de arquivos

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260916120000_0263_times_de_atendimento.sql` | Schema, RLS e as RPCs de escrita |
| `lib/times/slug.ts` + `.test.ts` | Derivação pura de slug a partir do nome |
| `lib/times/catalogo.ts` + `.test.ts` | Carregador único: times + membros + aberto agora + nº de elegíveis |
| `lib/mcp/tools/times.ts` | A tool `crm_list_teams` |
| `app/api/v1/settings/teams/route.ts` | GET lista, POST salva (RPC) |
| `app/api/v1/settings/teams/[id]/archive/route.ts` | Arquivar/desarquivar |
| `app/api/v1/conversations/[id]/team/route.ts` | Transferir conversa para time |
| `app/app/settings/teams/page.tsx` | A tela |
| `components/times/EditorDeTime.tsx` | Formulário (nome, slug, quando usar, horário, membros) |
| `tests/invariants/times-nao-vazam-entre-organizacoes.test.ts` | Isolamento RLS — **arquivo novo, nunca modificação** |
| `tests/e2e/times-de-atendimento.spec.ts` | Prova pela tela |
| `.changes/times-de-atendimento.md` | Fragmento de release |

**Modificar:**

| Arquivo | Mudança |
|---|---|
| `supabase/baseline.sql` | Apêndice idempotente **antes** do bloco de varredura anon |
| `supabase/migrations/MANIFEST.md` | Uma linha na tabela "Applied" |
| `lib/routing/eligibles.ts` + `.test.ts` | `teamId` no scope; filtro de membros + horário do time |
| `lib/routing/queue.ts` + teste novo | `getQueuePosition` conta a fila do time |
| `lib/schemas/routing.ts` | `timeDeAtendimentoSchema` |
| `lib/mcp/tools/handoff.ts` | Parâmetro `team` |
| `lib/mcp/tools/index.ts` | Registro da tool nova |
| `lib/navigation/catalogo.ts` | A porta da tela |
| `app/api/v1/conversations/route.ts` + `_handler.ts` | Filtro `team_id` |
| `lib/database.types.ts` | Regenerar |
| `.github/workflows/e2e.yml` | A spec nova em `SPECS_PARTE_*` |

⚠️ **`tests/invariants/**` é congelado** por `loop/hooks/freeze-invariants.sh`: arquivo **novo**
(`A`) passa, arquivo **modificado** (`M`) é bloqueado. Por isso o invariante de isolamento é um
arquivo próprio, e não uma linha em `rls-isolation.test.ts`.

---

## Task 1: Schema, RLS e RPCs de escrita

**Arquivos:**
- Criar: `supabase/migrations/20260916120000_0263_times_de_atendimento.sql`
- Modificar: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
- Criar: `tests/invariants/times-nao-vazam-entre-organizacoes.test.ts`

- [ ] **Passo 1: confirmar o próximo número de migration**

```bash
ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
```

Esperado: `0262` (medido em 2026-09-16). Se vier outro, use o sucessor dele — **nunca** o número
do último arquivo da listagem, que pode discordar do maior `NNNN`.

- [ ] **Passo 2: escrever a migration**

Crie `supabase/migrations/20260916120000_0263_times_de_atendimento.sql` com o bloco abaixo. Esse
**mesmo texto** vai para o baseline no passo 4 — é o que garante que os dois artefatos não divirjam.

```sql
-- ---- times de atendimento (migration 0263) ----
--
-- Setores como destino humano. Desenho em
-- docs/superpowers/specs/2026-09-16-times-de-atendimento-design.md
--
-- A FK COMPOSTA (organization_id, user_id) → user_organizations é o que torna
-- IMPOSSÍVEL, e não só improvável, alocar num time alguém de outra organização.

create table if not exists public.attendance_teams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  slug            text not null,
  description     text not null default '',
  schedule        jsonb not null default '{}'::jsonb,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table if not exists public.attendance_team_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  team_id         uuid not null,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (organization_id, team_id)
    references public.attendance_teams(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.user_organizations(organization_id, user_id) on delete cascade
);

create index if not exists attendance_team_members_org_user
  on public.attendance_team_members(organization_id, user_id);

alter table public.conversations add column if not exists team_id uuid;

do $do$ begin
  alter table public.conversations add constraint conversations_team_id_fkey
    foreign key (team_id) references public.attendance_teams(id) on delete set null;
exception when duplicate_object then null; end $do$;

create index if not exists conversations_org_team
  on public.conversations(organization_id, team_id) where team_id is not null;

alter table public.attendance_teams        enable row level security;
alter table public.attendance_team_members enable row level security;
revoke all on public.attendance_teams, public.attendance_team_members
  from public, anon, authenticated, service_role;
grant select on public.attendance_teams, public.attendance_team_members
  to authenticated, service_role;

-- Policy `for all` (doutrina do CLAUDE.md), GRANT só de SELECT: o grant é o
-- portão mais estreito, e é ele que impede escrita pela REST.
drop policy if exists tenant_isolation_attendance_teams_all on public.attendance_teams;
create policy tenant_isolation_attendance_teams_all on public.attendance_teams for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

drop policy if exists tenant_isolation_attendance_team_members_all on public.attendance_team_members;
create policy tenant_isolation_attendance_team_members_all on public.attendance_team_members for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- A transferência para time é um motivo NOVO no vocabulário do evento de
-- atribuição. Acrescentar valor a um IN nunca viola dado existente.
do $do$ begin
  alter table public.conversation_assignment_events drop constraint if exists conversation_assignment_events_reason_check;
  alter table public.conversation_assignment_events add constraint conversation_assignment_events_reason_check
    check (reason in ('claim','transfer','release','routing','handoff','team_transfer'));
end $do$;

-- ---------------------------------------------------------------------------
-- Escrita: só por RPC security definer, no molde de fn_set_channel_routing.
-- ---------------------------------------------------------------------------

create or replace function public.fn_save_attendance_team(
  p_org uuid, p_team uuid, p_name text, p_slug text,
  p_description text, p_schedule jsonb, p_users uuid[]
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid; requested_count integer; found_count integer;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'team_mfa_required' using errcode='42501'; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'team_invalid_name' using errcode='22023'; end if;
  if p_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then
    raise exception 'team_invalid_slug' using errcode='22023'; end if;
  if p_users is null or cardinality(p_users) > 1000 or array_position(p_users, null) is not null then
    raise exception 'team_invalid_members' using errcode='22023'; end if;

  if p_team is null then
    insert into public.attendance_teams(organization_id,name,slug,description,schedule)
    values (p_org, btrim(p_name), p_slug, coalesce(p_description,''), coalesce(p_schedule,'{}'::jsonb))
    returning id into v_id;
  else
    update public.attendance_teams
       set name=btrim(p_name), slug=p_slug, description=coalesce(p_description,''),
           schedule=coalesce(p_schedule,'{}'::jsonb), updated_at=now()
     where organization_id=p_org and id=p_team
    returning id into v_id;
    if v_id is null then raise exception 'team_not_found' using errcode='P0002'; end if;
  end if;

  select count(distinct x) into requested_count from unnest(p_users) x;
  perform 1 from public.user_organizations
   where organization_id=p_org and user_id=any(p_users) and revoked_at is null
     and role in ('agent','manager','admin') order by user_id for share;
  get diagnostics found_count = row_count;
  if found_count <> requested_count then raise exception 'team_invalid_members' using errcode='22023'; end if;

  delete from public.attendance_team_members where organization_id=p_org and team_id=v_id;
  insert into public.attendance_team_members(organization_id,team_id,user_id)
   select p_org, v_id, x from (select distinct unnest(p_users) x) u;

  return jsonb_build_object('id', v_id, 'slug', p_slug, 'user_ids', to_jsonb(p_users));
end;
$$;
revoke execute on function public.fn_save_attendance_team(uuid,uuid,text,text,text,jsonb,uuid[]) from public, anon;
grant  execute on function public.fn_save_attendance_team(uuid,uuid,text,text,text,jsonb,uuid[]) to authenticated;

create or replace function public.fn_archive_attendance_team(p_org uuid, p_team uuid, p_arquivar boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'manager')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if not public.fn_session_mfa_proven() then raise exception 'team_mfa_required' using errcode='42501'; end if;
  update public.attendance_teams
     set archived_at = case when p_arquivar then now() else null end, updated_at = now()
   where organization_id=p_org and id=p_team returning id into v_id;
  if v_id is null then raise exception 'team_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('id', v_id, 'archived', p_arquivar);
end;
$$;
revoke execute on function public.fn_archive_attendance_team(uuid,uuid,boolean) from public, anon;
grant  execute on function public.fn_archive_attendance_team(uuid,uuid,boolean) to authenticated;

-- Transferir para time: grava o time, SOLTA o dono e pede o roteamento.
-- `fn_request_channel_routing` é idempotente (on conflict do update), então
-- chamá-la aqui e a trigger de atribuição chamá-la de novo não duplica evento.
create or replace function public.fn_conversation_set_team(p_org uuid, p_conversation uuid, p_team uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'agent')
     or not public.fn_support_write_allowed(p_org)
   then raise exception 'team_forbidden' using errcode='42501'; end if;
  if p_team is not null and not exists (
      select 1 from public.attendance_teams
       where organization_id=p_org and id=p_team and archived_at is null)
   then raise exception 'team_not_found' using errcode='P0002'; end if;

  select assigned_to_user_id into v_owner from public.conversations
   where organization_id=p_org and id=p_conversation for update;
  if not found then raise exception 'conversation_not_found' using errcode='P0002'; end if;

  update public.conversations
     set team_id = p_team, assigned_to_user_id = null, assignee_kind = null, updated_at = now()
   where organization_id=p_org and id=p_conversation;

  if v_owner is not null then
    insert into public.conversation_assignment_events(
      organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
    values (p_org, p_conversation, v_owner, null, auth.uid(), 'team_transfer');
  end if;

  perform public.fn_request_channel_routing(p_org, p_conversation);
  return jsonb_build_object('conversation_id', p_conversation, 'team_id', p_team, 'released_from', v_owner);
end;
$$;
revoke execute on function public.fn_conversation_set_team(uuid,uuid,uuid) from public, anon;
grant  execute on function public.fn_conversation_set_team(uuid,uuid,uuid) to authenticated;
```

- [ ] **Passo 3: escrever o invariante de isolamento (vermelho primeiro)**

Crie `tests/invariants/times-nao-vazam-entre-organizacoes.test.ts`. Copie o preâmbulo de conexão de
`tests/invariants/agenda-rls.test.ts` (o helper `sql()` com `execFileSync` e `TEST_DB_CONTAINER`) e
prove **comportamento**, não só existência de policy:

1. Semeia duas organizações (A e B), um `agent` em cada, um time em cada.
2. Com o JWT do agent de A: `select count(*) from attendance_teams` devolve **1** (o dele) — e a
   asserção do vizinho é `0`. As duas importam: só a negativa passaria num banco vazio.
3. Mesma dupla de asserções para `attendance_team_members`.
4. `set local role authenticated` + `insert into attendance_teams …` falha com `permission denied`
   (o GRANT não tem INSERT — é o portão estreito da policy `for all`).
5. `fn_save_attendance_team` chamada para a organização **B** com o JWT de A levanta
   `team_forbidden` (42501).

- [ ] **Passo 4: acrescentar o apêndice ao baseline**

Insira **o mesmo SQL do passo 2** em `supabase/baseline.sql`, **imediatamente antes** da linha:

```
-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----
```

⚠️ Esse bloco de varredura é, de propósito, **o último do arquivo** — é ele que revoga `anon` das
funções novas do apêndice. Empurrá-lo para o meio desarma a cura de tudo que vier depois, e
`tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` reprova.

- [ ] **Passo 5: linha no MANIFEST**

Acrescente ao fim da tabela "Applied" de `supabase/migrations/MANIFEST.md`:

```
| `20260916120000` | `0263_times_de_atendimento` | **Times (setores) como destino humano.** `attendance_teams` (nome, slug estável, "quando usar", `schedule` no MESMO shape de `attendant_availability`, `archived_at`) e `attendance_team_members` (N:N, com FK COMPOSTA `(organization_id,user_id)` → `user_organizations`, que torna impossível alocar alguém de outra organização), mais `conversations.team_id` (`on delete set null` — a tela só arquiva, nunca apaga, porque conversa encerrada aponta para o time). Escrita só por RPC `security definer` no molde de `fn_set_channel_routing`: `fn_save_attendance_team` (upsert + troca de membros atômica), `fn_archive_attendance_team` e `fn_conversation_set_team` (grava o time, solta o dono, pede o roteamento — idempotente, então não duplica evento com a trigger). `conversation_assignment_events.reason` ganha `team_transfer` no CHECK. Policy `for all` com GRANT só de SELECT. Gate: `tests/invariants/times-nao-vazam-entre-organizacoes.test.ts`. |
```

- [ ] **Passo 6: rodar o invariante**

```bash
pnpm test:db 2>&1 | tail -30
```

Esperado: verde, incluindo `times-nao-vazam-entre-organizacoes` e a varredura
`agenda-nenhuma-tabela-sem-rls` (que deriva a lista do catálogo e **reprovaria** se as tabelas
novas ficassem sem RLS — não é preciso inscrevê-las em lugar nenhum).

- [ ] **Passo 7: regenerar os tipos**

```bash
pnpm supabase gen types typescript --local > lib/database.types.ts && pnpm typecheck
```

Se o Supabase local não estiver de pé, edite `lib/database.types.ts` à mão acrescentando as duas
tabelas e `team_id: string | null` em `conversations` (Row, Insert e Update).

- [ ] **Passo 8: commit**

```bash
git add supabase/ tests/invariants/times-nao-vazam-entre-organizacoes.test.ts lib/database.types.ts
git commit -m "feat(times): as tabelas de time, a coluna na conversa e as RPCs de escrita"
```

---

## Task 2: elegíveis por time (o coração)

**Arquivos:**
- Modificar: `lib/routing/eligibles.ts`, `lib/routing/eligibles.test.ts`

- [ ] **Passo 1: escrever os testes que ficam vermelhos**

Em `lib/routing/eligibles.test.ts`, acrescente ao `fixture` as duas tabelas novas e um novo `describe`.
No `fixture`, dentro de `rows`, acrescente:

```ts
    attendance_teams: { id: "time", schedule: {}, archived_at: null },
    attendance_team_members: [{ user_id: "ana" }],
```

E o bloco de testes (`now` é **domingo 12:00** em São Paulo — conferido):

```ts
const scopeComTime = { kind: "conversation_channel", channelSessionId: "channel", teamId: "time" } as const;

describe("elegibilidade restrita por time", () => {
  it("atendente fora do time não entra", async () => {
    const { db } = fixture({ attendance_team_members: [{ user_id: "bia" }] });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time sem membro é restrição explícita, não ausência de configuração", async () => {
    const { db } = fixture({ attendance_team_members: [] });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time fechado agora não tem elegível, mesmo com atendente disponível e no horário dele", async () => {
    // Janela só de segunda a sexta; `now` é domingo. É o caso Cancelamentos.
    const { db } = fixture({
      attendance_teams: {
        id: "time", archived_at: null,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] },
      },
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time aberto agora devolve quem está nele", async () => {
    const { db } = fixture({
      attendance_teams: {
        id: "time", archived_at: null,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 0, start: "08:00", end: "18:00" }] },
      },
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([{ userId: "ana" }]);
  });

  it("time arquivado não devolve ninguém", async () => {
    const { db } = fixture({ attendance_teams: { id: "time", schedule: {}, archived_at: "2026-01-01T00:00:00Z" } });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("sem time no escopo, nada muda — nenhuma consulta às tabelas de time", async () => {
    const { db, filters } = fixture();
    expect(await loadEligibleAttendants(db, "org", now, scope)).toMatchObject([{ userId: "ana" }]);
    expect(filters.some(([t]) => t === "attendance_teams" || t === "attendance_team_members")).toBe(false);
  });

  it("canal e time SOMAM: só quem está nos dois sobra", async () => {
    // Sem esta prova, a interseção pode ser trocada pela política do canal
    // sozinha e a suíte inteira segue verde — medido por sabotagem.
    const { db } = fixture({
      channel_routing_policies: { id: "policy" },
      channel_routing_responsibles: [{ user_id: "ana" }, { user_id: "bia" }],
      attendance_team_members: [{ user_id: "bia" }, { user_id: "carla" }],
      user_organizations: [{ user_id: "ana" }, { user_id: "bia" }, { user_id: "carla" }],
      attendant_availability: [
        { user_id: "ana", capacity: 2, schedule: {} },
        { user_id: "bia", capacity: 2, schedule: {} },
        { user_id: "carla", capacity: 2, schedule: {} },
      ],
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([{ userId: "bia" }]);
  });
});
```

⚠️ **Este sétimo caso faltava na primeira versão do plano.** Os seis anteriores usam o fixture com
`channel_routing_policies: null`, então só o ramo `allowed === null` era exercido — trocar a
interseção por `allowed` (isto é, desligar a restrição de time sempre que o canal tem política)
deixava a suíte inteira verde.

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm vitest run lib/routing/eligibles.test.ts
```

Esperado: FAIL em 4 casos — eles devolvem `ana` onde deveriam devolver `[]`.

⚠️ **Uma versão anterior desta linha dizia que o `as const` do escopo "já reprova no typecheck".
É falso, e foi medido:** `pnpm typecheck` sai `exit=0` mesmo antes da mudança. O excess property
check do TypeScript só dispara em objeto literal **fresco** passado inline; `scopeComTime` é uma
const nomeada, então a propriedade extra é ignorada estruturalmente. O vermelho do TDD aqui é de
runtime, que é o que importa — mas quem esperasse o typecheck reprovar concluiria que o passo 1
não foi aplicado.

- [ ] **Passo 3: implementar**

Em `lib/routing/eligibles.ts`, acrescente `isWithinSchedule` ao import de `./eligibility`, mude o
tipo do escopo e insira o bloco **depois** da política de canal e **antes** da consulta a
`user_organizations`:

```ts
export type RoutingScope =
  | { kind: "conversation_channel"; channelSessionId: string; teamId?: string | null }
  | { kind: "organization_summary"; teamId?: string | null };
```

```ts
  // Time é restrição ORTOGONAL ao canal (canal = por onde se fala; time = sobre
  // o quê), por isso é campo do escopo e não variante: handoff para time NUM
  // canal precisa das duas ao mesmo tempo, e a variante perderia o canal.
  if (scope.teamId) {
    const { data: team, error: teamError } = await supabase.from("attendance_teams")
      .select("id, schedule, archived_at")
      .eq("organization_id", organizationId).eq("id", scope.teamId).maybeSingle();
    if (teamError) throw new Error(teamError.message);
    if (!team || team.archived_at) return [];
    // O horário do time vale para TODOS os candidatos: uma checagem, não uma por
    // pessoa. Interseção com a janela do atendente, que o isAttendantEligible faz.
    if (!isWithinSchedule(availabilityScheduleSchema.parse(team.schedule ?? {}), now)) return [];
    const { data: membros, error: membrosError } = await supabase.from("attendance_team_members")
      .select("user_id").eq("organization_id", organizationId).eq("team_id", scope.teamId);
    if (membrosError) throw new Error(membrosError.message);
    const doTime = new Set((membros ?? []).map((m: { user_id: string }) => m.user_id));
    // Time sem membro é restrição explícita — mesma leitura da política de canal vazia.
    if (doTime.size === 0) return [];
    allowed = allowed === null ? doTime : new Set([...allowed].filter((u) => doTime.has(u)));
  }
```

- [ ] **Passo 4: rodar e ver passar**

```bash
pnpm vitest run lib/routing/eligibles.test.ts
```

Esperado: PASS em todos, inclusive os seis casos que já existiam.

- [ ] **Passo 5: sabotar para provar que o teste vigia**

Comente a linha `if (!isWithinSchedule(...)) return [];` e rode de novo. Esperado: **FAIL** em
"time fechado agora não tem elegível". Descomente. Repita com a linha do `doTime`: esperado FAIL em
"atendente fora do time não entra". Teste que passa com a correção desfeita não vigia nada.

- [ ] **Passo 6: commit**

```bash
git add lib/routing/eligibles.ts lib/routing/eligibles.test.ts
git commit -m "feat(times): elegíveis restritos ao time, com o horário do time em interseção"
```

---

## Task 3: a posição na fila é a do time

**Arquivos:**
- Modificar: `lib/routing/queue.ts`
- Criar: `lib/routing/queue.test.ts`

- [ ] **Passo 1: escrever o teste vermelho**

Crie `lib/routing/queue.test.ts`. Ele precisa de um fake que registre os filtros aplicados:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => false }));
vi.mock("@/lib/inbox/comando-da-conversa", () => ({ comandosDaFila: () => ["na_fila"] }));

import { getQueuePosition } from "./queue";

function fake() {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select() { return q; },
    eq(k: string, v: unknown) { filtros.push([k, v]); return q; },
    is(k: string, v: unknown) { filtros.push([k, v]); return q; },
    in(k: string, v: unknown) { filtros.push([k, v]); return q; },
    lte(k: string, v: unknown) { filtros.push([k, v]); return q; },
    then(r: (x: unknown) => unknown) { return Promise.resolve({ count: 2, error: null }).then(r); },
  };
  const db = { from() { return q; } } as unknown as SupabaseClient;
  return { db, filtros };
}

const agora = new Date("2026-09-06T15:00:00Z");

describe("posição na fila", () => {
  it("com time, conta só a fila daquele time", async () => {
    const { db, filtros } = fake();
    await getQueuePosition(db, "org", null, agora, "time");
    expect(filtros).toContainEqual(["team_id", "time"]);
  });

  it("sem time, conta só a fila geral — as conversas sem time", async () => {
    const { db, filtros } = fake();
    await getQueuePosition(db, "org", null, agora, null);
    expect(filtros).toContainEqual(["team_id", null]);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm vitest run lib/routing/queue.test.ts
```

Esperado: FAIL — `getQueuePosition` ainda não aceita o 5º argumento e nunca filtra `team_id`.

- [ ] **Passo 3: implementar**

Em `lib/routing/queue.ts`, substitua o corpo de `getQueuePosition`:

```ts
export async function getQueuePosition(
  supabase: SupabaseClient,
  organizationId: string,
  lastInboundAt: string | null,
  now: Date,
  teamId?: string | null,
): Promise<number> {
  const naFila = comandosDaFila(await orgTemAutomatico(supabase, organizationId));
  const ref = lastInboundAt ?? now.toISOString();
  let q = supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("comando_da_conversa", naFila)
    .lte("last_inbound_at", ref);
  // A fila do time é OUTRA fila. Contar a geral daria ao cliente uma posição que
  // não existe na tela de quem vai atendê-lo — número errado dito com confiança.
  // Numa instalação sem time nenhum, toda conversa tem team_id null e a conta é
  // idêntica à de antes: não há regressão a pagar por esta precisão.
  q = teamId ? q.eq("team_id", teamId) : q.is("team_id", null);
  const { count } = await q;
  return count ?? 1;
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
pnpm vitest run lib/routing/queue.test.ts && pnpm typecheck
```

- [ ] **Passo 5: commit**

```bash
git add lib/routing/queue.ts lib/routing/queue.test.ts
git commit -m "fix(times): a posição na fila conta o time, não a organização inteira"
```

---

## Task 3.5: o cron respeita o time — LACUNA descoberta durante a execução

> **Por que esta tarefa tem número quebrado.** Ela não estava no plano original, e a numeração das
> demais não foi mexida de propósito: as Tasks 4–11 já foram citadas em commits e em briefings de
> agentes, e renumerar faria toda referência anterior apontar para outra coisa.

**A lacuna, e o tamanho dela.** Nenhuma tarefa do plano tocava `lib/routing/worker.ts` — medido:
`grep -c "worker.ts"` no plano devolvia `0`. E o worker monta o escopo assim (`worker.ts:172`):

```ts
      eligibles = await loadEligibleAttendants(admin, orgId, now, {
        kind: "conversation_channel", channelSessionId: conv.channel_session_id,
      });
```

Sem `teamId`. E a conversa é lida sem a coluna (`worker.ts:146`):

```ts
    .select("id, organization_id, contact_id, channel_session_id, assigned_to_user_id, status")
```

Consequência: no instante em que a Task 6 gravar `conversations.team_id` e a conversa cair na fila,
o cron a pega em até 60 segundos e a atribui a **qualquer** elegível da organização — o comercial
recebendo um pedido de cancelamento. É a decisão 2 desfeita por dentro, em silêncio, com a suíte
inteira verde, porque nenhum teste cobre a montagem do escopo no worker.

**Esta tarefa é PRÉ-CONDIÇÃO da Task 6.** Ligar a escrita de `team_id` antes dela entrega a feature
com o defeito que ela existe para evitar.

**Arquivos:**
- Modificar: `lib/routing/worker.ts`
- Criar: `lib/routing/worker-respeita-o-time.test.ts`

- [ ] **Passo 1: escrever o teste que fica vermelho**

O worker não expõe `processEvent` (é interna) e `runRoutingWorker` cria o próprio client por
`createAdminClient()`. Dois caminhos, e o implementador escolhe — mas o teste **tem de ficar
vermelho sem a mudança**, e isso é medido, não afirmado:

- **Comportamental (preferido):** `vi.mock("@/lib/supabase/admin")` devolvendo um fake que registra
  as chamadas, e `vi.mock("@/lib/routing/eligibles")` capturando o `scope` recebido. Chame
  `runRoutingWorker` com um evento semeado e afirme que o escopo passado contém
  `teamId: "<o time da conversa>"`. É o único caminho que prova COMPORTAMENTO.
- **Estrutural (aceitável se o comportamental se mostrar caro demais):** ler `lib/routing/worker.ts`
  e afirmar que o `select` da conversa inclui `team_id` e que o objeto de escopo inclui `teamId`.
  O repo tem precedente para gate estrutural de invariante transversal
  (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts` varre o AST de toda rota de cron). É mais
  fraco: pega remoção, não pega o valor errado. Se escolher este, **diga no relatório que escolheu
  a catraca mais fraca e por quê**.

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm vitest run lib/routing/worker-respeita-o-time.test.ts
```

- [ ] **Passo 3: implementar — duas linhas**

Em `lib/routing/worker.ts:146`, acrescente a coluna:

```ts
    .select("id, organization_id, contact_id, channel_session_id, assigned_to_user_id, status, team_id")
```

Em `lib/routing/worker.ts:172`, passe o time:

```ts
      eligibles = await loadEligibleAttendants(admin, orgId, now, {
        kind: "conversation_channel",
        channelSessionId: conv.channel_session_id,
        // Sem esta linha o cron desfaz a decisão 2 em até 60 segundos: a conversa
        // que o handoff pôs na fila de Cancelamentos é atribuída a qualquer
        // elegível da organização — o comercial inclusive.
        teamId: conv.team_id,
      });
```

- [ ] **Passo 4: rodar e ver passar**

```bash
pnpm vitest run lib/routing/ && pnpm typecheck && pnpm lint
```

- [ ] **Passo 5: sabotar**

Tire o `teamId:` do escopo e confirme o vermelho. Cole a saída real no relatório.

- [ ] **Passo 6: commit**

```bash
git add lib/routing/worker.ts lib/routing/worker-respeita-o-time.test.ts
git commit -m "fix(times): o cron de roteamento respeita o time da conversa"
```

---

## Task 4: o catálogo de times (carregador único)

**Arquivos:**
- Criar: `lib/times/slug.ts`, `lib/times/slug.test.ts`, `lib/times/catalogo.ts`, `lib/times/catalogo.test.ts`
- Modificar: `lib/schemas/routing.ts`

- [ ] **Passo 1: o slug, puro e testado primeiro**

`lib/times/slug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slugDoTime } from "./slug";

describe("slug do time", () => {
  it("tira acento, espaço e caixa", () => {
    expect(slugDoTime("Financeiro / Cobrança")).toBe("financeiro-cobranca");
  });
  it("não começa nem termina com hífen", () => {
    expect(slugDoTime("  -- Suporte Técnico -- ")).toBe("suporte-tecnico");
  });
  it("corta em 40 caracteres sem deixar hífen na ponta", () => {
    expect(slugDoTime("a".repeat(60)).length).toBeLessThanOrEqual(40);
  });
  it("nome sem nenhum caractere aproveitável vira vazio, e quem chama decide", () => {
    expect(slugDoTime("!!!")).toBe("");
  });
});
```

`lib/times/slug.ts`:

```ts
/**
 * Slug do time: token estável que o agente usa para escolher o destino.
 *
 * Ele é SUGERIDO a partir do nome e depois editável — não é derivação viva. Como
 * o agente lê o catálogo em runtime, trocar o slug não quebra prompt nenhum.
 */
export function slugDoTime(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
```

- [ ] **Passo 2: rodar**

```bash
pnpm vitest run lib/times/slug.test.ts
```

Esperado: PASS nos quatro.

- [ ] **Passo 3: o schema Zod**

Em `lib/schemas/routing.ts`, no fim do arquivo:

```ts
/**
 * Um time de atendimento. O `schedule` reusa `availabilityScheduleSchema` de
 * propósito: é o MESMO shape do atendente, validado pela MESMA regra, e é o que
 * permite a interseção de horários ser composição em vez de algoritmo novo.
 */
export const timeDeAtendimentoSchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "use letras minúsculas, números e hífen"),
  description: z.string().trim().max(500).default(""),
  schedule: availabilityScheduleSchema.default({ timezone: "America/Sao_Paulo", windows: [] }),
  user_ids: z.array(z.string().uuid()).max(1000).default([]),
}).strict();
export type TimeDeAtendimento = z.infer<typeof timeDeAtendimentoSchema>;
```

- [ ] **Passo 4: o carregador, com teste primeiro**

`lib/times/catalogo.test.ts` — prove as três coisas que o consumidor precisa e que não são óbvias:

```ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { carregarTimes } from "./catalogo";

const domingoMeioDia = new Date("2026-09-06T15:00:00Z");

function fake(times: unknown[], membros: unknown[]) {
  const q = (linhas: unknown) => {
    const o = {
      select() { return o; }, order() { return o; },
      eq() { return o; }, is() { return o; }, in() { return o; },
      then(r: (x: unknown) => unknown) { return Promise.resolve({ data: linhas, error: null }).then(r); },
    };
    return o;
  };
  return { from(t: string) { return q(t === "attendance_teams" ? times : membros); } } as unknown as SupabaseClient;
}

describe("catálogo de times", () => {
  it("diz se o time está aberto AGORA, pela janela dele", async () => {
    const db = fake(
      [{ id: "t1", name: "Cancelamentos", slug: "cancelamento", description: "Pedidos de cancelar",
         schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] } }],
      [{ team_id: "t1", user_id: "ana" }],
    );
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time).toMatchObject({ slug: "cancelamento", aberto_agora: false });
  });

  it("time sem janela é 24/7 — janela existe para RESTRINGIR", async () => {
    const db = fake([{ id: "t1", name: "Suporte", slug: "suporte", description: "", schedule: {} }], []);
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time?.aberto_agora).toBe(true);
  });

  it("conta os membros alocados", async () => {
    const db = fake(
      [{ id: "t1", name: "Suporte", slug: "suporte", description: "", schedule: {} }],
      [{ team_id: "t1", user_id: "ana" }, { team_id: "t1", user_id: "bia" }],
    );
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time?.user_ids).toEqual(["ana", "bia"]);
  });
});
```

`lib/times/catalogo.ts`:

```ts
/**
 * Carregador ÚNICO dos times de uma organização.
 *
 * Um só, e não um por consumidor: a tela de Times, a tool `crm_list_teams` e o
 * filtro do inbox fazem a mesma pergunta, e três leituras divergentes do mesmo
 * fato é como se produz uma tela que discorda do que o agente vê.
 *
 * `aberto_agora` sai da MESMA `isWithinSchedule` do roteamento — se a tela
 * dissesse "aberto" com o roteador achando "fechado", o usuário não teria como
 * descobrir qual das duas mente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isWithinSchedule } from "@/lib/routing/eligibility";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

export interface TimeDoCatalogo {
  id: string;
  name: string;
  slug: string;
  description: string;
  schedule: unknown;
  archived_at: string | null;
  aberto_agora: boolean;
  user_ids: string[];
}

export async function carregarTimes(
  db: SupabaseClient,
  organizationId: string,
  now: Date,
  opts: { incluirArquivados?: boolean } = {},
): Promise<TimeDoCatalogo[]> {
  let consulta = db.from("attendance_teams")
    .select("id, name, slug, description, schedule, archived_at")
    .eq("organization_id", organizationId)
    .order("name");
  if (!opts.incluirArquivados) consulta = consulta.is("archived_at", null);
  const { data: times, error } = await consulta;
  if (error) throw new Error(error.message);

  const { data: membros, error: erroMembros } = await db.from("attendance_team_members")
    .select("team_id, user_id").eq("organization_id", organizationId);
  if (erroMembros) throw new Error(erroMembros.message);

  const porTime = new Map<string, string[]>();
  for (const m of (membros ?? []) as Array<{ team_id: string; user_id: string }>) {
    porTime.set(m.team_id, [...(porTime.get(m.team_id) ?? []), m.user_id]);
  }

  return ((times ?? []) as Array<Omit<TimeDoCatalogo, "aberto_agora" | "user_ids">>).map((t) => ({
    ...t,
    aberto_agora: isWithinSchedule(availabilityScheduleSchema.parse(t.schedule ?? {}), now),
    user_ids: porTime.get(t.id) ?? [],
  }));
}
```

- [ ] **Passo 5: rodar e commitar**

```bash
pnpm vitest run lib/times/ && pnpm typecheck
git add lib/times/ lib/schemas/routing.ts
git commit -m "feat(times): o catálogo de times, com aberto_agora saindo da mesma regra do roteador"
```

---

## Task 4.5: agenda ilegível não derruba nada — decisão do dono, 2026-09-16

> Número quebrado pelo mesmo motivo da 3.5: as Tasks 5–11 já foram citadas, e renumerar faria toda
> referência anterior apontar para outra coisa.

**O defeito, medido.** `availabilityScheduleSchema.parse` lança num `schedule` que o banco aceita
(coluna `jsonb` sem CHECK; `America/Asunción` com acento passa na escrita e explode na leitura). O
mesmo `parse` está em três pontos, e um único registro ruim derruba os três de uma vez — incluindo
**o roteamento da organização inteira**, porque `loadEligibleAttendants` lança antes de decidir.

**A decisão (spec §4):** agenda ilegível = **fechado, e visível**. Nunca 24/7, nunca exceção.

**Arquivos:**
- Criar: `lib/times/agenda.ts` + `lib/times/agenda.test.ts`
- Modificar: `lib/times/catalogo.ts`, `lib/times/catalogo.test.ts`, `lib/routing/eligibles.ts`, `lib/routing/eligibles.test.ts`

- [ ] **Passo 1: o helper, com teste primeiro**

`lib/times/agenda.ts`:

```ts
/**
 * Lê uma agenda `{timezone, windows}` sem NUNCA lançar.
 *
 * A coluna é `jsonb` sem CHECK e a escrita não valida conteúdo, então o banco
 * aceita o que o parser recusa — `America/Asunción`, com o acento que um
 * hispanofalante escreve natural, é o caso real que já custou um bug a esta base.
 *
 * Três pontos liam isso com `.parse()`: o catálogo de times, a elegibilidade do
 * TIME e a elegibilidade do ATENDENTE. Um registro ruim derrubava os três — e o
 * terceiro leva junto o roteamento da organização inteira.
 *
 * `valida: false` é tratado como FECHADO por quem chama, nunca como 24/7:
 * fechado é visível (a conversa espera na fila e a Central avisa), "sem
 * restrição" é uma mentira sem sintoma. Mesmo formato do "Resolvedor NUNCA
 * lança" do branding.
 */
import { availabilityScheduleSchema, type AvailabilitySchedule } from "@/lib/schemas/routing";

export interface AgendaLida {
  agenda: AvailabilitySchedule;
  /** false = o banco tem algo que o parser não lê. Quem chama trata como FECHADO. */
  valida: boolean;
}

export function lerAgenda(bruto: unknown): AgendaLida {
  const r = availabilityScheduleSchema.safeParse(bruto ?? {});
  if (r.success) return { agenda: r.data, valida: true };
  return { agenda: { timezone: "America/Sao_Paulo", windows: [] }, valida: false };
}
```

`lib/times/agenda.test.ts` — quatro casos, e o terceiro é o que importa:

```ts
import { describe, expect, it } from "vitest";
import { lerAgenda } from "./agenda";

describe("ler agenda sem lançar", () => {
  it("agenda boa volta íntegra e válida", () => {
    const r = lerAgenda({ timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] });
    expect(r.valida).toBe(true);
    expect(r.agenda.windows).toHaveLength(1);
  });
  it("vazio é válido e sem restrição — janela existe para RESTRINGIR", () => {
    expect(lerAgenda({})).toMatchObject({ valida: true });
    expect(lerAgenda(null)).toMatchObject({ valida: true });
  });
  it("fuso que não existe NÃO lança, e vem marcado inválido", () => {
    expect(() => lerAgenda({ timezone: "America/Asunción", windows: [] })).not.toThrow();
    expect(lerAgenda({ timezone: "America/Asunción", windows: [] }).valida).toBe(false);
  });
  it("janela malformada também vem marcada, sem lançar", () => {
    expect(lerAgenda({ timezone: "America/Sao_Paulo", windows: [{ dow: 9, start: "25:00", end: "x" }] }).valida).toBe(false);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** (`pnpm vitest run lib/times/agenda.test.ts`), depois verde.

- [ ] **Passo 3: os três pontos de leitura**

Em `lib/times/catalogo.ts`, `TimeDoCatalogo` ganha `horario_invalido: boolean`, e o `map` vira:

```ts
  return ((times ?? []) as Array<Omit<TimeDoCatalogo, "aberto_agora" | "user_ids" | "horario_invalido">>).map((t) => {
    const { agenda, valida } = lerAgenda(t.schedule);
    return {
      ...t,
      // Agenda ilegível = FECHADO, nunca 24/7: a tela mostra o aviso e o gestor
      // conserta. "Aberto" sob um horário que ninguém lê é mentira sem sintoma.
      aberto_agora: valida && isWithinSchedule(agenda, now),
      horario_invalido: !valida,
      user_ids: porTime.get(t.id) ?? [],
    };
  });
```

Em `lib/routing/eligibles.ts`, a agenda do TIME:

```ts
    const { agenda: agendaDoTime, valida: agendaDoTimeValida } = lerAgenda(team.schedule);
    if (!agendaDoTimeValida || !isWithinSchedule(agendaDoTime, now)) return [];
```

E a agenda do ATENDENTE (o ponto pré-existente e mais exposto — `attendant_availability` aceita
INSERT/UPDATE dos três papéis do PostgREST, medido):

```ts
    const { agenda: schedule, valida: agendaValida } = lerAgenda(r.schedule);
    const eligible = agendaValida && isAttendantEligible(
      { isAvailable: true, capacity: r.capacity, currentLoad, schedule },
      now,
    );
```

- [ ] **Passo 4: os testes dos consumidores**

Em `lib/times/catalogo.test.ts`, um caso: time com `schedule: { timezone: "America/Asunción" }` →
`{ aberto_agora: false, horario_invalido: true }`, e a chamada **não lança**.

Em `lib/routing/eligibles.test.ts`, dois: (a) time com fuso inválido ⇒ `[]` sem lançar;
(b) **atendente** com fuso inválido ⇒ ele não entra, e os demais continuam entrando — este é o que
prova que um atendente ruim não derruba a organização.

- [ ] **Passo 5: sabotar**

Troque `lerAgenda` de volta por `.parse()` em cada ponto e confirme que o caso correspondente vira
**erro lançado**, não asserção falsa. Cole a saída real.

- [ ] **Passo 6: commit**

```bash
git add lib/times/ lib/routing/eligibles.ts lib/routing/eligibles.test.ts
git commit -m "fix(times): agenda ilegivel fecha o time em vez de derrubar o roteamento"
```

---

## Task 5: a tool `crm_list_teams`

**Arquivos:**
- Criar: `lib/mcp/tools/times.ts`
- Modificar: `lib/mcp/tools/index.ts`

- [ ] **Passo 1: escrever a tool**

`lib/mcp/tools/times.ts`:

```ts
/**
 * crm_list_teams — o catálogo de destinos humanos, lido em RUNTIME.
 *
 * É esta tool que mantém o prompt do agente PORTÁVEL: ele nunca nomeia um time
 * nem carrega um uuid. Pergunta quais existem, lê o "quando usar" que a empresa
 * escreveu na tela, e escolhe pelo assunto. Renomear um time não mexe em prompt.
 *
 * `organization_id` SEMPRE do ctx — service role bypassa RLS.
 */
import { z } from "zod";

import { carregarTimes } from "@/lib/times/catalogo";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import type { McpToolDefinition } from "../types";

const inputShape = {
  /** true = só os que podem receber agora; false = todos, com o motivo visível. */
  only_open: z.boolean().default(false),
};

export const crmListTeams: McpToolDefinition<typeof inputShape> = {
  name: "crm_list_teams",
  description:
    "Times (setores) de atendimento da organização, com slug, nome, quando usar cada um, se está " +
    "aberto agora e quantas pessoas podem assumir. Use ANTES de transferir para humano: passe o " +
    "slug escolhido em crm_request_human_handoff. Time fechado ou sem ninguém elegível significa " +
    "que a conversa vai esperar na fila daquele time — avise o cliente do prazo real.",
  inputSchema: inputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agora = new Date();
    const times = await carregarTimes(ctx.supabase, ctx.organizationId, agora);
    const linhas = await Promise.all(times.map(async (t) => ({
      slug: t.slug,
      name: t.name,
      when_to_use: t.description,
      open_now: t.aberto_agora,
      eligible_count: t.aberto_agora
        ? (await loadEligibleAttendants(ctx.supabase, ctx.organizationId, agora, {
            kind: "organization_summary", teamId: t.id,
          })).length
        : 0,
    })));
    const visiveis = input.only_open ? linhas.filter((l) => l.open_now) : linhas;
    const prontos = linhas.filter((l) => l.eligible_count > 0);
    return {
      teams: visiveis,
      open_count: prontos.length,
      total_count: linhas.length,
      next_action:
        linhas.length === 0
          ? "Esta organização não tem times cadastrados. Use crm_request_human_handoff sem o parâmetro team."
          : prontos.length === 0
            ? "Nenhum time pode assumir agora. Transfira mesmo assim se o assunto exigir, mas avise o cliente do prazo real em vez de prometer atendimento imediato."
            : "Escolha o time pelo assunto e passe o slug dele em crm_request_human_handoff.",
    };
  },
};
```

- [ ] **Passo 2: registrar**

Em `lib/mcp/tools/index.ts`, acrescente `import { crmListTeams } from "./times";` junto dos demais
imports e `crmListTeams,` na lista de exportação/registro — nas **duas** posições onde
`crmListAvailableAttendants` aparece (linha ~36 e ~129 no arquivo atual).

- [ ] **Passo 3: verificar que a tool entrou no catálogo**

```bash
pnpm vitest run lib/mcp && pnpm typecheck
```

Esperado: PASS. Há testes que contam/validam o catálogo de tools; se algum afirmar um número de
tools, ele vai reprovar — atualize-o, é a régua fazendo o trabalho dela.

- [ ] **Passo 4: commit**

```bash
git add lib/mcp/tools/times.ts lib/mcp/tools/index.ts
git commit -m "feat(times): crm_list_teams — o agente descobre os setores em runtime"
```

---

## Task 6: o handoff aceita um time

**Arquivos:**
- Modificar: `lib/mcp/tools/handoff.ts`

- [ ] **Passo 1: acrescentar o parâmetro**

Em `inputShape`:

```ts
  /** Slug do time de destino (crm_list_teams). Ausente = comportamento de antes. */
  team: z.string().min(1).max(40).optional(),
```

- [ ] **Passo 2: validar ANTES de mutar**

Logo depois da checagem `if (!conv || conv.organization_id !== ctx.organizationId)`, e **antes** do
`beginServiceAtOrigin`, insira:

```ts
    // A ordem é a regra: o slug é validado enquanto NADA foi mutado. Validar
    // depois deixaria a conversa em `pending` com o bot silenciado e sem destino
    // — pior que recusar. Recusa estruturada com a lista válida: o modelo se
    // corrige sozinho na chamada seguinte.
    let teamId: string | null = null;
    if (input.team) {
      const { data: team, error: teamErr } = await ctx.supabase
        .from("attendance_teams")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("slug", input.team)
        .is("archived_at", null)
        .maybeSingle();
      if (teamErr) throw new Error(teamErr.message);
      if (!team) {
        const times = await carregarTimes(ctx.supabase, ctx.organizationId, new Date());
        return {
          handoff_recorded: false,
          conversation_id: input.conversation_id,
          error: "team_not_found",
          available_teams: times.map((t) => ({ slug: t.slug, name: t.name, when_to_use: t.description })),
          next_action: "Escolha um dos times listados em available_teams e chame esta ferramenta de novo.",
        };
      }
      teamId = team.id;
    }
```

Acrescente o import `import { carregarTimes } from "@/lib/times/catalogo";`.

- [ ] **Passo 3: gravar o time e usá-lo na escolha**

Dentro de `if (result.triggered) {`, **antes** do `loadEligibleAttendants`:

```ts
      if (teamId) {
        const { error: teamUpdateErr } = await ctx.supabase
          .from("conversations").update({ team_id: teamId })
          .eq("id", input.conversation_id).eq("organization_id", ctx.organizationId);
        if (teamUpdateErr) throw new Error(teamUpdateErr.message);
      }
```

E passe o time ao escopo e à posição da fila:

```ts
      const eligibles = await loadEligibleAttendants(ctx.supabase, ctx.organizationId, now, {
        kind: "conversation_channel", channelSessionId: conv.channel_session_id, teamId,
      });
```

```ts
        position = queued ? await getQueuePosition(
          ctx.supabase, ctx.organizationId, conv.last_inbound_at ?? null, now, teamId,
        ) : null;
```

E acrescente `team_id: teamId,` ao objeto de retorno final, ao lado de `assigned_to`.

- [ ] **Passo 4: atualizar a descrição da tool**

Na `description`, acrescente ao fim: `"Passe team (slug de crm_list_teams) para mandar ao setor certo; sem team, vai para a fila geral."`

- [ ] **Passo 5: rodar**

```bash
pnpm typecheck && pnpm vitest run lib/mcp
```

- [ ] **Passo 6: commit**

```bash
git add lib/mcp/tools/handoff.ts
git commit -m "feat(times): o handoff aceita um time, validado antes de qualquer mutação"
```

---

## Task 7: as rotas de configuração

**Arquivos:**
- Criar: `app/api/v1/settings/teams/route.ts`, `app/api/v1/settings/teams/[id]/archive/route.ts`

- [ ] **Passo 1: escrever `route.ts`**

Copie a estrutura de `app/api/v1/settings/routing/channels/route.ts` — ela é o molde canônico e já
tem todos os portões na ordem certa.

O GET:

```ts
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    const db = await createClient();
    const times = await carregarTimes(db, auth.org.orgId, new Date(), { incluirArquivados: true });
    const { data: membros } = await db.from("user_organizations")
      .select("user_id").eq("organization_id", auth.org.orgId).is("revoked_at", null)
      .in("role", ["agent", "manager", "admin"]);
    const ids = (membros ?? []).map((m: { user_id: string }) => String(m.user_id));
    const nomes = await nomesDosAtendentes(ids);
    return ok({ times, membros: ids.map((id) => ({ id, name: nomes.get(id) ?? "Atendente sem nome" })) }, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar os times. Tente novamente.", 500, { requestId });
  }
}
```

O POST valida com `timeDeAtendimentoSchema` e chama a RPC:

```ts
  const { data, error } = await db.rpc("fn_save_attendance_team", {
    p_org: auth.org.orgId,          // fonte confiável — NUNCA o body
    p_team: parsed.data.id,
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_description: parsed.data.description,
    p_schedule: parsed.data.schedule,
    p_users: parsed.data.user_ids,
  });
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe um time com esse identificador.", 409, { requestId });
    if (error.code === "P0002") return fail("not_found", "Time não encontrado.", 404, { requestId });
    if (error.code === "22023") return fail("validation_failed", "Confira o nome, o identificador e os atendentes selecionados.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar os times.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({ action: "routing.team_saved", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "attendance_team", resourceId: (data as { id: string }).id, requestId,
    metadata: { slug: parsed.data.slug, user_ids: parsed.data.user_ids } });
  return ok(data, { requestId });
```

Os quatro portões antes disso, na ordem do molde: `requireSupportWrite()`, `requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true })`, `mfaEmDivida()`, validação Zod.

⚠️ **`p_team` precisa de cast na chamada `.rpc()`.** Os tipos gerados declaram
`fn_save_attendance_team.Args.p_team` como `string`, não `string | null` — é o que o gerador emite
para um argumento `uuid` sem default —, mas o caminho de INSERT da RPC exige `p_team = null`. Sem o
cast, `pnpm typecheck` reprova a criação de time. Não é defeito dos tipos; é o gerador sendo fiel
ao catálogo.

- [ ] **Passo 2: escrever `[id]/archive/route.ts`**

Mesmos portões; corpo `{ arquivar: boolean }`; chama `fn_archive_attendance_team`; audita
`routing.team_archived`.

- [ ] **Passo 3: provar pelos dois lados**

```bash
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Passo 4: commit**

```bash
git add app/api/v1/settings/teams/
git commit -m "feat(times): as rotas de configuração, com escrita só por RPC e org da sessão"
```

---

## Task 8: a tela e a porta

**Arquivos:**
- Criar: `app/app/settings/teams/page.tsx`, `components/times/EditorDeTime.tsx`
- Modificar: `lib/navigation/catalogo.ts`

- [ ] **Passo 1: declarar a porta ANTES da tela**

Em `lib/navigation/catalogo.ts`, logo **depois** da entrada de `/app/settings/atendimento`:

```ts
  {
    // "de atendimento" no rótulo não é enfeite: "Equipe" (/app/team) já existe e
    // significa TODO MUNDO da organização. Dois vizinhos chamados "Equipe" e
    // "Times" obrigariam o usuário a adivinhar qual é qual.
    href: "/app/settings/teams",
    label: "Times de atendimento",
    description: "Os setores que recebem conversa: quem está em cada um e a que horas atendem.",
    icon: "UsersFour",
    group: "organizacao",
    section: "Sua empresa",
    minRole: "manager",
  },
```

- [ ] **Passo 2: rodar o gate de completude e ver falhar**

```bash
pnpm vitest run tests/unit/navegacao-completude.test.ts
```

Esperado: **FAIL** — a porta existe e a rota não. É o gate provando que funciona; a tela do passo 3
é o que o fecha. (Confirme que o ícone `UsersFour` existe no conjunto usado pelo Sidebar; se não,
use `UsersThree`.)

- [ ] **Passo 3: a tela**

`app/app/settings/teams/page.tsx` — Server Component que lê pela sessão (RLS de verdade) e entrega
ao componente cliente:

```tsx
import { redirect } from "next/navigation";

import { EditorDeTimes } from "@/components/times/EditorDeTime";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

export default async function Page() {
  const auth = await requireRole("manager", { resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) redirect("/app");
  const db = await createClient();
  const times = await carregarTimes(db, auth.org.orgId, new Date(), { incluirArquivados: true });
  const { data: membros } = await db.from("user_organizations")
    .select("user_id").eq("organization_id", auth.org.orgId).is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"]);
  const ids = (membros ?? []).map((m: { user_id: string }) => String(m.user_id));
  const nomes = await nomesDosAtendentes(ids);
  return (
    <EditorDeTimes
      times={times}
      membros={ids.map((id) => ({ id, name: nomes.get(id) ?? "Atendente sem nome" }))}
    />
  );
}
```

⚠️ `requireRole` fora de rota de API pode ter assinatura diferente da usada nas rotas — confira
como `app/app/settings/atendimento/page.tsx` faz o gate de `manager` e siga aquele padrão, em vez
de inventar um terceiro.

`components/times/EditorDeTime.tsx` (client component) tem, por time:

- **nome** e **slug** — o slug é preenchido por `slugDoTime(nome)` **enquanto o campo não for
  tocado à mão**; depois disso ele para de seguir o nome (senão renomear o time reescreveria um
  identificador que a pessoa escolheu de propósito);
- **"quando usar"**, com este texto de ajuda literal, porque é a única pista de que o campo não é
  decorativo: *"O agente de IA lê isto para escolher o time. Escreva os assuntos: fatura, boleto,
  negociação de dívida."*;
- **horário** — reaproveite o editor de janelas que já existe em
  `app/app/team/_components/AttendantsClient.tsx` (é o único do repo; extraia-o para
  `components/times/EditorDeJanelas.tsx` e faça os DOIS o importarem, em vez de copiar — duas
  cópias divergem na primeira correção de fuso);
- **membros**, com caixas de seleção sobre a lista de `membros`.

Cada card de time mostra nome, slug, **aberto agora** (vindo do catálogo, mesma regra do roteador),
nº de pessoas alocadas e o botão de arquivar. Salvar faz `POST /api/v1/settings/teams`.

⚠️ **`horario_invalido` PRECISA de leitor aqui, e esta é a única tarefa que pode dá-lo.** A Task 4.5
gravou esse campo em `TimeDoCatalogo` porque a decisão do dono foi "agenda ilegível = fechado **e
visível**". Hoje a visibilidade existe só do lado da fila (o aviso da Central). Se o card não
mostrar o aviso, um time com agenda ilegível simplesmente some do "aberto agora" sem dizer por quê
— e o campo vira a forma "campo sem consumidor" do anti-pattern nº 3 do `CLAUDE.md`. O card precisa
dizer, em português de gente: **"O horário deste time está inválido e ninguém está recebendo por
ele. Reconfigure o horário abaixo."**

- [ ] **Passo 4: rodar o gate de novo e ver passar**

```bash
pnpm vitest run tests/unit/navegacao-completude.test.ts && pnpm build
```

Esperado: PASS.

- [ ] **Passo 5: commit**

```bash
git add app/app/settings/teams/ components/times/ lib/navigation/catalogo.ts
git commit -m "feat(times): a tela de Times de atendimento e a porta dela na navegação"
```

---

## Task 9: o inbox — filtro, selo e transferência

**Arquivos:**
- Criar: `app/api/v1/conversations/[id]/team/route.ts`
- Modificar: `app/api/v1/conversations/route.ts`, `app/api/v1/conversations/_handler.ts`

- [ ] **Passo 1: o filtro**

Em `app/api/v1/conversations/route.ts`, junto dos demais `searchParams.get`:

```ts
    team_id: url.searchParams.get("team_id") ?? undefined,
```

E em `_handler.ts`, aplique no mesmo ponto onde `channel_session_id` é aplicado. O parâmetro aceita
três formas, e as três são necessárias:

```ts
  // "none" = a fila geral (conversas sem time). Sem esse valor não há COMO pedi-la:
  // ausência do parâmetro significa "não filtre", que é outra coisa.
  // "mine"  = os times de quem está olhando, MAIS as sem time. É o padrão do inbox
  //           para o papel `agent` — e é FILTRO, não barreira: quem enxerga o quê
  //           continua sendo `organizations.settings.visibility_mode`. Dizer que é
  //           restrição de segurança seria afirmar uma proteção que não existe.
  if (filtros.team_id === "none") {
    q = q.is("team_id", null);
  } else if (filtros.team_id === "mine") {
    const { data: meus } = await db.from("attendance_team_members")
      .select("team_id").eq("organization_id", orgId).eq("user_id", userId);
    const ids = (meus ?? []).map((m: { team_id: string }) => m.team_id);
    q = ids.length > 0 ? q.or(`team_id.is.null,team_id.in.(${ids.join(",")})`) : q.is("team_id", null);
  } else if (filtros.team_id) {
    q = q.eq("team_id", filtros.team_id);
  }
```

- [ ] **Passo 2: a rota de transferência**

`app/api/v1/conversations/[id]/team/route.ts`, no molde de
`app/api/v1/conversations/[id]/transfer/route.ts`: `requireSupportWrite()`, `requireRole("agent")`,
corpo `{ team_id: z.string().uuid().nullable() }`, RPC `fn_conversation_set_team`, mapeamento de
erro (`P0002` → 404, `42501` → 403) e `audit({ action: "routing.team_changed", … })`.

- [ ] **Passo 3: a UI**

Três arquivos, todos existentes:

- `components/inbox/ConversationHeader.tsx` — o selo do time (ou "Sem time"), ao lado do
  `JanelaSelo` que já mora ali.
- `components/inbox/ReassignDialog.tsx` — é o molde do diálogo de transferência para pessoa. Crie
  `components/inbox/TransferirParaTimeDialog.tsx` no mesmo formato, listando os times do catálogo
  **com o indicador de aberto/fechado ao lado de cada um**: quem transfere precisa saber que está
  mandando para um setor fechado **antes** de mandar, não depois.
- `components/inbox/InboxFilters.tsx` — o seletor de fila ("Meus times" / "Fila geral" / um time
  específico), que escreve o parâmetro `team_id` do passo 1.

- [ ] **Passo 4: provar**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run app/api
```

- [ ] **Passo 5: commit**

```bash
git add app/api/v1/conversations/ components/
git commit -m "feat(times): filtro de fila por time, selo na conversa e transferência entre setores"
```

---

## Task 10: o aviso da Central nomeia o time

**Arquivos:**
- Modificar: `supabase/migrations/20260916120000_0263_times_de_atendimento.sql`, `supabase/baseline.sql`

- [ ] **Passo 1: entender o que está errado hoje**

`fn_routing_unassigned_notice` (`supabase/baseline.sql:22486`) já abre o aviso e
`fn_routing_assignment_changed` já o resolve. **O laço existe inteiro.** O defeito é o corpo do
aviso: ele manda conferir "os responsáveis do canal", que é o lugar errado para uma conversa parada
na fila de um time.

- [ ] **Passo 2: acrescentar a versão nova da função aos DOIS artefatos**

Acrescente ao fim do bloco da migration 0263 (e ao apêndice do baseline, antes da varredura anon):

```sql
-- O aviso de conversa sem responsável passa a NOMEAR o time. Sem isto, quem lê
-- a Central é mandado conferir os responsáveis do CANAL — o lugar errado quando
-- a conversa espera na fila de um setor.
create or replace function public.fn_routing_unassigned_notice(p_org uuid,p_conversation uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare v_time text;
begin
 if not exists(select 1 from public.conversations where organization_id=p_org and id=p_conversation
  and assigned_to_user_id is null and status in('open','pending','claimed','ai_handling')) then return;end if;
 select t.name into v_time from public.conversations c
   join public.attendance_teams t on t.id=c.team_id and t.organization_id=c.organization_id
  where c.organization_id=p_org and c.id=p_conversation;
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
 values(p_org,'routing_unassigned','warn',
  case when v_time is null then 'Uma conversa aguarda um responsável'
       else 'Uma conversa aguarda o time ' || v_time end,
  case when p_reason='invalid_channel' then 'Confira o canal de origem desta conversa nas Conexões.'
   when v_time is not null then 'Ninguém do time ' || v_time || ' pode assumir agora. Confira quem está alocado nele e o horário do time em Configurações → Times de atendimento. A distribuição continuará tentando.'
   else 'Confira os responsáveis do canal em Configurações → Atendimento e a disponibilidade da equipe. A distribuição continuará tentando.' end,
  'conversation',p_conversation)
 on conflict(organization_id,ref_id,kind) where kind='routing_unassigned'
 do update set status='open',title=excluded.title,body=excluded.body;
end;
$$;
revoke execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) from public, anon, authenticated;
grant  execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) to service_role;
```

- [ ] **Passo 3: provar no Postgres de verdade**

```bash
pnpm test:db 2>&1 | tail -30
```

Esperado: verde. O `update.sh` de um clone re-aplica o baseline inteiro, então o
`create or replace` precisa passar num banco que **já tem** a versão antiga da função.

- [ ] **Passo 4: commit**

```bash
git add supabase/
git commit -m "fix(times): o aviso da Central nomeia o time, em vez de mandar olhar o canal"
```

---

## Task 11: prova em tela, fragmento e portões

**Arquivos:**
- Criar: `tests/e2e/times-de-atendimento.spec.ts`, `.changes/times-de-atendimento.md`
- Modificar: `.github/workflows/e2e.yml`

- [ ] **Passo 1: a spec E2E**

`tests/e2e/times-de-atendimento.spec.ts` dirige o **frontend**, num banco fresco estilo VPS
(`baseline.sql` + `scripts/bootstrap-owner.ts`), como manda a doutrina de QA Visual:

1. Entra em `/app/settings/teams` **pela navegação**, não pela URL — a porta é parte do que se prova.
2. Cria "Cancelamentos", slug sugerido automaticamente, "quando usar" preenchido.
3. Define a janela seg–sex 08h–18h.
4. Aloca um atendente.
5. Confere que o card mostra o nome, o slug e o estado de aberto/fechado.
6. Abre o inbox, filtra pela fila do time e confirma que o filtro responde.

Medidas de layout, se houver, por ferramenta (`getBoundingClientRect`/`getComputedStyle`), nunca a olho.

- [ ] **Passo 2: inscrever a spec no CI**

Acrescente `times-de-atendimento.spec.ts` a uma das `SPECS_PARTE_*` de `.github/workflows/e2e.yml`.
Se for ficar de fora, entre em `FORA_DO_CI` **com motivo escrito** — `tests/unit/e2e-cobertura-completa.test.ts`
reprova spec que não esteja em nenhuma das duas.

```bash
pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts
```

- [ ] **Passo 3: o fragmento de release**

`.changes/times-de-atendimento.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: O atendimento agora vai para o time certo
---

Times (setores) de atendimento: cadastre Suporte, Cobrança, Comercial ou o que a sua
operação usar, aloque atendentes em cada um — a mesma pessoa pode estar em vários — e
defina o horário do setor, que pode ser diferente do horário de quem atende.

O agente de IA descobre os times sozinho e escolhe pelo assunto da conversa; o prompt
não precisa conhecer nome nem identificador de time nenhum. Sem ninguém do time
disponível, a conversa espera na fila daquele setor em vez de cair no colo de quem não
atende aquilo, e quem opera pode transferir de time pela tela a qualquer momento.
```

```bash
pnpm release:conferir
```

- [ ] **Passo 4: os portões, todos, sem cortar a saída**

```bash
rm -f tsconfig*.tsbuildinfo
pnpm typecheck && pnpm lint && pnpm lint:channels
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
pnpm test:db
pnpm build
```

⚠️ **O exit code é a autoridade.** Rodapé `0 failed` com `exit=1` significa erro não tratado — leia
a linha `Errors` antes de concluir qualquer coisa. E `grep FAIL` pode voltar vazio **com** falhas:
compare `Tests N failed` (casos) com a contagem do `uniq -c` (casos). Se não baterem, a sonda está
cega — rode com `--reporter=verbose`.

Vermelho local que **não é seu**: `lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos quando o
`.env.local` tem `UPSTASH_REDIS_REST_URL` e o Redis não está de pé.

- [ ] **Passo 5: commit final**

```bash
git add tests/e2e/ .changes/ .github/workflows/e2e.yml
git commit -m "test(times): a prova em tela da jornada e o fragmento de release"
```

---

## Antes de considerar pronto

1. `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels` zerados.
2. `pnpm test:unit` verde **pelo exit code**, não só pelo rodapé.
3. `pnpm test:db` verde — é o único caminho que exercita o `baseline.sql` que o self-hoster aplica.
4. `pnpm build` verde.
5. Tripla de migration completa: arquivo + apêndice + MANIFEST no **mesmo commit** (o hook de
   `pre-commit` reprova o contrário).
6. Sabotagem feita e registrada: Task 2 passo 5 é o mínimo; repita em qualquer teste novo.
7. Fragmento em `.changes/` presente (o CI valida a **forma**, não a presença — a presença é cobrada
   aqui e por quem revisa).
8. **Antes do primeiro deploy**, confirmar na VPS que o `.env` tem `APP_IMAGE`,
   `WORKER_IMAGE` e `SCHEDULER_IMAGE` apontando para `ghcr.io/paulocmbcosta/…`. Se apontarem para o
   upstream, a produção roda a imagem de outra pessoa e **nada disto chega lá**, com o CI verde o
   tempo todo.
