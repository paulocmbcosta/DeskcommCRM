---
impacto: nada_mudou
secao: corrigido
titulo: Atualização — as versões antigas deixam de encher o disco do servidor
---

Cada atualização baixava a versão nova do CRM e deixava a anterior guardada no servidor, para
sempre. São cerca de 3 GB por versão, e como o sistema pode se atualizar sozinho pela tela, o
disco ia enchendo sem ninguém perceber — num servidor de 100 GB, em poucas semanas de uso ele
passava de 80%. Disco cheio derruba o CRM inteiro.

Agora, depois que a versão nova sobe e responde que está saudável, a atualização apaga as
versões antigas do CRM que ficaram no servidor. Ficam duas: a que está no ar e, de reserva, a
que estava no ar antes dela. Nada que não seja do CRM é tocado, e o que estiver em uso não é
apagado. Se a limpeza não conseguir rodar, a atualização termina normalmente do mesmo jeito.

Nada a fazer na atualização. A limpeza passa a acontecer **a partir da atualização seguinte**:
quem executa a atualização para esta versão ainda é o atualizador antigo, que não sabe apagar.
O que foi feito aparece no fim do registro da atualização, em "Liberando espaço em disco".
