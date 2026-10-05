# Janela de encerramento — plano de implementação

> **Para quem executa:** siga tarefa a tarefa, na ordem. Cada tarefa termina com
> commit próprio. Desenho: `docs/superpowers/specs/2026-10-05-janela-de-encerramento-design.md`.

**Objetivo:** trocar o `confirm()` do encerramento por uma janela que registra
assunto (cadastrado por time) e resumo no atendimento, com números em Métricas.

**Arquitetura:** o registro mora em `atendimentos` (duas colunas) e os assuntos em
`atendimento_assuntos`. A regra de obrigatoriedade vive numa RPC `security definer`
(`fn_atendimento_encerrar`), que é a porta única das duas rotas que encerram. A tela
só consome.

**Stack:** Postgres (migration 0293 + apêndice do baseline), Next.js Route Handlers,
Zod, React 19 + react-query, Vitest, Playwright.

**Onde cada teste roda** (decisão do dono, 2026-09-29): nesta máquina só `typecheck`,
`lint` e Vitest de recorte, sob Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`).
`test:unit` inteiro, `test:db`, `build` e imagens rodam nos checks do PR; e2e por
`gh workflow run e2e.yml --ref <branch>`.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261005230000_0293_encerramento_assunto_e_resumo.sql` | tabela, colunas, índice, 5 funções, gatilho LGPD |
| `supabase/baseline.sql` | o mesmo bloco, rotulado, **antes** da VARREDURA anon |
| `supabase/migrations/MANIFEST.md` | linha da 0293 |
| `lib/database.types.ts` | tabela, colunas e funções novas |
| `lib/atendimento/encerramento.ts` | constantes (mín. 10, máx. 2000, nome 60), `motivoDaRecusa(mensagem)` e tipos da janela |
| `lib/schemas/settings.ts` | `encerramentoDoAtendimento(settings)` + `encerramentoWriteSchema` |
| `lib/schemas/messaging.ts` | `closeConversationSchema`; `patchConversationSchema` ganha `assunto_id` e `resumo` |
| `lib/audit/actions.ts` | `atendimento.assunto_salvo`, `atendimento.assunto_arquivado`, `atendimento.encerramento_configurado` |
| `app/api/v1/conversations/[id]/close/route.ts` | chama `fn_atendimento_encerrar`, traduz recusas em 422 |
| `app/api/v1/conversations/_handler.ts` | status terminal pelo PATCH usa a mesma RPC |
| `app/api/v1/atendimentos/assuntos/route.ts` | o que a janela precisa: interruptores + times com assuntos |
| `app/api/v1/settings/teams/[id]/assuntos/route.ts` e `[assuntoId]/route.ts` | cadastro |
| `app/api/v1/metrics/assuntos/route.ts` + `lib/metrics/assuntos.ts` | números; a função pura agrupa as linhas da RPC |
| `app/actions/settings/definirEncerramento.ts` | grava os interruptores |
| `app/api/v1/contacts/[id]/atendimentos/route.ts`, `app/api/v1/atendimentos/_handler.ts` | `AtendimentoResumo` com `assunto` e `closure_summary` |
| `lib/lgpd/export-collector.ts` | atendimentos do titular na exportação |
| `components/inbox/EncerrarAtendimentoDialog.tsx` + `hooks/inbox/useOpcoesDeEncerramento.ts` | a janela |
| `components/inbox/ConversationHeader.tsx`, `InboxLayout.tsx`, `InboxKeyboardShortcuts.tsx` | abrir a janela no lugar do `confirm()` |
| `components/times/AssuntosDoTime.tsx` + `components/times/useAssuntosDoTime.ts` | cadastro por time |
| `app/app/settings/atendimento/_encerramento.tsx` | cartão dos interruptores |
| `components/inbox/PainelDaConversa.tsx`, `AtendimentosFechadosList.tsx`, `lib/inbox/eventos-da-conversa.ts` | onde o registro aparece |
| `app/app/metrics/_components/AssuntosPanel.tsx` | o painel |

---

## Tarefa 1 — Banco (migration 0293)

