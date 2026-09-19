# Chamar o cliente primeiro — iniciar conversa no WhatsApp

> Spec de 2026-09-19. Sessão autônoma: o dono do produto pediu a feature, autorizou
> ir até produção e não estava disponível para perguntas. As decisões que normalmente
> seriam perguntas estão registradas aqui como **premissas declaradas**, com a razão
> de cada uma.

---

## O pedido

> "Cadastrar um cliente, ou ele já vem na importação do IXC. Nunca chamamos ele no
> WhatsApp, ele nunca falou com a gente — por isso ainda não existe conversa. Quero
> poder chamar o cliente e iniciar a conversa com um template. É importante fazer
> isso usando um template da Meta, e também poder chamar pela API não-oficial."

---

## O que JÁ existe (e por isso não será construído)

A auditoria do repositório encontrou quase toda a mecânica pronta. Registrar isto é
metade do valor da spec: construir de novo o que existe seria o defeito, não a entrega.

| Peça | Onde | Estado |
|---|---|---|
| Criar conversa sem inbound (outbound-first) | `lib/automation/start-conversation.ts` → `beginServiceAtOrigin` → `fn_service_begin` | pronto |
| Resolver contato por telefone e abrir conversa | `lib/messaging/open-shared-contact-conversation.ts` | pronto |
| Rota que faz isso | `POST /api/v1/conversations/open-with-contact` | pronto |
| Envio de template ponta a ponta **com valores** | `sendMessageSchema.template_values` → `_handler.ts` → `conferirDefinicao` → `buildComponents` → Graph/parceiro | pronto |
| Derivação do contrato de parâmetros | `lib/channels/meta/template-contract.ts` (**função pura, zero imports**) | pronto |
| Montagem do payload a partir dos valores | `lib/channels/meta/build-components.ts` (`slotKey`, `missingSlots`) | pronto |
| Botão "Iniciar conversa" | `components/contacts/ContactsTable.tsx` | pronto, mas incompleto (ver abaixo) |
| Tool MCP de abrir+enviar | `lib/mcp/tools/start-conversation.ts` | pronto, mas sem template |

**O backend inteiro já sabe enviar um template parametrizado para um contato que
nunca escreveu.** O que falta é exclusivamente a superfície — e é por isso que o dono
do produto "não encontrou a funcionalidade": ela existe e não tem porta.

---

## As cinco lacunas medidas

### L1 — Nenhuma tela coleta os valores dos parâmetros (a lacuna central)

`template_values` existe no schema, no handler e nos adapters. Mas nenhuma tela o
preenche. O próprio `JanelaFechadaAviso.tsx` documenta a falha:

> "Não preenche `{{1}}`, `{{2}}`. Modelo com parâmetro é oferecido, mas o envio vai
> com os valores vazios — e a plataforma recusa."

Como **todo template de abertura de conversa carrega ao menos o nome do cliente**,
na prática iniciar conversa pelo canal oficial é impossível pela tela.

### L2 — A saída oferecida não existe

`JanelaFechadaAviso` manda o operador para **Conexões → Templates** para enviar com
parâmetros. Medido: `components/connections/TemplatesClient.tsx` **não tem envio
nenhum** — nem botão, nem `POST`, nem a palavra "enviar". É uma afirmação de estado
falsa na UI, apontando para um beco sem saída.

### L3 — As duas rotas de modelos são assimétricas, e uma barra quem atende

| | `/channels/templates` (oficial) | `/channels/partner/templates` (parceiro) |
|---|---|---|
| Autorização | **`requireRole("admin")`** | qualquer usuário autenticado |
| Devolve `slots` | sim | **não** |
| Devolve `contractHash` | sim | **não** |

Consequências medidas, as duas silenciosas:

- Um `agent` — o papel de quem atende — recebe **403** no canal oficial e a tela
  mostra *"Nenhum modelo aprovado ainda"*. A frase é falsa: os modelos existem.
- No canal parceiro, `tpl.slots?.length` é sempre `undefined`, então o aviso
  "este modelo pede N parâmetros" **nunca aparece** — justamente onde ele importa.

### L4 — Iniciar conversa não é um ato

O caminho de hoje: Contatos → ícone → navega para o Inbox → conversa vazia →
**só ali descobre** que a janela está fechada → seletor de modelos → falha se o
modelo pedir parâmetro. Quatro telas, e a restrição aparece depois da decisão.

### L5 — Alcance

O botão existe **só na tabela de contatos**. Medido: não há caminho em
`app/app/contacts/[id]` (o `ConversaNoDossie` retorna `null` quando não há conversa),
nem em leads/kanban. E a tool MCP `crm_start_conversation_and_send` — cujo cabeçalho
declara servir à "automação de prospecção fria" — tem um enum de `type` que **não
inclui `template`**, ou seja, não serve ao canal oficial, que é onde prospecção fria
obrigatoriamente usa template.

---

## Premissas declaradas (as perguntas que eu não pude fazer)

