# Telefonia · Fila visível — Entrega 2 (aba Telefone, teto por time, ordem de chegada) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** uma aba "Telefone" no trilho do Inbox mostra, ao vivo, quem está na fila do telefone (por ordem de chegada), no menu, em ligação e as perdidas dos últimos 30 minutos; cada time ganha a sua espera máxima na fila; e a fila passa a atender por ordem de chegada.

**Architecture:** o worker grava em `voice_calls` quando a ligação passou a esperar por uma pessoa (`queued_at`) e quando a espera esgota (`queue_deadline_at`); uma rota de leitura (`GET /api/v1/telefonia/fila`) monta a fila a partir do banco, e a tela a relê quando o Realtime avisa de mudança em `voice_calls`. O teto da espera sai de `attendance_teams.phone_queue_max_wait_seconds`. A ordem de chegada é decidida no controlador, em memória, por uma função pura.

**Tech Stack:** Postgres (migration + apêndice idempotente do `baseline.sql`), `pg` no worker e nas rotas (fora da RLS — toda consulta filtra `organization_id`), Next.js Route Handlers, React 19 + TanStack Query, Supabase Realtime, Vitest, Playwright (só no GitHub Actions).

Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.2).

---

## Decisões de implementação (emendas ao desenho, com o porquê)

1. **A rota da fila não devolve "quantos livres" por time.** Contar livres pede uma leitura da ARI e o diretório inteiro a cada pedido, e esta rota é lida por todo navegador com o Inbox aberto justamente no pico. Os times vêm com id, nome e teto; as contagens saem da própria lista de ligações. "Quantos livres" entra na entrega 3, no menu de mover, pelo diretório que já existe.
2. **Leitura compartilhada por 1,5 s por organização**, em memória da instância: vários navegadores que pedem no mesmo instante dividem uma leitura do banco.
3. **Um hook, uma assinatura**: `useFilaDoTelefone` é chamado UMA vez, no `InboxLayout`, e o resultado desce por props para o trilho (selo) e para a lista.
4. **A aba aparece quando a rota diz `ativa: true`** (instalação com telefonia E organização com número), e não pelo ramal de quem olha: `viewer` não tem ramal e vê a aba.
5. **O teto é lido quando a ligação entra na fila do time** (a leitura que já existe, `timeParaAFila`); mudar a configuração não altera quem já está esperando.
6. **Duas colunas a mais só nas linhas do telefone** (`CHECK`, como a 0294): a linha do WaCalls a REST escreve com o JWT do atendente, e ninguém forja por ela uma ligação "na fila".

## Regras do repositório que valem para todas as tasks

- Node 22: `source ~/.nvm/nvm.sh && nvm use 22.23.2` antes de qualquer `pnpm`. zsh: aspas em volta de qualquer glob.
- Nunca `console.log`. Comentários em português, no tom dos vizinhos (dizem o PORQUÊ). Não refatore fora do que a task pede.
- Toda consulta com `pool`/`db.query` filtra `organization_id` — vindo da sessão (`authz.org.orgId`) ou da linha da ligação, nunca do corpo do pedido.
- Texto de tela: `t("…")` com a chave em português, e a chave em `lib/i18n/dicionario.ts` com `es` (vigiado por `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`). Marcador `{x}` em texto se troca com `trocarMarcador` (`lib/telefonia/texto-do-menu.ts`), nunca `.replace("{x}", …)`.
- Data na tela: `useLocaleDeData()`; nada de `"pt-BR"` fixo nem import de `date-fns/locale`.
- `useState(() => …)` não pode ler `window`/`Date.now()`: relógio de tela começa em estado fixo e anda num `useEffect`.
- Um invariante: `pnpm test:db tests/invariants/<arquivo>.test.ts`. Unit de arquivos: `pnpm exec vitest run <caminhos>`.
- Commit ao fim de cada task, só com os arquivos dela: `git commit -m "<msg>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <arquivos>` (arquivo novo: `git add <arquivo>` antes). Nunca `git add -A`. Não fazer push.
- Não rodar e2e, `next build` nem Supabase local nesta máquina.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261007010000_0295_telefonia_fila_visivel.sql` | NOVO — colunas, CHECKs e índices |
| `supabase/baseline.sql` | bloco `-- ---- telefonia: a fila visível (migration 0295) ----`, logo ANTES do bloco `-- ---- VARREDURA anon:` |
| `supabase/migrations/MANIFEST.md` | linha da 0295 (última) |
| `tests/invariants/telefonia-fila-visivel-schema.test.ts` | NOVO — schema e autocura |
| `lib/telefonia/distribuicao.ts` (+ `.test.ts`) | `esperaMaximaMs`, `eAVezDela`, limites e opções |
| `lib/channels/telefonia/repositorio.ts` | `timeParaAFila` devolve o teto; `marcarNaFila`; `marcarPrazoDaFila`; `marcarAtendida` limpa o prazo |
| `tests/invariants/telefonia-fila-visivel-repositorio.test.ts` | NOVO — o SQL acima, duas organizações |
| `lib/channels/telefonia/portas.ts`, `laco.ts`, `dubles-de-teste.ts` | as portas novas |
| `lib/channels/telefonia/controle.ts` (+ `controle.test.ts`) | `queued_at`, teto por time, prazo, ordem de chegada, reavaliação ao fim de uma ligação |
| `lib/telefonia/fila.ts` (+ `.test.ts`) | NOVO — tipos da resposta e funções puras (fase, posição, motivo, relógio) |
| `lib/channels/telefonia/fila-da-tela.ts` | NOVO — a leitura SQL da fila |
| `tests/invariants/telefonia-fila-da-tela.test.ts` | NOVO — a leitura contra Postgres real |
| `app/api/v1/telefonia/fila/route.ts` (+ `route.test.ts`) | NOVO — `GET` |
| `lib/telefonia/espera-do-time.ts` | NOVO — ler e gravar o teto |
| `app/api/v1/telefonia/fila/times/route.ts`, `…/times/[teamId]/route.ts` (+ testes) | NOVO — `GET` e `PUT` do teto |
| `lib/audit/actions.ts` | `phone.queue_wait_changed` (no fim da lista) |
| `components/telefonia/EsperaMaximaDoTime.tsx`, `components/telefonia/useEsperaDosTimes.ts` (+ teste) | NOVO — o seletor em Configurações › Times |
| `app/app/settings/teams/_client.tsx` | renderiza o seletor depois do aviso de instabilidade |
| `hooks/telefonia/useFilaDoTelefone.ts` | NOVO — leitura + Realtime + rede de segurança |
| `components/telefonia/fila/FilaDoTelefone.tsx`, `LinhaDaFila.tsx`, `ChipsDaFila.tsx` (+ testes) | NOVO — a coluna da aba |
| `lib/inbox/abas.ts`, `components/inbox/InboxAbas.tsx`, `components/inbox/InboxLayout.tsx`, `components/inbox/ChipsDosTimes.tsx` | a aba `phone` |
| `lib/i18n/dicionario.ts` | chaves novas |
| `tests/e2e/telefonia-fila.spec.ts` + `.github/workflows/e2e.yml` (`SPECS_PARTE_3`) | NOVO — prova pela tela, semeada |
| `.changes/telefonia-aba-da-fila.md`, docs | fragmento, spec 20, estado atual, mapa, jornada |

Tasks 1 → (2, 3, 4 em sequência — o WORKER) e, em paralelo depois da 1, (5 → 6 e 7 — a TELA). 8 e 9 por último.

---

### Task 1: a migration 0295 (os três artefatos) e o invariante de schema

**Files:** os três de `supabase/` acima e `tests/invariants/telefonia-fila-visivel-schema.test.ts`.

- [ ] **Step 1: o invariante que falha.** Molde: `tests/invariants/telefonia-primeiro-toque-da-saida.test.ts` (leia inteiro: guarda de `TEST_DB_CONTAINER`, pool, semeadura, e o `describe("o bloco do baseline se cura sozinho")` — copie a técnica de extrair o bloco do `baseline.sql` e reaplicá-lo). Casos:
  1. `voice_calls` tem `queued_at` e `queue_deadline_at` (`timestamptz`, nulas); `attendance_teams` tem `phone_queue_max_wait_seconds` (`integer`, nula) — pergunte a `information_schema.columns`.
  2. Linha `sip_trunk` aceita as duas colunas; linha de outro provider (insira como o molde insere a do WaCalls) recusa `queued_at` e recusa `queue_deadline_at` (erro `23514`).
  3. `phone_queue_max_wait_seconds`: aceita `null`, `30`, `1800`; recusa `29`, `1801`, `0`, `-5` (`23514`).
  4. Os dois índices existem (`pg_indexes`): `idx_voice_calls_recebidas_vivas`, `idx_voice_calls_perdidas_recentes`.
  5. Autocura: derrube `voice_calls_fila_so_no_telefone_check`, ponha `queued_at` numa linha que não é `sip_trunk`, reaplique o bloco da 0295 extraído do baseline → a linha foi limpa e o CHECK existe e está validado (`pg_constraint.convalidated`).
  6. A REST não escreve as colunas na linha do telefone: como `authenticated` (o molde tem o helper que troca de papel e põe o JWT), `update voice_calls set queued_at = now()` numa linha `sip_trunk` não altera nada.

- [ ] **Step 2:** `pnpm test:db tests/invariants/telefonia-fila-visivel-schema.test.ts` → FAIL (colunas não existem).

- [ ] **Step 3: a migration** `supabase/migrations/20261007010000_0295_telefonia_fila_visivel.sql`:

```sql
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
-- 1:18" da tela. NULL = não está esperando sem ninguém livre.
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
  'Recebida: quando a espera sem ninguém livre esgota (o "cai em" da aba Telefone). Gravado pelo worker no relógio do banco. NULL = não está esperando. Só sip_trunk.';
comment on column public.attendance_teams.phone_queue_max_wait_seconds is
  'Espera máxima na fila do telefone deste time, em segundos (30 a 1800). NULL = o padrão, 120. Lido pelo worker quando a ligação entra na fila do time.';

notify pgrst, 'reload schema';
```

  **O bloco do baseline** é o mesmo conteúdo, com o cabeçalho curto no molde do bloco da 0294 (`-- ---- telefonia: a fila visível (migration 0295) ----` + "Racional no cabeçalho de supabase/migrations/…0295…sql" + quem escreve/lê + o teste que cobra) e com a validação do CHECK de `voice_calls` DENTRO do `do`, no molde exato do bloco da 0294 (só valida o que está NOT VALID, com `exception when check_violation then raise warning`). Entra **imediatamente antes** da linha `-- ---- VARREDURA anon:` (hoje logo depois do bloco da 0294). Use `$fila_0295$` e `$espera_0295$` como marcas no baseline.

  **MANIFEST**: uma linha nova no fim, no formato das vizinhas:
  `| \`20261007010000\` | \`0295_telefonia_fila_visivel\` | **Telefonia: a fila visível** (desenho \`docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md\` §4.2). … |` — diga o que cada coluna é, os CHECKs, os dois índices, "sem backfill", "idempotente", e os testes que cobram.

