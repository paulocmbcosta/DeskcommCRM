# Runbook — publicar e instalar do próprio repositório

> Para quem transformou um fork do DeskcommCRM em projeto próprio: este repositório publica as
> suas imagens, corta as suas versões e é de onde as VPS instalam. Cada passo abaixo tem a
> sonda que prova que ele funcionou. Quatro deles **não cabem num PR** — dependem de tela ou de
> segredo do dono do repositório — e é por isso que este documento existe.
>
> Estado medido em 2026-09-18, ao ser escrito. Não confie nas afirmações: rode as sondas.

## A sonda

O `_common.sh` já sabe onde as imagens moram (`IMG_NS`) e como perguntar ao GHCR sem confundir
`401` de token com "não existe":

```bash
source hostgator-setup-kit/_common.sh
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
  echo "$i latest: $(ghcr_status "$i" latest)   stable: $(ghcr_status "$i" stable)"
done
# 200 = existe e é pública | 404 = não existe | 403 = existe e é PRIVADA | 000 = sem rede
```

## 1. Tornar os três pacotes públicos (tela, uma vez)

Todo pacote nasce privado no GHCR, e **repositório público não muda isso**. Enquanto for privado,
o `docker compose pull` de toda VPS é negado, e o `update.sh` para no passo de subir.

**Não há API para isto.** Medido em 2026-09-18:
`gh api -X PATCH user/packages/container/<pacote> -f visibility=public` devolve `Not Found` — o
endpoint não existe —, enquanto o `GET` do mesmo caminho devolve erro de escopo. Não é falta de
permissão, é falta de endpoint; um handoff anterior afirmava o contrário.

Para cada um de `deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler`:

> https://github.com/users/paulocmbcosta/packages/container/`<pacote>`/settings
> → **Danger Zone** → **Change visibility** → **Public** (digite o nome do pacote para confirmar)

Aproveite e ligue **Inherit access from repository**: o pacote passa a seguir a permissão do
repositório em vez de uma lista própria. O label `org.opencontainers.image.source` dos três
Dockerfiles aponta para este repositório, então a partir do próximo build o GHCR liga o pacote ao
repositório sozinho.

**Verificação:** a sonda acima devolve `200` nas três em `latest`.

Alternativa, se quiser mantê-los privados: `docker login ghcr.io -u paulocmbcosta` na VPS com um
PAT clássico de `read:packages`. É um segredo a mais rodando numa máquina de cliente, num projeto
open source. Público é o caminho.

## 2. A release sai do CI, e o CI precisa de um App

`release.yml` abre o PR de release e cria a tag com o token de um **GitHub App**, nunca com o
`GITHUB_TOKEN` (tag criada por ele não dispara `publish-image.yml`; a razão está no cabeçalho do
workflow). O fork **não herda segredos**: o job `cortar-tag` falha em todo push na `main` por não
achar `RELEASE_APP_ID` e `RELEASE_APP_PRIVATE_KEY`, e esse é o vermelho de
`gh run list --workflow=release.yml`.

Criar o App (uma vez, uns cinco minutos):

> https://github.com/settings/apps/new
> - **GitHub App name**: `deskcomm-release` (ou outro — o assinante do commit é fixado pelo workflow, não pelo App)
> - **Homepage URL**: a URL deste repositório
> - **Webhook**: desmarque *Active*
> - **Repository permissions**: *Contents* → Read and write; *Pull requests* → Read and write
> - *Where can this GitHub App be installed?* → Only on this account
> - **Create GitHub App** → anote o **App ID** → **Generate a private key** (baixa um `.pem`)
> - Na barra lateral, **Install App** → este repositório

Depois, no seu computador (o `.pem` não passa pelo chat e não entra no repositório):

```bash
gh secret set RELEASE_APP_ID --repo paulocmbcosta/DeskcommCRM --body '<App ID>'
gh secret set RELEASE_APP_PRIVATE_KEY --repo paulocmbcosta/DeskcommCRM < ~/Downloads/deskcomm-release.*.private-key.pem
rm ~/Downloads/deskcomm-release.*.private-key.pem
```

**Verificação:** `gh secret list --repo paulocmbcosta/DeskcommCRM` lista os dois.

Cortar a versão é o ciclo de [`../doctrine/versionamento.md`](../doctrine/versionamento.md):
*Actions → release → Run workflow* abre o PR `Release X.Y.Z`; o merge dele cria a tag `vX.Y.Z`,
publica as três imagens em `X.Y.Z` e move `stable`. Para ver o número que sairia, sem escrever:

```bash
pnpm release:conferir
```

