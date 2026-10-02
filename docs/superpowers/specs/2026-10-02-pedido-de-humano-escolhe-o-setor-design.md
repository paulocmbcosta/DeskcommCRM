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

O desvio continua avisando o cliente e silenciando a IA exatamente como hoje, sem modelo. **Depois**
da trava e **antes** de pedir o rodízio, a passagem pergunta a um classificador auxiliar a qual setor
a conversa pertence e grava `conversations.team_id`.

```
aviso ao lead → force_human + silêncio + crons cancelados → [escolhe o setor] → inbox → atividade
              → grava team_id → pede o rodízio
```

### Peças

1. **`lib/agent-engine/agent/setor-do-pedido.ts`** (novo) — `escolherSetorDoPedido`. Lê os times
   ativos (mesma query da ferramenta de transferência), monta o prompt com `slug: nome — quando usar`
   e as últimas falas da conversa, chama o modelo auxiliar pelo seam (`runModelCall`, purpose
   `handoff_team_classify`) e devolve `{ id, name }` ou `null`. Mesmo molde de
   `intent-classifier.ts`. Nunca lança.
2. **`performHumanHandoff`** ganha `escolherTime?: () => Promise<{ id; name } | null>`, chamado só
   quando `teamId` não veio. Falha do resolvedor não derruba a passagem.
3. **`inbound-turn.ts`** — o desvio de pedido explícito injeta o resolvedor. O desvio de suspeita de
   opt-out **não**: quem confirma bloqueio não é um setor.
4. **`lib/ai/pontos/registro.ts`** — ponto novo `handoff_team_classify`, papel "entender",
   configurável no painel de provedores.

### Quando o setor NÃO é escolhido (fila geral, o comportamento de hoje)

- organização sem time ativo (o modelo nem é chamado — o desvio segue sem gastar token);
- o modelo responde `none`, um slug que não existe, ou confiança abaixo de 0,6 (o mesmo piso padrão
  do roteador de intenção);
- o modelo falha, é recusado por orçamento ou passa de 10 s.

Em nenhum desses casos a passagem deixa de acontecer.

### Por que o modelo auxiliar, e não o Jev

O Jev é ~5× mais rápido (p50 0,3 s contra 1,5 s na Totus), mas só existe com chave da OpenRouter —
exigiria um segundo caminho de reserva, como o do sentimento. O modelo auxiliar roda em toda
instalação, lê os mesmos "quando usar" que a ferramenta de transferência lê (as duas portas decidem
com o mesmo material), entra em `llm_calls` e no painel de provedores sem código extra. A latência
não chega ao cliente: ele já foi avisado, e o rodízio roda uma vez por minuto.

### Por que depois da trava

O aviso e o silêncio são exigência (escalação imediata) e não podem esperar um provedor. Feita depois,
a escolha do setor só atrasa o pedido de rodízio. Se o worker morrer no meio, a conversa já está
silenciada e a próxima mensagem do cliente pede o rodízio pelo drain — fila geral, como hoje.

### O prompt pede a razão antes do setor

Medido com modelos reais e 13 conversas sintéticas (nenhum dado de cliente), usando os seis times da
Totus como a empresa os descreveu. Na primeira versão do prompt o `gpt-5-mini` mandou justamente o
texto pronto do site de comparação para `none` em 6 de 8 tentativas ("só pediu um atendente").
Pedir um `porque` curto antes do `setor`, e dizer para usar o que o cliente já preencheu, levou os
três modelos medidos a 20 de 20 (os 13 casos + 7 repetições do texto pronto), sem nenhum setor
errado e mantendo `none` nos dois casos em que o cliente só pede atendente:

| modelo | acertos | setor errado | p50 | máximo |
|---|---|---|---|---|
| `gpt-5.6-terra` (o que a Totus usa) | 20/20 | 0 | 1,9 s | 6,1 s |
| `gpt-5-mini` | 20/20 | 0 | 3,4 s | 4,7 s |
| `claude-haiku-4-5` | 20/20 | 0 | 1,2 s | 1,4 s |

O `porque` não é lido, logado nem gravado: é paráfrase da conversa do cliente.

## Registro e retorno

- `llm_calls` com `purpose = handoff_team_classify` — aparece em IA › Execuções.
- A atividade `handoff_triggered` passa a levar `team_id` e `team_origem` (`classificador` ou
  `agente`) no payload; o aviso da Central diz "Setor escolhido automaticamente: <nome>".
- Na tela: o chip do time na conversa deixa de ser "Sem time" e a conversa entra na fila do setor.
- Laço de retorno: quem recebe a conversa errada usa **Transferir**, que grava
  `routing.team_changed`. `team_origem = classificador` seguido de troca é o erro do classificador,
  medível por consulta; o conserto é reescrever o "quando usar" do time na tela de Times.

## Testes

- Unit do módulo novo (prompt, leitura do veredito, falha, tempo, sem times).
- Unit de `performHumanHandoff`: o resolvedor roda depois de `force_human` e antes do rodízio; falha
  não derruba; `teamId` explícito não o chama.
- Invariante com Postgres: turno inteiro com times cadastrados grava `team_id`; aviso sai antes de
  qualquer chamada de modelo; modelo que falha deixa a passagem íntegra e sem time.

## Fora de escopo

Conversa que chega à fila sem passar por passagem nenhuma (IA desligada no canal) continua sem time.
O desvio de suspeita de opt-out continua na fila geral.
