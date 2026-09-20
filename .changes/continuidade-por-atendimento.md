---
impacto: nada_mudou
secao: corrigido
titulo: O resumo de "Devolver ao automático" considera só o atendimento em curso
---

Quando uma pessoa clica em **Devolver ao automático**, o sistema monta um resumo
do que a equipe fez — as notas internas, o que foi decidido nos chamados e o que
ficou pendente com o cliente — para o agente retomar sem pedir tudo de novo.

Esse resumo era montado com a **conversa inteira**. Como a conversa é uma só por
cliente e canal, ele misturava atendimentos diferentes: o cliente que falou com o
Financeiro na segunda ("enviei a 2ª via do boleto", "pedir o comprovante de
pagamento") e voltou na quarta com a internet caída tinha, no resumo da devolução
do Suporte, a nota do boleto como coisa combinada **neste** atendimento — e o
comprovante como a próxima coisa a cobrar dele.

Agora o resumo segue a mesma regra que a tela já seguia para mensagens e notas
internas: **o atendimento novo começa do zero**. Entram só as notas escritas e os
chamados abertos no atendimento em curso. Se nele ninguém da equipe registrou
nada, a devolução não inventa um resumo com assunto encerrado.

O histórico não se perde: os atendimentos anteriores continuam inteiros em
**Atendimentos anteriores**, no painel da conversa, e cada chamado continua com a
linha do tempo completa.

Para quem automatiza: o campo `human_continuity` de `crm_get_human_case` e de
`crm_resume_ai_attendance` passa a trazer só o atendimento em curso. O detalhe do
chamado pedido continua vindo completo, seja de que atendimento for.

Nada a configurar.
