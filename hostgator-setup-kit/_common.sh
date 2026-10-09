#!/usr/bin/env bash
# Helpers compartilhados pelos scripts do kit. Sourced, não executado direto.
set -euo pipefail

COMPOSE="docker-compose.prod.yml"
COMPOSE_TRAEFIK="docker-compose.traefik.yml"
COMPOSE_NPM="docker-compose.npm.yml"

# Proxy reverso desta instalação. Vem do .env (load_env), com default 'caddy' —
# ou seja, toda instalação que já existe continua exatamente como está.
#
#   caddy   → o kit sobe o próprio Caddy nas portas 80/443 (VPS "cru")
#   traefik → a VPS JÁ tem um Traefik nessas portas (Hostinger, Coolify,
#             Dokploy...). Entra o override, que desliga o Caddy e publica o app
#             por labels. Ver o cabeçalho de docker-compose.traefik.yml.
#   npm     → a VPS JÁ tem um Nginx Proxy Manager nessas portas (não lê labels
#             Docker — o roteamento é manual, na UI dele). Entra o override, que
#             desliga o Caddy e garante o `app` na rede/IP que o Proxy Host
#             espera. Ver o cabeçalho de docker-compose.npm.yml.
#
# Todo `docker compose` do kit passa por aqui: com proxy externo, um comando sem
# o override subiria o Caddy e ele iria bater de frente com o proxy da hospedagem.
dc() {
  case "${REVERSE_PROXY:-caddy}" in
  traefik) docker compose -f "$COMPOSE" -f "$COMPOSE_TRAEFIK" "$@" ;;
  npm)     docker compose -f "$COMPOSE" -f "$COMPOSE_NPM" "$@" ;;
  *)       docker compose -f "$COMPOSE" "$@" ;;
  esac
}

# A mesma lista de -f, como texto, para as mensagens que ensinam o comando ao
# dono. Se a mensagem omitisse o override numa instalação com proxy externo, o
# próprio dono derrubaria o site seguindo a instrução do kit.
dc_files() {
  case "${REVERSE_PROXY:-caddy}" in
  traefik) printf -- '-f %s -f %s' "$COMPOSE" "$COMPOSE_TRAEFIK" ;;
  npm)     printf -- '-f %s -f %s' "$COMPOSE" "$COMPOSE_NPM" ;;
  *)       printf -- '-f %s' "$COMPOSE" ;;
  esac
}

# ── A rede externa por onde o proxy de fora alcança o app ────────────────────
# O nome que o docker compose dá ao projeto quando ninguém passa -p: basename do
# diretório, minúsculo, só [a-z0-9_-] — E com os `_`/`-` do INÍCIO aparados
# (NormalizeProjectName faz TrimLeft). Sem essa aparada, uma pasta como
# `/root/_deskcomm` faz o kit calcular `_deskcomm` enquanto os contêineres
# carregam `deskcomm`: a instalação deixa de se reconhecer e passa a se tratar
# como intrusa. Medido contra o docker compose v2.38.2 em `_deskcomm`,
# `-deskcomm`, `_-_crm` e `_123` — todos divergiam.
nome_do_projeto_compose() {  # nome_do_projeto_compose <diretório>
  local n
  n="$(basename "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  printf '%s' "${n#"${n%%[!_-]*}"}"
}

nome_do_projeto_atual() {
  printf '%s' "${COMPOSE_PROJECT_NAME:-$(nome_do_projeto_compose "${PROJECT_DIR:-$PWD}")}"
}

# ── Quem é o DONO deste projeto Docker ───────────────────────────────────────
#
# Duas cópias do repo na mesma VPS — o clone de produção e um de teste ao lado —
# recebem o MESMO nome de projeto compose: o docker o deriva do basename do
# diretório, e `/root/DeskcommCRM` e `/root/apagar6/DeskcommCRM` dão os dois
# `deskcommcrm`. Os contêineres são UM conjunto só; os `.env` são dois. Cada
# `up -d` recria o parque com as credenciais da SUA árvore, e a outra fica
# falando com um transporte que não a reconhece mais.
#
# Não é hipótese. Numa VPS real o clone de teste recriou o contêiner do WhatsApp
# com a chave dele às 13:30; o app foi recriado da árvore de produção às 14:47,
# com outra chave; e por TRÊS DIAS toda chamada ao WAHA respondeu 401 — nenhum
# número conectava, nenhuma mensagem entrava, e o painel só dizia "não foi
# possível verificar a conexão".
#
# O `flock` do agent.sh não protege disso: ele é por DIRETÓRIO, então as duas
# árvores pegam locks diferentes enquanto disputam os mesmos contêineres. A
# trava tem de ser pelo que elas de fato compartilham — o projeto Docker.
#
# O sinal é o próprio Docker: todo contêiner criado pelo compose carrega o label
# `com.docker.compose.project.working_dir` com a árvore que o criou.
donos_do_projeto_em_execucao() {  # → um diretório por linha, sem repetir
  docker ps -a \
    --filter "label=com.docker.compose.project=$(nome_do_projeto_atual)" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
    | grep -v '^$' | sort -u
}

# Imprime as árvores ALHEIAS que ainda são instalações VIVAS; sai 0 quando existe
# ao menos uma. Sem contêiner no ar não há dono, e uma instalação nova assume
# legitimamente — por isso o silêncio aqui é "pode seguir", não "não sei".
#
# "Viva" é o filtro que impede este guarda de nascer vermelho em quem não fez
# nada de errado: quem MOVEU a instalação de pasta deixa contêineres apontando
# para um caminho que não existe mais. Esse não é um rival disputando o parque —
# é o endereço antigo desta mesma instalação, e recusar ali travaria as
# atualizações para sempre, num log que ninguém lê. Só conta como rival a árvore
# que ainda está no disco COM um compose: aquela de onde um segundo cron
# realmente consegue rodar `up -d`.
projeto_pertence_a_outra_arvore() {
  local dir vivas=""
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ "$dir" != "${PROJECT_DIR:-$PWD}" ] || continue
    [ -f "$dir/$COMPOSE" ] || continue
    vivas="${vivas}${vivas:+$'\n'}${dir}"
  done <<EOF
$(donos_do_projeto_em_execucao)
EOF
  [ -n "$vivas" ] || return 1
  printf '%s' "$vivas"
}

# O guarda que o agent.sh e o update.sh chamam antes de tocar em contêiner.
#
# Falha FECHADA na ação (não mexe em parque alheio) e ABERTA na informação: diz
# qual árvore é a dona e como assumir de propósito. Parar calado deixaria o dono
# da VPS achando que o agente atualiza, quando ele desiste a cada 5 minutos.
#
# `DESKCOMM_ASSUMIR_PROJETO=1` é a saída para o caso legítimo — a instalação
# mudou de pasta e os contêineres ainda apontam para a antiga. É explícita de
# propósito: assumir por engano é justamente o defeito que esta função existe
# para impedir.
recusar_projeto_de_outra_arvore() {  # recusar_projeto_de_outra_arvore <como reportar>
  local alheias reportar="${1:-}"
  alheias="$(projeto_pertence_a_outra_arvore)" || return 0
  [ "${DESKCOMM_ASSUMIR_PROJETO:-}" != "1" ] || return 0

  local recado
  recado="os contêineres do projeto '$(nome_do_projeto_atual)' foram criados por outra cópia do repo ($(printf '%s' "$alheias" | tr '\n' ' ')) — esta aqui é $(printf '%s' "${PROJECT_DIR:-$PWD}"). Duas cópias com o mesmo nome de projeto disputam os MESMOS contêineres e cada uma os recria com o .env dela, o que derruba as conexões de WhatsApp e quebra as credenciais. Deixe apenas UMA no cron (crontab -e) ou, se esta é mesmo a instalação boa, rode com DESKCOMM_ASSUMIR_PROJETO=1"
  if [ -n "$reportar" ] && command -v "$reportar" >/dev/null 2>&1; then
    "$reportar" "$recado"
  else
    printf '%s\n' "$recado" >&2
  fi
  return 1
}

# A bridge que ESTE projeto reserva para o proxy externo. Um `basename` cru
# diverge numa pasta com maiúscula, ponto ou underscore inicial — e aí o kit
# cria uma rede e o compose procura outra.
rede_reservada_do_proxy() { printf '%s_proxy' "$(nome_do_projeto_atual)"; }

# O compose declara TRAEFIK_NETWORK como rede EXTERNA, e rede externa que não
# existe é recusada ANTES de o compose criar qualquer coisa — medido com o
# compose v2.38.2: `up -d` morre em "network X declared as external, but could
# not be found", sem dizer de onde saiu o nome. Descobrir isso aqui, com o nome na
# mão, é dezenas de minutos de diferença para quem está instalando. Valor escrito
# à mão no .env passa pelo mesmo crivo: erra tão fácil quanto a detecção.
#
# A rede que o instalador reserva para si é o caso em que não existir é NORMAL —
# instalação nova, ou alguém que rodou `docker network prune`. Aí a resposta é
# criar, não morrer: o nome é nosso e sabemos a forma dele.
# Ecoa: ok | criar | inexistente | driver_errado
veredito_rede_do_proxy() {  # veredito_rede_do_proxy <driver encontrado> <rede> <bridge do projeto> [attachable]
  local drv="${1:-}" rede="${2:-}" nossa="${3:-}"
  if [ -z "$drv" ]; then
    [ -n "$nossa" ] && [ "$rede" = "$nossa" ] && { printf 'criar'; return 0; }
    printf 'inexistente'; return 0
  fi
  [ "$drv" = bridge ] && { printf 'ok'; return 0; }
  # $4 = "true" quando a rede é uma overlay attachable (Swarm). Contêiner de
  # compose comum entra numa dessas, então ela serve tão bem quanto uma bridge.
  # Sem o attachable a recusa continua: ali o `up` morreria em
  # "could not attach to network".
  [ "$drv" = overlay ] && [ "${4:-}" = true ] && { printf 'ok'; return 0; }
  printf 'driver_errado'
}

# Aplica o veredito acima: confere no Docker, cria a nossa quando falta, morre
# explicando quando é de outro. Mora aqui — e não no install.sh — porque o
# `dc up -d` do update.sh corre exatamente o mesmo risco: a bridge é um artefato
# como qualquer outro e some num `docker network prune`, ou no `down -v` que o
# próprio kit ensina como caminho de recomeço. Sem esta checagem a atualização
# morre com a mesma mensagem opaca do compose, e pior: o agent.sh roda o
# update.sh sozinho a cada 5 minutos, então ninguém está olhando a tela.
# Define TRAEFIK_NETWORK quando ela vem vazia — de propósito, é o mesmo default
# que o instalador grava no .env.
garantir_rede_do_proxy() {
  # NPM nunca é criado por nós: a rede é sempre do stack do Proxy Manager (ou de
  # quem hospeda), então não há "nossa" bridge para oferecer — só checar e, se
  # sumiu (prune, down -v), morrer explicando em vez do opaco erro do compose.
  if [ "${REVERSE_PROXY:-caddy}" = "npm" ]; then
    local rede
    rede="${PROXY_NETWORK_NAME:-proxy_network}"
    docker network inspect "$rede" >/dev/null 2>&1 && return 0
    die "A rede Docker '$rede' (a do Nginx Proxy Manager) não existe.
Rode 'docker network ls', identifique a rede do seu NPM (Settings > a que o
contêiner dele já está conectado) e ponha PROXY_NETWORK_NAME=<nome> no .env
antes de tentar de novo."
  fi
  [ "${REVERSE_PROXY:-caddy}" = "traefik" ] || return 0
  local nossa drv erro
  nossa="$(rede_reservada_do_proxy)"
  TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-traefik}"
  drv="$(docker network inspect -f '{{.Driver}}' "$TRAEFIK_NETWORK" 2>/dev/null || true)"
  local att
  att="$(docker network inspect -f '{{.Attachable}}' "$TRAEFIK_NETWORK" 2>/dev/null || true)"
  case "$(veredito_rede_do_proxy "$drv" "$TRAEFIK_NETWORK" "$nossa" "$att")" in
  ok) : ;;
  criar)
    # O motivo vai junto porque aqui NÃO se sabe qual é: o comando está certo, e
    # quem recusou foi o Docker (falta de faixa de IP livre numa VPS com muitas
    # stacks é um caso conhecido). Sem repassar a resposta dele, a mensagem
    # mandaria repetir à mão o comando que acabou de falhar.
    if ! erro="$(docker network create "$TRAEFIK_NETWORK" 2>&1 >/dev/null)"; then
      die "Não consegui criar a rede Docker '$TRAEFIK_NETWORK'. O Docker respondeu:
  ${erro}"
    fi
    c_dim "  (rede '$TRAEFIK_NETWORK' criada — é por ela que o Traefik alcança o CRM)"
    ;;
  inexistente)
    die "A rede Docker '$TRAEFIK_NETWORK' não existe.
Rode 'docker network ls', identifique a rede do seu Traefik e ponha
TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo."
    ;;
  driver_errado)
    # Mandar quem está em modo host "procurar a rede do seu Traefik" é mandar
    # procurar o que não existe: em modo host ele não está em rede nenhuma do
    # Docker. Para esse caso a saída é apagar a linha e deixar o kit decidir —
    # ele cria a bridge do projeto sozinho.
    die "A rede '$TRAEFIK_NETWORK' tem driver '$drv', e o app precisa
de uma bridge para o Traefik alcançar o contêiner. Se o seu Traefik roda em modo
host (é o caso quando 'docker ps' não mostra porta publicada nele), APAGUE a linha
TRAEFIK_NETWORK do .env: o kit cria e usa a rede '$nossa'.
Senão, rode 'docker network ls' e ponha a bridge certa em TRAEFIK_NETWORK no .env.
Se for uma overlay do Swarm, ela precisa ter sido criada com --attachable —
sem isso um contêiner de compose comum não consegue entrar nela."
    ;;
  esac
}

