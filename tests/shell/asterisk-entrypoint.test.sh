#!/usr/bin/env bash
# Gate do docker/asterisk/entrypoint.sh — o IP público que vai CRU para a
# configuração do Asterisk.
#
# O que ele guarda, e por quê:
#
# 1. O IP É UM IPv4, OU O CONTÊINER NÃO SOBE. O entrypoint escreve o IP público
#    em pjsip.conf (external_media_address) e rtp.conf (ice_host_candidates)
#    sem aspas — o formato .conf do Asterisk lê o valor até o fim da linha. O
#    valor vem de fora: do .env (TELEFONIA_IP_PUBLICO) ou, vazio, da resposta
#    do api.ipify.org, que pode voltar página de erro, portal cativo ou
#    qualquer coisa. Uma quebra de linha abria seção nova no arquivo; lixo
#    fazia o áudio sair anunciando um endereço que não existe, com o contêiner
#    "healthy". Revisão de segurança de 2026-09-28.
#
# 2. O CAMINHO BOM CONTINUA BOM. Um entrypoint que recusasse tudo passaria no
#    item 1; aqui se cobra também que o IP válido — do .env e do ipify — chegue
#    ao arquivo.
#
# Roda o script DE VERDADE, fora da imagem, com dublês só do que não existe
# aqui: `asterisk` (o exec final), `chown` (o usuário asterisk é da imagem),
# `hostname -i` (é do busybox) e `curl` (o ipify, sem rede).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/asterisk/entrypoint.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

mkdir -p "$TMP/bin" "$TMP/origem"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/asterisk"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/chown"
printf '#!/bin/sh\necho 172.20.0.5\n' > "$TMP/bin/hostname"
printf '#!/bin/sh\ncat "%s/ipify"\n' "$TMP" > "$TMP/bin/curl"
chmod +x "$TMP/bin/"*
cp docker/asterisk/conf/* "$TMP/origem/"

rodar() { # $1 = TELEFONIA_IP_PUBLICO ("" = vazio → pergunta ao ipify), $2 = resposta do ipify
  rm -rf "$TMP/destino"
  mkdir -p "$TMP/destino"
  printf '%s' "$2" > "$TMP/ipify"
  env TELEFONIA_ARI_PASSWORD='segredo-da-ari' TELEFONIA_IP_PUBLICO="$1" \
    ASTERISK_CONF_DESTINO="$TMP/destino" ASTERISK_CONF_ORIGEM="$TMP/origem" \
    PATH="$TMP/bin:$PATH" sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  echo $?
}

echo "asterisk: IP válido chega ao pjsip.conf e ao rtp.conf"
RC="$(rodar '203.0.113.7' '')"
check "TELEFONIA_IP_PUBLICO válido: sobe" test "$RC" -eq 0
check "pjsip.conf anuncia o IP do .env" grep -qx 'external_media_address=203.0.113.7' "$TMP/destino/pjsip.conf"
check "rtp.conf troca o IP do contêiner pelo público" grep -qx '172.20.0.5 => 203.0.113.7' "$TMP/destino/rtp.conf"
# Os heredocs de configuração não são citados (precisam expandir as variáveis):
# uma crase num comentário deles vira comando. Medido: a versão anterior rodava
# `line` a cada partida e deixava "line: not found" no log do contêiner.
check "sobe sem comando perdido no log (crase em heredoc)" bash -c "! grep -q 'not found' '$TMP/saida'"

RC="$(rodar '' '198.51.100.9')"
check "sem TELEFONIA_IP_PUBLICO, o ipify válido: sobe" test "$RC" -eq 0
check "pjsip.conf anuncia o IP detectado" grep -qx 'external_media_address=198.51.100.9' "$TMP/destino/pjsip.conf"

echo "asterisk: IP inválido não chega a arquivo nenhum"
recusa() { # $1 = nome, $2 = TELEFONIA_IP_PUBLICO, $3 = ipify
  local rc
  rc="$(rodar "$2" "$3")"
  check "$1: recusa" test "$rc" -ne 0
  check "$1: diz que não é um IPv4" grep -q 'não é um IPv4 válido' "$TMP/saida"
  check "$1: nenhum pjsip.conf escrito" test ! -e "$TMP/destino/pjsip.conf"
}
recusa "quebra de linha com seção nova" $'203.0.113.7\n[transport-evil]' ''
recusa "octeto acima de 255" '999.1.1.1' ''
recusa "três octetos" '203.0.113' ''
recusa "cinco octetos" '203.0.113.7.1' ''
recusa "zero à esquerda (octal para inet_aton)" '010.0.113.7' ''
recusa "espaço no fim" '203.0.113.7 ' ''
recusa "nome em vez de IP" 'crm.exemplo.com.br' ''
recusa "ipify devolveu uma página" '' '<html><body>502 Bad Gateway</body></html>'
recusa "ipify devolveu IPv6" '' '2001:db8::1'
check "a mensagem diz de onde veio o valor ruim (a detecção)" grep -q 'api.ipify.org' "$TMP/saida"
check "e não despeja a página inteira no log" test "$(wc -l < "$TMP/saida" | tr -d ' ')" -le 2

if [ "$fail" -ne 0 ]; then
  echo "asterisk-entrypoint: FALHOU" >&2
  exit 1
fi
echo "asterisk-entrypoint: ok"
