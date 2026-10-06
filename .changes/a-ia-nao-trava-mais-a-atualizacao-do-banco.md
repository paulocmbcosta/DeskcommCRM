---
impacto: nada_mudou
secao: corrigido
titulo: Atualização — a IA deixa de travar o sistema enquanto o banco é atualizado
---

Atualizar o CRM com gente sendo atendida podia deixar o sistema inteiro sem responder, com a
tela "Algo deu errado", até alguém entrar no servidor e parar a IA à mão. Aconteceu numa
instalação real: 16 minutos fora do ar numa segunda-feira de manhã.

O que acontecia: no passo "Atualizando o banco de dados", um comando da atualização esperava
uma tabela que a IA estava usando para enviar uma resposta — e a IA, por sua vez, esperava um
registro que só conseguiria gravar depois que esse comando passasse. Um esperava o outro, o
banco não percebia, e todo o resto do sistema entrava na fila atrás dos dois.

Foram dois consertos:

- **A IA parou de segurar as tabelas enquanto envia.** Ela lê o que precisa e solta, em vez de
  manter tudo preso até a mensagem sair. É a causa do problema, e vale para qualquer mudança no
  banco, não só para a atualização.
- **A IA devolve o que estava fazendo quando é parada.** Antes, uma conversa que estava sendo
  respondida no momento da parada ficava até 10 minutos esquecida, e o cliente esperava. Agora
  ela volta para a fila e é retomada assim que a IA sobe de novo.

O passo de banco da atualização em si não mudou: com muita gente usando o sistema ele continua
deixando tudo mais lento por alguns minutos. O que deixa de acontecer é o travamento.

Nada a fazer na atualização. Um cuidado, **só desta vez**: a atualização para esta versão ainda
roda com a IA antiga no ar — então prefira fazê-la fora do horário de atendimento. Da versão
seguinte em diante, o conserto já está valendo.
