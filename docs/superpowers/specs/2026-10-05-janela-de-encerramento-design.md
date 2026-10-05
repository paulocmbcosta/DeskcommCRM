# Janela de encerramento: assunto por time e resumo do atendimento

**Data:** 2026-10-05 · **Estado:** desenho aprovado pelo dono do produto · **Migration:** 0293

## 1. O problema

Encerrar uma conversa hoje é um `confirm()` do navegador, em dois lugares
(`components/inbox/ConversationHeader.tsx`, botão "Fechar";
`components/inbox/InboxKeyboardShortcuts.tsx`, atalho `e`). O atendimento fecha sem
dizer do que tratou. Consequências:

- não há número de "quais assuntos geram mais atendimento", por dia ou por mês;
- o histórico do cliente lista protocolos, e nenhum diz o que foi tratado.

Medido na instalação de produção em 2026-10-05 (14 dias, consulta agregada):
1.063 encerramentos, 110 a 165 por dia útil, 100% feitos por pessoa (15 pessoas),
6 times ativos, e **336 encerramentos (32%) sem time**.

## 2. Decisões do dono

| # | Decisão |
|---|---|
| D1 | A janela pede **setor do assunto**, **assunto** e **resumo**. |
| D2 | Os assuntos são cadastrados **por time**, por gerente ou administrador. |
| D3 | Obrigatoriedade é **interruptor por organização**: "exigir assunto" e "exigir resumo". Os dois nascem desligados. |
| D4 | Atendimento sem time: o atendente **escolhe o setor na hora**. O setor também pode ser trocado quando o assunto era de outro time. |
| D5 | **Sem IA.** Quem escreve é quem atendeu. |
| D6 | Um assunto por atendimento, um nível (o time já é o primeiro nível). |

## 3. Caminhos recusados

- **Etiquetas da conversa.** A etiqueta é da conversa, que é permanente e única por
  cliente e canal (0266). O segundo atendimento herdaria o assunto do primeiro.
- **Demandas e `desfecho`.** Vocabulário fixo de seis desfechos, não é por time e não
  é cadastrável. Demanda não é atendimento.
- **Tabela 1:1 de encerramentos.** O registro é do atendimento e é um só: coluna, não
  tabela (DIRC).

## 4. Modelo de dados (migration 0293)

### 4.1 `atendimento_assuntos`

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | `uuid` pk | |
| `organization_id` | `uuid not null` → `organizations` cascade | |
| `team_id` | `uuid not null` | FK composta `(organization_id, team_id)` → `attendance_teams(organization_id, id)` cascade |
| `name` | `text not null` | 1 a 60 caracteres depois do `btrim` |
| `archived_at` | `timestamptz` | arquivar, nunca apagar: o assunto continua nomeando o passado |
| `created_at`, `updated_at` | `timestamptz` | |

- `unique (organization_id, id)`; índice único `(team_id, lower(btrim(name)))`.
- RLS ligada, policy `tenant_isolation_atendimento_assuntos_all`; GRANT só de `select`
  a `authenticated` e `service_role`. A escrita é só por RPC `security definer`, o
  mesmo desenho de `attendance_teams` (0263).

### 4.2 `atendimentos`

- `assunto_id uuid` → `atendimento_assuntos(id) on delete set null`.
- `closure_summary text`, com `check (char_length(closure_summary) <= 2000)`.
- Índice novo `atendimentos_org_fechamento (organization_id, closed_at) where closed_at is not null`:
  os dois índices que existem são por conversa, e o painel lê por período.

**O time do atendimento não muda.** `atendimentos.team_id` continua sendo o time que
estava com a conversa no fechamento (fato). O setor do assunto vem de
`atendimento_assuntos.team_id` (classificação). Gravar o setor escolhido em
`conversations.team_id` dispararia `team_changed` e acordaria o roteamento — é um
gesto de encaminhar, e ninguém encaminhou.

### 4.3 Configuração

`organizations.settings.atendimento.encerramento = { exigir_assunto: boolean, exigir_resumo: boolean }`,
ausente = os dois `false`. Leitor e escritor com schema Zod em `lib/schemas/settings.ts`,
no molde de `reguaDeEspera`.

## 5. Funções SQL

Todas terminam com `revoke execute ... from public, anon` e o `grant` mínimo; entram
no apêndice do baseline **antes** do bloco da VARREDURA anon.