# Cor só quando há terminal de verdade — mesma regra do install.sh (se mexer
# numa, mexa na outra). Aqui isso vale dobrado: o update.sh, que herda estas
# funções, é rodado pelo agent.sh com a saída redirecionada para arquivo
# (`> "$LOG"`) a cada 5 minutos, para sempre, em toda instalação. Era daí que
# vinha o escape ANSI que o esc() do agent.sh precisa varrer byte a byte antes
# de mandar o log no heartbeat; não emitir na origem é a correção de causa.
if   [ -n "${NO_COLOR:-}" ];    then COLOR=0
elif [ -n "${FORCE_COLOR:-}" ]; then COLOR=1
elif [ -t 1 ];                  then COLOR=1
else                                 COLOR=0
fi
paint() { local code="$1"; shift; if [ "$COLOR" = 1 ]; then printf '\033[%sm%s\033[0m\n' "$code" "$*"; else printf '%s\n' "$*"; fi; }
c_red() { paint 31 "$*"; }
c_grn() { paint 32 "$*"; }
c_ylw() { paint 33 "$*"; }
c_dim() { paint 2  "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n'; paint 1 "▶ $*"; }

# Gêmea da de install.sh (se mexer numa, mexa na outra) — ver o comentário lá
# para o defeito que ela fecha. Coberta por test-validators.sh.
resposta_sim() {
  local r
  r="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$r" in s|sim|y|yes) return 0;; *) return 1;; esac
}

# Saúde do app pela rota que ele responde de verdade, não pela porta. A porta
# 3000 aceita conexão assim que o Node sobe — ANTES de o app saber se alcança
# banco, Redis e WhatsApp. Era exatamente a diferença entre o install.sh, que
# testava a porta e imprimia "Instalação concluída!" mesmo sem resposta, e o
# update.sh, que só declara sucesso com "status":"ok". Um critério, um lugar.
# Devolve DUAS linhas: o status GERAL na primeira, o corpo inteiro na segunda.
#
# A separação existe porque procurar '"status":"ok"' no JSON cru é errado, e
# erra em silêncio: `ok` é o vocabulário dos CHECKS individuais
# (ok|degraded|down), enquanto o status geral usa outro (healthy|degraded|
# unhealthy). Medido contra o app real: um `grep '"status":"ok"'` casa com o
# `checks.redis`, então um app com o BANCO FORA — status geral "unhealthy" —
# passava como saudável, desde que qualquer outro check estivesse de pé. Quem
# decide é o app, no Node que já está sendo invocado; o shell não repete a
# regra dele.
app_health_probe() {
  dc exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(j=>{console.log((j&&j.data&&j.data.status)||'sem_status');console.log(JSON.stringify(j))}).catch(()=>process.exit(1))" \
    2>/dev/null || echo ''
}

# wait_app_healthy [tentativas] [intervalo_s] — 0 quando o app se declara
# `healthy` ou `degraded`, 1 caso contrário. `degraded` entra de propósito:
# significa que algum serviço OPCIONAL ainda não foi configurado (o check
# devolve degraded/not_configured), e recusar a instalação por isso reprovaria
# um CRM que está de pé e atendendo. `unhealthy` é outra história — quer dizer
# check DOWN, e aí o app não serve. Ecoa o corpo lido, para quem chama poder
# mostrar o motivo em vez de só dizer que não deu.
wait_app_healthy() {
  local tentativas="${1:-20}" intervalo="${2:-3}" saida='' status='' corpo='' i=0
  while [ "$i" -lt "$tentativas" ]; do
    saida="$(app_health_probe)"
    status="$(printf '%s\n' "$saida" | head -1 | tr -d '\r')"
    corpo="$(printf '%s\n' "$saida" | tail -n +2)"
    case "$status" in
      healthy|degraded) printf '%s' "$corpo"; return 0;;
    esac
    i=$((i+1))
    [ "$i" -lt "$tentativas" ] && sleep "$intervalo"
  done
  printf '%s' "$corpo"
  return 1
}

# Código de saída de quem RECUSOU antes de tocar em qualquer coisa — distinto
# de "falhei no meio" (1). O agent.sh usa isso para não desfazer uma
# atualização que nunca começou: reiniciar o container e reescrever o .env
# "voltando" de uma mudança que não houve é estrago inventado do nada.
REFUSED_RC=3
refuse() { c_red "✖ $*"; exit "$REFUSED_RC"; }

# Instalar <ref> seria voltar no tempo? 0 = sim (já está contido no HEAD),
# 1 = não, 2 = NÃO SEI. "Não sei" nunca vira "pode".
#
# O install.sh clona com `--depth 1`, e num repositório raso o
# `merge-base --is-ancestor` responde 1 (não-ancestral) para QUALQUER coisa
# fora do único commit baixado — inclusive para uma tag velha que, na história
# real, está muito atrás. Ou seja: a resposta que libera é exatamente a que o
# raso dá de graça, e `git fetch --tags` não desfaz o raso (conferido: depois
# do fetch, is-shallow-repository continua true). Por isso completamos a
# história ANTES de perguntar, e, se não der, devolvemos 2 — o chamador
# recusa. Falhar fechado é o certo num script que roda como root na máquina de
# quem não sabe consertar.
is_already_in_head() {
  local ref="$1"
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" = "true" ]; then
    git fetch --unshallow --tags --quiet origin 2>/dev/null || true
  fi
  case "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" in
    false) : ;;
    *) return 2 ;;   # ainda raso, ou nem é repositório git: não dá pra saber
  esac
  git merge-base --is-ancestor "$ref" HEAD 2>/dev/null && return 0
  return 1
}

# Carrega o .env lendo cada linha como DADO, sem `source`.
#
# O `. ./.env` interpretava o arquivo como script, e aí qualquer valor de texto
# livre virava código: `APP_NAME=Loja do João` fazia o shell tentar executar
# `do`; uma senha com `#` era truncada no que parecia comentário; uma com `$`
# era expandida e chegava corrompida. Como TODO script do kit passa por aqui,
# um nome de empresa com espaço — ou seja, quase todos — derrubava reset-mfa,
# reset-password, backup, restore e healthcheck. Justamente as ferramentas de
# emergência, que só são usadas quando já deu problema.
#
# Aceita valores com ou sem aspas: instalações antigas (sem aspas) passam a
# funcionar sem precisar reescrever o .env.
load_env() {
  local file="${1:-.env}" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue;; esac
    case "$line" in *=*) ;; *) continue;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in ''|*[!A-Za-z0-9_]*) continue;; esac
    case "$val" in
      \"*\")
        val="${val:1:${#val}-2}"
        # Tirar as aspas não desfaz o escape que o envq pôs lá dentro. Sem estas
        # quatro trocas, `Loja P$ss` volta da releitura como `Loja P\$ss` — o
        # valor chega adulterado e o erro só aparece longe daqui (medido).
        #
        # O sentinela \001 existe pela ORDEM: um `\\` desfeito para `\` de cara
        # seria reprocessado pelas trocas seguintes, e `\\$` (barra literal
        # seguida de cifrão) viraria `$`. Guardando o par escapado num byte que
        # não ocorre em .env, as trocas de `\"`, `\$` e crase não o enxergam, e
        # ele só volta a ser barra no fim.
        val="${val//\\\\/$'\001'}"
        val="${val//\\\"/\"}"
        val="${val//\\\$/\$}"
        val="${val//\\\`/\`}"
        val="${val//$'\001'/\\}"
        ;;
      \'*\')
        # RETROCOMPATIBILIDADE — não remova. Até 2026-08 o envq gravava com
        # aspas simples, e atualizar NÃO reescreve o .env: o update.sh só troca
        # APP_IMAGE e APP_PULL_POLICY (:159 e :165, via set_env_var) e deixa as
        # outras chaves exatamente como o install antigo as escreveu. Quem
        # apagar este ramo devolve senha e connection string de toda instalação
        # velha com quatro caracteres a mais, já na primeira atualização.
        val="${val:1:${#val}-2}"
        # O envq daquela época escrevia a aspa simples do CONTEÚDO como '\''
        # (fecha o literal, escapa a aspa, reabre). Tirar as aspas de fora não
        # desfaz isso: sem esta troca, uma senha com aspa volta da releitura com
        # quatro caracteres a mais, e o erro só aparece longe daqui (o psql
        # recusa a conexão, o login não bate) sem nada apontando para o .env.
        # Achado pelo teste de round-trip.
        val="${val//"'\\''"/"'"}"
        ;;
    esac
    printf -v "$key" '%s' "$val"
    export "${key?}"
  done < "$file"
}

# Vai pro diretório do projeto (onde está o compose) e carrega o .env.
enter_project() {
  if [ -f "$COMPOSE" ]; then :;
  elif [ -f "deskcommcrm/$COMPOSE" ]; then cd deskcommcrm;
  else die "Não achei $COMPOSE. Rode a partir da pasta do projeto."; fi
  [ -f .env ] || die "Falta o .env (rode install.sh primeiro)."
  load_env .env
  PROJECT_DIR="$(pwd)"
}

# ── As DUAS conexões: a do app e a do schema ─────────────────────────────────
# `SUPABASE_DB_URL` tinha dois papéis numa string só: ela vai para o `.env` dos
# contêineres (o app fala com o banco por ela) E era a mesma que rodava
# `create extension`, o `baseline.sql` e a promoção do dono.
#
# Na nuvem isso não dói — a string do pooler já vem privilegiada. Num Supabase
# PRÓPRIO dói na primeira instalação: o baseline exige o dono do banco, o app
# quer a role menor (é o que `docs/deploy-selfhost/README.md` §2 recomenda), e a
# única saída era editar o `.env` na mão entre uma etapa e outra (issue #192).
#
# Daqui em diante: quem mexe no schema (e quem faz backup/restore, que precisam
# ler tudo) passa por esta função; o `.env` continua recebendo só a do app.
# `SUPABASE_DB_ADMIN_URL` ausente OU vazia cai na de sempre — quem já instalou
# não muda de comportamento.
#
# É FUNÇÃO, e não uma atribuição no topo deste arquivo, porque o `_common.sh` é
# *sourced* ANTES do `load_env` nos dois scripts (install.sh e update.sh), e ele
# abre com `set -euo pipefail`: uma linha `X="${SUPABASE_DB_ADMIN_URL:-$SUPABASE_DB_URL}"`
# aqui morre em "variável não associada" e leva o kit inteiro junto (medido: a
# suíte de shell inteira foi a EXIT=1 com 0 casos executados). E com guarda
# (`${SUPABASE_DB_URL:-}`) seria pior: o valor CONGELA vazio e todo sítio de DDL
# passa a rodar `psql ""`. A resolução tem de acontecer na hora do uso.
#
# `:?` e não `:-`: sem NENHUMA das duas, o certo é parar com uma frase que diz o
# que fazer, não seguir para um `psql ""` que erra longe da causa. O limite é
# honesto — isto roda em substituição de comando, e um subshell não derruba o
# pai; o que a mensagem garante é que a causa apareça na tela antes do erro de
# conexão que os chamadores já tratam.
url_do_schema() {
  printf '%s' "${SUPABASE_DB_ADMIN_URL:-${SUPABASE_DB_URL:?sem connection string de banco no .env — rode o install.sh}}"
}

