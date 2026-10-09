#!/usr/bin/env bash
# Prova do `hostgator-setup-kit/update.sh` num repositório git descartável, com
# `docker` e `crontab` substituídos por dublês — nada aqui toca a máquina de
# quem roda (nenhum container sobe, nenhum crontab real é escrito).
#
#   bash tests/shell/update-guard.test.sh
#
# O que está sob prova (defeitos reais achados na revisão final da branch):
#   1. Alvo ANTERIOR ao que está instalado é recusado ANTES do backup — numa
#      instalação que segue a `main`, `git describe --exact-match` é vazio e a
#      comparação de tags passa batido: sem a guarda de ancestralidade, o
#      script rebobinava a instalação para a última tag publicada.
#   2. `--force` continua sendo a saída explícita de quem quer mesmo voltar.
#   3. A imagem escolhida é GRAVADA no .env (não só exportada), sem duplicar a
#      chave a cada execução — senão o próximo `docker compose up -d` do dono
#      volta pro ":latest" e desfaz a atualização.
#   4. A linha de cron do agente entra na pasta do projeto (o agent.sh resolve
#      o projeto pelo diretório corrente, e no cron o CWD é o home).
#   5. Mesmo quando o update é recusado, o agente da tela fica instalado — é o
#      que faz o bootstrap pelo terminal ter fim.
#   6. `compare_failed` no heartbeat tem DUAS linhas independentes em
#      agent.sh que podem acendê-lo (CONTIDA=2 vindo do `is_already_in_head`,
#      e o fallback de "nenhuma tag conhecida + fetch falhou") — casos 8 e 9
#      isolam cada uma, provado por sabotagem cirúrgica de cada linha.
#   7. Código JÁ na tag nova + `.env` fixado na versão anterior NÃO é "nada a
#      atualizar" (caso 12). Medido em produção em 2026-09-19: a sonda por digest
#      compara a imagem fixada com ela mesma. O caso traz o próprio CONTROLE
#      (12b), porque o dublê de `docker` calado faria a prova passar por
#      vacuidade; e cinco sabotagens com previsão, uma por linha da regra:
#        sem o 1º critério ............ 12a×4 12c×4 12d×2
#        conferindo só o app .......... 12a×1 12c×4 12g×1
#        comparando só o número ....... 12d×2
#        canal móvel contando ......... 12e×2 12g×1
#        sem o 2º critério (digest) ... 12f×2
#   8. Ligar a telefonia (`telefonia` em COMPOSE_PROFILES) numa instalação JÁ na
#      última versão faz o update.sh subir o Asterisk, em vez de "Nada a
#      atualizar" (caso 14). Controles: tudo no alvo (14b), profile desligado
#      (14c), stack parada (14e). Sete sabotagens, medidas em 2026-09-28:
#        .env ignora o Asterisk ............... 14a×9
#        sem o critério do contêiner .......... 14d×5 14f×2
#        telefonia sempre "ligada" ............ 14c×4 14i×5 (+ 12a×1 12e×2 12g×7)
#        sem o export do ASTERISK_IMAGE ....... 14g×1
#        sem a prudência da stack parada ...... 14e×2 14h×1
#        sem a guarda do docker inspect ....... 14h×1
#        "segue DESLIGADA" com ela ligada ..... 14a×1
#   9. Atualização que deu certo apaga as imagens das versões antigas (caso 15).
#      Fica a instalada e UMA de reserva — a que rodava antes; sem dar para
#      saber, a maior das outras. Só os quatro repositórios de `IMG_*`, só tag
#      X.Y.Z; `docker rmi` sem `-f`, nunca `prune`; nunca antes de o app responder
#      saudável; e a limpeza não falha a atualização. O dublê de `docker` responde
#      lista VAZIA por padrão, então toda prova de "não apagou" vem ao lado de um
#      "apagou" na mesma rodada. Vinte e quatro sabotagens, uma por linha da
#      regra, medidas em 2026-10-05:
#        sem a chamada no update.sh ............... 15a×6 15d×3 15e×1 15i×2
#        limpeza ANTES da conferência de saúde .... 15a×2 15b×1 15d×1
#        sem a guarda "o alvo está no disco" ...... 15g×4
#        ordem de texto em vez de numérica ........ 15g×1
#        sem a reserva (fica só o alvo) ........... 15a×3 15d×2 15f×1 15g×12 15i×1
#        sem o filtro de repositório .............. 15a×4 15d×2 15f×1 15g×2
#        repositório por PREFIXO .................. 15a×2 15d×2 15f×1 15g×1
#        sem o filtro de tag numerada ............. 15a×4 15d×2 15f×1 15g×3
#        rmi com -f ............................... 15a×3 15d×2 15i×2
#        prune no lugar do rmi .................... 15a×5 15d×3 15f×1 15i×2
#        docker images sem guarda de erro ......... 15e×1 15f×1
#        docker rmi sem guarda de erro ............ 15d×2 15f×1
#        conta como apagada a que o Docker recusou  15d×2
#        sem a guarda do alvo não numerado ........ 15f×2
#        aceita a reserva de uma conta que falhou . 15g×1
#        sem a guarda "sem reserva, não sai nada" . 15g×1
#        sem o `|| true` de quem chama ............ 15h×1
#        reserva sempre a maior (ignora a que rodava) 15g×1 15i×2
#        aceita a que rodava mesmo FORA do disco .. 15g×1
#        aceita a que rodava mesmo sendo o ALVO ... 15g×1
#        update.sh não passa a que rodava ......... 15i×2
#        lê a versão no ar DEPOIS do up -d ........ 15i×2
#        versao_no_ar sem guarda de erro .......... 15f×1
#        versao_no_ar devolve o que não é versão .. 15f×2
#      O dublê não é o Docker: a recusa de imagem presa a contêiner PARADO, a
#      ordem numérica e o formato de `docker images` foram conferidos contra um
#      daemon de verdade (29.5.3), com imagens de mentira num namespace de teste;
#      e o rótulo de versão que `versao_no_ar` lê, nos contêineres da VPS de
#      produção (29.8.0).
#  10. Com a telefonia ligada, o update.sh confere a porta SIP 5060 depois do
#      `up -d` e antes da saúde do app, e essa conferência nunca falha a
#      atualização (caso 16). A REGRA do conserto é de
#      tests/shell/telefonia-porta-sip.test.sh; aqui está só o encaixe, com o
#      update.sh inteiro rodando. Seis sabotagens no update.sh, medidas em
#      2026-10-07 numa cópia da árvore:
#        sem o `|| true` de quem chama ............ 14a×1 14d×1 16b×2 16c×2
#        confere DEPOIS da saúde do app ........... 16a×1
#        sem a guarda de telefonia ligada ......... 16d×1
#        lê os registrados DEPOIS do up -d ........ 16a×1
#        sem a chamada no update.sh ............... 16a×5 16b×1 16c×1
#        confere ANTES do up -d ................... 16a×1
set -uo pipefail

# O namespace das imagens publicadas, lido da FONTE (hostgator-setup-kit/_common.sh)
# em vez de repetido aqui. Este arquivo tinha o literal em 29 lugares — fixtures e
# asserções —, o que amarrava a suíte a UM publicador: um fork que publica as
# próprias imagens fica vermelho sem ter quebrado nada. O que estes casos provam é
# que as três imagens andam na MESMA versão, e isso independe de quem publica.
#
# O CUSTO DE DERIVAR, e onde ele é pago. Enquanto o literal estava aqui, este
# arquivo era a única canária do repo contra um IMG_NS errado: um valor trocado
# reprovava 4 casos (medido). Derivando, ele deixa de reprovar — os testes
# passam a concordar entre si sobre o valor errado, que é a família do teste que
# mede a si mesmo. A proteção não sumiu: mudou de lugar, para
# `tests/unit/namespace-das-imagens.test.ts`, que assere o literal UMA vez e
# confere que o compose, o `.env` de exemplo e o workflow de publicação dizem o
# mesmo. Se você veio parar aqui procurando a guarda do namespace, é lá.
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
# Exportado porque o dublê de `docker` (escrito mais abaixo num heredoc quoted)
# resolve $NS em tempo de execução, já dentro de outro processo.
export NS


