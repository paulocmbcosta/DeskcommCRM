#!/usr/bin/env bash
# Prova de `religar_troncos_sip` (hostgator-setup-kit/_common.sh): o conserto da
# porta SIP 5060 depois que o `update.sh` recria o Asterisk.
#
#   bash tests/shell/telefonia-porta-sip.test.sh
#
# O defeito, medido na VPS em cinco atualizações e reproduzido em laboratório
# (dockerd 29.8.0 dentro de um contêiner, Asterisk 20.11 dos dois lados, em
# 2026-10-07): o Asterisk novo nasce com outro IP, a linha do IP antigo segura a
# 5060 na tabela de conexões do servidor, o novo sai por outra porta e a
# operadora recusa o registro — e não volta sozinho.
#
# O QUE ESTE ARQUIVO PROVA, E COM QUÊ
#
#   1. O JULGAMENTO (`veredito_da_porta_sip`), com as linhas que o `conntrack`
#      imprimiu DE VERDADE no laboratório — não com um formato imaginado.
#   2. A LEITURA do Asterisk (`registros_sip`, `canais_do_asterisk`), com a
#      saída real do Asterisk 20.11, inclusive "Rejected" e "No objects found".
#   3. A ORQUESTRAÇÃO, contra um dublê de `docker` que tem ESTADO: uma tabela,
#      uma lista de registros, canais e o log do worker. O dublê carrega a única
#      regra do mundo que importa aqui, e ela também foi medida: depois de uma
#      limpeza, quem falar primeiro fica com a 5060. Se o kit manda o Asterisk
#      falar (`pjsip qualify`), é o Asterisk. Se não manda e a operadora disputa
#      a porta, é ela — e o Asterisk sai desviado de novo.
#   4. O ENCAIXE no update.sh, no Dockerfile e no log do worker.
#   5. O SCRIPT `religar-telefonia.sh`, executado de verdade contra o dublê.
#
# O DUBLÊ NÃO É O DOCKER. Ele não prova que a 5060 volta numa VPS: isso foi
# provado no laboratório, com NAT e Asterisk de verdade. Ele prova que a função
# toma a decisão certa em cada estado, na ordem certa, e que não age quando não
# deve — que é o que uma mudança futura quebraria sem ninguém ver.
#
# SABOTAGENS, uma por linha da regra, medidas em 2026-10-07. Cada uma foi
# aplicada SOZINHA a uma cópia do arquivo (`KIT_COMUM=…` ou `UPDATE_SH=…` trocam
# o que está sob prova), e à direita está o que fica vermelho: bloco × provas.
# Nenhuma das 54 deixou a suíte verde.
#   sem o passo OCUPAR .............................................. 3a2×1 3b×3 3c×4 3e×1 3e2×1 3m×1
#   reinicia logo após limpar, sem conferir a porta ................. 3b×1 3i×1
#   sem a guarda de ligação em curso ................................ 3e×5 3k×3 5×1
#   guarda de ligação falha ABERTA (não soube = não há) ............. 3e2×3 3k×1
#   pergunta pelos canais uma vez só ................................ 3e2×1
#   sem a prova de que o worker reenviou ............................ 3f×3
#   a prova do reenvio lê o log INTEIRO (sem --since) ............... 3f×4
#   a prova do reenvio conta desde sempre (desde=0) ................. 3f×4
#   registro pela porta errada conta como 'voltou' .................. 3e×3 3k×2 5×1
#   tabela ilegível vira 'está certo' ............................... 3h×2
#   limpa mesmo com tudo certo ...................................... 3a×8 3a2×6 3b×7 3c×3 3d×3 3e×3 3e2×3 3f×5 3g×8 3k×8 3l×1 3o×3 3p×1 3n×4 5×4
#   não enxerga a linha presa ....................................... 1×5 3d×3 3o×1
#   sobra desviada de um Asterisk antigo conta como presa ........... 1×1
#   presa que reaparece é limpa de novo a cada volta ................ 3o×3
#   julga com a PRIMEIRA rede da lista, sem perguntar a rota ........ 3n×5
#   sem saber a rota, julga com a primeira rede (não com todas) ..... 3n×1
#   com a rota conhecida, ainda julga com todas as redes ............ 3n×2
#   qualquer IP de fora conta como presa ............................ 1×5 3n×2
#   lê o 1º dport (a porta da operadora), não o último .............. 1×5 3a2×2 3b×5 3c×2 3e×4 3e2×2 3f×6 3g×3 3i×2 3l×1 3p×1 3n×2
#   limpa TODA a tabela UDP, não só a 5060 .......................... 3b×1 3l×1
#   limpa a 5060 de qualquer protocolo .............................. 3b×1 3l×1
#   ignora os registrados de antes (régua = todos) .................. 3g×6
#   zero registrados antes vira 'não sei' (régua = todos) ........... 3g×2
#   mais registrados antes do que há agora vira 'todos' ............. 3g×2
#   régua frouxa (basta 1 registrado) ............................... 3g×7
#   declara sucesso sem olhar os registros .......................... 3a2×4 3d×1 3g×5 3k×2
#   na atualização, 'não ficou presa' lido uma vez já é 'voltou' .... 3a×1 3a2×4
#   na atualização, reinicia o worker quando os números não voltam .. 3a2×4 3d×1
#   sem limite de rodadas respeitado (10) ........................... 3i×4
#   age com a telefonia desligada ................................... 3j×2
#   age com o Asterisk parado ....................................... 3j×1
#   nunca usa o conntrack do servidor ............................... 3l×1
#   usa o conntrack do servidor sem ser root ........................ 3a×1 3b×1 3h×5 3l×2 3p×1
#   nome do tronco sem filtro ....................................... 3m×1
#   à mão não reenvia o número recusado ............................. 3k×3
#   à mão, sem número nenhum, reinicia o worker assim mesmo ......... 3k×2
#   Asterisk mudo passa por 'não tem número nenhum' ................. 3k×1
#   --reenviar não força o reenvio .................................. 3k×4 5×2
#   --reenviar adiado conta como feito .............................. 3k×2 5×1
#   reinício que falha conta como feito ............................. 3k×1
#   Unregistered casa como Registered ............................... 2×1
#   'No objects found' vira um número ............................... 2×2 3a×1 3a2×2 3b×1 3d×1 3e×1 3e2×1 3g×3 3k×6 5×4
#   Asterisk mudo vira 'nenhum número' .............................. 2×2 3k×1
#   pergunta ao Asterisk sem o prazo de dentro ...................... 2×1
#   reinicia o worker no caminho da prevenção ....................... 3d×1 3o×1
#   usa pjsip send register no lugar do qualify ..................... 3a2×1 3b×4 3c×4 3e×1 3e2×1 3m×1
#   o texto procurado no log muda só no kit ......................... 3a2×1 3b×2 3c×1 3f×1 3g×8 3k×2 3l×1 3p×1 3n×2 4×1 5×2
#   com_prazo não roda o comando quando não há timeout .............. 2×7 3a×6 3a2×6 3b×10 3c×4 3d×4 3e×3 3e2×3 3f×5 3g×8 3h×2 3i×2 3k×8 3l×4 3m×1 3o×2 3n×4 5×4
#   docker restart sem o prazo de fora .............................. 3p×1
#   update.sh: confere a telefonia DEPOIS da saúde do app ........... 4×1
#   update.sh: sem o || true ........................................ 4×1
#   update.sh: sem a guarda de telefonia ligada ..................... 4×1
#   update.sh: não passa os registrados de antes .................... 4×1
#   update.sh: lê os registrados DEPOIS do up -d .................... 4×1
# As cinco últimas, do update.sh, aqui são conferidas no TEXTO do arquivo. A
# prova de comportamento delas — o update.sh inteiro rodando — é o caso 16 de
# tests/shell/update-guard.test.sh.
#
# Duas destas linhas existem porque uma revisão independente as achou PASSANDO:
# a prova de "o worker reenviou" ficava verde lendo o log inteiro (sem `--since`)
# e contando desde sempre, porque o dublê de `docker logs` não filtrava por
# instante e o log do mundo nascia vazio. Num worker de verdade sempre há uma
# linha de envio anterior. Hoje o dublê filtra e o mundo nasce com a linha velha.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# O arquivo sob prova pode ser trocado por uma cópia sabotada (KIT_COMUM=…).
KIT_COMUM="${KIT_COMUM:-$REPO_ROOT/hostgator-setup-kit/_common.sh}"
UPDATE_SH="${UPDATE_SH:-$REPO_ROOT/hostgator-setup-kit/update.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}" >/dev/null 2>&1; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── O mundo do dublê ─────────────────────────────────────────────────────────
# Endereços: os da VPS no dia em que o defeito foi medido, com o IP público e o
# da operadora trocados por endereços de documentação.
AST="172.19.0.6"      # o Asterisk novo
VELHO="172.19.0.2"    # o Asterisk que a atualização removeu
OP="198.51.100.58"    # a operadora
PUB="203.0.113.10"    # o IP público do servidor
linha() {  # linha <IP de origem> <porta lá fora>   — o formato é o do conntrack 1.4.8, copiado do laboratório
  printf 'udp      17 118 src=%s dst=%s sport=5060 dport=5060 src=%s dst=%s sport=5060 dport=%s [ASSURED] mark=0 use=1\n' "$1" "$OP" "$OP" "$PUB" "$2"
}
CERTA="$(linha "$AST" 5060)"
DESVIADA="$(linha "$AST" 60039)"
PRESA="$(linha "$VELHO" 5060)"
# A operadora falando PRIMEIRO com o servidor: a linha é dela, de fora da rede
# do compose. Copiada do laboratório, onde foi ela que tomou a 5060.
DA_OPERADORA="udp      17 29 src=${OP} dst=${PUB} sport=5060 dport=5060 [UNREPLIED] src=${PUB} dst=${OP} sport=5060 dport=5060 mark=0 use=1"

