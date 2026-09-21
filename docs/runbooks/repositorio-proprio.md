# Runbook — publicar e instalar do próprio repositório

> Para quem transformou um fork do DeskcommCRM em projeto próprio: este repositório publica as
> suas imagens, corta as suas versões e é de onde as VPS instalam. Cada passo abaixo tem a
> sonda que prova que ele funcionou. Quatro deles **não cabem num PR** — dependem de tela ou de
> segredo do dono do repositório — e é por isso que este documento existe.
>
> **Executado de ponta a ponta em 2026-09-18.** A tabela diz o estado no fim daquela sessão;
> reconfira na fonte — as sondas estão aqui para isso, e foi por confiar numa nota de estado
> que a doutrina de packaging passou um dia inteiro afirmando o contrário do que valia.
>
> | Passo | Estado | Prova |
> |---|---|---|
> | 1. Pacotes públicos | feito | a sonda devolve `200` nas três em `latest`, `stable` e `1.29.0` |
> | 2. App da release | feito | `gh secret list` lista os dois; o `cortar-tag` assinou a `v1.29.0` como `deskcomm-release[bot]` |
> | 3. Imagens da versão | feito | `200` nas três em `1.29.0`; `stable` com o mesmo digest |
> | 4. Proteção da `main` | feito | `verify, build-and-size, invariants, imagens-ok` (PR #7 tirou o `paths-ignore`) |
> | 5. VPS | feito | `/api/v1/health` → `1.29.0`; contêineres em `ghcr.io/paulocmbcosta/*:1.29.0` |

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
workflow). O fork **não herda segredos**: sem `RELEASE_APP_ID` e `RELEASE_APP_PRIVATE_KEY`, o job
`cortar-tag` falha em todo push na `main`, e esse é o vermelho de
`gh run list --workflow=release.yml`.

Criar o App (uma vez, uns cinco minutos):

> https://github.com/settings/apps/new
> - **GitHub App name**: único no GitHub inteiro — `deskcomm-release` pode estar tomado; use
>   `deskcomm-release-<seu-usuário>` (o assinante do commit é fixado pelo workflow, não pelo App)
> - **Homepage URL**: a URL deste repositório
> - **Webhook**: desmarque *Active*
> - **Repository permissions**: *Contents* → Read and write; *Pull requests* → Read and write
> - *Where can this GitHub App be installed?* → Only on this account
> - **Create GitHub App** → anote o **App ID** → **Generate a private key** (baixa um `.pem`)
> - Na barra lateral, **Install App** → este repositório

Depois, no seu computador (o `.pem` não passa pelo chat e não entra no repositório). O macOS pode
recusar a leitura de `~/Downloads` pelo terminal (`operation not permitted`): mova o arquivo para
a pasta pessoal antes, ou libere a pasta em Privacidade e Segurança › Arquivos e Pastas.

```bash
gh secret set RELEASE_APP_ID --repo paulocmbcosta/DeskcommCRM --body '<App ID>'
gh secret set RELEASE_APP_PRIVATE_KEY --repo paulocmbcosta/DeskcommCRM < ~/<nome-do-app>.<data>.private-key.pem
rm ~/<nome-do-app>.<data>.private-key.pem
```

**Verificação:** `gh secret list --repo paulocmbcosta/DeskcommCRM` lista os dois. A instalação do
App não dá para listar com o token do `gh`; quem a prova é o primeiro passo de qualquer run do
`release` (`create-github-app-token`), que falha na hora se o App não estiver instalado.

Cortar a versão é o ciclo de [`../doctrine/versionamento.md`](../doctrine/versionamento.md):
*Actions → release → Run workflow* abre o PR `Release X.Y.Z`; o merge dele — **com commit de
merge, nunca squash**: o `cortar-tag` lê o assinante do segundo pai, que tem de ser o App — cria
a tag `vX.Y.Z`, publica as três imagens em `X.Y.Z` e move `stable`. Para ver o número que sairia,
sem escrever:

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

O GitHub não copia branch protection num fork. Sem ela, "checks obrigatórios" é prosa — o merge
depende de quem mergeia. Em repositório público a proteção está disponível no plano Free.

