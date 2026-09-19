---
impacto: nada_mudou
secao: corrigido
titulo: O `update.sh` para de responder "nada a atualizar" com o CRM ainda na versão anterior
---

Quando o código do servidor já estava na versão nova mas o CRM seguia rodando a
anterior — o que acontece se uma atualização é interrompida no meio, ou se alguém
faz o `git checkout` da versão à mão antes —, o `update.sh` respondia "Você já
está na versão mais recente. Nada a atualizar." e saía sem mexer em nada. A
única saída era forçar com `--to <versão> --force`.

O motivo: a conferência comparava a imagem que o servidor está configurado para
rodar com ela mesma. Isso só detecta atraso em quem segue um canal (`latest`); com
a versão fixada em número, que é como toda instalação fica hoje, a resposta era
sempre "em dia".

Agora o script confere as três imagens do `.env` (app, worker e scheduler) contra
a versão do código e atualiza quando qualquer uma ficou para trás, dizendo qual.
Também deixa de dar por "em dia" um servidor que voltou para a versão anterior
depois de uma atualização que falhou. Quem segue um canal de propósito continua
exatamente como estava.

Nada a fazer para receber a correção: a atualização normal — pela tela ou com
`bash hostgator-setup-kit/update.sh`, sem `git checkout` antes — funciona como
sempre.