# psql efêmero via container (não exige psql no host). Usa a conexão de schema:
# os chamadores mexem em `auth.mfa_factors` e `private.app_secrets`, fora do
# alcance de uma role de app com grants só em `public`.
psql_run() { docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" -v ON_ERROR_STOP=1 "$@"; }

# ── As três imagens que NÓS publicamos ───────────────────────────────────────
# O namespace é constante e literal de propósito: ele está gravado no .env de
# toda instalação viva, e derivá-lo de variável faria o kit antigo (que já está
# no disco do cliente) e o novo montarem strings diferentes.
#
# Esta linha é a ÚNICA fonte do namespace para tudo que executa — os testes do
# kit a leem em vez de repetir a string. Quem a confere é
# `tests/unit/namespace-das-imagens.test.ts`, que assere este valor e cobra que
# `docker-compose.prod.yml`, `.env.hostgator.example` e a matriz de
# `publish-image.yml` digam o mesmo. Se você é um fork, é lá que está a lista do
# que trocar junto.
IMG_NS="ghcr.io/paulocmbcosta"
IMG_APP="${IMG_NS}/deskcommcrm"
IMG_WORKER="${IMG_NS}/deskcomm-worker"
IMG_SCHEDULER="${IMG_NS}/deskcomm-scheduler"
# Telefonia SIP (spec 20): serviço de profile opcional, fixado na MESMA versão
# que as outras três por `gravar_imagens` — ligado ou não, o pin fica pronto.
IMG_ASTERISK="${IMG_NS}/deskcomm-asterisk"

# A última versão publicada (ex.: "1.2.1"), ou vazio se não deu para saber.
#
# Consulta o REMOTO, não o clone: o install.sh clona com `--depth 1`, que não
# traz tag nenhuma, então `git tag -l` local devolveria vazio e a instalação
# nasceria em `latest` sem ninguém perceber — que é justamente o defeito que
# esta função existe para consertar.
#
# Falha ABERTA de propósito: sem rede, sem git ou sem tag no remoto ela devolve
# vazio e quem chama cai no canal móvel, como era antes. Travar a instalação de
# alguém porque não deu para resolver um número de versão seria trocar um
# problema de previsibilidade por um de disponibilidade.
ultima_versao_publicada() {
  local url="${1:-https://github.com/paulocmbcosta/DeskcommCRM.git}" ref
  command -v git >/dev/null 2>&1 || return 0
  # `grep -v -- -` descarta PRERELEASE (v1.11.0-rc1, v1.1.1-jmpo.1 — esta última
  # existe de verdade neste repo). O `--sort=-v:refname` do git põe o prerelease
  # ACIMA do release final quando `versionsort.suffix` não está configurado, e
  # uma instalação nova nasceria num release candidate sem ninguém pedir.
  # `GIT_TERMINAL_PROMPT=0`: num repositório FECHADO, o git por HTTPS pergunta
  # usuário e senha no terminal de quem roda o instalador — e ele ficaria parado
  # ali. Sem prompt, falha na hora e quem chama trata o vazio.
  ref="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs --sort=-v:refname "$url" 'v*' 2>/dev/null \
        | awk '{print $2}' | grep -v -- '-' | head -1)" || return 0
  [ -n "$ref" ] || return 0
  printf '%s' "${ref#refs/tags/v}"
}

# Credencial que o Docker DESTA máquina guarda para um registro (`docker login`).
# Ecoa o valor de `auths[<registro>].auth` (já em base64), ou nada.
#
# Existe para o repositório FECHADO: com os pacotes privados no GHCR, a sonda
# anônima abaixo responde 401/403 para imagens que existem, e o instalador lia
# isso como "a versão não está publicada" — caía no `stable`, depois em
# "construir aqui", e o `docker compose pull` do app (que não tem `build:`)
# morria no fim. O `pull` usa a credencial do `docker login`; a sonda tem de
# usar a MESMA, senão ela mede um caminho e o cliente usa outro.
#
# Sem `jq` no kit: achata o JSON e recorta. A chave pode ser `ghcr.io` ou
# `https://ghcr.io`, com ou sem barra no fim. Quando o Docker usa um cofre
# (`credsStore`), o `auth` não está no arquivo e isto ecoa vazio — a sonda cai
# no caminho anônimo, que é o comportamento de antes.
credencial_do_registro() {
  local registro="$1" cfg ponto
  cfg="${DOCKER_CONFIG:-${HOME:-/root}/.docker}/config.json"
  [ -r "$cfg" ] || return 0
  ponto="$(printf '%s' "$registro" | sed 's/\./\\./g')"
  { tr -d ' \n\r\t' < "$cfg" 2>/dev/null || true; } \
    | sed -n "s#.*\"\\(https://\\)\\{0,1\\}${ponto}/\\{0,1\\}\":{[^}]*\"auth\":\"\\([^\"]*\\)\".*#\\2#p" \
    | head -1
}

# Token de leitura do registro para uma imagem nossa. Com `docker login` feito
# nesta máquina, pede COM a credencial (enxerga pacote privado e público); sem
# ela, ou se ela for recusada, pede anônimo (só pacote público).
#
# A credencial vai ao `curl` por stdin (`-K -`), nunca na linha de comando: um
# `-H 'Authorization: Basic …'` ficaria visível em `ps` para qualquer usuário
# da máquina enquanto a requisição durasse.
ghcr_token() {
  local img="$1" registry owner url cred tok=""
  registry="${IMG_NS%%/*}"
  owner="${IMG_NS#*/}"
  url="https://${registry}/token?scope=repository:${owner}/${img}:pull&service=${registry}"
  cred="$(credencial_do_registro "$registry")" || cred=""
  if [ -n "$cred" ]; then
    tok="$(printf 'header = "Authorization: Basic %s"\n' "$cred" \
            | curl -fsS --max-time 6 -K - "$url" 2>/dev/null \
            | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || tok=""
  fi
  if [ -z "$tok" ]; then
    tok="$(curl -fsS --max-time 6 "$url" 2>/dev/null \
            | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || tok=""
  fi
  printf '%s' "$tok"
}

# Código HTTP do manifest de uma referência nossa no GHCR — com a credencial do
# `docker login` desta máquina quando há uma, anonimamente quando não há.
#   200 = existe e ESTA MÁQUINA consegue puxar | 404 = não existe
#   401/403 = existe, mas é PRIVADO e esta máquina não tem login | 000 = sem rede
#
# 403 é o caso que mais engana: pacote recém-criado no GHCR nasce privado, e
# repositório público não muda isso. Enquanto ninguém trocar a visibilidade na
# mão — ou fizer `docker login ghcr.io` nesta máquina —, o `docker compose pull`
# é negado, e como `pull` de serviço com `image:` falha a operação inteira, a
# instalação morre no passo de subir.
#
# ⚠️ O DONO E O REGISTRO SAEM DO `IMG_NS`, NUNCA DE UM LITERAL. Achado por
# @galeonel no PR #605: as duas URLs tinham `melgarafael` cravado. Num fork que
# troca o `IMG_NS`, isso faz o pré-voo conferir os pacotes do UPSTREAM enquanto
# `gravar_imagens` escreve no `.env` do cliente as referências do FORK — a sonda
# mede um caminho e o usuário usa outro, que é a falha-em-verde do passe 5 da
# triagem.
#
# E o literal escapava da catraca por acidente: `namespace-das-imagens.test.ts`
# procura a string contígua `ghcr.io/melgarafael`, e a URL do token a parte em
# `ghcr.io/token?scope=repository:melgarafael/`.
ghcr_status() {
  local img="$1" tag="$2" tok registry owner
  registry="${IMG_NS%%/*}"
  owner="${IMG_NS#*/}"
  tok="$(ghcr_token "$img")" || true
  if [ -z "$tok" ]; then printf '000'; return 0; fi
  curl -s -o /dev/null --max-time 6 -w '%{http_code}' \
    -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
    "https://${registry}/v2/${owner}/${img}/manifests/${tag}" 2>/dev/null || printf '000'
}

# As imagens existem, mas esta máquina NÃO tem permissão de lê-las?
#
# É a pergunta que separa "a versão ainda está publicando" de "o pacote é
# privado e falta o `docker login`" — duas causas com a mesma cara no
# `trio_publicado` (nenhuma devolve 200) e remédios opostos: esperar não
# conserta a segunda nunca.
registro_recusa_esta_maquina() {
  local c
  c="$(ghcr_status deskcommcrm stable)"
  [ "$c" = "401" ] || [ "$c" = "403" ]
}

# As TRÊS imagens existem nesta referência, e esta máquina consegue puxá-las?
#
# Perguntar pelas três juntas, e não só pela do app, é o ponto: `deskcomm-worker`
# e `deskcomm-scheduler` nasceram depois das releases que já existem, então
# `deskcomm-worker:1.2.1` nunca vai existir — a v1.2.1 é passado. Pinar as três
# numa versão sem conferir gravaria no .env do cliente duas referências
# impossíveis, e o kit as construiria na VPS **em silêncio**, do topo da main:
# app de uma release + worker/scheduler de outro código. Exatamente a mistura de
# versões que a doutrina existe para proibir, no caminho de primeira impressão.
trio_publicado() {
  local tag="$1" i
  for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
    [ "$(ghcr_status "$i" "$tag")" = "200" ] || return 1
  done
  return 0
}

# O .env está com pin PELA METADE? (app fixado numa versão, worker/scheduler não)
#
# Este é o estado que a transição produz e que nada denuncia. Medido em ensaio e
# depois na produção: quem executa a primeira atualização é o `update.sh` que já
# estava no disco — o antigo —, e ele só sabe gravar `APP_IMAGE`. O worker cai no
# default do compose (`:stable`, um canal MÓVEL) e o script termina dizendo
# "Atualização concluída — app no ar e saudável", sem uma palavra sobre isso.
#
# Por que importa: na release seguinte o `stable` se move, e um `up -d` qualquer
# — com `pull_policy: always`, que é o default de tag móvel — levaria o worker
# sozinho para a versão nova enquanto o app permanece na antiga. Mistura de
# versões que acontece sem ninguém pedir, e é o que o invariante 3 proíbe.
#
# Ecoa os serviços sem pin, separados por espaço. Vazio = está tudo certo.
valor_do_env() {  # valor_do_env <arquivo> <chave>   (sem aspas ao redor)
  # O `|| true` não é decorativo: o `_common.sh` roda sob `set -euo pipefail`, e
  # um `grep` que não casa sai 1 — o que, sem isto, mataria a função inteira
  # justamente no caso que interessa (a chave AUSENTE). Custou dois casos verdes
  # de mentira num teste antes de aparecer.
  { grep -E "^$2=" "$1" 2>/dev/null || true; } | head -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]\$//"
}

tag_da_imagem() {  # tag_da_imagem <referência>  → a tag, ou vazio se não houver
  local ref="${1##*/}"
  case "$ref" in *:*) printf '%s' "${ref##*:}" ;; *) printf '' ;; esac
}

pin_incompleto() {  # pin_incompleto [caminho do .env]
  local envfile="${1:-.env}" app_ref app_tag faltando="" par chave svc img tag
  [ -f "$envfile" ] || return 0

  # Sem APP_IMAGE pinado não há "metade" nenhuma — é outra situação (instalação
  # que nunca rodou update, ou que escolheu um canal de propósito).
  app_ref="$(valor_do_env "$envfile" APP_IMAGE)"
  [ -n "$app_ref" ] || return 0
  app_tag="$(tag_da_imagem "$app_ref")"
  case "$app_tag" in latest|main|stable|"") return 0 ;; esac

  for par in "WORKER_IMAGE:worker" "SCHEDULER_IMAGE:scheduler"; do
    chave="${par%%:*}"; svc="${par##*:}"
    img="$(valor_do_env "$envfile" "$chave")"
    if [ -z "$img" ]; then
      faltando="$faltando $svc"                    # ausente: segue o default do compose
    else
      tag="$(tag_da_imagem "$img")"
      case "$tag" in latest|main|stable|"") faltando="$faltando $svc" ;; esac
    fi
  done
  printf '%s' "${faltando# }"
}

# ── A telefonia está LIGADA nesta instalação? ────────────────────────────────
# É `telefonia` em COMPOSE_PROFILES, lido do ARQUIVO e com a régua do próprio
# `docker compose` — é ele quem decide se o Asterisk existe, e uma régua
# diferente da dele diria "desligada" com o serviço no ar, ou o contrário. Cada
# regra abaixo foi medida contra o docker compose v5.1.4 (2026-09-28), com
# `docker compose config --services`:
#   - a ÚLTIMA linha vence. O `install.sh` grava `COMPOSE_PROFILES=''`, e quem
#     ACRESCENTA uma linha no fim em vez de editar aquela liga o profile (o
#     `load_env` também fica com a última);
#   - aspas simples ou duplas, `export ` na frente, comentário depois de um
#     espaço e fim de linha do Windows não mudam nada;
#   - é uma lista separada por vírgula, com ou sem espaço depois dela, e o nome é
#     comparado INTEIRO: `telefonia2` não liga a telefonia.
telefonia_ligada() {  # telefonia_ligada [envfile] → sai 0 se ligada
  local envfile="${1:-.env}" v
  [ -f "$envfile" ] || return 1
  v="$({ grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_PROFILES=' "$envfile" 2>/dev/null || true; } | tail -1)"
  v="${v#*=}"
  # Nome de profile não tem espaço nem aspas: tirar TODOS é mais simples, e mais
  # difícil de errar, do que reproduzir o parser de aspas do compose.
  v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//' | tr -d "[:space:]\"'")"
  case ",$v," in *,telefonia,*) return 0 ;; esac
  return 1
}

# Quais das nossas imagens o .env FIXA em algo que não é o alvo desta atualização?
# São três — app, worker, scheduler — e QUATRO quando a telefonia está ligada.
#
# Existe porque "o código está na tag" não diz nada sobre o que RODA: quem roda é
# a imagem, e a imagem é a que o `.env` manda o compose subir. Medido em produção
# em 2026-09-19 (deploy da v1.32.0): repositório já em `v1.32.0`, `.env` fixado em
# `:1.31.1`, e o `update.sh` respondeu "Nada a atualizar" com os três contêineres
# na 1.31.1. A única sonda que havia era por DIGEST — o local contra o remoto da
# MESMA referência —, e numa tag imutável isso é a imagem antiga comparada com ela
# mesma. Só enxergava defasagem em canal móvel, que era como toda instalação
# nascia quando a sonda foi escrita.
#
# Compara a REFERÊNCIA INTEIRA com a que `gravar_imagens` escreveria, e não só o
# número depois dos dois-pontos. Motivo medido, não hipotético: uma VPS que veio
# do repositório de origem tem `ghcr.io/<origem>/deskcommcrm:1.29.0`, e a
# `v1.29.0` daqui é OUTRO produto (docs/runbooks/repositorio-proprio.md §5).
# Comparar só o número responderia "em dia" com o produto alheio no ar.
#
# O que a versão NÃO decide, de propósito:
#   - chave AUSENTE: vale o default do compose, que é um canal. Quem cuida dessa
#     lacuna é `completar_pin_ausente`, com a versão que já está rodando.
#     EXCETO a do Asterisk com a telefonia ligada, que conta. Ela só falta no
#     `.env` de quem chegou à versão da telefonia pelo `update.sh` ANTERIOR (ele
#     carrega este arquivo antes do checkout, e o `gravar_imagens` velho não
#     conhece o Asterisk) — não há escolha de canal ali para respeitar, só um
#     serviço ligado caindo em `:stable` + `always`, que a doutrina de packaging
#     proíbe. Desligada, a chave ausente não conta: o compose nem cria o serviço.
#   - canal móvel EXPLÍCITO (`latest`/`main`/`stable`, ou repositório sem tag, que
#     é `:latest` implícito): é decisão de quem opera. E `latest` aqui é o topo da
#     `main`, não a última release — fixá-la à força na versão da tag poderia ser
#     um DOWNGRADE que ninguém pediu. Para canal, quem decide é o digest.
#
# Tudo o mais é "fixado em outra coisa" e conta — inclusive o ID de imagem LOCAL
# que o rollback do `agent.sh` grava (`docker compose images -q`: sem repositório
# e sem tag). Esse era o segundo estado em que o `update.sh` jurava "em dia" com o
# app na versão anterior: o digest remoto de um ID local não existe, e sem remoto
# a sonda antiga não forçava nada.
#
# Ecoa os serviços fora do alvo, separados por espaço. Vazio = a versão não acusa
# ninguém (o que NÃO é o mesmo que "está em dia": falta o digest).
imagens_fora_do_alvo() {  # imagens_fora_do_alvo <envfile> <versão alvo, sem o "v">
  local envfile="${1:-.env}" alvo="${2:-}" svc chave repo img fora="" servicos="app worker scheduler"
  [ -f "$envfile" ] || return 0
  [ -n "$alvo" ] || return 0
  telefonia_ligada "$envfile" && servicos="$servicos asterisk"

  for svc in $servicos; do
    # `case`, e não um mapa "CHAVE:svc:repo" partido por dois-pontos como em
    # `completar_pin_ausente`: o repositório pode TER dois-pontos (registro com
    # porta, num fork), e o corte devolveria metade do nome.
    case "$svc" in
      app)       chave=APP_IMAGE;       repo="$IMG_APP" ;;
      worker)    chave=WORKER_IMAGE;    repo="$IMG_WORKER" ;;
      scheduler) chave=SCHEDULER_IMAGE; repo="$IMG_SCHEDULER" ;;
      asterisk)  chave=ASTERISK_IMAGE;  repo="$IMG_ASTERISK" ;;
    esac
    img="$(valor_do_env "$envfile" "$chave")"
    if [ -z "$img" ]; then
      # Ausente: vale o default do compose. Conta só para o Asterisk, que só
      # está nesta lista com a telefonia ligada (o porquê no cabeçalho acima).
      [ "$svc" = asterisk ] && fora="$fora $svc"
      continue
    fi
    referencia_fora_do_alvo "$img" "$repo" "$alvo" && fora="$fora $svc"
  done
  printf '%s' "${fora# }"
}

