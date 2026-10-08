# Inbox: filtros por atendente, caixa de entrada, período e assunto — e filtros no endereço

**Data:** 2026-10-08 · **Estado:** desenho aprovado pelo dono do produto · **Migration:** 0297 · **Tarefa:** CU-124b4z9rjvg

## 1. O problema

O pedido veio dos atendentes da Totus, comparando com a ferramenta anterior: "todas as
conversas que vemos aqui são todas misturadas de todos os atendentes". Lido no código
em 2026-10-08 (nada medido em produção):

- **Atendente.** Não há controle na tela. A lista de conversas já aceita
  `assigned_to=<uuid>` (`app/api/v1/conversations/_handler.ts`), mas as contagens das
  abas (`conversations/counts/route.ts`) e a aba Fechadas
  (`app/api/v1/atendimentos/_handler.ts`) não conhecem o parâmetro.
- **Caixa de entrada.** Só existe filtro por número (`channel_session_id`). O seletor
  some com menos de dois números, não lista o telefone, e não há como pedir um meio
  inteiro ("só WhatsApp").
- **Fechadas.** Lista atendimentos encerrados sem recorte de data nem de assunto.
- **Persistência.** Só a aba vai para o endereço (`?filter=`). O resto é `useState` em
  `components/inbox/InboxLayout.tsx` e se perde ao recarregar.
- **Duas listas de "filtro ligado" que discordam.** `contarFiltrosAuxiliares`
  (`InboxFilters.tsx`) conta time, número e etiqueta; `filtrosAuxiliaresAtivos`
  (`lib/inbox/filtros-ativos.ts`) conta não lidos, busca, etiqueta, canal, só na fila
  e insatisfeitos — e **não o time**. Com só o time ligado e zero resultados, a tela
  diz "Sem conversas por aqui".
- **Dois chamadores da contagem com parâmetros diferentes.** `InboxAbas.tsx` não manda
  `na_fila` nem `insatisfeitos`; `InboxLayout.tsx` manda.

## 2. Decisões

| # | Decisão | Quem |
|---|---|---|
| D1 | Entram: atendente, caixa de entrada (meio e número), período e assunto em Fechadas, e filtros no endereço. | dono |
| D2 | Em Fechadas, "do atendente X" é quem estava com a conversa no encerramento (`atendimentos.assigned_to_user_id`), não quem clicou em encerrar. | sessão, aprovado no desenho |
| D3 | O seletor de atendente vale em Todas e Fechadas. Minhas já é "eu"; Fila e Automático não têm atendente por definição. | sessão, aprovado no desenho |
| D4 | A aba Telefone fica como está. | sessão, aprovado no desenho |
| D5 | Uma entrega, um PR. | sessão |
| D6 | O texto da busca não vai para o endereço. | sessão |
| D7 | "Hoje" é o dia de quem olha a tela (fuso do navegador). | sessão |

Por que D3 vale para Fila e Automático: em `comandoDaConversa`
(`lib/inbox/comando-da-conversa.ts`), conversa com dono tem comando `humano`; a Fila
pede `aguardando` (e `automatico` em organização sem IA) e a aba Automático pede
`automatico` — os dois só existem sem dono.

## 3. Caminhos recusados

- **Aba nova "Minhas fechadas".** É a aba Fechadas com atendente = eu. Aba a mais
  duplica a regra e o selo.
- **Filtrar Fechadas pelo dono atual da conversa.** A conversa perde o dono quando o
  cliente volta (0269); o histórico de quem atendeu sumiria.
- **Filtrar por `closed_by_user_id`.** Responde "quem clicou", não "quem atendeu" (D2).
- **Filtrar em memória depois de paginar.** Devolve página curta e um "carregar mais"
  que não traz nada — o defeito que `unread` já teve.
- **Reusar `GET /api/v1/team/assignable` no seletor.** Exige `agent` (o observador
  enxerga a organização inteira e ficaria sem o filtro) e não traz ex-membros, que são
  donos de histórico.
- **Pôr o telefone em `GET /api/v1/channel-sessions`.** A rota serve seletores de
  "por onde enviar"; o comentário dela registra o defeito de uma linha de voz virar
  opção ali.
- **Busca no endereço.** Nome e telefone de cliente no histórico do navegador e em
  registro de acesso (D6).
- **Fuso da organização para "hoje".** Exigiria conta de fuso no cliente para um caso
  que hoje não existe (todos os usuários no mesmo fuso). Fica registrado como limite.

## 4. O estado dos filtros