**Sem o App** dá para cortar da máquina: `pnpm release:cortar`, commit, PR, merge, e então
`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z` daqui — tag empurrada por pessoa dispara
o `publish-image.yml` normalmente. O que se perde: o `cortar-tag` fica vermelho no push da `main`
(ele exige o assinante do App), a release do GitHub não é criada, e ninguém confere as três
imagens antes de dizer "publicado". Serve para uma emergência, não para o ciclo.

## 3. As imagens da versão existem?

```bash
V=$(pnpm -s exec tsx scripts/cortar-release.ts --versao-do-changelog)
source hostgator-setup-kit/_common.sh
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do echo "$i $V: $(ghcr_status "$i" "$V")"; done
# esperado: 200 nas três
```

## 4. Recriar a proteção da `main`

O GitHub não copia branch protection num fork. Aqui ela **não existe**: o comando que o
`CLAUDE.md` manda rodar devolve `Branch not protected`. Sem ela, "cinco checks obrigatórios" é
prosa — o merge depende de quem mergeia. Em repositório público a proteção está disponível no
plano Free.

**Antes de exigir um check, garanta que ele roda em todo push.** `ci.yml` e `perf.yml` têm
`paths-ignore` para `docs/**`, `**/*.md` e `.changes/**` (PR #5 deste repositório, para poupar a
cota de Actions de quando ele era privado). Check obrigatório que não roda num PR só de prosa
deixa esse PR **travado para sempre** — o próprio `ci.yml` avisa. Repositório público tem Actions
sem cota nos runners padrão, então o motivo do `paths-ignore` já não vale: tire-o dos dois arquivos
no mesmo PR em que ligar a proteção, ou não exija `verify`, `build-and-size` e `invariants`.

`e2e` fica de fora até voltar a rodar em `synchronize` (dívida declarada em `e2e.yml`): um check
exigido que só roda no `opened` bloqueia o PR no segundo push.

```bash
gh api -X PUT repos/paulocmbcosta/DeskcommCRM/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["verify", "build-and-size", "invariants", "imagens-ok"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`strict: false` é deliberado e é o que a origem usava: o CI testa a branch, não o resultado do
merge. `enforce_admins: false` deixa o dono passar por cima numa emergência — e cada vez fica no
log de auditoria do repositório.

**Verificação:**

```bash
gh api repos/paulocmbcosta/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

## 5. A VPS que veio do repositório de origem passa a acompanhar este

Uma instalação feita a partir do repositório de origem tem o clone em `/root/DeskcommCRM` com
`origin` apontando para lá, e o `agent.sh` (cron a cada 5 minutos) anuncia na tela as versões
**de lá**. O `update.sh` faz `git checkout` da tag mais nova do `origin` e regrava as três imagens
a partir do `IMG_NS` do kit **daquela tag** — então trocar o remoto basta: a primeira versão
cortada aqui já traz o kit com o namespace deste repositório.

Só depois dos passos 1 e 3 (imagens públicas e existentes na versão), na VPS:

```bash
cd /root/DeskcommCRM
git remote set-url origin https://github.com/paulocmbcosta/DeskcommCRM.git
git fetch --tags origin
bash hostgator-setup-kit/update.sh
```

Nada de `sed` no `.env` nem de `latest`/`always`: o `update.sh` grava as três imagens pinadas em
`X.Y.Z` com `pull_policy=missing`, que é o que a doutrina exige de uma instalação. Use o
`update.sh`, não `docker compose` à mão: a função `dc()` escolhe os arquivos de compose pelo perfil
da instalação (nesta VPS o proxy é o Caddy do próprio stack, e `-f docker-compose.traefik.yml`
seria errado).

**Verificação:**

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep deskcomm          # as três em ghcr.io/paulocmbcosta/*:X.Y.Z
curl -s https://<DOMÍNIO>/api/v1/health | jq -r '.data.version'      # X.Y.Z
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMÍNIO>/           # 307, nunca 404
grep -E '^(APP|WORKER|SCHEDULER)_(IMAGE|PULL_POLICY)=' .env          # pinadas em X.Y.Z, missing
```

Rollback: `bash hostgator-setup-kit/update.sh --to v1.28.0 --force` (a tag existe aqui também).
Para voltar ao remoto antigo, `git remote set-url origin` de volta.

## O que este runbook não resolve

- **As falhas herdadas do `e2e`.** Até ficarem verdes e o `synchronize` voltar, `e2e` não entra
  na proteção.
- **A cota de Actions.** Público = runners padrão sem cota. Se o repositório voltar a ser privado,
  o `paths-ignore` e a concorrência do PR #5 voltam a importar, e o passo 4 precisa ser revisto.
