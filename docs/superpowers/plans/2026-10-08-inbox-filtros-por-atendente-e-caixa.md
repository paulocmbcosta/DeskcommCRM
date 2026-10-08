# Inbox · filtros por atendente, caixa de entrada, período e assunto, com filtros no endereço — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** quem usa o Inbox filtra as conversas por atendente e por caixa de entrada em qualquer aba, filtra as Fechadas por período e por assunto, e os filtros sobrevivem a recarregar a página porque moram no endereço.

**Architecture:** três módulos puros no cliente decidem tudo o que é regra — `filtros-na-url` (ler e escrever o endereço), `periodo` (dia local → instantes) e `filtros-de-tela` (em que aba cada filtro vale, o que vai para cada rota, que nomes o vazio cita). No servidor, os predicados dos atendimentos encerrados saem para uma função única usada pela lista e pela contagem, e uma rota de leitura nova (`GET /api/v1/conversations/filtros`) entrega as opções dos seletores. Dois índices cobrem os caminhos novos.

**Tech Stack:** Next.js 16 Route Handlers, Supabase (PostgREST sob RLS, client do usuário), Zod 4, React 19 + TanStack Query, Vitest, Playwright (só no GitHub Actions), Postgres (migration + apêndice do `baseline.sql`).

Desenho: `docs/superpowers/specs/2026-10-08-inbox-filtros-por-atendente-e-caixa-design.md`. Tarefa: CU-124b4z9rjvg.

---

## Emendas ao desenho (com o porquê)

1. **O seletor de atendente aparece para todos em Todas e Fechadas; o que muda é a lista de nomes.** O desenho escondia o seletor de quem não vê colegas. Só que "Eu" e "Sem atendente" servem também a esse atendente (no modo padrão ele vê as próprias e as sem dono), e esconder o seletor deixaria o selo do funil contando um filtro que o funil não mostra. Quem não vê colegas recebe `atendentes: []` do servidor — a decisão é da rota, não da tela.
2. **O isolamento entre organizações da rota nova é provado em teste de unidade**, não em invariante: a suíte `tests/invariants/` fala com o Postgres, não com rotas HTTP. O teste afirma que cada leitura da rota leva o `organization_id` da sessão.
3. **As contagens recebem todos os filtros ligados, e o servidor decide a que contagem cada um se aplica.** O selo de uma aba tem de dizer o que a lista mostrará ao clicar nela; se a tela mandasse só os filtros da aba atual, o selo de Fechadas ignoraria o período enquanto a pessoa estivesse em Todas.
4. **Uma chamada de contagem só.** `InboxAbas` passa a receber as contagens por prop, do mesmo jeito que já recebe a fila do telefone, em vez de chamar o hook com parâmetros próprios.
5. **"Escolher datas…" nasce com hoje nos dois campos.** Não existe estado intermediário com uma data só: mexer em `de` para depois de `ate` puxa `ate` junto, e o contrário.
6. **Prova em tela.** O dono não roda Supabase local nem Playwright na máquina dele (decisão de 2026-09-29). A prova em tela é o teste de ponta a ponta no GitHub Actions, com capturas, e a prova real é na produção depois de publicado.

## Regras do repositório que valem para todas as tasks

- Node 22: `source ~/.nvm/nvm.sh && nvm use 22.23.2` antes de qualquer `pnpm`. zsh: aspas em volta de qualquer glob.
- A worktree nasce sem `node_modules`: `pnpm install --frozen-lockfile --prefer-offline`.
- Nunca `console.log`. Comentários em português, no tom dos vizinhos (dizem o porquê).
- Texto de tela: `t("…")` com a chave em português, e a chave em `lib/i18n/dicionario.ts`.
- Feature não nomeia provider: pergunta o meio por `meioDoCanal` (`pnpm lint:channels`).
- A suíte que vale é `pnpm test:unit` sem caminho, com a saída em arquivo:

  ```bash
  pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
  grep -aE "Test Files|Tests |^ *Errors " /tmp/vt.log | tail -3
  ```

- Commits pequenos, um por task, com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Mapa de arquivos

| Arquivo | Papel |
|---|---|
| `lib/schemas/messaging.ts` | modifica: `channel` na lista; peças compartilhadas (`filtroDeAtendenteSchema`, `filtroDeMeioSchema`, `instanteSchema`) |
| `app/api/v1/conversations/route.ts`, `_handler.ts` | modifica: lê e aplica `channel` |
| `app/api/v1/atendimentos/_handler.ts`, `route.ts` | modifica: cinco filtros novos; `aplicarFiltrosDosFechados` |
| `app/api/v1/conversations/counts/route.ts` | modifica: filtros novos pelo schema; usa `aplicarFiltrosDosFechados` |
| `app/api/v1/conversations/filtros/route.ts`, `_handler.ts` | cria: opções dos seletores |
| `lib/inbox/opcoes-dos-filtros.ts` | cria: tipos da resposta (puros, importáveis pela tela) |
| `lib/inbox/abas.ts` | modifica: `podeVerColegas` |
| `lib/inbox/periodo.ts` | cria: `resolverPeriodo`, `dataValida` |
| `lib/inbox/filtros-de-tela.ts` | cria: `FiltrosDeTela`, `ONDE_VALE`, `filtrosAplicados`, `paraConversas`, `paraFechados`, `paraContagens`, `nomesDosFiltros`, `contarFiltrosDoFunil` |
| `lib/inbox/filtros-na-url.ts` | cria: `lerFiltrosDaUrl`, `escreverFiltrosNaUrl` |
| `lib/inbox/filtros-ativos.ts` | remove (substituído por `nomesDosFiltros`) |
| `hooks/inbox/useConversationsRealtime.ts`, `useAtendimentosFechados.ts`, `useConversationCounts.ts` | modifica: serializam os filtros novos |
| `hooks/inbox/useOpcoesDosFiltros.ts` | cria |
| `components/inbox/InboxLayout.tsx` | modifica: estado no endereço; uma régua para lista, fechados, contagens e vazio |
| `components/inbox/InboxFilters.tsx` | modifica: seletores de atendente, caixa, período e assunto |
| `components/inbox/InboxAbas.tsx` | modifica: contagens por prop |
| `components/inbox/SoAsMinhas.tsx` | cria: o botão da linha do título de Fechadas |
| `components/inbox/ConversationList.tsx`, `AtendimentosFechadosList.tsx` | modifica: nomes dos filtros por prop |
| `lib/i18n/dicionario.ts` | modifica: frases novas |
| `supabase/migrations/20261008120000_0297_inbox_filtros_indices.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md` | cria/modifica: dois índices |
| `tests/e2e/inbox-filtros-por-atendente-e-caixa.spec.ts`, `.github/workflows/e2e.yml` | cria/modifica |
| `docs/architecture/inbox-fila-e-termometro.architecture.json`, `docs/testing/user-journey-map.md`, `.changes/` | modifica |

---

### Task 0: Ambiente

