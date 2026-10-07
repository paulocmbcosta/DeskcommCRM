# Telefonia · Fila visível — Entrega 3 (agir na fila: Atender e Mover para outro time) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** na aba Telefone do Inbox, qualquer atendente puxa para o próprio ramal uma ligação que espera na fila ("Atender"), e gerente/admin manda a ligação para a fila de outro time ("Mover").

**Architecture:** o mesmo desenho da transferência (fase 2, §12.4): a rota confere e GRAVA o pedido numa linha própria (`voice_call_queue_orders`), emite um evento de usuário da ARI, e o worker relê a linha pelo id — com a organização da ligação que ele tem em memória — e revalida antes de agir. O navegador de quem clicou em "Atender" atende sozinho o toque que chega com o cabeçalho `X-Fila-Atender`.

**Tech Stack:** Postgres (migration + apêndice do `baseline.sql`), `pg`, Next.js Route Handlers, ARI (eventos de usuário), JsSIP no navegador, React 19 + TanStack Query, Vitest, Playwright (só no GitHub Actions).

Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.3). Depende das entregas 1 e 2 (a aba, `queued_at`, a ordem de chegada).

---

## Decisões de implementação

1. **A mecânica do worker mora no controlador**, não num módulo à parte: puxar e mover mexem no estado privado da fila (o ramal que toca, as voltas, o relógio). `lib/channels/telefonia/ordens-da-fila.ts` fica só com o vocabulário do evento e a leitura dele (como `lerOrdemDaTransferencia`).
2. **Quem puxa toca por 10 s** (e não 20): o navegador que clicou atende em menos de 1 s; 10 s cobrem a aba que fechou. Não atendeu → a ligação volta ao rodízio de onde estava.
3. **Derrubar o toque em curso não conta como recusa**: o canal do ramal que tocava sai do mapa ANTES de ser desligado, então o fim dele não avança o rodízio.
4. **O resultado da ordem volta por uma rota de leitura** (`GET /api/v1/telefonia/fila/ordens/[id]`), consultada pela tela por alguns segundos depois do clique — a resposta da rota da fila é compartilhada por organização e não pode levar dado de UM usuário.
5. **Só se age sobre quem espera por uma pessoa** (`queued_at` preenchido, não atendida): no menu e nos avisos a ligação não é puxada nem movida (quem não ouviu o aviso de gravação até o fim não é gravado).
6. **Mover não repete "fora do horário" nem o aviso de instabilidade** do time novo; a rota recusa time fechado, e o worker revalida.

## Regras do repositório

