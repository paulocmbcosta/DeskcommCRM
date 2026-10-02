# Pedido de humano escolhe o setor — design

Data: 2026-10-02 · Origem: protocolo 20261002000072 (Totus), lead comercial entregue ao Suporte.

## O defeito

Quando a mensagem do cliente casa com `HUMAN_HANDOFF_PATTERNS` ("falar com um atendente"), o turno
passa a conversa para humano **antes** de chamar o modelo (`inbound-turn.ts`, desvio F4-06) e sem
`teamId`. Quem escolhe setor é só a ferramenta `request_human_handoff`, que o desvio nunca alcança.
Com `conversations.team_id` nulo, `loadEligibleAttendants` devolve todo atendente disponível da
organização e o rodízio entrega ao de menor carga — de qualquer setor.

Medido na Totus (7 dias até 2026-10-02): 20 passagens pelo desvio, 16 com troca manual de time
depois (80%); 116 passagens pela ferramenta, 29 com troca (25%). O texto pronto do site Melhor Plano
contém "quero falar com um atendente": todo lead de lá cai no desvio.

## O que muda

Antes de avisar o cliente e de começar a passagem, o desvio pergunta a um classificador a qual setor
a conversa pertence, e entrega a resposta pronta a `performHumanHandoff`.

```
[escolhe o setor] → aviso ao lead → force_human + silêncio + crons cancelados → inbox → atividade
                  → grava team_id → pede o rodízio
```

### Peças

1. **`lib/agent-engine/agent/setor-do-pedido.ts`** (novo) — `escolherSetorDoPedido`. Lê os times
   ativos (a mesma query da ferramenta de transferência) e as últimas 12 falas da conversa (500
   caracteres cada, sem a moldura que o motor põe em volta de áudio e imagem) e devolve
   `{ id, name }` ou `null`. Nunca lança.
   - **Com chave da OpenRouter** (da organização, senão a da instalação): o Jev, pela System One,
     com duas perguntas — "há assunto além do pedido?" (noul) e "qual setor?" (choice só com os
     times).
   - **Sem chave, ou se o Jev não responder**: um modelo auxiliar pelo seam (`runModelCall`), no
     molde de `intent-classifier.ts`, com o modelo e o provider do agente publicado.
   - As duas vias gravam em `llm_calls` com `purpose = handoff_team_classify`.
2. **`performHumanHandoff`** ganha `timeAutomatico?: { id; name } | null`. Vale quando `teamId` não
   veio; a origem (`classificador`) vai para o aviso da Central e para a atividade.
3. **`inbound-turn.ts`** — o desvio de pedido explícito chama o classificador antes do aviso. O
   desvio de suspeita de opt-out **não**: quem confirma bloqueio não é um setor.
4. **`lib/ai/pontos/registro.ts`** — ponto novo `handoff_team_classify`, papel "entender"; em
   `PONTOS_QUE_HERDAM_DO_AGENTE` para a tela de Provedores mostrar o modelo certo da reserva.

### Quando o setor NÃO é escolhido (fila geral, o comportamento de hoje)

- organização sem time ativo (nenhuma chamada é feita — o desvio segue sem gastar token);
- o Jev responde que não há assunto além do pedido (< 0,5), ou o setor fica abaixo de 0,5;
- a reserva responde `none`, um slug que não existe, ou confiança abaixo de 0,6 (o piso padrão do
  roteador de intenção);
- o Jev e a reserva falham, são recusados ou passam do tempo (4 s e 8 s).

Em nenhum desses casos a passagem deixa de acontecer.

### Por que antes da passagem, e não dentro dela

A primeira versão escolhia o setor **depois** de silenciar a IA, para a escalação não esperar um
provedor. A revisão independente mostrou o custo: entre calar a conversa e gravar o time ela fica
fora da IA e sem time pelo tempo de uma chamada, e o cron de rodízio — que roda uma vez por minuto e
só espera a IA sair — a distribui para a organização inteira nessa janela. Era o defeito de origem,
por corrida, em cerca de 6% das passagens a 3,5 s de espera.

Escolhendo antes, a passagem volta a ser um bloco só de escritas no banco, como sempre foi. O preço
é o aviso ao lead esperar a escolha: ~0,3 s pelo Jev, com teto de 12 s no pior caso (Jev e reserva
fora do ar).

### Medição (2026-10-02)

20 conversas **sintéticas** — 13 casos e mais 7 repetições do texto pronto do site de comparação —
com os seis times da Totus como a empresa os descreveu. Nenhum dado de cliente. O Jev foi medido na
VPS de produção, com a chave que já está lá; os outros, nesta máquina.

| quem escolhe | acertos | setor errado | p50 | máximo |
|---|---|---|---|---|
| Jev, duas perguntas (o que foi para o código) | 20/20 | 0 | 0,26 s | 0,33 s |
| Jev, uma pergunta com a opção `none` | 12/20 a 16/20 | 0 | 0,27 s | 0,75 s |
| `gpt-5.6-terra` (reserva; o modelo da Totus) | 20/20 | 0 | 1,9 s | 6,1 s |
| `gpt-5-mini` (reserva) | 20/20 | 0 | 3,4 s | 4,7 s |
| `claude-haiku-4-5` (reserva) | 20/20 | 0 | 1,2 s | 1,4 s |

Dois achados que mudaram o desenho:

- **O Jev precisa de duas perguntas.** Com uma só, o texto pronto caía em `none` 8 de 8: ele lê ao
  pé da letra, a mensagem diz mesmo "quero falar com um atendente", e o `none` roubava a
  probabilidade do Comercial. "Há assunto?" separa sozinho quem não disse nada (0,03 e 0,04 contra
  0,80 ou mais).
- **A reserva precisa do porquê antes do setor.** Sem o campo `porque` no JSON, o `gpt-5-mini`
  respondia `none` para o mesmo texto em 6 de 8. O `porque` não é lido, logado nem gravado: é
  paráfrase da conversa do cliente.

## Registro e retorno

- `llm_calls` com `purpose = handoff_team_classify` — aparece em IA › Execuções.
- A atividade `handoff_triggered` passa a levar `team_id` e `team_origem` (`classificador` ou
  `agente`) no payload; o aviso da Central diz "Setor escolhido automaticamente: <nome>".
- Na tela: o chip do time na conversa deixa de ser "Sem time" e a conversa entra na fila do setor.
- Laço de retorno: quem recebe a conversa errada usa **Transferir**, que grava
  `routing.team_changed`. `team_origem = classificador` seguido de troca é o erro do classificador,
  medível por consulta; o conserto é reescrever o "quando usar" do time na tela de Times.

## Testes

- Unit do módulo novo: as duas vias, as perguntas, a leitura das respostas, falha, tempo, sem times,
  registro em `llm_calls`, nada do cliente em log.
- Unit de `performHumanHandoff`: o time do classificador é gravado antes do rodízio; time explícito
  vence; a Central e a atividade contam a origem.
- Invariante com Postgres: o turno inteiro com times cadastrados grava `team_id`; a escolha acontece
  antes de a passagem começar; Jev fora do ar cai para a reserva; os dois fora do ar deixam a
  passagem íntegra e sem time.

## Fora de escopo, e o que fica como está

- Conversa que chega à fila sem passar por passagem nenhuma (IA desligada no canal) continua sem time.
- O desvio de suspeita de opt-out e a passagem por teto de gasto continuam na fila geral.
- Conversa devolvida ao automático mantém o `team_id` anterior: se o classificador não escolher, ela
  volta para a fila daquele time, não para a geral. Já era assim.