# A regra de julgamento de UMA referência, num lugar só. Ela nasceu dentro de
# `imagens_fora_do_alvo` e saiu quando `conteiner_da_telefonia_fora_do_alvo`
# passou a precisar da MESMA decisão sobre uma referência de outra origem (o
# contêiner em vez do `.env`). Duplicá-la seria pedir divergência: um conserto no
# canal móvel aplicado num lugar e não no outro acusa a instalação por um
# critério e a absolve pelo outro, que é pior do que não ter critério nenhum.
# Sai 0 = está fora do alvo (conta). Sai 1 = não conta (é o alvo, é canal, ou
# não há o que julgar) — o que NÃO significa "em dia": falta o digest.
referencia_fora_do_alvo() {  # referencia_fora_do_alvo <referência> <repo> <versão alvo>
  local ref="$1" repo="$2" alvo="$3"
  [ -n "$ref" ] || return 1                       # nada para julgar (chave ausente, contêiner parado)
  [ "$ref" = "${repo}:${alvo}" ] && return 1      # exatamente o que esta atualização gravaria
  case "$(tag_da_imagem "$ref")" in
    latest|main|stable) return 1 ;;               # canal escolhido: o digest decide
    "") case "$ref" in */*) return 1 ;; esac ;;   # repositório sem tag = :latest implícito
  esac
  return 0
}

# O contêiner do Asterisk, com a telefonia LIGADA: ele existe, e roda o alvo?
#
# É o critério que fecha o caminho que a aba Telefone ensina — acrescentar
# `telefonia` a COMPOSE_PROFILES e rodar o `update.sh`. Numa instalação nova, ou
# que já passou por um `update.sh` desta época, o `.env` JÁ fixa o Asterisk na
# versão (o `install.sh` e o `gravar_imagens` gravam a chave ligada ou não): o
# critério do `.env` o vê no alvo, o do digest vê o app em dia, e o script
# respondia "Nada a atualizar" com o Asterisk nunca criado. É o caso mais comum,
# e só o contêiner sabe dele.
#
# Prudências, na mesma linha do resto do kit:
#   - telefonia DESLIGADA não acusa nada: o compose nem cria o serviço.
#   - sem o contêiner do APP, não acusa nada. Stack parada de propósito não
#     recebe um update que ninguém pediu; a ausência do Asterisk só diz algo com
#     o resto do CRM no ar.
#   - a referência julgada é a DO CONTÊINER, pela mesma régua do `.env`
#     (`referencia_fora_do_alvo`): Asterisk seguindo um canal não é atraso.
#   - `docker` fora do ar / socket sem permissão não derruba quem chama, mesmo
#     sob `set -euo pipefail`. Sem enxergar, o critério se cala.
#
# Ecoa `asterisk` quando está fora do alvo; vazio quando não há o que acusar.
conteiner_da_telefonia_fora_do_alvo() {  # conteiner_da_telefonia_fora_do_alvo <envfile> <versão alvo, sem o "v">
  local envfile="${1:-.env}" alvo="${2:-}" proj app ast
  [ -n "$alvo" ] || return 0
  telefonia_ligada "$envfile" || return 0
  command -v docker >/dev/null 2>&1 || return 0
  proj="$(nome_do_projeto_atual)"

  # As guardas `|| x=""` valem para o chamador DIRETO. O `update.sh` chama por
  # `$( )`, onde o errexit já não aborta a função — mas quem escrever esta
  # chamada numa linha solta sob `set -e` perderia o script no primeiro docker
  # fora do ar (medido: tests/shell/update-guard.test.sh, caso 14h).
  app="$(docker inspect "${proj}-app-1" --format '{{.Config.Image}}' 2>/dev/null)" || app=""
  [ -n "$app" ] || return 0
  ast="$(docker inspect "${proj}-asterisk-1" --format '{{.Config.Image}}' 2>/dev/null)" || ast=""
  if [ -z "$ast" ] || referencia_fora_do_alvo "$ast" "$IMG_ASTERISK" "$alvo"; then
    printf 'asterisk'
  fi
}

# ── A porta SIP depois de recriar o Asterisk ─────────────────────────────────
# O Asterisk não publica porta de sinalização: ele registra NA operadora, saindo
# pelo NAT do Docker, e a operadora exige que ele chegue pela 5060. Quem garante
# a 5060 do lado de fora é uma linha da tabela de conexões do servidor
# (conntrack) — e essa linha pertence ao IP do contêiner, não ao serviço.
#
# Recriar o Asterisk quebra isso, e o defeito NÃO se cura sozinho. Medido na
# VPS em cinco atualizações (1.52.2 a 1.57.0) e reproduzido em laboratório
# (dockerd 29.8.0, Asterisk 20.11, 2026-10-07):
#
#   1. Uma atualização recria vários contêineres de uma vez, e o Docker
#      redistribui os IPs. O Asterisk novo costuma nascer com OUTRO IP.
#   2. A linha do IP antigo continua na tabela segurando a 5060: remover o
#      contêiner não a apaga (medido — é conexão de SAÍDA, sem porta publicada).
#   3. O Asterisk novo fala com a mesma operadora, a 5060 está ocupada, e o
#      kernel o faz sair por outra porta (64466 no laboratório, 60039 na VPS).
#      A operadora recusa: "registro recusado" em Conexões › Telefone.
#   4. Quando a linha antiga finalmente expira, a NOVA já está de pé na porta
#      errada, e o `qualify` de 25 s do tronco a renova para sempre.
#
# O conserto tem três tempos, e cada um existe por uma medida:
#
#   LIMPAR  as linhas UDP de porta de origem 5060. Só elas: o áudio (RTP) usa
#           outra faixa e nenhuma ligação passa por aqui.
#   OCUPAR  a 5060 na hora, mandando o Asterisk falar com a operadora (um
#           OPTIONS, `pjsip qualify`). Sem isto a limpeza é uma corrida: se a
#           operadora mandar um pacote para o servidor antes de o Asterisk
#           mandar o dele, é ESSE pacote que fica com a 5060, e o Asterisk sai
#           desviado de novo (medido: operadora falando a cada 3 s venceu a
#           corrida contra o `qualify` de 25 s; com o OPTIONS em seguida, a
#           0,27 s da limpeza, o Asterisk ficou com a porta).
#   REENVIAR os números: reiniciar o worker, que empurra os troncos de novo e
#           faz o Asterisk registrar já. Sem isto o registro recusado só tenta
#           de novo em 5 minutos (`forbidden_retry_interval`, pjsip.ts).
#
# `pjsip send register` NÃO entra, e não é esquecimento: sozinho ele registra
# pela porta errada e a tela passa a dizer "Conectado" com a ligação recebida
# sem chegar. Pelo mesmo motivo, "registrou" não é o critério daqui — o critério
# é a PORTA, lida na tabela.
PORTA_SIP=5060
# Quanto esperar os números voltarem depois do conserto, e de quanto em quanto
# olhar. Variáveis para o teste não esperar um minuto de relógio.
TELEFONIA_PRAZO_DOS_REGISTROS="${TELEFONIA_PRAZO_DOS_REGISTROS:-60}"
TELEFONIA_PAUSA="${TELEFONIA_PAUSA:-3}"
# Quantas vezes limpar e ocupar antes de desistir. Cada rodada custa ~2 s e não
# reinicia nada; a 2ª em diante só existe para a corrida perdida (ver abaixo).
TELEFONIA_RODADAS="${TELEFONIA_RODADAS:-5}"

# Nenhuma pergunta desta seção pode PRENDER a atualização. O `update.sh` roda
# sozinho pelo cron do `agent.sh`, segurando a trava de "uma atualização por
# vez": um `docker exec` pendurado num Asterisk travado não falharia — ficaria
# ali para sempre, e nenhuma atualização futura começaria. Onde o servidor não
# tem `timeout` (macOS de quem desenvolve), roda sem prazo.
com_prazo() {  # com_prazo <segundos> <comando...>
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}

# O `conntrack` contra a tabela do SERVIDOR. Se o servidor já tem o programa,
# usa o dele. Senão, roda o da imagem do próprio Asterisk (Dockerfile.asterisk)
# num contêiner efêmero na rede do host: nada é instalado na VPS e nada é
# baixado — a imagem é a do contêiner que está rodando, então já está no disco.
conntrack_do_host() {  # conntrack_do_host <imagem do Asterisk> <argumentos do conntrack...>
  local imagem="$1"; shift
  if [ "$(id -u)" = 0 ] && command -v conntrack >/dev/null 2>&1; then
    com_prazo 20 conntrack "$@"
  else
    com_prazo 60 docker run --rm --network host --cap-add NET_ADMIN --entrypoint conntrack "$imagem" "$@"
  fi
}

# O julgamento, puro: dada a listagem do conntrack, quantas conexões SIP do
# Asterisk estão certas, quantas estão desviadas e quantas ficaram presas.
#
#   certa    → sai do IP do Asterisk e chega lá fora pela 5060.
#   desviada → sai do IP do Asterisk e chega lá fora por OUTRA porta.
#   presa    → sai de outro IP da MESMA rede do Asterisk e está NA 5060 lá
#              fora. Só o Asterisk fala UDP a partir da 5060 nessa rede, então é
#              de um Asterisk que não existe mais — é ela que segura a porta.
#
# A sobra de um Asterisk antigo que estava DESVIADO (outro IP da rede, outra
# porta lá fora) não segura nada: é lixo que expira sozinho, e não conta.
# Medido no laboratório: contá-la fazia a função limpar a conexão boa de um
# Asterisk que, por sorte, tinha renascido com o IP da linha certa.
#
# Conexão de porta de origem 5060 vinda de FORA da rede (outro programa de
# telefonia no servidor, a própria operadora) não é contada: não é nossa, e
# sozinha não é motivo para mexer em nada.
#
# A rede chega como "<IP do Asterisk>/<bits>", e pode ser mais de uma, separadas
# por espaço — ver `rede_de_saida_do_asterisk`, logo abaixo.
#
# A linha tem duas metades — o pacote como saiu e como a resposta volta — e a
# porta de fora é o `dport` da SEGUNDA, isto é, o último da linha.
veredito_da_porta_sip() {  # veredito_da_porta_sip "<IP>/<bits> [<IP>/<bits> …]"   ← stdin: `conntrack -L -p udp --orig-port-src 5060`
  awk -v redes="$1" -v porta="$PORTA_SIP" '
    function num(a,   o) { if (split(a, o, ".") != 4) return -1; return ((o[1] * 256 + o[2]) * 256 + o[3]) * 256 + o[4] }
    function mesma_rede(a,   k, na, ni, tam) {
      na = num(a)
      if (na < 0) return 0
      for (k = 1; k <= n; k++) {
        ni = num(ipr[k])
        if (ni < 0 || bit[k] < 1 || bit[k] > 32) continue
        tam = 2 ^ (32 - bit[k])
        if (int(na / tam) == int(ni / tam)) return 1
      }
      return 0
    }
    BEGIN { n = split(redes, r, " "); for (j = 1; j <= n; j++) { split(r[j], p, "/"); ipr[j] = p[1]; bit[j] = p[2] + 0; meu[p[1]] = 1 } }
    $1 == "udp" {
      origem = ""; sport = ""; fora = ""
      for (i = 1; i <= NF; i++) {
        if (origem == "" && $i ~ /^src=/) origem = substr($i, 5)
        if (sport == "" && $i ~ /^sport=/) sport = substr($i, 7)
        if ($i ~ /^dport=/) fora = substr($i, 7)
      }
      if (sport != porta) next
      if (origem in meu) { if (fora == porta) certas++; else desviadas++ }
      else if (fora == porta && mesma_rede(origem)) presas++
    }
    END { printf "%d %d %d\n", certas, desviadas, presas }'
}

# A rede por onde o Asterisk SAI para a internet, como "<IP>/<bits>".
#
# Ele pode estar em mais de uma: com o proxy da hospedagem (o override do
# Traefik) entra também na rede do proxy, por causa do WebSocket do ramal — e
# essa é a topologia da VPS onde o defeito foi medido. A conexão SIP sai por UMA
# delas, com o IP que ele tem NAQUELA rede; julgar com o IP da outra faria toda
# linha dele parecer "de fora", e a resposta seria "0 0 0 — nada a corrigir" com
# o telefone mudo.
#
# Quem sabe por onde ele sai é o próprio contêiner: `ip route get` devolve o
# endereço de origem que o kernel usaria. Não deu para perguntar (Asterisk ainda
# subindo, imagem sem `ip`)? Devolve TODAS: o IP dele em qualquer rede conta
# como dele, e "presa" passa a valer para as duas — mais largo, nunca cego.
rede_de_saida_do_asterisk() {  # rede_de_saida_do_asterisk <contêiner> "<IP>/<bits> …"
  local ast="$1" redes="$2" origem r n=0
  for r in $redes; do n=$((n + 1)); done
  if [ "$n" -le 1 ]; then printf '%s' "$redes"; return 0; fi
  # 192.0.2.1 é endereço de documentação: nada é enviado, só se pergunta a rota.
  origem="$(com_prazo 20 docker exec "$ast" timeout 10 ip -4 route get 192.0.2.1 2>/dev/null | sed -n 's/.* src \([0-9][0-9.]*\).*/\1/p' | head -1)" || origem=""
  for r in $redes; do
    if [ "${r%/*}" = "$origem" ]; then printf '%s' "$r"; return 0; fi
  done
  printf '%s' "$redes"
}

