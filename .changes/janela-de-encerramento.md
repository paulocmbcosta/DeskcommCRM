---
impacto: capacidade_nova
secao: adicionado
titulo: Encerrar o atendimento registra o assunto e um resumo, com números por assunto em Métricas
---

Encerrar uma conversa era um aviso do navegador ("Fechar esta conversa?") e o atendimento fechava
sem dizer do que tratou. Agora o botão **Fechar** (e o atalho `E`) abre uma janela que pede o
**setor do assunto**, o **assunto** e um **resumo** do que foi tratado.

- **Assuntos por time.** Em **Configurações › Times**, cada time ganha a sua lista de assuntos de
  encerramento ("Segunda via de boleto", "Wi-Fi"…). Quem cadastra é gerente ou administrador.
  Arquivar tira o assunto da janela sem apagar o que já foi registrado com ele.
- **Você decide o que é obrigatório.** Em **Configurações › Atendimento**, dois interruptores:
  "Exigir o assunto" e "Exigir o resumo" (mínimo de 10 letras). **Os dois chegam desligados**: depois
  de atualizar, a janela aparece e ninguém é bloqueado até você cadastrar os assuntos e ligar.
- **Atendimento sem time.** Quem atende escolhe o setor na própria janela. Escolher o setor ali não
  transfere a conversa — só diz de que assunto se tratou.
- **Onde aparece.** Na ficha do atendimento, em "Atendimentos anteriores" do cliente, no card da aba
  Fechadas e na linha do tempo ("Encerrada por Fulano. Assunto: Suporte › Wi-Fi").
- **Números.** Em **Métricas**, o painel "Assuntos dos atendimentos encerrados" (gerente e
  administrador): por período e por setor, quantos atendimentos de cada assunto, quantos ficaram sem
  assunto e quantos foram atendidos por um time diferente do setor do assunto.

"Reabrir" continua o mesmo atendimento, e fechá-lo de novo traz a janela já preenchida. O resumo é
apagado quando o contato é anonimizado (LGPD) e entra na exportação de dados do titular.

Quem encerra conversas por integração (`POST /conversations/{id}/close` ou `PATCH` com
`status: "closed"`) pode mandar `assunto_id` e `resumo`; se a organização ligar os interruptores, a
integração passa a receber `422` quando eles faltarem. Os encerramentos anteriores a esta versão
ficam sem assunto.
