# Telefonia — transcrição e resumo das ligações gravadas (F4)

**Data:** 2026-10-09 · **Tarefa:** CU-124b4z9rr63 · **Migration:** 0298
**Relacionados:** spec 20 (`docs/specs/20-spec-telefonia-sip.md`, F3 e F4), o
desenho da gravação (`2026-09-29-telefonia-gravacao-das-ligacoes-design.md`) e a
transcrição do áudio do WhatsApp (`lib/inbox/transcricao-do-audio.ts`).

## 1. O pedido

O dono, em 2026-10-09: a ligação gravada só pode ser ouvida; ele quer também a
transcrição, "porque às vezes a gente não quer escutar a ligação". E ela é a
base de uma função futura — avaliar a técnica do atendimento (SPIN no comercial,
Customer Success no suporte) —, que fica FORA desta entrega.

Respostas dele ao estudo, no mesmo dia: sonda de qualidade com gravações reais
autorizada; além do texto, um **resumo**; **só as ligações daqui para frente**;
foco na transcrição; deixar pronto sem cortar release. As demais decisões deste
documento foram tomadas na ausência dele ("toma as decisões aí") e estão
marcadas como **sessão**.

## 2. O que foi medido antes de desenhar

### 2.1 O caminho que já existia não serve

A spec da gravação dizia (D7) que a F4 "só precisa emitir o
`media.derive_requested` que já transcreve o áudio do WhatsApp". Medido no
código (main `c3c3d823`), não se sustenta:

- a mensagem da ligação é `type = 'system'`; `workers/media-derive-worker.ts`
  recusa pelo tipo (`TIPOS_DERIVAVEIS`), a listagem só entrega derivado de
  `audio`, e os leitores de IA pulam `system`;
- `MAX_DERIVED_CHARS = 8000` cortaria cerca de 9 minutos de conversa;
- `messages` é lida pela REST e levada inteira pelo Realtime a qualquer membro
  que veja a conversa — inclusive o `viewer`, que não pode ouvir a gravação;
- não há estrutura: nem o tempo, nem quem falou.

### 2.2 O uso real (Totus, 30/09 a 09/10/2026, só contagens)

180 gravações, 242 minutos, 41,6 MB. Recebidas: 27 (mediana 2 min 47 s, maior
14 min 33 s). Feitas: 153 (mediana 13 s; 84 com menos de 15 s; maior 28 min
49 s). 98 escutas auditadas por 13 pessoas. As 153 feitas não têm time na
ligação. Projeção: ~730 min/mês.

### 2.3 A sonda de qualidade (10 gravações reais, de 1 s a 28 min 49 s)

Rodada dentro do worker de produção, sem escrever no banco; os textos foram
apagados da VPS em seguida.

| Modelo | O que se viu |
|---|---|
| `whisper-1` | Completo nas 10, inclusive a de 28 min 49 s (76 s de processamento; a de 10 min 44 s, 28 s). Devolve trechos com tempo. Erra nomes, endereços e o nome da empresa. |
| `gpt-4o-transcribe` | Perdeu fala em 4 das 5 ligações curtas (devolveu só o aviso de gravação, ou só a caixa postal). Recusa áudio acima de 1.400 s. |
| `gpt-4o-mini-transcribe` | Perdeu metade da ligação de 10 min 44 s (3.445 caracteres contra ~7.300). Recusou a de 28 min. |
| `gpt-4o-transcribe-diarize` (separa vozes) | Numa ligação de duas pessoas os rótulos viraram A, B, C, D; inventou frases em inglês durante a espera; levou 227 s na de 10 min 44 s; recusa acima de 1.400 s; cerca de 3× o custo. |

Outras três medições:

- **Vocabulário** (o nome da empresa como `prompt` do `whisper-1`): com ele, 2
  de 3 ligações voltaram só com a primeira frase. **Não usar.**
- **A regra padrão de "trecho inventado" do Whisper** (`no_speech_prob > 0,6` e
  `avg_logprob < -1`): não marcou nenhum trecho nas 10, e marcaria fala real
  ("Alô?") se fosse só pelo primeiro critério. Não é filtro.