# Capturado ANTES de qualquer `cd`: o script muda de diretório várias vezes, e
# `${BASH_SOURCE[0]}` é relativo ao cwd de quem invocou. Resolvê-lo lá embaixo
# devolvia string vazia, e o `.` virava `/_common.sh`.
KIT_DIR_TESTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# git de verdade, resolvido ANTES de $WORK/bin entrar no PATH (senão o shim
# abaixo se acharia a si mesmo e recursaria pra sempre).
REAL_GIT="$(command -v git)"

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês de `docker` e `crontab` ───────────────────────────────────────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  # Healthcheck do update.sh: "docker compose ... exec -T app node -e ...".
  # O dublê responde o que o app RESPONDE DE VERDADE — capturado da instalação
  # em produção. Antes aqui vinha {"status":"ok"}, um formato que /api/v1/health
  # nunca emitiu: `ok` é o vocabulário dos CHECKS individuais, e o status geral
  # usa healthy|degraded|unhealthy. Um dublê que fala um dialeto inventado
  # aprova código que o app real reprovaria — foi exatamente por casar
  # '"status":"ok"' no JSON cru que o kit dava por saudável um app com o BANCO
  # FORA, desde que qualquer outro check estivesse de pé.
  # São duas linhas porque o probe imprime o status geral e depois o corpo.
  *" exec "*)
    # O app que NÃO volta (caso 15b): o status geral que a rota devolve com um
    # check DOWN. É o desfecho em que o agent.sh precisa da imagem anterior.
    [ -n "${DUBLE_APP_DOENTE:-}" ] && { printf 'unhealthy\n{"data":{"status":"unhealthy"}}\n'; exit 0; }
    printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":268},"redis":{"status":"ok","latency_ms":4},"waha":{"status":"ok","latency_ms":6}}}}\n' ;;
  # `docker images --format '{{.Repository}}:{{.Tag}}'`: o que há NO DISCO da
  # VPS, uma referência por linha. ANTES do ramo genérico de `images` logo
  # abaixo, que casaria com este comando também. Calado por padrão — é o disco
  # que os casos 1 a 14 sempre viram, e é por isso que o caso 15 só afirma "não
  # apagou X" ao lado de um "apagou Y" na MESMA rodada: com a lista vazia a
  # limpeza não faz nada, e toda prova de preservação passaria por vacuidade.
  *" images --format "*)
    [ -n "${DUBLE_IMAGES_QUEBRADO:-}" ] && exit 1
    for duble_ref in ${DUBLE_NO_DISCO:-}; do printf '%s\n' "$duble_ref"; done ;;
  # `docker rmi <referência>` SEM `-f`: o Docker recusa a referência única de uma
  # imagem que algum contêiner usa, de pé ou parado. A mensagem é a que o daemon
  # devolve de verdade; o que importa é o status != 0.
  *" rmi "*)
    for duble_ref in ${DUBLE_EM_USO:-}; do
      if [ "$duble_ref" = "$2" ]; then
        echo "Error response from daemon: conflict: unable to remove repository reference \"$2\" (must force) - container 0f3a9c1d5e7b is using its referenced image" >&2
        exit 1
      fi
    done ;;
  # Imagem em execução, que o agent.sh guarda para poder voltar. Precisa
  # devolver algo: com PREV_IMAGE vazio o rollback nem seria tentado, e o teste
  # do agente passaria mesmo com o defeito de volta.
  *" images "*) printf 'sha256:deadbeef\n' ;;
  # O par que `image_desatualizada` compara: digest LOCAL e digest REMOTO de uma
  # referência. Calado por padrão — é o que os casos 1 a 11 sempre viram, e sem
  # digest local o script conclui "nem baixada ainda → atualizar". Esse silêncio
  # é o motivo de o caso 12 precisar deste ramo: com ele, `image_desatualizada`
  # responde "desatualizada" SEMPRE, e uma prova de "não pode dizer 'nada a
  # atualizar'" ficaria verde por vacuidade, com ou sem a correção.
  #
  #   iguais     → local == remoto. NÃO é atalho do dublê: é o que o registro
  #                responde DE VERDADE para uma tag imutável já baixada — a
  #                imagem comparada com ela mesma, que é o defeito do caso 12.
  #   diferentes → o remoto andou (canal móvel, ou republicação sem commit).
  *" image inspect "*RepoDigests*)
    [ -n "${DUBLE_DIGESTS:-}" ] && printf '%s@sha256:%s\n' "${3%:*}" "$(printf '%s' "$3" | cksum | cut -d' ' -f1)" ;;
  *" buildx imagetools inspect "*)
    case "${DUBLE_DIGESTS:-}" in
      iguais)     printf 'Name: %s\nDigest: sha256:%s\n' "$4" "$(printf '%s' "$4" | cksum | cut -d' ' -f1)" ;;
      diferentes) printf 'Name: %s\nDigest: sha256:republicada\n' "$4" ;;
    esac ;;
  # `docker inspect <contêiner> --format '{{.Config.Image}}'`: a referência com
  # que o contêiner FOI CRIADO — o que de fato roda, que é a única pergunta que
  # nem o `.env` nem o digest respondem. Calado por padrão, e esse silêncio é
  # deliberado: é o estado "stack parada" que os casos 1 a 12 sempre viram, e é
  # o que faz o caso 14e ser uma prova e não uma formalidade.
  #
  # O formato é `<svc>=<referência>`, separado por espaço, porque os serviços
  # precisam divergir. O `svc` sai do nome do contêiner (`<projeto>-<svc>-1`)
  # para que o dublê responda por serviço sem precisar saber o nome do projeto,
  # que o teste não fixa.
  # `docker inspect <contêiner> --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`:
  # a versão que o contêiner do app RODA — o rótulo que o CI grava na imagem.
  # Calado por padrão, como o ramo de baixo. O contêiner muda no `up -d`: depois
  # dele quem responde é o novo, e é assim que o caso 15i prova que o update.sh
  # leu a versão ANTES de recriá-lo (lida depois, ela seria sempre o alvo).
  *"image.version"*)
    [ -n "${DUBLE_INSPECT_QUEBRADO:-}" ] && exit 1
    if grep -q '^UP env ' "$DOCKER_LOG" 2>/dev/null; then
      printf '%s\n' "${DUBLE_VERSAO_DEPOIS:-}"
    else
      printf '%s\n' "${DUBLE_VERSAO_NO_AR:-}"
    fi ;;
  # `docker inspect <asterisk> --format '{{.State.Running}} {{.Image}} <IP>/<bits>'`:
  # o que `religar_troncos_sip` pergunta DEPOIS do `up -d` (caso 16). Calado por
  # padrão — "o Asterisk não está no ar" —, e é esse silêncio que faz dos casos 1
  # a 15 um controle: com a telefonia ligada eles passam pelo aviso e seguem.
  *"State.Running"*)
    [ -n "${DUBLE_ASTERISK_NO_AR:-}" ] && printf 'true sha256:c806ecd5fd3d 172.19.0.6/16 \n' ;;
  # O `conntrack` da imagem do Asterisk, num contêiner efêmero na rede do host:
  # `docker run --rm --network host --cap-add NET_ADMIN --entrypoint conntrack <imagem> -L …`.
  # Devolve a tabela que o caso declarar. A regra inteira (limpar, ocupar,
  # reenviar) é provada em tests/shell/telefonia-porta-sip.test.sh, com um dublê
  # que tem estado; aqui só se prova o ENCAIXE no update.sh.
  *"--entrypoint conntrack"*)
    case " $* " in *" -L "*) printf '%s\n' "${DUBLE_CONNTRACK:-}" ;; esac ;;
  *"Config.Image"*)
    # Docker fora do ar / sem permissão no socket: o comando SAI != 0. É um
    # estado real numa VPS, e o update.sh roda sob `set -euo pipefail`.
    [ -n "${DUBLE_INSPECT_QUEBRADO:-}" ] && exit 1
    duble_n="${2%-1}"
    for duble_par in ${DUBLE_EM_EXECUCAO:-}; do
      case "$duble_par" in "${duble_n##*-}="*) printf '%s\n' "${duble_par#*=}" ;; esac
    done ;;
  # O `up -d` PLENO do update.sh (sem nomear serviço): é ele que cria o Asterisk
  # quando `telefonia` está em COMPOSE_PROFILES. O dublê anota o que o compose de
  # verdade LERIA naquele instante — o ambiente herdado, que VENCE o `.env`
  # (medido no docker compose v5.1.4), e o `.env` em disco. É assim que o caso 14
  # prova a ORDEM: imagem e senha gravadas antes de subir, e não depois.
  *" up -d ")
    {
      printf 'UP env ASTERISK_IMAGE=%s\n' "${ASTERISK_IMAGE:-}"
      printf 'UP env COMPOSE_PROFILES=%s\n' "${COMPOSE_PROFILES:-}"
      printf 'UP .env %s\n' "$(grep -E '^ASTERISK_IMAGE=' .env 2>/dev/null | tail -1)"
      printf 'UP .env senha=%s\n' "$(grep -cE '^TELEFONIA_ARI_PASSWORD=.+' .env 2>/dev/null)"
    } >> "$DOCKER_LOG" ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# flock não existe no macOS e o agent.sh depende dele; aqui a exclusão mútua
# não está sob prova, então o dublê só deixa passar.
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# O "app": responde ao heartbeat que ALGUÉM PEDIU uma atualização (é o que faz
# o agente sair do heartbeat e ir executar) e guarda cada corpo enviado, que é
# como a prova lê o desfecho reportado.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
payload=""
while [ $# -gt 0 ]; do
  [ "$1" = "-d" ] && { shift; payload="$1"; }
  shift
done
printf '%s\n' "$payload" >> "$CURL_LOG"
case "$payload" in
  *heartbeat*) printf '{"data":{"update_requested":true,"run_id":"11111111-1111-4111-8111-111111111111"}}\n200' ;;
  *)           printf '{"data":{}}\n200' ;;
esac
STUB
# `git` de verdade para tudo, EXCETO `fetch --unshallow` quando
# FORCE_UNSHALLOW_FAIL=1 estiver no ambiente — é o que isola o caso 8 (a
# comparação genuinamente NÃO SABE porque o unshallow falhou) de um fetch
# --tags comum, que continua funcionando contra a origin de verdade. Fora
# desse gate (a maioria das chamadas do arquivo inteiro, casos 1-7 incluídos)
# o dublê é 100% transparente.
#
# E, a partir do caso 17, EXCETO `fetch --tags` quando DUBLE_FETCH_TAGS_FALHA
# trouxer uma mensagem: o dublê a escreve no stderr e sai 128, que é como o git
# de verdade responde quando o GitHub recusa a chave ou a rede não existe. É o
# único jeito de exercitar "o servidor perdeu o acesso ao repositório" sem
# depender de rede nem de um repositório privado de verdade.
cat > "$WORK/bin/git" <<STUB
#!/usr/bin/env bash
if [ -n "\${DUBLE_FETCH_TAGS_FALHA:-}" ]; then
  case " \$* " in
    *" fetch "*"--tags "*)
      printf '%s\\n' "\$DUBLE_FETCH_TAGS_FALHA" >&2
      exit 128 ;;
  esac
fi
if [ "\${FORCE_UNSHALLOW_FAIL:-0}" = "1" ]; then
  for a in "\$@"; do
    if [ "\$a" = "--unshallow" ]; then
      echo "fatal: simulated unshallow failure" >&2
      exit 1
    fi
  done
fi
exec "$REAL_GIT" "\$@"
STUB
# `religar_troncos_sip` (caso 16) usa o `conntrack` do SERVIDOR quando quem roda é
# root e o programa existe. Rodada como root numa máquina que o tem, esta suíte
# leria — e poderia limpar — a tabela de conexões de verdade de quem está
# testando. Aqui ninguém é root, e o `conntrack` do PATH só deixa rastro.
cat > "$WORK/bin/id" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && { echo 1000; exit 0; }
exit 1
STUB
cat > "$WORK/bin/conntrack" <<'STUB'
#!/usr/bin/env bash
printf 'CONNTRACK-DO-SERVIDOR %s\n' "$*" >> "$DOCKER_LOG"
exit 1
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/git" "$WORK/bin/id" "$WORK/bin/conntrack"
export DOCKER_LOG="$WORK/docker.log" CURL_LOG="$WORK/curl.log"
export FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"

# ── Instalação de mentira: repo git + kit + .env ─────────────────────────────
PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$REPO_ROOT/hostgator-setup-kit/_common.sh" "$REPO_ROOT/hostgator-setup-kit/update.sh" \
   "$REPO_ROOT/hostgator-setup-kit/agent.sh" "$PROJ/hostgator-setup-kit/"
# backup.sh de mentira: deixa um rastro. É o marco "o script já começou a
# mexer" — a guarda de retrocesso só vale se abortar ANTES dele.
BACKUP_MARK="$WORK/backup-rodou"
cat > "$PROJ/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
touch "$BACKUP_MARK"
STUB
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$PROJ/docker-compose.prod.yml"
printf 'select 1;\n' > "$PROJ/supabase/baseline.sql"
cat > "$PROJ/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
chmod 600 "$PROJ/.env"

cd "$PROJ" || exit 1
git init --quiet
git config user.email t@t.t; git config user.name t
git add -A
git commit --quiet -m "v0.9.0"
git tag v0.9.0
# Instalação que SEGUE A MAIN: HEAD à frente da última tag publicada.
echo topo > topo.txt; git add -A; git commit --quiet -m "topo da main"

OUTFILE="$WORK/saida.txt"
run_update() {  # run_update <args...> → saída em $OUTFILE, status em $RC
  rm -f "$BACKUP_MARK"
  bash hostgator-setup-kit/update.sh "$@" > "$OUTFILE" 2>&1
  RC=$?
}

echo "── 1. Alvo anterior ao instalado é recusado antes do backup"
run_update --to v0.9.0
check "aborta com status != 0" test "$RC" -ne 0
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"

echo "── 2. Sem --to, a última tag publicada também é recusada se já está no HEAD"
# É o caso do defeito: o dono copia da tela o comando sem argumento nenhum.
run_update
check "aborta com status != 0" test "$RC" -ne 0
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "mesmo recusando, deixou o agente da tela instalado (com cd no diretório do projeto)" \
  grep -q "cd ${PROJ} && bash hostgator-setup-kit/agent.sh" "$FAKE_CRONTAB"