registro() {  # registro <nome> <estado>   — linha de `pjsip show registrations`, Asterisk 20.11
  printf ' %s/sip:%s;transport=udp                 %s                  %s        (exp. 284s)\n' "$1" "$OP" "$1" "$2"
}
registros() {  # registros <linha...> → a saída inteira do comando
  printf '\n <Registration/ServerURI..............................>  <Auth....................>  <Status.......>\n'
  printf '==========================================================================================\n\n'
  local n=0 l
  for l in "$@"; do printf '%s\n' "$l"; n=$((n + 1)); done
  printf '\nObjects found: %s\n\n' "$n"
}
SEM_REGISTROS="No objects found."

mkdir -p "$WORK/bin" "$WORK/deskcommcrm"
M="$WORK/mundo"
export MUNDO="$M"

# O `conntrack` do mundo. Serve aos DOIS caminhos: o do contêiner efêmero (o
# dublê de `docker run` cai aqui) e o do servidor que já tem o programa.
cat > "$WORK/conntrack-do-mundo" <<'STUB'
#!/usr/bin/env bash
M="$MUNDO"
ev() { printf '%s\n' "$*" >> "$M/eventos"; }
tem_tronco() { grep -q 'sip:' "$M/registros" 2>/dev/null; }
case "${1:-}" in
  -L)
    n=$(( $(cat "$M/listagens" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$M/listagens"
    # O roteiro do caso: uma linha por listagem, executada ANTES de responder.
    # É como o mundo muda sozinho no meio da função (o worker que sobe depois).
    passo="$(sed -n "${n}p" "$M/roteiro" 2>/dev/null)"
    [ -n "$passo" ] && eval "$passo"
    # A REGRA DO MUNDO (medida): porta limpa e ninguém a ocupou → fica com quem
    # falar primeiro. Com a operadora disputando, é ela; o Asterisk sai desviado.
    if [ -f "$M/aberta" ] && tem_tronco; then
      rm -f "$M/aberta"
      if [ -f "$M/disputa" ]; then
        cat "$M/linha-da-operadora" "$M/linha-desviada" >> "$M/tabela"
      else
        cat "$M/linha-certa" >> "$M/tabela"
      fi
    fi
    ev "LISTOU"
    cat "$M/tabela" 2>/dev/null
    echo "conntrack v1.4.8 (conntrack-tools): $(wc -l < "$M/tabela" | tr -d ' ') flow entries have been shown." >&2 ;;
  -D)
    ev "LIMPOU $*"
    havia="$(grep -c 'sport=5060' "$M/tabela" 2>/dev/null || true)"
    : > "$M/tabela"; : > "$M/aberta"
    echo "conntrack v1.4.8 (conntrack-tools): ${havia:-0} flow entries have been deleted." >&2
    # Medido: sai 1 quando não apagou nada.
    [ "${havia:-0}" -gt 0 ] || exit 1 ;;
esac
exit 0
STUB

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
M="$MUNDO"
printf '%s\n' "$*" >> "$M/chamadas"
ev() { printf '%s\n' "$*" >> "$M/eventos"; }
case "${1:-}" in
  inspect)
    # `docker inspect <asterisk> --format '{{.State.Running}} {{.Image}} <IP>/<bits>'`
    cat "$M/asterisk" 2>/dev/null ;;
  run)
    # docker run --rm --network host --cap-add NET_ADMIN --entrypoint conntrack <imagem> <args…>
    ev "EFEMERO $9"
    # Imagem anterior a esta mudança: o binário não existe lá dentro. É o que o
    # Docker devolve de verdade (medido com a imagem `:dev`): status 127.
    [ -f "$M/imagem-sem-conntrack" ] && { echo 'exec: "conntrack": executable file not found in $PATH' >&2; exit 127; }
    shift 9; exec "$CONNTRACK_DO_MUNDO" "$@" ;;
  exec)
    # docker exec <asterisk> timeout <s> <programa> …  — o prazo de DENTRO é do kit
    # (perguntar_ao_asterisk); o dublê o anota e segue para o programa.
    shift 2
    if [ "${1:-}" = "timeout" ]; then ev "PRAZO-DE-DENTRO $2"; shift 2; else ev "SEM-PRAZO-DE-DENTRO $*"; fi
    case "${1:-}" in
      ip)
        # ip -4 route get <endereço>: por onde o contêiner sai. A saída é a do
        # busybox da imagem (copiada do laboratório).
        ev "PERGUNTOU-A-ROTA"
        [ -f "$M/sem-ip-route" ] && exit 1
        printf '192.0.2.1 via 172.19.0.1 dev eth1  src %s \n' "$(cat "$M/saida-por")" ;;
      asterisk)
        cmd="${3:-}"   # asterisk -rx '<comando>'
        case "$cmd" in
          "pjsip show registrations")
            [ -f "$M/asterisk-mudo" ] && exit 1
            cat "$M/registros" ;;
          "core show channels count")
            ev "PERGUNTOU-OS-CANAIS"
            [ -f "$M/asterisk-mudo" ] && exit 1
            [ -f "$M/canais-mudos" ] && exit 1
            printf '%s active channels\n%s active calls\n31 calls processed\n' "$(cat "$M/canais")" "$(cat "$M/canais")" ;;
          "pjsip qualify "*)
            ev "OCUPOU ${cmd#pjsip qualify }"
            # O Asterisk falou: se a porta estava limpa, é dele.
            if [ -f "$M/aberta" ]; then rm -f "$M/aberta"; cat "$M/linha-certa" >> "$M/tabela"; fi ;;
          *) ev "COMANDO-DESCONHECIDO $cmd" ;;
        esac ;;
    esac ;;
  restart)
    ev "REINICIOU $2"
    [ -f "$M/restart-falha" ] && exit 1
    # O worker que sobe: empurra os troncos (a linha do log é a dele) e o
    # Asterisk registra. Um caso pode trocar isto por outro desfecho.
    if [ -f "$M/ao-reiniciar" ]; then . "$M/ao-reiniciar"; fi ;;
  logs)
    # docker logs --since <instante> <contêiner>. O arquivo do mundo guarda
    # "<instante> <linha>", e o `--since` FILTRA como o Docker filtra: no log do
    # worker de verdade sempre há uma linha "tronco enviado" de antes do
    # reinício (a de quando ele subiu com a atualização), e é só a de DEPOIS que
    # prova alguma coisa. Sem `--since`, sai tudo — que é o defeito.
    ev "LEU-O-LOG"
    desde=0
    [ "${2:-}" = "--since" ] && desde="${3:-0}"
    awk -v d="$desde" '$1 + 0 >= d + 0 { sub(/^[0-9]+ /, ""); print }' "$M/log-do-worker" 2>/dev/null ;;