# Lê a tabela e julga. Sai != 0 quando não deu para LER (sem o programa na
# imagem, sem permissão, Docker fora do ar) — "não sei" não pode virar "0 0 0",
# que é a resposta de quem está saudável.
medir_porta_sip() {  # medir_porta_sip <imagem> "<IP>/<bits> …"  → "<certas> <desviadas> <presas>"
  local tabela
  tabela="$(conntrack_do_host "$1" -L -p udp --orig-port-src "$PORTA_SIP" 2>/dev/null)" || return 1
  printf '%s\n' "$tabela" | veredito_da_porta_sip "$2"
}

# Uma pergunta ao Asterisk, com DOIS prazos. O de fora (`com_prazo`) solta o
# kit; o de dentro mata o cliente `asterisk -rx` no contêiner — sem ele, cada
# pergunta a um Asterisk travado deixaria um processo pendurado lá dentro, e a
# função pergunta várias vezes. O `timeout` de dentro é o do busybox da imagem.
perguntar_ao_asterisk() {  # perguntar_ao_asterisk <contêiner> <comando do CLI>
  com_prazo 20 docker exec "$1" timeout 10 asterisk -rx "$2" 2>/dev/null
}

# Os números (troncos) que o Asterisk tem, um por linha: "<nome> <estado>".
# Sai != 0 se o Asterisk não respondeu — "não sei" não é "nenhum".
#
# O formato é o do Asterisk 20.11, medido com nome curto e com o de produção
# (`tronco-<uuid>`, que estoura a primeira coluna e corta a URI em `sip:172.20`):
# o nome é o que vem antes da barra, e o estado é a terceira palavra.
registros_sip() {  # registros_sip <contêiner do Asterisk>
  local saida
  saida="$(perguntar_ao_asterisk "$1" 'pjsip show registrations')" || return 1
  printf '%s\n' "$saida" | awk '$1 ~ /^[^<=\/]+\/sips?:/ { n = $1; sub(/\/.*/, "", n); print n, $3 }'
}

# Quantos números estão registrados agora, para o `update.sh` guardar ANTES de
# recriar o Asterisk: é a régua de "voltaram". VAZIO quando não deu para saber
# (telefonia desligada, Asterisk fora do ar), e aí a régua passa a ser "todos";
# `0` quando deu para saber e não havia nenhum — e aí não se espera nenhum.
troncos_registrados_agora() {  # troncos_registrados_agora [envfile]
  local lista
  telefonia_ligada "${1:-.env}" || return 0
  command -v docker >/dev/null 2>&1 || return 0
  lista="$(registros_sip "$(nome_do_projeto_atual)-asterisk-1")" || return 0
  printf '%s\n' "$lista" | awk '$2 == "Registered" { n++ } END { printf "%d", n }'
}

# Há ligação em curso? Conta CANAIS, não ligações atendidas: quem está no menu,
# na fila ou tocando também é canal, e é justamente essa ligação que o reinício
# do worker encerra (`recuperar`, em lib/channels/telefonia/controle.ts, só
# retoma a que já tem duas pontas conversando).
canais_do_asterisk() {  # canais_do_asterisk <contêiner>  → o número; sai != 0 se não deu para saber
  local saida
  saida="$(perguntar_ao_asterisk "$1" 'core show channels count')" || return 1
  printf '%s\n' "$saida" | awk '/active channel/ { print $1; ok = 1; exit } END { if (!ok) exit 1 }'
}

# O comando de quem precisa resolver à mão — o mesmo do runbook, com o nome do
# projeto DESTA instalação. Impresso quando o kit não conseguiu nem LER a tabela.
conserto_manual_da_porta_sip() {
  local proj; proj="$(nome_do_projeto_atual)"
  c_ylw "  Para resolver à mão (pode rodar com o CRM no ar):"
  c_ylw "    docker run --rm --net=host --cap-add=NET_ADMIN alpine:3.22 sh -c \"apk add -q --no-cache conntrack-tools; conntrack -D -p udp --orig-port-src ${PORTA_SIP}\""
  c_ylw "    docker restart ${proj}-worker-1"
  c_ylw "  E confira: docker exec ${proj}-asterisk-1 asterisk -rx \"pjsip show registrations\""
}

# Reenvia os números ao Asterisk: reinicia o worker, que ao reconectar empurra
# todos os troncos de novo (`sincronizar(true)`, lib/channels/telefonia/laco.ts)
# — a não ser que haja ligação em curso.
#
# A guarda FALHA FECHADA: se o Asterisk não diz quantos canais tem, não se
# reinicia. "Não respondeu" não é "não há ligação" — um Asterisk no teto de
# memória, com gente na linha, é exatamente o que demora a responder. Pergunta
# três vezes antes de desistir, porque logo depois do `up -d` ele ainda está
# subindo e o silêncio dura um ou dois segundos.
#
# Sai 0 = reiniciou · 2 = adiou (há ligação, ou não deu para saber) · 1 = não
# conseguiu reiniciar. Quem chama diz o que falta; aqui se diz o porquê.
reenviar_numeros_sip() {  # reenviar_numeros_sip <contêiner do Asterisk> <contêiner do worker>
  local canais="" tentativa=0
  while [ "$tentativa" -lt 3 ]; do
    if canais="$(canais_do_asterisk "$1")"; then break; fi
    canais=""
    tentativa=$((tentativa + 1))
    if [ "$tentativa" -lt 3 ]; then sleep "$TELEFONIA_PAUSA"; fi
  done
  case "$canais" in
    ""|*[!0-9]*)
      c_ylw "  O Asterisk não respondeu se há ligação em curso: NÃO reiniciei o worker, que derrubaria quem estivesse na linha."
      return 2 ;;
  esac
  if [ "$canais" -gt 0 ]; then
    c_ylw "  Há ligação em curso (${canais} canal(is) no Asterisk): NÃO reiniciei o worker, para não derrubá-la."
    return 2
  fi
  if com_prazo 90 docker restart "$2" >/dev/null 2>&1; then
    c_dim "  reiniciei o worker para ele reenviar os números ao Asterisk"
    return 0
  fi
  c_ylw "  ⚠ não consegui reiniciar o worker ($2)."
  return 1
}

# O worker REENVIOU os números depois do reinício? "Registrado" sozinho não
# responde: uma operadora que aceita qualquer porta deixa o número "Registered"
# pela porta ERRADA (medido no laboratório), e esse estado velho continua na
# lista do Asterisk até o worker apagar e recriar o tronco. Declarar "voltou"
# olhando para ele seria aprovar o registro que este conserto existe para
# refazer — e, se o worker não subisse, ninguém ficaria sabendo.
#
# A prova é a linha que o próprio worker escreve a cada tronco empurrado
# (lib/channels/telefonia/sincronizacao.ts), e só a escrita DEPOIS do reinício:
# no log dele sempre há uma anterior, a de quando subiu com a atualização. O
# texto é contrato entre os dois arquivos: tests/shell/telefonia-porta-sip.test.sh
# reprova se um mudar sozinho.
MARCA_DE_TRONCO_ENVIADO="tronco enviado ao Asterisk"
worker_reenviou_desde() {  # worker_reenviou_desde <contêiner do worker> <instante, em segundos desde 1970>
  local saida
  # Sem pipe para o grep: com `pipefail`, um `grep -q` que acha cedo fecha o
  # cano, o `docker logs` morre de SIGPIPE e o "achei" vira falha.
  saida="$(com_prazo 30 docker logs --since "$2" "$1" 2>&1)" || return 1
  case "$saida" in *"$MARCA_DE_TRONCO_ENVIADO"*) return 0 ;; esac
  return 1
}