- [ ] **Passo 1: dependências**

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2
pnpm install --frozen-lockfile --prefer-offline
```

- [ ] **Passo 2: linha de base — o que já está vermelho antes de eu tocar em algo**

```bash
pnpm typecheck > /tmp/tc0.log 2>&1; echo "typecheck exit=$?"
pnpm test:unit > /tmp/vt0.log 2>&1; echo "unit exit=$?"
grep -aE "Test Files|Tests |^ *Errors " /tmp/vt0.log | tail -3
```

Esperado: exit 0 nos dois. Qualquer vermelho aqui é anotado com o nome do arquivo e conferido contra as notas de "vermelhos locais" antes de seguir.

---

### Task 1: `channel` na lista de conversas

**Files:** `lib/schemas/messaging.ts`, `app/api/v1/conversations/route.ts`, `app/api/v1/conversations/_handler.ts`, `lib/schemas/messaging.test.ts`, `tests/unit/inbox-filtro-de-meio.test.ts` (novo)

- [ ] **Passo 1: o teste que falha.** `tests/unit/inbox-filtro-de-meio.test.ts`, no molde de `tests/unit/inbox-filtro-de-tag.test.ts` (mesmo dublê de Supabase que registra a cadeia):
  - `channel=phone` produz `.eq("channel", "phone")` na consulta;
  - sem `channel`, nenhum `.eq("channel", …)`;
  - `channel=fax` é recusado pelo schema.

  E em `lib/schemas/messaging.test.ts`: `listConversationsQuerySchema.parse({ channel: "site_chat" }).channel === "site_chat"`.

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm vitest run tests/unit/inbox-filtro-de-meio.test.ts lib/schemas/messaging.test.ts
```

- [ ] **Passo 3: o schema.** Em `lib/schemas/messaging.ts`, acima de `listConversationsQuerySchema`:

```ts
/**
 * O ATENDENTE como filtro: `me`, `unassigned` ou o id de um usuário. Mora fora
 * do objeto porque três rotas aplicam a MESMA régua — a lista de conversas, a
 * lista dos atendimentos encerrados e a contagem das abas.
 */
export const filtroDeAtendenteSchema = z.union([
  z.string().uuid(),
  z.literal("me"),
  z.literal("unassigned"),
]);

/** O MEIO da conversa (`conversations.channel`) — nunca o provider. */
export const filtroDeMeioSchema = z.enum(MEIOS_DE_CANAL);

/** Um instante ISO-8601 com fuso (`Z` ou `-03:00`), para os recortes de data. */
export const instanteSchema = z.string().datetime({ offset: true });
```

  `MEIOS_DE_CANAL` vem de `@/lib/channels/capabilities`. No objeto, `assigned_to` passa a ser `filtroDeAtendenteSchema.optional()` e entra, logo abaixo de `channel_session_id`:

```ts
  /**
   * O MEIO: só WhatsApp, só telefone, só chat do site. É o mesmo valor de
   * `conversations.channel`. Pergunta diferente de `channel_session_id`, que é
   * UM número: o meio alcança também a conversa de número já removido.
   */
  channel: filtroDeMeioSchema.optional(),
```

- [ ] **Passo 4: a rota lê.** Em `app/api/v1/conversations/route.ts`, junto de `channel_session_id`:

```ts
    channel: url.searchParams.get("channel") ?? undefined,
```

  (A cerca `rota-le-todo-filtro-do-schema.test.ts` reprova a falta desta linha a partir do passo 3.)

- [ ] **Passo 5: o handler aplica.** Em `_handler.ts`, depois da linha do `channel_session_id`:

```ts
  if (q.channel) query = query.eq("channel", q.channel);
```

- [ ] **Passo 6: verde e commit**

```bash
pnpm vitest run tests/unit/inbox-filtro-de-meio.test.ts lib/schemas/messaging.test.ts tests/unit/rota-le-todo-filtro-do-schema.test.ts
pnpm typecheck
git add -A && git commit -m "feat(inbox): a lista de conversas filtra pelo meio"
```

---

### Task 2: os fechados — uma régua, cinco filtros novos

**Files:** `app/api/v1/atendimentos/_handler.ts`, `app/api/v1/atendimentos/route.ts`, `tests/unit/aba-fechadas-lista-atendimentos.test.ts`, `tests/unit/rota-le-todo-filtro-do-schema.test.ts`

- [ ] **Passo 1: os testes que falham.** Em `aba-fechadas-lista-atendimentos.test.ts`, um `describe("os filtros novos viram predicado")` com o dublê que já existe no arquivo (`fakeSupabase`, `consulta`, `args`):

| Entrada | Predicado esperado em `atendimentos` |
|---|---|
| `assigned_to=me` | `eq ["assigned_to_user_id","user-1"]` |
| `assigned_to=unassigned` | `is ["assigned_to_user_id",null]` |
| `assigned_to=<uuid>` | `eq ["assigned_to_user_id","<uuid>"]` |
| `channel=phone` | `eq ["conversations.channel","phone"]` |
| `closed_from=2026-10-08T03:00:00.000Z` | `gte ["closed_at","2026-10-08T03:00:00.000Z"]` |
| `closed_to=2026-10-09T03:00:00.000Z` | `lt ["closed_at","2026-10-09T03:00:00.000Z"]` |
| `assunto_id=<uuid>` | `eq ["assunto_id","<uuid>"]` |
| nenhum | nenhum `gte`, nenhum `eq` em `assigned_to_user_id`/`assunto_id` |

  E recusas do schema: `closed_from=ontem`, `assunto_id=abc`, `channel=fax`.

- [ ] **Passo 2: a cerca alcança esta rota.** `rota-le-todo-filtro-do-schema.test.ts` ganha um segundo bloco: para cada chave de `listarFechadosSchema.shape`, `app/api/v1/atendimentos/route.ts` precisa conter `<chave>: sp.get("<chave>")`. Com o mesmo par de controles do bloco existente (o schema tem chaves; sabotar uma linha reprova).

- [ ] **Passo 3: rodar e ver falhar**

```bash
pnpm vitest run tests/unit/aba-fechadas-lista-atendimentos.test.ts tests/unit/rota-le-todo-filtro-do-schema.test.ts
```

- [ ] **Passo 4: o schema.** Em `listarFechadosSchema`:

```ts
  assigned_to: filtroDeAtendenteSchema.optional(),
  channel: filtroDeMeioSchema.optional(),
  closed_from: instanteSchema.optional(),
  closed_to: instanteSchema.optional(),
  assunto_id: z.string().uuid().optional(),
```

- [ ] **Passo 5: a régua única.** No mesmo arquivo:

```ts
/**
 * O que uma consulta de `atendimentos` precisa saber fazer para receber os
 * filtros. Estrutural e sem genérico, pelo mesmo motivo de `ConsultaFiltravel`:
 * o builder tipado por um `select` com embed, entregue a um genérico, estoura a
 * profundidade de instanciação (TS2589), e só o `next build` acusa.
 */
export interface ConsultaDeFechados {
  eq(coluna: string, valor: string): this;
  is(coluna: string, valor: null): this;
  gt(coluna: string, valor: number): this;
  gte(coluna: string, valor: string): this;
  lt(coluna: string, valor: string): this;
  contains(coluna: string, valor: string[]): this;
}

export type FiltrosDosFechadosNoBanco = Pick<
  ListarFechadosQuery,
  | "channel_session_id" | "channel" | "tag" | "unread"
  | "assigned_to" | "closed_from" | "closed_to" | "assunto_id"
>;

/**
 * OS FILTROS DOS FECHADOS, numa régua só — a lista da aba e o selo dela chamam
 * esta função. Antes cada lado escrevia os predicados por conta própria; com
 * cinco filtros a mais, o selo passaria a contar o que a lista não mostra na
 * primeira vez em que alguém esquecesse um dos dois.
 *
 * Número, meio, etiqueta e não lidas são da CONVERSA (por isso o
 * `conversations!inner` em quem chama). Atendente, período e assunto são do
 * ATENDIMENTO: o atendente é quem estava com a conversa no encerramento, e não
 * o dono de hoje — a conversa perde o dono quando o cliente volta (0269).
 */
export function aplicarFiltrosDosFechados<Q extends ConsultaDeFechados>(
  consulta: Q,
  q: FiltrosDosFechadosNoBanco,
  userId: string,
): Q {
  let c = consulta;
  if (q.channel_session_id) c = c.eq("conversations.channel_session_id", q.channel_session_id);
  if (q.channel) c = c.eq("conversations.channel", q.channel);
  if (q.tag) c = c.contains("conversations.tags", [q.tag]);
  if (q.unread) c = c.gt("conversations.unread_count_for_assignee", 0);
  if (q.assigned_to === "me") c = c.eq("assigned_to_user_id", userId);
  else if (q.assigned_to === "unassigned") c = c.is("assigned_to_user_id", null);
  else if (q.assigned_to) c = c.eq("assigned_to_user_id", q.assigned_to);
  if (q.closed_from) c = c.gte("closed_at", q.closed_from);
  if (q.closed_to) c = c.lt("closed_at", q.closed_to);
  if (q.assunto_id) c = c.eq("assunto_id", q.assunto_id);
  return c;
}
```

  Em `listarAtendimentosFechados`, as três linhas de `channel_session_id`/`tag`/`unread` viram:

