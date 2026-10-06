# Telefonia · A fila visível — conversa viva ao atender, aba Telefone e ações na fila — desenho

Escrito em 2026-10-06. O dono descreveu dois buracos na telefonia em produção:

1. **A conversa só aparece quando a ligação acaba.** Durante a ligação o atendente
   não tem onde escrever uma nota interna.
2. **Não existe onde acompanhar a fila do telefone.** Numa queda de internet muita
   gente liga ao mesmo tempo, e quem coordena não vê quantos esperam, de que time,
   por qual número — nem consegue pôr mais gente para atender ou mandar a ligação
   para outro setor.

O desenho foi apresentado e aprovado por ele na mesma conversa, com o teto da espera
**configurável por time** (escolha dele) e as decisões D4–D7 propostas por mim e
aceitas.

Relacionados: spec 20 (`docs/specs/20-spec-telefonia-sip.md`), desenho da fase 2
(`2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`), desenho da
gravação (`2026-09-29-telefonia-gravacao-das-ligacoes-design.md`), desenho da fila
e do termômetro do Inbox (`2026-09-24-inbox-times-fila-e-termometro-design.md`).

## 1. O que existe hoje (lido no código em 2026-10-06, não medido na tela)

- **A conversa já nasce no primeiro toque.** `novaRecebida`
  (`lib/channels/telefonia/controle.ts`) chama `acharOuCriarConversa` assim que a
  ligação entra, e `ramalAtendeu` a passa para quem atendeu
  (`fn_conversation_assign`, motivo `claim`). O que só acontece no fim é o **cartão
  da ligação** (`registrarNaConversa`), e é ele que grava `last_message_at` — a
  coluna pela qual o Inbox ordena. Durante a ligação, a conversa de um cliente novo
  fica no fim da lista (`last_message_at` nulo, `nullsFirst: false`) e a de quem já
  ligou antes fica na posição da ligação anterior. O painel da ligação tem o link
  "Abrir a conversa", que leva a uma conversa sem nada que marque a ligação em curso.
- **A fila vive na memória do worker** (`Recebida.fila`). O banco guarda o bastante
  para mostrá-la — `voice_calls.status`, `ringing_user_id`, `owner_user_id`,
  `team_id`, `menu_id`, `menu_outcome`, `started_at`, `channel_session_id` —, e a
  tabela já está na publicação do Realtime. Não há rota nem tela.
- **A espera tem teto fixo de 2 minutos** (`ESPERA_NA_FILA_MS`,
  `lib/telefonia/distribuicao.ts`): sem ninguém livre, o cliente ouve "ninguém
  atendeu", a ligação cai e vira "Ligar de volta" na Central.
- **A fila não segue a ordem de chegada.** Cada ligação reavalia sozinha, a cada
  5 s (`REAVALIAR_FILA_MS`), se alguém ficou livre. Quem pega o atendente que
  desocupou é a ligação cujo relógio disparar primeiro, não a mais antiga.
- **O rodízio de conversas não toca em conversa de telefone** (`lib/routing/worker.ts`
  pula `MEIO_TELEFONE`), então pôr a conversa no time da fila não a entrega a ninguém
  por engano.

## 2. O que muda para quem usa

- **Atendente:** ao atender, a conversa sobe para o topo de Minhas com o cartão
  "Ligação em andamento" e um atendimento aberto. Dá para escrever nota interna
  enquanto fala. No fim, o mesmo cartão é completado com duração e gravação.
- **Qualquer pessoa no Inbox:** aba nova **Telefone** no trilho, com o número de
  ligações esperando no selo. Dentro dela: quem está na fila (por ordem de chegada),
  no menu, em ligação, e as perdidas dos últimos 30 minutos.
- **Atendente, na aba:** botão **Atender** em cada ligação da fila — a ligação vai
  direto para o ramal dele, de qualquer time.
- **Gerente e administrador, na aba:** **Mover para outro time**.
- **Gerente e administrador, em Configurações › Times:** a **espera máxima na fila
  do telefone** de cada time.
- **Quem liga:** espera até o teto do time em vez de 2 minutos fixos, e é atendido
  por ordem de chegada.

## 3. Decisões