- **Resumo e quem falou por um modelo de conversa** (o padrão da organização,
  `gpt-5.6-terra`), lendo os trechos numerados do `whisper-1`: nas 5 ligações
  testadas (5, 34, 117, 181 e 538 trechos) devolveu um rótulo para cada trecho,
  em ordem, em 2 a 16 s; os resumos conferiram com o que li; a conversa de fundo
  que o transcritor transformou em texto durante a espera foi marcada como
  ruído. A indicação de quem falou acerta a maior parte e erra em respostas
  curtas ("Isso.", um nome repetido).

**O que a sonda NÃO mediu:** taxa de erro por palavra (não há texto de
referência — eu não ouvi as gravações); ligações em espanhol; ligação com
transferência (três vozes); e o custo cobrado de fato.

## 3. Decisões

| # | Pergunta | Decisão | Por quê | Quem |
|---|---|---|---|---|
| T1 | Que transcritor? | `whisper-1`, sem vocabulário, com o idioma da organização. | Foi o único que não perdeu fala e aceitou a ligação longa (§2.3). | sessão |
| T2 | Como saber quem falou? | **Estimativa** por um modelo de conversa (ponto `resumo_de_ligacao`): ele devolve só o número de cada trecho e uma letra. A tela diz que é estimativa. | A gravação mistura as duas vozes num canal; o modelo que separa pelo som se mostrou instável. Exatidão pede gravar cada lado separado — mexe na ligação ao vivo e é tarefa própria (CU-124b4z9rr7x). | sessão |
| T3 | O modelo pode reescrever a ligação? | **Não.** O texto mostrado é o do transcritor, intocado. O modelo só escreve o resumo. | Um modelo "consertando" a fala inventaria o que ninguém disse. | sessão |
| T4 | Resumo? | Sim, curto (até 3 frases), no cartão; numa ligação longa só vale se TODOS os blocos responderem. | Pedido do dono. Um resumo que cobre só o começo, apresentado como o da ligação, seria pior que não ter. | dono / sessão |
| T5 | Onde mora? | Tabela própria `voice_call_transcripts`, **server-side only**; em `messages` vai só a situação. | §2.1: corte, estrutura e — principalmente — quem lê. | sessão |
| T6 | Quem lê? | Quem ouve: atendente ou acima que enxerga a conversa. O **resumo** vem com a conversa (pela listagem); o **texto inteiro**, só no clique, por rota que **audita** cada leitura. | É a gravação por escrito. Auditar cada carregamento da conversa seria ruído; auditar o clique é o equivalente da escuta. | sessão |
| T7 | Ligado por padrão? | **Não.** Interruptor próprio em Conexões › Telefone › Gravação; ligar exige a gravação ligada (na tela) e uma chave da OpenAI (na rota, 409). | Custa por minuto e manda o áudio a um terceiro: quem instala decide. | sessão |
| T8 | E as antigas? | Não são transcritas. `phone_settings.transcription_enabled_at` é a régua: só a ligação que terminou depois de ligar. Desligar e ligar de novo recomeça a contagem. | Decisão do dono. | dono |
| T9 | Onde roda? | No serviço do telefone do worker, na passada de 60 s, **uma por vez** — não na fila de eventos. | O dreno de `event_log` é serial e é ele que entrega a mensagem do cliente à IA; uma transcrição leva de segundos a minutos. | sessão |
| T10 | Pode custar a gravação? | **Não.** Começa depois de a gravação estar guardada; `anexarGravacao` não foi tocada; o gancho (`aoGuardar`) nunca muda o desfecho; pedido perdido é reposto pela passada. | A gravação é obrigação (SAC); a transcrição é conveniência. | sessão |
| T11 | Retenção? | A transcrição é apagada **junto com a gravação**. | É o mesmo conteúdo; guardá-la além do prazo reteria por outro caminho o que a retenção mandou apagar. | sessão |
| T12 | LGPD? | Anonimizar o contato apaga a transcrição, pelos dois caminhos de anonimização (trigger em `contacts.is_anonymized`) — mas só para quem anonimiza de verdade (função definer ou service key): o membro que escreve o campo direto pela REST não apaga nada. A exportação de dados do titular passa a dizer QUAIS ligações têm transcrição; o texto, como o áudio, não vai no relatório. | Apagar por qualquer escrita do campo daria a qualquer membro o poder de destruir transcrições de conversas que não enxerga e de forçar nova transcrição paga. E o `data.json` do relatório mora num bucket que qualquer membro lê (§5, item 7): pôr o texto ali furaria T6. | sessão, depois da revisão de segurança |
| T15 | E quem LÊ a transcrição de um contato anonimizado? | Ninguém: a listagem e a rota da leitura conferem o FATO (`contacts.is_anonymized`) e não entregam nada — nem a situação —, exista a linha ou não (`ligacoesDeContatoLiberado`, falha fechado). | T12 deixou um buraco, achado na revisão dos consertos: o contato que um membro marcou pela REST faz os dois caminhos de anonimização responderem "já estava" e saírem sem redigir, e a transcrição ficava na tabela, legível. A leitura não pode depender de o apagamento ter acontecido. O texto que sobra na tabela nesse caso sai com a gravação, no prazo de guarda (§5, item 10). | sessão, depois da terceira revisão |
| T13 | Custo visível? | Cada chamada ao transcritor e ao modelo vira linha em `llm_calls` (IA › Execuções). | Sem isso a transcrição seria um gasto de IA que a tela não mostra. | sessão |
| T14 | E o teto de gasto de IA? | Vale para a transcrição: antes de baixar o áudio, o MESMO gate do resto (`conferirOrcamento`). Com o teto estourado em modo de bloqueio, nada é enviado, e a ligação espera como numa falha. | O custo da transcrição entra na soma do mês. Sem o portão ela gastaria com o teto estourado — e gastaria o orçamento que mantém o agente respondendo o cliente sem nunca ser parada por ele. | sessão, depois das duas revisões |