- [ ] Escrever a migration, idempotente e portável (sem `BEGIN`, sem temp table):
  - `atendimento_assuntos` conforme §4.1 da spec; RLS + policy `tenant_isolation_atendimento_assuntos_select` (só leitura);
    `revoke all ... from public, anon, authenticated, service_role` e `grant select to authenticated, service_role`.
  - `alter table atendimentos add column if not exists assunto_id / closure_summary`; FK e CHECK em bloco `do $$ ... exception when duplicate_object`.
  - `create index if not exists atendimentos_org_fechamento on atendimentos(organization_id, closed_at) where closed_at is not null`.
  - `fn_save_atendimento_assunto(p_org uuid, p_team uuid, p_assunto uuid, p_name text) returns jsonb`
    — portões iguais aos de `fn_save_attendance_team`; erros `assunto_forbidden` (42501),
    `assunto_mfa_required` (42501), `assunto_invalid_name` (22023), `assunto_team_not_found` (P0002),
    `assunto_not_found` (P0002); nome repetido no time → 23505, exceto arquivado, que é reativado.
  - `fn_archive_atendimento_assunto(p_org uuid, p_assunto uuid, p_arquivar boolean) returns jsonb`.
  - `fn_atendimento_encerrar(p_org uuid, p_conversation uuid, p_expected bigint, p_actor uuid, p_assunto uuid, p_resumo text, p_status text default 'closed') returns public.conversations`
    — passos 1 a 8 do §5.1; `p_status` em `('closed','resolved','archived')`, senão `invalid_status` (22023).
  - `fn_metricas_de_assuntos(p_org uuid, p_from timestamptz, p_to timestamptz) returns table (assunto_id uuid, assunto_nome text, assunto_team_id uuid, assunto_team_nome text, atendimento_team_id uuid, atendimento_team_nome text, total bigint)`.
  - `fn_redigir_encerramentos_do_contato_anonimizado()` + `trg_redigir_encerramentos_ao_anonimizar`.
  - Todo `create function` seguido de `revoke execute ... from public, anon` (+ `authenticated` nas de serviço) e do `grant` mínimo.
- [ ] Copiar o bloco para `supabase/baseline.sql`, rotulado `-- ---- encerramento: assunto por time e resumo (migration 0293) ----`, imediatamente antes de `-- ---- VARREDURA anon`.
- [ ] Linha no `MANIFEST.md`.
- [ ] `lib/database.types.ts`: tabela nova, duas colunas em `atendimentos`, quatro funções em `Functions`.
- [ ] Rodar `pnpm exec vitest run tests/unit/manifest-x-migrations.test.ts tests/unit/baseline-no-piso-do-postgres.test.ts` → verde.
- [ ] Commit: `feat(banco): assunto por time e resumo no encerramento (0293)`.

## Tarefa 2 — Invariantes do banco

- [ ] `tests/invariants/encerramento-com-assunto-e-resumo.test.ts` (molde: `atendimentos-protocolo-e-linha-do-tempo.test.ts`), casos:
  1. vizinho lê zero linhas de `atendimento_assuntos`; ninguém escreve pela REST (insert como `authenticated` → `permission denied`);
  2. `agent` não cadastra (`assunto_forbidden`); `manager` cadastra; nome repetido → 23505; nome arquivado → reativa o mesmo `id`;
  3. encerrar com interruptores desligados e sem campos → fecha, `assunto_id` e `closure_summary` nulos;
  4. `exigir_assunto` ligado, sem assunto → `encerramento_assunto_obrigatorio` e a conversa **segue aberta**;
  5. `exigir_assunto` ligado e nenhum assunto cadastrado → fecha;
  6. `exigir_resumo` ligado, resumo de 9 letras → `encerramento_resumo_obrigatorio`; com 10 → fecha;
  7. assunto de outra organização e assunto arquivado → `encerramento_assunto_invalido`;
  8. fecha com assunto e resumo → colunas gravadas, `closed_by_user_id` é o ator, evento `closed` traz `assunto` e **não** traz o resumo;
  9. reabrir (`fn_service_status_com_ator(..., 'open', ..., true)`) e fechar sem campos com os dois interruptores ligados → fecha e preserva o registro;
  10. anonimizar o contato (`update contacts set is_anonymized = true`) → `closure_summary` nulo, `assunto_id` preservado;
  11. `fn_metricas_de_assuntos` conta por assunto e separa os sem assunto; período fora não conta; a organização vizinha não entra.
- [ ] Registrar as peças novas onde as varreduras pedem (`rls-completude-varredura`, `lgpd-cascata-alcanca-quem-guarda-pessoa`) — o próprio `test:db` do PR aponta o que faltar.
- [ ] Commit: `test(invariantes): encerramento com assunto e resumo`.

## Tarefa 3 — Contratos em TypeScript

