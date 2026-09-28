---
impacto: capacidade_nova
secao: adicionado
titulo: Prefixo de discagem por número de telefone, e a ligação que a operadora recusa aparece para o atendente
---

Cada número em **Conexões › Telefone** ganha o campo **Prefixo de discagem (opcional)**: os
dígitos que a operadora pede antes do DDD nas ligações de saída — um `0`, ou `0` + código da
operadora (como `015`). Há operadora que só completa a ligação com ele: na medida que motivou
esta mudança, a mesma chamada para um celular foi recusada sem o `0` e tocou com ele. Vazio, o
CRM disca como antes (DDD + número). O prefixo aparece no cartão do número, e mudá-lo não pede
a senha da conta de novo. Se as ligações de saída de um número estão falhando, pergunte à
operadora qual prefixo ela usa e preencha o campo.

Quando a ligação que o atendente faz acaba sem ninguém atender, a tela passa a dizer por quê,
no mesmo canto do painel da ligação: "A operadora não completou a ligação. Confira o número e
o prefixo de discagem do número SIP.", "O número chamado está ocupado." ou "Ninguém atendeu."
Antes, a recusa da operadora fazia o painel sumir sem explicação e a conversa registrava
"sem resposta"; agora registra "Ligação não completada".

A atualização acrescenta a coluna do prefixo ao banco sozinha; nenhum número muda de
comportamento até alguém preencher o campo.
