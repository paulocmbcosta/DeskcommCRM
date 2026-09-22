# A IA identifica o cliente no IXC e envia a cobrança — design

> Fase 4 do conector IXC (a spec-mãe é
> [`2026-09-19-conector-ixc-design.md`](2026-09-19-conector-ixc-design.md), §10 e §10.1).
> Aprovada pelo dono em 2026-09-22, depois das perguntas abaixo. Cliente de origem: a
> Totus (provedor de internet), agente "Bia - 3025", número oficial via API da Meta.

## 1. O pedido e as decisões do dono

> O cliente vai chamar, vai dar o CPF, e a IA envia o boleto e o Pix dele. **Sempre só o
> mais atrasado de todos; se não houver nenhum atrasado, o próximo a vencer. Nunca dois de
> uma vez** — e assim sucessivamente. *(dono, 22/09)*

| # | Decisão | Quando |
|---|---|---|
| D1 | **Identidade antes de dinheiro.** Telefone da conversa que bate com UM cadastro basta. Com 2+ cadastros no telefone, o CPF escolhe entre ELES (o telefone já é a prova). Sem cadastro no telefone: **CPF + data de nascimento**, os dois conferidos. Só o CPF não basta. Nunca dizer qual dos dois não conferiu. Na 3ª falha, passa para a Cobrança. | 21/09, confirmada 22/09 |
| D2 | **Uma fatura por vez:** a mais atrasada; sem atrasada, a próxima a vencer. Nunca duas. | 22/09 |
| D3 | **Pix é o padrão**, sem perguntar. Se o cliente, depois de receber o Pix, quiser boleto, a IA manda o boleto **da mesma fatura**. | 22/09 |
| D4 | **Cliente bloqueado:** a IA manda a cobrança e explica que a liberação acontece depois que o pagamento compensar, sem prometer prazo. | 22/09 |
| D5 | **Fatura com mais de N dias de atraso** (qualquer cliente, bloqueado ou não): a IA **não** envia; diz que a fatura foi encaminhada ao setor de cobrança e transfere para o time de Cobrança. **N é ajustável na tela**, padrão **60**. | 22/09 |
| D6 | **Sem como cobrar** (sem boleto registrado E o IXC recusou gerar o Pix): transfere para a Cobrança. | 22/09 |
| D7 | Configuração pela tela, nunca por SQL. Publicar a versão nova da Bia e fazer deploy são decisões do dono. | 21/09 |

## 2. O que já existe e é reusado (não reescrito)

- `lib/conectores/ixc/enviar-cobranca.ts` — `enviarCobrancaIxc`, a ÚNICA função que envia
  boleto/Pix. Relê a fatura, exige cadastro vinculado, status A, boleto registrado (só para
  boleto), `%PDF`, CRC16, Pix `ATIVA`. Recebe as portas `guardarArquivo` e `enviar`.
- `lib/conectores/ixc/painel.ts` — `estadoDoPainelIxc`, a máquina de estados de identificação
  (vinculado / escolher / nao_encontrado / vinculo_sem_cadastro).
- `lib/conectores/ixc/identificar.ts` (`clientesPorTelefone`, `clientesPorDocumento`),
  `mascara.ts` (`documentoNaMascara` com dígito verificador), `faturas.ts` (`lerFatura`,
  `hojeEmSaoPaulo`), `resumo.ts` (`montarResumo`, `situacaoDoCliente`).
- `lib/conectores/vinculos.ts` e `lib/conectores/conexao.ts` (`lerCredencial`).
- O motor: `send_template` já é o molde de ferramenta nativa que envia pela cadeia
  `runBeforeSend` → `liveChannel().send` → `sendTurnMessage` → ledger → `sendMessageHandler`.

## 3. Achados que mudaram o desenho

1. **O chat do site grava o telefone DIGITADO em `contacts.phone_number`**
   (`lib/channels/chat-do-site/entrada.ts:29`, quando não pertence a outro contato). Se a IA
   aceitasse "telefone bate com 1 cadastro" ali, quem digitasse o celular da Maria receberia
   o boleto dela. **O painel do atendente já tem esse furo hoje:** `estadoDoPainelIxc` vincula
   sozinho pelo telefone, qualquer que seja o canal. Conserto nesta entrega (§6.4).
