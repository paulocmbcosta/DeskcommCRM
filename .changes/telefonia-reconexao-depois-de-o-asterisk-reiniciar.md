---
impacto: nada_mudou
secao: corrigido
titulo: O telefone volta sozinho depois que o servidor de telefonia reinicia
---

Quando o servidor de telefonia (Asterisk) reiniciava sozinho — por uma falha, ou porque só ele
foi recriado —, o telefone do CRM ficava mudo: nenhuma ligação tocava, o número deixava de
registrar na operadora, e nada avisava. Só voltava quando alguém reiniciava o serviço `worker`.

Isso acontecia porque o CRM tentava reconectar um segundo depois da queda, encontrava o servidor
ainda subindo, e essa tentativa que não dava certo nunca terminava — então não havia a seguinte.
Agora toda tentativa tem saída: a que falha é descartada na hora, a que não responde em 10
segundos também, e o CRM tenta de novo até conseguir (em intervalos de até 30 segundos). Quando
conecta, os números voltam a registrar sozinhos.

Pelo mesmo motivo, com o telefone nesse estado o `worker` não conseguia desligar numa
atualização: ficava esperando a tentativa que nunca terminava, até ser interrompido à força.
Essa espera acabou.

Enquanto o servidor de telefonia estiver fora, o log do `worker` passa a mostrar uma linha
"conexão com o Asterisk caiu — reconectando" a cada tentativa: é o sinal de que ele segue
tentando. Você não precisa fazer nada na atualização.
