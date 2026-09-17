---
impacto: nada_mudou
secao: corrigido
titulo: Uma agenda com fuso escrito errado não derruba mais a lista de atendentes
---

O horário de atendimento de cada pessoa é gravado com o fuso, e o fuso escrito
com acento — `America/Asunción`, como um hispanofalante escreve natural — era
aceito na hora de salvar e recusado na hora de ler. O resultado aparecia longe da
tela que o causou: a lista de quem pode assumir uma conversa voltava vazia para a
organização inteira, e o atendimento automático prometia retorno "sem prazo" ao
cliente mesmo com a equipe toda online — por causa da agenda de UMA pessoa.

Agora a agenda que o sistema não consegue ler fecha apenas aquele atendente, que
fica fora do rodízio até corrigir o horário dele; todos os demais continuam
recebendo conversa normalmente.
