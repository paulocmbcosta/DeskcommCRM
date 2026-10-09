# Repositório fechado: o que cada VPS precisa, e a ordem de fechar

> **Para quem é.** Quem vai tornar o repositório e as imagens **privados**, ou instalar/atualizar
> uma VPS depois disso. Enquanto o repositório for público, nada aqui é necessário.
>
> **O risco que este runbook existe para evitar.** Fechar o repositório sem preparar as VPSs
> não derruba nada na hora — o sistema continua no ar. O que acontece é pior: a VPS **para de
> receber versão nova**, e a única pista é a tela de atualização dizendo que não conseguiu
> checar. A correção de segurança seguinte não chega.

Para saber em que estado o repositório e os pacotes estão **agora**, em vez de acreditar neste
arquivo:

```bash
gh repo view paulocmbcosta/DeskcommCRM --json visibility --jq .visibility
for img in deskcommcrm deskcomm-worker deskcomm-scheduler deskcomm-asterisk; do
  tok=$(curl -fsS "https://ghcr.io/token?scope=repository:paulocmbcosta/$img:pull&service=ghcr.io" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  echo "$img: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' "https://ghcr.io/v2/paulocmbcosta/$img/manifests/stable")"
done
```

`200` = a imagem baixa **sem login** (pacote público). `401`/`403` = privado.

---

## 1. Por que são duas credenciais, e não uma

A VPS fala com o GitHub por **dois caminhos diferentes**, e cada um tem a sua fechadura:

| O que a VPS busca | Quem busca | Fechadura |
|---|---|---|
| O código e as tags (para saber que há versão nova e trazer o kit dela) | `git fetch`, no `agent.sh` (a cada 5 min) e no `update.sh` | **chave de deploy** do repositório |
| As imagens Docker | `docker compose pull`, no `update.sh` | **login no registro** (`docker login ghcr.io`) |

E **fechar o repositório não fecha as imagens**: a visibilidade de cada pacote do GHCR é
separada. A imagem do worker carrega o código inteiro (`COPY . .` em `Dockerfile.worker`) —
repositório privado com pacote público continua expondo tudo.

---

## 2. Preparar uma VPS (faça com o repositório AINDA público)

Tudo abaixo roda **na VPS, como o usuário que roda o kit** (root, na instalação padrão). Com o
repositório ainda público, cada passo pode ser conferido sem risco: se a credencial estiver
errada, o caminho antigo continua funcionando.

### 2.1 Chave de deploy (código)

```bash
ssh-keygen -t ed25519 -N '' -C "deploy-$(hostname)" -f ~/.ssh/deskcomm_deploy
cat ~/.ssh/deskcomm_deploy.pub
```

Cadastre a chave **pública** no repositório, **só leitura** — pela tela (Settings › Deploy keys ›
Add deploy key, sem marcar "Allow write access") ou, da sua máquina:

```bash
gh api -X POST repos/paulocmbcosta/DeskcommCRM/keys \
  -f title="VPS <nome do cliente>" -f key="<a linha que o cat mostrou>" -F read_only=true
```

Uma chave **por VPS**: quando um cliente sai, você revoga a dele sem tocar nas outras.

De volta à VPS, diga ao SSH qual chave usar e registre a identidade do GitHub. **Sem o
`known_hosts` o cron falha**: o `agent.sh` não tem terminal para responder "yes" à pergunta de
primeira conexão.

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/deskcomm_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
ssh-keygen -lf ~/.ssh/known_hosts | grep github.com
```

Confira a impressão digital que o último comando mostra com a que o GitHub publica em
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>
antes de seguir. Depois, aponte o clone para o endereço por SSH e prove:

```bash
cd /root/DeskcommCRM            # a pasta da instalação
git remote set-url origin git@github.com:paulocmbcosta/DeskcommCRM.git
GIT_TERMINAL_PROMPT=0 git fetch --tags origin && echo "codigo: ok"
```

### 2.2 Login no registro (imagens)

O GHCR **não aceita chave de deploy**: precisa de um token **clássico** com um escopo só,
`read:packages` (GitHub › Settings › Developer settings › Personal access tokens › Tokens
(classic)). Esse token é da **conta**, não do repositório: ele lê todos os pacotes que a conta
enxerga. Se isso for mais do que você quer deixar numa VPS de cliente, crie uma conta de máquina
com acesso de leitura só a estes pacotes e gere o token nela.

Quem digita o token é **uma pessoa**, no terminal da VPS — ele não vai para chat, `.env` nem
arquivo do repositório:

```bash
docker login ghcr.io -u <usuário do GitHub>      # cola o token quando ele pedir a senha
```

O Docker guarda a credencial em `~/.docker/config.json`. É a **mesma** que o `docker compose pull`
usa e que o instalador lê para sondar o registro (`credencial_do_registro`, em `_common.sh`) — a
sonda mede o caminho que o `pull` vai percorrer.

### 2.3 Conferir os dois caminhos

```bash
cd /root/DeskcommCRM
GIT_TERMINAL_PROMPT=0 git ls-remote --tags origin 'v*' | tail -1          # código
bash -c '. hostgator-setup-kit/_common.sh; for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
  echo "$i: $(ghcr_status "$i" stable)"; done'                             # imagens: 200 nas três