| # | Pergunta | Decisão | Por quê |
|---|---|---|---|
| D1 | Quanto o cliente espera sem ninguém livre? | **Por time**, em `attendance_teams.phone_queue_max_wait_seconds`. Nulo = 120 s (o de hoje). A tela oferece 2, 5, 10, 15, 20 e 30 minutos. | Escolha do dono. O padrão não muda nada para quem atualiza. |
| D2 | De onde a tela lê a fila? | **Do banco** (`voice_calls`), por uma rota. | O worker já grava cada mudança de estado; a leitura sobrevive a um reinício dele; organização e permissão ficam num lugar só. O Asterisk não sabe o que é time, e perguntar à memória do worker abriria uma porta nova entre o app e ele. |
| D3 | Quando o cartão da ligação entra na conversa? | **Ao atender** (só a recebida), por **uma função só e idempotente** (`abrirCartaoDaLigacao`): a primeira chamada cria o cartão e a seguinte só troca o nome de quem está com a ligação. A marca é `metadata.voice_call.em_andamento: true`, com `desfecho: "atendida"`. No fim ele é **atualizado**, não inserido. | É o momento em que a conversa tem dono. A feita já parte de dentro da conversa. O desfecho fica `atendida` porque um valor novo (`"em_andamento"`) seria lido como "não atendida" pela aba que não recarregou depois da atualização, e ela mostraria "Ligação perdida" em vermelho durante a ligação; com a marca à parte, a tela antiga mostra "Ligação recebida · atendida por Ana", que é verdade. Uma função só porque a transferência (outra pessoa pega a ligação) repete o mesmo gesto, e quem chama não precisa saber se o cartão já existe. |
| D4 | Quem vê a aba? | Todo membro que entra no Inbox (`viewer`+), **todos os times**, só com nome, número, time e espera. Abrir a conversa segue a visibilidade que já vale (RLS). | Sem ver a fila do outro setor, ninguém consegue ajudar no pico. A linha não mostra conteúdo de conversa. |
| D5 | Quem age? | **Atender:** `agent`+. **Mover para outro time:** `manager`+. | Atender é pegar trabalho; mover é decidir por um setor. A transferência de ligação em andamento já usa a mesma divisão (dono da ligação ou gerente). |
| D6 | A tela abre a conversa sozinha ao atender? | **Não.** A conversa sobe ao topo e o link "Abrir a conversa" do painel continua. | Trocar de conversa sozinho descartaria o que o atendente estava digitando em outra. |
| D7 | A regra das 2 voltas muda? | **Não.** Com gente livre que não atende em duas voltas de 20 s, a ligação cai como hoje. O teto de D1 vale para a espera sem ninguém livre. | Não foi pedido, e mudar as duas réguas juntas impediria saber qual delas mexeu no número de perdidas. |
| D8 | Como a ordem da tela chega ao worker? | Como a transferência (fase 2, §12.4): a rota confere e **grava o pedido**, emite um evento de usuário da ARI, e o worker **relê a linha** e revalida contra o estado dele. | A variável do evento é ponteiro, nunca autoridade. O padrão já está provado em produção. |
| D9 | Quem clicou em Atender precisa atender de novo quando o ramal tocar? | **Não.** O navegador que clicou atende sozinho. | O clique já foi a decisão. Um segundo clique é atraso com cliente esperando. |
| D10 | O que é a "ordem de chegada"? | A hora em que a ligação passou a esperar por uma pessoa: `voice_calls.queued_at`, gravada quando os toques começam (depois do menu e dos avisos). Mover de time **não** muda essa hora. | Quem esperou mais é atendido antes, em qualquer fila. |
| D11 | O que conta como perdida recente? | Recebida encerrada sem atender nos últimos 30 minutos, com o motivo: desligou no menu, desistiu na fila, fila esgotada, ninguém atendeu, fora do horário. | No pico é esse o volume que o dono quer ver. O "fora do horário" não vira aviso na Central, mas é volume. |

## 4. As três entregas

Cada uma tem plano de implementação próprio e sai em PR próprio, com fragmento em
`.changes/` (`capacidade_nova`) e prova própria. A ordem é 1, 2, 3: a 1 não depende
de nada; a 3 depende da aba da 2. Nenhuma mexe na imagem do Asterisk nem no dialplan.

### 4.1 Entrega 1 — conversa viva ao atender

**Worker** (`controle.ts` + `repositorio.ts`):

- **O time da conversa não muda** (este desenho dizia "ao entrar na fila, a conversa
  passa para o time da fila"; o plano levou isso para o atender; a revisão independente
  tirou). A conversa de quem já ligou antes guarda o time do atendimento anterior, e
  trocá-lo ao atender gravava na linha do tempo "Transferida para a fila do time…
  Aguardando operador disponível" com a ligação já atendida: o gatilho de
  `conversations` só cala esse evento quando o time muda no MESMO comando que reabre a
  conversa. Fica como era antes desta entrega; o conserto pede migration (o gatilho
  precisa saber que a troca veio de uma ligação atendida).