- [ ] `lib/atendimento/encerramento.ts` com teste ao lado: `RESUMO_MINIMO = 10`, `RESUMO_MAXIMO = 2000`, `NOME_DO_ASSUNTO_MAXIMO = 60`; `motivoDaRecusa("encerramento_resumo_obrigatorio") → { campo: "resumo", motivo: "obrigatorio" }` e as outras três; mensagem desconhecida → `null`.
- [ ] `lib/schemas/settings.ts`: `ENCERRAMENTO_PADRAO = { exigir_assunto: false, exigir_resumo: false }`, `encerramentoWriteSchema` (estrito), `encerramentoDoAtendimento(settings)` (nunca lança). Teste: lixo e ausência leem o padrão.
- [ ] `lib/schemas/messaging.ts`: `closeConversationSchema`; `patchConversationSchema` com `assunto_id` e `resumo` opcionais.
- [ ] `lib/audit/actions.ts`: as três ações.
- [ ] `lib/inbox/eventos-da-conversa.ts`: `AtendimentoResumo` ganha `assunto: { id, nome, time } | null` e `closure_summary: string | null`; o caso `closed` acrescenta "Setor › Assunto" ao detalhe. Atualizar `tests/unit/eventos-da-conversa.test.ts`.
- [ ] Commit: `feat(encerramento): contratos e schemas`.

## Tarefa 4 — Rotas

- [ ] `POST /conversations/[id]/close`: valida com `closeConversationSchema`, chama `fn_atendimento_encerrar`; `22023` com mensagem `encerramento_*` → `422 validation_failed` + `details`; `40001` → 409; audita com `metadata: { assunto_id, com_resumo }`. Teste de rota ao lado (mock do admin client, molde de `team/route.test.ts`).
- [ ] `_handler.ts` do PATCH: status terminal passa pela mesma RPC com `p_status`; demais status seguem em `fn_service_status_com_ator`.
- [ ] `GET /api/v1/atendimentos/assuntos` (agent+): lê settings da organização da sessão e os assuntos ativos de times ativos pelo client do usuário.
- [ ] `settings/teams/[id]/assuntos` (GET lista com arquivados, POST cria) e `[assuntoId]` (PATCH `{ name? , archived? }`): `requireSupportWrite`, `requireRole("manager")`, `mfaEmDivida`, RPC pelo client do usuário, auditoria. Testes de rota: `organization_id` no corpo é 422; mapeamento dos códigos.
- [ ] `lib/metrics/assuntos.ts` (pura, com teste): agrupa as linhas da RPC em `{ total, sem_assunto, times: [{ id, nome, total, assuntos: [{ id, nome, total, de_outro_time }] }] }`. `GET /api/v1/metrics/assuntos` (manager+), período máximo de 92 dias.
- [ ] `definirEncerramento` (molde de `definirReguaDeEspera`), grava só `settings.atendimento.encerramento`.
- [ ] As duas rotas de listagem de atendimentos embutem o assunto e o resumo.
- [ ] `lib/lgpd/export-collector.ts`: seção de atendimentos.
- [ ] Commit: `feat(encerramento): rotas`.

## Tarefa 5 — Telas

- [ ] `useOpcoesDeEncerramento` + `EncerrarAtendimentoDialog` (props: `conversation`, `atendimento`, `open`, `onOpenChange`). Regras: setor inicial = time do atendimento se ele tiver assunto; trocar de setor limpa o assunto; erro do servidor (`details.campo`) aparece no campo; `Ctrl/Cmd+Enter` envia; grupo → só confirmação. Teste de componente cobrindo as regras.
- [ ] `ConversationHeader` recebe `onEncerrar` e o botão "Fechar" o chama; `InboxLayout` guarda o estado da janela e a renderiza uma vez; o atalho `e` abre a mesma janela (sai o `confirm()` dos dois lugares).
- [ ] `AssuntosDoTime` em `app/app/settings/teams/_client.tsx`, abaixo de cada time ativo.
- [ ] Cartão `EncerramentoForm` em `app/app/settings/atendimento/page.tsx`.
- [ ] `PainelDaConversa`: campos "Assunto" e "Resumo" na ficha; assunto e resumo em cada item de "Atendimentos anteriores". `AtendimentosFechadosList`: assunto no card.
- [ ] `AssuntosPanel` em `MetricsClient`, só com `canCompare`.
- [ ] Dicionário de espanhol para toda frase nova (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).
- [ ] Commit por tela.

## Tarefa 6 — Registro e prova

- [ ] `.changes/janela-de-encerramento.md` (`impacto: capacidade_nova`); `pnpm release:conferir`.
- [ ] `docs/testing/user-journey-map.md`: jornada J41; `docs/architecture/`: peça nova com arestas.
- [ ] `tests/e2e/encerrar-com-assunto-e-resumo.spec.ts` e registro em `.github/workflows/e2e.yml` (`SPECS_PARTE_*`).
- [ ] `pnpm typecheck`, `pnpm lint`, Vitest dos arquivos tocados.
- [ ] Push, PR em rascunho, ler os 4 checks; `gh workflow run e2e.yml --ref <branch>` e comparar as falhas com a `main`.
- [ ] Revisão independente (segurança e multi-tenant) por subagente, sobre o diff.
- [ ] Parar e pedir autorização para mesclar, cortar a release e atualizar a VPS fora do horário de atendimento.
