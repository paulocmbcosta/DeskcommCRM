---
impacto: nada_mudou
secao: corrigido
titulo: "Cancelar a assinatura" não bloqueia mais o cliente como se ele tivesse pedido para parar de receber mensagens
---

A detecção de "parar de receber mensagens" tratava **"cancelar a assinatura"** (e o
espanhol **"cancelar la suscripción"**) como pedido de descadastro. Num provedor, num
SaaS ou num streaming, a assinatura é o **plano** do cliente. Um cliente sem internet,
reclamando e ameaçando cancelar, era bloqueado, e a IA parava de atendê-lo. Agora essas
frases só bloqueiam quando falam da comunicação, como em "cancelar a assinatura das
mensagens" ou "…da newsletter". "Sair da lista", "descadastrar", "parar de receber" e
"cancelar a inscrição" continuam bloqueando como antes.