- [ ] **Step 4:** `pnpm test:db tests/invariants/telefonia-fila-visivel-schema.test.ts` → PASS (o `test:db` aplica o baseline em install e em update antes: os dois têm de dizer ok).
- [ ] **Step 5:** os guardas da tripla: `pnpm exec vitest run tests/unit/manifest-x-migrations.test.ts tests/unit/baseline-reaplicavel.test.ts tests/unit/baseline-constraint-reconstruida.test.ts tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/baseline-no-piso-do-postgres.test.ts` → PASS.
- [ ] **Step 6: commit** (os três de `supabase/` no MESMO commit — há um pre-commit que exige) + o invariante:
  `feat(banco): a fila do telefone ganha ordem de chegada, prazo e teto por time (0295)`

---

### Task 2: as funções puras da distribuição

**Files:** `lib/telefonia/distribuicao.ts`, `lib/telefonia/distribuicao.test.ts`

- [ ] **Step 1: testes que falham** (acrescentar ao arquivo de teste existente):

```ts
describe("a espera máxima na fila, por time (0295)", () => {
  it("sem configuração vale o padrão de sempre", () => {
    expect(esperaMaximaMs(null)).toBe(ESPERA_NA_FILA_MS);
    expect(esperaMaximaMs(undefined)).toBe(ESPERA_NA_FILA_MS);
    expect(esperaMaximaMs(Number.NaN)).toBe(ESPERA_NA_FILA_MS);
  });
  it("o configurado vale em milissegundos, preso aos limites", () => {
    expect(esperaMaximaMs(600)).toBe(600_000);
    expect(esperaMaximaMs(5)).toBe(ESPERA_NA_FILA_MIN_S * 1000);
    expect(esperaMaximaMs(99_999)).toBe(ESPERA_NA_FILA_MAX_S * 1000);
  });
  it("as opções da tela cabem nos limites e começam pelo padrão", () => {
    expect(OPCOES_DE_ESPERA_NA_FILA_S[0] * 1000).toBe(ESPERA_NA_FILA_MS);
    for (const s of OPCOES_DE_ESPERA_NA_FILA_S) {
      expect(s).toBeGreaterThanOrEqual(ESPERA_NA_FILA_MIN_S);
      expect(s).toBeLessThanOrEqual(ESPERA_NA_FILA_MAX_S);
    }
  });
});

describe("a vez na fila: ordem de chegada", () => {
  it("com um atendente livre, só a primeira da fila toca", () => {
    expect(eAVezDela(0, 1)).toBe(true);
    expect(eAVezDela(1, 1)).toBe(false);
  });
  it("com dois livres, as duas primeiras tocam; a terceira espera", () => {
    expect(eAVezDela(0, 2)).toBe(true);
    expect(eAVezDela(1, 2)).toBe(true);
    expect(eAVezDela(2, 2)).toBe(false);
  });
  it("sem ninguém livre, ninguém toca", () => {
    expect(eAVezDela(0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2:** `pnpm exec vitest run lib/telefonia/distribuicao.test.ts` → FAIL.
- [ ] **Step 3: implementar**, no fim de `lib/telefonia/distribuicao.ts`:

```ts
// ─── a espera máxima, por time (migration 0295) ───────────────────────────

/** Os limites de `attendance_teams.phone_queue_max_wait_seconds` (o CHECK do banco é o mesmo). */
export const ESPERA_NA_FILA_MIN_S = 30;
export const ESPERA_NA_FILA_MAX_S = 1800;
/** O que a tela oferece (Configurações › Times): 2, 5, 10, 15, 20 e 30 minutos. O primeiro é o padrão. */
export const OPCOES_DE_ESPERA_NA_FILA_S = [120, 300, 600, 900, 1200, 1800] as const;

/**
 * A espera máxima de um time, em ms. Sem configuração (ou com um valor que não
 * é número), o padrão de sempre — a fila nunca fica sem teto por causa de um
 * dado ruim. Preso aos limites: o banco já recusa fora deles, e o worker não
 * depende disso.
 */
export function esperaMaximaMs(segundos: number | null | undefined): number {
  if (typeof segundos !== "number" || !Number.isFinite(segundos)) return ESPERA_NA_FILA_MS;
  return Math.min(Math.max(Math.round(segundos), ESPERA_NA_FILA_MIN_S), ESPERA_NA_FILA_MAX_S) * 1000;
}

// ─── a vez na fila (ordem de chegada) ─────────────────────────────────────

/**
 * É a vez desta ligação tocar? Com `livres` atendentes livres, só as `livres`
 * ligações mais ANTIGAS que esperam (sem ramal tocando) podem tocar; as outras
 * esperam. `naFrente` = quantas, do mesmo time, chegaram antes desta e ainda
 * esperam. Sem isto, quem pegava o atendente que desocupou era a ligação cujo
 * relógio de 5 s disparasse primeiro — não a que esperava há mais tempo.
 */