## 4. Desenho

```
gravação guardada (gravacoes.ts)
   │ aoGuardar(org, ligação)          ← nunca muda o desfecho da gravação
   ▼
transcricoes.ts (worker do telefone, uma por vez)        passada de 60 s:
   pedir  ── só org com a transcrição ligada,            repõe o pedido perdido
             ligação terminada depois de ligar           e faz as pendentes
   baixar ── o MP3, pelo caminho canônico
   transcrever ── whisper-1 → trechos com tempo          (ponto transcricao_de_ligacao)
   resumir ───── modelo de conversa → resumo + letras    (ponto resumo_de_ligacao)
   concluir ──── voice_call_transcripts (ready | empty)
                 + messages.metadata.voice_call.transcricao = { situacao }
   ▼
tela: o Realtime da mensagem da ligação manda recarregar a conversa
   listagem ── entrega situação + RESUMO a atendente ou acima
   cartão ──── "Transcrevendo…" → resumo + "Ver transcrição"
   clique ──── GET /api/v1/telefonia/chamadas/<id>/transcricao → audita → falas
```

### 4.1 Onde mora cada coisa (DIRC)

- **`voice_call_transcripts.status`** (`pending` → `ready` | `empty` | `failed`)
  é a fonte da verdade. A linha guarda `text`, `segments` (jsonb lido só por
  `trechosDaTranscricao`), `summary`, e o controle de tentativas.
- **`messages.metadata.voice_call.transcricao`** é a projeção — **só a
  situação**. Serve para o cartão saber que há algo e para o Realtime avisar.
- **`phone_settings.transcription_enabled` / `_enabled_at`** é a política.

### 4.2 Falhas

Erro de rede, do provedor ou do Storage → a ligação volta para a fila (1, 5,
15, 60 min). Na 5ª tentativa, ou 24 h depois do pedido → `failed`, o cartão diz,
e a Central abre `phone_transcription_failed`. Sem chave, a Central é avisada já
na primeira ligação. O resumo que falha não derruba a transcrição.

A tentativa é contada quando a ligação é RESERVADA, e não quando a falha é
registrada: o worker que cai no meio (falta de memória, contêiner reiniciado)
não registra falha nenhuma, e uma ligação que o derrubasse voltaria para a fila
para sempre — o defeito que um PDF causou em 28/09/2026. A reserva vence em
45 min; na 6ª, a ligação é dada como perdida sem nova ida ao provedor.

