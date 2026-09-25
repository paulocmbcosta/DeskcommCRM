---
impacto: capacidade_nova
secao: adicionado
titulo: Gerentes e administradores podem desbloquear pela tela um contato bloqueado por opt-out
---

Quando o sistema entende que o cliente pediu para não receber mensagens, o contato fica
**bloqueado** e o Inbox mostra o selo "Cliente pediu para não receber mensagens". Até aqui
não havia como desfazer isso pela tela. Agora quem é **gerente ou administrador** tem o
botão **Desbloquear** na ficha do contato, e no Inbox o próprio selo abre o desbloqueio.

A confirmação explica que o cliente **pode ter pedido para sair de verdade** e pede duas
coisas: o **motivo**, e a marcação de que a conversa foi conferida. Quem desbloqueou e o
motivo ficam na auditoria (`contact.unblocked`). O que foi cancelado enquanto o contato
estava bloqueado não é reenviado. Se ele pedir para sair de novo, o bloqueio volta sozinho.
Atendentes continuam vendo o selo, mas sem o botão.