```ts
  consulta = aplicarFiltrosDosFechados(
    consulta as unknown as ConsultaDeFechados,
    q,
    ctx.userId,
  ) as unknown as typeof consulta;
```

- [ ] **Passo 6: a rota lê.** Em `atendimentos/route.ts`, no `safeParse` do ramo `status=closed`:

```ts
      assigned_to: sp.get("assigned_to") ?? undefined,
      channel: sp.get("channel") ?? undefined,
      closed_from: sp.get("closed_from") ?? undefined,
      closed_to: sp.get("closed_to") ?? undefined,
      assunto_id: sp.get("assunto_id") ?? undefined,
```

- [ ] **Passo 7: verde e commit**

```bash
pnpm vitest run tests/unit/aba-fechadas-lista-atendimentos.test.ts tests/unit/rota-le-todo-filtro-do-schema.test.ts
pnpm typecheck
git add -A && git commit -m "feat(inbox): Fechadas filtra por atendente, meio, período e assunto"
```

---

### Task 3: as contagens

**Files:** `app/api/v1/conversations/counts/route.ts`, `tests/unit/badge-espelha-o-filtro.test.ts`, `tests/unit/contagem-aplica-os-filtros-novos.test.ts` (novo)

A que contagem cada filtro chega — a mesma tabela de `ONDE_VALE` (Task 6):

| Filtro | fila | automático | minhas | todas + chips | fechadas |
|---|---|---|---|---|---|
| `channel` | sim | sim | sim | sim | sim |
| `assigned_to` | — | — | — | sim | sim |
| `closed_from`, `closed_to`, `assunto_id` | — | — | — | — | sim |

- [ ] **Passo 1: o teste que falha.** `contagem-aplica-os-filtros-novos.test.ts` chama o `GET` da rota com `createClient`, `loadAuthUser` e `resolveActiveOrg` simulados por um dublê que registra, por contagem, os predicados aplicados (o molde é `tests/unit/inbox-todas-contagem-por-time.test.ts`). Afirma a tabela acima, linha por linha, e mais:
  - `assigned_to=me` vira o id do usuário da sessão;
  - `assigned_to=xyz` responde 422;
  - `closed_from=ontem` responde 422.

  Em `badge-espelha-o-filtro.test.ts`: `filtrosAuxiliaresDaContagem` devolve `["channel","phone"]` para `?channel=phone`, e a fábrica dos fechados chama `aplicarFiltrosDosFechados` (o laço manual sobre `auxiliares` deixa de existir ali).

- [ ] **Passo 2: rodar e ver falhar**

- [ ] **Passo 3: implementar.**
  - `filtrosAuxiliaresDaContagem`: `channel` entra como par coluna/valor, depois de validado por `filtroDeMeioSchema` (valor inválido é ignorado ali e recusado pelo schema da rota, abaixo).
  - Logo depois do `filtroDeTime`, um schema para os novos, com 422 no erro:

```ts
  const novos = z
    .object({
      assigned_to: filtroDeAtendenteSchema.optional(),
      channel: filtroDeMeioSchema.optional(),
      closed_from: instanteSchema.optional(),
      closed_to: instanteSchema.optional(),
      assunto_id: z.string().uuid().optional(),
    })
    .safeParse({
      assigned_to: sp.get("assigned_to") ?? undefined,
      channel: sp.get("channel") ?? undefined,
      closed_from: sp.get("closed_from") ?? undefined,
      closed_to: sp.get("closed_to") ?? undefined,
      assunto_id: sp.get("assunto_id") ?? undefined,
    });
```

  - O atendente das abertas, na mesma forma do handler da lista, e aplicado dentro de `daTodas` (que já embrulha Todas e os chips):

```ts
  const doAtendente = <Q extends { eq(c: string, v: string): Q; is(c: string, v: null): Q }>(q: Q): Q => {
    const a = novos.data.assigned_to;
    if (a === "me") return q.eq("assigned_to_user_id", user.id);
    if (a === "unassigned") return q.is("assigned_to_user_id", null);
    return a ? q.eq("assigned_to_user_id", a) : q;
  };
```

  - `countAtendimentosFechados` troca o laço e o `soNaoLidas` por `aplicarFiltrosDosFechados(q, { channel_session_id, channel, tag, unread: soNaoLidas, assigned_to, closed_from, closed_to, assunto_id }, user.id)`.

- [ ] **Passo 4: verde e commit**

```bash
pnpm vitest run tests/unit/contagem-aplica-os-filtros-novos.test.ts tests/unit/badge-espelha-o-filtro.test.ts tests/unit/inbox-todas-contagem-por-time.test.ts
pnpm typecheck
git add -A && git commit -m "feat(inbox): os selos das abas acompanham os filtros novos"
```

---

### Task 4: `GET /api/v1/conversations/filtros`

**Files:** `lib/inbox/opcoes-dos-filtros.ts`, `lib/inbox/abas.ts`, `app/api/v1/conversations/filtros/_handler.ts`, `app/api/v1/conversations/filtros/route.ts`, `app/api/v1/conversations/filtros/_handler.test.ts`

- [ ] **Passo 1: os tipos.** `lib/inbox/opcoes-dos-filtros.ts`:

```ts
import type { MeioDeCanal } from "@/lib/channels/capabilities";

export interface AtendenteDoFiltro {
  user_id: string;
  /** `null` quando o nome não pôde ser lido (self-host sem service role). */
  nome: string | null;
  /** `false` para quem saiu da organização e ainda é dono de histórico. */
  ativo: boolean;
}

export interface CaixaDeEntrada {
  id: string;
  meio: MeioDeCanal;
  nome: string | null;
  numero: string | null;
}

export interface AssuntosDoTime {
  time_id: string;
  time: string;
  assuntos: Array<{ id: string; nome: string; arquivado: boolean }>;
}

export interface OpcoesDosFiltros {
  atendentes: AtendenteDoFiltro[];
  caixas: CaixaDeEntrada[];
  assuntos: AssuntosDoTime[];
}
```

- [ ] **Passo 2: `podeVerColegas`.** Em `lib/inbox/abas.ts`, e `visibleInboxTabs` passa a usá-la:

```ts
/**
 * Quem enxerga conversa de COLEGA. É a mesma pergunta que decide a aba "Todas"
 * e a lista de nomes do filtro por atendente — uma função, para as duas
 * respostas não divergirem.
 */
export function podeVerColegas(role: Role, mode: VisibilityMode | undefined): boolean {
  return role !== "agent" || mode === "all" || mode === "own_and_team";
}
```

- [ ] **Passo 3: o teste que falha.** `_handler.test.ts`, com dublê que registra a cadeia por tabela:
  - toda leitura (`user_organizations`, `channel_sessions`, `atendimento_assuntos`, `attendance_teams`) leva `.eq("organization_id", <org da sessão>)`;
  - `viewer` não entra em `atendentes`; revogado entra com `ativo: false`; usuário com vínculo ativo e outro revogado sai uma vez, ativo;
  - `agent` em `own_and_unassigned` recebe `atendentes: []` e `user_organizations` nem é lida;
  - sessão de provider sem meio não entra em `caixas`; a resposta não tem a chave `provider`;
  - assunto arquivado sai com `arquivado: true`; time sem assunto não sai.

- [ ] **Passo 4: implementar.** `_handler.ts` exporta `carregarOpcoesDosFiltros({ db, admin, orgId, role, visibilityMode, nomes })`, onde `db` é o client do usuário, `admin` é o client de service role ou `null`, e `nomes` é `nomesDosAtendentes` (injetado para o teste):
  - **atendentes** — só se `podeVerColegas`. Lê `user_organizations` (`user_id, role, revoked_at`) com `admin ?? db`, filtrado pela organização; descarta `viewer`; deduplica por `user_id` preferindo o vínculo ativo; resolve nomes; ordena ativos por nome, depois inativos por nome.
  - **caixas** — `channel_sessions` (`id, display_name, phone_number, provider`) com `db`, não arquivadas (`queryTolerantToMissingArchived`, como `channel-sessions/route.ts`); mapeia `meioDoCanal(provider)`, descarta `null`, não devolve `provider`.
  - **assuntos** — `atendimento_assuntos` (`id, name, team_id, archived_at`) e `attendance_teams` (`id, name`) com `db`; agrupa por time, ordena por nome.

  `route.ts`, no molde de `conversations/teams/route.ts`: `requireRole("viewer", { requestId, resource: "conversations" })`, `export const dynamic = "force-dynamic"`, `ok(opcoes, { requestId })`, e falha de leitura vira 500 com frase traduzida.

- [ ] **Passo 5: verde e commit**

```bash
pnpm vitest run app/api/v1/conversations/filtros tests/unit/inbox-filters-scope.test.tsx
pnpm typecheck && pnpm lint:channels
git add -A && git commit -m "feat(inbox): rota com as opções dos filtros (atendentes, caixas, assuntos)"
```

---

### Task 5: migration 0297

**Files:** `supabase/migrations/20261008120000_0297_inbox_filtros_indices.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`

- [ ] **Passo 1: conferir o número.**

```bash
ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1   # esperado: 0296
```

- [ ] **Passo 2: a migration.** Cabeçalho no tom das vizinhas (o que entra e por quê, com o caminho do desenho) e:

```sql
create index if not exists atendimentos_org_dono_fechamento
  on public.atendimentos (organization_id, assigned_to_user_id, closed_at desc)
  where closed_at is not null;

create index if not exists conversations_org_channel_last_msg
  on public.conversations (organization_id, channel, last_message_at desc nulls last);
```

- [ ] **Passo 3: o apêndice do baseline.** O mesmo SQL, sob `-- ---- inbox: índices dos filtros por atendente e por meio (migration 0297) ----`, depois do apêndice da 0296 (`grep -n "migration 0296" supabase/baseline.sql`).

- [ ] **Passo 4: a linha do MANIFEST**, na tabela "Applied", no formato das vizinhas.

- [ ] **Passo 5: medir.** Num Postgres descartável com o baseline aplicado, uma organização com 20 mil conversas (2% `phone`) e 20 mil atendimentos encerrados (5% de um mesmo dono), `EXPLAIN (ANALYZE, BUFFERS)` sob o papel `authenticated` das duas consultas — a de Todas com `channel = 'phone'` e a de Fechadas com `assigned_to_user_id = <dono>` —, com e sem cada índice. Índice que o plano não usar sai da migration, do baseline e do MANIFEST. Os números vão para o cabeçalho da migration e para o PR.

- [ ] **Passo 6: instalação e atualização.**

```bash
pnpm test:db tests/invariants/manifest-x-migrations.test.ts
```

  (A suíte inteira de invariantes roda no check `invariants` do PR.)

- [ ] **Passo 7: commit** — `feat(db): índices dos filtros do Inbox por atendente e por meio (0297)`.

---

### Task 6: o núcleo puro da tela

**Files:** `lib/inbox/periodo.ts`, `lib/inbox/filtros-de-tela.ts`, `lib/inbox/filtros-na-url.ts`, e um `.test.ts` ao lado de cada

- [ ] **Passo 1: `periodo.test.ts`** — com `agora = new Date(2026, 9, 8, 15, 30)` e comparando contra `new Date(2026, 9, 8).toISOString()` (meia-noite LOCAL, para o teste não depender do fuso da máquina):

| Escolha | `closed_from` | `closed_to` |
|---|---|---|
| `hoje` | 08/10 00:00 | ausente |
| `ontem` | 07/10 00:00 | 08/10 00:00 |
| `7d` | 02/10 00:00 | ausente |
| `30d` | 09/09 00:00 | ausente |
| `de=2026-10-01`, `ate=2026-10-03` | 01/10 00:00 | 04/10 00:00 |
| `de=2026-10-03`, `ate=2026-10-01` | ausente | ausente |
| só `de` | ausente | ausente |
| `de=2026-02-30` | ausente | ausente |
| `periodo=hoje` + `de`/`ate` | o de `hoje` | ausente |

  E a virada: `agora = new Date(2026, 9, 8, 0, 0, 0)` ainda é "hoje = 08/10".

- [ ] **Passo 2: `lib/inbox/periodo.ts`**

```ts
export const PERIODOS = ["hoje", "ontem", "7d", "30d"] as const;
export type Periodo = (typeof PERIODOS)[number];

export interface IntervaloDeFechamento {
  /** Inclusivo. */
  closed_from?: string;
  /** Exclusivo. Ausente = até agora. */
  closed_to?: string;
}

const FORMA = /^\d{4}-\d{2}-\d{2}$/;

function partes(data: string): [number, number, number] {
  const [a, m, d] = data.split("-").map(Number);
  return [a ?? 0, m ?? 0, d ?? 0];
}

/** `AAAA-MM-DD` que existe no calendário — `2026-02-30` tem a forma e não existe. */
export function dataValida(data: string): boolean {
  if (!FORMA.test(data)) return false;
  const [a, m, d] = partes(data);
  const dt = new Date(a, m - 1, d);
  return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Hoje como `AAAA-MM-DD`, no fuso de quem olha. */
export function hojeComoData(agora: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
}

/**
 * Do que a pessoa escolheu para os dois instantes que o servidor recebe.
 *
 * O dia é o de QUEM OLHA A TELA (`new Date(ano, mês, dia)` é meia-noite local):
 * "hoje" é o que a pessoa chama de hoje. Um observador em outro fuso vê outro
 * recorte — limite declarado no desenho (D7).
 *
 * As escolhas abertas (`hoje`, `7d`, `30d`) não mandam `closed_to`: o instante
 * de início é o mesmo o dia inteiro, e a chave da consulta não muda a cada
 * render.
 */
export function resolverPeriodo(
  escolha: { periodo?: Periodo; de?: string; ate?: string },
  agora: Date = new Date(),
): IntervaloDeFechamento {
  const dia = (deslocamento: number) =>
    new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + deslocamento).toISOString();
  switch (escolha.periodo) {
    case "hoje":
      return { closed_from: dia(0) };
    case "ontem":
      return { closed_from: dia(-1), closed_to: dia(0) };
    case "7d":
      return { closed_from: dia(-6) };
    case "30d":
      return { closed_from: dia(-29) };
    default:
  }
  const { de, ate } = escolha;
  if (!de || !ate || !dataValida(de) || !dataValida(ate) || de > ate) return {};
  const [a1, m1, d1] = partes(de);
  const [a2, m2, d2] = partes(ate);
  return {
    closed_from: new Date(a1, m1 - 1, d1).toISOString(),
    closed_to: new Date(a2, m2 - 1, d2 + 1).toISOString(),
  };
}
```