# Confere a porta SIP e, se ela ficou presa ou desviada, conserta e espera os
# números voltarem. Três modos:
#
#   atualizacao → o do `update.sh`, logo depois do `up -d`. Com a porta certa
#                 não reinicia nada; se havia número registrado antes, espera
#                 eles voltarem (quem os reenvia é o worker que acabou de subir)
#                 e diz quantos voltaram.
#   manual      → o do `religar-telefonia.sh`. Além da porta, cobra os números:
#                 com a porta certa e algum número fora, reenvia uma vez.
#   reenviar    → o do `religar-telefonia.sh --reenviar`. Reenvia SEMPRE, mesmo
#                 com tudo "registrado". Existe para o caso em que o reinício do
#                 worker foi adiado por causa de uma ligação: numa operadora que
#                 aceita qualquer porta, o número fica "registrado" pela porta
#                 errada, e daqui não há como distinguir esse registro de um bom.
#
# O que ela NUNCA faz:
#   - agir com a telefonia desligada ou com o Asterisk fora do ar;
#   - mexer na tabela quando a medida diz que está tudo certo — limpar uma
#     conexão saudável é exatamente o que abre a corrida do cabeçalho;
#   - reiniciar o worker com ligação em curso, ou sem conseguir saber se há. A
#     atualização já derrubou as que havia ao recriar o Asterisk; uma que
#     começou DEPOIS não é dela para derrubar. Sem o reinício os números voltam
#     sozinhos, só mais devagar;
#   - falhar a atualização: quem chama põe `|| true`, e ela só devolve 1 para
#     dizer "não ficou bom" a quem perguntou (o script manual).
#
# Sai 0 = está bom (ou não havia o que fazer) · 1 = não ficou bom, e a saída diz
# o quê e o que rodar.
religar_troncos_sip() {  # religar_troncos_sip <atualizacao|manual|reenviar> [números registrados antes]
  local modo="${1:-manual}" antes="${2:-}" envfile=".env"
  local proj ast worker dados rodando imagem redes rede
  local medida certas desviadas presas lista lida total reg alvo nome rc
  local rodada=0 reenvio="" pendente="" refazer="" inicio=0 desde=0

  telefonia_ligada "$envfile" || return 0
  command -v docker >/dev/null 2>&1 || return 0
  proj="$(nome_do_projeto_atual)"
  ast="${proj}-asterisk-1"
  worker="${proj}-worker-1"
  case "$antes" in *[!0-9]*) antes="" ;; esac

  dados="$(com_prazo 30 docker inspect "$ast" --format '{{.State.Running}} {{.Image}} {{range .NetworkSettings.Networks}}{{.IPAddress}}/{{.IPPrefixLen}} {{end}}' 2>/dev/null)" || dados=""
  # O último nome do `read` fica com o resto da linha: todas as redes.
  read -r rodando imagem redes <<<"$dados" || true
  if [ "${rodando:-}" != true ] || [ -z "${redes:-}" ]; then
    c_ylw "⚠ A telefonia está ligada, mas o Asterisk não está no ar — nada a conferir na porta do telefone."
    c_ylw "  Veja: docker compose $(dc_files) logs --tail=30 asterisk"
    return 1
  fi
  rede="$(rede_de_saida_do_asterisk "$ast" "$redes")"

  while :; do
    # Os números ANTES da porta, nesta ordem: assim todo registro que esta
    # leitura enxerga já deixou a sua linha na tabela que a medida vai ler. Na
    # ordem inversa, um registro feito entre as duas passaria por "voltou" sem
    # ninguém ter olhado por que porta.
    if lista="$(registros_sip "$ast")"; then lida=1; else lista=""; lida=""; fi
    medida="$(medir_porta_sip "$imagem" "$rede")" || medida=""
    if [ -z "$medida" ]; then
      c_ylw "⚠ Telefonia: não consegui ler a tabela de conexões do servidor, então não sei se a"
      c_ylw "  porta ${PORTA_SIP} ficou presa. Olhe Conexões › Telefone: números em \"registro recusado\""
      c_ylw "  logo depois de uma atualização são isto."
      conserto_manual_da_porta_sip
      return 1
    fi
    read -r certas desviadas presas <<<"$medida" || true
    # Linha de Asterisk antigo não volta depois de apagada: o contêiner dela não
    # existe mais. "Presa" que reaparece depois da limpeza é outro programa VIVO
    # falando pela 5060 na mesma rede (a do proxy é compartilhada) — não
    # é nossa, e limpá-la de novo a cada volta só atrapalharia o vizinho.
    if [ "$rodada" -ge 1 ]; then presas=0; fi

    if [ $((desviadas + presas)) -gt 0 ]; then
      if [ "$rodada" -ge "$TELEFONIA_RODADAS" ]; then
        c_ylw "⚠ Telefonia: limpei a tabela de conexões ${rodada} vezes e o Asterisk continua saindo por outra porta"
        c_ylw "  que não a ${PORTA_SIP}. Alguma outra coisa está ficando com ela. Para ver quem:"
        c_ylw "    docker run --rm --net=host --cap-add=NET_ADMIN --entrypoint conntrack \\"
        c_ylw "      \"\$(docker inspect -f '{{.Image}}' ${ast})\" -L -p udp | grep 'port=${PORTA_SIP}'"
        c_ylw "  (o Asterisk é ${rede%%/*}; a linha de sport=${PORTA_SIP} que não é dele é a intrusa)."
        c_ylw "  Depois: bash hostgator-setup-kit/religar-telefonia.sh"
        return 1
      fi
      rodada=$((rodada + 1))
      [ "$inicio" -gt 0 ] || inicio="$(date +%s)"
      if [ "$rodada" -eq 1 ] && [ "$desviadas" -gt 0 ]; then
        c_ylw "  O Asterisk está saindo por outra porta que não a ${PORTA_SIP}, e a operadora recusa o registro. Corrigindo."
      elif [ "$rodada" -eq 1 ]; then
        c_ylw "  A porta do telefone (SIP ${PORTA_SIP}) ficou presa ao Asterisk anterior: o novo sairia por outra. Corrigindo."
      fi
      # LIMPAR. `-D` sai 1 quando não apaga nada (medido): não é erro daqui.
      conntrack_do_host "$imagem" -D -p udp --orig-port-src "$PORTA_SIP" >/dev/null 2>&1 || true
      # OCUPAR, colado na limpeza (a lista já foi lida, para não haver nada entre
      # os dois). O nome do REGISTRO serve de nome do ENDPOINT porque os quatro
      # objetos de um tronco levam o mesmo id (`objetosDoTronco`, em
      # lib/channels/telefonia/pjsip.ts). Ele vem da saída do Asterisk e entra
      # numa linha de comando: só passa o que tem cara de nome de objeto.
      while read -r nome _; do
        case "$nome" in ""|*[!A-Za-z0-9_.-]*) continue ;; esac
        perguntar_ao_asterisk "$ast" "pjsip qualify $nome" >/dev/null 2>&1 || true
      done <<<"$lista"
      c_dim "  limpei a tabela de conexões (só UDP, porta ${PORTA_SIP}): ${presas} presa(s), ${desviadas} desviada(s)"
      # Se o Asterisk novo JÁ falou pela porta errada, o registro pode ter sido
      # recusado e estar na espera longa: vai ser preciso reenviar. Se só havia a
      # linha antiga, o worker ainda nem enviou os números, e reiniciá-lo só
      # atrasaria o envio.
      if [ "$desviadas" -gt 0 ]; then pendente=1; refazer=1; fi
      sleep 1
      continue
    fi

    # Daqui para baixo a porta está certa.
    #
    # Na atualização, com a porta certa de primeira e sem número nenhum para
    # esperar (não havia registrado antes, ou não deu para saber): uma linha e
    # segue. Havendo, cai na espera abaixo — sem reiniciar nada: quem reenvia é
    # o worker que acabou de subir, e "a porta não ficou presa" lido uma vez,
    # antes de o Asterisk novo ter falado, ainda não é "os números voltaram".
    if [ "$rodada" -eq 0 ] && [ "$modo" = atualizacao ] && [ "${antes:-0}" -eq 0 ]; then
      c_grn "✓ telefonia: a porta ${PORTA_SIP} não ficou presa — nada a corrigir"
      return 0
    fi
    # No modo `reenviar` o reenvio é devido desde o começo: sem ele feito, nada
    # do que a lista do Asterisk disser conta como "voltou".
    if [ "$modo" = reenviar ] && [ -z "$reenvio" ]; then pendente=1; refazer=1; fi

    # REENVIAR só agora, com a porta CONFERIDA: o registro novo sai pela conexão
    # que acabou de ser medida. Reiniciar o worker logo depois da limpeza, sem
    # olhar, gastava um reinício por tentativa quando a corrida era perdida
    # (medido no laboratório, sem o passo OCUPAR: três limpezas, três reinícios).
    if [ -n "$pendente" ]; then
      pendente=""
      desde="$(date +%s)"
      rc=0; reenviar_numeros_sip "$ast" "$worker" || rc=$?
      case "$rc" in 0) reenvio=feito ;; 2) reenvio=adiado ;; *) reenvio=falhou ;; esac
      # O prazo de espera conta do reinício, não da primeira limpeza: só o
      # `docker restart` pode levar dez segundos, e o worker ainda tem de subir.
      # E a lista lida no topo desta volta é a de ANTES dele.
      if [ "$reenvio" = feito ]; then inicio="$desde"; sleep "$TELEFONIA_PAUSA"; continue; fi
    fi

    total="$(printf '%s\n' "$lista" | awk 'NF { n++ } END { printf "%d", n }')"
    reg="$(printf '%s\n' "$lista" | awk '$2 == "Registered" { n++ } END { printf "%d", n }')"
    # A régua de "voltaram": os que estavam registrados antes — inclusive ZERO
    # (um número que já era recusado antes não vira motivo de espera) e inclusive
    # MAIS do que o Asterisk tem agora (aí falta o worker enviar algum). Sem
    # saber quantos eram, a régua é todos.
    alvo="${antes:-$total}"

    # À mão, com a porta certa e o Asterisk sem número nenhum: não há o que
    # religar, e reiniciar o worker de quem só veio conferir seria mexer sem
    # motivo. Se há número cadastrado e ele não chegou aqui, o `--reenviar` é que
    # faz o worker empurrar.
    if [ "$modo" = manual ] && [ "$rodada" -eq 0 ] && [ -n "$lida" ] && [ "$total" -eq 0 ]; then
      c_grn "✓ telefonia: a porta ${PORTA_SIP} está certa, e o Asterisk não tem número nenhum para registrar."
      c_dim "  (se há número cadastrado em Conexões › Telefone, o worker não o enviou: rode com --reenviar)"
      return 0
    fi

    # "Registrado" só vale como prova quando o registro é NOVO:
    #   - se o Asterisk chegou a falar pela porta errada (`refazer`), o que está
    #     na lista pode ser o registro feito por ela — só conta depois de reenviado;
    #   - depois de um reinício, só conta com o worker tendo reenviado de fato.
    if [ -n "$lida" ] && [ "$total" -gt 0 ] && [ "$reg" -ge "$alvo" ] \
       && { [ -z "$refazer" ] || [ "$reenvio" = feito ]; } \
       && { [ "$reenvio" != feito ] || worker_reenviou_desde "$worker" "$desde"; }; then
      if [ "$rodada" -gt 0 ]; then
        c_grn "✓ telefonia: porta ${PORTA_SIP} recuperada — ${reg} de ${total} número(s) registrado(s) na operadora"
      elif [ "$reenvio" = feito ]; then
        c_grn "✓ telefonia: números reenviados — ${reg} de ${total} registrado(s) na operadora, pela porta ${PORTA_SIP}"
      elif [ "$modo" = atualizacao ]; then
        c_grn "✓ telefonia: a porta ${PORTA_SIP} não ficou presa — ${reg} de ${total} número(s) registrado(s) na operadora"
      else
        # "Constam", e não "estão": sem ter reenviado, o que se leu foi a lista
        # do Asterisk — ver o modo `reenviar` no cabeçalho.
        c_grn "✓ telefonia: a porta ${PORTA_SIP} está certa e ${reg} de ${total} número(s) constam como registrados — nada a corrigir"
      fi
      if [ "$reg" -lt "$total" ]; then
        c_dim "  ($((total - reg)) já não estava(m) registrado(s) antes — o motivo está em Conexões › Telefone)"
      fi
      return 0
    fi

    # À mão, com a porta certa e número fora: reenvia, uma vez só.
    [ "$inicio" -gt 0 ] || inicio="$(date +%s)"
    if [ "$modo" != atualizacao ] && [ -z "$reenvio" ]; then
      desde="$(date +%s)"
      rc=0; reenviar_numeros_sip "$ast" "$worker" || rc=$?
      case "$rc" in 0) reenvio=feito; inicio="$desde" ;; 2) reenvio=adiado ;; *) reenvio=falhou ;; esac
    fi

    if [ "$reenvio" = adiado ]; then
      c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas falta o worker reenviar os números, e ele não foi"
      c_ylw "  reiniciado (o motivo está na linha acima). Eles se registram sozinhos em até 5 minutos."
      c_ylw "  Para adiantar, sem ligação em curso: bash hostgator-setup-kit/religar-telefonia.sh --reenviar"
      return 1
    fi
    if [ "$reenvio" = falhou ]; then
      c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas não consegui reiniciar o worker para ele reenviar os"
      c_ylw "  números. Reinicie à mão: docker restart ${worker}"
      return 1
    fi
    if [ $(( $(date +%s) - inicio )) -ge "$TELEFONIA_PRAZO_DOS_REGISTROS" ]; then
      if [ "$reenvio" = feito ] && ! worker_reenviou_desde "$worker" "$desde"; then
        c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa e reiniciei o worker, mas em ${TELEFONIA_PRAZO_DOS_REGISTROS} s não o vi"
        c_ylw "  reenviar os números ao Asterisk. Veja se ele subiu:"
        c_ylw "    docker compose $(dc_files) logs --tail=50 worker | grep -i telefonia"
      elif [ -z "$lida" ]; then
        c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas o Asterisk não respondeu quais números tem —"
        c_ylw "  não sei se registraram. Veja: docker compose $(dc_files) logs --tail=30 asterisk"
      elif [ "$total" -eq 0 ]; then
        c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas o Asterisk não recebeu número nenhum do worker"
        c_ylw "  em ${TELEFONIA_PRAZO_DOS_REGISTROS} s. Se há número cadastrado em Conexões › Telefone, veja:"
        c_ylw "    docker compose $(dc_files) logs --tail=50 worker | grep -i telefonia"
      elif [ -n "$antes" ] && [ "$antes" -gt "$total" ]; then
        c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas o Asterisk só recebeu ${total} número(s) do worker em"
        c_ylw "  ${TELEFONIA_PRAZO_DOS_REGISTROS} s, e antes da atualização havia ${antes} registrado(s). Veja o que o worker diz:"
        c_ylw "    docker compose $(dc_files) logs --tail=50 worker | grep -i telefonia"
      else
        c_ylw "⚠ Telefonia: a porta ${PORTA_SIP} está certa, mas só ${reg} de ${total} número(s) registraram em ${TELEFONIA_PRAZO_DOS_REGISTROS} s."
        if [ -n "$antes" ]; then c_ylw "  Antes da atualização eram ${antes}."; fi
        c_ylw "  Aí não é mais a porta: é a operadora ou a senha. O motivo está em Conexões › Telefone."
      fi
      return 1
    fi
    sleep "$TELEFONIA_PAUSA"
  done
}

# Completa o pin AUSENTE no .env, com a versão que a imagem EM EXECUÇÃO declara.
#
# A regra que torna isto seguro: **só preenche lacuna, nunca sobrescreve valor
# explícito.** Chave ausente é omissão do `update.sh` antigo; chave presente é
# decisão de quem opera — inclusive a decisão de seguir um canal móvel de
# propósito. Um cron que corrigisse escolha alheia seria pior que o defeito.
#
# E a versão gravada é a que o contêiner JÁ está rodando (label
# `org.opencontainers.image.version` da imagem em uso), não a do app. A diferença
# importa: se o worker estiver numa versão diferente do app, gravar a do app
# MUDARIA o que roda no próximo `up -d` — possivelmente um downgrade. Gravando o
# que já está lá, a operação é congelamento puro: nada muda de comportamento
# agora, e o próximo `update.sh` alinha as três.
#
# Ecoa os serviços corrigidos, separados por espaço. Vazio = nada a fazer.
completar_pin_ausente() {  # completar_pin_ausente [envfile]
  local envfile="${1:-.env}" par chave svc repo img ver corrigidos=""
  [ -f "$envfile" ] || return 0
  # Esta guarda vale para execução não-root e não custa nada. NÃO é ela que
  # protege o caso real: o cron roda como root, e root ignora `chmod`. Quem
  # protege é a atomicidade do `set_env_var` (escreve num `.tmp` e faz `mv`) —
  # medido com `chattr +i`, que barra até root: a escrita falha, a função sai 0
  # e o `.env` original chega intacto do outro lado, com as customizações.
  [ -w "$envfile" ] || return 0

  for par in "WORKER_IMAGE:worker:deskcomm-worker" "SCHEDULER_IMAGE:scheduler:deskcomm-scheduler"; do
    chave="${par%%:*}"; svc="$(printf '%s' "$par" | cut -d: -f2)"; repo="${par##*:}"

    # LACUNA apenas. Valor explícito (mesmo em canal móvel) é intocável.
    if { grep -qE "^${chave}=" "$envfile" 2>/dev/null; }; then continue; fi

    img="$(docker inspect "$(nome_do_projeto_atual)-${svc}-1" --format '{{.Config.Image}}' 2>/dev/null)" || img=""
    [ -n "$img" ] || continue
    ver="$(docker image inspect "$img" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || ver=""
    # `<no value>` = imagem sem o label (build local). Canal não é versão.
    case "$ver" in ""|"<no value>"|latest|main|stable) continue ;; esac

    set_env_var "$envfile" "$chave" "${IMG_NS}/${repo}:${ver}"
    set_env_var "$envfile" "${chave%_IMAGE}_PULL_POLICY" missing
    corrigidos="$corrigidos $svc"
  done
  printf '%s' "${corrigidos# }"
}