2. **Os gates de CONTEÚDO da saída vetariam a cobrança.** `promiseGate` barra valor em R$
   fora da tabela de promessas; `spinningGate` barra o mesmo Pix reenviado; o copia-e-cola
   traz UUID, que `internalVocabularyGate` pega. Eles existem para texto escrito pelo
   MODELO; a cobrança é texto do SISTEMA, conferido no ERP (§7.2).
3. **Todo item do catálogo de capacidades exige handler MCP** (`lib/mcp/tools/index.ts`
   reprova catálogo sem handler e vice-versa). A tela de capacidades é catálogo; a ferramenta
   que envia tem de ser nativa do motor (§5.3).

## 4. Escopo

**Entra:** duas ferramentas nativas do motor; a costura por `DefinicaoDeConector`; mídia na
saída do motor; o limite de dias ajustável na tela (migration 0274); o conserto do painel
(telefone só é prova em canal onde ele é identidade); prova em unidade, invariante e tela.

**Fica fora:** bloco do IXC na ABERTURA do turno (as ferramentas bastam e só custam IXC
quando a conversa é de financeiro/suporte); índice da base (fase 5); escrita no IXC —
desbloqueio de confiança, abrir OS (fase 6); funil "Assinantes"; a versão 2 da Bia
(prompt + capacidades ligadas), que o dono publica depois do deploy.

## 5. Arquitetura

```
 inbound-turn.ts ──(espalha)──► agent/ferramentas-do-conector.ts   ← NOVO, no motor
                                   │  importa SÓ lib/conectores/{registro,conexao,vinculos}
                                   │  e lib/channels/capabilities (telefoneEhIdentidade)
                                   ▼
                     registro.obterConector("ixc").agente     ← campo novo, opcional
                                   │
                     lib/conectores/ixc/agente.ts             ← NOVO, na pasta do IXC
                     (estadoDoPainelIxc · clientesPorDocumento · faturaDaVez · enviarCobrancaIxc)
                                   │ portas
                                   ▼
   guardarArquivo → Storage `whatsapp-media` (<org>/<conversa>/cobranca-<8hex>/<nome>.<ext>)
   enviar         → runBeforeSend(conteudoDoSistema) → liveChannel().send({ media }) → ledger
```

### 5.1 O contrato do conector (sem IXC no nome)

`lib/conectores/tipos.ts` ganha, opcional em `DefinicaoDeConector`:

```ts
agente?: CapacidadeDoAgente;

interface CapacidadeDoAgente {
  consultar(p: PedidoDeConsulta): Promise<ResultadoDaConsulta>;
  enviarCobranca(p: PedidoDeCobranca): Promise<ResultadoDaCobranca>;
}
```

Os tipos falam de **cliente, situação, fatura, forma** — nunca de `fn_areceber` ou
`cnpj_cpf`. Conector sem cobrança (a imobiliária de amanhã) não declara `agente`, e as
ferramentas não entram no turno dela. `lib/conectores/ixc/agente.ts` implementa; `index.ts`
do IXC pendura em `conectorIxc.agente`. A cerca (`tests/unit/conectores-cerca.test.ts`)
continua valendo: o motor importa o registro, nunca `conectores/ixc`.

### 5.2 As ferramentas no motor

`lib/agent-engine/agent/ferramentas-do-conector.ts` monta as duas ferramentas com a
conversa, o contato, o canal e o job FECHADOS no closure — o modelo nunca passa contato,
conversa nem id de fatura. `inbound-turn.ts` só as inclui em `rawTools`. Entram quando:

1. o agente publicado tem o id ligado em `tool_ids` (a tela de capacidades), **e**
2. a organização tem uma conexão de conector que declara `agente`.

Ligada na tela e sem conector na organização: a ferramenta não entra, e o turno abre aviso
na Central pelo mecanismo que já existe para capacidade ausente (`avisarCapacidadesAusentes`)
— a falha não fica num log que ninguém lê.

Envio entra em `FERRAMENTAS_DE_ENVIO` (`lib/agent-engine/edge/llm/fila-de-envio.ts`): as
mensagens da cobrança saem na ordem em que o modelo pediu, junto com as do `send_message`.

### 5.3 A capacidade na tela

Dois itens novos no catálogo, domínio próprio `lib/mcp/tools/catalogo/sistema-de-gestao.ts`,
pacote **"Atender e responder"**:

| id (contrato de wire) | category | rótulo na tela | risco |
|---|---|---|---|
| `crm_consultar_cliente_erp` | read | Consultar o cliente no sistema de gestão | seguro |
| `crm_enviar_cobranca_erp` | write | Enviar a cobrança do cliente (Pix ou boleto) | atencao |

