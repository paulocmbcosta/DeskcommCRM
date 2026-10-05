---
impacto: nada_mudou
secao: corrigido
titulo: Atualização — o sistema não trava mais enquanto o banco é atualizado
---

Atualizar o CRM com gente sendo atendida podia deixar o sistema inteiro sem responder, com a
tela "Algo deu errado", até alguém entrar no servidor e parar a IA à mão. Aconteceu numa
instalação real: 16 minutos fora do ar numa segunda-feira de manhã.

O que acontecia: no passo "Atualizando o banco de dados", um comando da atualização esperava
uma tabela que a IA estava usando para enviar uma resposta — e a IA, por sua vez, esperava um
registro que só conseguiria gravar depois que esse comando passasse. Um esperava o outro, o
banco não percebia, e todo o resto do sistema entrava na fila atrás dos dois.

Foram três consertos:

- **A IA parou de segurar as tabelas enquanto envia.** Ela lê o que precisa e solta, em vez de
  manter tudo preso até a mensagem sair. É a causa do problema, e vale para qualquer mudança no
  banco, não só para a atualização.
- **A atualização do banco não espera mais para sempre.** Se uma tabela está em uso, o comando
  desiste em 3 segundos e a atualização tenta de novo, sozinha. Se depois de três tentativas
  ainda houver algo no caminho, ela **pausa a IA**, termina o banco e a IA volta junto com a
  versão nova — nesse intervalo o sistema segue no ar, mas a IA não responde e o telefone não
  atende, e isso aparece escrito no registro da atualização. Se nem assim o banco der a vez, a
  atualização **para antes de trocar o sistema**: a versão de antes continua no ar, nada se
  perde, e é só atualizar de novo mais tarde.
- **A IA devolve o que estava fazendo quando é parada.** Antes, uma conversa que estava sendo
  respondida no momento da parada ficava até 10 minutos esquecida, e o cliente esperava. Agora
  ela volta para a fila e é retomada assim que a IA sobe de novo.

Nada a fazer na atualização. Um cuidado, **só desta vez**: quem executa a atualização para esta
versão ainda é o atualizador antigo, sem as proteções acima — então prefira fazê-la fora do
horário de atendimento. Da atualização seguinte em diante, as três valem.