echo "── 3. --force é a saída explícita de quem quer mesmo voltar"
run_update --to v0.9.0 --force
check "passou da guarda e rodou o backup" test -f "$BACKUP_MARK"

echo "── 4. Atualização de verdade grava a imagem no .env, sem duplicar a chave"
# Estado de quem sofreu um rollback antes: o agente deixou a imagem apontando
# para um ID local e a política em "missing" (ID não se puxa do registro).
set_env_missing() { grep -v '^APP_PULL_POLICY=' .env > .env.t; echo 'APP_PULL_POLICY=missing' >> .env.t; mv .env.t .env; }
set_env_missing
git checkout --quiet main 2>/dev/null || git checkout --quiet master
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
git checkout --quiet v0.9.0
run_update --to v1.1.0
check "a atualização termina com sucesso" test "$RC" -eq 0
check ".env aponta para a imagem da versão instalada" grep -q "^APP_IMAGE=${NS}/deskcommcrm:1.1.0$" .env
check "a chave APP_IMAGE não duplicou" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
run_update --to v1.1.0 --force
check "segunda execução também não duplica" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
check "as outras chaves do .env sobreviveram" grep -q '^INTERNAL_SECRET=segredo$' .env
check "a política de pull vira 'missing' — a tag é imutável, e 'always' derrubaria o CRM se o GHCR caísse" \
  grep -q '^APP_PULL_POLICY=missing$' .env
check "e sem duplicar a chave" test "$(grep -c '^APP_PULL_POLICY=' .env)" -eq 1
check ".env continua 600 (só o dono lê)" test -n "$(find .env -perm 600)"

# Esta prova exigia 'always' até 2026-08-13, e o motivo escrito era real: um
# rollback deixava 'missing' no .env com um ID de imagem LOCAL, e ninguém
# desfazia — o `up -d` manual do dono parava de puxar imagem para sempre.
#
# O que mudou não foi a preocupação, foi a régua. Medido: com 'always' e o
# registro sem responder para aquela referência, o `up -d` FALHA e o contêiner
# NÃO SOBE, mesmo com a imagem já no disco. Como a instalação agora nasce e
# permanece pinada numa tag imutável, 'always' deixou de proteger de qualquer
# coisa e passou a amarrar a subida do CRM de um cliente pago à disponibilidade
# do GHCR. O medo original continua coberto por outro caminho: o update.sh faz
# `dc pull` EXPLÍCITO, que independe do pull_policy, e regrava a tag por cima do
# ID local do rollback — que é o que a prova logo acima verifica.
# Ver docs/doctrine/packaging.md, invariante 5.

echo "── 4b. As três imagens sobem juntas, na mesma versão"
# O worker e o scheduler eram `build:`-only no compose: `dc pull` os pulava e o
# `up -d` sem --build recriava o contêiner sobre a imagem velha. O worker — o
# runtime do agente de IA — ficava congelado no código do dia da instalação.
# Se estas três linhas voltarem a divergir, o defeito voltou.
check "o worker é pinado na MESMA versão do app" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:1.1.0$" .env
check "o scheduler é pinado na MESMA versão do app" \
  grep -q "^SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.1.0$" .env
check "o worker herda a política da tag imutável" \
  grep -q '^WORKER_PULL_POLICY=missing$' .env
check "o scheduler herda a política da tag imutável" \
  grep -q '^SCHEDULER_PULL_POLICY=missing$' .env
check "nenhuma das chaves novas duplicou" \
  test "$(grep -cE '^(WORKER|SCHEDULER)_(IMAGE|PULL_POLICY)=' .env)" -eq 4

# ── Clone RASO: a topologia que o install.sh realmente entrega ───────────────
# `install.sh` instala com `git clone --depth 1`. Num repositório raso o
# `merge-base --is-ancestor` responde "não é ancestral" para QUALQUER coisa
# fora do único commit baixado — inclusive para uma tag velha. Era o furo que
# mantinha o retrocesso vivo mesmo com a guarda: o fixture acima (git init
# completo) não tinha como pegar.
SRC="$WORK/src"
mkdir -p "$SRC"
cp -R "$PROJ/hostgator-setup-kit" "$SRC/"
mkdir -p "$SRC/supabase"; printf 'select 1;\n' > "$SRC/supabase/baseline.sql"
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$SRC/docker-compose.prod.yml"
printf '.env\n' > "$SRC/.gitignore"
cd "$SRC" || exit 1
git init --quiet; git config user.email t@t.t; git config user.name t
git add -A; git commit --quiet -m "release antiga"; git tag v0.9.0
echo topo > topo.txt; git add -A; git commit --quiet -m "main, depois da release"

clona_raso() {  # clona_raso <destino> — igual ao install.sh: --depth 1
  git clone --depth 1 --quiet "file://$SRC" "$1"
  cat > "$1/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
  chmod 600 "$1/.env"
}

echo "── 5. Clone raso (o do install.sh): a tag velha continua sendo recusada"
RASO="$WORK/raso"
clona_raso "$RASO"
cd "$RASO" || exit 1
check "o fixture é mesmo um clone raso (senão esta prova não vale nada)" \
  test "$(git rev-parse --is-shallow-repository)" = "true"
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3), não com falha genérica" test "$RC" -eq 3
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"
check "a imagem do .env continua intacta" grep -q "^APP_IMAGE=${NS}/deskcommcrm:latest$" .env
check "completou a história para poder decidir (deixou de ser raso)" \
  test "$(git rev-parse --is-shallow-repository)" = "false"

echo "── 6. Clone raso que NÃO consegue completar a história: recusa em vez de chutar"
CEGO="$WORK/cego"
clona_raso "$CEGO"
cd "$CEGO" || exit 1
git fetch --tags --quiet origin            # conhece a tag…
git remote set-url origin "$WORK/nao-existe"  # …mas perdeu o caminho de volta
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3)" test "$RC" -eq 3
check "diz que não teve CERTEZA, em vez de agir" grep -q "consegui ter CERTEZA" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"

echo "── 7. Recusa não é falha no meio: o agente não desfaz o que nunca foi feito"
# O update.sh recusa (RC=3) e o agent.sh, antes, tratava qualquer RC!=0 como
# "quebrou": reiniciava o container, reescrevia o .env e reportava
# "failed_rolled_back" — estrago inventado, para um run que não tocou em nada.
AGENTE="$WORK/agente"
clona_raso "$AGENTE"
cd "$AGENTE" || exit 1
: > "$DOCKER_LOG"; : > "$CURL_LOG"; rm -f "$BACKUP_MARK"
bash hostgator-setup-kit/agent.sh > "$WORK/agente.out" 2>&1
check "o agente chegou a executar o update (o app de mentira pediu)" \
  grep -q '"kind":"run_progress"\|"kind":"run_result"' "$CURL_LOG"
check "NÃO reiniciou o container" test -z "$(grep -F 'up -d app' "$DOCKER_LOG" || true)"
check "NÃO reescreveu a imagem do .env" grep -q "^APP_IMAGE=${NS}/deskcommcrm:latest$" .env
check "reportou 'failed', não 'failed_rolled_back'" \
  test -n "$(grep -F '"status":"failed"' "$CURL_LOG" || true)"
check "não reportou rollback nenhum" test -z "$(grep -F 'failed_rolled_back' "$CURL_LOG" || true)"
check "o motivo em português chegou no log que a tela mostra" \
  grep -qi 'anterior' "$CURL_LOG"

echo "── 8. CONTIDA=2 (unshallow falhou) SOZINHO já acende compare_failed, mesmo com fetch --tags OK"
# Isola a linha `[ "$CONTIDA" = 2 ] && COMPARE_FAILED=true`. O modo de falha
# mais provável numa VPS fraca é exatamente este: um `fetch --tags` é barato e
# passa (FETCH_OK=1), mas o `--unshallow` (que baixa a história inteira) é caro
# e falha — origin continua alcançável o tempo todo, ao contrário do caso 9.
echo mid > "$SRC/mid.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "depois da 0.9.0"
echo nova > "$SRC/nova.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "release nova"
git -C "$SRC" tag v1.1.0
CONTIDA2="$WORK/contida2"
git -c advice.detachedHead=false clone --depth 1 --branch v0.9.0 --quiet "file://$SRC" "$CONTIDA2"
cp "$RASO/.env" "$CONTIDA2/.env"; chmod 600 "$CONTIDA2/.env"
cd "$CONTIDA2" || exit 1
check "fixture: ainda é raso, e a origin CONTINUA alcançável (nada quebrado)" \
  test "$(git rev-parse --is-shallow-repository)" = "true"
: > "$CURL_LOG"
FORCE_UNSHALLOW_FAIL=1 bash hostgator-setup-kit/agent.sh > "$WORK/agente-contida2.out" 2>&1
check "o heartbeat diz explicitamente que não conseguiu comparar (CONTIDA=2 isolado)" \
  grep -q '"compare_failed":true' "$CURL_LOG"
check "e não anuncia a tag que não conseguiu confirmar" \
  grep -q '"latest_version":""' "$CURL_LOG"

echo "── 9. Sem NENHUMA tag conhecida + fetch --tags falhou: fallback isolado"
# Isola a linha `[ -z "$LATEST_TAG" ] && [ "$FETCH_OK" = 0 ]`. Diferente do
# caso 8: aqui a origin fica INALCANÇÁVEL desde o primeiro fetch (FETCH_OK=0),
# e o CONTIDA nunca chega a ser calculado porque não há tag nenhuma conhecida
# localmente (`--no-tags` no clone) — só este fallback pode acender
# compare_failed neste cenário.
SEM_TAG="$WORK/sem-tag"
git clone --depth 1 --no-tags --quiet "file://$SRC" "$SEM_TAG"
cp "$RASO/.env" "$SEM_TAG/.env"; chmod 600 "$SEM_TAG/.env"
cd "$SEM_TAG" || exit 1
check "fixture: nenhuma tag v* conhecida localmente" test -z "$(git tag -l 'v*')"
git remote set-url origin "$WORK/nao-existe"   # fetch --tags vai falhar (FETCH_OK=0)
: > "$CURL_LOG"
bash hostgator-setup-kit/agent.sh > "$WORK/agente-sem-tag.out" 2>&1
check "sem tag nenhuma conhecida e sem conseguir buscar, o heartbeat diz que não sabe (fallback isolado)" \
  grep -q '"compare_failed":true' "$CURL_LOG"
check "e não anuncia versão nenhuma" \
  grep -q '"latest_version":""' "$CURL_LOG"

echo