# Escreve no .env as três imagens da MESMA versão + o pull_policy que combina
# com a mutabilidade da tag.
#
# As três juntas porque elas sobem juntas: app numa versão e worker em `latest`
# é a matriz de compatibilidade que ninguém testou. E o pull_policy não é
# detalhe — foi medido que, com `always` e o registry sem responder para aquela
# referência, o `up -d` FALHA e o contêiner não sobe, mesmo com a imagem já no
# disco. Numa tag imutável isso não protege de nada e só amarra a subida do CRM
# do cliente à disponibilidade do GHCR.
#
#   gravar_imagens .env 1.2.1   → pinado,  pull_policy=missing
#   gravar_imagens .env latest  → canal,   pull_policy=always
gravar_imagens() {
  local envfile="$1" versao="$2" politica
  case "$versao" in
    latest|main|stable) politica="always" ;;
    *)                  politica="missing" ;;
  esac
  set_env_var "$envfile" APP_IMAGE             "${IMG_APP}:${versao}"
  set_env_var "$envfile" APP_PULL_POLICY       "$politica"
  set_env_var "$envfile" WORKER_IMAGE          "${IMG_WORKER}:${versao}"
  set_env_var "$envfile" WORKER_PULL_POLICY    "$politica"
  set_env_var "$envfile" SCHEDULER_IMAGE       "${IMG_SCHEDULER}:${versao}"
  set_env_var "$envfile" SCHEDULER_PULL_POLICY "$politica"
  set_env_var "$envfile" ASTERISK_IMAGE        "${IMG_ASTERISK}:${versao}"
  set_env_var "$envfile" ASTERISK_PULL_POLICY  "$politica"
}

# ── As imagens das versões que ficaram para trás ─────────────────────────────
#
# Cada atualização puxa as imagens da versão nova e as da anterior continuam no
# disco — para sempre, porque nada as apagava. Medido na VPS de produção: ~3,2 GB
# por release (app, worker, scheduler, Asterisk). Em 2026-09-24 eram 21 versões e
# o disco estava em 73%; limpo à mão. Em 2026-10-05, onze dias depois, 26 versões
# e 88%. E a instalação se atualiza sozinha pelo cron do `agent.sh`: o disco
# enche sem ninguém ter entrado por SSH, e disco cheio derruba o CRM inteiro.
#
# A REGRA mora em `imagens_de_versoes_antigas`, que é só texto: recebe no stdin
# o que há no disco (`repo:tag`, uma por linha) e ecoa o que pode sair. Ficam:
#   - a versão ALVO, que é a que acabou de subir;
#   - UMA de reserva: a que RODAVA antes desta atualização — a última que este
#     servidor viu funcionar. Quem informa é o `update.sh`, lendo o contêiner
#     antes de recriá-lo (`versao_no_ar`). Quando não dá para saber (stack
#     parada, imagem sem o rótulo), ou quando ela é o próprio alvo (`--force` na
#     mesma versão), a reserva é a MAIOR das outras.
#
# "A maior das outras" sozinha não serve de regra, e o caso que a derruba é o
# que mais importa: a atualização para a N falha, o `agent.sh` volta para a N-1,
# e dias depois a N+1 sobe. No disco, a maior das outras é a N — a que quebrou —
# e a N-1, que é para onde o dono voltaria, seria apagada.
#
# O que ela NÃO toca, e cada linha é uma decisão:
#   - nada fora dos quatro repositórios de `IMG_*`, comparados pelo nome INTEIRO.
#     A VPS do cliente tem imagem que não é nossa (medido: um `openclaw` de 7 GB
#     com contêiner próprio), e o mesmo nome em OUTRO namespace é outro produto
#     (docs/runbooks/repositorio-proprio.md §5);
#   - nada que não seja tag de versão numerada (`X.Y.Z`): canal móvel é escolha
#     de quem opera, e prerelease ninguém instalou por este caminho;
#   - nada, se o ALVO não estiver no disco. Depois de uma atualização que deu
#     certo ele está; se não está, quem chamou passou a versão errada, e uma
#     régua que não mede esta instalação não apaga nada dela. É também esta
#     guarda que cala a função para alvo em canal móvel, vazio ou prerelease:
#     nenhum deles é tag numerada, então nunca está entre as nossas.
#
# A versão é da INSTALAÇÃO, não de cada repositório: os quatro sobem juntos na
# mesma versão (`gravar_imagens`), então a reserva de um é a reserva de todos.
versao_numerada() { [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# A versão que o contêiner do app está RODANDO agora, ou vazio se não dá para
# saber. Lê o rótulo `org.opencontainers.image.version`, que o CI grava na imagem
# e o contêiner herda — e não a referência com que ele foi criado: depois de um
# rollback do `agent.sh` essa referência é um ID local, sem tag, e é justamente
# aí que saber a versão importa. Medido na VPS de produção (Docker 29.8.0): os
# quatro contêineres nossos respondem `1.52.2`; um contêiner sem o rótulo
# responde vazio; um que não existe sai != 0.
versao_no_ar() {
  local ver
  command -v docker >/dev/null 2>&1 || return 0
  ver="$(docker inspect "$(nome_do_projeto_atual)-app-1" \
          --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || ver=""
  if versao_numerada "$ver"; then printf '%s' "$ver"; fi
  return 0
}

imagens_de_versoes_antigas() {  # imagens_de_versoes_antigas <versão alvo, sem o "v"> [versão que rodava]   ← stdin: `repo:tag` por linha
  local alvo="${1:-}" rodava="${2:-}" ref nossas="" tem_alvo="" tem_a_que_rodava="" reserva=""

  while IFS= read -r ref; do
    # `##*:` e `%:*` cortam no ÚLTIMO dois-pontos: o repositório pode ter outro
    # (registro com porta), e a tag nunca tem.
    versao_numerada "${ref##*:}" || continue
    case "${ref%:*}" in
      "$IMG_APP"|"$IMG_WORKER"|"$IMG_SCHEDULER"|"$IMG_ASTERISK") ;;
      *) continue ;;
    esac
    nossas="${nossas}${ref}"$'\n'
    if [ "${ref##*:}" = "$alvo" ]; then tem_alvo=1; fi
    if [ "${ref##*:}" = "$rodava" ]; then tem_a_que_rodava=1; fi
  done
  [ -n "$tem_alvo" ] || return 0

  # A que rodava só vale como reserva se ESTÁ no disco (guardar um número que
  # não corresponde a imagem nenhuma é não guardar reserva) e se não é o alvo
  # (aí a reserva seria o próprio alvo, e todas as outras sairiam).
  if [ -n "$tem_a_que_rodava" ] && [ "$rodava" != "$alvo" ]; then
    reserva="$rodava"
  else
    # Ordem NUMÉRICA, campo a campo: na ordem de texto a 1.9.0 vem depois da
    # 1.10.0, e a reserva escolhida seria a errada.
    #
    # Uma conta que saiu != 0 tem o resultado DESCARTADO, mesmo que tenha ecoado
    # algo com cara de versão.
    reserva="$(printf '%s' "$nossas" | sed 's/.*://' | { grep -vxF "$alvo" || true; } \
              | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" || reserva=""
  fi
  # Sem reserva decidida, não sai nada. Vazio é o caso normal de "só há o alvo";
  # mas é também o que sobra se a conta acima falhar, e aí a alternativa seria
  # apagar tudo menos o alvo — errar para o lado de onde não se volta.
  [ -n "$reserva" ] || return 0

  printf '%s' "$nossas" | while IFS= read -r ref; do
    case "${ref##*:}" in
      "$alvo"|"$reserva") ;;
      *) printf '%s\n' "$ref" ;;
    esac
  done
  return 0
}

# O EFEITO: lista o disco, aplica a regra acima e apaga.
#
# Três escolhas que não são detalhe:
#   - `docker rmi` SEM `-f`, uma referência por vez. Imagem que algum contêiner
#     usa — de pé ou parado, desta instalação ou de outra na mesma VPS — o Docker
#     recusa, e a recusa é a resposta certa: quem sabe o que está em uso é ele.
#   - nunca `docker image prune` nem `system prune`: eles decidem pelo disco
#     INTEIRO, e o que é "sem uso" na VPS de outra pessoa não é pergunta nossa.
#   - NUNCA falha. Disco é manutenção: uma atualização que subiu, respondeu
#     saudável e sai != 0 porque não deu para apagar imagem velha faria o
#     `agent.sh` voltar a versão — desfazendo o que deu certo.
#
# Quem chama é o `update.sh`, e só DEPOIS de o app novo responder saudável. Antes
# disso a imagem que rodava é a rede de proteção do `agent.sh`
# (`PREV_IMAGE`), e nada aqui pode encostar nela. O 2º argumento é a versão que
# rodava (`versao_no_ar`, lida antes do `up -d`); vazio = não se sabe.
#
# O que se perde é só tempo de download: as versões são públicas e o
# `pull_policy` da tag fixada é `missing` — um `up -d` que precise de uma versão
# apagada a puxa de novo.
apagar_imagens_antigas() {  # apagar_imagens_antigas <versão alvo, sem o "v"> [versão que rodava]
  local alvo="${1:-}" rodava="${2:-}" lista antigas ref versoes="" n=0 presas=0
  versao_numerada "$alvo" || return 0
  command -v docker >/dev/null 2>&1 || return 0

  if ! lista="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)"; then
    c_ylw "⚠ não consegui listar as imagens do Docker — não apaguei nenhuma versão antiga."
    c_ylw "  A atualização não depende disso; na próxima eu tento de novo."
    return 0
  fi
  antigas="$(printf '%s\n' "$lista" | imagens_de_versoes_antigas "$alvo" "$rodava")" || antigas=""
  if [ -z "$antigas" ]; then
    c_grn "✓ nenhuma versão antiga ocupando o disco."
    return 0
  fi

  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if docker rmi "$ref" >/dev/null 2>&1; then
      case " $versoes " in
        *" ${ref##*:} "*) ;;
        *) versoes="$versoes ${ref##*:}"; n=$((n + 1)) ;;
      esac
    else
      presas=$((presas + 1))
    fi
  done <<<"$antigas"

  if [ "$n" -eq 1 ]; then
    c_grn "✓ apaguei as imagens da versão${versoes}, que só ocupavam disco (ficam a ${alvo}, que está no ar, e mais uma de reserva)."
  elif [ "$n" -gt 1 ]; then
    c_grn "✓ apaguei as imagens de ${n} versões antigas, que só ocupavam disco (ficam a ${alvo}, que está no ar, e mais uma de reserva)."
  fi
  if [ "$presas" -eq 1 ]; then
    c_dim "  (1 imagem antiga ficou: o Docker não apaga o que algum contêiner ainda usa.)"
  elif [ "$presas" -gt 1 ]; then
    c_dim "  (${presas} imagens antigas ficaram: o Docker não apaga o que algum contêiner ainda usa.)"
  fi
  return 0
}

# ── Os segredos da chamada de voz, no .env de quem já tinha instalado ────────
#
# A doutrina de packaging é literal: "bump de versão não pode exigir que o
# operador edite `.env`, compose ou qualquer arquivo à mão". A chamada de voz
# (spec 18) trouxe três chaves novas, e o serviço NÃO SOBE sem duas delas.
#
# Quem instalou antes desta versão não as tem. Sem esta função, o dia em que ele
# quisesse ligar a voz começaria por inventar dois segredos num editor de texto
# dentro de uma VPS — que é exatamente o passo que a doutrina proíbe.
#
# LACUNA APENAS, como `completar_pin_ausente`: chave já presente (mesmo vazia
# por escolha de quem operou) é intocável. Preencher só o que falta é a
# diferença entre curar e sobrescrever.
#
# ⚠️ ISTO NÃO LIGA A FEATURE. As chaves geradas ficam paradas até alguém pôr
# `voz` em COMPOSE_PROFILES: sem o profile, o compose nem cria o contêiner.
# Gerar credencial para um serviço desligado não é risco — é o que faz o
# desligado poder virar ligado sem passo manual.
completar_segredos_da_voz() {  # completar_segredos_da_voz [envfile]
  local envfile="${1:-.env}" criados="" chave
  [ -f "$envfile" ] || return 0
  # Somente-leitura (montagem read-only, permissão errada): não é erro daqui.
  [ -w "$envfile" ] || return 0

  for chave in WACALLS_ADMIN_USER WACALLS_ADMIN_PASSWORD WACALLS_API_TOKEN; do
    # `^CHAVE=` casa inclusive a linha com valor vazio — que é presença, não
    # lacuna. Só a AUSÊNCIA da linha é preenchida.
    grep -qE "^${chave}=" "$envfile" && continue
    if [ "$chave" = "WACALLS_ADMIN_USER" ]; then
      set_env_var "$envfile" "$chave" "deskcomm"
    else
      set_env_var "$envfile" "$chave" "$(openssl rand -hex 32)"
    fi
    criados="$criados $chave"
  done

  printf '%s' "${criados# }"
}

# ── O segredo da telefonia SIP (spec 20), no .env de quem já tinha instalado ──
#
# Mesmo racional de `completar_segredos_da_voz`: gerar a senha da ARI não liga
# nada (sem `telefonia` em COMPOSE_PROFILES o Asterisk nem é criado, e sem
# TELEFONIA_ARI_URL o app e o worker não o procuram). Só impede que ligar a
# telefonia comece por inventar um segredo num editor dentro da VPS.
completar_segredos_da_telefonia() {  # completar_segredos_da_telefonia [envfile]
  local envfile="${1:-.env}"
  [ -f "$envfile" ] || return 0
  [ -w "$envfile" ] || return 0
  grep -qE "^TELEFONIA_ARI_PASSWORD=" "$envfile" && return 0
  set_env_var "$envfile" TELEFONIA_ARI_PASSWORD "$(openssl rand -hex 32)"
  printf 'TELEFONIA_ARI_PASSWORD'
}