**Antes de exigir um check, garanta que ele roda em todo push.** `ci.yml` e `perf.yml` tinham
`paths-ignore` para `docs/**`, `**/*.md` e `.changes/**` (PR #5, para poupar a cota de Actions de
quando o repositório era privado). Check obrigatório que não roda num PR só de prosa deixa esse PR
**travado para sempre**, porque o GitHub não conta check ausente como verde. Repositório público
tem Actions sem cota nos runners padrão, então o filtro saiu (PR #7). Se ele voltar, a proteção
tem de sair junto.

`e2e` fica de fora: desde o PR #9 ele não roda em PR (só no push na `main` e por `Run workflow`),
e check exigido que não roda trava o PR.

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
`origin` apontando para lá, e o `agent.sh` (cron a cada 5 minutos) busca as tags **de lá** — e a
origem continua lançando versões. Este passo já dizia "trocar o remoto basta". Não basta. Três
armadilhas, todas pagas em 2026-09-18:

1. **As tags da origem já estão no clone.** A VPS tinha `v1.29.0` a `v1.32.1` da origem, buscadas
   pelo cron. A nossa `v1.29.0` aponta para outro commit, então o `fetch` recusa (`would clobber
   existing tag`) — e, se não recusasse, o `update.sh` escolheria a `v1.32.1` da origem e
   instalaria **o produto de lá**. Apague as tags que não batem com o remoto antes de buscar.
2. **O `update.sh` que roda é o do kit ANTIGO.** Ele carrega `_common.sh` na memória antes do
   `git checkout` da tag nova, e o `IMG_NS` ali ainda é o namespace da origem: ele grava no `.env`
   e puxa `ghcr.io/melgarafael/*:1.29.0`, que existe e é público. Medido: a VPS subiu com o
   produto da origem sobre o nosso banco por sete minutos, saudável no `docker ps`. Por isso,
   **na migração**, o `git checkout` da tag vem **antes** do `update.sh`: é o que põe o kit novo
   no disco, com o `IMG_NS` certo.

   ⚠️ **Este item afirmava que, feito o checkout, o `update.sh` "detecta 'código na versão,
   imagem antiga'". Era falso com a imagem fixada em número de versão** — que é como toda
   instalação fica. Medido em 2026-09-19, no deploy da v1.32.0: código em `v1.32.0`, `.env` em
   `:1.31.1` (`pull_policy=missing`), e a resposta foi "Você já está na versão mais recente. Nada
   a atualizar.", com exit 0 e os três contêineres na 1.31.1. A sonda comparava o digest local da
   imagem fixada com o digest remoto **da mesma referência** — a imagem antiga contra ela mesma,
   iguais por definição. Ela só enxergava defasagem em canal móvel (`latest`). Quem atualizou foi
   `update.sh --to v1.32.0 --force`.

   O kit corrigido compara o que o `.env` fixa com o que a atualização gravaria — a **referência
   inteira**, namespace incluído, que é exatamente o que esta migração precisa: uma
   `ghcr.io/<origem>/deskcommcrm:1.29.0` não passa por "em dia" só porque o número coincide. Mas
   quem decide é o kit **da tag em que você fez o checkout**, não o desta página:

   ```bash
   grep -c 'imagens_fora_do_alvo' hostgator-setup-kit/_common.sh   # 0 = kit anterior à correção
   ```

   Com `0` — toda tag até a `v1.32.0` —, o `update.sh` sem argumento responde "Nada a atualizar"
   com a versão antiga no ar. Use `bash hostgator-setup-kit/update.sh --to <tag> --force`: ele faz
   o backup do mesmo jeito. Vigiado por `tests/shell/update-guard.test.sh`, caso 12.
3. **`drop trigger` no `job_queue` deadlocka com o worker de pé.** O `baseline.sql` recria os
   triggers dessa tabela, e a primeira aplicação avisou `deadlock detected`; a segunda passou.
   Confira os triggers depois (abaixo) e, se faltar algum, rode o `update.sh` de novo.

Só depois dos passos 1 e 3 (imagens públicas e existentes na versão), na VPS:

```bash
cd /root/DeskcommCRM
cp .env ".env.bak-$(date +%F-%H%M)"
git remote set-url origin https://github.com/paulocmbcosta/DeskcommCRM.git
# tags locais que não existem no remoto, ou apontam para outro commit: fora
git ls-remote --tags --refs origin | awk '{print $1, $2}' | sed 's#refs/tags/##' | sort > /tmp/tags-remoto
git for-each-ref --format='%(objectname) %(refname:short)' refs/tags | sort > /tmp/tags-local
for t in $(comm -23 /tmp/tags-local /tmp/tags-remoto | awk '{print $2}'); do git tag -d "$t"; done
git fetch --tags origin
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -1)"   # o kit NOVO fica no disco ANTES do update
bash hostgator-setup-kit/update.sh                                # backup, banco, imagens deste repositório, up
# Respondeu "Nada a atualizar" com os contêineres na versão antiga? O kit desta tag é anterior à
# correção (armadilha 2). Saída:  bash hostgator-setup-kit/update.sh --to <tag> --force
```

**Esta é a receita da MIGRAÇÃO, não a de rotina.** Depois que o kit no disco já é o deste
repositório, atualizar é um comando só, **sem `git checkout` antes**: o `update.sh` busca as tags,
escolhe a mais nova e troca o código ele mesmo — depois do backup, que é a ordem que ele foi
desenhado para garantir. O checkout prévio não compra nada na rotina, e foi o que armou a
resposta falsa da v1.32.0.

```bash
cd /root/DeskcommCRM
nohup bash hostgator-setup-kit/update.sh > /root/deskcomm-update.log 2>&1 < /dev/null &
```

Nada de `sed` no `.env` nem de `latest`/`always`: o `update.sh` grava as três imagens pinadas em
`X.Y.Z` com `pull_policy=missing`, que é o que a doutrina exige de uma instalação. Use o
`update.sh`, não `docker compose` à mão: a função `dc()` escolhe os arquivos de compose pelo perfil
da instalação (nesta VPS o proxy é o Caddy do próprio stack, e `-f docker-compose.traefik.yml`
seria errado). Rodando por SSH sem ninguém no terminal, dispare com `nohup … > log 2>&1 &` e leia
o log — e nunca `pkill -f <trecho-do-comando>`: o padrão casa com a própria sessão SSH e a derruba.

**Verificação:**

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep deskcomm          # as três em ghcr.io/paulocmbcosta/*:X.Y.Z
curl -s https://<DOMÍNIO>/api/v1/health | jq -r '.data.version'      # X.Y.Z
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMÍNIO>/           # 307, nunca 404
grep -E '^(APP|WORKER|SCHEDULER)_(IMAGE|PULL_POLICY)=' .env          # pinadas em X.Y.Z, missing
set -a; . ./.env; set +a; . hostgator-setup-kit/_common.sh
docker run --rm postgres:17-alpine psql "$(url_do_schema)" -Atc \
  "select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.job_queue'::regclass"
```

Rollback: `bash hostgator-setup-kit/update.sh --to v1.28.0 --force` (a tag existe aqui também).
Para voltar ao remoto antigo, `git remote set-url origin` de volta.

## O que este runbook não resolve

- **As falhas herdadas do `e2e`.** Ele não roda mais em PR (PR #9); roda no push na `main` e por
  `Run workflow`. Até ficar verde de forma estável e voltar a `synchronize`, não entra na proteção.
- **A cota de Actions.** Público = runners padrão sem cota. Se o repositório voltar a ser privado,
  o `paths-ignore` e a concorrência do PR #5 voltam a importar, e o passo 4 precisa ser revisto.
- **Os sete minutos de produto da origem.** Entre o primeiro `update.sh` e a correção, o app, o
  worker e o scheduler da origem (1.29.0 de lá) rodaram sobre este banco. O schema é o nosso
  (aplicado pelo nosso `baseline.sql`), mas o que aquele worker processou naquela janela foi com a
  lógica de lá. Nenhum sintoma medido; fica registrado para quem investigar algo estranho datado
  de 2026-09-18 entre 00:33 e 00:40.