Os handlers MCP (`lib/mcp/tools/sistema-de-gestao.ts`) existem pela paridade
catálogo×handler e **recusam** fora de uma conversa atendida pelo agente — um cliente MCP
externo não tem conversa para amarrar, e abrir o ERP por contato a uma integração é
superfície nova que ninguém pediu. No turno, o nome nativo tem precedência
(`if (name in rawTools) continue`, já existente).

`GET /api/v1/mcp/tools` só serve os dois itens à organização que tem conector com `agente`:
quem não tem IXC não vê capacidade que nunca funcionaria.

## 6. Identidade — `crm_consultar_cliente_erp`

### 6.1 Entrada

```ts
{ cpf_cnpj?: string; data_nascimento?: string /* AAAA-MM-DD */ }
```

A descrição para o modelo diz: chame sem argumentos primeiro; peça ao cliente só o que a
ferramenta pedir; converta a data que ele digitar para AAAA-MM-DD.

### 6.2 A máquina de estados

"Telefone verificado" = o telefone é a identidade do transporte. Capacidade nova do canal,
`telefoneEhIdentidade` em `CHANNEL_CAPABILITIES` (`lib/channels/capabilities.ts`): `true`
para WAHA, Meta e Zernio; `false` para `site_widget`. A feature lê a capacidade, nunca
compara provider.

| Situação | Resultado para o modelo | Efeito |
|---|---|---|
| Vínculo existente (`documento` ou `manual`; ou `telefone` com telefone verificado) | `identificado` + projeção (§6.3) | — |
| Sem vínculo, telefone verificado, 1 cadastro no telefone | `identificado` | vincula `telefone` |
| Sem vínculo, telefone verificado, 2+ cadastros, sem CPF | `precisa_cpf` | — |
| 2+ cadastros no telefone, CPF de um deles | `identificado` | vincula `documento` |
| Nenhum cadastro no telefone, CPF fora dos do telefone, ou telefone NÃO verificado, sem os dois dados | `precisa_cpf_e_nascimento` | — |
| CPF + nascimento batem com cadastro(s) do CPF | `identificado` | vincula `documento` (todos os cadastros daquele CPF com aquele nascimento, até o teto) |
| CPF com dígito verificador errado, ou data que não é data | `cpf_invalido` / `data_invalida` — **não conta tentativa** | — (é conta, não consulta: não revela se o CPF é de alguém) |
| Qualquer outra combinação (CPF inexistente, nascimento diferente, cadastro sem nascimento) | `nao_conferiu` + `tentativas_restantes` | audita `conector.identificacao_recusada` |
| 3 recusas no atendimento atual | `tentativas_esgotadas` | — |

- **Resposta única para toda recusa.** "CPF não existe", "nascimento não bate" e "cadastro
  sem nascimento" devolvem o MESMO `nao_conferiu` — dizer qual seria confirmar a um curioso
  que o CPF é de alguém.
- **A contagem** é das linhas `conector.identificacao_recusada` com `resource_id` = a
  conversa e `created_at >= conversations.service_started_at` (o atendimento atual). O índice
  `idx_audit_resource` cobre. A escrita dessa auditoria é **aguardada** (é contador, não
  telemetria). Cliente que volta noutro atendimento recomeça do zero.
- **A data de nascimento nunca entra em `ClienteIxc`**, que vai ao navegador no painel. Ela é
  lida só na conferência, com uma lista de campos própria (`CAMPOS_DA_CONFERENCIA` =
  `CAMPOS_DO_CLIENTE` + `data_nascimento`), comparada e descartada. O formato é medido na
  sonda de §12 antes de entrar na lista branca.
- Vínculo `telefone` num canal sem telefone verificado **não conta** para a IA (pode ter
  nascido do furo do painel antes deste conserto).

### 6.3 O que a IA vê (decisão de 21/09)

```json
{
  "ok": true, "estado": "identificado",
  "cliente": {
    "primeiro_nome": "Maria", "situacao": "Bloqueado", "motivo_da_situacao": "financeiro em atraso",
    "bloqueado": true, "plano": "Fibra 500 Mega", "cliente_desde": "10/03/2024",
    "conexao": "offline", "tem_os_aberta": true
  },
  "financeiro": {
    "vencidas": [{ "vencimento": "14/07/2026", "valor": "R$ 129,90", "dias_de_atraso": 70 }],
    "proxima": { "vencimento": "12/10/2026", "valor": "R$ 129,90" },
    "total_vencido": "R$ 389,70",
    "fatura_da_vez": { "vencimento": "14/07/2026", "valor": "R$ 129,90", "dias_de_atraso": 70,
                        "vai_para_a_cobranca": true }
  },
  "orientacao": "A fatura da vez tem mais de 60 dias de atraso: não envie a cobrança. Diga que ela foi encaminhada ao setor de cobrança e transfira para o time de Cobrança."
}
```

