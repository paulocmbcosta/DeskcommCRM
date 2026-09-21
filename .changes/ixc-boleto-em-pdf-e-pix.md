---
impacto: capacidade_nova
secao: alterado
titulo: IXC — a fatura vai como boleto em PDF ou como Pix (QR code + copia e cola), à escolha do atendente
---

Na aba **IXC** do atendimento, o botão **Enviar** de uma fatura agora pergunta como enviar:

- **Boleto** — o CRM baixa do IXC o PDF do boleto e o envia como documento na conversa,
  com valor e vencimento na legenda; a linha digitável vai sozinha na mensagem seguinte,
  para o cliente copiar com um toque.
- **Pix** — o CRM busca no IXC o Pix copia e cola da fatura, gera o QR code e o envia
  como imagem; o código copia e cola vai sozinho na mensagem seguinte.

O link do boleto no site do banco, que ia no texto, não é mais enviado.

Antes de sair, a cobrança é conferida: o arquivo tem de ser um PDF de verdade, o código
Pix tem de fechar a conferência (CRC) e o Pix tem de estar ativo no IXC — se não, nada é
enviado e a tela diz por quê. Só aparece a forma que o IXC já gerou para aquela fatura
(parcela futura ainda sem boleto ou Pix registrado não oferece o botão).

Quem usa o conector com token restrito por recurso no IXC precisa liberar também
`get_boleto` e `get_pix` para o usuário do token; sem isso, o envio responde que a
cobrança não está disponível. Quem não usa IXC não vê nada de novo.
