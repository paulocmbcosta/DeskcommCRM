---
impacto: nada_mudou
secao: corrigido
titulo: IXC — o Pix pode ser enviado mesmo quando o IXC ainda não o gerou para a fatura
---

Na aba **IXC**, a opção **Pix** ficava desligada em toda fatura para a qual o IXC ainda
não tinha gerado o Pix — o que é o caso normal de fatura a vencer. Num cadastro com
quatro faturas abertas e nenhum Pix gerado, o atendente não conseguia enviar Pix de
nenhuma.

O IXC gera o Pix quando alguém pede. Agora escolher **Pix** faz exatamente isso: o CRM
pede o Pix ao IXC na hora, confere o código e o envia com o QR code. O botão avisa quando
o Pix vai ser gerado naquele momento, e a auditoria registra que ele foi gerado por
aquele pedido.

O **Boleto** continua aparecendo só quando o IXC já o registrou — sem registro não há
PDF para baixar.

Quando o IXC recusa (carteira sem Pix, usuário do token sem permissão), a frase que ele
devolve passa a aparecer para o atendente, em vez de uma mensagem genérica.