**Nunca:** ids (do cliente, do contrato, da fatura), CPF, endereço, IP, MAC, login, senha,
protocolo de OS. Valores e datas já formatados — o modelo não faz conta de dinheiro.
`orientacao` é a frase curta que a regra do dono pede na situação (bloqueado: "a liberação
acontece depois que o pagamento compensar, sem prometer prazo"; fatura acima do limite:
"diga que foi encaminhada ao setor de cobrança e transfira para o time de Cobrança"). Seção
do resumo que falhou vira `"indisponivel"` no campo, nunca invenção.

### 6.4 O conserto do painel

`estadoDoPainelIxc` ganha `telefoneEhIdentidade: boolean`. Sem ele verdadeiro, a busca por
telefone continua (o atendente vê os candidatos), mas **1 candidato não vincula sozinho**:
cai em `escolher`, como 2+. Quem chama (a rota do painel) resolve a capacidade pelo canal da
conversa; conversa sem canal conhecido = falso (fail-closed).

## 7. Enviar — `crm_enviar_cobranca_erp`

### 7.1 Entrada e regra

```ts
{ forma?: "pix" | "boleto" }   // padrão "pix" (D3)
```

Sem id de fatura, de propósito: a ferramenta escolhe, e é por construção que "nunca duas"
vale (D2). **A fatura da vez** = entre as faturas abertas de TODOS os cadastros vinculados,
a vencida mais antiga; sem vencida, a que vence primeiro (`faturaDaVez`, pura, em
`lib/conectores/ixc/faturas.ts`). Pedir boleto depois do Pix = mesma fatura, forma boleto.

| Caso | Resultado | O que a IA faz (vem em `orientacao`) |
|---|---|---|
| Sem vínculo válido | `cliente_nao_identificado` | chamar `crm_consultar_cliente_erp` |
| Nenhuma fatura aberta | `sem_fatura_em_aberto` | dizer que não há fatura em aberto |
| `dias_de_atraso` > limite (D5) | `encaminhar_para_cobranca` — **nada é enviado** | dizer que foi encaminhada ao setor de cobrança e transferir para Cobrança |
| Boleto pedido e não registrado | `boleto_indisponivel` | oferecer o Pix (o cliente escolheu boleto: trocar sem perguntar seria desfazer a escolha dele) |
| Pix recusado/inativo/corrompido e **boleto registrado** | a ferramenta envia o **boleto da mesma fatura** e diz `forma: "boleto"`, `pix_indisponivel: true` | contar que o Pix não pôde ser gerado e que foi o boleto. Leitura de D3+D6: só quando as DUAS formas falham é que se transfere |
| Pix recusado e sem boleto (D6), ou boleto pedido com PDF indisponível | `sem_como_cobrar` (+ frase do IXC, só para a nota de transferência) | transferir para Cobrança |
| Enviada | `enviada` + forma, vencimento, valor, `mensagens` (2) | não repetir o código; no máximo 1 mensagem curta depois |
| Saiu só o arquivo | `enviada_em_parte` | avisar e transferir |

O que chega ao cliente são as DUAS mensagens de `enviarCobrancaIxc` (arquivo com legenda +
código sozinho). Nenhum texto do modelo entra nelas.

### 7.2 A saída do motor ganha mídia

- `ChannelSendInput` (`lib/agent-engine/channel-adapter.ts`) e `SendMessageInput`
  (`edge/crm/send-message.ts`) ganham, opcional:
  `media?: { kind: "document" | "image"; storagePath: string; mime: string; sizeBytes: number }`.
  Adapter que não conhece o campo envia só o `body` (a legenda) — degrada, não estoura.
- `sendTurnMessage` passa `type: media.kind` + `media_storage_path/mime/size_bytes` ao
  `sendMessageHandler`. Ledger `(job_id, seq)` como sempre: o hash é do corpo, então um
  retry pós-crash (arquivo novo, mesma legenda) é reconhecido como já enviado.
