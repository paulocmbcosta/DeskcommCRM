---
impacto: capacidade_nova
secao: adicionado
titulo: Mais de um número da API Oficial (Meta) por organização
---

Em Conexões › API Oficial (Meta), o botão "Adicionar outro número" conecta um
segundo número (ou mais), cada um com a sua caixa de entrada e a sua URL de
webhook. Antes, conectar outro número substituía o que já estava conectado.

O número que pertence a outro app da Meta aceita a chave secreta desse app,
conferida com a Meta antes de ser gravada. Os modelos passam a ser separados por
conta do WhatsApp Business: cada número só oferece e só envia os modelos da sua
conta. A migration 0275 é aplicada sozinha pelo `update.sh`.