export function eAVezDela(naFrente: number, livres: number): boolean {
  return naFrente < livres;
}
```

- [ ] **Step 4:** o teste → PASS. `pnpm typecheck` → sem erro.
- [ ] **Step 5: commit:** `feat(telefonia): a espera máxima por time e a vez na fila, como funções puras`

---

### Task 3: o repositório grava a fila

**Files:** `lib/channels/telefonia/repositorio.ts`, `portas.ts`, `laco.ts`, `dubles-de-teste.ts`, `tests/invariants/telefonia-fila-visivel-repositorio.test.ts`

- [ ] **Step 1: o invariante que falha** (molde e semeadura: `tests/invariants/telefonia-cartao-em-andamento.test.ts`, com ids `c0de0296-…`; duas organizações, um time em cada). Casos:
  1. `timeParaAFila` devolve `esperaMaximaS: null` para o time sem configuração e `600` depois de `update attendance_teams set phone_queue_max_wait_seconds = 600`; para time de outra organização, `situacao: "indisponivel"` e `esperaMaximaS: null`.
  2. `marcarNaFila(pool, ORG, vc)` grava `queued_at` (próximo de `now()`); chamada de novo NÃO move o instante; com a organização errada não grava nada; em ligação já encerrada não grava.
  3. `marcarPrazoDaFila(pool, ORG, vc, 90_000)` grava `queue_deadline_at` = `now()` do banco + 90 s (medido no banco: `extract(epoch from (queue_deadline_at - now()))` entre 88 e 90); com `null` apaga; organização errada não grava.
  4. `marcarAtendida` apaga `queue_deadline_at` e preserva `queued_at`.

- [ ] **Step 2:** rodar → FAIL (`marcarNaFila is not a function`).
- [ ] **Step 3: implementar em `repositorio.ts`.**

  Em `LinhaDoTimeNaFila`, acrescentar `espera_maxima_s: number | null;` e, no `select` de `lerTimeNaFila`, depois de `t.archived_at,`: `t.phone_queue_max_wait_seconds as espera_maxima_s,`.

  Em `TimeParaAFila`:
  ```ts
  /** A espera máxima na fila deste time, em segundos (0295) — `null` = o padrão. Lida aqui, na entrada: mudar a configuração não altera quem já está esperando. */
  esperaMaximaS: number | null;
  ```
  e `timeParaAFila` passa a devolver `esperaMaximaS: t?.espera_maxima_s ?? null` nos DOIS retornos (o time que não existe nesta organização devolve `null`).

  Depois de `marcarTocando`:
  ```ts
  /**
   * A ligação passou a ESPERAR POR UMA PESSOA (0295): o começo dos toques. Guarda
   * a PRIMEIRA vez — é a ordem de chegada da fila, e mover de time não a muda.
   */
  export async function marcarNaFila(db: Queryable, organizationId: string, id: string): Promise<void> {
    await db.query(
      `update voice_calls set queued_at = coalesce(queued_at, now()), updated_at = now()
        where id = $1 and organization_id = $2 and status <> 'ended'`,
      [id, organizationId],
    );
  }

  /**
   * Quando a espera sem ninguém livre esgota (0295) — o "cai em" da aba Telefone.
   * `restanteMs` é o que falta no relógio do worker; vira `now()` do BANCO mais
   * isso, para a conta não depender de os dois relógios baterem (o desenho da
   * 0294). `null` = não está mais esperando.
   */
  export async function marcarPrazoDaFila(
    db: Queryable,
    organizationId: string,
    id: string,
    restanteMs: number | null,
  ): Promise<void> {
    await db.query(
      `update voice_calls
          set queue_deadline_at = case when $3::double precision is null then null
                                       else now() + make_interval(secs => $3::double precision / 1000) end,
              updated_at = now()
        where id = $1 and organization_id = $2 and status <> 'ended'`,
      [id, organizationId, restanteMs],
    );
  }
  ```
  Em `marcarAtendida`, acrescentar `queue_deadline_at = null,` ao `set` (quem foi atendido não cai por espera).

  `portas.ts` (`PortaBanco`, depois de `marcarTocando`):
  ```ts
  /** A ligação passou a esperar por uma pessoa (0295): a ordem de chegada. Guarda a primeira vez. */
  marcarNaFila(org: string, id: string): Promise<void>;
  /** Quando a espera sem ninguém livre esgota, em ms a partir de agora (0295); `null` = não espera mais. */
  marcarPrazoDaFila(org: string, id: string, restanteMs: number | null): Promise<void>;
  ```
  `laco.ts` (`portaBanco`): `marcarNaFila: (org, id) => repo.marcarNaFila(pool, org, id),` e `marcarPrazoDaFila: (org, id, ms) => repo.marcarPrazoDaFila(pool, org, id, ms),`.

  `dubles-de-teste.ts` (`BancoFalso`):
  ```ts
  /** O teto do time que `timeParaAFila` devolve, em segundos (`null` = o padrão). */
  esperaMaximaS: number | null = null;
  ```
  `timeParaAFila` devolve também `esperaMaximaS: this.esperaMaximaS`; e, depois de `marcarTocando`:
  ```ts
  marcarNaFila = async (org: string, id: string) => {
    if (!this.daOrg(org, id, "marcarNaFila")) return;
    this.eventos.push(["na_fila", id]);
  };
  marcarPrazoDaFila = async (org: string, id: string, restanteMs: number | null) => {
    if (!this.daOrg(org, id, "marcarPrazoDaFila")) return;
    this.eventos.push(["prazo_da_fila", id, restanteMs]);
  };
  ```

- [ ] **Step 4:** o invariante → PASS; `pnpm exec vitest run lib/channels/telefonia` → PASS; `pnpm typecheck` → sem erro. (O `TimeParaAFila` ganhou campo obrigatório: `entrarNaFila` em `controle.ts` monta `{ situacao: "aberto", aviso: null }` como valor inicial — acrescente `esperaMaximaS: null` ali para compilar; o uso de verdade é da Task 4.)
- [ ] **Step 5: commit:** `feat(telefonia): o repositório grava a ordem de chegada e o prazo da fila, e lê o teto do time`

---

### Task 4: o controlador — ordem de chegada, teto por time, prazo

**Files:** `lib/channels/telefonia/controle.ts`, `lib/channels/telefonia/controle.test.ts`

Leia antes, em `controle.ts`: `FilaDaLigacao`, `novaRecebida` (o estado inicial da fila), `entrarNaFila`, `comecarOsToques`, `tocarProximo`, `aoDestruirCanal` (o ramo da recebida) e `finalizar`.

- [ ] **Step 1: os testes que falham.** `describe` novo no fim de `controle.test.ts`:

```ts
describe("a fila visível (0295): ordem de chegada, teto por time e prazo", () => {
  const cliente2 = canal("cli-2", `PJSIP/tronco-${TRONCO}-00000002`, { caller: { name: "", number: "61977776666" } });
  const entrar2 = () => ctl.tratar({ type: "StasisStart", channel: cliente2, args: ["entrada"] });
  /** Para quem cada ligação foi oferecida, na ordem: `[endpoint, appArgs]`. */
  const ofertas = () => ari.chamadas.filter((c) => c[0] === "originar").map((c) => [c[1], c[2]]);

  it("a ordem de chegada é gravada uma vez, quando os toques começam", async () => {
    await entrar();
    expect(banco.tem("na_fila")).toEqual([["na_fila", "vc-1"]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(banco.tem("na_fila")).toHaveLength(1);
  });

  it("sem ninguém livre, o prazo da fila é gravado com o teto padrão — e a fila esgota nele", async () => {
    await entrar();
    expect(banco.tem("prazo_da_fila")).toEqual([["prazo_da_fila", "vc-1", 120_000]]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("o teto é o do time: com 5 minutos, a ligação não cai aos 2 e cai aos 5", async () => {
    banco.esperaMaximaS = 300;
    await entrar();
    expect(banco.tem("prazo_da_fila")).toEqual([["prazo_da_fila", "vc-1", 300_000]]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("duas esperando e UM atendente fica livre: toca para a que chegou primeiro, não para a segunda", async () => {
    await entrar();
    await vi.advanceTimersByTimeAsync(2_000); // a segunda chega 2 s depois…
    await entrar2();
    // …e o relógio de 5 s da SEGUNDA dispara antes do da primeira logo depois de o atendente ficar livre.
    await vi.advanceTimersByTimeAsync(4_500); // t=6,5 s: a 1ª reavaliou em t=5 e reavalia em t=10; a 2ª em t=7
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(1_000); // t=7,5 s: o relógio da SEGUNDA dispara — e ela NÃO toca
    expect(ofertas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000); // t=10,5 s: o da PRIMEIRA dispara — e ela toca
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);
  });

  it("três esperando e dois livres: as duas mais antigas tocam, a terceira espera", async () => {
    const cliente3 = canal("cli-3", `PJSIP/tronco-${TRONCO}-00000003`, { caller: { name: "", number: "61966665555" } });
    await entrar();
    await vi.advanceTimersByTimeAsync(1_000);
    await entrar2();
    await vi.advanceTimersByTimeAsync(1_000);
    await ctl.tratar({ type: "StasisStart", channel: cliente3, args: ["entrada"] });
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 0, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);
    await vi.advanceTimersByTimeAsync(6_000);
    const quem = ofertas().map((o) => o[1]);
    expect(quem).toContain("oferta,vc-1");
    expect(quem).toContain("oferta,vc-2");
    expect(quem).not.toContain("oferta,vc-3");
  });

  it("quando uma ligação acaba, quem espera é reavaliado NA HORA — sem esperar os 5 s", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await entrar();
    await ramalAtende(ari.ultimoOriginado()); // ANA atende a primeira
    banco.disponiveis = []; // ANA está em ligação
    await entrar2(); // a segunda espera
    await vi.advanceTimersByTimeAsync(1_000);
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 1, ultimaAtendidaEm: new Date() }];
    await destruir("cli-1"); // a primeira acaba: ANA está livre
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${ANA}`, "oferta,vc-2"]);
  });

  it("o banco cai ao gravar a fila ou o prazo: a ligação segue e é atendida mesmo assim", async () => {
    banco.marcarNaFila = async () => {
      throw new Error("banco fora do ar");
    };
    banco.marcarPrazoDaFila = async () => {
      throw new Error("banco fora do ar");
    };
    await entrar();
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("atendida")).toHaveLength(1);
  });
});
```

  Observações para quem escreve: `BancoFalso.disponiveis` é a MESMA lista para qualquer time e não sabe quem está tocando — o teste a troca à mão, como os casos vizinhos fazem (num caso com dois atendentes e duas ligações tocando, a segunda ligação pode ver na lista o atendente que já toca para a primeira; se isso atrapalhar um caso, ajuste a lista entre os passos, sem afrouxar a afirmação). Confira os instantes do caso "duas esperando" contra o relógio de verdade do controlador (`REAVALIAR_FILA_MS = 5_000`, armado a cada passagem pelo ramo "esperar") e ajuste os avanços se a aritmética real for outra — a AFIRMAÇÃO não muda: com um livre, a segunda não toca antes da primeira.

- [ ] **Step 2:** `pnpm exec vitest run lib/channels/telefonia/controle.test.ts` → FAIL nos casos novos.

- [ ] **Step 3: implementar em `controle.ts`.**

  1. Imports de `@/lib/telefonia/distribuicao`: acrescentar `eAVezDela` e `esperaMaximaMs` (o `ESPERA_NA_FILA_MS` deixa de ser usado neste arquivo — remova do import se sobrar).
  2. `FilaDaLigacao` ganha:
  ```ts
  /**
   * Quando a ligação passou a esperar por uma pessoa (o começo dos toques) — a
   * ORDEM DE CHEGADA da fila (0295). `null` enquanto está no menu ou nos avisos.
   */
  entrouEm: number | null;
  /** A espera máxima sem ninguém livre, do TIME (0295); o padrão até a fila do time ser lida. */
  tetoMs: number;
  ```
  e o estado inicial em `novaRecebida`: `entrouEm: null, tetoMs: esperaMaximaMs(null),`.
  3. `entrarNaFila`: o valor inicial vira `{ situacao: "aberto", aviso: null, esperaMaximaS: null }`, e logo depois de `l.fila.avisoPendente = entrada.aviso;`: `l.fila.tetoMs = esperaMaximaMs(entrada.esperaMaximaS);`.
  4. `comecarOsToques`:
  ```ts
  private async comecarOsToques(l: Recebida): Promise<void> {
    if (l.fim) return;
    l.fila.inicioDosToques = this.agora();
    // A ordem de chegada (0295): a PRIMEIRA vez que os toques começam. Não
    // gravar não pode parar a fila — a tela perde a posição, a ligação não.
    if (l.fila.entrouEm === null) {
      l.fila.entrouEm = this.agora();
      await this.banco
        .marcarNaFila(l.org, l.vcId)
        .catch((e) => this.log.warn("telefonia: entrada na fila não gravada", { voice_call: l.vcId, erro: mensagemDe(e, 160) }));
      if (l.fim) return;
    }
    return this.tocarProximo(l);
  }
  ```
  5. Dois métodos novos, perto de `disponiveisComRamal`:
  ```ts
  /**
   * As recebidas que ESPERAM por uma pessoa (sem ramal tocando) na fila de um
   * time, da mais antiga para a mais nova (0295). Só o que este worker tem em
   * memória — que é tudo: a fila só existe aqui.
   */
  private esperandoNoTime(org: string, teamId: string | null): Recebida[] {
    const fila: Recebida[] = [];
    for (const l of this.porId.values()) {
      if (l.tipo !== "recebida" || l.fim || l.atendidaPor || l.encerrando || l.ura) continue;
      if (l.org !== org || l.fila.teamId !== teamId || l.fila.entrouEm === null || l.fila.ramal) continue;
      fila.push(l);
    }
    return fila.sort((a, b) => a.fila.entrouEm! - b.fila.entrouEm! || (a.vcId < b.vcId ? -1 : 1));
  }

  /**
   * Uma ligação acabou — alguém pode ter ficado livre. Quem está esperando
   * reavalia JÁ, da mais antiga para a mais nova, em vez de aguardar o próprio
   * relógio de 5 s (que segue como rede de segurança para o que não gera
   * evento: alguém saiu da pausa). Nunca lança: é o fim de OUTRA ligação.
   */
  private async reavaliarQuemEspera(org: string): Promise<void> {
    const esperando: Recebida[] = [];
    for (const l of this.porId.values()) {
      if (l.tipo === "recebida" && l.org === org && l.fila.esperando && l.fila.entrouEm !== null && !l.fila.ramal) esperando.push(l);
    }
    esperando.sort((a, b) => a.fila.entrouEm! - b.fila.entrouEm! || (a.vcId < b.vcId ? -1 : 1));
    for (const l of esperando) {
      if (l.fim || l.atendidaPor || l.encerrando || l.ura || l.fila.ramal) continue;
      await this.tocarProximo(l).catch((e) =>
        this.log.warn("telefonia: reavaliação da fila falhou — o relógio de 5 s tenta de novo", { voice_call: l.vcId, erro: mensagemDe(e, 160) }),
      );
    }
  }
  ```
  6. `tocarProximo`: depois do `try/catch` que lê `disponiveis` e ANTES de `const p = proximoToque(…)`:
  ```ts
    // A VEZ (ordem de chegada, 0295): com N livres, só as N mais antigas que
    // esperam podem tocar. Quem não está entre elas espera como se ninguém
    // estivesse livre — música, e o teto do time.
    if (disponiveis.length > 0 && l.fila.entrouEm !== null) {
      const naFrente = this.esperandoNoTime(l.org, l.fila.teamId).findIndex((o) => o === l);
      if (naFrente > 0 && !eAVezDela(naFrente, disponiveis.length)) disponiveis = [];
    }
  ```
  (`findIndex` devolve a posição desta ligação na fila ordenada = quantas estão na frente; `-1` — ela não está na lista por algum motivo — não bloqueia.)

  No ramo `esperar`, trocar o bloco por:
  ```ts
    if (p.tipo === "esperar") {
      if (!l.fila.esperando) {
        l.fila.esperando = true;
        l.fila.inicioDaEspera = this.agora();
        // O "cai em" da tela (0295). Não gravar não muda a espera.
        await this.banco
          .marcarPrazoDaFila(l.org, l.vcId, l.fila.tetoMs)
          .catch((e) => this.log.warn("telefonia: prazo da fila não gravado", { voice_call: l.vcId, erro: mensagemDe(e, 160) }));
        if (l.fim) return;
        await this.segurarNaLinha(l);
        if (l.fim) return;
        await this.marcarTocando(l, null);
      }
      if (this.agora() - (l.fila.inicioDaEspera ?? this.agora()) >= l.fila.tetoMs) {
        return this.encerrarComFala(l, "fila_esgotada");
      }
      this.armar(l, REAVALIAR_FILA_MS, () => this.tocarProximo(l));
      return;
    }
  ```
  7. `finalizar`: como ÚLTIMA instrução (depois do `log.info` de "ligação encerrada"; quando a função sai cedo por `if (!l) return;` NÃO chama — só reavalia quem de fato fechou uma ligação agora):
  ```ts
    // Alguém pode ter ficado livre: quem espera reavalia já (0295).
    await this.reavaliarQuemEspera(org);
  ```
  Atualize os comentários que dizem "2 min" onde a régua passou a ser o teto do time (`inicioDaEspera`, `tocarProximo`).

- [ ] **Step 4:** `pnpm exec vitest run lib/channels/telefonia` → PASS em TODOS (os casos antigos dos 2 minutos continuam verdes: o padrão não mudou). `pnpm typecheck` → sem erro.
- [ ] **Step 5: sabotagens** (rode, mostre o vermelho, desfaça): (a) tire o bloco "A VEZ" de `tocarProximo` → o caso "duas esperando" reprova; (b) troque `l.fila.tetoMs` por `120_000` na comparação → o caso "teto é o do time" reprova; (c) tire a chamada de `reavaliarQuemEspera` → o caso "reavaliado NA HORA" reprova.
- [ ] **Step 6: commit:** `feat(telefonia): a fila atende por ordem de chegada, com o teto de espera do time`

---

### Task 5: a leitura da fila — funções puras, SQL e rota

**Files:** `lib/telefonia/fila.ts` (+ `.test.ts`), `lib/channels/telefonia/fila-da-tela.ts`, `tests/invariants/telefonia-fila-da-tela.test.ts`, `app/api/v1/telefonia/fila/route.ts` (+ `route.test.ts`)

- [ ] **Step 1: `lib/telefonia/fila.ts`** — tipos e funções puras, usados pelo servidor E pela tela (sem import de servidor):

```ts
/**
 * A FILA DO TELEFONE, como a tela a lê (aba Telefone do Inbox; migration 0295).
 * Tipos da resposta de `GET /api/v1/telefonia/fila` e as regras puras que o
 * servidor e a tela dividem — a fase de uma ligação, a posição na fila, por que
 * uma ligação se perdeu, e o relógio "m:ss". Quem lê o banco é
 * `lib/channels/telefonia/fila-da-tela.ts`.
 */
import { esperaMaximaMs } from "./distribuicao";
import { MOTIVO_FORA_DO_HORARIO } from "./vocabulario";

/** Onde a ligação está AGORA. */
export const FASES_DA_LIGACAO = ["menu", "avisos", "aguardando", "tocando", "em_ligacao", "transferencia_na_fila"] as const;
export type FaseDaLigacao = (typeof FASES_DA_LIGACAO)[number];

/** As fases que contam como "esperando por alguém" — o selo do trilho e a contagem do chip. */
export const FASES_QUE_ESPERAM: ReadonlySet<FaseDaLigacao> = new Set(["aguardando", "tocando", "transferencia_na_fila"]);

export const MOTIVOS_DA_PERDIDA = ["desligou_no_menu", "desistiu_na_fila", "fila_esgotada", "ninguem_atendeu", "fora_do_horario", "interrompida", "outro"] as const;
export type MotivoDaPerdida = (typeof MOTIVOS_DA_PERDIDA)[number];

export interface PessoaDaFila {
  id: string;
  nome: string | null;
}

export interface LigacaoNaFila {
  id: string;
  fase: FaseDaLigacao;
  /** O contato, se a ligação tem um (número oculto não tem). */
  contato: { id: string; nome: string | null } | null;
  /** O número de quem liga (E.164, ou o que a operadora mandou). */
  numero: string;
  /** O time da fila em que ela está (na transferência para um time, o time de destino). */
  time_id: string | null;
  /** O número da EMPRESA que foi chamado. */
  numero_da_empresa_id: string;
  conversa_id: string | null;
  /** Quando a ligação começou. */
  entrou_em: string;
  /** Quando passou a esperar por uma pessoa (`queued_at`); na transferência, quando ela foi pedida. `null` no menu e nos avisos. */
  na_fila_desde: string | null;
  /** A posição na fila do time (1 = a próxima); `null` fora de `aguardando`/`tocando`. */
  posicao: number | null;
  /** Quando a espera sem ninguém livre esgota; só em `aguardando`. */
  cai_em: string | null;
  tocando_para: PessoaDaFila | null;
  /** Com quem está falando (`em_ligacao`) — ou quem transferiu (`transferencia_na_fila`). */
  com: PessoaDaFila | null;
  atendida_em: string | null;
}

export interface PerdidaRecente {
  id: string;
  contato: { id: string; nome: string | null } | null;
  numero: string;
  time_id: string | null;
  numero_da_empresa_id: string;
  conversa_id: string | null;
  motivo: MotivoDaPerdida;
  /** Quanto esperou até a ligação acabar, em segundos (do começo da fila; sem fila, do começo da ligação). */
  esperou_s: number;
  encerrada_em: string;
}

export interface FilaDoTelefone {
  /** A instalação tem telefonia E a organização tem número: sem isso a aba nem aparece. */
  ativa: boolean;
  /** O relógio do BANCO na hora da leitura — a tela mede a defasagem do relógio dela por ele. */
  agora: string;
  times: Array<{ id: string; nome: string; espera_maxima_s: number }>;
  numeros: Array<{ id: string; nome: string | null; numero: string | null }>;
  ligacoes: LigacaoNaFila[];
  perdidas: PerdidaRecente[];
}

export const FILA_DESLIGADA: Omit<FilaDoTelefone, "agora"> = { ativa: false, times: [], numeros: [], ligacoes: [], perdidas: [] };

/** A fase, a partir das colunas da ligação viva. */
export function faseDaLigacao(l: {
  status: string;
  queued_at: unknown;
  ringing_user_id: string | null;
  menu_id: string | null;
  menu_outcome: string | null;
  transferencia_time_id: string | null;
}): FaseDaLigacao {
  if (l.status === "connected") return l.transferencia_time_id ? "transferencia_na_fila" : "em_ligacao";
  if (l.queued_at) return l.ringing_user_id ? "tocando" : "aguardando";
  return l.menu_id && !l.menu_outcome ? "menu" : "avisos";
}

/** Por que a recebida não atendida acabou. */
export function motivoDaPerdida(l: {
  end_reason: string | null;
  queued_at: unknown;
  menu_id: string | null;
  menu_outcome: string | null;
}): MotivoDaPerdida {
  if (l.end_reason === MOTIVO_FORA_DO_HORARIO) return "fora_do_horario";
  if (l.end_reason === "fila_esgotada") return "fila_esgotada";
  if (l.end_reason === "ninguem_atendeu") return "ninguem_atendeu";
  if (l.end_reason === "cliente_desligou") {
    return !l.queued_at && l.menu_id && !l.menu_outcome ? "desligou_no_menu" : "desistiu_na_fila";
  }
  if (l.end_reason && l.end_reason.includes("reinicio")) return "interrompida";
  return "outro";
}

/**
 * A posição de cada ligação na fila do SEU time: as que esperam por uma pessoa
 * (`aguardando` ou `tocando`), pela ordem de chegada (`na_fila_desde`; empate
 * pelo id, para a ordem ser estável). Devolve `id → posição` (1 = a próxima).
 */
export function posicoesNaFila(
  ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "id" | "fase" | "time_id" | "na_fila_desde">>,
): Map<string, number> {
  const porTime = new Map<string, Array<{ id: string; desde: number }>>();
  for (const l of ligacoes) {
    if ((l.fase !== "aguardando" && l.fase !== "tocando") || !l.na_fila_desde) continue;
    const chave = l.time_id ?? "";
    const lista = porTime.get(chave) ?? [];
    lista.push({ id: l.id, desde: new Date(l.na_fila_desde).getTime() });
    porTime.set(chave, lista);
  }
  const posicoes = new Map<string, number>();
  for (const lista of porTime.values()) {
    lista.sort((a, b) => a.desde - b.desde || (a.id < b.id ? -1 : 1));
    lista.forEach((l, i) => posicoes.set(l.id, i + 1));
  }
  return posicoes;
}

/** O resumo de um time para o chip: quantas esperam e há quanto tempo a mais antiga espera (ms). */
export function resumoDoTime(
  ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "fase" | "time_id" | "na_fila_desde">>,
  timeId: string,
  agoraMs: number,
): { esperando: number; maisAntigaMs: number | null } {
  let esperando = 0;
  let maisAntiga: number | null = null;
  for (const l of ligacoes) {
    if (l.time_id !== timeId || !FASES_QUE_ESPERAM.has(l.fase)) continue;
    esperando++;
    if (!l.na_fila_desde) continue;
    const ms = agoraMs - new Date(l.na_fila_desde).getTime();
    if (maisAntiga === null || ms > maisAntiga) maisAntiga = ms;
  }
  return { esperando, maisAntigaMs: maisAntiga === null ? null : Math.max(0, maisAntiga) };
}

/** Quantas ligações esperam por alguém — o selo do trilho. */
export function quantasEsperam(ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "fase">>): number {
  return ligacoes.filter((l) => FASES_QUE_ESPERAM.has(l.fase)).length;
}

/** "m:ss" (e "h:mm:ss" depois de uma hora). Negativo vira "0:00". */
export function relogio(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type UrgenciaDaEspera = "normal" | "atencao" | "critico";

/**
 * O quanto a espera pesa: passou da METADE do teto do time → atenção; faltam
 * menos de 20% → crítico. Sem prazo (há gente livre tocando), normal.
 */
export function urgenciaDaEspera(caiEmMs: number | null, agoraMs: number, tetoS: number | null): UrgenciaDaEspera {
  if (caiEmMs === null) return "normal";
  const teto = esperaMaximaMs(tetoS);
  const resta = caiEmMs - agoraMs;
  if (resta <= teto * 0.2) return "critico";
  if (resta <= teto * 0.5) return "atencao";
  return "normal";
}
```

  E `lib/telefonia/fila.test.ts` com tabela de casos: `faseDaLigacao` (as seis fases; `connected` com e sem transferência para time; `ringing` sem `queued_at` com menu sem desfecho = `menu`, com desfecho = `avisos`, sem menu = `avisos`); `motivoDaPerdida` (os sete; `cliente_desligou` com e sem `queued_at`, com menu decidido); `posicoesNaFila` (dois times, empate de instante resolvido pelo id, `em_ligacao` e `menu` de fora); `resumoDoTime`; `quantasEsperam`; `relogio` (0, 59 s, 61 s, 3601 s, negativo); `urgenciaDaEspera` (sem prazo; metade; 20%; teto nulo = 120 s).

  Run: `pnpm exec vitest run lib/telefonia/fila.test.ts` → falha antes de o arquivo existir, passa depois.

- [ ] **Step 2: a leitura SQL** — `lib/channels/telefonia/fila-da-tela.ts`:

```ts
/**
 * A FILA DO TELEFONE LIDA DO BANCO (aba Telefone; migration 0295). Server-only.
 * A organização vem SEMPRE de quem chama (a sessão) e entra em TODA consulta —
 * a conexão é a do app, fora da RLS. Nada aqui fala com o Asterisk: a fila que
 * a tela mostra é a que o worker gravou em `voice_calls`.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { esperaMaximaMs } from "@/lib/telefonia/distribuicao";
import {
  faseDaLigacao,
  motivoDaPerdida,
  posicoesNaFila,
  type FilaDoTelefone,
  type LigacaoNaFila,
  type PerdidaRecente,
} from "@/lib/telefonia/fila";

import { PROVIDER } from "./repositorio";

/** Há quanto tempo, no máximo, uma ligação "viva" é levada a sério (a mesma régua do "ocupado" do distribuidor). */
const VIVA_HA_NO_MAXIMO = "4 hours";
/** A janela das perdidas recentes (D11 do desenho) e o teto de linhas dela. */
const PERDIDAS_DESDE = "30 minutes";
const MAXIMO_DE_PERDIDAS = 100;

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());
const NOME_DE = (coluna: string) =>
  `(select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = ${coluna})`;

export async function lerFilaDoTelefone(db: Queryable, organizationId: string): Promise<FilaDoTelefone> {
  const numeros = await db.query<{ id: string; nome: string | null; numero: string | null }>(
    `select id, display_name as nome, phone_number as numero
       from channel_sessions
      where organization_id = $1 and provider = $2 and archived_at is null
      order by created_at asc`,
    [organizationId, PROVIDER],
  );
  const relogio = await db.query<{ agora: Date }>("select now() as agora");
  const agora = new Date(relogio.rows[0]!.agora).toISOString();
  if (numeros.rows.length === 0) return { ativa: false, agora, times: [], numeros: [], ligacoes: [], perdidas: [] };

  const times = await db.query<{ id: string; nome: string; espera: number | null }>(
    `select id, name as nome, phone_queue_max_wait_seconds as espera
       from attendance_teams
      where organization_id = $1 and archived_at is null
      order by name asc`,
    [organizationId],
  );

  const vivas = await db.query<{
    id: string; status: string; peer_phone: string; team_id: string | null; channel_session_id: string;
    conversation_id: string | null; contact_id: string | null; contato_nome: string | null;
    started_at: Date; queued_at: Date | null; queue_deadline_at: Date | null; answered_at: Date | null;
    menu_id: string | null; menu_outcome: string | null;
    ringing_user_id: string | null; tocando_nome: string | null;
    owner_user_id: string | null; dono_nome: string | null;
    transferencia_time_id: string | null; transferencia_desde: Date | null;
    transferida_por: string | null; transferida_por_nome: string | null;
  }>(
    `select v.id, v.status, v.peer_phone, v.team_id, v.channel_session_id, v.conversation_id, v.contact_id,
            coalesce(c.display_name, c.name) as contato_nome,
            v.started_at, v.queued_at, v.queue_deadline_at, v.answered_at, v.menu_id, v.menu_outcome,
            v.ringing_user_id, ${NOME_DE("v.ringing_user_id")} as tocando_nome,
            v.owner_user_id, ${NOME_DE("v.owner_user_id")} as dono_nome,
            tr.to_team_id as transferencia_time_id, tr.created_at as transferencia_desde,
            tr.from_user_id as transferida_por, ${NOME_DE("tr.from_user_id")} as transferida_por_nome
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
       left join voice_call_transfers tr
         on tr.organization_id = v.organization_id and tr.voice_call_id = v.id
        and tr.status = 'open' and tr.to_team_id is not null
      where v.organization_id = $1 and v.provider = $2 and v.direction = 'inbound' and v.status <> 'ended'
        and v.started_at > now() - interval '${VIVA_HA_NO_MAXIMO}'
      order by coalesce(v.queued_at, v.started_at) asc, v.id asc`,
    [organizationId, PROVIDER],
  );

  const ligacoes: LigacaoNaFila[] = vivas.rows.map((r) => {
    const fase = faseDaLigacao(r);
    const naTransferencia = fase === "transferencia_na_fila";
    return {
      id: r.id,
      fase,
      contato: r.contact_id ? { id: r.contact_id, nome: r.contato_nome } : null,
      numero: r.peer_phone,
      time_id: naTransferencia ? r.transferencia_time_id : r.team_id,
      numero_da_empresa_id: r.channel_session_id,
      conversa_id: r.conversation_id,
      entrou_em: iso(r.started_at)!,
      na_fila_desde: naTransferencia ? iso(r.transferencia_desde) : iso(r.queued_at),
      posicao: null,
      cai_em: fase === "aguardando" ? iso(r.queue_deadline_at) : null,
      tocando_para: fase === "tocando" && r.ringing_user_id ? { id: r.ringing_user_id, nome: r.tocando_nome } : null,
      com: naTransferencia
        ? r.transferida_por
          ? { id: r.transferida_por, nome: r.transferida_por_nome }
          : null
        : fase === "em_ligacao" && r.owner_user_id
          ? { id: r.owner_user_id, nome: r.dono_nome }
          : null,
      atendida_em: iso(r.answered_at),
    };
  });
  const posicoes = posicoesNaFila(ligacoes);
  for (const l of ligacoes) l.posicao = posicoes.get(l.id) ?? null;

  const perdidasQ = await db.query<{
    id: string; peer_phone: string; team_id: string | null; channel_session_id: string;
    conversation_id: string | null; contact_id: string | null; contato_nome: string | null;
    started_at: Date; queued_at: Date | null; ended_at: Date; end_reason: string | null;
    menu_id: string | null; menu_outcome: string | null;
  }>(
    `select v.id, v.peer_phone, v.team_id, v.channel_session_id, v.conversation_id, v.contact_id,
            coalesce(c.display_name, c.name) as contato_nome,
            v.started_at, v.queued_at, v.ended_at, v.end_reason, v.menu_id, v.menu_outcome
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
      where v.organization_id = $1 and v.provider = $2 and v.direction = 'inbound'
        and v.answered_at is null and v.ended_at is not null
        and v.ended_at > now() - interval '${PERDIDAS_DESDE}'
      order by v.ended_at desc
      limit ${MAXIMO_DE_PERDIDAS}`,
    [organizationId, PROVIDER],
  );
  const perdidas: PerdidaRecente[] = perdidasQ.rows.map((r) => ({
    id: r.id,
    contato: r.contact_id ? { id: r.contact_id, nome: r.contato_nome } : null,
    numero: r.peer_phone,
    time_id: r.team_id,
    numero_da_empresa_id: r.channel_session_id,
    conversa_id: r.conversation_id,
    motivo: motivoDaPerdida(r),
    esperou_s: Math.max(
      0,
      Math.round((new Date(r.ended_at).getTime() - new Date(r.queued_at ?? r.started_at).getTime()) / 1000),
    ),
    encerrada_em: iso(r.ended_at)!,
  }));

  return {
    ativa: true,
    agora,
    times: times.rows.map((t) => ({ id: t.id, nome: t.nome, espera_maxima_s: esperaMaximaMs(t.espera) / 1000 })),
    numeros: numeros.rows,
    ligacoes,
    perdidas,
  };
}
```

  (As constantes de intervalo são literais do módulo, nunca entrada do usuário — por isso entram interpoladas.) Confira os nomes das colunas de `contacts` (`display_name`, `name`) e de `voice_call_transfers` no `baseline.sql` antes de rodar.

- [ ] **Step 3: o invariante** `tests/invariants/telefonia-fila-da-tela.test.ts` (molde e semeadura: `telefonia-cartao-em-andamento.test.ts`; ids `c0de0297-…`; DUAS organizações com número e time). Monte na organização A, por SQL direto em `voice_calls` (provider `sip_trunk`): uma no menu (`menu_id` de um `phone_menus` semeado, sem `menu_outcome`), uma nos avisos, duas aguardando (com `queued_at` diferentes e `queue_deadline_at`), uma tocando para a Ana, uma em ligação com o Bruno, uma em ligação com transferência ABERTA para o time 2 (`voice_call_transfers`), uma recebida viva de 5 h atrás, uma FEITA viva, uma do WaCalls viva; e encerradas: perdida há 5 min (`fila_esgotada`), fora do horário há 10 min, desligou no menu há 2 min, perdida há 40 min, atendida há 3 min. Na organização B: uma aguardando e uma perdida. Afirme:
  1. `ativa: true`; fases e ordem das ligações de A; as três que não entram (5 h, feita, WaCalls) não aparecem; nenhuma linha de B aparece em A (e vice-versa).
  2. Posições: 1 e 2 e 3 nas aguardando/tocando do time, pela ordem de `queued_at`; `null` nas outras.
  3. `cai_em` só na `aguardando`; `tocando_para.nome` = nome da Ana; `com.nome` = Bruno; na transferência, `time_id` = time 2 e `com` = quem transferiu.
  4. Perdidas: três (as de 40 min e a atendida ficam de fora), da mais recente para a mais antiga, com os motivos certos e `esperou_s` batendo com os instantes semeados (±1).
  5. `times` com `espera_maxima_s` 120 (sem configuração) e 600 (configurado); time arquivado não aparece.
  6. Organização sem número de telefone: `ativa: false` e listas vazias, mesmo com `voice_calls` de outro provider.
  7. `agora` é o relógio do banco (diferença para `select now()` < 2 s).

- [ ] **Step 4: a rota** `app/api/v1/telefonia/fila/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/fila — a fila do telefone ao vivo (aba Telefone do
 * Inbox; migration 0295): quem espera por ordem de chegada, quem está no menu,
 * em ligação, e as perdidas dos últimos 30 minutos.
 *
 * `viewer`+: todo mundo que entra no Inbox vê a fila de TODOS os times, só com
 * nome, número, time e espera (D4 do desenho) — sem ver a fila do outro setor,
 * ninguém consegue ajudar no pico. Abrir a conversa segue a RLS de sempre.
 *
 * A organização sai da sessão. A leitura é compartilhada por 1,5 s por
 * organização nesta instância: no pico, todo navegador com o Inbox aberto pede
 * ao mesmo tempo (o Realtime avisa todos juntos), e uma leitura serve a todos.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { lerFilaDoTelefone } from "@/lib/channels/telefonia/fila-da-tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { FILA_DESLIGADA, type FilaDoTelefone } from "@/lib/telefonia/fila";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COMPARTILHADA_POR_MS = 1_500;
const leituras = new Map<string, { em: number; promessa: Promise<FilaDoTelefone> }>();

/** A leitura desta organização — a que está em curso (ou acabou de acabar), ou uma nova. */
function lerCompartilhada(org: string, agora: number): Promise<FilaDoTelefone> {
  const atual = leituras.get(org);
  if (atual && agora - atual.em < COMPARTILHADA_POR_MS) return atual.promessa;
  const promessa = lerFilaDoTelefone(getRequestPool(), org);
  leituras.set(org, { em: agora, promessa });
  // A leitura que falhou não fica guardada: o próximo pedido tenta de novo.
  promessa.catch(() => {
    if (leituras.get(org)?.promessa === promessa) leituras.delete(org);
  });
  return promessa;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;

  if (configAriDoAmbiente() === null) {
    return ok({ ...FILA_DESLIGADA, agora: new Date().toISOString() } satisfies FilaDoTelefone, { requestId });
  }
  try {
    return ok(await lerCompartilhada(authz.org.orgId, Date.now()), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não foi possível ler a fila do telefone.", authz.user.idioma), 500, { requestId });
  }
}
```

  `route.test.ts` (molde: `app/api/v1/telefonia/emergencias/route.test.ts` — leia para ver como o arquivo dubla `requireRole`, `getRequestPool` e `configAriDoAmbiente`): (a) sem sessão/sem papel → a resposta do `requireRole` volta intacta; (b) telefonia desligada → 200 com `ativa: false` e o banco NÃO é lido; (c) ligada → chama `lerFilaDoTelefone` com a organização DA SESSÃO; (d) dois pedidos seguidos da mesma organização dentro de 1,5 s = UMA leitura; de organizações diferentes = duas; depois de 1,6 s (relógio falso) = outra; (e) a leitura que falha responde 500 e a seguinte tenta de novo (não fica presa no erro). O `Map` é do módulo: use `vi.resetModules()` + import dinâmico por caso, ou relógio falso avançando além da janela entre os casos.

- [ ] **Step 5:** `pnpm exec vitest run lib/telefonia/fila.test.ts app/api/v1/telefonia/fila` → PASS; `pnpm test:db tests/invariants/telefonia-fila-da-tela.test.ts` → PASS; `pnpm exec vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/admin-client-exige-filtro-de-tenant.test.ts tests/unit/ligacao-nunca-chama-elevenlabs.test.ts tests/unit/telefonia-troca-de-marcador-literal.test.ts` → PASS (a frase de erro nova precisa de `es` no dicionário: `"Não foi possível ler a fila do telefone.": { es: "No se pudo leer la cola del teléfono." }`); `pnpm typecheck`.
- [ ] **Step 6: commit:** `feat(telefonia): a rota que lê a fila do telefone ao vivo`

---

### Task 6: a espera máxima do time — rotas e seletor em Configurações › Times

**Files:** `lib/telefonia/espera-do-time.ts`, `app/api/v1/telefonia/fila/times/route.ts`, `app/api/v1/telefonia/fila/times/[teamId]/route.ts` (+ testes), `lib/audit/actions.ts`, `components/telefonia/useEsperaDosTimes.ts`, `components/telefonia/EsperaMaximaDoTime.tsx` (+ teste), `app/app/settings/teams/_client.tsx`, `lib/i18n/dicionario.ts`, e um invariante novo `tests/invariants/telefonia-espera-do-time.test.ts`.

- [ ] **Step 1: `lib/telefonia/espera-do-time.ts`**

```ts
/**
 * A ESPERA MÁXIMA NA FILA DO TELEFONE, por time (migration 0295) — ler e gravar
 * `attendance_teams.phone_queue_max_wait_seconds`. Server-only. A tabela só tem
 * GRANT de leitura para `authenticated`: quem grava é a rota, pela conexão do
 * app, com a organização DA SESSÃO em toda consulta.
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { ESPERA_NA_FILA_MAX_S, ESPERA_NA_FILA_MIN_S, esperaMaximaMs } from "./distribuicao";

export const esperaDoTimeSchema = z
  .object({
    /** Segundos; `null` volta ao padrão. */
    espera_maxima_s: z.number().int().min(ESPERA_NA_FILA_MIN_S).max(ESPERA_NA_FILA_MAX_S).nullable(),
  })
  .strict();

export interface EsperaDoTime {
  team_id: string;
  /** O que está gravado; `null` = o padrão. */
  espera_maxima_s: number | null;
  /** O que VALE (o gravado, ou o padrão). */
  em_vigor_s: number;
}

const paraATela = (r: { id: string; espera: number | null }): EsperaDoTime => ({
  team_id: r.id,
  espera_maxima_s: r.espera,
  em_vigor_s: esperaMaximaMs(r.espera) / 1000,
});

/** Os times ATIVOS da organização, com a espera de cada um. */
export async function lerEsperaDosTimes(db: Queryable, organizationId: string): Promise<EsperaDoTime[]> {
  const { rows } = await db.query<{ id: string; espera: number | null }>(
    `select id, phone_queue_max_wait_seconds as espera
       from attendance_teams
      where organization_id = $1 and archived_at is null
      order by name asc`,
    [organizationId],
  );
  return rows.map(paraATela);
}

export type ResultadoDaEspera =
  | { ok: true; time: EsperaDoTime; anterior: number | null }
  | { ok: false; motivo: "nao_encontrado" | "time_arquivado" };

/** Grava a espera do time DESTA organização. Time de outra organização: `nao_encontrado`. */
export async function gravarEsperaDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  segundos: number | null,
): Promise<ResultadoDaEspera> {
  const { rows } = await db.query<{ id: string; espera: number | null; anterior: number | null; arquivado: boolean }>(
    `with antes as (
       select id, phone_queue_max_wait_seconds as anterior, archived_at is not null as arquivado
         from attendance_teams
        where id = $1 and organization_id = $2
        for no key update
     ), gravado as (
       update attendance_teams t
          set phone_queue_max_wait_seconds = $3, updated_at = now()
         from antes
        where t.id = antes.id and t.organization_id = $2 and not antes.arquivado
       returning t.id, t.phone_queue_max_wait_seconds as espera
     )
     select antes.id, gravado.espera, antes.anterior, antes.arquivado
       from antes left join gravado on gravado.id = antes.id`,
    [teamId, organizationId, segundos],
  );
  const r = rows[0];
  if (!r) return { ok: false, motivo: "nao_encontrado" };
  if (r.arquivado) return { ok: false, motivo: "time_arquivado" };
  return { ok: true, time: paraATela({ id: r.id, espera: r.espera }), anterior: r.anterior };
}
```

  O invariante `tests/invariants/telefonia-espera-do-time.test.ts` (molde e semeadura: `telefonia-cartao-em-andamento.test.ts`, ids `c0de0298-…`, duas organizações): grava 600 e devolve `anterior: null`, `em_vigor_s: 600`; grava `null` e devolve `anterior: 600`, `em_vigor_s: 120`; time de OUTRA organização → `nao_encontrado` e a linha dela não muda; time arquivado → `time_arquivado` e não muda; `lerEsperaDosTimes` só devolve os times ativos da organização pedida. Se o `for no key update` dentro do CTE não for aceito pelo Postgres, faça em duas consultas dentro de uma transação e relate.

- [ ] **Step 2: auditoria.** Em `lib/audit/actions.ts`, acrescentar `"phone.queue_wait_changed",` como ÚLTIMA entrada de `AUDIT_ACTIONS` (o arquivo não pode ganhar import). Rode `pnpm exec vitest run tests/unit/audit-lista-do-painel-e-derivada.test.tsx`.

- [ ] **Step 3: as rotas.**
  - `GET /api/v1/telefonia/fila/times` — `requireRole("manager", { requestId, resource: "telefonia_fila" })`; telefonia desligada → `ok({ oferecida: false, times: [] })`; ligada → `ok({ oferecida: true, times: await lerEsperaDosTimes(getRequestPool(), authz.org.orgId) })`.
  - `PUT /api/v1/telefonia/fila/times/[teamId]` — na ordem do modelo (`app/api/v1/telefonia/emergencias/[teamId]/route.ts`, leia-o): `requireSupportWrite()` → `requireRole("manager", { requestId, resource: "telefonia_fila" })` → telefonia desligada: `fail("telefonia_nao_oferecida", t("O telefone não está ligado nesta instalação."), 409)` → `teamId` uuid (senão 404 `not_found`, `t("Time não encontrado.")`) → corpo por `esperaDoTimeSchema` (senão 422 `validation_failed`, `t("Escolha uma espera entre 30 segundos e 30 minutos.")`) → `gravarEsperaDoTime` → `nao_encontrado`: 404; `time_arquivado`: 409 com `t("Este time está arquivado.")` → `void audit({ action: "phone.queue_wait_changed", actorUserId, organizationId, resourceType: "attendance_team", resourceId: teamId, metadata: { de: r.anterior, para: corpo.espera_maxima_s }, requestId })` → `ok({ time: r.time })`.
  - Testes das duas rotas (molde: `app/api/v1/telefonia/emergencias/[teamId]/route.test.ts`): papel abaixo de manager barrado; suporte somente-leitura barrado no PUT; organização da sessão é a que chega ao `gravarEsperaDoTime` (o corpo não consegue trocá-la — mande um `organization_id` no corpo e afirme 422 pelo `.strict()`); cada recusa com o status certo; auditoria emitida só no sucesso, com `de`/`para`.

- [ ] **Step 4: a tela.**
  - `components/telefonia/useEsperaDosTimes.ts`: `useEsperaDosTimes()` (`useQuery`, chave `["telefonia", "espera-dos-times"]`, `GET`, `staleTime: 30_000`) e `useGravarEspera()` (`useMutation` com `PUT`, `toast.success(t("Espera máxima do telefone salva."))`, erro por `showApiError`, invalida a chave). Molde: `components/telefonia/useAvisosDeInstabilidade.ts`.
  - `components/telefonia/EsperaMaximaDoTime.tsx` — `({ teamId }: { teamId: string })`: um `Card` (`p-4`, `data-espera-da-fila={teamId}`) com o título `t("Fila do telefone")`, a frase `t("Quanto tempo um cliente espera na fila do telefone deste time quando ninguém está livre. Depois disso a ligação cai e vira \"Ligar de volta\" na Central.")` e um `Select` (shadcn, como o de `AvisoDeInstabilidadeDoTime`) com `OPCOES_DE_ESPERA_NA_FILA_S` rotuladas `trocarMarcador(t("{n} minutos"), "{n}", String(s / 60))`, a primeira com o sufixo ` — ${t("padrão")}`. O valor mostrado é `em_vigor_s`. Trocar o valor grava na hora (o padrão grava `null`). Não renderiza nada se `!dados?.oferecida` ou se o time não está na lista; erro de leitura sem dado → `t("Não foi possível carregar a espera da fila do telefone. Recarregue a página.")`. Um valor em vigor que não está entre as opções (gravado por outro caminho) aparece como opção extra `trocarMarcador(t("{n} segundos"), "{n}", String(valor))`.
  - `app/app/settings/teams/_client.tsx`: `<EsperaMaximaDoTime teamId={x.id} />` logo depois de `<AvisoDeInstabilidadeDoTime teamId={x.id} />`, com o comentário `{/* A espera máxima na fila do telefone também é do TIME (migration 0295). */}`.
  - Teste do componente (molde: `components/telefonia/AvisoDeInstabilidadeDoTime.test.tsx`): mostra o valor em vigor; trocar para 10 minutos chama o `PUT` com `{ espera_maxima_s: 600 }`; escolher o padrão manda `null`; telefonia não oferecida → nada na tela.
  - Chaves novas no dicionário, todas com `es`.

- [ ] **Step 5:** os testes desta task + `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`, `tests/unit/suporte-cobertura-de-efeitos.test.ts`, `tests/unit/controle-decorativo.test.ts`, `tests/unit/telefonia-troca-de-marcador-literal.test.ts` → PASS; o invariante → PASS; `pnpm typecheck && pnpm exec eslint <arquivos da task>`.
- [ ] **Step 6: commit:** `feat(telefonia): a espera máxima na fila do telefone é do time, em Configurações › Times`

---

### Task 7: a aba Telefone no Inbox

**Files:** `hooks/telefonia/useFilaDoTelefone.ts`, `components/telefonia/fila/{FilaDoTelefone,LinhaDaFila,ChipsDaFila}.tsx` (+ testes), `lib/inbox/abas.ts`, `components/inbox/InboxAbas.tsx`, `components/inbox/InboxLayout.tsx`, `components/inbox/ChipsDosTimes.tsx`, `lib/i18n/dicionario.ts`, e os testes que dublam módulos do Inbox.

- [ ] **Step 1: `lib/inbox/abas.ts`.** `InboxTab` ganha `"phone"`; `INBOX_TABS` ganha, no fim, `{ value: "phone", label: "Telefone" }` (com o comentário: a aba não lista conversas, lista LIGAÇÕES; só existe com telefonia). `visibleInboxTabs` ganha um terceiro parâmetro:

```ts
export function visibleInboxTabs(
  role: Role,
  mode: VisibilityMode | undefined,
  opcoes: { telefone?: boolean } = {},
): InboxTab[] {
  const hideAll = role === "agent" && mode !== "all" && mode !== "own_and_team";
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll))
    .filter((t) => t.value !== "phone" || opcoes.telefone === true)
    .map((t) => t.value);
}
```

  Teste (acrescentar onde `visibleInboxTabs` já é testado — `tests/unit/inbox-filters-scope.test.tsx`): sem `telefone`, nenhum papel vê `phone`; com `telefone: true`, `viewer`, `agent`, `manager` e `admin` veem.

- [ ] **Step 2: o hook** `hooks/telefonia/useFilaDoTelefone.ts`:

```ts
"use client";
/**
 * A FILA DO TELEFONE NA TELA (aba Telefone; migration 0295). Chamado UMA vez,
 * no `InboxLayout`; o resultado desce por props para o trilho (o selo) e para
 * a coluna da aba — duas chamadas seriam duas assinaturas do Realtime.
 *
 * Quem entrega a mudança é o Realtime de `voice_calls` (a tabela já está na
 * publicação), passando por um juntador: cada toque do worker escreve na
 * tabela, e uma rajada vira UMA releitura. A releitura a cada 15 s é a rede de
 * segurança do canal que assina e não entrega; sem telefonia na organização
 * (`ativa: false`) nada é relido nem assinado.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { criarJuntador } from "@/lib/realtime/juntar-avisos";
import type { FilaDoTelefone } from "@/lib/telefonia/fila";

export const CHAVE_DA_FILA_DO_TELEFONE = ["telefonia", "fila"] as const;
export const RELEITURA_DE_SEGURANCA_MS = 15_000;
const ESPERA_DO_JUNTADOR_MS = 400;
const INTERVALO_MINIMO_MS = 2_000;

/** A fila, mais a defasagem entre o relógio do banco e o deste navegador (ms; somar a `Date.now()`). */
export type FilaComRelogio = FilaDoTelefone & { defasagemMs: number };

const recusada = (erro: unknown) => erro instanceof ApiError && (erro.status === 401 || erro.status === 403);

export function useFilaDoTelefone() {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  const qc = useQueryClient();

  const consulta = useQuery({
    queryKey: [...CHAVE_DA_FILA_DO_TELEFONE, orgId],
    enabled: orgId !== null,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (recusada(q.state.error) || q.state.data?.ativa === false ? false : RELEITURA_DE_SEGURANCA_MS),
    queryFn: async (): Promise<FilaComRelogio> => {
      const r = await apiClient.get<{ data: FilaDoTelefone }>("/api/v1/telefonia/fila");
      return { ...r.data, defasagemMs: new Date(r.data.agora).getTime() - Date.now() };
    },
  });

  const juntador = useMemo(
    () =>
      criarJuntador({
        esperaMs: ESPERA_DO_JUNTADOR_MS,
        intervaloMinimoMs: INTERVALO_MINIMO_MS,
        agir: () => void qc.invalidateQueries({ queryKey: CHAVE_DA_FILA_DO_TELEFONE }),
      }),
    [qc],
  );
  useEffect(() => () => juntador.cancelar(), [juntador]);

  const ativa = consulta.data?.ativa === true;
  useRealtimeChannel({
    name: orgId && ativa ? `telefonia-fila-${orgId}` : "telefonia-fila-desligada",
    postgresChanges:
      orgId && ativa ? { event: "*", schema: "public", table: "voice_calls", filter: `organization_id=eq.${orgId}` } : undefined,
    onChange: () => juntador.avisar(),
    enabled: Boolean(orgId) && ativa,
  });

  return consulta;
}
```

  Confira o caminho de `ApiError` (`@/lib/api/types`) e a assinatura de `useRealtimeChannel` no arquivo antes de fechar.

- [ ] **Step 3: os componentes.**
  - `components/inbox/ChipsDosTimes.tsx`: exportar as três constantes de classe (`CHIP`, `CHIP_LIGADO`, `CHIP_DESLIGADO`) — só o `export`.
  - `components/telefonia/fila/ChipsDaFila.tsx` — props `{ times: FilaDoTelefone["times"]; ligacoes: LigacaoNaFila[]; agoraMs: number; timeEscolhido?: string; onEscolherTime(id: string | undefined): void }`. Contêiner `flex flex-wrap gap-1 border-b border-border px-3 py-1.5`, `data-testid="chips-da-fila"`. Um chip "Todos" com o total de `quantasEsperam`; um chip por time que tem alguém esperando (ou é o escolhido), ordenados por quantos esperam (desc) e nome; cada chip: nome (`max-w-32 truncate`), o número, e — se há espera — `relogio(maisAntigaMs)` da mais antiga. `aria-pressed`, `data-team-id`. Sem ninguém esperando em time nenhum (e nenhum escolhido), o contêiner não é desenhado.
  - `components/telefonia/fila/LinhaDaFila.tsx` — uma ligação viva. Props `{ ligacao: LigacaoNaFila; nomeDoTime: string | null; numeroDaEmpresa: string | null; tetoS: number | null; agoraMs: number; selecionada: boolean; onAbrir?: () => void }`. É um `<button type="button">` quando há `onAbrir` (clicar abre a conversa) e um `<div>` quando não há; `data-ligacao-id`, `data-fase`. Classes do contêiner iguais às de `ConversationListItem` (`group relative flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated`, selecionada: `bg-accent-50`). Conteúdo:
    - à esquerda, a posição (`{n}º`, no selo `inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-medium tabular-nums text-accent`) quando `posicao !== null`; senão um ícone de telefone discreto (`Phone` de `@/lib/ui/icons`, `size={14}`, `text-text-subtle`);
    - 1ª linha: o nome do contato (`truncate text-sm font-medium text-text`) ou, sem nome, o número formatado por `phoneForDisplay` (o mesmo import de `components/telefonia/PainelDoTelefone.tsx`); com nome, o número vai na 2ª linha;
    - 2ª linha (`text-[11px] text-text-muted`): time · `t("pelo")` número da empresa (formatado);
    - 3ª linha — o estado, por fase:
      - `aguardando`: `${t("Aguardando há")} ${relogio(agora - na_fila_desde)}` e, com `cai_em` no futuro, ` · ${t("cai em")} ${relogio(cai_em - agora)}`; cor por `urgenciaDaEspera`: normal `text-text-muted`, atenção `rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg`, crítico `rounded-full bg-error px-1.5 py-0.5 text-bg`; `data-urgencia`;
      - `tocando`: `${t("Tocando para")} ${nome ?? t("alguém")}` · `${t("na fila há")} ${relogio(…)}`;
      - `menu`: `${t("Ouvindo as opções")} · ${relogio(agora - entrou_em)}`;
      - `avisos`: `${t("Ouvindo os avisos")} · ${relogio(…)}`;
      - `em_ligacao`: `${t("Com")} ${nome ?? t("alguém")} ${t("há")} ${relogio(agora - atendida_em)}`;
      - `transferencia_na_fila`: `${t("Transferida por")} ${nome ?? t("alguém")} · ${t("aguardando há")} ${relogio(…)}`.
  - `components/telefonia/fila/FilaDoTelefone.tsx` — a coluna. Props `{ consulta: Pick<UseQueryResult<FilaComRelogio>, "data" | "isPending" | "isError" | "refetch">; selectedId: string | null; onSelect(id: string): void }`.
    - relógio da tela: `const [, setTique] = useState(0)` + `useEffect` com `setInterval(() => setTique((n) => n + 1), 1_000)`; `agoraMs = Date.now() + (data?.defasagemMs ?? 0)` calculado no render (o tique só força o redesenho);
    - estado local: `timeEscolhido`, `numeroEscolhido`;
    - sem dado e carregando: um esqueleto curto (`data-testid="fila-do-telefone-carregando"`); erro sem dado: `role="alert"` com `t("Não foi possível ler a fila do telefone.")` e o botão `t("Tentar novamente")`; `ativa === false`: `t("O telefone não está ligado nesta organização.")`;
    - cabeçalho: `<ChipsDaFila …/>` e, com mais de um número, um `Select` "Todos os números" / cada número (`data-testid="fila-numero"`);
    - corpo rolável (`h-full overflow-y-auto`, `data-testid="fila-do-telefone"`), com seções — cada uma só aparece se tiver linha — com o título `px-3 pt-3 pb-1 text-[11px] font-medium text-text-subtle`:
      1. `t("Na fila, por ordem de chegada")` (`data-secao="na-fila"`): fases `aguardando`, `tocando` e `transferencia_na_fila`, por `na_fila_desde` crescente (a mais antiga em cima), que é a ordem em que a rota já entrega;
      2. `t("No menu")` (`data-secao="no-menu"`): `menu` e `avisos`;
      3. `t("Em ligação")` (`data-secao="em-ligacao"`);
      4. `t("Perdidas nos últimos 30 minutos")` (`data-secao="perdidas"`): cada perdida numa linha própria (componente interno `LinhaDaPerdida`): nome/número, time, o motivo (`t` de uma tabela `const MOTIVO: Record<MotivoDaPerdida, string>` no topo do MESMO arquivo — "Desligou no menu", "Desistiu na fila", "A fila esgotou", "Ninguém atendeu", "Fora do horário", "Interrompida", "Não atendida"), `${t("esperou")} ${relogio(esperou_s * 1000)}`, e há quanto tempo: `${t("há")} ${minutos} min` (minutos = `Math.max(0, Math.floor((agoraMs - encerrada_em) / 60_000))`; com 0, `t("agora há pouco")`); à direita, `<BotaoLigar contatoId nome temTelefone variante="icone" />` quando há contato (o botão já some sozinho para quem não tem ramal);
    - tudo vazio (nenhuma ligação e nenhuma perdida): `t("Nenhuma ligação agora.")`, centralizado, `text-sm text-text-muted`;
    - os filtros de time e de número valem para as quatro seções.
  - Testes (`FilaDoTelefone.test.tsx`, `LinhaDaFila.test.tsx`), com `vi.useFakeTimers()` e um dado fixo: as quatro seções com as linhas certas; o filtro por time e por número; a contagem regressiva muda depois de `advanceTimersByTime(1_000)`; a urgência `critico` quando falta menos de 20% do teto; clicar numa linha com conversa chama `onSelect(conversa_id)`; linha sem conversa não é botão; `ativa: false`; erro com "Tentar novamente" chamando `refetch`; vazio. Dublar `@/components/telefonia/BotaoLigar` como os testes do Inbox fazem.

- [ ] **Step 4: `InboxAbas`.** Props ganham `telefone?: { ativa: boolean; esperando: number }`. `ICONE_DA_ABA.phone = Phone` (confira o export em `@/lib/ui/icons`; se o nome for outro, use o que `PainelDoTelefone` importa); `ABAS_QUE_COBRAM` ganha `"phone"`; `tabs = visibleInboxTabs(role, mode, { telefone: telefone?.ativa })` (e, sem `activeOrg`, `INBOX_TABS` sem `phone`); `countFor.phone = telefone?.esperando`.

- [ ] **Step 5: `InboxLayout`.**
  - `const filaDoTelefoneQ = useFilaDoTelefone();` (uma vez);
  - `tabToFilter`: `case "phone": return { assigned_to: "me", exclude_finished: true };` com o comentário: a aba Telefone não lista conversas; a consulta de fundo é a mais barata (as minhas) e mantém a assinatura da lista viva para as outras abas;
  - `FILTER_TABS` ganha `"phone"`;
  - `<InboxAbas … telefone={{ ativa: filaDoTelefoneQ.data?.ativa === true, esperando: quantasEsperam(filaDoTelefoneQ.data?.ligacoes ?? []) }} />`;
  - na coluna da lista: com `tab === "phone"`, NÃO renderizar `InboxFilters`, `ResultadosPorProtocolo` nem `ChipsDosTimes`, e no lugar de `ConversationList` renderizar `<FilaDoTelefone consulta={filaDoTelefoneQ} selectedId={selectedId} onSelect={handleSelect} />`; ao entrar na aba, zerar a lista de ids visíveis dos atalhos de teclado (`handleVisibleChange([])` num `useEffect` que depende de `tab`).
  - Testes a atualizar: `tests/unit/inbox-aba-minhas-sem-fechadas.test.ts` (o retorno de `tabToFilter("phone")`); os que montam o `InboxLayout` com dublês (`components/inbox/InboxLayout.altura.test.tsx`, `InboxLayout.encerrada.test.tsx`, `tests/unit/deep-link-nao-espera-a-lista.test.tsx`) precisam dublar `@/hooks/telefonia/useFilaDoTelefone` (`vi.mock(…, () => ({ useFilaDoTelefone: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }) }))`); `tests/unit/inbox-filters-scope.test.tsx` ganha: com `telefone={{ ativa: true, esperando: 3 }}` o trilho mostra a aba "Telefone" com o selo 3; sem a prop, não mostra.
  - Teste novo `components/inbox/InboxLayout.telefone.test.tsx` (molde: `InboxLayout.altura.test.tsx`): com `?filter=phone` e o hook dublado devolvendo uma fila com uma ligação aguardando, a coluna mostra `data-testid="fila-do-telefone"`, o título "Telefone", e NÃO mostra a lista de conversas nem os filtros.

- [ ] **Step 6:** `pnpm exec vitest run components/inbox components/telefonia hooks lib/inbox tests/unit/inbox-filters-scope.test.tsx tests/unit/inbox-aba-minhas-sem-fechadas.test.ts tests/unit/deep-link-nao-espera-a-lista.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/i18n-a-data-segue-o-idioma.test.ts tests/unit/hidratacao-useState-nao-le-o-navegador.test.ts tests/unit/controle-decorativo.test.ts tests/unit/realtime-assinatura-tem-publicacao.test.ts tests/unit/fila-tem-uma-definicao-so.test.ts tests/unit/telefonia-troca-de-marcador-literal.test.ts tests/unit/tailwind-tokens.test.ts` → PASS; `pnpm typecheck && pnpm exec eslint <arquivos da task>`.
- [ ] **Step 7: commit:** `feat(inbox): a aba Telefone mostra a fila de ligações ao vivo`

---

### Task 8: a prova pela tela (e2e semeado), documentação e fragmento

- [ ] **e2e** `tests/e2e/telefonia-fila.spec.ts` (molde: `tests/e2e/telefonia-gravacao.spec.ts` — os helpers `sql`, `criarUsuario`, `entrar`, a marca `E2E_TELEFONIA` e a semeadura do número): semeia um time com `phone_queue_max_wait_seconds = 600`, e ligações `voice_calls` nas fases aguardando (duas, com `queued_at` diferentes e `queue_deadline_at` no futuro), tocando, em ligação e uma perdida há 5 min; entra como `agent`, abre `/app/inbox`, afirma o selo do trilho (3), clica na aba "Telefone", afirma as seções, a ordem (a mais antiga é a 1ª), o "cai em", e que clicar na linha abre a conversa à direita; depois, SEM recarregar, encerra por SQL a primeira da fila e afirma (`timeout: 20_000`) que ela sai de "Na fila" e a segunda vira a 1ª. Um segundo caso entra como `manager`, vai a Configurações › Times, troca a espera para 5 minutos e confere no banco. Registrar a spec em `SPECS_PARTE_3` de `.github/workflows/e2e.yml` (vigiado por `tests/unit/e2e-cobertura-completa.test.ts` e `tests/unit/e2e-telefonia-so-na-parte-3.test.ts` — rode os dois).
- [ ] **Fragmento** `.changes/telefonia-aba-da-fila.md` (`impacto: capacidade_nova`, `secao: adicionado`, `titulo: Telefone — a fila de ligações aparece no Inbox`): o que a aba mostra; a ordem de chegada; a espera máxima por time em Configurações › Times (padrão 2 minutos, nada muda para quem não mexer); "Nada a fazer na atualização. Quem está com o CRM aberto precisa recarregar a página para ver a aba."
- [ ] **Docs:** spec 20 (a fila visível: colunas, rota, aba, teto; a linha da fase), `docs/current-state.md`, `docs/architecture/telefonia.architecture.json` (nós novos `rota_fila` e `aba_telefone`, cada um com ≥2 arestas reais; rode `tests/unit/mapas-de-arquitetura.test.ts`), `docs/testing/user-journey-map.md` (J44, no molde da J43), e as emendas deste plano no desenho (§4.2).
- [ ] Commits separados: `test(e2e): …`, `docs(telefonia): …`.

---

### Task 9: verificação completa, revisão independente e PR

- [ ] `pnpm typecheck && pnpm lint`; `pnpm test:unit > /tmp/vt-entrega2.log 2>&1; echo "exit=$?"` + as três linhas do rodapé + o `grep FAIL`; `pnpm test:db` dos invariantes novos e dos vizinhos de telefonia.
- [ ] Revisão independente (subagente sem contexto), com o foco: o worker (ordem de chegada e teto) não pode atrasar nem derrubar ligação; a rota não vaza organização; a carga da rota no pico; a aba não quebra as outras.
- [ ] Push, `gh workflow run e2e.yml --ref <branch>`, PR com MEDIDO e NÃO MEDIDO (ligação real; capacidade de áudio da instalação; a carga com a fila cheia).