- Em `ramalAtendeu`, depois de `marcarAtendida` e `atribuirConversa`, uma função nova
  `abrirCartaoDaLigacao` insere a mensagem `ligacao:<voice_call_id>` (mesmo
  `external_id` de hoje) com `metadata.voice_call.em_andamento = true` e
  `desfecho = "atendida"` — e não `desfecho = "em_andamento"`, como este desenho dizia
  antes do plano (motivo em D3) —, atendente, menu e `ouviu_aviso`, e grava
  `last_message_at` e a prévia "Ligação em andamento". A ordem importa: a atribuição
  reabre a conversa encerrada e o gatilho da 0266 abre o atendimento novo; o cartão
  vem depois, dentro da janela desse atendimento.
- `registrarNaConversa` (o fim): se a mensagem já existe, **atualiza** corpo e
  `metadata.voice_call` — sempre mesclando no banco (`||`), nunca sobrescrevendo, que
  é a regra de `messages.metadata` desde a 1.41.0 — tira a marca `em_andamento` e
  grava `last_message_at` de novo. Se não existe (ligação perdida, ou o cartão não
  entrou), insere como hoje.
- Transferência concluída: quem pega a ligação a recebe pela MESMA
  `abrirCartaoDaLigacao`, chamada de novo — a função é idempotente, e nessa segunda
  chamada só troca o nome de quem está com a ligação. Uma função só, e não uma
  segunda para a transferência, porque o gesto é o mesmo e quem chama não precisa
  saber se o cartão já existe.
- Falha ao abrir o cartão nunca derruba a ligação: registra aviso e segue.

**Tela:**

- `CartaoDaLigacao` ganha o estado "Ligação em andamento · com {nome} · desde {hora}".
  A atualização chega pelo canal de mensagens que já assina `event: "*"`
  (`useMessagesRealtime`) — o mesmo caminho pelo qual a gravação já troca o cartão.
- Nada muda na lista além do que a prévia e a ordenação já fazem.

**Anti-morte:** `recuperar()` já encerra a ligação que morreu com o worker, e o
encerramento atualiza o cartão. Sobra um caso: a ligação fechou no banco e a escrita
do cartão falhou. A passada de 60 s do telefone (`passadaDoTelefone`) passa a
consertar cartão "em andamento" cuja `voice_calls` já está `ended`.

**Banco:** sem migration. `desfecho` é vocabulário do TypeScript dentro de
`messages.metadata` (jsonb, sem `check`), fora do alcance de
`tests/invariants/vocabulario-banco-x-typescript.test.ts`.

**A conferir no plano antes de escrever:** os gatilhos de `conversations`
(`fn_service_stamp_status` solta o dono quando reabre para um status que não é
`claimed` — armadilha já paga na 1.52.6) e a régua da janela das notas internas.

### 4.2 Entrega 2 — aba Telefone

**Banco** (migration nova, próximo `NNNN` livre na hora; hoje seria 0295):

- `voice_calls.queued_at timestamptz` — D10.
- `voice_calls.queue_deadline_at timestamptz` — quando a espera sem ninguém livre
  esgota. É o que a linha mostra como "cai em 1:18". Nulo enquanto há alguém tocando
  ou a ligação ainda não esperou.
- `attendance_teams.phone_queue_max_wait_seconds integer`, `check` entre 30 e 1800.
- Índices parciais: ligações vivas por organização
  (`where status <> 'ended' and direction = 'inbound'`) e perdidas recentes
  (`(organization_id, ended_at desc) where direction = 'inbound' and answered_at is null`).
- Migration + apêndice idempotente no `baseline.sql` + linha no MANIFEST.

**Worker:**

- `queued_at` gravado em `comecarOsToques`, uma vez.
- O teto vem do time: `timeParaAFila` passa a devolvê-lo; é lido quando a espera
  começa e de novo quando a ligação muda de time. Mudar a configuração não altera
  quem já está esperando. `queue_deadline_at` é gravado no mesmo momento.
- **Ordem de chegada.** Função pura nova em `lib/telefonia/distribuicao.ts`: com `n`
  atendentes livres, só as `n` ligações mais antigas do time que não estão tocando
  para ninguém podem tocar; as outras esperam. Em `tocarProximo`, a ligação que não
  está entre elas cai no ramo `esperar` de sempre (música, teto).