As do plano da entrega 2 (`docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-2.md`, seção "Regras do repositório que valem para todas as tasks") valem aqui, inteiras.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/<timestamp>_0296_telefonia_ordens_da_fila.sql`, `supabase/baseline.sql`, `MANIFEST.md` | a tabela `voice_call_queue_orders` |
| `tests/invariants/telefonia-ordens-da-fila.test.ts` | NOVO — schema, RLS, REST, os pedidos e o repositório, duas organizações |
| `tests/invariants/rls-completude-varredura.test.ts` | a tabela nova em `PROVA_PROPRIA` |
| `tests/invariants/vocabulario-banco-x-typescript.test.ts` | os CHECKs de vocabulário novos em `PARES` |
| `lib/telefonia/vocabulario.ts` | `TIPOS_DA_ORDEM_DA_FILA`, `DESFECHOS_DA_ORDEM_DA_FILA`, o leitor `acoesNaFila` do cartão |
| `lib/channels/telefonia/ordens-da-fila.ts` (+ teste) | NOVO — nome do evento, cabeçalho, `lerOrdemDaFila` |
| `lib/channels/telefonia/pedido-da-fila.ts` | NOVO — `pedirAtender`, `pedirMover`, `recusarOrdemSemWorker`, `lerOrdemDaFila` (banco) |
| `lib/channels/telefonia/repositorio.ts`, `portas.ts`, `laco.ts`, `dubles-de-teste.ts` | as portas do worker para a ordem |
| `lib/channels/telefonia/controle.ts` (+ teste) | `puxarDaFila`, `moverDeTime`, o fim da ordem |
| `app/api/v1/telefonia/chamadas/[id]/atender/route.ts`, `…/mover/route.ts`, `app/api/v1/telefonia/fila/ordens/[id]/route.ts` (+ testes) | NOVO |
| `lib/audit/actions.ts` | `phone.queue_call_pulled`, `phone.queue_call_moved` |
| `lib/telefonia/fila.ts`, `lib/channels/telefonia/fila-da-tela.ts` | `LigacaoNaFila.ordem` (a ordem aberta) |
| `components/telefonia/TelefoniaContext.tsx` | `atenderDaFila`, a fase `atendendo`, o atendimento automático |
| `components/telefonia/fila/*`, `components/telefonia/fila/useAcoesDaFila.ts` | os botões e o acompanhamento da ordem |
| `components/telefonia/CartaoDaLigacao.tsx` | as linhas "Puxada da fila por…" e "Movida de… para…" |
| `tests/e2e/telefonia-fila.spec.ts`, docs, `.changes/telefonia-agir-na-fila.md` | prova e documentação |

---

### Task 1: a migration 0296 e o invariante de schema

- [ ] Molde EXATO: o bloco da 0290 (`voice_call_transfers`) no `baseline.sql` (`grep -n "voice_call_transfers" supabase/baseline.sql`) e a migration `*_0290_telefonia_transferencia.sql` — leia os dois inteiros e imite: a criação da tabela, os CHECKs de vocabulário criados só se faltarem, o índice único parcial de "uma aberta por ligação", a RLS, os GRANTs/REVOKEs e os comentários. Confira o próximo `NNNN` livre (`ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`) e use um timestamp MAIOR que o da última migration.
- [ ] A tabela:

```sql
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
  foreign key (organization_id, to_team_id) references public.attendance_teams (organization_id, id)
    on delete set null (to_team_id),
  foreign key (organization_id, from_team_id) references public.attendance_teams (organization_id, id)
    on delete set null (from_team_id)
);
```
  CHECKs (cada um criado só se faltar, com nome próprio): `kind in ('pull','move')`; `status in ('open','ended')`; `outcome is null or outcome in ('done','refused','no_answer','cancelled')`; `(status = 'open') = (ended_at is null)`.
  Índices: único parcial `voice_call_queue_orders_uma_aberta on (voice_call_id) where status = 'open'`; e `(organization_id, voice_call_id, created_at)`.
  RLS ligada; policy de LEITURA por organização (`organization_id in (select public.fn_user_org_ids())`), com `drop policy if exists` antes; **nenhuma** policy de escrita; e `revoke insert, update, delete, truncate on public.voice_call_queue_orders from anon, authenticated;` + `revoke all … from anon;` explícitos (o default ACL do Supabase concede tudo — ver "Audit log" no `CLAUDE.md`). Sem função nova.
- [ ] O invariante `tests/invariants/telefonia-ordens-da-fila.test.ts` (molde: `tests/invariants/telefonia-transferencia.test.ts` — leia inteiro): colunas e CHECKs (cada vocabulário recusa valor de fora, `23514`); uma aberta por ligação (`23505` na segunda; depois de encerrar a primeira, a segunda entra); FK composta (ordem com `voice_call_id` de OUTRA organização é recusada); RLS: membro da organização A lê as ordens de A e nenhuma de B; `authenticated` não insere, não altera e não apaga (pela REST, com JWT); `anon` não lê; autocura do bloco do baseline (derruba um CHECK e reaplica).
- [ ] `tests/invariants/rls-completude-varredura.test.ts`: a tabela em `PROVA_PROPRIA`, apontando para o arquivo acima. `tests/invariants/vocabulario-banco-x-typescript.test.ts`: os CHECKs `kind`, `status`, `outcome` em `PARES`, espelhando como `voice_call_transfers` entrou (as constantes TypeScript vão em `lib/telefonia/vocabulario.ts`: `TIPOS_DA_ORDEM_DA_FILA = ["pull", "move"]`, `SITUACOES_DA_ORDEM_DA_FILA = ["open", "ended"]`, `DESFECHOS_DA_ORDEM_DA_FILA = ["done", "refused", "no_answer", "cancelled"]`, com os tipos).
- [ ] `pnpm test:db` do invariante novo e dos dois alterados → PASS; os guardas da tripla (os seis da Task 1 da entrega 2) → PASS. Commit com os três de `supabase/` juntos: `feat(banco): as ordens da fila do telefone — atender e mover (0296)`.

---

### Task 2: os pedidos (banco) e as rotas

**Files:** `lib/channels/telefonia/pedido-da-fila.ts`, as três rotas e os testes, `lib/audit/actions.ts`, casos novos no invariante da Task 1.

- [ ] Molde EXATO: `lib/channels/telefonia/pedido-de-transferencia.ts` e `app/api/v1/telefonia/chamadas/[id]/transferir/route.ts` (+ `route.test.ts`) — leia inteiros. A forma é a mesma: confere → grava a linha `open` → a rota emite o evento → se o evento não sai, fecha a linha como `refused`/`telefonia_indisponivel` e responde 503 → auditoria → 202.

```ts
// lib/channels/telefonia/pedido-da-fila.ts — o contrato
export type RecusaDaFila =
  | "ligacao_inexistente"      // 404 — não é desta organização, não é do telefone, não é recebida
  | "ligacao_encerrada"        // 409
  | "ligacao_ja_atendida"      // 409
  | "ligacao_fora_da_fila"     // 409 — ainda no menu ou nos avisos (`queued_at` nulo)
  | "voce_offline"             // 409 — atender: o ramal de quem pede não está registrado
  | "voce_em_ligacao"          // 409 — atender: quem pede está em outra ligação
  | "ja_ha_ordem"              // 409 — outra ordem aberta nesta ligação
  | "destino_invalido"         // 422 — mover: time de outra organização ou arquivado
  | "ja_esta_nesse_time"       // 409 — mover
  | "time_fora_do_horario";    // 409 — mover

export const MENSAGEM_DA_RECUSA_DA_FILA: Record<RecusaDaFila, string> = {
  ligacao_inexistente: "Ligação não encontrada.",
  ligacao_encerrada: "Esta ligação já acabou.",
  ligacao_ja_atendida: "Esta ligação já foi atendida.",
  ligacao_fora_da_fila: "Esta ligação ainda está no menu. Espere ela entrar na fila.",
  voce_offline: "Seu telefone não está conectado. Recarregue a página e tente de novo.",
  voce_em_ligacao: "Você está em outra ligação.",
  ja_ha_ordem: "Outra pessoa já está cuidando desta ligação.",
  destino_invalido: "Esse time não é desta organização.",
  ja_esta_nesse_time: "A ligação já está na fila desse time.",
  time_fora_do_horario: "O time está fora do horário de atendimento.",
};
export function statusDaRecusaDaFila(m: RecusaDaFila): number; // 404 | 422 | 409 conforme os comentários acima

export async function pedirAtender(db, p: { org: string; userId: string; vcId: string; online: Set<string> }):
  Promise<{ ok: true; id: string; timeId: string | null } | { ok: false; motivo: RecusaDaFila; por?: string | null }>;
export async function pedirMover(db, p: { org: string; userId: string; vcId: string; teamId: string; agora: Date }):
  Promise<{ ok: true; id: string; deTimeId: string | null } | { ok: false; motivo: RecusaDaFila; por?: string | null }>;
export async function recusarOrdemSemWorker(db, org: string, id: string): Promise<void>;
export async function lerOrdem(db, org: string, id: string):
  Promise<{ id: string; kind: "pull" | "move"; status: "open" | "ended"; outcome: string | null; reason: string | null; requested_by: string | null; to_team_id: string | null } | null>;
```

  - A ligação: `select id, status, direction, queued_at, team_id from voice_calls where id = $1 and organization_id = $2 and provider = $3` (PROVIDER de `./repositorio`); `direction <> 'inbound'` → `ligacao_inexistente`.
  - `pedirAtender`: `online.has(userId)` senão `voce_offline`; `pessoaEmLigacao(db, org, userId)` (de `./repositorio`) → `voce_em_ligacao`; `insert … (organization_id, voice_call_id, kind, requested_by, to_user_id, from_team_id) values (…, 'pull', $userId, $userId, <team da ligação>)`; `23505` → `ja_ha_ordem`, com `por` = o nome de quem pediu a ordem aberta (mesma expressão de nome de `fila-da-tela.ts`).
  - `pedirMover`: o time por `select id, schedule, archived_at from attendance_teams where id = $1 and organization_id = $2`; inexistente ou arquivado → `destino_invalido`; igual ao da ligação → `ja_esta_nesse_time`; `situacaoDaLinhaDoTime(time, agora) !== "aberto"` → `time_fora_do_horario`; `insert … kind 'move', to_team_id, from_team_id`.
- [ ] As rotas:
  - `POST /api/v1/telefonia/chamadas/[id]/atender` — `requireSupportWrite()`; `requireRole("agent", { requestId, resource: "telefonia_fila" })`; telefonia desligada → 409 `telefonia_indisponivel`; id uuid; `pedirAtender` com `online: await ramaisOnline(ari)`; recusa → `fail(motivo, mensagem, status)` (em `ja_ha_ordem` com `por`, a mensagem é `trocarMarcador(t("{nome} já está atendendo esta ligação."), "{nome}", por)`); `ari.emitirEvento(EVENTO_DA_FILA, { acao: "atender", ordem_id, voice_call_id })`; falha → `recusarOrdemSemWorker` + 503; `audit({ action: "phone.queue_call_pulled", resourceType: "voice_call", resourceId: vcId, metadata: { ordem_id, time_id } })`; `ok({ ordem_id }, { status: 202 })`.
  - `POST …/[id]/mover` — igual, com `requireRole("manager", …)`, corpo `z.object({ team_id: z.string().uuid() }).strict()`, `acao: "mover"`, auditoria `phone.queue_call_moved` com `{ ordem_id, de_time_id, para_time_id }`.
  - `GET /api/v1/telefonia/fila/ordens/[id]` — `requireRole("agent", …)`; `lerOrdem` com a organização da sessão; quem lê é quem pediu (`requested_by`) ou `manager`+, senão 404; `ok({ id, tipo, situacao, desfecho, motivo })`.
  - `lib/audit/actions.ts`: as duas ações novas no fim de `AUDIT_ACTIONS`.
- [ ] Testes de rota (molde: `transferir/route.test.ts`): papel; suporte somente-leitura; organização da sessão (um `organization_id` no corpo dá 422 pelo `.strict()`); cada recusa com status e mensagem; o evento emitido com os ids; a ARI que não responde → 503 e a linha fechada; auditoria só no sucesso. No invariante: `pedirAtender`/`pedirMover` contra Postgres real, duas organizações (ligação de B pedida por A → `ligacao_inexistente`; a corrida de duas ordens → uma `ja_ha_ordem`; cada recusa de estado).
- [ ] Cercas: `suporte-cobertura-de-efeitos`, `i18n-espanhol-cobre-a-tela` (as frases de `traduzir`), `audit-lista-do-painel-e-derivada`, `telefonia-troca-de-marcador-literal`, `ligacao-nunca-chama-elevenlabs`. Commit: `feat(telefonia): pedir para atender ou mover uma ligação da fila`.

---

### Task 3: o worker executa a ordem

**Files:** `lib/channels/telefonia/ordens-da-fila.ts` (+ teste), `repositorio.ts`, `portas.ts`, `laco.ts`, `dubles-de-teste.ts`, `controle.ts`, `controle.test.ts`, casos no invariante.

- [ ] `ordens-da-fila.ts`:

```ts
/** O evento de usuário da ARI que leva a ordem da tela para a fila (atender, mover). */
export const EVENTO_DA_FILA = "telefonia_fila";
/** O cabeçalho do toque de quem pediu para atender: o navegador que clicou atende sozinho. */
export const CABECALHO_DO_ATENDER = "X-Fila-Atender";
export const ACOES_DA_FILA = ["atender", "mover"] as const;
export type AcaoDaFila = (typeof ACOES_DA_FILA)[number];
export interface OrdemDaFilaNoEvento { acao: AcaoDaFila; ordemId: string; voiceCallId: string }
/** `null` para qualquer evento que não seja uma ordem da fila bem formada (ids limpos; o da ordem é uuid). */
export function lerOrdemDaFila(ev: EventoAri): OrdemDaFilaNoEvento | null;
/** Quanto o ramal de quem puxou toca antes de a ligação voltar ao rodízio. */
export const TOQUE_DE_QUEM_PUXOU_MS = 10_000;
```
  Teste no molde dos casos de `lerOrdemDaTransferencia` em `transferencia.test.ts` (evento certo; nome de outro evento → `null`; ids sujos → `null`; o `eventname` repetido dentro de `userevent` é ignorado).
- [ ] Repositório (+ porta, laço, dublê):
  - `ordemDaFilaAberta(db, org, vcId, id)` → `{ id, kind, requestedBy, toUserId, toTeamId } | null` (presa à organização E à ligação, só `open`);
  - `encerrarOrdemDaFila(db, org, id, { desfecho, motivo })` (só fecha a `open`);
  - `recusarOrdemDaFilaOrfa(db, id, vcId, motivo)` (a ordem chegou para uma ligação que este worker não acompanha);
  - `cancelarOrdensDaFilaAbertas(db, motivo)` (reinício do worker), e `cancelarOrdensDaLigacao(db, org, vcId, motivo)` (a ligação acabou).
  - `registrarNaConversa` passa a levar `fila: [{ tipo, por_nome, de_time, para_time }]` no registro, das ordens `done` da ligação (molde: `transferenciasDoRegistro` — nunca lança; ausente quando vazio).
  - Casos no invariante para cada uma, com a organização errada não alcançando nada.
- [ ] Controlador. Leia `tratar`, `tocarRamal`, `ramalAtendeu`, `aoDestruirCanal`, `encerrarRecebida`, `recuperar`, `tocarProximo` como estão DEPOIS da entrega 2.
  - `FilaDaLigacao` ganha `puxada: { ordemId: string; userId: string } | null` (inicial `null`).
  - `tratar`, no `ChannelUserevent`: se `lerOrdemDaFila(ev)` devolver uma ordem, `return this.aoReceberOrdemDaFila(ordem)`; senão segue para `this.transferencias.aoReceberOrdem(ev)` como hoje.
  - `aoReceberOrdemDaFila`: a ligação tem de estar em `porId`, ser `recebida`, e estar esperando por uma pessoa (`!fim && !atendidaPor && !encerrando && !ura && fila.entrouEm !== null`); senão `recusarOrdemDaFilaOrfa` (ligação desconhecida) ou `encerrarOrdemDaFila(…, refused, "ligacao_fora_da_fila" | "ligacao_ja_atendida")`. Relê `ordemDaFilaAberta(l.org, l.vcId, ordemId)` — sem ela, `warn` e nada.
  - **Atender** (`kind === "pull"`): revalida `ari.ramalOnline(toUserId)` e `!(await banco.pessoaEmLigacao(l.org, toUserId))` (recusa: `destino_offline` / `destino_em_ligacao`); já há `fila.puxada` → recusa `ja_ha_ordem`. Então:
    1. `l.fila.puxada = { ordemId, userId }`; `pararRelogio(l.fila.relogios, "reavaliar")`;
    2. se `l.fila.ramal`: guarda o canal, `l.fila.ramal = null`, `this.porCanal.delete(canal)` e SÓ ENTÃO `ari.desligar(canal).catch(…)` — o fim desse canal não acha mais a ligação e não avança o rodízio;
    3. `ari.originar({ endpoint: PJSIP/<ramal de quem puxou>, appArgs: \`oferta,${l.vcId}\`, callerId: l.numeroExibido, prazoS: TOQUE_DE_QUEM_PUXOU_MS/1000, variaveis: { "PJSIP_HEADER(add,X-Ligacao-Id)": l.vcId, "PJSIP_HEADER(add,X-Fila-Atender)": ordemId } })`; se lançar: ordem `refused`/`destino_offline`, `puxada = null`, `return this.tocarProximo(l)`;
    4. `l.fila.ramal = { canal, userId }`, `porCanal.set`, `marcarTocando(l, userId)`, e a rede de segurança `armar(l, TOQUE_DE_QUEM_PUXOU_MS + 3_000, …)` no molde de `tocarRamal`.
    - Em `ramalAtendeu`, depois de tudo o que já faz: se `l.fila.puxada`, `encerrarOrdemDaFila(…, { desfecho: "done", motivo: null })` (com `.catch` → `warn`) e `puxada = null`.
    - Em `aoDestruirCanal`, no ramo "não atendeu, recusou ou o ramal caiu": se `l.fila.puxada`, fecha a ordem como `no_answer` e zera `puxada` ANTES de seguir para `tocarProximo` (a ligação volta ao rodízio com as voltas e o teto como estavam).
  - **Mover** (`kind === "move"`): relê o time (`banco.timeParaAFila(l.org, toTeamId, agora)`); `situacao !== "aberto"` → recusa `time_fora_do_horario`. Então: derruba o toque em curso como no passo 2 acima; `banco.moverParaOTime(l.org, l.vcId, l.conversationId, toTeamId)`; `l.fila.teamId = toTeamId`, `l.fila.toque = ESTADO_INICIAL`, `l.fila.direto = null`, `l.fila.esperando = false`, `l.fila.inicioDaEspera = null`, `l.fila.tetoMs = esperaMaximaMs(entrada.esperaMaximaS)`; `banco.marcarPrazoDaFila(l.org, l.vcId, null)`; ordem `done`; `return this.tocarProximo(l)`. `entrouEm` NÃO muda (a ordem de chegada é do cliente). Se `moverParaOTime` lançar: ordem `refused`/`falha_ao_mover`, e a ligação segue no time em que estava (`tocarProximo`).
  - `encerrarRecebida`: `cancelarOrdensDaLigacao(l.org, l.vcId, "ligacao_encerrada")` (com `.catch`). `recuperar()`: `cancelarOrdensDaFilaAbertas("worker_reiniciou")`, no molde das transferências.
  - Nada disto pode derrubar nem pendurar ligação: toda escrita nova tem `.catch` → `warn`; depois de cada `await`, confira `l.fim`.
- [ ] Testes em `controle.test.ts` (o `BancoFalso` ganha `abrirOrdemDaFila(…)` como `abrirTransferencia`, e um helper `ordemDaFila(acao, ordemId, vcId)` que monta o `ChannelUserevent`): atender uma que ESPERA (toca só para quem puxou, com o cabeçalho; atendeu → ponte, ordem `done`, conversa atribuída a quem puxou); atender uma que TOCA para outro (o toque do outro é derrubado e o fim dele NÃO origina toque novo nem conta volta); quem puxou não atende em 10 s (ordem `no_answer`, a ligação volta ao rodízio); quem puxou está em ligação/offline (recusada, a ligação nem percebe); ordem para ligação já atendida, no menu, desconhecida, ou com `ordemId` que não bate no banco; o cliente desliga com a ordem aberta (`cancelled`); mover (time troca, voltas zeram, o teto novo vale, `entrouEm` igual, toca quem está livre no time novo — troque `banco.disponiveis` à mão); mover para time fechado (recusada, nada muda); `moverParaOTime` lançando (a ligação segue). Sabotagens: sem o `porCanal.delete` antes do `desligar` (o rodízio avança → vermelho); sem revalidar quem puxa; sem zerar as voltas no mover.
- [ ] `pnpm exec vitest run lib/channels/telefonia lib/telefonia` → PASS; o invariante → PASS; typecheck. Commit: `feat(telefonia): o worker atende e move ligações da fila a pedido da tela`.

---

### Task 4: a tela — atender com um clique, mover, e o cartão

**Files:** `lib/telefonia/fila.ts`, `lib/channels/telefonia/fila-da-tela.ts` (+ invariante), `components/telefonia/TelefoniaContext.tsx` (+ teste), `components/telefonia/PainelDoTelefone.tsx`, `components/telefonia/fila/*` (+ testes), `components/telefonia/fila/useAcoesDaFila.ts`, `components/telefonia/CartaoDaLigacao.tsx` (+ teste), `lib/telefonia/vocabulario.ts`, `lib/i18n/dicionario.ts`.

- [ ] **A ordem aberta na fila.** `LigacaoNaFila` ganha `ordem: { tipo: "pull" | "move"; por: PessoaDaFila | null; para_time_id: string | null } | null`; `fila-da-tela.ts` junta a ordem `open` da ligação (`left join voice_call_queue_orders o on o.organization_id = v.organization_id and o.voice_call_id = v.id and o.status = 'open'`) com o nome de quem pediu. Caso no invariante `telefonia-fila-da-tela.test.ts`.
- [ ] **O navegador atende sozinho** (`TelefoniaContext.tsx` — leia o arquivo inteiro antes):
  - `ContextoDoTelefone` ganha `atenderDaFila(ligacaoId: string): Promise<boolean>` (no valor sem provider: `async () => false`). Ela faz `POST /api/v1/telefonia/chamadas/${id}/atender`; no 202 guarda numa ref `{ ordemId, ate: Date.now() + 15_000 }` e devolve `true`; erro → `showApiError` e `false`.
  - `EstadoDaLigacao["fase"]` ganha `"atendendo"`: o toque que chega com `X-Fila-Atender` igual à ordem guardada (e dentro do prazo) nasce nessa fase e é atendido NA HORA, pelo mesmo código de `atender()` (extraia o corpo para uma função interna que recebe a sessão, em vez de duplicar). Sem a ordem guardada (outra aba, prazo vencido), o toque é o de sempre (`tocando`).
  - `PainelDoTelefone`: a fase `atendendo` mostra o painel de baixo com "Conectando…" (não o aviso de toque, e sem o som de toque). Confira todo `switch`/`Record` sobre `fase` no repositório (`grep -rn '"tocando"' components hooks lib`).
  - Teste (molde: `components/telefonia/TelefoniaContext.aviso.test.tsx` e `.ramal-por-papel.test.tsx` — veja como dublam o JsSIP): com a ordem guardada, o `newRTCSession` com o cabeçalho certo chama `answer` sem clique; com o cabeçalho de OUTRA ordem, não; sem ordem guardada, não; depois do prazo, não.
- [ ] **Os botões** (`components/telefonia/fila/`):
  - `useAcoesDaFila.ts`: `atender(ligacaoId)` (delega a `useTelefonia().atenderDaFila` e acompanha a ordem) e `mover(ligacaoId, teamId)` (`POST …/mover`). O acompanhamento: depois do 202, lê `GET /api/v1/telefonia/fila/ordens/{id}` a cada 1 s, por até 15 s, até `situacao === "ended"`; `refused`/`no_answer` viram `toast.error` com a frase do motivo (tabela `const` no MESMO arquivo, com `t`): `destino_offline` "Seu telefone não está conectado.", `destino_em_ligacao` "Você está em outra ligação.", `ligacao_encerrada` "A ligação acabou antes.", `ligacao_ja_atendida` "Outra pessoa atendeu antes.", `time_fora_do_horario` "O time está fora do horário de atendimento.", `no_answer` "Seu telefone não atendeu. A ligação voltou para a fila.", outro "Não foi possível concluir. Tente de novo."; mover com `done` → `toast.success(trocarMarcador(t("Ligação movida para {time}."), "{time}", nome))`. Depois de cada ordem, `invalidateQueries` da fila.
  - `LinhaDaFila`: deixa de ser um `<button>` inteiro (botão dentro de botão é HTML inválido): a área principal continua clicável (abre a conversa) e as ações ficam ao lado. Nas fases `aguardando` e `tocando`: **Atender** (`size="sm"`, `data-fila-atender`) para quem tem ramal (`useTelefonia().disponivel`), e **Mover** (ícone de troca, `aria-label={t("Mover para outro time")}`, `data-fila-mover`) para `manager`+ (`roleAtLeast(activeOrg.role, "manager")`), que abre um `DropdownMenu` (shadcn) com os outros times ativos da fila; cada item mostra o nome e, quando `useDiretorio()` (`components/telefonia/useDiretorio.ts`) já respondeu, "N livres". Os botões NÃO ficam desabilitados por estado (a rota responde com o motivo); ficam ocupados (`aria-busy`) enquanto o próprio pedido está em curso. Com `ligacao.ordem` aberta, no lugar dos botões: "{nome} está atendendo…" (`pull`) ou "Movendo para {time}…" (`move`).
  - Testes: os botões aparecem só nas fases certas e só para quem pode (agent sem ramal não vê Atender; agent não vê Mover; manager vê os dois); clicar chama a ação com o id; a ordem aberta troca os botões pela frase; a área principal segue abrindo a conversa.
- [ ] **O cartão.** `lib/telefonia/vocabulario.ts`: `AcaoNaFilaDaLigacao { tipo: "pull" | "move"; por_nome: string | null; de_time: string | null; para_time: string | null }` e o leitor `acoesNaFilaDaLigacao(bruto): AcaoNaFilaDaLigacao[]` (molde: `transferenciasDaLigacao` — jsonb aberto, nunca conta o que o registro não sustenta). `CartaoDaLigacao`: `MetadadoDaLigacao.fila`, lido pelo leitor; uma linha por ação, no estilo das transferências: `t("Puxada da fila por {quem}")` e `t("Movida de {de} para {para} por {quem}")` (com `trocarMarcador`; nome ausente → `t("alguém")`; time ausente → `t("outro time")`). Testes no arquivo do cartão.
- [ ] Cercas (as da Task 7 da entrega 2) + `pnpm exec vitest run components lib/telefonia hooks` → PASS; typecheck; eslint. Commit: `feat(inbox): atender e mover ligações direto da fila do telefone`.

---

### Task 5: e2e, documentação, fragmento

- [ ] `tests/e2e/telefonia-fila.spec.ts` (a spec da entrega 2): casos novos, semeados — como `agent`, a linha da fila mostra "Atender" e não "Mover"; como `manager`, os dois; com uma ordem `open` semeada, a linha mostra "{nome} está atendendo…"; o cartão de uma ligação com ordens `done` mostra "Puxada da fila por…" e "Movida de… para…". (O clique de verdade depende do Asterisk; não entra no e2e.)
- [ ] `.changes/telefonia-agir-na-fila.md` (`capacidade_nova`, `adicionado`, "Telefone — atender e mover ligações direto da fila").
- [ ] Docs: spec 20, estado atual, mapa (`rota_atender`, `rota_mover`, a tabela, com arestas reais), jornada J45, o desenho (§4.3: as decisões deste plano), e o runbook `docs/runbooks/telefonia-fila-visivel.md` com o roteiro da PROVA COM LIGAÇÃO REAL das três entregas (com duas contas `agent` e uma `manager`), que não foi feita.

---

### Task 6: verificação completa, revisão independente e PR

- [ ] Como a Task 9 da entrega 2. Foco da revisão: a ordem não derruba ligação; ninguém puxa ligação de outra organização; a corrida de dois cliques; o atendimento automático não atende o que não devia (só o toque com a ordem que ESTE navegador pediu).