- [ ] **Passo 3: `filtros-de-tela.test.ts`** — a tabela do desenho (§4.1), aba por aba: com TODOS os filtros ligados, `filtrosAplicados(aba, tela)` devolve exatamente as chaves que valem naquela aba; `phone` não devolve nenhuma. Mais:
  - busca de uma letra não é aplicada;
  - `paraConversas("closed", …)` não leva `assigned_to` (ali ele é do atendimento);
  - `paraFechados` leva `closed_from`/`closed_to`, não leva `na_fila`;
  - `paraContagens(tela)` leva todos os ligados, sem olhar a aba;
  - **a cerca**: para cada chave de filtro, ligada numa aba onde vale, ela aparece em `nomesDosFiltros`; e `contarFiltrosDoFunil` conta time, etiqueta, caixa, atendente, período e assunto — e não conta não lidos, busca, na fila nem insatisfeitos.

- [ ] **Passo 4: `lib/inbox/filtros-de-tela.ts`**

```ts
import type { MeioDeCanal } from "@/lib/channels/capabilities";
import type { InboxTab } from "@/lib/inbox/abas";
import { resolverPeriodo, type Periodo } from "@/lib/inbox/periodo";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

/** O que a pessoa ligou na tela. Tudo menos `search` mora no endereço. */
export interface FiltrosDeTela {
  search: string;
  onlyUnread: boolean;
  /** `mine`, `none` ou o id de um time. */
  team_id?: string;
  tag?: string;
  /** A caixa de entrada pelo MEIO… */
  channel?: MeioDeCanal;
  /** …ou por UM número. Escolher um apaga o outro. */
  channel_session_id?: string;
  /** `me`, `unassigned` ou o id de um usuário. */
  assigned_to?: string;
  periodo?: Periodo;
  de?: string;
  ate?: string;
  assunto_id?: string;
  na_fila?: boolean;
  ordem?: "espera";
  insatisfeitos?: boolean;
}

export type ChaveDeFiltro =
  | "unread" | "search" | "team_id" | "tag" | "caixa"
  | "assigned_to" | "periodo" | "assunto_id" | "na_fila" | "insatisfeitos" | "ordem";

const DE_CONVERSA: readonly InboxTab[] = ["unassigned", "mine", "all", "ai", "closed"];

/**
 * EM QUE ABA CADA FILTRO VALE — a tabela do desenho (§4.1), e a única.
 *
 * Dela saem o que vai para a API, que controle a tela mostra, quantos filtros o
 * funil conta e que nomes o vazio cita. Eram quatro respostas escritas em
 * quatro lugares, e duas já discordavam (o time não era citado no vazio).
 *
 * Filtro ligado em aba onde não vale continua no endereço e volta a valer
 * quando a pessoa volta — a regra que `na_fila` já seguia.
 *
 * O atendente não vale em Minhas (a aba já é "eu") nem em Fila e Automático:
 * conversa com dono tem comando `humano`, e essas abas pedem os comandos que só
 * existem sem dono (`lib/inbox/comando-da-conversa.ts`).
 */
export const ONDE_VALE: Record<ChaveDeFiltro, readonly InboxTab[]> = {
  unread: DE_CONVERSA,
  search: DE_CONVERSA,
  team_id: DE_CONVERSA,
  tag: DE_CONVERSA,
  caixa: DE_CONVERSA,
  assigned_to: ["all", "closed"],
  periodo: ["closed"],
  assunto_id: ["closed"],
  na_fila: ["all"],
  insatisfeitos: ["all", "mine"],
  ordem: ["all", "mine"],
};

export function valeNaAba(chave: ChaveDeFiltro, tab: InboxTab): boolean {
  return ONDE_VALE[chave].includes(tab);
}

/** Os filtros que VALEM na aba, já na forma que as rotas recebem. */
export interface FiltrosAplicados {
  search?: string;
  unread?: true;
  team_id?: string;
  tag?: string;
  channel?: MeioDeCanal;
  channel_session_id?: string;
  assigned_to?: string;
  closed_from?: string;
  closed_to?: string;
  assunto_id?: string;
  na_fila?: true;
  ordem?: "espera";
  insatisfeitos?: true;
}

/** Tira as chaves sem valor: um `undefined` espalhado por cima apagaria o filtro da ABA. */
function semVazios<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function filtrosAplicados(
  tab: InboxTab,
  tela: FiltrosDeTela,
  agora: Date = new Date(),
): FiltrosAplicados {
  const vale = (chave: ChaveDeFiltro) => valeNaAba(chave, tab);
  const intervalo = vale("periodo") ? resolverPeriodo(tela, agora) : {};
  return semVazios<FiltrosAplicados>({
    // A tela não pede o que a rota recusa: uma letra só não é busca.
    search: vale("search") && buscaValeConsulta(tela.search) ? tela.search : undefined,
    unread: vale("unread") && tela.onlyUnread ? true : undefined,
    team_id: vale("team_id") ? tela.team_id : undefined,
    tag: vale("tag") ? tela.tag : undefined,
    channel: vale("caixa") ? tela.channel : undefined,
    channel_session_id: vale("caixa") ? tela.channel_session_id : undefined,
    assigned_to: vale("assigned_to") ? tela.assigned_to : undefined,
    closed_from: intervalo.closed_from,
    closed_to: intervalo.closed_to,
    assunto_id: vale("assunto_id") ? tela.assunto_id : undefined,
    na_fila: vale("na_fila") && tela.na_fila ? true : undefined,
    ordem: vale("ordem") ? tela.ordem : undefined,
    insatisfeitos: vale("insatisfeitos") && tela.insatisfeitos ? true : undefined,
  });
}

/** O que vai para `GET /api/v1/conversations`. */
export function paraConversas(tab: InboxTab, a: FiltrosAplicados) {
  const { closed_from: _de, closed_to: _ate, assunto_id: _assunto, assigned_to, ...resto } = a;
  // Em Fechadas o atendente é o do ATENDIMENTO (quem estava no encerramento);
  // a consulta de conversas que roda por trás da aba não o recebe.
  return semVazios({ ...resto, assigned_to: tab === "closed" ? undefined : assigned_to });
}

/** O que vai para `GET /api/v1/atendimentos?status=closed`. */
export function paraFechados(a: FiltrosAplicados) {
  const { na_fila: _fila, ordem: _ordem, insatisfeitos: _insatisfeitos, ...resto } = a;
  return resto;
}

/**
 * O que vai para a contagem das abas: TODOS os filtros ligados, sem olhar a aba
 * atual. O selo de uma aba diz o que a lista mostrará ao clicar nela, e quem
 * sabe a que contagem cada filtro chega é o servidor (`counts/route.ts`).
 */
export function paraContagens(tela: FiltrosDeTela, agora: Date = new Date()) {
  const intervalo = resolverPeriodo(tela, agora);
  return semVazios({
    search: buscaValeConsulta(tela.search) ? tela.search : undefined,
    unread: tela.onlyUnread || undefined,
    team_id: tela.team_id,
    tag: tela.tag,
    channel: tela.channel,
    channel_session_id: tela.channel_session_id,
    assigned_to: tela.assigned_to,
    closed_from: intervalo.closed_from,
    closed_to: intervalo.closed_to,
    assunto_id: tela.assunto_id,
    na_fila: tela.na_fila || undefined,
    insatisfeitos: tela.insatisfeitos || undefined,
  });
}

/**
 * Os filtros ligados, em palavras que o operador reconhece — para o vazio dizer
 * POR QUE a lista está vazia. Sai do mesmo objeto que foi ao servidor.
 * A ordem ("Mais tempo esperando") não entra: não esconde conversa nenhuma.
 */
export function nomesDosFiltros(a: FiltrosAplicados): string[] {
  const nomes: string[] = [];
  if (a.unread) nomes.push("Não lidos");
  if (a.search) nomes.push("Busca");
  if (a.team_id) nomes.push("Time");
  if (a.tag) nomes.push("Etiqueta");
  if (a.channel || a.channel_session_id) nomes.push("Caixa de entrada");
  if (a.assigned_to) nomes.push("Atendente");
  if (a.closed_from || a.closed_to) nomes.push("Período");
  if (a.assunto_id) nomes.push("Assunto");
  if (a.na_fila) nomes.push("Só na fila");
  if (a.insatisfeitos) nomes.push("Insatisfeitos");
  return nomes;
}

/** Quantos dos filtros que moram DENTRO do funil estão valendo — o selo dele. */
export function contarFiltrosDoFunil(a: FiltrosAplicados): number {
  return [
    a.team_id,
    a.tag,
    a.channel ?? a.channel_session_id,
    a.assigned_to,
    a.closed_from ?? a.closed_to,
    a.assunto_id,
  ].filter((v) => v != null).length;
}
```