- Quando qualquer ligação acaba, o controlador reavalia na hora as ligações em espera,
  da mais antiga para a mais nova. O relógio de 5 s continua, como rede de segurança
  para o que não gera evento (alguém saiu da pausa).
- **O que não muda:** a fila da transferência para um time (v2, `transferencia.ts`)
  mantém os 2 minutos fixos e a mecânica própria.

**API:**

- `GET /api/v1/telefonia/fila` — `viewer`+, organização da sessão, leitura pela
  conexão da API com filtro explícito de `organization_id`. Devolve, num corpo só:
  - `times`: id, nome, teto, quantas na fila, espera mais antiga, quantos livres, situação;
  - `numeros`: os números da empresa (para o filtro);
  - `ligacoes`: id, fase (`menu`, `avisos`, `aguardando`, `tocando`, `em_ligacao`,
    `transferencia_na_fila`), contato, número de quem liga, time, número da empresa,
    conversa, `na_fila_desde`, posição, `cai_em`, para quem toca, com quem fala;
  - `perdidas`: as dos últimos 30 minutos, com motivo e quanto esperaram (D11).

  Os filtros (time, número) são aplicados na tela sobre esse corpo: o chip e a lista
  saem da mesma resposta, e o selo nunca conta o que a lista não mostra.
- `PUT /api/v1/telefonia/fila/times/[teamId]` — a espera máxima do time. `manager`+
  (o mesmo papel do aviso de instabilidade, `telefonia/emergencias/[teamId]`), Zod,
  time desta organização e não arquivado, auditoria `phone.queue_wait_changed`.
  Corpo `{ espera_maxima_s: number | null }`; nulo volta ao padrão.

**Tela:**

- `lib/inbox/abas.ts`: aba `phone` ("Telefone"), depois de Automático, visível só com
  a telefonia ligada na organização. `InboxAbas` mostra o selo com as ligações em
  `aguardando`, `tocando` e `transferencia_na_fila`, e ele cobra ação (cor de destaque).
- `InboxLayout`: com a aba Telefone, a coluna da lista troca `ConversationList` por
  `FilaDoTelefone`, e a faixa de busca e filtros de conversa dá lugar aos chips de
  time e ao seletor de número.
- Componentes novos em `components/telefonia/fila/` (`FilaDoTelefone`, `LinhaDaFila`,
  `ChipsDaFila`); a lógica pura (fase, ordenação, rótulos, contagem regressiva) em
  `lib/telefonia/fila.ts`; o hook em `hooks/telefonia/useFilaDoTelefone.ts`.
- Atualização: o hook refaz a leitura quando chega mudança de `voice_calls` pelo
  Realtime (`useRealtimeChannel`, com espera curta para juntar rajadas) e, de
  segurança, a cada 15 s; os relógios da tela andam sozinhos, sem leitura.
- A linha: posição, nome ou número, time, "pelo {número da empresa}", e o estado —
  "Aguardando há 3:42 · cai em 1:18" (em destaque quando passa da metade do teto),
  "Tocando para Ana", "Ouvindo as opções", "Com Bruno há 4:12".
- Clicar numa linha com conversa a abre à direita. Sem acesso pela regra de
  visibilidade, o painel mostra o estado que já existe para conversa não encontrada.
- Perdidas: "Ligar de volta" pelo mesmo caminho do `BotaoLigar`.
- A ligação transferida para a fila de um time (v2) aparece na fila desse time, com
  "Transferida por {nome}", sem ações.
- Configurações › Times: no bloco do telefone do time (onde já está o aviso de
  instabilidade), o seletor "Espera máxima na fila do telefone".

### 4.3 Entrega 3 — agir na fila

**Banco** (migration nova, a seguinte): tabela `voice_call_queue_orders` —
`organization_id` (FK com cascade), `voice_call_id` (FK composta com a organização),
`kind` (`pull` | `move`, `text` + `check`), `requested_by`, `to_user_id`,
`to_team_id`, `from_team_id`, `status` (`open` | `ended`), `outcome` (`done`,
`refused`, `no_answer`, `cancelled`), `reason`, `created_at`, `ended_at`. Índice
único parcial: uma ordem aberta por ligação. RLS de leitura por organização; nenhuma
escrita pela REST, com `revoke` explícito de `insert`, `update` e `delete` para
`anon` e `authenticated` no apêndice. Teste de isolamento entre duas organizações.

