---
impacto: nada_mudou
secao: corrigido
titulo: Ligar a telefonia e rodar a atualização passa a subir o Asterisk, mesmo sem versão nova
---

O caminho para ligar a telefonia — acrescentar `telefonia` a `COMPOSE_PROFILES`,
preencher `TELEFONIA_ARI_URL=http://asterisk:8088` e rodar
`bash hostgator-setup-kit/update.sh` — não funcionava em quem já estava na
versão mais recente. O script respondia "Você já está na versão mais recente.
Nada a atualizar." e o serviço de telefonia nunca subia: ele conferia o app, o
worker e o agendador, e não o Asterisk.

Agora, com a telefonia ligada, a atualização confere também o Asterisk. Se ele
não está rodando a versão instalada — ou se o `.env` ainda não diz qual versão
usar, o que acontecia com quem chegou à versão da telefonia pela atualização
anterior —, o script segue em frente, grava a versão do Asterisk e a senha da
telefonia no `.env` e sobe o serviço, dizendo na tela que é a telefonia. Numa
atualização normal, o Asterisk também passa a subir na versão nova junto com o
resto, em vez de ficar na anterior.

Quem não ligou a telefonia não percebe diferença nenhuma, e quem parou o
servidor de propósito não é incomodado.

Nada a fazer para receber a correção. Até receber, quem ligar a telefonia numa
instalação já em dia usa `bash hostgator-setup-kit/update.sh --force`.