esac
exit 0
STUB
# Nada de esperar de relógio: o que se prova é a ordem, não o tempo.
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
# QUEM RODA ESTE TESTE NÃO PODE DECIDIR O CAMINHO. A função usa o `conntrack` do
# servidor quando é root e o programa existe — e, rodada como root numa máquina
# que o tem, ela leria (e LIMPARIA) a tabela de conexões de verdade de quem está
# testando. Por isso `id -u` é dublado em TODOS os casos (1000 por padrão; só o
# 3l pede 0), e há um `conntrack` no PATH que é o do mundo de mentira.
cat > "$WORK/bin/id" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && { echo "${DUBLE_UID:-1000}"; exit 0; }
exit 1
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/sleep" "$WORK/bin/id" "$WORK/conntrack-do-mundo"
ln -sf "$WORK/conntrack-do-mundo" "$WORK/bin/conntrack"
export CONNTRACK_DO_MUNDO="$WORK/conntrack-do-mundo"

# A linha que o worker DE VERDADE escreve, lida da fonte — se ela mudar lá, o
# dublê passa a escrever a nova, e quem reprova é a prova do contrato (bloco 4).
MARCA_NO_WORKER="$(sed -n 's/.*log\.info("\(telefonia: tronco enviado ao Asterisk\)".*/\1/p' "$REPO_ROOT/lib/channels/telefonia/sincronizacao.ts" | head -1)"
[ -n "$MARCA_NO_WORKER" ] || MARCA_NO_WORKER="(a linha do worker sumiu de sincronizacao.ts)"

mundo() {  # mundo <tabela> <registros> [canais]   — zera o mundo e o põe num estado
  rm -rf "$M"; mkdir -p "$M"
  printf 'true sha256:c806ecd5fd3d %s/16 \n' "$AST" > "$M/asterisk"
  printf '%s\n' "$CERTA" > "$M/linha-certa"
  printf '%s\n' "$DESVIADA" > "$M/linha-desviada"
  printf '%s\n' "$DA_OPERADORA" > "$M/linha-da-operadora"
  if [ -n "$1" ]; then printf '%s\n' "$1" > "$M/tabela"; else : > "$M/tabela"; fi
  printf '%s\n' "$2" > "$M/registros"
  printf '%s\n' "${3:-0}" > "$M/canais"
  : > "$M/eventos"; : > "$M/chamadas"; : > "$M/roteiro"
  # Por padrão o worker que reinicia faz o que o de verdade faz.
  cat > "$M/ao-reiniciar" <<HOOK
printf '%s {"level":"info","msg":"%s","tronco":"a"}\n' "\$(date +%s)" "$MARCA_NO_WORKER" >> "\$M/log-do-worker"
sed 's/ Rejected / Registered /; s/ Unregistered / Registered /' "\$M/registros" > "\$M/registros.novo" && mv "\$M/registros.novo" "\$M/registros"
HOOK
  # No log do worker JÁ existe uma linha de envio, de cinco minutos atrás: a de
  # quando ele subiu. É o estado de toda instalação de verdade, e é o que faz do
  # `--since` uma regra e não um enfeite.
  printf '%s {"level":"info","msg":"%s","tronco":"a"}\n' "$(( $(date +%s) - 300 ))" "$MARCA_NO_WORKER" > "$M/log-do-worker"
}

cat > "$WORK/deskcommcrm/.env" <<'ENV'
COMPOSE_PROFILES=telefonia
TELEFONIA_ARI_URL=http://asterisk:8088
ENV
: > "$WORK/deskcommcrm/docker-compose.prod.yml"