### 4.1 Uma fonte: o endereço

Os filtros auxiliares deixam o `useState` e passam a ser lidos de `useSearchParams`.
A busca continua em estado local (D6). Os nomes dos parâmetros da página são os mesmos
da API, para existir um vocabulário só.

| Filtro | Parâmetro | Valores | Abas onde vale |
|---|---|---|---|
| Aba | `filter` | já existe | — |
| Conversa aberta | `id` | já existe | — |
| Não lidos | `unread` | `1` | Fila, Minhas, Todas, Automático, Fechadas |
| Time | `team_id` | `mine`, `none`, uuid | as mesmas |
| Etiqueta | `tag` | texto | as mesmas |
| Caixa (meio) | `channel` | `whatsapp`, `site_chat`, `phone` | as mesmas |
| Caixa (número) | `channel_session_id` | uuid | as mesmas |
| Atendente | `assigned_to` | `me`, `unassigned`, uuid | Todas, Fechadas |
| Período | `periodo` | `hoje`, `ontem`, `7d`, `30d` | Fechadas |
| Período (datas) | `de`, `ate` | `AAAA-MM-DD`, inclusivas | Fechadas |
| Assunto | `assunto_id` | uuid | Fechadas |
| Só na fila | `na_fila` | `1` | Todas |
| Ordem | `ordem` | `espera` | Todas, Minhas |
| Insatisfeitos | `insatisfeitos` | `1` | Todas, Minhas |

### 4.2 Peças

- **`lib/inbox/filtros-na-url.ts`** (novo, puro). `lerFiltrosDaUrl(sp)` e
  `escreverFiltrosNaUrl(sp, filtros)`.
  - Valor inválido na leitura é descartado em silêncio: link quebrado abre a lista sem
    aquele filtro, não um erro.
  - A escrita preserva parâmetros que não são de filtro (`id` e qualquer outro).
  - `de` e `ate` só valem juntos e com `de <= ate`; `periodo` vence quando os três vêm.
- **`lib/inbox/filtros-da-aba.ts`** (novo, puro). A tabela acima em código: dada a aba
  e os filtros da tela, devolve os que **se aplicam**. É a única fonte para quatro
  perguntas que hoje têm respostas separadas:
  1. o que vai para a API;
  2. que controles a tela mostra;
  3. quantos filtros o funil conta;
  4. que nomes o estado vazio cita.

  Substitui `contarFiltrosAuxiliares` e `filtrosAuxiliaresAtivos`. O time passa a ser
  citado no vazio.
- **Filtro ligado em aba onde não vale** fica no endereço e não é aplicado nem contado
  ali; ao voltar para a aba onde vale, ele volta. É a regra que `na_fila` já segue
  (`InboxLayout.tsx`, comentário dos "dois chips de Todas").
- **Escrita do endereço.** `window.history.replaceState`, para a aba e para os
  filtros — um escritor só. A documentação do Next (guia "Linking and Navigating",
  seção "Native History API") diz que `pushState` e `replaceState` se integram ao
  roteador e sincronizam com `useSearchParams`. Hoje a aba usa `router.replace`, que
  refaz a página no servidor (`force-dynamic`, com leitura de usuário e organização)
  a cada clique; isso deixa de acontecer. A prova de que sincroniza na versão
  instalada (`next ^16.3.4`) é o teste de ponta a ponta de recarregar e de abrir o
  endereço copiado.
- **"Limpar filtros"** apaga todos os parâmetros de filtro e a busca; mantém `filter`
  e `id`.

## 5. Atendente

- **Estado:** `assigned_to` = `me`, `unassigned` ou o id de um usuário.
- **Todas:** vai como `assigned_to` para `GET /api/v1/conversations` (já aceito).
- **Fechadas:** parâmetro novo em `GET /api/v1/atendimentos`, sobre
  `atendimentos.assigned_to_user_id`: `me` → igual ao usuário da sessão;
  `unassigned` → `is null`; uuid → igual.
- **Contagens:** valem para `all`, `closed` e os chips por time (que são de Todas).
  `mine`, `fila` e `automatico` não mudam.
- **Atalho "Só as minhas":** botão de alternância na linha do título da aba Fechadas,
  no mesmo lugar e estilo das alternâncias de Todas (`AlternanciasDaLista`). Liga e
  desliga `assigned_to=me`; fica pressionado quando o valor é `me`.
- **Seletor no funil:** "Todos os atendentes", "Eu", "Sem atendente", depois os nomes
  em ordem alfabética, e por último quem saiu da organização, marcado "(saiu)".
  Id escolhido que não está na lista aparece como "Atendente removido" — o mesmo
  tratamento de número, etiqueta e time órfãos.