echo "── 10. Pin pela metade: o estado que a 1ª atualização deixa, e ninguém via"
# Medido em ensaio e depois na produção: quem executa a primeira atualização de
# uma instalação legada é o `update.sh` que já estava no disco — o antigo —, e
# ele só grava APP_IMAGE. O worker cai no default do compose (`:stable`, canal
# MÓVEL) e o script termina com "Atualização concluída — app no ar e saudável".
# Nada na tela dizia que o worker ficou solto; na release seguinte o canal se
# move e um `up -d` levaria o worker sozinho, com o app na versão antiga.
# A função vive no _common.sh do kit e precisa ser carregada AQUI. Sem isto os
# casos cujo esperado é vazio passavam por VACUIDADE — "comando não encontrado"
# devolve string vazia, que casa com o esperado. Três de cinco verdes eram
# falsos até esta linha existir.
# shellcheck source=/dev/null
. "$KIT_DIR_TESTE/_common.sh"
command -v pin_incompleto >/dev/null || { echo "  ✗ pin_incompleto não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }

pin_caso() {  # pin_caso <descrição> <conteúdo do .env> <esperado>
  local d="$1" env="$2" esperado="$3" r
  printf '%s\n' "$env" > "$PROJ/.env.pin"
  r="$(cd "$PROJ" && pin_incompleto .env.pin || true)"
  check "$d" test "$r" = "$esperado"
}
pin_caso "app pinado + worker/scheduler AUSENTES → acusa os dois" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0" "worker scheduler"
pin_caso "app pinado + worker em canal móvel → acusa" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:stable
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0" "worker"
pin_caso "as três na mesma versão → silêncio" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0" ""
pin_caso "app num canal deliberado (:latest) → não é 'metade', silêncio" \
  "APP_IMAGE=${NS}/deskcommcrm:latest" ""
# As aspas SIMPLES são o objeto deste caso — o `install.sh` grava assim. Elas
# ficam literais porque estão DENTRO da string de aspas duplas; trocá-las por
# duplas FECHA a string, e o conteúdo sai sem aspa nenhuma. Medido: nessa forma
# o caso vira byte-a-byte igual ao "as três na mesma versão" logo acima, e o
# rótulo passa a mentir sobre o que está sendo exercitado.
pin_caso "valores entre aspas, como o install grava → silêncio" \
  "APP_IMAGE='${NS}/deskcommcrm:1.3.0'
WORKER_IMAGE='${NS}/deskcomm-worker:1.3.0'
SCHEDULER_IMAGE='${NS}/deskcomm-scheduler:1.3.0'" ""
rm -f "$PROJ/.env.pin"



echo "── 11. Autocorreção do pin: preenche lacuna, nunca sobrescreve decisão"
# O `agent.sh` (cron de 5 min) completa o pin AUSENTE com a versão que a imagem
# em execução declara. A regra que torna isso seguro: chave ausente é omissão do
# `update.sh` antigo; chave presente é decisão de quem opera — inclusive a de
# seguir um canal móvel. Um cron que corrigisse escolha alheia seria pior que o
# defeito que ele conserta.
#
# Aqui o docker é dublado: o que se testa é a REGRA, não o daemon. O caminho com
# imagem real foi exercitado na VPS, com cron de verdade.
PIN_DIR="$WORK/autopin"; mkdir -p "$PIN_DIR/bin"
cat > "$PIN_DIR/bin/docker" <<'STUBDOCKER'
#!/usr/bin/env bash
# inspect de contêiner → devolve o nome da imagem; de imagem → devolve a versão
case "$*" in
  # O heredoc é quoted ('STUBDOCKER') para proteger $* e $DUBLE_VERSION, então
  # $NS NÃO é expandido na escrita: ele chega literal aqui e é resolvido quando o
  # dublê RODA, lendo do ambiente (por isso o `export NS` lá em cima). Sem essa
  # resolução o dublê devolvia a string `${NS}/deskcomm-worker:stable` — uma
  # fixture que não representa instalação nenhuma. O `:?` faz o dublê morrer alto
  # se a variável não vier, em vez de devolver um nome começando em "/".
  *"Config.Image"*)  printf '%s/deskcomm-worker:stable\n' "${NS:?dublê de docker sem NS no ambiente}" ;;
  *"image.version"*) printf '%s
' "${DUBLE_VERSION:-1.3.0}" ;;
  *) exit 1 ;;
esac
STUBDOCKER
chmod +x "$PIN_DIR/bin/docker"

autopin() {  # autopin <conteúdo do .env> → ecoa o que a função corrigiu
  printf '%s
' "$1" > "$PIN_DIR/.env"
  ( cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" bash -c \
      ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null ) || true
}

R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0")"
check "chave AUSENTE → preenche os dois" test "$R" = "worker scheduler"
check "  e grava a versão da imagem em execução, não um canal" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0$" "$PIN_DIR/.env"
check "  com pull_policy de tag imutável" \
  grep -q "^WORKER_PULL_POLICY=missing$" "$PIN_DIR/.env"

# Rodar de novo sobre o resultado: nada a fazer, e o arquivo não muda.
ANTES_MD5="$(md5sum "$PIN_DIR/.env" | cut -d' ' -f1)"
R="$( ( cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" bash -c ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null ) || true )"
check "idempotente: 2ª passada não corrige nada" test -z "$R"
check "  e não altera um byte do .env" test "$ANTES_MD5" = "$(md5sum "$PIN_DIR/.env" | cut -d' ' -f1)"

# A REGRA QUE PROTEGE O OPERADOR. Se esta cair, o cron passa a sobrescrever
# escolha explícita — e a decisão de implementar a autocorreção deixa de valer.
R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:stable
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:stable")"
check "canal móvel EXPLÍCITO → não toca (é decisão de quem opera)" test -z "$R"
check "  o :stable escolhido continua lá, intacto" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:stable$" "$PIN_DIR/.env"

R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0")"
check "já pinada → silêncio" test -z "$R"

# Imagem sem o label (build local): não há versão para gravar, e inventar uma
# seria pior que não fazer nada.
R="$( printf "APP_IMAGE=${NS}/deskcommcrm:1.3.0\n" > "$PIN_DIR/.env"
      cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" DUBLE_VERSION="<no value>" bash -c \
        ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null || true )"
check "imagem sem label de versão → não inventa pin" test -z "$R"

echo "── 12. Código já na tag nova + .env fixado na versão anterior: NÃO é 'nada a atualizar'"
# Medido em produção em 2026-09-19, no deploy da v1.32.0: com o repositório já em
# `git checkout v1.32.0` e o `.env` fixado em `:1.31.1` (pull_policy=missing), o
# `update.sh` respondeu "Você já está na versão mais recente. Nada a atualizar." e
# saiu com 0 — com os três contêineres na 1.31.1.
#
# A causa: `image_desatualizada` comparava o digest LOCAL de `$APP_IMAGE` com o
# digest REMOTO da MESMA referência. Isso só enxerga defasagem em tag MÓVEL. Desde
# que a instalação nasce fixada em número de versão, a comparação é a imagem
# antiga contra ela mesma — sempre "em dia". O caso que a função existe para
# cobrir (repositório novo, imagem velha) tinha deixado de ser coberto.
#
#
# `set +e` de propósito. O caso 10 faz `source` do `_common.sh` DENTRO deste
# shell, e ele abre com `set -euo pipefail` — a partir dali o `-e` vale aqui
# também. Os casos 10 e 11 não executam o `update.sh`; este executa. Com o `-e`
# ligado, um `update.sh` que saísse != 0 encerraria este arquivo na linha do
# `run_update`, ANTES do veredito: sem "FALHOU", sem contagem, só um exit code.
set +e

# Fixture própria, com o `.env` FORA do git: o `$PROJ` lá de cima versiona o
# `.env`, e cada `git checkout` dele troca o arquivo por baixo do caso.
PINADA="$WORK/pinada"
mkdir -p "$PINADA/supabase"
cp -R "$PROJ/hostgator-setup-kit" "$PINADA/"
printf 'select 1;\n' > "$PINADA/supabase/baseline.sql"
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$PINADA/docker-compose.prod.yml"
printf '.env\n' > "$PINADA/.gitignore"
cd "$PINADA" || exit 1
git init --quiet; git config user.email t@t.t; git config user.name t
git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.2.0"; git tag v1.2.0
# A origem EXISTE e responde: é o estado normal de uma VPS, que alcança o GitHub.
# Sem ela, todo `git fetch --tags origin` deste bloco falhava ("'origin' does not
# appear to be a git repository") e os controles de "Nada a atualizar" mediam,
# sem saber, o caminho em que o servidor NÃO conseguiu consultar — que desde o
# caso 17 tem resposta própria, em amarelo.
git clone --quiet --bare "$PINADA" "$WORK/pinada-origem.git"
git remote add origin "$WORK/pinada-origem.git"
# O que o operador fez à mão ANTES de rodar o update.sh.
git -c advice.detachedHead=false checkout --quiet v1.2.0

env_das_tres() {  # env_das_tres <app> <worker> <scheduler> — referências INTEIRAS; vazio = chave ausente
  {
    [ -n "$1" ] && printf 'APP_IMAGE=%s\nAPP_PULL_POLICY=missing\n' "$1"
    [ -n "$2" ] && printf 'WORKER_IMAGE=%s\nWORKER_PULL_POLICY=missing\n' "$2"
    [ -n "$3" ] && printf 'SCHEDULER_IMAGE=%s\nSCHEDULER_PULL_POLICY=missing\n' "$3"
    printf 'SUPABASE_DB_URL=postgresql://x/y\nNEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br\n'
    printf 'INTERNAL_SECRET=segredo\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave\n'
  } > .env
  chmod 600 .env
}
tres_em() {  # tres_em <versão> → as três chaves do .env estão nessa versão, no namespace NOSSO
  grep -q "^APP_IMAGE=${NS}/deskcommcrm:$1$" .env \
    && grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:$1$" .env \
    && grep -q "^SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:$1$" .env
}
nada_a_atualizar() { grep -q "Nada a atualizar" "$OUTFILE"; }
nao_disse_nada_a_atualizar() { ! nada_a_atualizar; }

# Em TODO este bloco o registro responde: digest local == digest remoto. É o que
# ele responde de verdade para uma tag imutável já baixada.
export DUBLE_DIGESTS=iguais

echo "   12a. o caso da produção: as três na versão anterior"
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
check "fixture: o código JÁ está na tag nova" test "$(git describe --tags --exact-match HEAD)" = "v1.2.0"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "foi adiante: rodou o backup" test -f "$BACKUP_MARK"
check "termina com sucesso" test "$RC" -eq 0
check "as três imagens do .env foram para a versão do código" tres_em 1.2.0
check "diz QUAL imagem estava para trás, em vez de um 'imagem antiga' genérico" \
  grep -q "app worker scheduler" "$OUTFILE"
# Controle do 14a: sem `telefonia` em COMPOSE_PROFILES, a senha gerada vem com
# o aviso de que a telefonia segue desligada — que aqui é verdade.
check "sem o profile, a senha da telefonia sai com o aviso 'segue DESLIGADA'" \
  grep -q "senha da telefonia no .env — ela segue DESLIGADA" "$OUTFILE"

echo "   12b. CONTROLE: com as três na versão certa, o MESMO dublê diz 'nada a atualizar'"
# Sem este controle o 12a não prova nada: bastaria o dublê de digest estar mudo
# (ou quebrado) para `image_desatualizada` responder "desatualizada" sempre, e o
# 12a passar com o defeito de volta. Aqui o `.env` é o que o 12a acabou de gravar.
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "sai com 0" test "$RC" -eq 0
check "e não rodou backup nenhum" test ! -f "$BACKUP_MARK"

echo "   12c. só UMA das três para trás já basta (o app na versão certa não absolve o worker)"
env_das_tres "${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.2.0"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "foi adiante: rodou o backup" test -f "$BACKUP_MARK"
check "o worker alcançou as outras duas" tres_em 1.2.0
check "nomeia só quem estava para trás" grep -q "outra imagem: worker\." "$OUTFILE"