```

Com o repositório ainda público, `200` aparece com ou sem login — então confira também que o
login **está** guardado: `grep -c '"ghcr.io"' ~/.docker/config.json` tem de responder `1`.

---

## 3. A ordem de fechar

1. **Toda VPS preparada e conferida** (seção 2), com o repositório ainda público.
2. **Nenhuma release no meio do caminho.** Entre fechar o repositório e fechar os pacotes, a
   conferência do fim da release reprova (ver a seção 5).
3. **Fechar o repositório**: Settings › General › Danger Zone › Change visibility › Private.
4. **Fechar os quatro pacotes**, um por um: perfil › Packages › *pacote* › Package settings ›
   Change visibility › Private. Só pela tela — a API devolve `Not Found` para isso (medido em
   2026-09).
5. **Conferir de fora**, de uma máquina sem login: os comandos do topo deste arquivo têm de
   responder `PRIVATE` e `401`/`403` nas quatro imagens.
6. **Conferir em cada VPS**: os dois comandos da seção 2.3 de novo. Agora eles só passam com as
   credenciais — é a prova de verdade.

---

## 4. Instalar uma VPS nova com o repositório fechado

O atalho `curl … comecar.sh | bash` deixa de funcionar (o arquivo não é mais público). O caminho:

1. Seção 2.1 na VPS nova (chave de deploy), **antes** de clonar.
2. Seção 2.2 (login no registro).
3. Clonar por SSH e instalar:

```bash
git clone --depth 1 git@github.com:paulocmbcosta/DeskcommCRM.git /root/DeskcommCRM
cd /root/DeskcommCRM
bash hostgator-setup-kit/install.sh
```

Para descobrir a última versão, o instalador pergunta primeiro ao endereço público; como ele
recusa, pergunta à **origem do próprio clone** — que é o endereço por SSH que acabou de
responder. Não é preciso exportar `REPO_URL`. Se nenhum dos dois responder, ele instala pelo
canal `stable` e avisa.

Sem o login do passo 2, o instalador diz *"As imagens existem, mas este servidor não tem
permissão para baixá-las"* e mostra o comando.

---

## 5. O que cada sintoma quer dizer

| Onde aparece | O que diz | Causa | Conserto |
|---|---|---|---|
| Tela **Configurações › Atualização**, por horas | "Não consegui checar se há versão nova" | o `git fetch` da VPS está sendo recusado | seção 2.1 |
| `update.sh` | "o GitHub RECUSOU o acesso deste servidor ao repositório" | a chave de deploy falta ou foi revogada | seção 2.1 |
| `update.sh` | "Você está na versão mais recente QUE ESTE SERVIDOR CONHECE" | o mesmo, ou rede fora: ele não conseguiu consultar | seção 2.1, ou esperar a rede |
| `update.sh` | "Não consegui puxar a imagem do APP" | falta o login no registro, ou o token venceu | seção 2.2 |
| `install.sh` | "As imagens existem, mas este servidor não tem permissão para baixá-las" | falta o login no registro | seção 2.2 |
| Fim do workflow `release` | "O repositório é PRIVADO, mas estas imagens baixam SEM login" | pacote ficou público | seção 3, passo 4 |
| Fim do workflow `release`, depois de 30 min | "a tag foi criada, mas as imagens não apareceram" com o repositório **público** | pacote ficou privado antes do repositório | fechar o repositório também |

A conferência do fim da release decide **como** perguntar ao registro pela visibilidade do
repositório (`github.event.repository.private`): público pergunta como anônimo, privado pergunta
com login. Não há variável para ligar no dia de fechar.

---

## 6. O que muda no GitHub ao fechar (conta gratuita)

- **Não existe proteção de branch** em repositório privado no plano gratuito. As quatro
  verificações obrigatórias da `main` deixam de ser exigidas pelo GitHub e passam a valer só
  por combinado. O plano Pro devolve a proteção.
- **As Actions passam a ter franquia**: 2.000 minutos por mês (3.000 no Pro), e a máquina
  privada tem metade dos núcleos da pública. O que foi feito para caber, e quanto custa cada
  release, está no cabeçalho de `.github/workflows/ci.yml` e em
  `docs/doctrine/versionamento.md`, §"A cadência".
- Para medir o consumo: Settings › Billing and plans › Plans and usage › Actions.

---

## 7. Voltar atrás

Tornar o repositório e os pacotes públicos de novo é o caminho inverso da seção 3, e as VPSs
continuam funcionando: a chave de deploy e o login servem para repositório público também. O que
**não** volta é o que foi publicado enquanto era público — quem clonou ou baixou uma imagem
antes continua com a cópia.

---

## O que este runbook não resolve

- **O token do registro vence ou é revogado.** Nada avisa antes: a VPS descobre no `pull` da
  atualização seguinte. Não há, no kit, uma conferência periódica desse login.
- **Docker com cofre de credenciais** (`credsStore`): a credencial não fica no `config.json`, o
  instalador não a enxerga e sonda o registro como anônimo. O `docker compose pull` funciona; a
  escolha de versão na instalação é que cai no canal móvel. Não é o padrão de uma VPS Linux.
- **O caminho com login da conferência da release nunca rodou num repositório privado** até a
  primeira release depois de fechar. Com o repositório público ele roda como informação a cada
  release (linhas `[informação]` no log do passo) — leia uma antes de fechar.