- **Quem vê o seletor:** quem enxerga conversa de colega — `viewer`, `manager`,
  `admin`, e `agent` nos modos `all` e `own_and_team`. É a mesma condição que hoje
  decide a aba Todas em `visibleInboxTabs`; ela vira uma função nomeada em
  `lib/inbox/abas.ts`, usada pelos dois. Os demais só têm o "Só as minhas".
- **`viewer` não atende:** para ele, a opção "Eu" e o botão "Só as minhas" não
  aparecem.
- **Filtro não é barreira.** Um `agent` restrito que abrir um link com o id de um
  colega recebe o que a RLS deixar (em geral, nada), com o filtro citado no vazio.

## 6. Caixa de entrada

- **Estado:** `channel` (meio) ou `channel_session_id` (número). Escolher um apaga o
  outro. Os dois juntos, vindos de um link editado à mão, são aplicados com E.
- **API:** `channel` é parâmetro novo em `GET /api/v1/conversations`, nas contagens e
  em `GET /api/v1/atendimentos` (via `conversations!inner`, como o número já é).
  Valores de `MEIOS_DE_CANAL` (`lib/channels/capabilities.ts`). Nenhuma peça nomeia
  provider.
- **Vale em** Fila, Minhas, Todas, Automático e Fechadas; as cinco contagens aplicam.
- **Seletor "Caixa de entrada"** (substitui "Todos os números"): "Todas as caixas" e,
  para cada meio presente, a linha do meio — "WhatsApp", "Telefone", "Chat do site".
  Os números de um meio aparecem abaixo dele quando o meio tem mais de um. A linha do
  meio existe sempre porque só ela alcança conversa de número já removido.
- **Aparece quando** há mais de um meio ou mais de um número, ou quando há um filtro
  de caixa ligado.
- **Telefone:** a conversa de telefone aponta para o número pelo mesmo
  `channel_session_id` (`lib/channels/telefonia/repositorio.ts`, `acharOuCriarConversa`),
  então o filtro por número funciona igual.

## 7. Período e assunto (só Fechadas)

### 7.1 Período

- **Estado:** `periodo` (`hoje`, `ontem`, `7d`, `30d`) ou `de` + `ate`.
- **Resolução no cliente**, no fuso do navegador (D7), para dois instantes:

  | Escolha | `closed_from` (inclusivo) | `closed_to` (exclusivo) |
  |---|---|---|
  | `hoje` | 00:00 de hoje | ausente |
  | `ontem` | 00:00 de ontem | 00:00 de hoje |
  | `7d` | 00:00 de seis dias atrás | ausente |
  | `30d` | 00:00 de 29 dias atrás | ausente |
  | `de` + `ate` | 00:00 de `de` | 00:00 do dia seguinte a `ate` |

  `closed_to` ausente nas escolhas abertas mantém a chave da consulta estável durante
  o dia.
- **API:** `closed_from` e `closed_to`, instantes ISO-8601 com fuso, em
  `GET /api/v1/atendimentos` e nas contagens. `closed_at >= from` e `closed_at < to`.
- **Seletor:** "Qualquer data", "Hoje", "Ontem", "Últimos 7 dias", "Últimos 30 dias",
  "Escolher datas…". A última abre dois campos de data.

### 7.2 Assunto

- **Estado e API:** `assunto_id` (uuid) → `atendimentos.assunto_id = id`.
- **Seletor:** "Todos os assuntos" e os assuntos agrupados por time. Assunto arquivado
  aparece marcado "(arquivado)", porque continua nomeando o histórico.

## 8. Servidor

### 8.1 Contratos que mudam (todos aditivos)

| Rota | Parâmetros novos |
|---|---|
| `GET /api/v1/conversations` | `channel` |
| `GET /api/v1/conversations/counts` | `assigned_to`, `channel`, `closed_from`, `closed_to`, `assunto_id` |
| `GET /api/v1/atendimentos?status=closed` | `assigned_to`, `channel`, `closed_from`, `closed_to`, `assunto_id` |

Parâmetro ausente devolve o mesmo de hoje.

### 8.2 Régua única dos fechados

Hoje a lista (`listarAtendimentosFechados`) e a contagem (`countAtendimentosFechados`,
dentro de `counts/route.ts`) aplicam os mesmos predicados escritos duas vezes. Com
cinco filtros novos, a divergência vira questão de tempo. Os predicados saem para uma
função em `app/api/v1/atendimentos/_handler.ts`, chamada pelos dois — o mesmo molde de
`_filtro-de-time.ts`.

