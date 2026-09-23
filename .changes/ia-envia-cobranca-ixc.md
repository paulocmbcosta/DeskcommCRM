---
impacto: capacidade_nova
secao: adicionado
titulo: A IA identifica o cliente no sistema de gestão e envia a cobrança (Pix ou boleto)
---

Com o IXC ligado em **Configurações › Conectores**, o agente de IA ganha duas capacidades novas
no editor do agente: **Consultar o cliente no sistema de gestão** e
**Enviar a cobrança do cliente (Pix ou boleto)**. A segunda é crítica: ligar o pacote
"Atender e responder" não a liga sozinha — é preciso marcá-la, uma a uma, no modo avançado.

A IA reconhece o cliente pelo telefone do WhatsApp quando ele bate com um único cadastro. Se o
número estiver em mais de um cadastro, ela pede o CPF; se não estiver em nenhum, pede CPF e data
de nascimento — e nunca diz qual dos dois não conferiu. Depois de três tentativas no mesmo
atendimento, ela para de pedir e passa a conversa para a equipe. Quando o CPF informado
contradiz o cadastro do telefone (número reciclado pela operadora, por exemplo), o telefone
deixa de valer como prova.

A cobrança é sempre de UMA fatura: a mais atrasada; sem atrasada, a próxima a vencer. Sai em
duas mensagens — o QR code do Pix (ou o PDF do boleto) e o código para copiar. O padrão é Pix; o
boleto sai quando o cliente pede. Fatura com mais dias de atraso que o limite —
**60 por padrão, ajustável na ficha do IXC** — não é enviada: a IA avisa que ela foi encaminhada
ao setor de cobrança e transfere a conversa.

No chat do site, o painel do IXC não vincula mais o contato sozinho pelo telefone que o visitante
digitou: ele mostra os cadastros para o atendente escolher. O telefone só prova quem é a pessoa
no canal em que ele é o próprio endereço, como o WhatsApp.

Para usar: ligue as duas capacidades numa versão nova do agente, ajuste o prompt para falar de
cobrança e publique. Sem conector ligado, nada disso aparece na tela.