- [ ] **Passo 5: `filtros-na-url.test.ts`**
  - ida e volta: para um `FiltrosDeTela` com tudo ligado, `lerFiltrosDaUrl(escreverFiltrosNaUrl(new URLSearchParams(), "closed", f))` devolve `f`;
  - `escrever` preserva `id=abc` e qualquer parâmetro desconhecido, e grava `filter`;
  - `escrever` com tudo desligado apaga todos os parâmetros de filtro;
  - `ler` descarta: `team_id=xyz`, `assigned_to=xyz`, `channel=fax`, `channel_session_id=1`, `periodo=semana`, `ordem=recente`, `assunto_id=1`, `tag` vazia ou com mais de 40 caracteres;
  - `de` sem `ate` descartado; `de > ate` descartados os dois; `periodo` presente descarta `de`/`ate`;
  - `unread=1` e `unread=true` ligam; `unread=0` e `unread=false` não.

- [ ] **Passo 6: `lib/inbox/filtros-na-url.ts`**

```ts
import { z } from "zod";

import { MEIOS_DE_CANAL, type MeioDeCanal } from "@/lib/channels/capabilities";
import type { InboxTab } from "@/lib/inbox/abas";
import type { FiltrosDeTela } from "@/lib/inbox/filtros-de-tela";
import { dataValida, PERIODOS, type Periodo } from "@/lib/inbox/periodo";

/** Tudo menos a busca: nome e telefone de cliente não vão para o endereço (D6). */
export type FiltrosNaUrl = Omit<FiltrosDeTela, "search">;

/** Os parâmetros que ESTE módulo escreve e apaga. `filter` e `id` não são dele. */
export const PARAMETROS_DE_FILTRO = [
  "unread", "team_id", "tag", "channel", "channel_session_id", "assigned_to",
  "periodo", "de", "ate", "assunto_id", "na_fila", "ordem", "insatisfeitos",
] as const;

// A MESMA régua do servidor (`z.string().uuid()`), para um id que a tela aceita
// nunca virar 422 na rota.
const ehUuid = (v: string) => z.string().uuid().safeParse(v).success;
const ligado = (v: string | null) => v === "1" || v === "true";

/**
 * Lê os filtros do endereço. Valor fora de forma é DESCARTADO em silêncio: um
 * link velho ou editado à mão abre a lista sem aquele filtro, em vez de um erro
 * na cara de quem só clicou num link.
 */
export function lerFiltrosDaUrl(sp: Pick<URLSearchParams, "get">): FiltrosNaUrl {
  const f: FiltrosNaUrl = { onlyUnread: ligado(sp.get("unread")) };

  const time = sp.get("team_id");
  if (time && (time === "mine" || time === "none" || ehUuid(time))) f.team_id = time;

  const tag = sp.get("tag")?.trim().toLowerCase();
  if (tag && tag.length <= 40) f.tag = tag;

  const meio = sp.get("channel");
  if (meio && (MEIOS_DE_CANAL as readonly string[]).includes(meio)) f.channel = meio as MeioDeCanal;

  const numero = sp.get("channel_session_id");
  if (numero && ehUuid(numero)) f.channel_session_id = numero;

  const atendente = sp.get("assigned_to");
  if (atendente && (atendente === "me" || atendente === "unassigned" || ehUuid(atendente))) {
    f.assigned_to = atendente;
  }

  const periodo = sp.get("periodo");
  if (periodo && (PERIODOS as readonly string[]).includes(periodo)) {
    f.periodo = periodo as Periodo;
  } else {
    const de = sp.get("de");
    const ate = sp.get("ate");
    if (de && ate && dataValida(de) && dataValida(ate) && de <= ate) {
      f.de = de;
      f.ate = ate;
    }
  }

  const assunto = sp.get("assunto_id");
  if (assunto && ehUuid(assunto)) f.assunto_id = assunto;

  if (ligado(sp.get("na_fila"))) f.na_fila = true;
  if (sp.get("ordem") === "espera") f.ordem = "espera";
  if (ligado(sp.get("insatisfeitos"))) f.insatisfeitos = true;
  return f;
}

/**
 * Devolve o endereço com a aba e os filtros dados. Parte de `atual` e só mexe
 * no que é dela: `id` (a conversa aberta) e qualquer parâmetro que este módulo
 * não conhece atravessam intactos.
 */
export function escreverFiltrosNaUrl(
  atual: URLSearchParams,
  tab: InboxTab,
  f: FiltrosNaUrl,
): URLSearchParams {
  const p = new URLSearchParams(atual);
  for (const chave of PARAMETROS_DE_FILTRO) p.delete(chave);
  p.set("filter", tab);
  if (f.onlyUnread) p.set("unread", "1");
  if (f.team_id) p.set("team_id", f.team_id);
  if (f.tag) p.set("tag", f.tag);
  if (f.channel) p.set("channel", f.channel);
  if (f.channel_session_id) p.set("channel_session_id", f.channel_session_id);
  if (f.assigned_to) p.set("assigned_to", f.assigned_to);
  if (f.periodo) p.set("periodo", f.periodo);
  else if (f.de && f.ate) {
    p.set("de", f.de);
    p.set("ate", f.ate);
  }
  if (f.assunto_id) p.set("assunto_id", f.assunto_id);
  if (f.na_fila) p.set("na_fila", "1");
  if (f.ordem) p.set("ordem", f.ordem);
  if (f.insatisfeitos) p.set("insatisfeitos", "1");
  return p;
}
```