- `RunBeforeSendArgs` ganha `conteudoDoSistema?: boolean`. Ligado: `spinning` e `promise`
  entram no trace como `skipped` com o código `conteudo_do_sistema` (nunca `pass` mudo);
  semântica de promessa, caso e agenda não são armados; `internalVocabulary` fica desligado.
  **Continuam valendo:** stop/opt-out, LGPD, ritmo anti-ban, janela e aviso de IA
  (disclosure). A composição da cadeia não muda (sem bump de versão da ordem).
- Cada mensagem avança `seq`. A ferramenta exige **2 vagas** no teto do turno
  (`DEFAULT_MAX_SENDS_PER_TURN = 3`) antes de pedir qualquer coisa ao IXC; sem vaga, devolve
  `max_sends_per_turn` explicando que a cobrança vem antes do texto. A descrição da
  ferramenta diz isso ao modelo.
- Veto de gate numa das mensagens (ex.: opt-out) devolve o código ao modelo e para ali.

### 7.3 Auditoria

- `conector.fatura_enviada` — a MESMA ação do botão, metadata igual (fatura, forma,
  vencimento, valor_cents, mensagens enviadas/previstas, `pix_gerado_agora`) + `ator:
  "ai_agent"` e `agente_id`. `actorUserId` nulo.
- `conector.vinculo_criado` quando a consulta vincula (verificado_por, `ator: "ai_agent"`).
- `conector.identificacao_recusada` (ação nova) — sem CPF nem data no metadata; só o
  motivo interno para quem investiga (`documento_invalido` / `nao_conferiu`).
- `conector.cobranca_encaminhada` (ação nova) quando D5 barra o envio — é o registro de que
  a IA NÃO mandou e por quê (dias de atraso, limite).

## 8. O limite de dias — configuração pela tela

- **Migration 0274** `conector_cobranca_limite_de_dias`: `alter table conector_conexoes add
  column if not exists cobranca_encaminha_apos_dias integer not null default 60` + CHECK
  `between 1 and 3650` criado só se faltar. Tripla completa: arquivo, apêndice idempotente no
  `baseline.sql`, linha no MANIFEST. Sem dados a corrigir (o default preenche).
- `lerConexaoPublica` passa a devolver o campo; a tela Configurações › Conectores mostra, no
  cartão do IXC, "Faturas com mais de **N** dias de atraso vão para a Cobrança (a IA não envia,
  transfere)". Salvar: `PATCH /api/v1/conectores/[conector]/conexao` com
  `{ cobranca_encaminha_apos_dias }`, `admin`, `requireSupportWrite`, Zod, auditoria
  `conector.preferencias_alteradas`. Não pede o token de novo.

## 9. Botão Testar (prévia)

As duas ferramentas entram na lista de propostas de `applyPreviewPolicy`: viram
`proposal_only` — nada é consultado no IXC, nada é vinculado, nada é enviado. A prévia mostra
que a IA TENTARIA consultar/enviar, que é o que quem afina o prompt precisa ver.

## 10. Erros e o laço de retorno

| Falha | O que o cliente vê | O que muda no sistema |
|---|---|---|
| Credencial recusada / IXC fora | a IA diz que não conseguiu consultar agora e transfere | `carimbarEstado("erro")` — Configurações › Conectores mostra o motivo; log do turno |
| Capacidade ligada, conector removido | nada de estranho: a ferramenta não existe no turno | aviso na Central (`avisarCapacidadesAusentes`) |
| Recusa de identificação | "não conferiu", até 3 | auditoria; na 3ª, transferência |
| Fatura acima do limite | "encaminhada ao setor de cobrança" + transferência | `conector.cobranca_encaminhada` |
| Veto de gate (opt-out, janela) | nada sai | trace de before-send, como qualquer envio |
| Saiu só o arquivo | a IA avisa e transfere | audit com `mensagens_enviadas < previstas` |

## 11. Prova

**Unidade (`pnpm test:unit`):**
- `lib/conectores/ixc/agente.test.ts` — a máquina de §6.2 inteira, a resposta única, a
  projeção sem id/CPF/endereço/IP/MAC (asserção sobre o JSON serializado), `faturaDaVez`
  entre dois cadastros, o limite de dias, cada recusa de §7.1.
- `faturas.test.ts` — `faturaDaVez`: vencida mais antiga vence a próxima; sem vencida, a que
  vence primeiro; empate; nenhuma.
- `painel.test.ts` — 1 candidato com `telefoneEhIdentidade=false` cai em `escolher` e não
  vincula.