### 8.3 Contagens validam pelo schema

`counts/route.ts` lê cada parâmetro com `sp.get` à mão. Os parâmetros novos entram por
um schema Zod compartilhado com as listas, e a cerca
`tests/unit/rota-le-todo-filtro-do-schema.test.ts` — que hoje só vigia
`conversations/route.ts` — passa a cobrir a rota de contagem e a de atendimentos.

### 8.4 Rota nova: `GET /api/v1/conversations/filtros`

O que o painel de filtros precisa para montar os seletores novos, numa resposta só.
Molde: `GET /api/v1/conversations/teams`.

- **Papel:** `viewer`+.
- **Resposta:**

  ```json
  {
    "data": {
      "atendentes": [{ "user_id": "…", "nome": "Maria", "ativo": true }],
      "caixas": [{ "id": "…", "meio": "whatsapp", "nome": "Comercial", "numero": "5511…" }],
      "assuntos": [{ "time_id": "…", "time": "Financeiro",
                     "assuntos": [{ "id": "…", "nome": "Segunda via", "arquivado": false }] }]
    }
  }
  ```

- **Atendentes:** membros da organização com papel diferente de `viewer`, mais os
  revogados (`ativo: false`). Lidos de `user_organizations` com o admin client,
  filtrado pela organização da sessão — o mesmo padrão e a mesma razão de
  `team/assignable` (a RLS mostra ao `agent` só o próprio vínculo). Nomes por
  `nomesDosAtendentes` (`lib/users/nome-do-atendente.ts`): só `full_name`, uma
  chamada por pessoa (medido no cabeçalho daquele arquivo: ~350 ms para 10). Sem
  service role, a lista sai com `nome: null` e a tela mostra o rótulo genérico.
- **Caixas:** `channel_sessions` não arquivadas cujo provider tem meio
  (`meioDoCanal(provider) != null`), com o client do usuário. A resposta leva `meio`,
  nunca o provider.
- **Assuntos:** `atendimento_assuntos` com o time, incluindo arquivados, com o client
  do usuário.
- **Carga:** a tela só pede quando o funil abre ou quando há filtro de atendente,
  caixa ou assunto vindo do endereço. Cache de 5 minutos no cliente.
- Leitura pura: sem auditoria.

## 9. Banco (migration 0297)

Dois índices, sem coluna, função ou policy nova:

```sql
create index if not exists atendimentos_org_dono_fechamento
  on public.atendimentos (organization_id, assigned_to_user_id, closed_at desc)
  where closed_at is not null;

create index if not exists conversations_org_channel_last_msg
  on public.conversations (organization_id, channel, last_message_at desc nulls last);
```

- O primeiro serve "Só as minhas" e o filtro por nome em Fechadas.
- O segundo serve o filtro por meio quando o meio é minoria (telefone, chat do site):
  sem ele, a consulta percorre as conversas da organização em ordem de atividade,
  passando cada linha pela RLS, até juntar uma página.
- Período e assunto já têm índice (`atendimentos_org_fechamento`,
  `atendimentos_assunto`).
- Antes de fechar o PR, medir os dois planos com `EXPLAIN` sob o papel
  `authenticated` num banco com volume sintético. Índice que o plano não usar sai da
  migration.
- Tripla: arquivo em `supabase/migrations/`, apêndice idempotente no `baseline.sql`,
  linha no `MANIFEST.md`.

## 10. Tela

- **`InboxFilters.tsx`** — o funil passa a guardar, nesta ordem:
  1. Time (linha inteira, como hoje);
  2. Atendente (linha inteira; só para quem vê colegas, só em Todas e Fechadas);
  3. Caixa de entrada + Etiqueta (dividem a linha, como número e etiqueta hoje);
  4. Período + Assunto (dividem a linha; só em Fechadas);
  5. dois campos de data, quando o período é "Escolher datas…".
- **Selo do funil:** quantos filtros se aplicam à aba atual (seção 4.2).
- **Linha do título de Fechadas:** o botão "Só as minhas".
- **Vazio por filtro** (`EmptyPorFiltro`): cita os filtros que se aplicam, agora
  incluindo Time, Atendente, Caixa de entrada, Período e Assunto.
- **`InboxAbas.tsx` e `InboxLayout.tsx`** pedem as contagens com os mesmos parâmetros,
  montados por uma função só.
