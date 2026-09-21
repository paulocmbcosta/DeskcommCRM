# Doutrina de Restrição de Canal

> Lei de arquitetura para tudo que envia mensagem por um canal externo (WhatsApp WAHA,
> WhatsApp Cloud API oficial, e qualquer canal futuro). Complementa
> [`sistema-vivo.md`](./sistema-vivo.md) — não é aspiração, é critério de aceite.

---

## O princípio-raiz

**Todo canal restringe o que você pode enviar. A pergunta que decide a arquitetura não é
*"qual é a restrição?"* — é *"quem a impõe e o que acontece se eu violar?"***

Duas famílias de restrição, com física invertida:

| | **Auto-restrição** | **Hetero-restrição** |
|---|---|---|
| Quem impõe | **você a si mesmo** | **a plataforma a você** |
| Por quê | a plataforma te **bane** se abusar | a plataforma te **proíbe** e te **cobra** |
| Se violar | conta morre, silenciosamente, depois | request falha na hora, com código de erro |
| Exemplo | WAHA: throttle, jitter, warm-up, cap diário | Meta Cloud: janela de 24h, template aprovado, 1 msg/6s por destinatário |
| Natureza | **preventiva e probabilística** | **determinística e verificável** |
| Quem detecta a violação | ninguém — você descobre pelo prejuízo | a API, no retorno |

**Nenhuma é subconjunto da outra.** Generalizar anti-ban em "rate limit" apaga a lógica de
template. Generalizar janela em "posso enviar?" apaga o warm-up. Elas convivem como **regras
irmãs**, nunca fundidas.

---

## Os 4 invariantes (verificáveis)

### 1. Nenhuma feature nomeia um provider

Nenhum código fora de `lib/channels/` pode conter a string `waha`, `graph.facebook.com`,
`meta_cloud` ou equivalente. Features perguntam **capacidades**, nunca identidade.

```ts
// ERRADO — o if novo é a porta de entrada de toda regressão futura
if (session.provider === 'meta_cloud') { /* ... */ }

// CERTO — a feature descreve o que precisa, não com quem fala
if (!caps.freeformOutsideWindow) { /* ... */ }
```

- **Por quê:** cada `if (provider === ...)` é uma chance de alguém escrever o ramo novo e
  esquecer o antigo. É assim que uma implementação regride a outra.
- **Verificação:** `scripts/lint-channels.ts` reprova o vazamento no `gov:verify`. Provider
  novo não exige tocar em feature nenhuma. O reconhecimento do nome mora em
  `scripts/lint-channels.pattern.ts` — separado justamente para poder ser testado, porque o
  lint em si varre disco e chama `process.exit` ao ser importado. São **duas** fronteiras,
  uma por grafia (`waha_session_name` / `WAHA_API_KEY` vs. `WahaClient`); a #118 mostrou que
  uma catraca que enxerga só uma delas dá verde afirmando o que não verificou.

### 2. Toda restrição declara ORIGEM e FÍSICA

Uma capability nunca é um booleano solto. Ela diz de que família é, porque isso decide
**o que fazer quando ela barra**:

- **auto-restrição barrou** → adiar e tentar depois (a janela reabre, o cap zera à meia-noite).
  Vetar para sempre seria perder a mensagem por prudência.
- **hetero-restrição barrou** → mudar a forma da mensagem (usar template) ou escalar ao humano.
  Adiar não resolve: amanhã a janela de 24h estará ainda mais fechada.

- **Verificação:** a matriz de capabilities é exaustiva — capability sem linha para algum
  provider reprova o CI. Capability que nenhum provider declara é código morto e sai.

### 3. Cortesia não é anti-ban

Restrição que existe **para não incomodar o cliente** (horário comercial, evitar domingo,
fuso do tenant) vale em **todos** os canais e nunca é desarmada junto com o anti-ban.
Restrição que existe **para não ser banido** (throttle, jitter, warm-up, cap diário) só
arma onde há risco de ban.

- **Anti-exemplo real:** `PACING_DEFAULTS` fundia as duas. Ligar a API oficial desarmando o
  "pacing" levaria o horário comercial junto — e a IA passaria a acordar cliente às 3h da manhã.
- **Verificação:** um teste prova que, com `banRisk: false`, throttle/warm-up/cap **desarmam**
  e horário/domingo/fuso **continuam armados**. Como separar (tipos distintos, flag na decisão)
  é escolha de implementação; o invariante é o teste.

