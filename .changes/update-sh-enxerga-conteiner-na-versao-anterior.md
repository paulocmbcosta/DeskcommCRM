---
impacto: nada_mudou
secao: corrigido
titulo: O `update.sh` passa a olhar o que está RODANDO, e não só o que está configurado
---

Se uma atualização era interrompida bem no fim — queda de conexão, falta de
memória, ou um Ctrl-C —, dava para ficar num estado em que o servidor já tinha
baixado a versão nova e anotado que era para usá-la, mas os programas no ar
continuavam sendo os da versão anterior. Rodar a atualização de novo não
resolvia: o script conferia o código e a configuração, achava os dois em dia, e
respondia "Você já está na versão mais recente. Nada a atualizar."

Era a mesma cegueira corrigida na versão passada, por outro caminho. As duas
conferências olhavam para arquivos — o que o servidor está configurado para
rodar e o que ele baixou —, e nenhuma das duas perguntava o que de fato está no
ar. O CRM seguia na versão antiga sem nada na tela dizendo isso.

Agora o script também confere os três programas em execução (o app, o worker e o
agendador) contra a versão do código, e sobe o que ficou para trás, dizendo qual.
Quem parou o servidor de propósito não é incomodado, e quem acompanha um canal
em vez de uma versão fixa continua exatamente como estava.

Nada a fazer para receber a correção: a atualização normal — pela tela ou com
`bash hostgator-setup-kit/update.sh` — funciona como sempre.
