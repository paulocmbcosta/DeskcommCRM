---
impacto: nada_mudou
secao: corrigido
titulo: Telefone — a atualização não deixa mais os números sem registro
---

Depois de uma atualização com a telefonia ligada, os números costumavam ficar em "registro
recusado" em Conexões › Telefone e as ligações paravam de chegar — foi assim nas cinco últimas em
que alguém conferiu. Não voltava sozinho: só quando alguém rodava dois comandos no servidor. A causa é a porta do telefone (SIP 5060): o Asterisk novo
nasce com outro endereço dentro do servidor, a porta fica presa ao anterior, o novo sai por outra
e a operadora recusa.

Agora o `update.sh` confere isso logo depois de subir a versão nova e conserta sozinho. Ele mede
antes de agir: se a porta está certa, não mexe em nada. Se houver ligação em curso, conserta a
porta mas não reinicia o serviço que reenvia os números, e avisa o que falta. A saída da
atualização diz o que encontrou e quantos números voltaram a registrar.

Para o mesmo conserto à mão — depois de recriar o Asterisk com um `docker compose up -d`, por
exemplo — há um comando novo:

```bash
bash hostgator-setup-kit/religar-telefonia.sh
```

**Nesta atualização o conserto ainda não roda sozinho**: quem executa é o `update.sh` da versão
que você já tinha. Se os números ficarem em "registro recusado" depois dela, rode o comando acima
uma vez. Da atualização seguinte em diante, é automático.

Quem não usa a telefonia não muda nada.