### 5.1 `fn_atendimento_encerrar(p_org, p_conversation, p_expected, p_actor, p_assunto, p_resumo) returns conversations`

`security definer`, só `service_role`. É a **porta única** do encerramento por pessoa.

1. Lê os dois interruptores de `organizations.settings`.
2. Acha o atendimento aberto da conversa (`v_at`). Conversa de grupo não tem
   atendimento: nesse caso nada é exigido e nada é gravado.
3. Se a conversa já está em estado terminal, devolve a linha sem tocar em nada.
4. Valores efetivos: `coalesce(p_assunto, o que já estava)` e
   `coalesce(nullif(btrim(p_resumo), ''), o que já estava)`. Omitir não apaga — é o
   que faz "Reabrir e fechar de novo" não perder o registro.
5. Valida, com `errcode '22023'` e mensagem que a rota traduz:
   - `encerramento_assunto_invalido`: assunto de outra organização, arquivado, ou de time arquivado;
   - `encerramento_assunto_obrigatorio`: interruptor ligado, sem assunto efetivo, **e**
     existe ao menos um assunto ativo em time ativo (sem cadastro não há o que exigir);
   - `encerramento_resumo_obrigatorio`: interruptor ligado e resumo efetivo com menos de 10 caracteres;
   - `encerramento_resumo_longo`: mais de 2.000 caracteres.
6. Chama `fn_service_status_com_ator(..., 'closed', ..., p_retomar => false)`.
7. Grava `assunto_id` e `closure_summary` no atendimento `v_at`.
8. Acrescenta ao `payload` do evento `closed` desse atendimento
   `assunto_id`, `assunto` (nome) e `assunto_time` (nome do time). **O resumo não entra
   em payload de evento** — é texto livre sobre o cliente (mesma regra do motivo da passagem).

Validação falhou → exceção → nada fecha.

### 5.2 Cadastro

- `fn_save_atendimento_assunto(p_org, p_team, p_assunto, p_name) returns jsonb` —
  cria (`p_assunto null`) ou renomeia. Criar um nome que existe arquivado no mesmo
  time o **reativa**. Portões no banco: `manager`+, suporte com escrita, MFA provada.
- `fn_archive_atendimento_assunto(p_org, p_assunto, p_arquivar) returns jsonb`.

Ambas `security definer`, `grant` a `authenticated` (molde de `fn_save_attendance_team`).

### 5.3 Números

`fn_metricas_de_assuntos(p_org, p_from, p_to)` — `security definer`, só `service_role`.
Agrupa os atendimentos encerrados no período por `(assunto_id, atendimentos.team_id)`
e devolve nomes e total. Sem seletor de linha além da organização e do período.
Gerente e administrador enxergam todas as conversas da organização, então a função
não precisa da RLS por linha (que já custou 1,5 s por consulta, migration 0283).

### 5.4 LGPD

`fn_redigir_encerramentos_do_contato_anonimizado()` + gatilho
`trg_redigir_encerramentos_ao_anonimizar` em `contacts`
(`after update of is_anonymized`, na transição `false → true`): zera
`atendimentos.closure_summary` de todas as conversas do contato. É o gancho das
migrations 0174 e 0184. O assunto fica: é estatística, não dado da pessoa.
O exportador (`lib/lgpd/export-collector.ts`) passa a incluir os atendimentos do
titular com assunto e resumo.

## 6. API

| Rota | Papel | O que muda |
|---|---|---|
| `POST /api/v1/conversations/[id]/close` | agent+ | corpo aceita `assunto_id?` e `resumo?`; chama `fn_atendimento_encerrar` |
| `PATCH /api/v1/conversations/[id]` com `status: "closed"` | agent+ / token | mesmos campos opcionais, mesma RPC |
| `GET /api/v1/atendimentos/assuntos` | agent+ | interruptores + times ativos com assuntos ativos (o que a janela precisa) |
| `GET`/`POST /api/v1/settings/teams/[id]/assuntos` | manager+ | lista (com arquivados) e cria |
| `PATCH /api/v1/settings/teams/[id]/assuntos/[assuntoId]` | manager+ | renomeia ou arquiva/reativa |
| `GET /api/v1/metrics/assuntos?from&to` | manager+ | os números por time e assunto |
| `GET /api/v1/contacts/[id]/atendimentos`, `GET /api/v1/atendimentos` | como hoje | `AtendimentoResumo` ganha `assunto` e `closure_summary` |