- [ ] **Passo 7: verde e commit**

```bash
pnpm vitest run lib/inbox/periodo.test.ts lib/inbox/filtros-de-tela.test.ts lib/inbox/filtros-na-url.test.ts
pnpm typecheck
git add -A && git commit -m "feat(inbox): a regra dos filtros num lugar só — abas, endereço e período"
```

---

### Task 7: os hooks

**Files:** `hooks/inbox/useConversationsRealtime.ts`, `hooks/inbox/useAtendimentosFechados.ts`, `hooks/inbox/useConversationCounts.ts`, `hooks/inbox/useOpcoesDosFiltros.ts`, `tests/unit/hooks-serializam-os-filtros-novos.test.ts` (novo)

- [ ] **Passo 1: o teste que falha.** Uma cerca de texto no molde de `rota-le-todo-filtro-do-schema`: para cada chave dos filtros que a tela manda, o hook correspondente contém `qs.set("<chave>"`. Três tabelas:
  - conversas: `channel`;
  - fechados: `assigned_to`, `channel`, `closed_from`, `closed_to`, `assunto_id`;
  - contagens: `assigned_to`, `channel`, `closed_from`, `closed_to`, `assunto_id`.

  Com o controle de sabotagem (apagar a linha no texto reprova).

- [ ] **Passo 2: implementar.** Cada tipo ganha os campos (`ConversationsFilters.channel`, `FiltrosDosFechados`, `FiltrosDaContagem`) e cada `queryFn` ganha as linhas `if (filtros.x) qs.set("x", filtros.x)`. `useOpcoesDosFiltros(habilitado)`:

```ts
export function useOpcoesDosFiltros(habilitado: boolean) {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  return useQuery({
    queryKey: ["inbox-opcoes-dos-filtros", orgId],
    enabled: habilitado && !!orgId,
    // Dado de referência: quem entra e sai da organização, número novo, assunto novo.
    staleTime: 5 * 60_000,
    queryFn: () =>
      apiClient
        .get<{ data: OpcoesDosFiltros }>("/api/v1/conversations/filtros")
        .then((r) => r.data),
  });
}
```

- [ ] **Passo 3: verde e commit** — `feat(inbox): os hooks levam os filtros novos às rotas`.

---

### Task 8: `InboxLayout` — o estado mora no endereço

**Files:** `components/inbox/InboxLayout.tsx`, `components/inbox/InboxAbas.tsx`, `components/inbox/InboxFilters.tsx` (só o tipo), `components/inbox/SoAsMinhas.tsx`, `components/inbox/ChipsDosTimes.tsx` (exporta as classes dos chips), `components/inbox/ConversationList.tsx`, `components/inbox/AtendimentosFechadosList.tsx`, `lib/inbox/filtros-ativos.ts` (remove), testes que os montam

- [ ] **Passo 1: o tipo.** Em `InboxFilters.tsx`, `InboxFiltersValue` vira `FiltrosDeTela & { tab: InboxTab }` (os comentários de `team_id` e dos chips sobem para `filtros-de-tela.ts`).

- [ ] **Passo 2: o estado.** Em `InboxLayout.tsx`, no lugar do `useState` de `aux`:

```ts
  const tab = parseFilterParam(searchParams.get("filter"));
  // OS FILTROS MORAM NO ENDEREÇO: recarregar não os perde, e o link de uma lista
  // filtrada abre a mesma lista. A busca fica de fora — nome e telefone de
  // cliente não vão para o histórico do navegador.
  const naUrl = useMemo(() => lerFiltrosDaUrl(searchParams), [searchParams]);
  const [search, setSearch] = useState("");
  const filterValue: InboxFiltersValue = useMemo(
    () => ({ tab, search, ...naUrl }),
    [tab, search, naUrl],
  );
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      const { tab: proximaAba, search: proximaBusca, ...resto } = next;
      setSearch(proximaBusca);
      // Parte do endereço DE AGORA, e não do `searchParams` capturado no render:
      // o timer da busca e um clique podem chegar no mesmo instante, e quem
      // escrevesse a partir de uma cópia velha desfaria o outro.
      const atual = new URLSearchParams(window.location.search);
      const proximo = escreverFiltrosNaUrl(atual, proximaAba, resto);
      if (proximo.toString() === atual.toString()) return;
      // `replaceState`, e não `router.replace`: o Next sincroniza
      // `useSearchParams` com ele e a página não é refeita no servidor a cada
      // clique num filtro (ela é `force-dynamic` e relê usuário e organização).
      window.history.replaceState(null, "", `${pathname}?${proximo.toString()}`);
    },
    [pathname],
  );
```

  `limparFiltrosAuxiliares` continua `setFilterValue({ tab, search: "", onlyUnread: false })`. `useRouter` sai do arquivo se não sobrar outro uso.

- [ ] **Passo 3: uma régua para tudo.**

```ts
  // O dia entra na dependência para "hoje" virar à meia-noite sem recarregar.
  const dia = new Date().toDateString();
  const aplicados = useMemo(
    () => filtrosAplicados(tab, filterValue),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, filterValue, dia],
  );
  const filters: ConversationsFilters = useMemo(
    () => ({ ...tabToFilter(tab, automaticoDaOrg), ...paraConversas(tab, aplicados) }),
    [tab, automaticoDaOrg, aplicados],
  );
  const filtrosDosFechados = useMemo(() => paraFechados(aplicados), [aplicados]);
  const nomesDosFiltrosAtivos = useMemo(() => nomesDosFiltros(aplicados), [aplicados]);
  const contagensQ = useConversationCounts(orgId, {
    ...paraContagens(filterValue),
    by_team: tab === "all",
  });
```

- [ ] **Passo 4: `InboxAbas` recebe as contagens.** Prop nova `contagens?: ConversationCounts`; o `useConversationCounts` sai de dentro dele. `InboxLayout` passa `contagens={contagensQ.data}`.

- [ ] **Passo 5: os vazios.** `ConversationList` e `AtendimentosFechadosList` ganham a prop `filtrosAtivos: string[]` e param de chamar `filtrosAuxiliaresAtivos`; `lib/inbox/filtros-ativos.ts` é removido. Em `AtendimentosFechadosList`, o vazio sem filtro segue "Nenhum atendimento encerrado ainda."

- [ ] **Passo 6: "Só as minhas".** `components/inbox/SoAsMinhas.tsx`, com as classes de chip exportadas de `ChipsDosTimes.tsx`:

```tsx
export function SoAsMinhas({ ligado, onChange }: { ligado: boolean; onChange: (ligado: boolean) => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={cn(ALTERNANCIA, ligado ? CHIP_LIGADO : CHIP_DESLIGADO)}
      aria-pressed={ligado}
      aria-label={t("Só as minhas")}
      title={t("Só os atendimentos que estavam comigo quando foram encerrados")}
      data-testid="so-as-minhas"
      onClick={() => onChange(!ligado)}
    >
      <User size={12} weight={ligado ? "fill" : "regular"} aria-hidden />
      {t("Só as minhas")}
    </button>
  );
}
```

  Na linha do título, para `tab === "closed"` e papel diferente de `viewer`:

```tsx
            {tab === "closed" && activeOrg?.role !== "viewer" && (
              <SoAsMinhas
                ligado={filterValue.assigned_to === "me"}
                onChange={(ligado) =>
                  setFilterValue({ ...filterValue, assigned_to: ligado ? "me" : undefined })
                }
              />
            )}
```

