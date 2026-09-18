---
impacto: capacidade_nova
secao: adicionado
titulo: Cliente que volta depois de encerrado começa um atendimento do zero, e a aba Fechadas passa a listar atendimentos
---

**Quando o cliente volta, o atendimento novo começa do zero.** Encerrar um
atendimento passa a ser a devolução completa: se o mesmo cliente escrever de
novo, o protocolo novo nasce **sem o time e sem o responsável do anterior**, com
a IA religada e passando pela triagem outra vez. Antes, quem tinha falado com o
Financeiro e voltava pedindo suporte caía direto na fila do Financeiro, com a IA
muda. O botão **Reabrir** não muda: ele continua o mesmo atendimento, com o
mesmo protocolo e o mesmo time.

**A aba Fechadas lista atendimentos, não conversas.** Tudo o que foi encerrado
aparece ali — inclusive de quem já voltou e está sendo atendido de novo, com a
marca **o cliente voltou**. Cada linha mostra o protocolo, quem encerrou, o time
que encerrou e o canal; clicar abre aquele atendimento, só com as mensagens
dele. A busca da aba acha pelo número do protocolo e pelo nome do cliente, e o
número no ícone da aba conta a mesma coisa que a lista mostra.

**Corrigido junto:** com um filtro de etiqueta ligado, os números das abas do
inbox sumiam. Voltaram.

Nada a fazer na atualização: a mudança entra sozinha pelo `update.sh`.
