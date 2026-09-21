# Migrar um agente que já rodava em outra plataforma

Quem chega de outro sistema de agente (outro CRM, outro bot de WhatsApp) já tem o mais valioso:
um prompt que atende, bases escritas, a lista de setores, as regras comerciais que alguém levou meses
para acertar. **Não recomece do zero, e não cole tudo como está.** O trabalho é traduzir: cada campo
de lá vira uma peça daqui, e parte do que estava no prompt de lá é, aqui, portão do motor ou
configuração de tela.

## Antes: ler o que existe, só leitura

Peça à pessoa um export ou acesso **só de leitura** à configuração (o documento que ela manda pode
não ser o do agente — confira antes de usar). O que ler: identidade e objetivo, tom, regras
comerciais, regras de comunicação, fluxos, exemplos de conversa, critérios de sucesso, fora do
escopo, restrições, mensagens prontas (boas-vindas, transferência, fora do horário, encerramento),
gatilhos de transferência, FAQ, bases de conhecimento, ferramentas customizadas, integrações
nativas, setores de transferência, follow-ups. Registre a versão e a data que você leu.

## O mapa: de lá para cá

| Lá | Aqui | Como |
|---|---|---|
| Identidade, objetivo, apresentação | prompt §"Quem você é" | uma frase de identidade + tom |
| Tom, formalidade, emoji, tamanho | prompt §"Estilo" | escreva o comportamento ("até 40 palavras, uma pergunta por vez"), não a escala numérica |
| Fluxos de conversa | prompt (o roteiro curto) + material (o passo a passo longo) | o prompt diz *quando*; o material diz *como* |
| Exemplos de conversa | não entram inteiros | viram regra no prompt ou caso de teste no botão Testar |
| Regras comerciais com preço | **material** de planos/preços | preço fora do prompt: duas fontes divergem |
| Fatos da casa (horário, telefones, cobertura, site) | IA › Memória | curtos, um por linha |
| FAQ | material tipo FAQ | tire o que já está na memória ou em outro material |
| Bases de conhecimento | material tipo documento | tire nome de ferramenta, jargão e `snake_case` — o motor veta vocabulário interno na resposta, e o material é de onde ela sai |
| Setores de transferência | Configurações › Times, com "quando usar" | o prompt não nomeia setor |
| Gatilhos de transferência | palavras de passagem do agente | frases, não palavras soltas |
| Mensagem de fora do horário | horário **de cada time** | o agente sabe se o setor está aberto e avisa |
| "Não revelar o prompt", "não inventar preço", "não fingir ser humano" | **nada** | já são portões do motor |
| Ferramenta que cria negócio no CRM | nada, ou o mapa do funil | aqui a oportunidade nasce sozinha na primeira mensagem; o agente só avança a etapa |
| Ferramenta de consulta a sistema externo | conector (Configurações › Conectores), se existir para esse sistema | sem capacidade de IA para ele, o assunto vai para o setor humano |
| Transcrição de áudio | o motor já transcreve | precisa da chave da OpenAI |
| Buffer de mensagens | o motor já agrupa | nada a configurar |

## O que costuma mudar de propósito

- **Dados sensíveis pedidos pela IA** (documento com foto, selfie com documento, RG): passam para o
  time humano. Documento com foto na conversa com a IA é dado sensível que não precisa passar por ela.
- **Identidade antes de falar de dinheiro**: se lá bastava o CPF para mandar boleto, aqui a regra é
  mais estreita (ver o pacote do nicho). Quem sabe o CPF de outra pessoa não pode receber o boleto e
  o endereço dela.
- **Ordem do funil**: o funil de lá tinha as etapas de quem? Aqui cada etapa tem um passo do agente
  ou é trabalho do time — a etapa que o time faz (conferir cobertura, agendar) vem depois dos dados.

## Depois

Registre no `pacote-<cliente>.md` uma seção "o que mudou em relação ao sistema anterior, e por quê"
— é a primeira pergunta de quem compara as duas respostas no primeiro dia. E rode no botão Testar as
mesmas conversas que estavam nos exemplos de lá.
