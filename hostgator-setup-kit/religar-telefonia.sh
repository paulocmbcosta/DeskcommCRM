#!/usr/bin/env bash
# Religa os números de telefone (troncos SIP) na operadora.
#
#   bash hostgator-setup-kit/religar-telefonia.sh
#   bash hostgator-setup-kit/religar-telefonia.sh --reenviar
#
# Para quando Conexões › Telefone mostra "registro recusado" ou "sem resposta da
# operadora" logo depois de recriar o Asterisk — uma atualização, um
# `docker compose up -d` à mão, um reinício do Docker. A causa quase sempre é a
# porta 5060 presa ao contêiner anterior na tabela de conexões do servidor; o
# mecanismo inteiro está no cabeçalho de `religar_troncos_sip`, em _common.sh.
#
# O `update.sh` já faz isto sozinho depois de subir a versão nova. Este script é
# a mesma função, para rodar à mão. Pode rodar com o CRM no ar e quantas vezes
# quiser: ele MEDE antes de agir, e com tudo certo não mexe em nada.
#
#   sem argumento → confere a porta e os números; conserta o que estiver errado.
#   --reenviar    → além disso, manda o worker reenviar os números mesmo que
#                   constem como registrados. É o que a mensagem de "não
#                   reiniciei o worker por causa da ligação em curso" pede.
#
# Nunca derruba ligação: com ligação em curso ele conserta a porta, não reinicia
# o worker, e diz o que falta. Sai 0 quando ficou bom, 1 quando não.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$KIT_DIR/_common.sh"
enter_project

MODO=manual
case "${1:-}" in
  "") ;;
  --reenviar) MODO=reenviar ;;
  *) die "Uso: religar-telefonia.sh [--reenviar]" ;;
esac

# A mesma guarda do update.sh: uma segunda cópia do repositório reiniciaria o
# worker da instalação que está no ar com base no .env DELA.
recusar_projeto_de_outra_arvore || die "Interrompido para não mexer na instalação que está no ar."

if ! telefonia_ligada .env; then
  c_ylw "A telefonia não está ligada nesta instalação (COMPOSE_PROFILES sem 'telefonia'). Nada a fazer."
  exit 0
fi

step "Conferindo a telefonia"
religar_troncos_sip "$MODO"