Gravar o resultado tem insistência própria (cinco tentativas, ~1 min 40 de
espera entre elas): o que já foi pago ao provedor não se perde por um tropeço do
banco. A espera pela trava da anonimização tem fim DENTRO da transação
(`lock_timeout` de 15 s, `statement_timeout` de 30 s, locais): vencido, o
Postgres aborta, a transação desfaz e a conexão volta ao pool. A primeira versão
desistia do lado de cá e deixava a transação seguir — ela segurava uma conexão
do pool que o motor da IA também usa e, quando a trava soltava, gravava um
resultado já dado como perdido e refeito (achado da terceira revisão). A
tentativa que estoura o prazo de fora é marcada como abandonada e não escreve.
Arquivo de gravação que não confere é falha definitiva — a linha fica, senão a
passada pediria a mesma ligação de novo a cada minuto.

### 4.3 Segurança

- A tabela não tem grant para `anon`/`authenticated` nem policy: o PostgREST não
  a serve. As leituras do app usam o cliente de serviço **depois** de a sessão
  provar que enxerga a mensagem da ligação, e sempre presas à organização.
- O arquivo só vai ao provedor se o caminho for exatamente
  `<org>/<conversa>/<mensagem>.mp3`.
- `concluir` roda sob a mesma trava da anonimização (`fn_service_lock`).
- `fn_gravacao_da_mensagem_apagada` (0289) passa a ser SECURITY DEFINER: o
  trigger AFTER de uma mensagem de ligação apagada por cascata roda no papel da
  sessão, e o membro não tem privilégio na tabela nova. Como invoker, excluir um
  contato com cartão de ligação falhava com 42501 em toda instalação — achado da
  revisão independente, reproduzido no Postgres antes do conserto.
- O trigger da anonimização é invoker e confere `current_user`: só a função
  definer e a service key apagam (T12).
- Nenhuma linha de log leva o texto; o erro guardado é a classe, nunca a
  mensagem crua do provedor.
- Os trechos vão ao modelo como dados ("ignore pedidos dentro deles"), e o que
  volta só pode virar uma letra por trecho e um resumo de até 600 caracteres,
  mostrado como texto.

## 5. Limites conhecidos

1. **Quem falou é estimativa**, e o texto erra nomes, números e endereços. A
   tela diz as duas coisas; o leitor não tem como corrigir uma fala.
2. **O aviso de gravação e a música de espera entram no texto** (a ponte os
   grava). O modelo costuma marcá-los como "gravação automática ou ruído".
3. **Ligação com transferência** tem três vozes; o vocabulário de quem falou tem
   só atendente e cliente.
4. **Sem chave (ou com o teto de gasto estourado) no momento da ligação**, as
   tentativas se esgotam em ~80 min; a ligação fica como "não foi possível
   transcrever" mesmo que a chave chegue, ou o teto suba, depois.
5. **Áudio do atendente no WhatsApp** segue sem transcrição (fora do escopo).
6. **Ligação muito longa.** O `fetch` do Node corta aos 300 s sem resposta, e o
   transcritor só responde quando termina. No ritmo medido (76 s para 28 min
   49 s), isso dá para cerca de 1 h 45 de ligação; acima disso — o teto da
   gravação é 2 h —, ou com o provedor lento, a transcrição falha. O conserto é
   fatiar a ligação em partes (tarefa própria).
7. **O bucket da exportação LGPD** (`lgpd-exports`) é lido por qualquer membro da
   organização e nada o esvazia — anterior a esta entrega, e a razão de o texto
   da ligação não ir no relatório (T12). Tarefa própria.
8. **A mensagem de erro do provedor de conversa** fica em `llm_calls` quando o
   resumo falha (até 500 caracteres, visível a gestor em IA › Execuções). É o
   comportamento do seam para todo ponto de IA; se um provedor ecoar o pedido,
   um pedaço da transcrição iria junto. O transcritor grava só a classe do erro.
