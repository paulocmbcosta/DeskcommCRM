---
impacto: capacidade_nova
secao: adicionado
titulo: Filtros do Inbox por atendente, caixa de entrada, período e assunto — e que não somem ao recarregar
---

O Inbox mostrava as conversas de todos os atendentes misturadas, e nas
finalizadas não havia como separar as de uma pessoa. Agora o funil de filtros
tem quatro seletores a mais, que valem junto com os que já existiam (time,
etiqueta, não lidos, busca):

- **Atendente** — em Todas e em Fechadas: "Eu", "Sem atendente" ou um colega
  pelo nome. Em Fechadas há também o botão **Só as minhas**, ao lado do título.
  Ali, "do atendente" quer dizer quem estava com a conversa quando ela foi
  encerrada — e não quem clicou em encerrar.
- **Caixa de entrada** — no lugar de "Todos os números": o meio inteiro
  (WhatsApp, Telefone, Chat do site) ou um número. O telefone passa a aparecer.
- **Período** e **Assunto** — só em Fechadas: hoje, ontem, 7 ou 30 dias, ou um
  intervalo de datas; e o assunto escolhido ao encerrar.

O número de cada aba acompanha os filtros ligados, e uma lista que fica vazia
por causa de filtro diz qual filtro está valendo — o time, inclusive, que antes
não era citado.

Os filtros passam a morar no endereço da página: recarregar não os perde, e dá
para mandar a um colega o link de uma lista filtrada por atendente escolhido
pelo nome, por caixa, período ou assunto. O link de "Só as minhas" mostra as de
quem o abre, não as de quem mandou. O texto da busca fica de fora do endereço,
porque é nome ou telefone de cliente.

Quem só enxerga as próprias conversas não vê nomes de colegas no seletor de
atendente. A aba Telefone continua com os filtros dela.

Para quem opera a instalação: a atualização cria um índice no banco
(`atendimentos_org_dono_fechamento`) sozinha; não há nada a configurar.