### 4. Restrição não aplicável é registrada, não omitida

Quando um gate não se aplica ao provider da vez, ele devolve `skipped: 'not_applicable'` —
**nunca** um `pass` silencioso, e nunca é removido da cadeia.

- **Por quê:** a diferença entre "não regrediu" e "**consigo provar** que não regrediu" é
  exatamente essa linha no `before_send_traces`.
- **Verificação:** todo gate da cadeia aparece no trace de todo envio, com veredito
  `pass` / `veto` / `skipped` + razão.

---

## Contrato de parâmetros — a regra que mata o mismatch

Aplicável a qualquer canal cuja plataforma hospede a definição da mensagem (templates Meta,
e-mail transacional de terceiro, etc.).

**A definição hospedada na plataforma É o schema. O contrato de parâmetros nunca é
redigitado — é derivado dela por função pura.**

Regras duras:

1. **Ninguém digita quantidade de parâmetro.** Não existe campo "número de variáveis" em
   tela, em jsonb, em nenhum lugar. Se existe, o mismatch é questão de tempo.
2. **Uma derivação, dois consumidores.** A mesma função pura alimenta (a) o formulário da
   tela e (b) o montador do payload de envio. Divergir vira impossível por construção, não
   por disciplina.

   ⚠️ **O consumidor (a) não existiu por meses, e esta linha não denunciava.** De 2026-07-28
   a 2026-09-19 `deriveTemplateContract` tinha um consumidor só — o montador. Nenhuma tela
   coletava um único valor: o seletor da janela fechada mandava `values: {}` e apontava para
   uma tela de administração que não envia. Como todo modelo de abertura pede ao menos o
   nome do cliente, **começar conversa pelo canal com hetero-restrição era impossível pelo
   produto** — e a regra aqui, lida como descrição, dizia o contrário. Regra de arquitetura
   afirma o que DEVE valer; que ela valha é o que o teste prende
   (`tests/unit/chamar-o-cliente-primeiro.test.ts`). Para conferir que os dois consumidores
   continuam existindo, sem acreditar nesta linha:

   ```bash
   grep -rln "deriveTemplateContract" --include="*.ts" --include="*.tsx" app/ components/ lib/
   ```
3. **Header e botões contam.** O contrato cobre todos os componentes com variável, não só o
   corpo. Contar só o body é a causa nº 1 do erro em produção.
4. **A chave é `(nome, idioma)`.** Nunca só o nome — variantes de idioma têm corpos diferentes.
5. **Bind por hash, não por nome.** Toda config que aponta para uma definição guarda o hash
   do contrato vigente quando foi salva. Hash divergente = config **obsoleta**: não envia,
   não adivinha, vira trabalho visível com o diff do que mudou.
6. **Erro de contagem da plataforma é bug NOSSO.** Se a API remota devolver "parâmetros não
   batem", isso não é erro do usuário: é falha da derivação. Vai para o Sentry como defeito,
   não para a tela como aviso.

---

## A segunda fronteira: plataformas de anúncio

Registrado em 2026-08-30, ao nascer o envio de conversões offline (migration 0213).

O invariante 1 diz "nenhum código fora de `lib/channels/` nomeia um provider". A frase
tratava `lib/channels/` como *a* fronteira porque, até aqui, só existia um tipo de
transporte externo. Reportar venda para a plataforma que trouxe o lead é o segundo — e
**não é canal**.

| | **Canal** (`lib/channels/`) | **Plataforma de anúncio** (`lib/plataformas-de-anuncio/`) |
|---|---|---|
| O que faz | entrega MENSAGEM a um contato | devolve um FATO sobre um contato |
| Tem destinatário | sim | não |
| Física que o governa | janela de 24h, template, ban, intervalo | idade do evento, dedup, formato de identidade |
| Capabilities | as de `capabilities.ts` (conte com `sed -n '/^export interface ChannelCapabilities/,/^}/p' lib/channels/types.ts \| grep -cE '^  [a-zA-Z]+: '` — esta célula dizia "sete" quando já eram oito) | nenhuma delas se aplica |

Uma linha em `CHANNEL_CAPABILITIES` respondendo "não se aplica" às sete colunas afirmaria
que isto é canal quando não é, e transformaria o invariante 2 em formulário preenchido com
nada. Pior: **os dois eixos são independentes**. Dá para receber lead de anúncio
clique-para-WhatsApp num número servido por qualquer transporte, então pendurar a credencial
de conversões em `channel_sessions` amarraria "reportar venda" a "ter canal oficial
conectado" — e quebraria justamente quem mais usa esse tipo de anúncio.