- **Idiomas:** toda frase nova entra em `lib/i18n/dicionario.ts`.
- A coluna da lista tem 300 px. As medidas dos controles novos são conferidas por
  ferramenta, não a olho.

## 11. O que não muda

- A aba Telefone e seus filtros de time e número.
- RLS e visibilidade: os filtros compõem sobre consultas que já estão sob o client do
  usuário.
- Tempo real: a lista é rebuscada no servidor com os filtros atuais; não há decisão
  no cliente sobre "esta conversa entra na lista".
- A busca, inclusive o que ela alcança.

## 12. Testes

**Unidade**
- `filtros-na-url`: ida e volta de cada filtro; valor inválido descartado; `id`
  preservado; `periodo` vence `de`/`ate`.
- `filtros-da-aba`: a tabela da seção 4.1, aba por aba.
- Resolução do período com relógio e fuso fixos, incluindo a virada do dia.
- Handler de conversas: `channel` vira predicado.
- Handler dos fechados: cada um dos cinco filtros vira predicado; `assigned_to=me`
  usa o usuário da sessão.
- Contagens: cada filtro alcança as contagens certas e só elas (estende
  `badge-espelha-o-filtro.test.ts`).
- Cerca do schema estendida às três rotas.
- `InboxFilters`: quem vê o seletor de atendente por papel, modo e aba; órfãos; o
  seletor de caixa com um e com vários meios.
- "Limpar filtros" apaga os novos.

**Invariantes (`pnpm test:db`)**
- A migration aplica em instalação nova e em atualização.
- Duas organizações: `GET /conversations/filtros` de uma não devolve atendente, caixa
  nem assunto da outra.
- `agent` em modo `own` filtrando por um colega em Fechadas não recebe nada.

**Ponta a ponta** — `tests/e2e/inbox-filtros-por-atendente-e-caixa.spec.ts`, registrado
no `e2e.yml`: dois atendentes com atendimentos encerrados por cada um, conversas de
WhatsApp e de telefone. Cobre "Só as minhas", atendente pelo nome, caixa por meio,
período, assunto, recarregar a página e abrir o endereço copiado.

**Prova em tela** — ambiente fresco no molde da VPS, com evidência em
`.superpowers/evidence/`, e o mapa `docs/testing/user-journey-map.md` atualizado.

## 13. Sistema vivo

| Invariante | Resposta |
|---|---|
| Entrada e saída | Entrada: o funil e o endereço. Saída: a lista e os selos das abas. |
| Porta | O funil do Inbox, tela que já existe e já tem porta. Nenhuma tela nova. |
| Log | Leitura pura; não gera auditoria nem atividade. |
| Anti-morte | Filtro ligado sem resultado é citado no vazio, com "Limpar filtros". Opção que saiu da lista (atendente, caixa, assunto) continua visível como órfã. |
| Laço de retorno | Lista e selo saem da mesma régua; se divergirem, `badge-espelha-o-filtro.test.ts` e a cerca do schema reprovam. |
| Mapa | `docs/architecture/inbox-fila-e-termometro.architecture.json` ganha a rota `conversations/filtros` e as arestas para a lista, as contagens e os fechados. |

## 14. Riscos

- **TS2589 nos builders com embed** (`atendimentos` com `conversations!inner`): só o
  `next build` acusa. A função única da seção 8.2 recebe o builder já com o cast que
  o arquivo usa hoje.
- **Escritor do endereço** (seção 4.2): os testes de unidade que hoje simulam
  `useRouter().replace` para a troca de aba (`debounce-nao-volta-a-aba`,
  `InboxLayout.telefone`) precisam passar a observar o endereço. A sincronização real
  com o roteador só é provada no navegador.
- **Custo dos nomes** (seção 8.4): uma chamada por membro. Se pesar, o conserto é
  desnormalizar o nome, não paralelizar.
- **Fuso** (D7): um observador em outro fuso vê "hoje" diferente do atendente.

## 15. Fora do escopo

- Aba Telefone.
- Visões salvas, filtro "aguardando nossa resposta", busca no histórico inteiro,
  exportar a lista.
- Visibilidade do `agent` restrito sobre o próprio histórico: a policy de
  `atendimentos` herda da conversa de hoje, então um atendimento que ele encerrou
  some para ele quando o cliente volta e outro atende. É regra de visibilidade, com
  tarefa própria no backlog.
- `unread` da API de conversas usa `z.coerce.boolean()` e lê `"false"` como
  verdadeiro. A tela só manda `true`; não é tocado aqui.
