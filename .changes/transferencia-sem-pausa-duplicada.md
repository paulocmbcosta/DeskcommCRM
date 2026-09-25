---
impacto: nada_mudou
secao: corrigido
titulo: Transferir uma conversa para um time não aparece mais duas vezes na linha do tempo
---

Desde a 1.42.0, transferir para um time também tira a IA da conversa, e a linha do tempo
registrava o mesmo gesto duas vezes: "Transferida para a fila do time" e "Atendimento
automático pausado". Agora fica só a transferência. A migration 0282 é aplicada sozinha
pelo `update.sh`.