echo "   12d. mesmo NÚMERO de versão em OUTRO namespace não é a nossa imagem"
# O caso de docs/runbooks/repositorio-proprio.md §5: a VPS que veio do repositório
# de origem tem `ghcr.io/<origem>/deskcommcrm:1.29.0`, e a `v1.29.0` daqui é outro
# produto. Comparar só o número responderia "em dia" com o produto alheio no ar.
env_das_tres "ghcr.io/outro-dono/deskcommcrm:1.2.0" "ghcr.io/outro-dono/deskcomm-worker:1.2.0" "ghcr.io/outro-dono/deskcomm-scheduler:1.2.0"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "regrava as três no namespace deste repositório" tres_em 1.2.0

echo "   12e. quem segue um CANAL de propósito não é fixado à força"
# `latest` é o topo da `main`, não a última release: fixar essa instalação na
# versão da tag poderia ser um DOWNGRADE que ninguém pediu. Para canal móvel a
# versão não decide nada — quem decide é o digest, como sempre foi.
env_das_tres "${NS}/deskcommcrm:latest" "${NS}/deskcomm-worker:latest" "${NS}/deskcomm-scheduler:latest"
run_update
check "com o digest em dia, responde 'Nada a atualizar'" nada_a_atualizar
check "e o canal escolhido continua no .env, intacto" grep -q "^APP_IMAGE=${NS}/deskcommcrm:latest$" .env

echo "   12f. o segundo critério sobrevive: canal móvel cujo digest andou ainda atualiza"
export DUBLE_DIGESTS=diferentes
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "foi adiante: rodou o backup" test -f "$BACKUP_MARK"
unset DUBLE_DIGESTS

