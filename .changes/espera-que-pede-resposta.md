---
impacto: capacidade_nova
secao: adicionado
titulo: O termômetro de espera não conta mais o "ok, obrigado" do cliente
---

O termômetro do card (as cores de 2, 5 e 10 minutos, configuráveis em Configurações ›
Distribuição de atendimento) contava toda mensagem do cliente sem resposta — inclusive "ok,
tudo bem, obrigado" depois de o atendente dizer que retornaria. Agora a Assistente lê as
últimas mensagens e, quando o cliente só confirma, agradece ou se despede, deixa de contar a
espera: o card mostra o selo "Não pede resposta" e o chat explica o porquê numa faixa acima da
conversa. Na dúvida, a espera continua contando. Se o cliente escrever de novo, a contagem
volta a partir da mensagem nova.

Quem discorda clica em "Contar mesmo assim" (qualquer `agent` ou acima), e a espera volta desde
a primeira mensagem sem resposta. Ninguém consegue desligar a contagem na mão pela tela. Cada
religada fica registrada na linha do tempo da conversa e na auditoria.

Funciona com uma chave da OpenRouter (em IA › Credenciais ou na instalação), pelo Jev — o mesmo
modelo que já decide se uma conversa vira card. Sem a chave, a espera continua sendo contada
como antes, sem dispensa nenhuma. Nada precisa ser configurado; o banco recebe três colunas
novas, uma função nova (`fn_dispensar_espera`) e duas reescritas (o trigger
`fn_conversations_espera_desde` e `fn_mark_conversation_message`) por `update.sh`.
