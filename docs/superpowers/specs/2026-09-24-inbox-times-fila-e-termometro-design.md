# Inbox: chips por time, fila do time, número no filtro e termômetro de espera

Data: 2026-09-24 · Pedido do dono (Totus) · Aprovado na conversa em 2026-09-24

## Problema

1. Em **Todas**, a lista agrupa por time com "Sem time" em cima e os demais em ordem
   alfabética. Com volume, o Suporte (sempre por último) vira uma barra longa no fim da
   lista — difícil de rastrear.
2. Cliente transferido para um time que **ninguém pegou** (ninguém disponível, ou todos no
   teto) não tem destaque no card nem filtro próprio — o gargalo é invisível.
3. O filtro de número mostra só o apelido (`channelLabel`: apelido **ou** número). Dois
   números oficiais da Meta aparecem como "Totus" e "Totus".
4. A espera ("Aguardando há X") usa degraus de 30 min / 2 h e mede desde a **última**
   mensagem do cliente — quem manda "oi" às 10h00 e "alguém aí?" às 10h09 aparece com 1 min.

## Decisões (tomadas com o dono)

- O **trilho lateral de abas não muda** (Fila, Minhas, Todas, Fechadas, Automático). Os
  chips existem **só dentro de Todas**.
- **Uma régua de espera só**, ajustável pela organização; padrão **2 / 5 / 10 min**.
- "Na fila do time" = `team_id` definido **e** sem atendente **e** não encerrada **e**
  `bot_silenced_until` no futuro (a IA saiu do comando). Pergunta colunas, não o campo
  calculado `comando_da_conversa`: entra numa contagem por time, e o campo calculado lê
  `contacts` duas vezes por linha (incidente da 0278). Régua única em
  `lib/inbox/espera.ts` (`estaNaFilaDoTime`) com espelho SQL em
  `app/api/v1/conversations/_na-fila.ts`.
  Transferência manual para um time passa a **silenciar a IA** (times não têm agente de IA;
  transferir e deixar o robô respondendo era o estado "transferido mas não está na fila").
- O **motivo** (ninguém disponível / todos no limite ou fora do horário) aparece por time, na
  dica do chip — não em cada card.
- Fora: SLA por time, som/notificação, relatório de tempo de resposta.

## Desenho

### Banco (migration 0279)

- `conversations.espera_desde timestamptz` — a **primeira** mensagem do cliente ainda sem
  resposta. Mantida por trigger `BEFORE INSERT OR UPDATE OF last_inbound_at,
  last_outbound_at, status`:
  - não espera (sem inbound, outbound ≥ inbound, ou status terminal) → `null`;
  - passou a esperar e estava `null` → `last_inbound_at`;
  - já esperando → mantém.
  Derivada só das colunas que `fn_mark_conversation_message` já grava: nenhuma função de
  ingestão precisa mudar. Backfill: conversas esperando hoje recebem `last_inbound_at`
  (aproximação — o dado anterior não existe). Índice parcial `(organization_id,
  espera_desde) where espera_desde is not null`.
- `fn_conversation_set_team`: com `p_team` não nulo grava também
  `bot_silenced_until = 'infinity'` (o mesmo valor do handoff da IA; "Devolver ao automático"
  continua sendo a volta).
- Tripla: arquivo em `migrations/` + apêndice idempotente no `baseline.sql` + MANIFEST.

### Configuração

- `organizations.settings.inbox.regua_de_espera = { amarelo_min, laranja_min, vermelho_min }`
  — schema Zod central em `lib/schemas/settings.ts` (`reguaDeEspera(settings)` nunca lança;
  valores inválidos ou fora de ordem caem no padrão). Escrita por Server Action
  (manager+, MFA provado, mescla só a própria chave, concorrência otimista pelo `updated_at`,
  audit `inbox.regua_de_espera_alterada`). Tela: **Configurações › Distribuição de atendimento**.
- Chega ao cliente pelo `ActiveOrg` (layout de `/app` já lê `settings`).

### API

- `GET /api/v1/conversations`: `na_fila=true` (time definido, sem dono, `aguardando`) e
  `ordem=espera` (ordena por `espera_desde` asc, nulls last; cursor genérico já suporta).
  Seleciona `espera_desde`.
- `GET /api/v1/conversations/counts`: `na_fila=true` entra na fábrica de contagem (badge
  espelha a lista). `by_team` passa a ser contado **sem** o filtro de time (senão, ao
  escolher um chip, todos os outros viram 0) e ganha `na_fila` por time.
- `GET /api/v1/conversations/teams/fila` (viewer+): para cada time com fila, o motivo —
  `ninguem_disponivel` (nenhum membro disponível) ou `todos_ocupados` (há disponíveis, mas
  ninguém elegível: teto/horário). Usa `loadEligibleAttendants` (a mesma régua do roteador).

### Tela

- **Todas**: some o agrupamento. Abaixo dos filtros, chips `Todos N · Sem time N · <Time> N`
  (+ selo vermelho "N na fila" e dica do motivo). Clicar filtra por `team_id`. Ao lado, dois
  chips de alternância: **Só na fila** e **Mais tempo esperando**. Em **Minhas**, só o
  segundo (é a aba de quem atende).
- **Card**: selo `Na fila · <Time>` quando a conversa está na fila do time; a linha
  "Aguardando há X" vira o termômetro (o texto fica — é vocabulário que as specs e o
  espanhol já conhecem): amarelo ≥ amarelo_min, laranja ≥ laranja_min,
  vermelho pulsando ≥ vermelho_min (`motion-safe`). Só aparece com comando `humano` ou
  `aguardando` (no Automático a IA leva 1–3 min e pintaria tudo de amarelo). O relógio anda
  sozinho (tick de 30 s na lista).
- **Filtro de número**: `apelido · número completo` (`canalComNumero` em
  `lib/inbox/rotulo-do-canal.ts`).

## Testes

- Unit: régua (`lib/inbox/espera.ts`), schema da régua, rótulo com número, chips, card
  (selo de fila, níveis, pulso), filtros novos no handler e nas contagens.
- Invariante (`test:db`): trigger de `espera_desde` (primeira sem resposta, zera na resposta,
  zera ao encerrar) e `fn_conversation_set_team` silenciando a IA.
- Prova pela tela em ambiente fresco.