echo "   12g. a regra, isolada do resto do script"
# shellcheck source=/dev/null
command -v imagens_fora_do_alvo >/dev/null || { echo "  ✗ imagens_fora_do_alvo não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
fora_caso() {  # fora_caso <descrição> <alvo> <esperado> <app> <worker> <scheduler>
  local r
  env_das_tres "$4" "$5" "$6"
  r="$(imagens_fora_do_alvo .env "$2" || true)"
  check "$1" test "$r" = "$3"
}
fora_caso "as três no alvo → silêncio" 1.2.0 "" \
  "${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"
fora_caso "as três na versão anterior → acusa as três" 1.2.0 "app worker scheduler" \
  "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
fora_caso "1.2.0 não é prefixo de 1.2.01: compara a referência, não um pedaço dela" 1.2.0 "app" \
  "${NS}/deskcommcrm:1.2.01" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"
# O que o rollback do agent.sh deixa: `docker compose images -q` devolve o ID da
# imagem LOCAL, sem repositório e sem tag. Não é canal e não é o alvo — é o app
# rodando a versão anterior com o código na nova, e antes a resposta era "em dia".
fora_caso "ID local deixado por um rollback → acusa (não é canal, nem é o alvo)" 1.2.0 "app" \
  "0f3a9c1d5e7b" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"
fora_caso "chave AUSENTE → a versão não decide (vale o default do compose, que é canal)" 1.2.0 "" \
  "${NS}/deskcommcrm:1.2.0" "" ""
fora_caso "canal móvel explícito (:stable) → a versão não decide" 1.2.0 "" \
  "${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:stable" "${NS}/deskcomm-scheduler:stable"
fora_caso "repositório SEM tag é :latest implícito → canal, a versão não decide" 1.2.0 "" \
  "${NS}/deskcommcrm" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"

echo "── 14. Ligar a telefonia numa instalação JÁ na última versão: o update.sh sobe o Asterisk"
# O caminho que a aba Telefone, o `.env` e o `install.sh` ensinam: acrescentar
# `telefonia` a COMPOSE_PROFILES, preencher TELEFONIA_ARI_URL e rodar o
# update.sh. Numa instalação que já está na última versão, o script saía cedo
# com "Nada a atualizar" — os dois critérios de `image_desatualizada` só
# olhavam app, worker e scheduler — e o Asterisk nunca subia.
#
# DOIS estados de partida, e cada um tem o seu critério:
#   - `.env` SEM `ASTERISK_IMAGE`: quem chegou à versão com telefonia pelo
#     `update.sh` da versão ANTERIOR (ele carrega o `_common.sh` antes do
#     checkout e roda o `gravar_imagens` velho). Com o profile ligado, o compose
#     cairia em `:stable` + `always` — canal móvel, contra a doutrina — e sem
#     TELEFONIA_ARI_PASSWORD o entrypoint do Asterisk sai. É o critério do .env.
#   - `.env` COMPLETO, contêiner AUSENTE: toda instalação nova (o `install.sh`
#     já grava as duas chaves) e toda que passou por um update.sh novo. O `.env`
#     está no alvo e o digest também; só o contêiner sabe que o Asterisk não
#     existe. É o critério do contêiner — e é o caso MAIS comum.
em_execucao() {  # em_execucao <app> <worker> <scheduler> [asterisk] — referências INTEIRAS; vazio = contêiner ausente
  local l=""
  [ -n "$1" ] && l="$l app=$1"
  [ -n "$2" ] && l="$l worker=$2"
  [ -n "$3" ] && l="$l scheduler=$3"
  [ -n "${4:-}" ] && l="$l asterisk=$4"
  export DUBLE_EM_EXECUCAO="${l# }"
}
env_da_telefonia() {  # env_da_telefonia <COMPOSE_PROFILES> <ASTERISK_IMAGE, vazio = ausente> <senha? 1|vazio>
  env_das_tres "${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"
  printf 'COMPOSE_PROFILES=%s\nTELEFONIA_ARI_URL=http://asterisk:8088\n' "$1" >> .env
  [ -n "$2" ] && printf 'ASTERISK_IMAGE=%s\nASTERISK_PULL_POLICY=missing\n' "$2" >> .env
  [ -n "$3" ] && printf 'TELEFONIA_ARI_PASSWORD=senha-de-teste\n' >> .env
  return 0
}
AST_ALVO="${NS}/deskcomm-asterisk:1.2.0"
TRES_NO_ALVO=("${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0")
falou_da_telefonia() { grep -q "telefonia está ligada" "$OUTFILE"; }
nao_acusou_as_tres() { ! grep -q "outra imagem" "$OUTFILE"; }
subiu_com() { grep -qxF "UP $1" "$DOCKER_LOG"; }   # subiu_com <linha que o dublê anotou no `up -d`>
# Em TODO este bloco o registro responde digest local == remoto, e app, worker e
# scheduler estão no alvo, no `.env` e no ar. É o que cala os critérios antigos:
# se o update rodar, foi por causa da telefonia.
export DUBLE_DIGESTS=iguais

echo "   14a. profile ligado + .env SEM ASTERISK_IMAGE (e sem senha) → roda, e grava as duas antes de subir"
# O contêiner do Asterisk existe em `:stable` — o que o default do compose cria
# se alguém tentou um `up -d` à mão. Canal não é julgado pela versão, então o
# critério do contêiner fica CALADO aqui: quem tem de acusar é o do .env.
env_da_telefonia "telefonia" "" ""
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:stable"
: > "$DOCKER_LOG"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "foi adiante: rodou o backup" test -f "$BACKUP_MARK"
check "termina com sucesso" test "$RC" -eq 0
check "diz que é a TELEFONIA, não um 'imagem antiga' genérico" falou_da_telefonia
check "e não acusa as três que estão em dia" nao_acusou_as_tres
check "o .env passa a fixar o Asterisk na versão do código" grep -q "^ASTERISK_IMAGE=${AST_ALVO}$" .env
check "  com pull_policy de tag imutável" grep -q '^ASTERISK_PULL_POLICY=missing$' .env
check "a senha da ARI foi gerada" grep -qE '^TELEFONIA_ARI_PASSWORD=.+' .env
check "  e a tela NÃO diz que a telefonia 'segue DESLIGADA' (ela acabou de ser ligada)" \
  test -z "$(grep 'segue DESLIGADA' "$OUTFILE" | grep -i telefonia || true)"
check "ANTES do up -d o .env já fixava o Asterisk no alvo" subiu_com ".env ASTERISK_IMAGE=${AST_ALVO}"
check "ANTES do up -d a senha já estava no .env" subiu_com ".env senha=1"
check "o up -d subiu com o profile ligado no ambiente" subiu_com "env COMPOSE_PROFILES=telefonia"

echo "   14b. CONTROLE: profile ligado, .env e contêiner do Asterisk no alvo → 'Nada a atualizar'"
# Sem este controle o 14a e o 14d não provam nada: o dublê responde VAZIO a
# `docker inspect` por padrão, e um critério que tratasse o vazio como
# "Asterisk ausente" ficaria verde nos dois COM o defeito de volta — e acusaria
# para sempre toda instalação com a telefonia ligada e em dia.
env_da_telefonia "telefonia" "$AST_ALVO" 1
em_execucao "${TRES_NO_ALVO[@]}" "$AST_ALVO"
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "sai com 0" test "$RC" -eq 0
check "e não rodou backup nenhum" test ! -f "$BACKUP_MARK"

echo "   14c. profile DESLIGADO + .env sem ASTERISK_IMAGE → 'Nada a atualizar' (nada muda para quem não usa)"
env_da_telefonia "" "" ""
em_execucao "${TRES_NO_ALVO[@]}"
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "não rodou backup" test ! -f "$BACKUP_MARK"
check "e não escreveu ASTERISK_IMAGE no .env" test -z "$(grep '^ASTERISK_IMAGE=' .env || true)"
# Outro profile ligado não é a telefonia.
env_da_telefonia "voz" "" ""
run_update
check "com COMPOSE_PROFILES=voz também: 'Nada a atualizar'" nada_a_atualizar

echo "   14d. profile ligado + .env completo + contêiner do Asterisk AUSENTE → roda (o caso mais comum)"
env_da_telefonia "telefonia" "$AST_ALVO" 1
em_execucao "${TRES_NO_ALVO[@]}"
: > "$DOCKER_LOG"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "foi adiante: rodou o backup" test -f "$BACKUP_MARK"
check "termina com sucesso" test "$RC" -eq 0
check "diz que é a TELEFONIA" falou_da_telefonia
check "o up -d subiu com o profile ligado no ambiente" subiu_com "env COMPOSE_PROFILES=telefonia"
check "  e com o Asterisk do alvo" subiu_com "env ASTERISK_IMAGE=${AST_ALVO}"

echo "   14e. profile ligado com a stack PARADA (nenhum contêiner) → 'Nada a atualizar'"
# Quem parou a stack de propósito não recebe um update que ninguém pediu: sem o
# app no ar, a ausência do Asterisk não diz nada.
env_da_telefonia "telefonia" "$AST_ALVO" 1
em_execucao "" "" ""
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "não rodou backup" test ! -f "$BACKUP_MARK"

echo "   14f. profile ligado + .env no alvo + Asterisk RODANDO a versão anterior → roda"
env_da_telefonia "telefonia" "$AST_ALVO" 1
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "diz que é a TELEFONIA" falou_da_telefonia

echo "   14g. o up -d recebe o Asterisk NOVO, não o que o load_env exportou do .env antigo"
# O `enter_project` exporta cada chave do `.env` para o ambiente, e o ambiente
# VENCE o `.env` no docker compose (medido). `gravar_imagens` regrava o arquivo,
# mas o processo segue com o valor lido no começo: sem o `export` explícito, o
# Asterisk de quem tinha `:1.1.0` subia de novo na 1.1.0, e as outras três na
# nova. É a mesma razão das três linhas `export` que já existiam.
env_da_telefonia "telefonia" "${NS}/deskcomm-asterisk:1.1.0" 1
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
: > "$DOCKER_LOG"
run_update
check "NÃO responde 'Nada a atualizar'" nao_disse_nada_a_atualizar
check "o .env foi para o alvo" grep -q "^ASTERISK_IMAGE=${AST_ALVO}$" .env
check "e o AMBIENTE do up -d também (senão o compose sobe a 1.1.0)" subiu_com "env ASTERISK_IMAGE=${AST_ALVO}"

echo "   14h. a guarda de erro do critério do contêiner, medida na FUNÇÃO"
# Chamada DIRETA, num subshell com o `set -euo pipefail` do kit, FORA de `if` e
# de `$( )` — nas duas formas o errexit não vale e a prova passaria com a guarda
# arrancada (medido no caso 13 do PR #34, e registrado na memória do projeto).
command -v conteiner_da_telefonia_fora_do_alvo >/dev/null \
  || { echo "  ✗ conteiner_da_telefonia_fora_do_alvo não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
env_da_telefonia "telefonia" "$AST_ALVO" 1
( set -euo pipefail
  export DUBLE_INSPECT_QUEBRADO=1
  conteiner_da_telefonia_fora_do_alvo .env 1.2.0 >/dev/null ) >/dev/null 2>&1
GUARDA_RC=$?
check "docker que sai != 0 não mata a função" test "$GUARDA_RC" -eq 0
ACUSOU="$(DUBLE_INSPECT_QUEBRADO=1 conteiner_da_telefonia_fora_do_alvo .env 1.2.0)"
check "e, sem poder enxergar, ela não acusa nada" test -z "$ACUSOU"
# O silêncio acima só vale se a MESMA chamada, com o docker respondendo, acusa —
# senão a função podia estar calada por qualquer outro motivo.
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
ACUSOU="$(conteiner_da_telefonia_fora_do_alvo .env 1.2.0)"
check "controle: com o docker respondendo, a mesma chamada acusa o Asterisk" test "$ACUSOU" = "asterisk"

echo "   14i. 'telefonia está ligada?' com a régua do docker compose"
# Cada linha abaixo foi medida contra o docker compose v5.1.4 (`docker compose
# config --services` com o profile no .env): o que ele liga, esta função liga.
# Sem a função carregada, todo caso "→ desligada" passaria por vacuidade.
command -v telefonia_ligada >/dev/null \
  || { echo "  ✗ telefonia_ligada não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
ligada_caso() {  # ligada_caso <descrição> <conteúdo do .env> <sim|nao>
  local r
  printf '%b' "$2" > .env.perfis
  if telefonia_ligada .env.perfis; then r=sim; else r=nao; fi
  check "$1" test "$r" = "$3"
}
ligada_caso "COMPOSE_PROFILES=telefonia → ligada" 'COMPOSE_PROFILES=telefonia\n' sim
ligada_caso "entre aspas simples, como o install.sh grava → ligada" "COMPOSE_PROFILES='telefonia'\n" sim
ligada_caso "lista entre aspas duplas → ligada" 'COMPOSE_PROFILES="voz,telefonia"\n' sim
ligada_caso "espaço depois da vírgula → ligada" 'COMPOSE_PROFILES=voz, telefonia\n' sim
ligada_caso "linha ACRESCENTADA no fim, depois da vazia do install → ligada (a última vence)" \
  "COMPOSE_PROFILES=''\nX=1\nCOMPOSE_PROFILES=telefonia\n" sim
ligada_caso "o contrário: a última está vazia → desligada" 'COMPOSE_PROFILES=telefonia\nCOMPOSE_PROFILES=\n' nao
ligada_caso "comentário no fim da linha → ligada" 'COMPOSE_PROFILES=telefonia # liguei\n' sim
ligada_caso "prefixo export → ligada" 'export COMPOSE_PROFILES=telefonia\n' sim
ligada_caso "fim de linha do Windows (CRLF) → ligada" 'COMPOSE_PROFILES=telefonia\r\n' sim
ligada_caso "telefonia2 não é telefonia → desligada" 'COMPOSE_PROFILES=telefonia2\n' nao
ligada_caso "linha comentada → desligada" '# COMPOSE_PROFILES=telefonia\n' nao
ligada_caso "vazia → desligada" "COMPOSE_PROFILES=''\n" nao
ligada_caso "chave ausente → desligada" 'X=1\n' nao
rm -f .env.perfis

unset DUBLE_EM_EXECUCAO

echo "── 15. Atualização que deu certo apaga as imagens das versões antigas"
# Medido na VPS de produção: cada release deixa ~3,2 GB no disco (app, worker,
# scheduler, Asterisk) e nenhum script as apagava. Em 2026-09-24 havia 21 versões
# e o disco estava em 73%; limpo à mão. Em 2026-10-05, onze dias depois, eram 26
# versões e 88% — e a VPS se atualiza sozinha pelo cron do agent.sh, então isso
# enche sem ninguém entrar por SSH.
#
# A regra: fica a versão instalada agora e mais UMA de reserva — a que rodava
# antes desta atualização; sem dar para saber, a maior das outras. Só referência
# NOSSA (os quatro repositórios de `IMG_*`) com tag de versão numerada;
# `docker rmi` SEM `-f`, uma referência por vez; nunca `prune`.
no_disco() { export DUBLE_NO_DISCO="$*"; }
das_quatro() {  # das_quatro <versão> → as quatro referências nossas nessa versão, separadas por espaço
  printf '%s ' "${NS}/deskcommcrm:$1" "${NS}/deskcomm-worker:$1" "${NS}/deskcomm-scheduler:$1" "${NS}/deskcomm-asterisk:$1"
}
# O que mais mora no disco de uma VPS real e NÃO é da limpeza: imagens de
# terceiros, o psql do kit, o mesmo nome de repositório em OUTRO namespace, os
# canais móveis, um prerelease, uma imagem sem tag e um repositório cujo nome só
# COMEÇA como o nosso.
ALHEIAS="ghcr.io/openclaw/openclaw:2026.2.12 postgres:17-alpine devlikeapro/waha:latest-2026.7.2 ghcr.io/outro-dono/deskcommcrm:1.0.0 ${NS}/deskcommcrm:stable ${NS}/deskcommcrm:latest ${NS}/deskcomm-worker:1.1.1-jmpo.1 ${NS}/deskcommcrm:<none> ${NS}/deskcommcrm-extra:1.0.0"
QUATRO_VERSOES="$(das_quatro 1.0.0)$(das_quatro 1.0.5)$(das_quatro 1.1.0)$(das_quatro 1.2.0)"
rmis() { grep -c '^rmi ' "$DOCKER_LOG" || true; }
apagou() { grep -qxF "rmi $1" "$DOCKER_LOG"; }                                  # apagou <referência>
apagou_as_quatro() { local r; for r in $(das_quatro "$1"); do apagou "$r" || return 1; done; }
nenhum_rmi_da() { ! grep -qE "^rmi .*:${1//./\\.}\$" "$DOCKER_LOG"; }           # nenhum_rmi_da <versão>
nenhum_rmi_alheio() {
  local r; for r in $ALHEIAS; do if apagou "$r"; then return 1; fi; done; return 0
}
linha_do_ultimo() { grep -nE "$1" "$DOCKER_LOG" | tail -1 | cut -d: -f1; }
linha_do_primeiro() { grep -nE "$1" "$DOCKER_LOG" | head -1 | cut -d: -f1; }
command -v apagar_imagens_antigas >/dev/null \
  || { echo "  ✗ apagar_imagens_antigas não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
command -v imagens_de_versoes_antigas >/dev/null \
  || { echo "  ✗ imagens_de_versoes_antigas não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
command -v versao_no_ar >/dev/null \
  || { echo "  ✗ versao_no_ar não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }
export DUBLE_DIGESTS=iguais

echo "   15a. atualização 1.1.0 → 1.2.0 com quatro versões no disco: saem as duas mais velhas"
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
no_disco "${QUATRO_VERSOES}${ALHEIAS}"
: > "$DOCKER_LOG"
run_update
check "a atualização termina com sucesso" test "$RC" -eq 0
check "apagou as quatro imagens da 1.0.0" apagou_as_quatro 1.0.0
check "apagou as quatro imagens da 1.0.5" apagou_as_quatro 1.0.5
check "NÃO tocou na versão instalada agora (1.2.0)" nenhum_rmi_da 1.2.0
check "NÃO tocou na de reserva (1.1.0: sem saber a que rodava, é a maior das outras)" nenhum_rmi_da 1.1.0
check "NÃO tocou em nada que não é nosso (terceiros, outro namespace, canal, prerelease, sem tag, nome parecido)" \
  nenhum_rmi_alheio
check "foram exatamente 8 remoções, nem uma a mais" test "$(rmis)" -eq 8
check "nunca com -f / --force" test -z "$(grep -E '^rmi .*(-f|--force)' "$DOCKER_LOG" || true)"
check "nunca prune (de imagem, de sistema, de nada)" test -z "$(grep -E '(^| )prune( |$)' "$DOCKER_LOG" || true)"
check "só DEPOIS de o app responder saudável" \
  test "$(linha_do_primeiro '^rmi ')" -gt "$(linha_do_ultimo ' exec -T app ')"
check "conta ao dono o que fez" grep -q "apaguei as imagens de 2 versões antigas" "$OUTFILE"
check "  e que a versão no ar ficou" grep -q "ficam a 1.2.0, que está no ar, e mais uma de reserva" "$OUTFILE"

echo "   15b. o app NÃO voltou saudável → nenhuma imagem é apagada (o agent.sh precisa da anterior para voltar)"
# O MESMO disco do 15a, que ali perdeu 8 referências: o silêncio daqui é da
# ordem, não de uma lista vazia. O `sleep` é dublado SÓ neste caso — a espera
# do update.sh pelo app são 19 × 3 s.
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
mkdir -p "$WORK/sem-espera"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/sem-espera/sleep"; chmod +x "$WORK/sem-espera/sleep"
PATH_COM_ESPERA="$PATH"; export PATH="$WORK/sem-espera:$PATH"
export DUBLE_APP_DOENTE=1
: > "$DOCKER_LOG"
run_update
unset DUBLE_APP_DOENTE; export PATH="$PATH_COM_ESPERA"
check "o update sai != 0 (é o sinal que o agent.sh usa para voltar)" test "$RC" -ne 0
check "fixture: chegou a subir a versão nova" test -n "$(linha_do_ultimo ' up -d$')"
check "nenhum rmi" test "$(rmis)" -eq 0

echo "   15c. 'Nada a atualizar' não mexe em imagem: a limpeza é o último passo de uma atualização"
env_das_tres "${NS}/deskcommcrm:1.2.0" "${NS}/deskcomm-worker:1.2.0" "${NS}/deskcomm-scheduler:1.2.0"
: > "$DOCKER_LOG"
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "nenhum rmi" test "$(rmis)" -eq 0

echo "   15d. imagem antiga presa a um contêiner: o Docker recusa, o update segue e não mente"
# As quatro da 1.0.0 em uso (uma segunda instalação na mesma VPS, um contêiner
# parado que alguém esqueceu). Sem `-f`, quem decide é o Docker.
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
export DUBLE_EM_USO="$(das_quatro 1.0.0)"
: > "$DOCKER_LOG"
run_update
unset DUBLE_EM_USO
check "a atualização termina com sucesso" test "$RC" -eq 0
check "  e diz que concluiu" grep -q "Atualização concluída" "$OUTFILE"
check "tentou as oito (a recusa de uma não interrompe as outras)" test "$(rmis)" -eq 8
check "só conta a versão que saiu de verdade" grep -q "apaguei as imagens da versão 1.0.5" "$OUTFILE"
check "  e não afirma ter apagado a 1.0.0" test -z "$(grep 'apaguei' "$OUTFILE" | grep -F '1.0.0' || true)"
check "diz que quatro ficaram, e por quê" grep -q "4 imagens antigas ficaram" "$OUTFILE"

echo "   15e. Docker que não lista as imagens → nada é apagado, e a atualização não falha por isso"
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
export DUBLE_IMAGES_QUEBRADO=1
: > "$DOCKER_LOG"
run_update
unset DUBLE_IMAGES_QUEBRADO
check "a atualização termina com sucesso" test "$RC" -eq 0
check "nenhum rmi" test "$(rmis)" -eq 0
check "avisa que não apagou nada" grep -q "não consegui listar as imagens" "$OUTFILE"

echo "   15f. as guardas de erro, medidas na FUNÇÃO"
# Chamada DIRETA, num subshell com o `set -euo pipefail` do kit, FORA de `if` e
# de `$( )` — nas duas formas o errexit não vale e a prova passaria com a guarda
# arrancada (a mesma armadilha do caso 14h).
( set -euo pipefail
  export DUBLE_IMAGES_QUEBRADO=1
  apagar_imagens_antigas 1.2.0 ) >/dev/null 2>&1
check "docker images que sai != 0 não mata a função" test "$?" -eq 0
( set -euo pipefail
  export DUBLE_EM_USO="$(das_quatro 1.0.0)$(das_quatro 1.0.5)"
  apagar_imagens_antigas 1.2.0 ) >/dev/null 2>&1
check "docker rmi recusando TODAS não mata a função" test "$?" -eq 0
( set -euo pipefail
  export DUBLE_NO_DISCO=""
  apagar_imagens_antigas 1.2.0 ) >/dev/null 2>&1
check "disco sem imagem nenhuma não mata a função" test "$?" -eq 0
# Controle: a MESMA chamada, com o docker respondendo, apaga — senão os três
# zeros acima podiam ser de uma função que não faz nada.
: > "$DOCKER_LOG"
( set -euo pipefail; apagar_imagens_antigas 1.2.0 ) >/dev/null 2>&1
check "controle: com o docker respondendo, a mesma chamada apaga as 8" test "$(rmis)" -eq 8
# A versão no ar: o `docker inspect` de um contêiner que não existe sai != 0.
( set -euo pipefail
  export DUBLE_INSPECT_QUEBRADO=1
  versao_no_ar ) >/dev/null 2>&1
check "docker inspect que sai != 0 não mata versao_no_ar" test "$?" -eq 0
: > "$DOCKER_LOG"   # sem `up -d` no log: quem responde é o contêiner de ANTES
check "controle: com o docker respondendo, ela devolve a versão" \
  test "$(DUBLE_VERSAO_NO_AR=1.0.5 versao_no_ar)" = "1.0.5"
check "rótulo ausente (imagem construída à mão) → vazio, não '<no value>'" \
  test -z "$(DUBLE_VERSAO_NO_AR='<no value>' versao_no_ar)"
check "rótulo que é canal (latest) → vazio: canal não é versão" \
  test -z "$(DUBLE_VERSAO_NO_AR=latest versao_no_ar)"
# Alvo que não é versão numerada (instalação que segue um canal): não há régua,
# então a função nem pergunta ao Docker — e não imprime um "nenhuma versão
# antiga" que seria afirmação sobre um disco que ela não olhou.
: > "$DOCKER_LOG"
DISSE="$(apagar_imagens_antigas latest 2>&1)"
check "alvo em canal móvel: não consulta o Docker" test ! -s "$DOCKER_LOG"
check "  e não afirma nada" test -z "$DISSE"

echo "   15g. a regra, isolada do Docker (texto entra, texto sai)"
antigas_caso() {  # antigas_caso <descrição> <alvo> <esperado, separado por espaço> <no disco, separado por espaço> [versão que rodava]
  local r
  r="$(printf '%s\n' $4 | imagens_de_versoes_antigas "$2" "${5:-}" | tr '\n' ' ' || true)"
  check "$1" test "${r% }" = "$3"
}
A="${NS}/deskcommcrm"
antigas_caso "só a instalada e a de reserva no disco → nada a apagar" 1.2.0 "" "$A:1.1.0 $A:1.2.0"
antigas_caso "três versões → sai a mais velha" 1.2.0 "$A:1.0.0" "$A:1.0.0 $A:1.1.0 $A:1.2.0"
antigas_caso "a ordem é NUMÉRICA: a reserva da 1.11.0 é a 1.10.0, não a 1.9.0" 1.11.0 "$A:1.9.0" \
  "$A:1.9.0 $A:1.10.0 $A:1.11.0"
antigas_caso "  e 2.0.0 é maior que 1.99.99" 2.0.1 "$A:1.99.99" "$A:1.99.99 $A:2.0.0 $A:2.0.1"
# `--to <antiga> --force`: a que rodava até agora é MAIOR que o alvo, e é ela a
# reserva — é para ela que o dono volta se o retrocesso não servir.
antigas_caso "retrocesso de propósito: fica o alvo e a que rodava (a maior das outras)" 1.1.0 "$A:1.0.0" \
  "$A:1.0.0 $A:1.1.0 $A:1.2.0"
antigas_caso "o alvo NÃO está no disco → não apaga nada (a régua não está medindo esta instalação)" 9.9.9 "" \
  "$A:1.0.0 $A:1.1.0 $A:1.2.0"
antigas_caso "alvo em canal móvel (latest) → não apaga nada" latest "" "$A:1.0.0 $A:1.1.0 $A:latest"
antigas_caso "alvo vazio → não apaga nada" "" "" "$A:1.0.0 $A:1.1.0 $A:1.2.0"
antigas_caso "prerelease como alvo → não apaga nada" 1.2.0-rc1 "" "$A:1.0.0 $A:1.1.0 $A:1.2.0-rc1"
antigas_caso "outro namespace, canal, prerelease, sem tag e nome parecido não entram na conta" 1.2.0 "$A:1.0.0" \
  "$A:1.0.0 $A:1.1.0 $A:1.2.0 $ALHEIAS"
antigas_caso "registro com PORTA no nome não confunde o corte do dois-pontos" 1.2.0 "" \
  "localhost:5000/x/deskcommcrm:1.0.0 $A:1.1.0 $A:1.2.0"
# A versão é da INSTALAÇÃO, não de cada repositório: o Asterisk só existe a
# partir de certa versão, e a reserva dele é a mesma das outras três.
antigas_caso "os quatro repositórios andam pela mesma régua de versão" 1.2.0 \
  "$A:1.0.0 ${NS}/deskcomm-worker:1.0.0" \
  "$A:1.0.0 ${NS}/deskcomm-worker:1.0.0 $A:1.1.0 ${NS}/deskcomm-asterisk:1.1.0 $A:1.2.0 ${NS}/deskcomm-asterisk:1.2.0"
# A reserva é a que RODAVA. O caso que derruba "a maior das outras": a
# atualização para a 1.2.0 falhou e o agent.sh voltou para a 1.1.0; dias depois
# a 1.3.0 sobe. A maior das outras é a 1.2.0 — a que quebrou.
QUATRO_NO_DISCO="$A:1.0.0 $A:1.1.0 $A:1.2.0 $A:1.3.0"
antigas_caso "a reserva é a que RODAVA (1.1.0), não a maior das outras (1.2.0, a que quebrou)" 1.3.0 \
  "$A:1.0.0 $A:1.2.0" "$QUATRO_NO_DISCO" 1.1.0
antigas_caso "a que rodava NÃO está no disco → a maior das outras" 1.3.0 \
  "$A:1.0.0 $A:1.1.0" "$QUATRO_NO_DISCO" 0.9.0
antigas_caso "a que rodava É o alvo (--force na mesma versão) → a maior das outras" 1.3.0 \
  "$A:1.0.0 $A:1.1.0" "$QUATRO_NO_DISCO" 1.3.0
antigas_caso "não se sabe a que rodava → a maior das outras" 1.3.0 \
  "$A:1.0.0 $A:1.1.0" "$QUATRO_NO_DISCO" ""
# Um `sort` que ecoa uma versão ERRADA e sai != 0. Aceitar o que ele ecoou
# guardaria a 1.0.0 e apagaria a 1.1.0, que é a reserva de verdade; tratar a
# falha como "não há reserva" apagaria as duas. Nenhuma das duas serve.
mkdir -p "$WORK/sort-quebrado"
printf '#!/usr/bin/env bash\ncat >/dev/null\necho 1.0.0\nexit 1\n' > "$WORK/sort-quebrado/sort"
chmod +x "$WORK/sort-quebrado/sort"
R="$(printf '%s\n' "$A:1.0.0" "$A:1.1.0" "$A:1.2.0" \
      | PATH="$WORK/sort-quebrado:$PATH" imagens_de_versoes_antigas 1.2.0 | tr '\n' ' ' || true)"
check "sem conseguir decidir a reserva → não apaga nada (erra para o lado de onde se volta)" test -z "$R"

echo "   15h. mesmo se a limpeza FALHAR, a atualização que deu certo sai com 0"
# A função não falha (15f). Mas quem garante isso para a versão dela de daqui a
# um ano é quem CHAMA: o update.sh roda sob `set -euo pipefail`, e uma limpeza
# que saísse != 0 faria o agent.sh desfazer uma atualização que deu certo. Aqui
# a função é trocada, no kit da fixture, por uma que só falha.
cp hostgator-setup-kit/_common.sh "$WORK/_common.sh.inteiro"
printf '\napagar_imagens_antigas() { return 1; }\n' >> hostgator-setup-kit/_common.sh
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
: > "$DOCKER_LOG"
run_update
cp "$WORK/_common.sh.inteiro" hostgator-setup-kit/_common.sh
check "fixture: o update chegou ao passo da limpeza" grep -q "Liberando espaço em disco" "$OUTFILE"
check "fixture: quem rodou foi a função que só falha" test "$(rmis)" -eq 0
check "a atualização sai com 0" test "$RC" -eq 0

echo "   15i. a reserva é a versão que estava NO AR, lida antes de o contêiner ser recriado"
# O `.env` não diz o que roda — depois de um rollback do agent.sh ele guarda um
# ID local. Quem diz é o contêiner, e só até o `up -d`: depois dele o contêiner
# já é o novo e responderia o alvo. Aqui o que rodava era a 1.0.5, e a 1.1.0
# (a maior das outras) está no disco sem nunca ter ficado no ar.
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
export DUBLE_VERSAO_NO_AR=1.0.5 DUBLE_VERSAO_DEPOIS=1.2.0
: > "$DOCKER_LOG"
run_update
unset DUBLE_VERSAO_NO_AR DUBLE_VERSAO_DEPOIS
check "a atualização termina com sucesso" test "$RC" -eq 0
check "ficou a 1.0.5, a que rodava" nenhum_rmi_da 1.0.5
check "saiu a 1.1.0, que nunca esteve no ar" apagou_as_quatro 1.1.0
check "saiu a 1.0.0" apagou_as_quatro 1.0.0
check "a instalada (1.2.0) segue intocada" nenhum_rmi_da 1.2.0

unset DUBLE_NO_DISCO

echo "── 16. Telefonia: a porta SIP é conferida depois do up -d, e nunca falha a atualização"
# Recriar o Asterisk deixa a porta 5060 presa ao IP do contêiner anterior, e os
# números ficam em "registro recusado" sem voltar sozinhos — medido em cinco
# atualizações com a telefonia ligada (1.52.2 a 1.57.0). O conserto é
# `religar_troncos_sip`, e a regra dela é provada em
# tests/shell/telefonia-porta-sip.test.sh. Aqui se prova o que só o update.sh
# INTEIRO mostra: que ele chama, na hora certa, e que não cai junto.
CERTA_16="udp      17 118 src=172.19.0.6 dst=198.51.100.58 sport=5060 dport=5060 src=198.51.100.58 dst=203.0.113.10 sport=5060 dport=5060 [ASSURED] mark=0 use=1"
conferiu_a_telefonia() { grep -q "Conferindo a telefonia" "$OUTFILE"; }
concluiu() { grep -q "Atualização concluída" "$OUTFILE"; }
tocou_na_tabela() { grep -q -- '--entrypoint conntrack' "$DOCKER_LOG"; }

echo "   16a. telefonia ligada, Asterisk no ar e porta certa → confere, e não mexe em nada"
env_da_telefonia "telefonia" "${NS}/deskcomm-asterisk:1.1.0" 1
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
export DUBLE_ASTERISK_NO_AR=1 DUBLE_CONNTRACK="$CERTA_16"
: > "$DOCKER_LOG"
run_update
check "a atualização termina com sucesso" test "$RC" -eq 0
check "conferiu a telefonia" conferiu_a_telefonia
check "leu a tabela com o conntrack da imagem do PRÓPRIO Asterisk, só UDP de origem 5060" \
  grep -q -- '--network host --cap-add NET_ADMIN --entrypoint conntrack sha256:c806ecd5fd3d -L -p udp --orig-port-src 5060$' "$DOCKER_LOG"
check "diz que a porta não ficou presa" grep -q "a porta 5060 não ficou presa" "$OUTFILE"
check "DEPOIS do up -d (antes dele o Asterisk ainda é o antigo)" \
  test "$(linha_do_primeiro 'State\.Running')" -gt "$(linha_do_primeiro ' up -d$')"
check "e ANTES de perguntar ao app se ele voltou (o rollback não volta o Asterisk)" \
  test "$(linha_do_primeiro 'State\.Running')" -lt "$(linha_do_ultimo ' exec -T app ')"
check "os números registrados foram lidos ANTES do up -d" \
  test "$(linha_do_primeiro 'pjsip show registrations')" -lt "$(linha_do_primeiro ' up -d$')"
check "com a porta certa: não limpou a tabela nem reiniciou o worker" \
  test -z "$(grep -E '^restart | -D ' "$DOCKER_LOG" || true)"
check "nunca tocou no conntrack do servidor de quem roda o teste" \
  test -z "$(grep '^CONNTRACK-DO-SERVIDOR' "$DOCKER_LOG" || true)"

echo "   16b. Asterisk fora do ar depois do up -d → avisa, e a atualização que deu certo sai com 0"
# A função devolve 1 ("não ficou bom"). O update.sh roda sob `set -euo pipefail`:
# sem o `|| true` de quem chama, o agent.sh desfaria uma atualização saudável.
unset DUBLE_ASTERISK_NO_AR DUBLE_CONNTRACK
env_da_telefonia "telefonia" "${NS}/deskcomm-asterisk:1.1.0" 1
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
: > "$DOCKER_LOG"
run_update
check "avisa que o Asterisk não está no ar" grep -q "o Asterisk não está no ar" "$OUTFILE"
check "não tentou ler a tabela de um Asterisk que não existe" bash -c "! grep -q -- '--entrypoint conntrack' '$DOCKER_LOG'"
check "a atualização sai com 0" test "$RC" -eq 0
check "e chegou ao fim" concluiu

echo "   16c. mesmo se a conferência FALHAR por inteiro, a atualização que deu certo sai com 0"
cp hostgator-setup-kit/_common.sh "$WORK/_common.sh.inteiro"
printf '\nreligar_troncos_sip() { return 1; }\n' >> hostgator-setup-kit/_common.sh
env_da_telefonia "telefonia" "${NS}/deskcomm-asterisk:1.1.0" 1
em_execucao "${TRES_NO_ALVO[@]}" "${NS}/deskcomm-asterisk:1.1.0"
: > "$DOCKER_LOG"
run_update
cp "$WORK/_common.sh.inteiro" hostgator-setup-kit/_common.sh
check "fixture: o update chegou à telefonia" conferiu_a_telefonia
check "a atualização sai com 0" test "$RC" -eq 0
check "e chegou ao fim" concluiu

echo "   16d. telefonia DESLIGADA → nem confere (nada muda para quem não usa)"
env_das_tres "${NS}/deskcommcrm:1.1.0" "${NS}/deskcomm-worker:1.1.0" "${NS}/deskcomm-scheduler:1.1.0"
export DUBLE_ASTERISK_NO_AR=1 DUBLE_CONNTRACK="$CERTA_16"   # mesmo com tudo respondendo
: > "$DOCKER_LOG"
run_update
unset DUBLE_ASTERISK_NO_AR DUBLE_CONNTRACK
check "fixture: a atualização rodou" concluiu
check "não há o bloco da telefonia na saída" bash -c "! grep -q 'Conferindo a telefonia' '$OUTFILE'"
check "nenhuma leitura da tabela de conexões" bash -c "! grep -q -- '--entrypoint conntrack' '$DOCKER_LOG'"
check "nenhuma pergunta ao Asterisk" bash -c "! grep -q 'asterisk -rx' '$DOCKER_LOG'"

echo
echo "── 17. Repositório fechado: sem conseguir consultar o GitHub, o update.sh NÃO diz 'em dia' em verde"
# Com o repositório privado e a VPS sem a chave de leitura (ou com ela revogada),
# o `git fetch` falha e o script seguia com as tags que já tinha — respondendo
# "✓ Você já está na versão mais recente. Nada a atualizar." a uma instalação que
# pode estar várias versões atrás. Verde que afirma o que não conferiu.
#
# A instalação deste bloco está EM DIA entre as versões que conhece: `.env`, digest
# e contêineres no alvo. O que muda de um subcaso para o outro é só o `fetch`.
V17="$(git describe --tags --exact-match HEAD 2>/dev/null)"; V17="${V17#v}"
check "fixture: o código está numa tag" test -n "$V17"
env_das_tres "${NS}/deskcommcrm:${V17}" "${NS}/deskcomm-worker:${V17}" "${NS}/deskcomm-scheduler:${V17}"
em_execucao "${NS}/deskcommcrm:${V17}" "${NS}/deskcomm-worker:${V17}" "${NS}/deskcomm-scheduler:${V17}"
disse_em_dia_em_verde() { grep -q "✓ Você já está na versão mais recente" "$OUTFILE"; }
disse_que_nao_conferiu() { grep -q "QUE ESTE SERVIDOR CONHECE" "$OUTFILE"; }
disse_que_foi_recusado() { grep -q "RECUSOU o acesso deste servidor" "$OUTFILE"; }
apontou_o_runbook() { grep -q "docs/runbooks/repositorio-fechado.md" "$OUTFILE"; }

echo "   17a. CONTROLE: com o GitHub respondendo, a resposta é a de sempre, em verde"
# Sem este controle os subcasos seguintes não provam nada: bastaria a fixture
# não estar em dia para o script nunca chegar à frase medida.
unset DUBLE_FETCH_TAGS_FALHA
run_update
check "responde 'Nada a atualizar'" nada_a_atualizar
check "em verde, afirmando que é a mais recente" disse_em_dia_em_verde
check "sem falar em acesso recusado" bash -c "! grep -q 'RECUSOU' '$OUTFILE'"
check "sai com 0" test "$RC" -eq 0

echo "   17b. o GitHub RECUSA a chave (repositório fechado, servidor sem acesso)"
export DUBLE_FETCH_TAGS_FALHA="git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository."
run_update
check "NÃO afirma em verde que é a mais recente" bash -c "! grep -q '✓ Você já está na versão mais recente' '$OUTFILE'"
check "diz que é a mais recente QUE ESTE SERVIDOR CONHECE" disse_que_nao_conferiu
check "diz que o acesso foi RECUSADO, e não 'sem internet'" disse_que_foi_recusado
check "aponta o passo a passo" apontou_o_runbook
check "não mexeu em nada: nem backup" test ! -f "$BACKUP_MARK"
check "sai com 0 (não é falha de atualização: não havia o que aplicar)" test "$RC" -eq 0

echo "   17c. o mesmo por HTTPS: o git pediria usuário e senha, e não pode ficar esperando"
export DUBLE_FETCH_TAGS_FALHA="fatal: could not read Username for 'https://github.com': terminal prompts disabled"
run_update
check "também é lido como acesso recusado" disse_que_foi_recusado
check "e não afirma 'em dia' em verde" bash -c "! grep -q '✓ Você já está na versão mais recente' '$OUTFILE'"

echo "   17d. falha de REDE não é acusada de falta de chave"
# O remédio é outro (esperar a rede voltar), e mandar o dono atrás de uma chave
# que está no lugar seria trocar um silêncio por uma pista falsa.
export DUBLE_FETCH_TAGS_FALHA="fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"
run_update
check "diz que não conseguiu falar com o GitHub" grep -q "não consegui falar com o GitHub" "$OUTFILE"
check "NÃO diz que o acesso foi recusado" bash -c "! grep -q 'RECUSOU' '$OUTFILE'"
check "e mesmo assim não afirma 'em dia' em verde" disse_que_nao_conferiu

echo "   17e. o script pede ao git que NÃO pergunte senha no terminal"
# Lido no próprio update.sh e no agent.sh: sem isto, rodado à mão por SSH num
# servidor sem credencial, o git pára numa pergunta de usuário e senha.
check "update.sh busca as tags com GIT_TERMINAL_PROMPT=0" \
  grep -qE '^[^#]*GIT_TERMINAL_PROMPT=0 git fetch --tags' hostgator-setup-kit/update.sh
check "agent.sh também" \
  grep -qE '^[^#]*GIT_TERMINAL_PROMPT=0 git fetch --tags' hostgator-setup-kit/agent.sh
unset DUBLE_FETCH_TAGS_FALHA

unset DUBLE_DIGESTS

if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