Erro de validação do encerramento: `422 validation_failed` com
`details: { campo: "assunto" | "resumo", motivo }`. A organização vem sempre da sessão.
Com o interruptor ligado, a porta por token também recusa encerramento incompleto —
é a organização que escolheu exigir.

Os interruptores são gravados por server action, no molde de `definirReguaDeEspera`.

## 7. Telas

- **`EncerrarAtendimentoDialog`** (`components/inbox/`): aberto pelo botão "Fechar" e
  pelo atalho `e`. Setor do assunto (só times com assunto ativo; vem com o time do
  atendimento quando ele tem assuntos), assunto, resumo com contador. Marca de
  obrigatório conforme os interruptores. Vem preenchido com o que o atendimento já
  tem (caso do "Reabrir"). Sem nenhum assunto cadastrado na organização, os campos
  de setor e assunto não aparecem. Conversa de grupo: só a confirmação.
- **Configurações › Times**: `AssuntosDoTime` abaixo de cada time — criar, renomear,
  arquivar, reativar.
- **Configurações › Atendimento**: cartão "Ao encerrar um atendimento" com os dois
  interruptores. Ligar "exigir assunto" sem nenhum assunto cadastrado mostra o aviso
  de que nada será exigido até haver cadastro.
- **Painel da conversa**: ficha do atendimento mostra assunto e resumo; "Atendimentos
  anteriores" mostra assunto e resumo de cada um.
- **Aba Fechadas**: o assunto no card.
- **Linha do tempo**: o evento de encerramento diz o setor e o assunto.
- **Métricas**: `AssuntosPanel`, só gerente e administrador. Período; por time, a
  lista de assuntos com total e percentual; quantos ficaram sem assunto; quantos
  foram atendidos por um time diferente do setor do assunto.

Nenhuma tela nova: todas as portas já existem na navegação.

## 8. Sistema vivo

| Pergunta | Resposta |
|---|---|
| Entrada | `EncerrarAtendimentoDialog`, e as duas rotas de encerrar |
| Saída | `AssuntosPanel` (Métricas), "Atendimentos anteriores", aba Fechadas, linha do tempo, exportação LGPD |
| Log | `api_audit_log`: `conversation.closed` com `assunto_id` e `com_resumo`; ações novas para o cadastro de assuntos e para os interruptores. `conversation_events.closed` com o assunto |
| Anti-morte | regra no banco (`fn_atendimento_encerrar`), não na tela; o painel mostra "sem assunto" em vez de escondê-lo |
| Laço de retorno | registro errado → "Reabrir" e fechar de novo, com a janela preenchida. "Sem assunto" alto → cadastro incompleto. "Assunto de outro setor" alto → o roteamento está entregando ao time errado |
| Mapa | peça nova em `docs/architecture/`, com arestas para `atendimentos`, times e métricas |

## 9. Compatibilidade

- Interruptores desligados por padrão: quem atualiza ganha a janela e nenhum bloqueio.
- Encerramentos anteriores ficam sem assunto; não há backfill (classificar o passado
  seria inventar).
- Nenhuma assinatura de função existente muda. `fn_service_status_com_ator` segue
  existindo para o "Reabrir".
- Fragmento em `.changes/`: `capacidade_nova`.

## 10. Testes

- **Invariantes (`pnpm test:db`)**: isolamento de `atendimento_assuntos` entre duas
  organizações; `fn_atendimento_encerrar` — cada recusa, atomicidade (recusou → conversa
  segue aberta), assunto de outra organização, reabrir e fechar sem campos preserva o
  registro, grupo fecha sem exigência; cadastro — papel, reativação por nome; gatilho
  LGPD zera o resumo e preserva o assunto; varredura de `security definer` segue verde.
- **Unidade**: rotas (mapeamento dos erros, organização nunca do corpo), janela
  (obrigatoriedade, troca de setor, preenchimento ao reabrir), formulários de
  configuração, descrição do evento, painel de métricas.
- **e2e**: jornada nova no mapa — gerente cadastra assuntos e liga os interruptores;
  atendente tenta fechar em branco e é barrado; fecha com assunto e resumo; o registro
  aparece no histórico do cliente e no painel de Métricas.

## 11. Fora do escopo

Sugestão por IA; "resolvido / não resolvido"; mais de um assunto por atendimento;
editar o registro sem reabrir; filtro por assunto na aba Fechadas; exportar o painel.