**O que NÃO afrouxa.** A entrada nova em `ALLOWED` (`scripts/lint-channels.ts`) é uma
fronteira da mesma natureza, não uma exceção de feature. Continua valendo que só a fronteira
nomeia o transporte: `lib/conversoes/` — a feature — pede ao registro pelo **slug da
plataforma** (`meta_ads`, o vocabulário que a 0164 já criou para a atribuição) e nunca
importa o transporte. Provado por construção: plantar `graph.facebook.com` em
`lib/conversoes/` reprova o `pnpm lint:channels`.

E o invariante 4 vale igual neste eixo. `google_ads` está **declarado sem transporte** no
registro — não ausente. A lacuna é anterior: sem extrator de `gclid` não há clique capturado
para reportar. Declarada, ela vira `skipped: 'plataforma_sem_transporte'` no livro-razão, que
a tela mostra; omitida, viraria `undefined` e o chamador a trataria como bug.

---

## Toda configuração tem superfície

Estende o invariante 3 do sistema vivo (*log universal e visível*) para o eixo da
**configuração**: log é sobre o que aconteceu; isto é sobre o que está **valendo**.

**Nenhum mecanismo de backend pode depender de estado configurável que não tenha tela para
ver, tela para mudar, e caminho visível de falha.**

- **Anti-exemplo real:** existir disparo de template por follow-up sem nenhuma área para
  ver ou configurar templates. O mecanismo funciona, mas é operável só por quem lê o banco —
  ou seja, não é operável.
