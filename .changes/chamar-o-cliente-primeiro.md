---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para chamar o cliente primeiro no WhatsApp — com modelo aprovado e os campos preenchidos na tela
---

Agora dá para **começar a conversa** com um cliente que nunca escreveu — o que
você acabou de cadastrar, ou o que veio da importação do IXC. O botão aparece na
lista de **Contatos**, no cadastro do contato e no dossiê do negócio, sempre com
o mesmo nome: **Chamar no WhatsApp**.

O diálogo pergunta por qual número enviar (quando há mais de um) e
**diz o que aquele canal permite antes de você escrever**:

- no WhatsApp comum, você escreve a mensagem à mão;
- no WhatsApp oficial (e no canal por parceiro), o WhatsApp só deixa falar
  primeiro com um **modelo aprovado** — então a tela mostra os modelos
  aprovados daquele número, com **um campo para cada informação pedida**
  (o nome do cliente, o valor, o link) e o texto final do jeito que o cliente
  vai receber. O botão de enviar só libera quando não falta nada.

Depois de enviar, a conversa abre no Inbox como qualquer outra. Quando o cliente
responde, a janela de 24 horas abre e a conversa fica livre.

**O que isso conserta.** Modelo com informação variável — que é a maioria, já
que quase todo modelo de abertura traz o nome do cliente — **não era enviável.**
Quem tentava pelo aviso de janela fechada, no Inbox, era
mandado para *Conexões → Templates*, que só lista e mostra os modelos: não envia.
Na prática, começar conversa pelo WhatsApp oficial não era possível pelo produto.
Esse aviso no Inbox agora traz os mesmos campos e resolve ali mesmo.

Dois consertos silenciosos vêm junto:

- **Quem atende voltou a enxergar os modelos.** A lista do canal oficial só era
  liberada para administrador; um atendente recebia "Nenhum modelo aprovado
  ainda" mesmo com a conta cheia deles.
- **Aviso de quantos campos o modelo pede** também no canal por parceiro, onde
  essa informação nunca chegava à tela.

Se o envio não completar (modelo recusado pela plataforma, canal sem credencial),
**a conversa não se perde**: ela abre assim mesmo, o motivo real aparece na tela,
e você tenta de novo de dentro dela.

Para quem automatiza: a ferramenta `crm_start_conversation_and_send` passa a
aceitar `type: "template"` com os valores dos campos — antes ela só servia ao
canal que não exige modelo, que é justamente o que não precisa dela.

Nada muda para quem já usa o WhatsApp comum, e nada precisa ser configurado:
quem tem modelos aprovados os vê na hora; quem não tem continua escrevendo
normalmente.