Tabela própria, e não tipos novos em `voice_call_transfers`: aquela pressupõe ligação
atendida e dono de origem, e o cartão lê a corrente dela como transferências.

**API:**

- `POST /api/v1/telefonia/chamadas/[id]/atender` — `agent`+. Confere: ligação
  recebida desta organização, viva, não atendida, já esperando por uma pessoa
  (`queued_at` preenchido); quem pede tem o ramal conectado e não está em outra ligação. Grava a ordem, emite o
  evento, responde 202. Recusas com motivo traduzido: não encontrada (404), já
  atendida, ainda no menu, encerrada, seu telefone está desconectado, você está em
  outra ligação, "{nome} já está atendendo" (409).
- `POST /api/v1/telefonia/chamadas/[id]/mover` — `manager`+, corpo `{ team_id }`.
  Confere a ligação como acima; o time é desta organização, não está arquivado, não é
  o atual e está dentro do horário (fora do horário: 409 com o motivo).
- As duas: `requireSupportWrite`, Zod, auditoria (`phone.queue_call_pulled`,
  `phone.queue_call_moved`). Se o evento não chega ao worker, a ordem fecha como
  `refused` (`telefonia_indisponivel`) e a rota responde 503 — a linha aberta travaria
  a próxima tentativa.

**Worker** — módulo novo `lib/channels/telefonia/ordens-da-fila.ts`, com ganchos para
o controlador, no molde de `transferencia.ts` (`controle.ts` já tem 1.961 linhas):

- **Atender:** relê a ordem, revalida (ligação viva e não atendida; ramal de quem
  pediu online e livre). Se a ligação toca para outra pessoa, derruba esse toque
  **sem contar como recusa** nem avançar o rodízio. Toca o ramal de quem pediu por
  10 s (`oferta,<id>`, com o cabeçalho `X-Fila-Atender: <ordem>`). Atendeu → o caminho
  de sempre (`ramalAtendeu`), ordem `done`. Não atendeu → ordem `no_answer` e a
  ligação volta ao ponto em que estava, com as voltas e o teto preservados.
- **Mover:** derruba o toque atual do mesmo jeito, chama `moverParaOTime` (que já
  troca o time da ligação e da conversa e grava o evento), zera as voltas e o relógio
  da espera, lê o teto do time novo e chama `tocarProximo`. Não repete "fora do
  horário" nem o aviso de instabilidade: a rota já recusou time fechado, e o cliente
  já está na fila. `queued_at` não muda (D10).
- Ligação que acaba com ordem aberta → `cancelled`. Reinício do worker → as abertas
  fecham como `cancelled` (`worker_reiniciou`), como as transferências.

**Navegador** (`TelefoniaContext`): `atenderDaFila(id)` chama a rota e guarda a ordem
por 15 s. Quando chega a INVITE com `X-Fila-Atender` igual à ordem guardada, atende
na hora, sem a tela de toque (D9). Em outra aba do mesmo atendente o ramal toca
normalmente e para quando a primeira atende.

**Tela:** em cada linha da fila, **Atender** (`agent`+) e **Mover** (`manager`+,
abre a lista de times com quantos estão livres). A recusa aparece com o motivo.
Enquanto há ordem aberta, a linha diz "Ana está atendendo…". O cartão da ligação
ganha as linhas "Puxada da fila por {nome}" e "Movida de {time} para {time} por
{nome}", com os nomes daquela hora (como as transferências).

## 5. O que não entra

- Dizer ao cliente a posição dele na fila (pediria voz gerada dentro da ligação, que
  a D15 da fase 2 proíbe).
- Retorno automático para quem desistiu.
- Relatórios de telefonia (F5 da spec 20) e painel fora do Inbox.
- Ações sobre a ligação transferida que espera na fila de um time (v2), teto por time
  para essa fila, e ordem unificada entre ela e a fila de entrada.
- Mudar a regra das 2 voltas (D7).
- Cartão em andamento na ligação feita.
- Puxar ligação que ainda está no menu ou ouvindo avisos (quem não ouviu o aviso de
  gravação até o fim não é gravado — D3 da gravação).
- Aumentar a faixa de portas de áudio.

## 6. Limites e riscos

