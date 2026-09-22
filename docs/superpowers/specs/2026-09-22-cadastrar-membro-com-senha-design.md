# Cadastrar membro da equipe com senha — design

> 2026-09-22 · pedido do dono: "cadastrar um membro da equipe e, ao invés de receber o convite,
> eu já cadastrasse a senha dele aqui dentro". Dono ausente durante a execução; as decisões
> abaixo foram tomadas sem ele e estão escritas para serem revistas.

## O problema

Hoje a única porta de entrada na equipe é o convite: token HMAC + linha em `team_invites` +
e-mail pelo provedor de e-mail. Numa instalação sem e-mail configurado (o caso da produção do
dono e de toda VPS recém-instalada, já que `RESEND_API_KEY` é opcional), o convite vira um link
que o administrador copia de uma tela marcada "(DEV)" e manda por fora; a pessoa abre, cria a
conta, confirma o e-mail (que também não chega) — burocracia com becos.

## O que muda

1. **Cadastro direto** — `/app/team/invite` ganha duas abas: **Cadastrar com senha** (padrão) e
   **Convidar por e-mail** (o formulário de hoje, intacto). O cadastro pede nome, e-mail, senha
   (mín. 8, botão "Gerar senha", mostrar/ocultar), papel e áreas permitidas. Um por vez: cada
   pessoa tem a sua senha.
2. **Resultado com os dados de acesso** — depois de cadastrar, a tela mostra endereço de login,
   e-mail e a senha digitada, com "Copiar dados de acesso". A senha **nunca volta da API**: é a
   que está no formulário, no browser de quem digitou.
3. **Definir nova senha** — no menu de ações de cada membro (aba Membros), só para admin. Sem
   e-mail configurado, "esqueci a senha" não funciona; sem esta ação, a pessoa que esquece a senha
   fica presa para sempre (a conta existe, então nem recadastrar dá). É o laço de retorno da
   feature (invariante 7).

## Rotas

### `POST /api/v1/team/members`

Body `{ full_name, email, password, role, interface_settings? }` (Zod). Guardas: suporte em
modo leitura barra (`requireSupportWrite`), `requireRole("admin")`, service role obrigatório
(503 `unavailable` sem ele — é o que cria usuário no provedor de auth).

1. E-mail com vínculo ATIVO na organização → 409 `state_conflict` ("já é membro").
2. `auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } })`.
   - E-mail já cadastrado → 409 `state_conflict` com motivo `conta_existente`: **não** mexe na
     senha de uma conta que já existe (ela pode pertencer a outra organização da instalação — um
     admin trocaria a senha de alguém de fora e entraria no lugar dele). A mensagem aponta os dois
     caminhos: "Devolver acesso" se a pessoa já foi da equipe; convite por link se não.
   - Senha recusada pela política do provedor → 422 com a mensagem dele.
3. Vínculo via `fn_accept_team_invite` (a MESMA função do aceite): org do cookie, papel e áreas do
   body validado, `invited_by` = quem cadastrou, `issued_at = now()`. Mesma semântica de entrega:
   se quem cadastra é o criador provisório e o papel é `admin`, ele sai da organização — e a
   resposta diz isso (`entregue: true`) para a tela não quebrar no próximo clique.
   - Falha no vínculo → apaga o usuário recém-criado (compensação) e 500. Sem isso sobraria uma
     conta órfã e o recadastro cairia em "conta existente".
4. Convite pendente para o mesmo e-mail nesta org é fechado (`accepted_at`, `accepted_by`) — senão
   a aba Membros lista "Pendente" para quem já está dentro.
5. Audita `member.created` (`target_user_id`, `email`, `role`). **Senha nunca vai para metadata,
   log ou resposta.**

Resposta 201 `{ data: { user_id, email, full_name, role, entregue, login_url } }`.

### `POST /api/v1/team/[user_id]/password`

Body `{ password }`. Guardas: suporte, `requireRole("admin")`, service role.

- Não vale para si mesmo (400): trocar a própria senha pela API de admin pula a verificação de
  sessão forte e o MFA de quem troca.
- Alvo precisa ter vínculo ATIVO nesta org (404 / 409 se revogado).
- Alvo **não pode ter vínculo ativo em outra organização** nem ser admin de plataforma (409 /
  403): nesses casos trocar a senha daria a um admin desta org a conta de alguém que também
  responde a outra. Numa instalação de uma organização só isto nunca bloqueia.
- `auth.admin.updateUserById(id, { password })`; política recusou → 422.
- Audita `member.password_set` (`target_user_id`). Sem a senha.

## O que NÃO entra

- Troca da própria senha pela pessoa logada (não existe tela para isso hoje, com ou sem esta
  feature). Fica como tarefa separada.
- Obrigar troca de senha no primeiro login — o pedido é justamente menos burocracia.
- Encerrar sessões abertas do membro ao redefinir a senha: a API de admin do cliente JS não
  oferece isso por id. Quem precisa tirar alguém de dentro na hora usa "Revogar acesso".
- Migration: nenhuma. Tudo reaproveita `fn_accept_team_invite`, `team_invites` e o provedor de auth.

## Prova

- Unit contra o Route Handler real (auth e Supabase mockados): cada guarda, a compensação, o
  fechamento do convite, a auditoria sem senha.
- E2E pela tela num banco fresco do `baseline.sql`: admin cadastra um membro com senha, sai, entra
  como o membro com a senha definida e vê o app; admin redefine a senha e o membro entra com a nova.