SAIDA="$WORK/saida.txt"
RC=0
rodar() {  # rodar <modo> [registrados antes]   → saída em $SAIDA, status em $RC
  ( cd "$WORK/deskcommcrm" && env PATH="$WORK/bin:$PATH" NO_COLOR=1 PROJECT_DIR="$WORK/deskcommcrm" \
      TELEFONIA_PAUSA=0 TELEFONIA_PRAZO_DOS_REGISTROS="${PRAZO:-10}" KIT_COMUM="$KIT_COMUM" DUBLE_UID="${COMO_UID:-1000}" \
      bash -c 'source "$KIT_COMUM"; religar_troncos_sip "$@"' -- "$@" ) > "$SAIDA" 2>&1
  RC=$?
}
# A sequência do que o kit FEZ, sem as perguntas de apoio (os prazos, os canais,
# a rota): o que as provas de ordem comparam são os atos, não cada consulta.
eventos() { cut -d' ' -f1 "$M/eventos" | grep -E '^(EFEMERO|LISTOU|LIMPOU|OCUPOU|REINICIOU|LEU-O-LOG)$' | tr '\n' ' ' | sed 's/ $//'; }
quantos() { local n; n="$(grep -c "^$1" "$M/eventos" 2>/dev/null)" || n=0; printf '%s' "$n"; }
nao_fez() { ! grep -q "^$1" "$M/eventos"; }
disse() { grep -q "$1" "$SAIDA"; }
nao_disse() { ! grep -q "$1" "$SAIDA"; }
antes_de() {  # antes_de <evento A> <evento B>: o 1º A vem antes do 1º B
  local a b
  a="$(grep -n "^$1" "$M/eventos" | head -1 | cut -d: -f1)"; b="$(grep -n "^$2" "$M/eventos" | head -1 | cut -d: -f1)"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

julgar() {  # julgar <linhas> ["<ip>/<bits> …"]  → "<certas> <desviadas> <presas>"
  printf '%s\n' "$1" | env KIT_COMUM="$KIT_COMUM" bash -c 'source "$KIT_COMUM"; veredito_da_porta_sip "$1"' -- "${2:-$AST/16}"
}
da() { [ "$(julgar "$1" "${3:-}")" = "$2" ]; }   # da <linhas> <esperado> ["<ip>/<bits> …"]

# ═════════════════════════════════════════════════════════════════════════════
echo "── 1. O julgamento: que linha é certa, desviada ou presa"
check "a conexão do Asterisk saindo pela 5060 é CERTA" da "$CERTA" "1 0 0"
check "a que sai por outra porta é DESVIADA" da "$DESVIADA" "0 1 0"
check "a do IP antigo, na mesma rede, é PRESA" da "$PRESA" "0 0 1"
check "o estado medido na VPS (antiga na 5060, nova na 60039) dá 1 desviada e 1 presa" da "$PRESA
$DESVIADA" "0 1 1"
# Medido no laboratório: o Asterisk renasceu com o IP da linha que estava CERTA,
# e a sobra era a de um Asterisk antigo desviado. Nada segura a 5060: nada a fazer.
check "sobra de um Asterisk antigo DESVIADO (outro IP, outra porta) não é presa" da "$CERTA
$(linha "$VELHO" 46535)" "1 0 0"
check "a linha da OPERADORA (de fora da rede do compose) não é nossa: não conta" da "$DA_OPERADORA" "0 0 0"
check "tabela vazia é 0 0 0" da "" "0 0 0"
check "porta de origem que não é a 5060 não conta" da "$(printf '%s' "$CERTA" | sed 's/sport=5060 dport=5060 src/sport=40000 dport=5060 src/')" "0 0 0"
check "protocolo que não é UDP não conta" da "$(printf '%s' "$PRESA" | sed 's/^udp      17/tcp      6/')" "0 0 0"
# A porta de fora é o ÚLTIMO dport. Um [UNREPLIED] no meio não pode deslocar a leitura.
check "linha sem resposta ainda ([UNREPLIED]) é lida igual" da "udp      17 29 src=${AST} dst=${OP} sport=5060 dport=5060 [UNREPLIED] src=${OP} dst=${PUB} sport=5060 dport=16045 mark=0 use=1" "0 1 0"
# A rede é a do contêiner, com o tamanho que o Docker informou — não um /16 fixo.
check "rede /20: o IP vizinho fora dela NÃO é presa" da "$(linha 192.168.16.9 5060)" "0 0 0" "192.168.0.6/20"
check "rede /20: o IP dentro dela é presa" da "$(linha 192.168.15.9 5060)" "0 0 1" "192.168.0.6/20"
check "rede /24: 172.19.1.x não é presa de 172.19.0.6/24" da "$(linha 172.19.1.2 5060)" "0 0 0" "172.19.0.6/24"
# Duas redes na lista (não deu para saber por qual o Asterisk sai): o IP dele em
# QUALQUER uma é dele, e presa vale para as duas.
DUAS="172.21.0.5/16 ${AST}/16"
check "duas redes: a conexão que sai pelo IP da SEGUNDA é do Asterisk (desviada)" da "$DESVIADA" "0 1 0" "$DUAS"
check "duas redes: presa na segunda rede é vista" da "$PRESA" "0 0 1" "$DUAS"
check "duas redes: presa na primeira rede também" da "$(linha 172.21.0.9 5060)" "0 0 1" "$DUAS"
check "rede malformada não vira 'tudo é presa'" da "$PRESA" "0 0 0" "lixo"
check "o IP de outro projeto Docker (172.18) não é presa do nosso (172.19)" da "$(linha 172.18.0.2 5060)" "0 0 0"
check "operadora em outra porta (5080): a desviada continua sendo vista" da "$(printf '%s' "$DESVIADA" | sed 's/dport=5060 src/dport=5080 src/')" "0 1 0"

# ═════════════════════════════════════════════════════════════════════════════
echo "── 2. A leitura do Asterisk, com a saída real do 20.11"
ler() {  # ler <função> — com o mundo já montado
  ( cd "$WORK/deskcommcrm" && env PATH="$WORK/bin:$PATH" NO_COLOR=1 PROJECT_DIR="$WORK/deskcommcrm" KIT_COMUM="$KIT_COMUM" \
      bash -c 'source "$KIT_COMUM"; "$@"' -- "$@" ) 2>/dev/null
}
mundo "$CERTA" "$(registros "$(registro tronco-a Registered)" "$(registro tronco-b Rejected)" "$(registro tronco-c Unregistered)")"
check "lista nome e estado de cada número" test "$(ler registros_sip deskcommcrm-asterisk-1 | tr '\n' ',')" = "tronco-a Registered,tronco-b Rejected,tronco-c Unregistered,"
check "conta só os Registered (Unregistered NÃO casa por ser parecido)" test "$(ler troncos_registrados_agora .env)" = "1"
# O nome de PRODUÇÃO é `tronco-<uuid>`: 43 caracteres, estoura a primeira coluna
# e o Asterisk corta a URI. Linha copiada do Asterisk 20.11 do laboratório.
LINHA_UUID=' tronco-0f3a9c1d-5e7b-4a2c-9d10-3b6f8e2a7c41/sip:172.20  tronco-0f3a9c1d-5e7b-4a2c-9d10-3b6f8e2a7c41  Registered        (exp. 276s)'
mundo "$CERTA" "$(registros "$LINHA_UUID" "$(registro tronco-b Rejected)")"
check "nome de produção (tronco-<uuid>, URI cortada): nome inteiro e estado certos" test "$(ler registros_sip deskcommcrm-asterisk-1 | head -1)" = "tronco-0f3a9c1d-5e7b-4a2c-9d10-3b6f8e2a7c41 Registered"
check "toda pergunta ao Asterisk leva o prazo de DENTRO do contêiner" test "$(quantos PRAZO-DE-DENTRO)" -ge 1 -a "$(quantos SEM-PRAZO-DE-DENTRO)" -eq 0
mundo "$CERTA" "$SEM_REGISTROS"
check "'No objects found.' é zero número, não um número chamado No" test -z "$(ler registros_sip deskcommcrm-asterisk-1)"
check "  e zero registrados" test "$(ler troncos_registrados_agora .env)" = "0"
mundo "$CERTA" "$(registros "$(registro tronco-a Registered)")" 2
check "lê os canais ativos" test "$(ler canais_do_asterisk deskcommcrm-asterisk-1)" = "2"
: > "$M/asterisk-mudo"
check "Asterisk que não responde: 'não sei' (status != 0), não 'nenhum'" bash -c "! ( cd '$WORK/deskcommcrm' && env PATH='$WORK/bin':\"\$PATH\" MUNDO='$M' bash -c 'source \"$KIT_COMUM\"; registros_sip deskcommcrm-asterisk-1' >/dev/null 2>&1 )"
check "  e o update.sh fica sem régua (vazio), não com zero" test -z "$(ler troncos_registrados_agora .env)"

# ═════════════════════════════════════════════════════════════════════════════
UM="$(registros "$(registro tronco-a Registered)")"
UM_RECUSADO="$(registros "$(registro tronco-a Rejected)")"
UM_RECUSADO_AQUI_NAO_IMPORTA="$UM_RECUSADO"   # casos em que o estado do número não pode decidir nada

echo "── 3a. Tudo certo: a função não toca em nada"
mundo "$CERTA" "$UM"
rodar atualizacao 1
check "sai 0" test "$RC" -eq 0
check "diz que a porta não ficou presa, e quantos números estão registrados" disse "não ficou presa — 1 de 1"
check "NÃO limpou a tabela" nao_fez LIMPOU
check "NÃO mandou o Asterisk falar" nao_fez OCUPOU
check "NÃO reiniciou o worker" nao_fez REINICIOU
check "só leu: uma listagem da tabela, e mais nada nela" test "$(quantos EFEMERO)-$(quantos LISTOU)" = "1-1"
# Sem saber quantos estavam registrados antes (ou sabendo que era nenhum), não há
# o que esperar: uma linha e segue.
mundo "$CERTA" "$UM_RECUSADO_AQUI_NAO_IMPORTA"
rodar atualizacao ""
check "sem régua de antes: uma linha, sai 0, não espera" test "$RC" -eq 0 -a "$(grep -c . "$SAIDA")" -eq 1
check "  e a linha é 'nada a corrigir'" disse "nada a corrigir"
mundo "$CERTA" "$UM_RECUSADO_AQUI_NAO_IMPORTA"
rodar atualizacao 0
check "com ZERO registrados antes: idem, não espera número nenhum" test "$RC" -eq 0 -a "$(quantos LISTOU)" -eq 1

echo "── 3a2. Porta certa, mas o Asterisk novo ainda não falou: espera os números, sem reiniciar"
# 'Não ficou presa' lido UMA vez, antes de o worker enviar os números, ainda não
# é 'os números voltaram'. Aqui o worker — que subiu com a atualização — envia na
# 3ª listagem.
mundo "" "$SEM_REGISTROS"
{ echo ":"; echo ":"; echo "cat \"\$M/registros-depois\" > \"\$M/registros\"; cat \"\$M/linha-certa\" >> \"\$M/tabela\""; } > "$M/roteiro"
printf '%s\n' "$UM" > "$M/registros-depois"
rodar atualizacao 1
check "não declara nada na primeira leitura (tabela vazia não é 'voltou')" test "$(quantos LISTOU)" -ge 3
check "espera, e diz quantos voltaram" disse "não ficou presa — 1 de 1"
check "sem limpar e sem reiniciar o worker" test "$(quantos LIMPOU)-$(quantos REINICIOU)" = "0-0"
check "sai 0" test "$RC" -eq 0
# E se o Asterisk novo sair DESVIADO durante a espera (a corrida do cabeçalho), conserta.
mundo "" "$SEM_REGISTROS"
{ echo "cat \"\$M/registros-depois\" > \"\$M/registros\""; echo "cat \"\$M/linha-desviada\" >> \"\$M/tabela\""; } > "$M/roteiro"
printf '%s\n' "$UM_RECUSADO" > "$M/registros-depois"
rodar atualizacao 1
check "desviado no meio da espera: limpa, ocupa e reenvia" test "$(quantos LIMPOU)-$(quantos OCUPOU)-$(quantos REINICIOU)" = "1-1-1"
check "  e termina recuperado" test "$RC" -eq 0
# Os números não voltam e a porta está certa: avisa, NÃO reinicia (não é a porta).
mundo "$CERTA" "$UM_RECUSADO"
PRAZO=0 rodar atualizacao 1
check "números que não voltam com a porta certa: avisa e sai 1" test "$RC" -eq 1 -a "$(grep -c 'é a operadora ou a senha' "$SAIDA")" -eq 1
check "  sem reiniciar o worker — na atualização, quem reenvia é o worker que acabou de subir" nao_fez REINICIOU

echo "── 3b. O defeito da VPS: antiga presa + nova desviada, registro recusado"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
rodar atualizacao 1
check "sai 0" test "$RC" -eq 0
check "limpou a tabela" test "$(quantos LIMPOU)" -eq 1
check "  só UDP e só a porta de origem 5060" grep -qx 'LIMPOU -D -p udp --orig-port-src 5060' "$M/eventos"
check "mandou o Asterisk falar com a operadora pelo nome do tronco" grep -qx 'OCUPOU tronco-a' "$M/eventos"
check "  logo depois da limpeza, sem nada no meio" test "$(eventos | sed 's/.*LIMPOU //' | cut -d' ' -f1)" = "OCUPOU"
check "reiniciou o worker, uma vez" test "$(quantos REINICIOU)" -eq 1
check "  o worker DESTE projeto" grep -qx 'REINICIOU deskcommcrm-worker-1' "$M/eventos"
check "  e só DEPOIS de conferir a porta de novo" test "$(eventos | sed 's/.*OCUPOU //' | cut -d' ' -f1-3)" = "EFEMERO LISTOU REINICIOU"
check "diz que recuperou, com a contagem" disse "porta 5060 recuperada — 1 de 1"
check "em uma rodada só" test "$(quantos LIMPOU)" -eq 1
check "nunca usou 'pjsip send register' (registra pela porta errada e mascara)" bash -c "! grep -q 'send register' '$M/chamadas'"

echo "── 3c. A corrida: a operadora disputa a 5060 (medido: sem OCUPAR, ela ganha)"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
: > "$M/disputa"
rodar atualizacao 1
check "sai 0 mesmo com a operadora disputando" test "$RC" -eq 0
check "resolveu na PRIMEIRA limpeza (o Asterisk falou antes dela)" test "$(quantos LIMPOU)" -eq 1
check "um reinício do worker, não um por tentativa" test "$(quantos REINICIOU)" -eq 1
check "a tabela termina com o Asterisk na 5060" da "$(cat "$M/tabela")" "1 0 0"

echo "── 3d. Só a linha antiga existe (o worker ainda não enviou os números): previne, sem reiniciar"
mundo "$PRESA" "$SEM_REGISTROS"
# Na 3ª listagem o worker — que acabou de subir com a atualização — empurra o tronco.
{ echo ":"; echo ":"; echo "printf '%s\n' \"\$(cat \"\$M/registros-depois\")\" > \"\$M/registros\"; cat \"\$M/linha-certa\" >> \"\$M/tabela\""; } > "$M/roteiro"
printf '%s\n' "$UM" > "$M/registros-depois"
rodar atualizacao 1
check "sai 0" test "$RC" -eq 0
check "limpou a linha presa" test "$(quantos LIMPOU)" -eq 1
check "NÃO reiniciou o worker (ele ainda ia enviar)" nao_fez REINICIOU
check "esperou os números aparecerem e disse que recuperou" disse "porta 5060 recuperada — 1 de 1"
check "a mensagem fala da linha ANTIGA, não de porta desviada" disse "ficou presa ao Asterisk anterior"

echo "── 3e. Ligação em curso: conserta a porta, NÃO reinicia o worker, e não diz que voltou"
mundo "$PRESA
$DESVIADA" "$UM" 2      # 'Registered' pela porta errada: a operadora do laboratório aceita qualquer porta
rodar atualizacao 1
check "limpou e ocupou a porta" test "$(quantos LIMPOU)-$(quantos OCUPOU)" = "1-1"
check "NÃO reiniciou o worker" nao_fez REINICIOU
check "diz por quê" disse "Há ligação em curso (2 canal"
check "NÃO declara que voltou — o 'Registered' da lista é o da porta errada" nao_disse "✓"
check "sai 1 (não ficou bom)" test "$RC" -eq 1
check "ensina o passo que falta, com o --reenviar" disse "religar-telefonia.sh --reenviar"

echo "── 3e2. O Asterisk não responde se há ligação: a guarda falha FECHADA"
# 'Não respondeu' não é 'não há ligação': um Asterisk no teto de memória, com
# gente na linha, é justamente o que demora. Sem saber, não reinicia.
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO" 4
: > "$M/canais-mudos"
rodar atualizacao 1
check "perguntou três vezes antes de desistir" test "$(quantos PERGUNTOU-OS-CANAIS)" -eq 3
check "NÃO reiniciou o worker" nao_fez REINICIOU
check "diz que não soube, em vez de dizer que não há ligação" disse "não respondeu se há ligação"
check "consertou a porta mesmo assim" test "$(quantos LIMPOU)-$(quantos OCUPOU)" = "1-1"
check "não declara que voltou, e sai 1" test "$RC" -eq 1 -a "$(grep -c '✓' "$SAIDA")" -eq 0

echo "── 3f. 'Registrado' não basta: sem o worker reenviar DEPOIS do reinício, não é 'voltou'"
mundo "$PRESA
$DESVIADA" "$UM"         # de novo 'Registered' pela porta errada
: > "$M/ao-reiniciar"    # o worker reinicia mas NÃO sobe (nenhuma linha NOVA no log)
check "fixture: o log do worker já tem uma linha de envio, de ANTES do reinício" grep -q "$MARCA_NO_WORKER" "$M/log-do-worker"
PRAZO=0 rodar atualizacao 1
check "reiniciou o worker" test "$(quantos REINICIOU)" -eq 1
check "foi ao log do worker conferir" test "$(quantos LEU-O-LOG)" -ge 1
check "  perguntando só pelo que veio depois do reinício" grep -qE '^logs --since [0-9]{9,} deskcommcrm-worker-1$' "$M/chamadas"
check "NÃO declara que voltou (a linha velha do log não prova nada)" nao_disse "✓"
check "diz que não viu o worker reenviar" disse "não o vi"
check "sai 1" test "$RC" -eq 1
# O controle: com o worker reenviando, o MESMO estado é sucesso.
mundo "$PRESA
$DESVIADA" "$UM"
rodar atualizacao 1
check "controle: com a linha do worker no log, o mesmo estado é sucesso" test "$RC" -eq 0

echo "── 3g. A régua de 'voltaram' é o que estava registrado ANTES"
TRES="$(registros "$(registro tronco-a Rejected)" "$(registro tronco-b Rejected)" "$(registro tronco-c Rejected)")"
mundo "$PRESA
$DESVIADA" "$TRES"
# Dois voltam; o terceiro já era recusado antes (senha errada), e continua.
cat > "$M/ao-reiniciar" <<HOOK
printf '%s {"msg":"%s"}\n' "\$(date +%s)" "$MARCA_NO_WORKER" >> "\$M/log-do-worker"
sed '/tronco-a/s/ Rejected / Registered /; /tronco-b/s/ Rejected / Registered /' "\$M/registros" > "\$M/r" && mv "\$M/r" "\$M/registros"
HOOK
rodar atualizacao 2
check "2 de 3, com 2 registrados antes: sucesso" test "$RC" -eq 0
check "  e diz a conta" disse "2 de 3"
check "  e que o terceiro já estava fora" disse "já não estava"
mundo "$PRESA
$DESVIADA" "$TRES"
cat > "$M/ao-reiniciar" <<HOOK
printf '%s {"msg":"%s"}\n' "\$(date +%s)" "$MARCA_NO_WORKER" >> "\$M/log-do-worker"
sed '/tronco-a/s/ Rejected / Registered /; /tronco-b/s/ Rejected / Registered /' "\$M/registros" > "\$M/r" && mv "\$M/r" "\$M/registros"
HOOK
PRAZO=0 rodar atualizacao 3
check "2 de 3, com 3 registrados antes: NÃO é sucesso" test "$RC" -eq 1
check "  e manda olhar a operadora ou a senha, não a porta" disse "é a operadora ou a senha"
check "  dizendo quantos eram antes" disse "Antes da atualização eram 3"
# ZERO sabido não é "não sei": o número que já era recusado antes (senha errada)
# não custa um minuto de espera e um aviso amarelo a cada atualização.
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
cat > "$M/ao-reiniciar" <<HOOK
printf '%s {"msg":"%s"}\n' "\$(date +%s)" "$MARCA_NO_WORKER" >> "\$M/log-do-worker"
HOOK
rodar atualizacao 0
check "0 registrados antes, 0 de 1 depois: a porta foi recuperada e isso é sucesso" test "$RC" -eq 0
check "  dizendo a conta, e que o número já estava fora" test "$(grep -c '0 de 1' "$SAIDA")-$(grep -c 'já não estava' "$SAIDA")" = "1-1"
# MAIS registrados antes do que o Asterisk tem agora: falta o worker enviar algum.
DOIS="$(registros "$(registro tronco-a Registered)" "$(registro tronco-b Registered)")"
mundo "$PRESA
$DESVIADA" "$DOIS"
PRAZO=0 rodar atualizacao 3
check "3 registrados antes e só 2 números no Asterisk: NÃO é '2 de 2, tudo certo'" test "$RC" -eq 1 -a "$(grep -c '✓' "$SAIDA")" -eq 0
check "  e diz que o worker não enviou todos" disse "só recebeu 2 número"

echo "── 3h. Não deu para ler a tabela: 'não sei' não vira 'está certo'"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
: > "$M/imagem-sem-conntrack"
rodar atualizacao 1
check "sai 1" test "$RC" -eq 1
check "NÃO diz que está certo" nao_disse "✓"
check "diz que não conseguiu ler" disse "não consegui ler a tabela"
check "ensina o comando manual, com o worker deste projeto" disse "docker restart deskcommcrm-worker-1"
check "não limpou nem reiniciou nada às cegas" test "$(quantos LIMPOU)-$(quantos REINICIOU)" = "0-0"

echo "── 3i. A porta nunca volta: desiste, não reinicia nada e mostra como achar o intruso"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
# Alguma outra coisa no servidor devolve a linha desviada a cada listagem.
for _ in 1 2 3 4 5 6 7 8; do echo "cat \"\$M/linha-desviada\" > \"\$M/tabela\"; rm -f \"\$M/aberta\""; done > "$M/roteiro"
rodar atualizacao 1
check "sai 1" test "$RC" -eq 1
check "tentou 5 vezes, e parou" test "$(quantos LIMPOU)" -eq 5
check "NÃO reiniciou o worker com a porta ainda errada" nao_fez REINICIOU
check "mostra como listar quem está na 5060" disse "grep 'port=5060'"

echo "── 3j. Telefonia desligada, ou Asterisk fora do ar: nada"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
printf 'COMPOSE_PROFILES=\n' > "$WORK/deskcommcrm/.env"
rodar atualizacao 1
check "desligada: sai 0, calada" test "$RC" -eq 0 -a ! -s "$SAIDA"
check "desligada: nenhuma chamada ao Docker" test ! -s "$M/chamadas"
printf 'COMPOSE_PROFILES=telefonia\nTELEFONIA_ARI_URL=http://asterisk:8088\n' > "$WORK/deskcommcrm/.env"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
printf 'false sha256:c806ecd5fd3d \n' > "$M/asterisk"
rodar atualizacao 1
check "Asterisk parado: avisa" disse "o Asterisk não está no ar"
check "Asterisk parado: não mexe na tabela nem no worker" test "$(quantos LIMPOU)-$(quantos REINICIOU)" = "0-0"
: > "$M/asterisk"
rodar atualizacao 1
check "Asterisk inexistente: idem" test "$(quantos LIMPOU)-$(quantos REINICIOU)" = "0-0"

echo "── 3k. À mão (religar-telefonia.sh): cobra os números, e o --reenviar reenvia sempre"
mundo "$CERTA" "$UM"
rodar manual
check "tudo certo: sai 0 sem reiniciar" test "$RC" -eq 0 -a "$(quantos REINICIOU)" -eq 0
check "  e diz 'constam', porque não refez nada" disse "constam como registrados"
mundo "$CERTA" "$UM_RECUSADO"
rodar manual
check "porta certa e número recusado: reenvia uma vez" test "$(quantos REINICIOU)" -eq 1
check "  e termina bem quando o número volta" test "$RC" -eq 0
check "  sem ter mexido na tabela, que estava certa" nao_fez LIMPOU
# Telefonia ligada e nenhum número cadastrado: quem só veio conferir não tem o
# worker reiniciado, nem espera um minuto, nem sai com erro.
mundo "" "$SEM_REGISTROS"
rodar manual
check "sem número nenhum: NÃO reinicia o worker" nao_fez REINICIOU
check "  diz que não há número, e sai 0 na hora" test "$RC" -eq 0 -a "$(grep -c 'não tem número nenhum' "$SAIDA")" -eq 1 -a "$(quantos LISTOU)" -eq 1
# Mas "o Asterisk não respondeu" não é "não tem número": aí não é esse o desfecho.
mundo "" "$SEM_REGISTROS"
: > "$M/asterisk-mudo"
PRAZO=0 rodar manual
check "Asterisk mudo NÃO vira 'não tem número nenhum'" nao_disse "não tem número nenhum"
check "  nem reinicia o worker sem saber se há ligação" nao_fez REINICIOU
mundo "$CERTA" "$UM"
rodar reenviar
check "--reenviar: reinicia mesmo com tudo 'registrado'" test "$(quantos REINICIOU)" -eq 1
check "  e só declara depois de ver o worker reenviar" disse "números reenviados"
mundo "$CERTA" "$UM" 3
rodar reenviar
check "--reenviar com ligação em curso: NÃO reinicia" nao_fez REINICIOU
check "  e NÃO diz que reenviou" nao_disse "✓"
check "  sai 1" test "$RC" -eq 1
mundo "$CERTA" "$UM_RECUSADO"
: > "$M/restart-falha"
rodar manual
check "reinício que falha: diz, ensina o comando e sai 1" test "$RC" -eq 1 -a "$(grep -c 'docker restart deskcommcrm-worker-1' "$SAIDA")" -ge 1

echo "── 3l. Servidor que já tem o conntrack: usa o dele, sem contêiner efêmero"
# O programa existe no PATH em todos os casos; o que muda aqui é ser root.
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
COMO_UID=0 rodar atualizacao 1
check "root + programa no servidor: consertou" test "$RC" -eq 0
check "  sem subir contêiner nenhum para o conntrack" nao_fez EFEMERO
check "  e limpou pela mesma regra (só UDP, porta de origem 5060)" grep -qx 'LIMPOU -D -p udp --orig-port-src 5060' "$M/eventos"
# Quem não é root não lê a tabela pelo programa do servidor: cai no contêiner.
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
rodar atualizacao 1
check "sem ser root: usa o contêiner efêmero, com a imagem do próprio Asterisk" grep -qx 'EFEMERO sha256:c806ecd5fd3d' "$M/eventos"
check "  na rede do host e com NET_ADMIN" grep -q '^run --rm --network host --cap-add NET_ADMIN --entrypoint conntrack sha256:c806ecd5fd3d -L' "$M/chamadas"
# A terceira combinação — root SEM o programa no servidor — não é provada aqui de
# propósito: tirar o dublê do PATH deixaria a função achar o `conntrack` de
# verdade de quem roda o teste. Ela é o estado da VPS de laboratório (root, sem
# conntrack-tools), onde o conserto inteiro foi medido pelo contêiner efêmero.

echo "── 3m. O nome do tronco entra numa linha de comando: só passa o que tem cara de nome"
mundo "$PRESA
$DESVIADA" "$(registros "$(registro 'tronco-a;reload' Rejected)" "$(registro tronco-b Rejected)")"
rodar atualizacao 2
check "o nome estranho NÃO vira comando no Asterisk" bash -c "! grep -q 'reload' '$M/eventos'"
check "o nome bom continua sendo usado" grep -qx 'OCUPOU tronco-b' "$M/eventos"

echo "── 3o. Outro programa VIVO fala pela 5060 na rede do Asterisk: uma limpeza, não cinco"
# A rede do proxy pode ser compartilhada com outras stacks. Linha de Asterisk
# antigo não volta depois de apagada; a que VOLTA é de um vizinho vivo.
VIVO="udp      17 118 src=172.19.0.9 dst=192.0.2.77 sport=5060 dport=5060 src=192.0.2.77 dst=${PUB} sport=5060 dport=5060 [ASSURED] mark=0 use=1"
mundo "$CERTA
$VIVO" "$UM"
printf '%s\n' "$VIVO" > "$M/linha-do-vizinho"
for _ in 1 2 3 4 5 6 7 8; do echo "grep -q 'src=172.19.0.9' \"\$M/tabela\" || cat \"\$M/linha-do-vizinho\" >> \"\$M/tabela\""; done > "$M/roteiro"
rodar atualizacao 1
check "limpou UMA vez (na primeira não dá para distinguir de uma linha antiga)" test "$(quantos LIMPOU)" -eq 1
check "não ficou limpando a tabela do vizinho a cada volta" test "$(quantos LISTOU)" -le 3
check "não reiniciou o worker (o Asterisk nunca saiu desviado)" nao_fez REINICIOU
check "sai 0" test "$RC" -eq 0

echo "── 3p. O prazo de fora: onde há timeout, todo comando do Docker passa por ele"
cat > "$WORK/bin/timeout" <<'STUB'
#!/usr/bin/env bash
printf 'PRAZO-DE-FORA %s %s\n' "$1" "$2" >> "$MUNDO/eventos"
shift; exec "$@"
STUB
chmod +x "$WORK/bin/timeout"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
rodar atualizacao 1
check "com timeout no servidor a função segue funcionando" test "$RC" -eq 0
check "o docker inspect, o exec, o run, o restart e o logs passaram pelo prazo" \
  test "$(grep -c '^PRAZO-DE-FORA [0-9][0-9]* docker$' "$M/eventos")" -ge 5
check "nenhum docker foi chamado por fora dele" \
  test "$(grep -c '^PRAZO-DE-FORA' "$M/eventos")" -eq "$(grep -c . "$M/chamadas")"
rm -f "$WORK/bin/timeout"

echo "── 3n. Asterisk em DUAS redes (o override do Traefik: internal + a do proxy)"
# É a topologia da VPS onde o defeito foi medido. O `docker inspect` lista as
# duas; a conexão SIP sai por UMA. Aqui a de saída é a SEGUNDA da lista.
duas_redes() { printf 'true sha256:c806ecd5fd3d 172.21.0.5/16 %s/16 \n' "$AST" > "$M/asterisk"; printf '%s' "$AST" > "$M/saida-por"; }
VIZINHO="$(linha 172.21.0.9 5060)"   # outro programa de telefonia, de OUTRA stack, na rede compartilhada do proxy
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
duas_redes
rodar atualizacao 1
check "perguntou ao contêiner por onde ele sai" test "$(quantos PERGUNTOU-A-ROTA)" -eq 1
check "viu o defeito (não respondeu 'nada a corrigir' olhando a rede errada)" nao_disse "nada a corrigir"
check "e consertou" test "$RC" -eq 0 -a "$(quantos LIMPOU)" -eq 1 -a "$(quantos REINICIOU)" -eq 1
mundo "$CERTA
$VIZINHO" "$UM"
duas_redes
rodar atualizacao 1
check "o vizinho da rede do proxy NÃO é uma linha presa nossa: a porta não ficou presa" disse "não ficou presa"
check "  e a tabela dele fica intocada" nao_fez LIMPOU
# Sem conseguir perguntar a rota: vale o IP dele em qualquer das redes.
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
duas_redes; : > "$M/sem-ip-route"
rodar atualizacao 1
check "sem a resposta da rota: ainda vê o defeito e conserta" test "$RC" -eq 0 -a "$(quantos LIMPOU)" -eq 1
# Uma rede só (instalação com Caddy): nem pergunta.
mundo "$CERTA" "$UM"
rodar atualizacao 1
check "com uma rede só não há o que perguntar" nao_fez PERGUNTOU-A-ROTA

# ═════════════════════════════════════════════════════════════════════════════
echo "── 4. O encaixe: update.sh, imagem e o contrato com o worker"
n_de() { grep -n "$1" "$UPDATE_SH" | head -1 | cut -d: -f1; }   # a linha da 1ª ocorrência
L_ANTES="$(n_de '^TRONCOS_ANTES=')"; L_UP="$(n_de '^dc up -d$')"
L_FIX="$(n_de '^  religar_troncos_sip atualizacao ')"; L_SAUDE="$(n_de 'wait_app_healthy 20 3')"
check "o update.sh guarda os registrados ANTES do up -d" test -n "$L_ANTES" -a -n "$L_UP" -a "${L_ANTES:-9}" -lt "${L_UP:-0}"
check "confere a telefonia DEPOIS do up -d" test -n "$L_FIX" -a "${L_UP:-9}" -lt "${L_FIX:-0}"
check "  e ANTES da conferência de saúde do app (o rollback não volta o Asterisk)" test -n "$L_SAUDE" -a "${L_FIX:-9}" -lt "${L_SAUDE:-0}"
check "  passando o que estava registrado antes" grep -q '^  religar_troncos_sip atualizacao "\$TRONCOS_ANTES" || true$' "$UPDATE_SH"
check "  e só com a telefonia ligada" test "$(sed -n "$(( ${L_FIX:-2} - 2 ))p" "$UPDATE_SH")" = "if telefonia_ligada .env; then"
check "a imagem do Asterisk traz o conntrack" grep -qE '^RUN apk add --no-cache .*\bconntrack-tools\b' "$REPO_ROOT/Dockerfile.asterisk"
check "o script manual existe e chama a mesma função" grep -q '^religar_troncos_sip "\$MODO"$' "$REPO_ROOT/hostgator-setup-kit/religar-telefonia.sh"
# O contrato de texto: o kit procura no log do worker a linha que o worker escreve.
MARCA_NO_KIT="$(sed -n 's/^MARCA_DE_TRONCO_ENVIADO="\(.*\)"$/\1/p' "$KIT_COMUM" | head -1)"
check "o kit sabe que linha procurar no log do worker" test -n "$MARCA_NO_KIT"
check "  e o worker escreve exatamente essa linha (sincronizacao.ts)" grep -qF "$MARCA_NO_KIT\"" "$REPO_ROOT/lib/channels/telefonia/sincronizacao.ts"
check "  ao reconectar o worker reenvia TUDO (laco.ts: sincronizar(true))" grep -q 'sync.sincronizar(true)' "$REPO_ROOT/lib/channels/telefonia/laco.ts"
check "o Asterisk continua SEM porta SIP publicada (só a faixa de áudio)" bash -c "! grep -nE '^\s*- .*5060' '$REPO_ROOT/docker-compose.prod.yml'"
# O passo OCUPAR usa o nome do REGISTRO como nome do ENDPOINT. Vale porque os
# quatro objetos de um tronco nascem com o mesmo `id` — se um dia deixarem de
# nascer, o `pjsip qualify` passa a falar com ninguém, em silêncio.
PJSIP="$REPO_ROOT/lib/channels/telefonia/pjsip.ts"
mesmo_id() { awk -v t="$1" '/^export function objetosDoTronco/ { dentro = 1 } dentro && index($0, "tipo: \"" t "\"") { getline; gsub(/[ \t]/, ""); print; exit }' "$PJSIP"; }
check "em pjsip.ts, o registro e o endpoint do tronco levam o mesmo id" test "$(mesmo_id endpoint)" = "id," -a "$(mesmo_id registration)" = "id,"
check "  e o tronco tem qualify (é o OPTIONS que o passo OCUPAR dispara)" grep -q 'f("qualify_frequency", 25)' "$PJSIP"

# ═════════════════════════════════════════════════════════════════════════════
echo "── 5. O script religar-telefonia.sh, executado de verdade"
SCRIPT="$REPO_ROOT/hostgator-setup-kit/religar-telefonia.sh"
KIT_DA_FIXTURE="$WORK/deskcommcrm/hostgator-setup-kit"
mkdir -p "$KIT_DA_FIXTURE"
cp "$SCRIPT" "$KIT_DA_FIXTURE/"; cp "$KIT_COMUM" "$KIT_DA_FIXTURE/_common.sh"
script() {  # script [argumentos]  → saída em $SAIDA, status em $RC
  ( cd "$WORK/deskcommcrm" && env PATH="$WORK/bin:$PATH" NO_COLOR=1 TELEFONIA_PAUSA=0 \
      TELEFONIA_PRAZO_DOS_REGISTROS="${PRAZO:-10}" DUBLE_UID=1000 DESKCOMM_ASSUMIR_PROJETO=1 \
      bash hostgator-setup-kit/religar-telefonia.sh "$@" ) > "$SAIDA" 2>&1 < /dev/null
  RC=$?
}
mundo "$CERTA" "$UM"
script
check "sem argumento, tudo certo: confere e sai 0 sem reiniciar" test "$RC" -eq 0 -a "$(quantos REINICIOU)" -eq 0
check "  com o cabeçalho do passo e a linha de resultado" test "$(grep -c 'Conferindo a telefonia' "$SAIDA")-$(grep -c 'constam como registrados' "$SAIDA")" = "1-1"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
script
check "com o defeito: conserta e sai 0" test "$RC" -eq 0 -a "$(quantos LIMPOU)" -eq 1 -a "$(quantos REINICIOU)" -eq 1
mundo "$CERTA" "$UM"
script --reenviar
check "--reenviar: reinicia o worker" test "$RC" -eq 0 -a "$(quantos REINICIOU)" -eq 1
mundo "$CERTA" "$UM" 2
script --reenviar
check "--reenviar com ligação em curso: sai 1 sem reiniciar" test "$RC" -eq 1 -a "$(quantos REINICIOU)" -eq 0
mundo "$CERTA" "$UM"
script --apagar-tudo
check "argumento desconhecido: uso, sai 1 e não chama o Docker" test "$RC" -eq 1 -a "$(grep -c 'Uso: ' "$SAIDA")" -eq 1 -a ! -s "$M/chamadas"
script --reenviar outra-coisa
check "argumento a mais: uso, sai 1 (não é ignorado calado)" test "$RC" -eq 1 -a "$(grep -c 'Uso: ' "$SAIDA")" -eq 1
script --help
check "--help: explica e sai 0" test "$RC" -eq 0 -a "$(grep -c -- '--reenviar' "$SAIDA")" -ge 1
printf 'COMPOSE_PROFILES=\n' > "$WORK/deskcommcrm/.env"
mundo "$PRESA
$DESVIADA" "$UM_RECUSADO"
script
check "telefonia desligada: diz, sai 0 e não toca em nada" test "$RC" -eq 0 -a "$(grep -c 'não está ligada' "$SAIDA")" -eq 1 -a "$(quantos LIMPOU)-$(quantos REINICIOU)" = "0-0"
printf 'COMPOSE_PROFILES=telefonia\nTELEFONIA_ARI_URL=http://asterisk:8088\n' > "$WORK/deskcommcrm/.env"

if [ "$FAILS" -ne 0 ]; then
  printf '\nFALHOU — %s prova(s) vermelha(s).\n' "$FAILS" >&2
  exit 1
fi
echo "OK — todas as provas passaram."