- **Capacidade de áudio.** A instalação publica 40 portas (`20000-20039/udp`), cerca
  de 20 pernas de áudio simultâneas — lido na configuração, **não medido**. Ligação em
  andamento usa duas pernas; na fila, uma. Com teto longo num pico, a fila pode bater
  nesse limite. Medir na entrega 2; o ajuste, se preciso, é proposta à parte.
- **Linhas da operadora.** Não se sabe quantas ligações simultâneas o tronco aceita.
- **Rajada de eventos.** Cada toque escreve em `voice_calls`, e cada escrita chega a
  todo navegador com o Inbox aberto. O hook junta rajadas antes de reler; medir a
  carga da rota com a fila cheia.
- **Deploy.** Reiniciar o worker encerra como perdida a ligação que está no menu ou
  na fila (risco já aceito no desenho da fase 2, §11). Atualizar fora do horário ou
  esperar as ligações em curso acabarem, como na 1.54.0.
- **Duas filas.** A transferida para um time disputa os mesmos atendentes da fila de
  entrada, sem ordem comum entre as duas.

## 7. Como se prova

Por entrega, antes do PR:

- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` inteiro (sem caminho) e, nas
  entregas 2 e 3, `pnpm test:db` (instalação e atualização do baseline, e o isolamento
  da tabela nova).
- Testes do controlador com os dublês de `dubles-de-teste.ts`: cartão ao atender e
  atualização no fim; ordem de chegada com duas e três ligações e um atendente que
  desocupa; teto por time; atender com a ligação tocando para outro; mover de time;
  ordem que chega com a ligação já encerrada.
- Testes das rotas: permissão por papel, organização da sessão, cada recusa.
- Funções puras (`distribuicao.ts`, `lib/telefonia/fila.ts`) com tabela de casos.
- Spec e2e nova (`telefonia-fila.spec.ts`), com `voice_calls` semeadas, rodada pelo
  `Run workflow` na branch — o e2e não roda em PR.
- **Prova real** na VPS, no número de teste, com contas `agent` (nunca só a do dono):
  roteiro em `docs/runbooks/` por entrega, com evidência em `.superpowers/evidence/`.
- Merge, release e atualização da VPS: cada um com a autorização do dono.

Documentos a atualizar junto: spec 20 (tabela de fases), `docs/current-state.md`,
`docs/architecture/telefonia.architecture.json`, `docs/testing/user-journey-map.md`.

## 8. Living System Checklist

- **Quem me alimenta?** O worker da telefonia, que grava `voice_calls`
  (`repositorio.ts`), e a rota de ordens, chamada pela aba.
- **Quem eu alimento?** A aba Telefone do Inbox; o cartão da ligação na conversa; a
  lista Minhas (pela ordenação); a auditoria; o rodízio do telefone (ordem de chegada
  e teto).
- **Que atividade/log eu emito?** `api_audit_log` (`phone.queue_call_pulled`,
  `phone.queue_call_moved`, `phone.queue_wait_changed`); `conversation_events` pela
  troca de time e de dono, que os gatilhos já gravam; `voice_call_queue_orders` como
  história de cada ordem; o `voice_call.ended` e a atividade do contato, que já existem.
- **Onde eu apareço na tela?** Aba Telefone (`components/telefonia/fila/`); cartão em
  andamento e linhas de "puxada" e "movida" (`CartaoDaLigacao`); seletor do teto em
  Configurações › Times.
- **Por qual porta se chega até mim?** A aba fica dentro do Inbox, que já está no
  `NAV_CATALOG`; não há tela nova. O seletor do teto fica numa tela que já tem porta.
- **Qual meu mecanismo anti-morte?** Cartão em andamento órfão é consertado pela
  passada de 60 s; ordem aberta fecha no fim da ligação e no reinício do worker;
  ligação que esgota o teto segue virando "Ligar de volta" na Central.
- **Onde se configura o que eu uso?** Configurações › Times (ver e mudar o teto). Sem
  configuração vale o padrão de 2 minutos, que a tela mostra como valor atual.
- **Continuidade IA↔humano?** Não se aplica: a IA não participa da ligação (spec 20).
- **Qual meu laço de retorno?** O teto e a ordem de chegada decidem quem cai e quem é
  atendido. O sinal é a lista de perdidas com motivo e tempo de espera, na própria
  aba, lida por quem ajusta o teto do time e a escala. Relatório por período é a F5
  (dívida declarada).
- **Atualizei o mapa vivo?** `telefonia.architecture.json` ganha a rota da fila, a aba
  e as ordens, cada uma com pelo menos duas arestas — em cada entrega.