- [ ] **Passo 7: testes.**
  - `tests/unit/inbox-filtros-no-endereco.test.tsx` (novo): monta `InboxLayout` com `next/navigation` simulado por um dublê cujo `useSearchParams` lê `window.location.search` e re-renderiza quando `history.replaceState` é chamado. Casos: abrir com `?filter=closed&assigned_to=me` pede os fechados com `assigned_to=me`; ligar "Só as minhas" escreve `assigned_to=me` no endereço e mantém `id`; "Limpar filtros" apaga os parâmetros de filtro e mantém `filter` e `id`; digitar na busca não muda o endereço.
  - Atualizar os que dependem do que mudou: `inbox-aba-minhas-encanamento`, `deep-link-nao-espera-a-lista`, `InboxLayout.telefone`, `vazio-por-filtro-nao-e-caixa-vazia`, `limpar-filtros-limpa-o-campo`, e os que simulam `useConversationCounts` dentro de `InboxAbas`. A lista exata sai de:

```bash
grep -rln "filtros-ativos\|contarFiltrosAuxiliares\|InboxAbas\|InboxLayout" tests components hooks --include="*.test.ts*"
```

- [ ] **Passo 8: verde e commit**

```bash
pnpm typecheck && pnpm lint
pnpm test:unit > /tmp/vt8.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests |^ *Errors " /tmp/vt8.log | tail -3
git add -A && git commit -m "feat(inbox): os filtros moram no endereço e saem de uma régua só"
```

---

### Task 9: `InboxFilters` — os seletores

**Files:** `components/inbox/InboxFilters.tsx`, `components/inbox/InboxFilters.novos.test.tsx` (novo), `lib/i18n/dicionario.ts`

- [ ] **Passo 1: os testes que falham** (`InboxFilters.novos.test.tsx`, com `useOpcoesDosFiltros` simulado):
  - o seletor de atendente aparece em `all` e `closed`, e não em `mine`, `unassigned`, `ai`;
  - opções: "Todos os atendentes", "Eu", "Sem atendente", os nomes, e quem saiu com "(saiu)"; `viewer` não tem "Eu";
  - id escolhido fora da lista aparece como "Atendente removido";
  - caixa: com WhatsApp (dois números) e telefone (um), as opções são "Todas as caixas", "WhatsApp", os dois números, "Telefone" — e o número do telefone não aparece;
  - escolher um meio grava `channel` e apaga `channel_session_id`; escolher um número faz o contrário;
  - com uma caixa só e nenhum filtro de caixa, o seletor não aparece;
  - período e assunto só em `closed`; "Escolher datas…" grava `de` e `ate` com a data de hoje e mostra os dois campos; mudar `de` para depois de `ate` puxa `ate`;
  - assunto arquivado aparece com "(arquivado)";
  - o selo do funil mostra `contarFiltrosDoFunil` da aba atual.

- [ ] **Passo 2: implementar.** `useOpcoesDosFiltros(filtrosAbertos)` no lugar de `useChannelSessions`. O valor do seletor de caixa é `meio:<meio>` ou `numero:<uuid>`. A ordem das linhas é a do desenho (§10): time; atendente; caixa + etiqueta; período + assunto; os dois campos de data. O rótulo de cada número sai de `canalComNumero` (`lib/inbox/rotulo-do-canal.ts`). A frase do funil vazio passa a "Ainda não há o que filtrar." só quando nenhum seletor tem o que mostrar.

- [ ] **Passo 3: idiomas.** Toda frase nova em `lib/i18n/dicionario.ts`, no formato das vizinhas. O guardião é `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`; as frases que passam por `t(<variável>)` (os nomes do vazio) ele não enxerga, então entram à mão: "Caixa de entrada", "Atendente", "Período", "Assunto", "Time".

- [ ] **Passo 4: verde e commit**

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels
pnpm test:unit > /tmp/vt9.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests |^ *Errors " /tmp/vt9.log | tail -3
git add -A && git commit -m "feat(inbox): seletores de atendente, caixa de entrada, período e assunto"
```

---

### Task 10: ponta a ponta

**Files:** `tests/e2e/inbox-filtros-por-atendente-e-caixa.spec.ts`, `.github/workflows/e2e.yml`

- [ ] **Passo 1: a spec.** No molde de `tests/e2e/inbox-busca-e-filtros-dizem-a-verdade.spec.ts` e `inbox-protocolo-e-historico.spec.ts` (mesmos ajudantes de semente e de login). Semente: dois atendentes (Ana, Bruno) e um gestor; um assunto; três atendimentos encerrados (dois com a Ana, um com o Bruno, um deles ontem); uma conversa aberta de WhatsApp com a Ana e uma de telefone sem dono. Casos, cada um com captura de tela em `.superpowers/evidence/`:
  1. Ana em Fechadas liga "Só as minhas": dois cartões, selo da aba 2.
  2. O gestor escolhe "Bruno" no funil: um cartão em Fechadas; em Todas, nenhuma conversa e o vazio cita "Atendente".
  3. O gestor escolhe a caixa "Telefone": Fila mostra só a conversa de telefone.
  4. Em Fechadas, período "Hoje" tira o atendimento de ontem; o assunto escolhido deixa só o dele.
  5. Com filtros ligados, `page.reload()` volta com a mesma lista; `page.goto(url copiada)` em contexto novo também.
  6. "Limpar filtros" devolve a lista inteira e o endereço fica só com `filter`.

- [ ] **Passo 2: registrar.** A spec entra numa `SPECS_PARTE_*` de `.github/workflows/e2e.yml` (a de menor duração); `tests/unit/e2e-cobertura-completa.test.ts` cobra.

- [ ] **Passo 3: rodar no GitHub Actions.**

```bash
git push -u origin HEAD
gh workflow run e2e.yml --ref "$(git rev-parse --abbrev-ref HEAD)"
```

  Ler o resultado comparando com o último `e2e` da `main` antes de atribuir uma falha à branch.

- [ ] **Passo 4: commit** — `test(e2e): filtros do Inbox por atendente, caixa, período e assunto`.

---

### Task 11: documentação e fecho

- [ ] **Passo 1:** `docs/architecture/inbox-fila-e-termometro.architecture.json` ganha a rota `conversations/filtros` e as arestas para a lista, as contagens e os fechados (`tests/unit/mapas-de-arquitetura.test.ts` valida a forma).
- [ ] **Passo 2:** `docs/testing/user-journey-map.md` ganha a jornada dos filtros com os seis casos da spec.
- [ ] **Passo 3:** o fragmento em `.changes/` (`capacidade_nova`), no formato de `docs/doctrine/versionamento.md`; `pnpm release:conferir`.
- [ ] **Passo 4:** o desenho recebe as emendas deste plano (seções 5, 8.4 e 12).
- [ ] **Passo 5: os portões, inteiros.**

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |^ *Errors " /tmp/vt.log | tail -3
pnpm build > /tmp/build.log 2>&1; echo "build exit=$?"
```

- [ ] **Passo 6: revisão independente.** Um agente revisor lê o diff contra a `main` sem receber as minhas conclusões, com foco em: selo que conta o que a lista não mostra; filtro que a rota aceita e não aplica; vazamento entre organizações na rota nova; estado do endereço que se desfaz em corrida.
- [ ] **Passo 7: PR** com a linha `ClickUp: CU-124b4z9rjvg · https://app.clickup.com/t/124b4z9rjvg`, os números do `EXPLAIN`, o que foi provado e o que não foi medido. Não mesclar: a autorização é do dono.
