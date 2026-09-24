---
impacto: capacidade_nova
secao: adicionado
titulo: Inbox mostra quem espera resposta, quem está na fila do time e separa Todas por chips de time
---

- **Todas** deixou de agrupar a lista por time. Os times viram chips com o total logo
  abaixo dos filtros, e um clique filtra. O chip de um time com gente esperando mostra
  "N na fila", e passar o mouse diz por quê: nenhum atendente disponível, todos no limite
  ou time fora do horário.
- **Na fila · <time>**: novo selo no card da conversa que foi transferida para um time e
  que ninguém pegou. O chip **Só na fila** lista só essas conversas. Transferir para um
  time passa a tirar a IA da conversa, que entra na fila do time.
- **Termômetro de espera**: quando o cliente fala e ninguém responde, o card fica amarelo
  aos 2 min, laranja aos 5 e vermelho pulsando aos 10. A contagem começa na **primeira**
  mensagem sem resposta. Os tempos se ajustam em Configurações › Distribuição de
  atendimento. O chip **Mais tempo esperando** (em Todas e em Minhas) ordena a lista por
  quem espera há mais tempo.
- No filtro de número aparece o número inteiro ao lado do nome, para distinguir dois
  números oficiais com o mesmo nome.

A migration 0279 é aplicada sozinha pelo `update.sh`.