| # | Decisão | Por quê |
|---|---|---|
| P1 | O ato se chama **"Chamar no WhatsApp"**, não "Nova conversa" | descreve a intenção do operador; "conversa" é o efeito |
| P2 | A tela **nunca** pergunta qual é o provider | invariante 1 da doutrina de canal; o servidor responde `exige_modelo: boolean` |
| P3 | Canal com texto livre (WAHA) oferece **textarea**; canal com hetero-restrição oferece **só modelo** | é a capability `freeformOutsideWindow`, não uma preferência |
| P4 | A restrição aparece **antes** da escrita, não depois | L4: descobrir a regra depois de redigir é o defeito |
| P5 | Falha de envio **mantém** a conversa aberta | o operador vê a conversa no inbox e tenta de novo; apagar perderia o rastro de `fn_service_begin` |
| P6 | **Sem migration** | nenhuma tabela nova; tudo compõe peças existentes (doutrina DIRC: Referenciar) |
| P7 | Não implemento Embedded Signup nem criação de template | fora de escopo e, no primeiro caso, recusado pela doutrina |

---

## O desenho

### Peça 1 — `GET /api/v1/channels/modelos?channel_session_id=<uuid>`

Rota **única e neutra** que serve os modelos aprovados de uma conexão. Resolve
oficial vs. parceiro **no servidor**, com a mesma `fonteDeTemplates` — a tela deixa
de precisar saber que existem duas rotas.

Devolve, por modelo: `name`, `language`, `status`, `category`, `components`,
`contract_hash` e `slots[]` com **`chave` já montada por `slotKey`** — a tela nunca
monta essa chave por conta própria (é exatamente o mismatch que a doutrina proíbe).

Devolve, no envelope: **`exige_modelo: boolean`** — a tradução neutra de
`!caps.freeformOutsideWindow`. É o único campo que a tela usa para decidir o modo.

- **Role `agent`** (não `admin`): quem atende precisa chamar. Conserta L3.
- Formato idêntico para os dois canais. Conserta L3.

### Peça 2 — `components/channels/CamposDoModelo.tsx`

Um campo por slot, derivado **no cliente** por `deriveTemplateContract(components)` —
a mesma função pura do montador de payload. Isto é a regra "uma derivação, dois
consumidores" cumprida literalmente, e é possível porque `template-contract.ts` não
tem um único import.

Chaveia por `slotKey(address, key)`. Mostra preview com os valores substituídos.
Conserta L1.

### Peça 3 — `lib/messaging/iniciar-conversa.ts` + `POST /api/v1/conversations/iniciar`

Helper que compõe `openSharedContactConversation` + `sendMessageHandler` — as duas
peças que a tool MCP já compõe. Extraí-lo faz MCP e tela compartilharem um caminho
só, em vez de a rota nova duplicar o que o MCP faz (DIRC).

Devolve `conversation_id` **mesmo quando o envio falha** (P5), com o erro junto.

### Peça 4 — `components/contacts/ChamarNoWhatsAppDialog.tsx`

Um ato: escolhe a conexão (quando há mais de uma) → o servidor diz se exige modelo →
texto livre **ou** modelo + parâmetros + preview → envia → navega para a conversa.
Conserta L4.

### Peça 5 — Alcance

O mesmo diálogo em: tabela de contatos, dossiê do contato (onde hoje não há nada
quando falta conversa) e o card/dossiê de lead. Conserta L5.

### Peça 6 — `JanelaFechadaAviso` passa a usar `CamposDoModelo`

Some o beco sem saída e a frase falsa sobre "Conexões → Templates". Conserta L2.

### Peça 7 — MCP aceita `template`

`type: "template"` + `template_name` / `template_language` / `template_values` na
tool `crm_start_conversation_and_send`. Conserta a metade de L5 que é de automação.

---

## Living System Checklist

| Invariante | Resposta (artefato concreto) |
|---|---|
| 1. Não é ilha | **Entrada:** contato/lead sem conversa. **Saída:** conversa real no inbox, mensagem em `messages`, atendimento aberto por `fn_service_begin` |
| 2. Continuidade IA↔humano | a conversa nasce igual às de inbound; roteamento, agente e follow-up a tratam sem saber que foi outbound |
| 3. Log universal e visível | o envio já audita em `api_audit_log`; `fn_service_begin` grava a atividade na linha do tempo do contato |
| 4. Nenhuma demanda sem próximo passo | envio falho **mantém a conversa** e mostra o erro real (contrato obsoleto, valor faltando, recusa da plataforma) |
| 5. Informação com propósito | a tela mostra a restrição do canal **antes** da escrita, não o código de erro depois |
| 6. Configuração com superfície | os modelos já têm tela em Conexões; esta spec dá a eles a **superfície de uso**, que faltava |
| 7. Laço de retorno | o cliente responde → `last_inbound_at` → a janela abre → o selo muda sozinho e o texto livre é liberado |

**Porta na navegação:** não é tela nova, é ação dentro de telas que já têm porta
(Contatos, Leads, Inbox) — então não entra em `NAV_CATALOG`.

---

## Verificação

- Unit: derivação↔montagem (mesma chave dos dois lados), a rota nova nos dois canais, `exige_modelo` por capability, role `agent` autorizada.
- E2E: a jornada pela tela, com banco fresco estilo VPS, nos **dois** modos de canal.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels` (nenhum nome de provider vazou), `pnpm test:unit`.
- Fragmento em `.changes/` com `impacto: capacidade_nova`.