9. **Super-admin em sessão de acompanhamento completa** lê resumo e texto como
   admin da organização — e fica na auditoria com o id dele, como na escuta.
10. **Contato marcado como anonimizado por um membro, pela REST, antes da
    anonimização de verdade.** A RLS de `contacts` deixa qualquer membro escrever
    `is_anonymized` (dívida anterior, tarefa própria). Nesse caso a anonimização
    de verdade responde "já estava" e não redige NADA — mensagens, gravação e
    transcrição. A transcrição deixa de ser lida pelo produto (T15), mas o texto
    fica na tabela, ao alcance só da service key, até a gravação vencer.
11. **Banco sem gravar por mais de ~3 min depois de a transcrição ficar pronta**
    (fora do ar, ou uma trava presa): a ligação é reagendada e transcrita de
    novo, paga de novo. A chamada ao transcritor custa centavos; guardar o
    resultado fora do banco para não pagar duas vezes não valeu a complexidade.
12. **A cada atualização, 44 funções do banco voltam por um instante à definição
    antiga** — o `update.sh` reaplica o baseline inteiro, e cada bloco antigo
    recria a função antes de o bloco novo consertá-la. Para a função que leva a
    transcrição junto com a mensagem apagada isso deixava transcrição órfã, e foi
    fechado (as duas cópias no baseline são idênticas, com cerca; o corpo confere
    com `to_regclass` se a tabela já existe, porque na primeira atualização de um
    banco antigo a função é recriada antes de a tabela nascer; e o trigger dela
    passou a ser criado só se faltar, em vez de derrubado e recriado). Para as
    outras 43 funções, e para os demais triggers que o baseline derruba e recria
    a cada atualização, o efeito não foi avaliado — tarefa própria.
13. **A gravação em ÁUDIO segue audível no caso do item 10** (contato marcado por
    um membro antes da anonimização de verdade): a rota da escuta não confere
    `contacts.is_anonymized`. É anterior a esta entrega e tem a mesma raiz — a
    RLS de `contacts` —, registrada na tarefa dela. A transcrição, que é o que
    esta entrega acrescenta, não é entregue.

## 6. Prova

- Unidade: regras puras, o pedido e a leitura do resumo, o transcritor, o
  serviço com dublês (caminho feliz, cada falha, blocos, o gancho), as rotas, a
  listagem, o cartão e a aba Gravação.
- Postgres real (`tests/invariants/telefonia-transcricao.test.ts`): grants,
  "só daqui para frente", reserva (com a tentativa contada nela), concluir,
  anonimização pelos dois caminhos e o membro pela REST, falha, poda, mensagem
  apagada — inclusive por um MEMBRO, pela cascata —, política.
- Uma terceira revisão, só sobre os consertos das duas primeiras, achou cinco
  defeitos novos — a transcrição que sobrevivia à anonimização quando um membro
  marcava o contato antes, a transação abandonada que gravava depois, a função
  que voltava ao estado antigo a cada atualização, o aviso de teto apontando a
  tela errada e a exportação que dizia "sem transcrição" quando a leitura
  falhava. Os cinco foram consertados com prova própria.
- Uma quarta leitura, só sobre esses cinco consertos, não achou defeito grave e
  achou dois efeitos na atualização de quem já instalou: o conserto da função
  fazia a exclusão de conversa com ligação falhar por um instante na primeira
  atualização (a função citava a tabela antes de ela existir), e o trigger era
  derrubado e recriado a cada atualização. Os dois fechados, o primeiro com
  prova no Postgres.
- Duas revisões independentes (correção e segurança), sem as conclusões de quem
  escreveu: acharam a exclusão de contato quebrada, a exportação que copiaria o
  texto para um bucket aberto, o membro apagando transcrição pela REST, o teto
  de gasto ignorado e o prazo do transcritor que não existia. Todos consertados
  nesta entrega, cada um com a sua prova.
- Tela: `tests/e2e/telefonia-transcricao.spec.ts` (J48 do mapa de jornadas).
- **Falta a prova real**: uma ligação gravada com a transcrição ligada em
  produção — depende de release e de o dono ligar o interruptor.