- Saída com mídia: `send-message` passa `document`/`image` ao handler; `conteudoDoSistema`
  deixa `spinning`/`promise` como `skipped` e mantém `stop` vetando.
- `applyPreviewPolicy` — as duas viram proposta.
- Cerca, catálogo leigo, alcançabilidade e paridade catálogo×handler seguem verdes.

**Invariante (`pnpm test:db`)** — `tests/invariants/ia-envia-cobranca.test.ts`: turno REAL
dentro de `withServiceJob` (molde de `envios-do-turno-saem-na-ordem.test.ts`), modelo
roteirizado (consultar → enviar → uma frase), IXC falso HTTP, canal capturando: 2 envios com
`media` na ordem, ledger com 2 linhas, `conector.fatura_enviada` com `ator: ai_agent`,
vínculo `telefone` criado; e o caso > limite: zero envio, `conector.cobranca_encaminhada`.
Cada caso é sabotado (tirar a checagem de limite, trocar a ordem da escolha) e fica vermelho.

**Tela (`tests/e2e/conector-ixc-no-painel.spec.ts`, estendida)** — o IXC falso ganha
`data_nascimento` e um cliente com a vencida mais velha acima do limite:
1. o admin muda o limite em Configurações › Conectores e ele persiste;
2. no editor do agente, as duas capacidades aparecem (e não aparecem para organização sem
   conector) e são ligadas;
3. um turno da IA roda com o **motor real e só o modelo roteirizado** (helper que
   monta o turno como o worker), e a conversa no Inbox mostra o QR code e o copia-e-cola
   enviados pela IA; o receiver WAHA do rig prova o que saiu;
4. o cliente acima do limite: nada sai, e a conversa não ganha mensagem da IA com cobrança;
5. conversa do chat do site com telefone digitado que bate no IXC: o painel mostra
   "escolher", não vincula.
Evidência em `.superpowers/evidence/ia-cobranca-ixc/`.

## 12. Não medido (e o que falta medir antes do deploy)

- **Formato de `cliente.data_nascimento` no IXC real** — sonda só-leitura AUTORIZADA pelo dono
  em 22/09, que imprime só agregados (formato × tipo de pessoa, faixa de anos). Até ela rodar,
  o campo não entra na lista branca.
- Pessoa jurídica: o que o IXC guarda em `data_nascimento` para CNPJ. Se vazio, cliente PJ fora
  do telefone vai para humano depois das recusas — aceitável na v1, declarado.
- O envio real de documento/imagem pela saída do MOTOR no canal Meta. A rota do botão já envia
  mídia pela Meta em produção (Pix provado pelo dono em 22/09) pelo MESMO `sendMessageHandler`;
  o motor não foi medido contra a Meta real.
- Tempo: consultar ≈ 3 s (duas ondas do resumo); enviar ≈ 5 s (lista de faturas + releitura +
  `get_pix`/`get_boleto`). Medido só no IXC falso.

## 13. Checklist do Sistema Vivo

| Invariante | Artefato concreto |
|---|---|
| Entrada e saída | entrada: mensagem do cliente → turno; saída: 2 mensagens na conversa (Inbox) e transferência para o time |
| Emite atividade/log | `conector.fatura_enviada`, `conector.vinculo_criado`, `conector.identificacao_recusada`, `conector.cobranca_encaminhada`; trace de before-send; log do turno |
| Aparece na tela | as mensagens no Inbox; o vínculo na aba IXC; o limite em Configurações › Conectores; as capacidades no editor do agente |
| Porta na navegação | Configurações › Conectores e IA › Agentes (já no `NAV_CATALOG`); nenhuma tela nova |
| Anti-morte | recusa sempre tem próximo passo (transferir para Cobrança); capacidade ligada sem conector vira aviso na Central |
| Laço de retorno (inv. 7) | IXC fora → conexão em `erro` na tela; recusas contadas → transferência; > limite → encaminhada + auditoria; envio parcial → audit e transferência |
| Mapa vivo | `docs/architecture/conectores.architecture.json` ganha `agente.ts` e `ferramentas-do-conector.ts` com arestas para o registro, o motor e a saída |

## 14. Entrega

PR próprio com os 4 checks obrigatórios (`verify`, `build-and-size`, `invariants`,
`imagens-ok`), fragmento em `.changes/` (`capacidade_nova`), J26 atualizada em
`docs/testing/user-journey-map.md`. **Sem deploy** até o dono pedir.