- **Segundo anti-exemplo, e mais caro (issue #144):** o rodízio de atendimento
  (`settings.routing.mode`) e a restrição de visibilidade por atendente
  (`settings.visibility_mode`) existiam INTEIROS — worker, RLS, invariantes, tudo — e não
  tinham nenhuma tela. `visibility_mode` era lido em `app/app/layout.tsx` e escrito por
  ninguém. Um contribuidor abriu issue pedindo a feature que já estava construída, porque do
  lado de fora ela não existia.
- **A armadilha que o mesmo caso revelou:** a rota de escrita EXISTIA e era um no-op
  silencioso. A única policy de escrita de `organizations` é `fn_is_platform_admin()`; pelo
  client de sessão o UPDATE de um manager casa zero linhas, e o PostgREST devolve sucesso.
  A tela dizia "salvo" e nada era gravado. **Rota que grava e nunca foi exercitada por uma
  tela não conta como superfície** — conte só o que uma spec de frontend prova.
- **Verificação:** para todo estado configurável existe (a) rota de leitura na UI,
  (b) rota de escrita na UI, e (c) o que acontece quando falta configuração é **visível**
  (item de inbox / banner), nunca um `return` mudo no worker.

---

## Enforcement

| Camada | Mecanismo | Efeito |
|---|---|---|
| Lint | `scripts/lint-channels.ts` | nome de provider fora de `lib/channels/` reprova |
| Invariante | matriz capability × provider em `tests/unit/` | capability sem cobertura reprova |
| Invariante | suíte de canal congelada rodando com o provider legado | regressão silenciosa reprova |
| Trace | `before_send_traces` com `skipped` explícito | não-aplicação é auditável, não invisível |
| Invariante | varredura de `lib/channels/` em `tests/unit/canal-consulta-por-organizacao.test.ts` | consulta a `channel_sessions` por identificador de provider sem `organization_id` reprova |
| Trava no banco | índices únicos parciais da migration 0165 | dois canais ativos com o mesmo identificador de provider são recusados pelo Postgres |
| Gate de sessão | item no Living System Checklist (`sistema-vivo.md`) | nenhuma task de canal fecha sem responder |

---

## Provider não é meio — e o canal que não fala primeiro

Registrado em 2026-09-20, ao nascer o chat do site (migration 0272) — o primeiro canal que
não é WhatsApp.

Até aqui o invariante 1 nunca precisou distinguir duas coisas que sempre andaram juntas:

| | **Provider** | **Meio** |
|---|---|---|
| O que é | o TRANSPORTE — com quem o CRM fala | por onde o CLIENTE fala |
| Onde mora | `channel_sessions.provider` | `conversations.channel` |
| Exemplos | três transportes diferentes… | …que são todos `whatsapp` |
| Quem pode nomear | só `lib/channels/` | qualquer feature |

Três providers gravavam o mesmo meio, então a tela nunca precisou saber nada além de "é
uma conversa". Com o chat do site apareceu o segundo meio (`site_chat`), e com ele UMA
pergunta legítima de tela: ícone de telefone não serve numa conversa que veio de um site.
A resposta é `meioDoCanal()` — a feature lê o **meio**, e o `lint:channels` continua
reprovando o **provider** (`site_widget`) fora da fronteira. Não é afrouxamento: o que o
invariante 1 proíbe é o `if` sobre *com quem falamos*, e o meio não diz isso.

O nome do provider foi escolhido com `_` no meio de propósito. O guardrail de vocabulário
interno (`lib/agent-engine/guardrails/vazamento-interno.ts`) barra TODO nome de provider na
fala do agente, derivando desta mesma lista; um nome em linguagem natural barraria uma
resposta legítima justamente no canal que é um chat de site.

**A capability que nasceu de uma ausência.** `outboundFirst` é a primeira que existe
porque um canal NÃO consegue algo que todos os outros conseguem: o "endereço" do visitante
é um token que nasce no navegador dele, então quem nunca escreveu não tem endereço. É
restrição FÍSICA — nem auto nem hetero: ninguém a impõe, e não há o que adiar nem forma de
mensagem a trocar. O que fazer quando ela barra é **recusar antes**, em quem escolhe o
canal: `sessaoProntaParaEnvio` (automação) filtra por `PROVIDERS_QUE_FALAM_PRIMEIRO`, e
`openSharedContactConversation` — o funil único de quem abre conversa — devolve
`channel_cannot_start_conversation` (422). Sem ela, o chat do site seria escolhido como
"um canal qualquer", a mensagem seria gravada como enviada, e ninguém jamais a leria.

**O transporte somos nós.** O adapter deste canal não chama ninguém: a resposta do
atendente É a linha de `messages`, e o navegador a busca. Por isso `sent` aqui significa
"na caixa de saída", e é a LEITURA que promove a `delivered`
(`lib/channels/chat-do-site/leitura.ts`). O invariante 4 vale igual — janela de 24h e
anti-ban respondem `skipped: 'not_applicable'` a partir da matriz, em vez de sumirem da
cadeia — e a cortesia (invariante 3) continua armada: `banRisk: false` não desarma horário.

---

## Embedded Signup não cabe em self-host

Registrado em 2026-07-30, depois de o dono do repo questionar uma premissa que eu tinha
copiado sem verificar.

**Embedded Signup é a ferramenta de quem onboarda OUTRAS empresas** — Tech Providers e
Solution Partners. A documentação da Meta exige, antes de qualquer cliente entrar:

- **App Review com Advanced Access** para cada permissão (`whatsapp_business_management`,
  `whatsapp_business_messaging`);
- **Business Verification** + **Access Verification** — sem as três, o teto é 10 clientes
  por janela de 7 dias.

Num produto **self-host** isso não fecha, e os dois caminhos possíveis são ruins:

| Caminho | Por que não |
|---|---|
| Cada self-hoster vira Tech Provider | App Review e verificação de negócio **por instalação**. Semanas de processo antes do primeiro envio — ninguém instala. |
| O projeto vira o Tech Provider central | Deixa de ser self-host: o projeto passa a rodar infraestrutura, a estar no caminho dos dados de onboarding e a ter teto de clientes. |

**A arquitetura certa para self-host é BYO**, e não é uma limitação: o self-hoster já vai,
necessariamente, criar o próprio app na Meta e a própria WABA — sem isso não existe número
oficial. Colar as credenciais é o passo seguinte natural, não um remendo.

**O que melhora de verdade** não é substituir BYO por Embedded Signup; é dar superfície ao
BYO (invariante 6): tela de conexão que valida a credencial na hora (`GET /{phone_number_id}`),
mostra a URL de webhook e o verify token prontos, e guarda a credencial **por sessão de
canal, cifrada** — em vez de env global, que hoje limita a instalação a uma WABA só.

**Lição de método:** eu escrevi "Fase 5 = Embedded Signup" em três planos sem perguntar se
ela cabia no modelo do produto. Vinha do TomikCRM, que é SaaS — lá faz sentido. Premissa
copiada de outro contexto não vira verdade por estar escrita em três lugares.
