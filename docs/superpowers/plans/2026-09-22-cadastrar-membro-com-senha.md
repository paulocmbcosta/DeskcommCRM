# Cadastrar membro com senha — plano de implementação

> Execução inline na mesma sessão (dono ausente). Spec:
> `docs/superpowers/specs/2026-09-22-cadastrar-membro-com-senha-design.md`.

**Goal:** o admin cadastra um membro da equipe já com senha, sem depender de e-mail, e redefine a
senha dele quando preciso.

**Architecture:** a lógica mora em `lib/team/cadastro-direto.ts` (duas funções puras sobre o client
service-role); as rotas só autenticam, validam e traduzem o resultado. O vínculo reusa
`fn_accept_team_invite`. Sem migration.

**Tech Stack:** Next.js Route Handlers, Supabase Auth admin API, Zod, React Query, Vitest,
Playwright.

## Mapa de arquivos

| arquivo | papel |
|---|---|
| `lib/schemas/team.ts` | `cadastrarMembroSchema`, `definirSenhaSchema` |
| `lib/team/cadastro-direto.ts` | `cadastrarMembroComSenha()`, `definirSenhaDoMembro()` |
| `lib/audit/actions.ts` | `member.created`, `member.password_set` no fim do array |
| `app/api/v1/team/members/route.ts` | `POST` — cadastro |
| `app/api/v1/team/[user_id]/password/route.ts` | `POST` — nova senha |
| `hooks/team/useCadastrarMembro.ts`, `hooks/team/useDefinirSenha.ts` | mutações |
| `lib/team/gerar-senha.ts` | senha aleatória legível (crypto.getRandomValues) |
| `app/app/team/invite/_components/CadastroComSenhaForm.tsx` | formulário + cartão de acesso |
| `app/app/team/invite/page.tsx` | abas Cadastrar / Convidar |
| `app/app/team/_components/TeamMembersClient.tsx` | ação "Definir nova senha" + diálogo |
| `app/app/team/page.tsx` | botão "Adicionar membros" |
| `lib/i18n/dicionario.ts` | espanhol das frases novas |
| `tests/unit/team-cadastro-com-senha.test.ts` | rota de cadastro contra handler real |
| `tests/unit/team-definir-senha.test.ts` | rota de nova senha |
| `tests/e2e/equipe-cadastro-com-senha.spec.ts` | prova pela tela |
| `tests/e2e/interface-por-vinculo.spec.ts` | clicar na aba de convite antes |
| `docs/testing/user-journey-map.md` | jornada nova |
| `docs/architecture/*` | se houver mapa da equipe, somar as arestas |
| `.changes/<slug>.md` | fragmento `capacidade_nova` |

## Tarefas

1. **Schemas + vocabulário de auditoria.** Zod: `full_name` 2..120 trim, `email`, `password`
   min 8 max 72 (limite do bcrypt), `role`, `interface_settings` opcional com o mesmo refine do
   convite. Commit.
2. **Teste vermelho da rota de cadastro** (`tests/unit/team-cadastro-com-senha.test.ts`):
   403 para não-admin; 503 sem service role; 409 `ja_membro`; 409 `conta_existente` sem chamar
   `updateUserById`; 422 senha curta; sucesso chama `createUser` com `email_confirm: true`,
   `fn_accept_team_invite` com a org do cookie, fecha `team_invites` pendente, audita
   `member.created` sem a senha em lugar nenhum; falha no RPC apaga o usuário criado.
3. **Implementação** de `cadastrarMembroComSenha` + rota. Verde. Sabotar (tirar a compensação,
   pôr a senha na metadata) e ver vermelho. Commit.
4. **Teste vermelho da rota de senha**: si mesmo → 400; alvo fora da org → 404; revogado → 409;
   alvo com vínculo ativo em outra org → 409 sem `updateUserById`; admin de plataforma → 403;
   sucesso chama `updateUserById` e audita `member.password_set` sem a senha.
5. **Implementação** de `definirSenhaDoMembro` + rota. Verde + sabotagem. Commit.
6. **UI**: hooks, gerador de senha, formulário com cartão de acesso, abas na página, ação no menu
   do membro, dicionário `es`. `pnpm typecheck && pnpm lint`. Commit.
7. **Gates**: `pnpm test:unit` inteiro (exit code é a autoridade), `pnpm build`.
8. **Prova pela tela**: banco fresco do `baseline.sql` + `bootstrap-owner`, `next build/start`,
   spec Playwright nova (cadastrar → sair → entrar como o membro → redefinir → entrar com a nova).
   Evidência em `.superpowers/evidence/`. Rodar também `invite-lifecycle` e `interface-por-vinculo`.
9. **Docs**: mapa de jornadas, fragmento `.changes/`, `docs/architecture` se couber.
10. **PR → 4 checks → merge → release → VPS** (o dono pediu produção nesta mensagem). Conferir
    `app.dyper.com.br/api/v1/health` na versão nova.