# Grava (ou reescreve) uma chave no .env — sem duplicar linha se ela já existe.
#   set_env_var .env APP_IMAGE ghcr.io/…:1.1.0
#
# É o que faz uma escolha SOBREVIVER ao processo que a fez. `export APP_IMAGE=…`
# vale só enquanto o script roda: o docker-compose.prod.yml lê a imagem do .env,
# então um `docker compose up -d` rodado à mão pelo dono semanas depois (comando
# documentado no README) voltaria pro APP_IMAGE gravado no install (":latest") e
# DESFARIA a atualização — app do topo da main sobre o banco da versão
# instalada, exatamente o modo de falha pelo qual o Watchtower foi descartado.
set_env_var() {
  local envfile="$1" key="$2" value="$3" tmp
  [ -f "$envfile" ] || return 0
  tmp="${envfile}.tmp.$$"
  # "|| true": com pipefail, grep -v que filtra TODAS as linhas (arquivo de uma
  # linha só) sai 1 e derrubaria o script por set -e antes do append.
  { grep -vE "^${key}=" "$envfile" || true; } > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"   # o .env tem segredos: o tmp nasce com o mesmo rigor
  mv "$tmp" "$envfile"
}

# Resolve o UUID de um usuário pelo e-mail (admin API do Supabase).
#
# ── O `filter` do GoTrue é BUSCA POR SUBSTRING, não expressão ────────────────
# Esta função pedia `?filter=email.eq.<email>` — sintaxe do PostgREST, que o
# GoTrue não fala. Ele trata a string inteira como termo de busca, nenhum e-mail
# contém "email.eq.", e a resposta é SEMPRE vazia. Medido em 2026-08-31 contra o
# projeto de produção, com um e-mail que existe:
#
#   GET /auth/v1/admin/users?filter=email.eq.<existente>  → 200 {"users":[]}
#   GET /auth/v1/admin/users?filter=<existente>           → 200 {"users":[<ele>]}
#
# Consequência: `reset-password.sh` morria com "Usuário '<email>' não
# encontrado" para TODO e-mail — o único caminho de recuperação de senha de uma
# instalação sem SMTP, que é o estado normal de um self-host, e o mesmo comando
# que o CLAUDE.md do kit manda usar quando a pessoa se tranca fora.
#
# ── Por que o casamento tem de ser EXATO aqui ───────────────────────────────
# Justamente por ser substring, `ana@empresa.com` casa também
# `mariana@empresa.com`. Um `head -1` cego devolveria o UUID da outra pessoa
# numa função cujo único consumidor TROCA SENHA. O padrão abaixo ancora no
# prefixo do objeto de usuário (id→aud→role→email, nessa ordem), que nenhum
# objeto aninhado de `identities` tem — e exige o e-mail inteiro, com os pontos
# escapados (em BRE `.` casa qualquer caractere, e sem escapar
# `elias.gervanno@x` casaria `eliasXgervanno@x`).
#
# Falha FECHADA: se o GoTrue mudar a ordem dos campos, o padrão não casa e a
# função devolve vazio — quem chama morre com "não encontrado", que é ruim mas
# recuperável. Devolver o UUID errado, não.
#
# ── Por que o `|| return 0` do fim não é enfeite ────────────────────────────
# `_common.sh` roda sob `set -euo pipefail`, e o consumidor resolve o UUID numa
# ATRIBUIÇÃO: `uid="$(owner_id_by_email "$EMAIL")"`. O status da atribuição é o
# da substituição, então uma função que devolve não-zero mata o script ALI — na
# linha de cima do `[ -n "$uid" ] || die "Usuário não encontrado."`, que nunca
# chega a rodar. E o `grep` devolve 1 justamente quando não casa ninguém, que é
# o caso em que a mensagem existe para falar.
#
# Medido em 2026-09-03 contra o GoTrue local v2.188.1, e-mail inexistente, as
# duas linhas reais do reset-password.sh: rc=1 e NENHUMA saída — o operador que
# erra uma letra no endereço não vê aviso nenhum, só o prompt de volta. "Não
# encontrado" era uma mensagem inalcançável. O `|| return 0` põe a decisão onde
# ela pertence: a função devolve VAZIO, e quem chama decide o que dizer.
owner_id_by_email() {
  local email="$1" resp esc
  resp="$(curl -fsS "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=${email}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null)" || return 0
  esc="$(printf '%s' "$email" | sed 's/[.[\*^$]/\\&/g')"
  printf '%s' "$resp" \
    | grep -o "\"id\":\"[0-9a-f-]\{36\}\",\"aud\":\"[^\"]*\",\"role\":\"[^\"]*\",\"email\":\"${esc}\"" \
    | head -1 | sed 's/^"id":"//;s/".*//' || return 0
}

# Ativa (idempotente) o cron que dispara o drain de eventos a cada minuto. SEM
# isso, nenhuma automação/webhook roda num self-host: neste kit os workers são
# lidos por cron, não por trigger→HTTP nem fila gerenciada (doutrina do
# projeto: trigger Postgres nunca faz HTTP). Chamada por install.sh e
# update.sh — re-rodar não duplica a linha do crontab.
# ── Cron: uma instalação nunca mexe na linha de outra ────────────────────────
# O filtro era `crontab -l | grep -v 'event-log-drain' | crontab -`: casava com
# a linha de QUALQUER instalação do host. Instalar uma segunda instância na
# mesma VPS apagava as duas linhas da primeira — o drain de eventos e o agente
# de atualização — em silêncio, e o dono só descobriria pelo que parou de
# acontecer. Confirmado numa VPS com produção rodando: as linhas dela seriam
# levadas por uma instalação nova em outra pasta.
#
# Agora cada linha carrega um marcador com o diretório da instalação, e o
# filtro remove só as que são dela.
# O marcador identifica a instalação E O PAPEL da linha. O papel não é enfeite:
# com um marcador só por instalação, a segunda função a rodar apagava a linha da
# primeira (o filtro remove tudo que casa com o marcador, e as duas linhas
# casavam). Medido na VPS: depois de instalar, sobrava só o agente e o CRM ficava
# SEM o drain de eventos — a automação inteira parada, em silêncio.
cron_tag() { printf '# deskcomm:%s:%s' "${PROJECT_DIR:-$PWD}" "${1:?papel da linha (drain|agent)}"; }

# Puro (testável sem tocar no crontab real): lê o crontab atual em stdin e
# imprime o novo. Tira as linhas DESTA instalação — pelo marcador, e também
# pela `assinatura` para as linhas legadas, escritas antes de o marcador
# existir, que sem isso ficariam duplicadas a cada re-execução.
cron_merge() {  # cron_merge <marcador> <assinatura_legada> <linha_nova>
  local marcador="$1" legado="$2" nova="$3"
  { grep -vF -e "$marcador" | grep -vF -e "$legado"; } || true
  printf '%s\n' "$nova"
}

setup_event_log_drain_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — instale o pacote 'cron' e rode de novo pra ativar as automações."; return 0; }

  local secret="${INTERNAL_CRON_SECRET:-}"
  [ -n "$secret" ] || secret="${INTERNAL_SECRET:-}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — não ativei o cron das automações."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o cron das automações."; return 0; }

  local url_drain="${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain"
  local marcador; marcador="$(cron_tag drain)"

  # "primeira vez" é sobre ESTA instalação, não sobre o host: com o teste antigo
  # ('existe alguma linha de event-log-drain?'), uma instalação nova numa VPS
  # que já roda outra se achava veterana e pulava a higienização de eventos.
  local first_time=1
  if crontab -l 2>/dev/null | grep -qF -e "$url_drain"; then first_time=0; fi

  local cron_line="* * * * * curl -fsS -H \"Authorization: Bearer ${secret}\" \"${url_drain}\" >/dev/null 2>&1 ${marcador}"
  # ⚠️ `|| true` OBRIGATÓRIO, e não é defensividade: `crontab -l` sai com status
  # 1 (sem stdout, só um aviso no stderr) quando o usuário NUNCA teve crontab —
  # o caso NORMAL de uma VPS recém-provisionada, que é o caso normal de quem
  # instala este produto. Sob `set -o pipefail` (linha 3 deste arquivo, e
  # `install.sh:12`) esse 1 vaza pelo pipe mesmo com os estágios seguintes
  # bem-sucedidos — `false | true` também sai 1 —, e o `set -e` mata o
  # instalador AQUI, no bloco 11, DEPOIS de a linha do cron já ter sido gravada.
  # O dono vê o script morrer sem mensagem, numa instalação que na verdade
  # funcionou.
  #
  # ACHADO DUAS VEZES, POR DUAS PESSOAS QUE NÃO SE FALARAM, NO MESMO DIA:
  # @luiscgc91 (PR #683) e @rafaelbatistazz (issue #715 + PR #726), os dois
  # instalando numa VPS limpa. Os dois escreveram EXATAMENTE a mesma linha. Isso
  # não é redundância — é a medida de quanto o defeito doía, e a razão de este
  # comentário ser longo: ele existe para a terceira pessoa não precisar
  # descobrir de novo.
  #
  # A issue #715 descreve o sintoma como quem o viveu: o instalador para logo
  # depois de "✓ chave de cifra ativa no banco", cai na tela "A instalação
  # parou", e os contêineres estão SAUDÁVEIS. Rodar de novo passa — porque aí o
  # crontab já não está vazio, o que faz o defeito parecer fantasma.
  #
  # Reproduzido com um dublê de `crontab` que sai 1 no `-l`: sem o `|| true`, a
  # linha seguinte a este bloco nunca é alcançada. Vigiado por DOIS testes, de
  # propósito: `tests/shell/cron-sem-crontab-previo.test.sh` mede cada função
  # isolada, e o bloco `cron numa VPS sem crontab nenhum` de
  # `hostgator-setup-kit/test-validators.sh` (de @rafaelbatistazz) roda AS DUAS
  # no mesmo processo — como o `install.sh` faz — e confere que as duas linhas
  # foram gravadas.
  #
  # Stdin vazio para o `cron_merge` é exatamente o que "sem crontab prévio" deve
  # produzir — o comportamento não muda, só o status.
  ( { crontab -l 2>/dev/null || true; } | cron_merge "$marcador" "$url_drain" "$cron_line" ) | crontab -
  c_grn "✓ automações ativas (cron do event-log-drain, a cada minuto)"

  if [ "$first_time" = 1 ]; then
    # 1ª ativação do cron (inclusive numa instalação já existente que nunca
    # teve o drain rodando): pode haver eventos 'pending' antigos acumulados.
    # Se o 1º drain os processasse, dispararia efeitos colaterais atrasados
    # (ex.: webhook de dias/semanas atrás) — surpresa indesejada pro dono do
    # CRM. Marcamos como 'done' só os realmente velhos (>7 dias); os recentes
    # continuam 'pending' e processam normalmente no próximo drain.
    step "Higienizando eventos pendentes antigos (1ª ativação do cron)"
    psql_run -c "update event_log set status='done', updated_at=now() where status='pending' and created_at < now() - interval '7 days';" \
      >/dev/null 2>&1 \
      && c_grn "✓ eventos pendentes com mais de 7 dias marcados como concluídos" \
      || c_ylw "⚠ não consegui higienizar eventos antigos — confira manualmente a tabela event_log se necessário."
  fi
}

# Ativa (idempotente) o cron do agente de atualização: a cada 5 minutos ele
# avisa o app da versão instalada e, se alguém clicou em "Atualizar agora" na
# tela, roda o update.sh sozinho. É o que faz o botão da tela existir de
# verdade — sem cron, a tela mostra "atualização automática indisponível" pra
# sempre. Chamada por install.sh e update.sh (bloco 7) — re-rodar não duplica
# a linha do crontab.
setup_update_agent_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar."; return 0; }
  local secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET — não ativei o agente de atualização."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização."; return 0; }

  # `cd` explícito: o agent.sh chama enter_project(), que acha o projeto pelo
  # DIRETÓRIO CORRENTE. No cron o CWD é o home do dono do crontab — sem o cd,
  # a linha só funciona por acidente (instalação padrão em /root/deskcommcrm) e
  # morre calada a cada 5 minutos em qualquer REPO_DIR customizado ou /opt.
  # A assinatura legada inclui o PROJECT_DIR: é o que distingue a linha desta
  # instalação da linha de uma vizinha, que roda o mesmo agent.sh em outra pasta.
  local legado="cd ${PROJECT_DIR} && bash hostgator-setup-kit/agent.sh"
  local marcador; marcador="$(cron_tag agent)"
  local cron_line="*/5 * * * * ${legado} >/dev/null 2>&1 ${marcador}"
  # Mesmo motivo do drain acima, e é por isso que o conserto é nos DOIS: a
  # primeira instalação passa pelos dois blocos na mesma rodada.
  ( { crontab -l 2>/dev/null || true; } | cron_merge "$marcador" "$legado" "$cron_line" ) | crontab -
  c_grn "✓ atualização pela tela ativa (agente a cada 5 minutos)"
}

# Garante a chave de cifra dos segredos (webhooks/Nuvemshop) e a semeia no
# banco (private.app_secrets, migration 0041). Idempotente: reusa a chave do
# .env se existir (trocá-la invalidaria dados já cifrados); gera se ausente e
# appenda ao .env. Chamada por install.sh e update.sh APÓS aplicar o baseline.
ensure_encryption_key() {
  local envfile="${1:-.env}"
  local key="${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:-}"
  if [ -z "$key" ] && [ -f "$envfile" ]; then
    key="$(grep -E '^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=' "$envfile" | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
  fi
  if [ -z "$key" ]; then
    key="$(openssl rand -hex 32)"
    printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$envfile"
    c_grn "✓ chave de cifra dos segredos gerada e gravada no .env"
  fi
  export NUVEMSHOP_OAUTH_ENCRYPTION_KEY="$key"

  # Semeia no banco — é de lá que as funções de cifra leem (Supabase não
  # permite configurar a chave via parâmetro de banco).
  psql_run -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '${key}') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null 2>&1 \
    && c_grn "✓ chave de cifra ativa no banco (segredos de webhook são guardados cifrados)" \
    || c_ylw "⚠ não consegui semear a chave de cifra no banco — segredos de webhook não poderão ser salvos até rodar update.sh de novo."
}
