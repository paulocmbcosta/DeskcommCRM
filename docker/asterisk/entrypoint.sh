#!/bin/sh
# Entrypoint do deskcomm-asterisk: escreve a configuração a partir do .env e
# entrega o PID 1 ao Asterisk.
#
# Só o que é da INSTALAÇÃO mora aqui (transportes, faixa de RTP, IP público,
# senha da ARI). O que é de cada ORGANIZAÇÃO — números, senhas das operadoras,
# ramais — nunca toca este disco: o worker empurra pela ARI para a memória do
# Asterisk, e sincroniza de novo sempre que ele reinicia (spec 20 §4.1).
set -eu

if [ -z "${TELEFONIA_ARI_PASSWORD:-}" ]; then
  echo "asterisk: TELEFONIA_ARI_PASSWORD vazio — sem ele o CRM não comanda a telefonia." >&2
  echo "asterisk: rode o update.sh (ele gera o segredo) e suba de novo." >&2
  exit 1
fi

# IPv4 em quatro octetos decimais de 0 a 255, e nada além disso. O IP público
# vai CRU para o pjsip.conf e o rtp.conf (external_media_address,
# ice_host_candidates): uma quebra de linha no valor abriria seção nova no
# arquivo, e o valor vem de fora — do .env ou, sem ele, da resposta de um
# serviço na internet (ipify), que pode voltar uma página de erro, um proxy
# cativo ou qualquer coisa. Zero à esquerda é recusado: `010` é 8 para quem lê
# com inet_aton.
ipv4_valido() {
  case "$1" in
    "" | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  _ifs_antigo="$IFS"
  IFS=.
  # shellcheck disable=SC2086 # a divisão pelos pontos é o propósito
  set -- $1
  IFS="$_ifs_antigo"
  [ "$#" -eq 4 ] || return 1
  for _octeto in "$@"; do
    case "$_octeto" in
      0) ;;
      0*) return 1 ;;
    esac
    [ "${#_octeto}" -le 3 ] || return 1
    [ "$_octeto" -le 255 ] || return 1
  done
  return 0
}

RTP_INICIO="${TELEFONIA_RTP_INICIO:-20000}"
RTP_FIM="${TELEFONIA_RTP_FIM:-20039}"
IP_PUBLICO="${TELEFONIA_IP_PUBLICO:-}"
ORIGEM_DO_IP="TELEFONIA_IP_PUBLICO"
if [ -z "$IP_PUBLICO" ]; then
  # Fallback: o kit grava o IP no .env; sem ele, pergunta a quem vê de fora.
  IP_PUBLICO="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  ORIGEM_DO_IP="a detecção automática (api.ipify.org)"
fi
if [ -z "$IP_PUBLICO" ]; then
  echo "asterisk: não sei o IP público desta máquina (TELEFONIA_IP_PUBLICO vazio e sem internet)." >&2
  echo "asterisk: sem ele o áudio não volta. Defina TELEFONIA_IP_PUBLICO no .env." >&2
  exit 1
fi
if ! ipv4_valido "$IP_PUBLICO"; then
  # Só o começo do valor, numa linha: pode ser uma página HTML inteira.
  AMOSTRA="$(printf '%s' "$IP_PUBLICO" | tr -c '[:alnum:].:-' '?' | cut -c1-40)"
  echo "asterisk: o IP público vindo de ${ORIGEM_DO_IP} não é um IPv4 válido: \"${AMOSTRA}\"." >&2
  echo "asterisk: defina TELEFONIA_IP_PUBLICO no .env com o IPv4 público desta máquina (ex.: 203.0.113.10) e suba de novo." >&2
  exit 1
fi
IP_CONTEINER="$(hostname -i | awk '{print $1}')"

# Os dois caminhos só mudam no teste (tests/shell/asterisk-entrypoint.test.sh),
# que roda este script fora da imagem; no contêiner valem os padrões.
DEST="${ASTERISK_CONF_DESTINO:-/etc/asterisk}"
cp "${ASTERISK_CONF_ORIGEM:-/usr/share/deskcomm-asterisk/conf}"/* "$DEST"/

# Senha da ARI entre aspas não existe no formato .conf do Asterisk: o valor vai
# cru até o fim da linha. Recusar quebra de linha evita injetar seção nova.
case "$TELEFONIA_ARI_PASSWORD" in
  *"
"*) echo "asterisk: TELEFONIA_ARI_PASSWORD tem quebra de linha" >&2; exit 1 ;;
esac

cat > "$DEST/ari.conf" <<ARI
[general]
enabled=yes
pretty=no
allowed_origins=
[crm]
type=user
read_only=no
password=${TELEFONIA_ARI_PASSWORD}
ARI

# AMI: só para LER o estado do registro de cada tronco (a ARI não expõe se a
# operadora aceitou a senha). Rede interna, mesma senha da ARI, sem permissão
# de originar nada.
cat > "$DEST/manager.conf" <<AMI
[general]
enabled=yes
port=5038
bindaddr=0.0.0.0
[crm]
secret=${TELEFONIA_ARI_PASSWORD}
read=system,reporting
write=system,reporting
AMI

cat > "$DEST/rtp.conf" <<RTP
[general]
rtpstart=${RTP_INICIO}
rtpend=${RTP_FIM}
; O navegador recebe o IP público no lugar do IP do contêiner. As portas são
; as mesmas: o compose publica a faixa inteira com host = contêiner.
[ice_host_candidates]
${IP_CONTEINER} => ${IP_PUBLICO}
RTP

cat > "$DEST/pjsip.conf" <<PJSIP
[global]
type=global
user_agent=SIP
; Nenhum endpoint anônimo: INVITE que não casa com tronco nem ramal é recusada.
; A ligação recebida casa com o tronco pelo parâmetro "line" do Contact que o
; próprio registro anunciou (registration line=yes) — é o que separa dois
; números da mesma operadora, que chegam do MESMO IP. E SÓ por ele: o endpoint
; do tronco tem identify_by=ip sem objeto identify (lib/channels/telefonia/
; pjsip.ts), porque com o padrão identify_by=username,ip uma INVITE forjada com
; From: tronco-<id> casava o tronco pelo nome e era atendida sem senha (medido
; em 2026-09-28 num Asterisk 20).
; Sem crase neste bloco: o heredoc não é citado, e uma crase aqui vira
; substituição de comando (a versão anterior rodava "line" a cada partida).

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
external_media_address=${IP_PUBLICO}
external_signaling_address=${IP_PUBLICO}
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=192.168.0.0/16

[transport-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:5060
external_media_address=${IP_PUBLICO}
external_signaling_address=${IP_PUBLICO}
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=192.168.0.0/16

; Ramais do navegador: WSS termina no Caddy, que entrega WS aqui.
[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0
external_media_address=${IP_PUBLICO}
PJSIP

echo "asterisk: IP público ${IP_PUBLICO}, RTP ${RTP_INICIO}-${RTP_FIM}, contêiner ${IP_CONTEINER}"
chown -R asterisk:asterisk "$DEST"
exec asterisk -f -U asterisk -G asterisk
