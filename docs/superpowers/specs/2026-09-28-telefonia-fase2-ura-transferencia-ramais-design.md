# Telefonia SIP — fase 2: URA, transferência e ramais (DYD-10)

- **Data:** 2026-09-28
- **Base:** fase 1 em produção na v1.49.0 ([`docs/specs/20-spec-telefonia-sip.md`](../../specs/20-spec-telefonia-sip.md)).
- **Pedido do dono:** menu na recebida que leva ao time, transferência entre operadores e equipes, ramais.
- **Desenho fechado com o dono** em sessão de brainstorming. As decisões estão em §1; o que ficou fora, em §9.

## 1. Decisões fechadas

| # | Decisão | Escolha |
|---|---|---|
| D1 | Entrega | Três versões separadas, cada uma provada na VPS antes da seguinte: **URA → Transferência → Ramais** |
| D2 | Onde vive a URA | **Menu é da organização**; o número aponta para um time **ou** para um menu; um menu serve a vários números |
| D3 | Voz das falas | **Só ElevenLabs** (texto → voz). Sem chave, nenhuma fala é gerada e nenhum menu pode ser ligado a um número. Sem envio de gravação nesta fase |
| D4 | Chave da ElevenLabs | Uma por organização, cadastrada pela tela, cifrada em `ai_provider_credentials` (provider `elevenlabs`) |
| D5 | Sem escolha ou opção inválida | A tecla interrompe a fala; 5 s de espera após a fala; repete o menu até 2 vezes; depois vai para o **time padrão** do menu |
| D6 | Falas além do menu | **Fora do horário**, **aguarde**, **ninguém atendeu**: as três na versão 1, uma de cada por organização |
| D7 | Aviso de emergência | Pertence ao **time**. Toda ligação **de fora** que entra na fila do time ouve o aviso antes; a transferida por atendente não ouve |
| D8 | Desligar a emergência | Gerente ou admin; a duração é escolhida ao ligar (1 h, **2 h** por padrão, 4 h, até eu desligar); ao vencer, desliga sozinho e registra na Central |
| D9 | Transferência | **Direta e consultada**. A consultada é só para pessoa |
| D10 | Pessoa não atende a transferência direta | **Volta para quem transferiu**; se essa pessoa também não atender, a ligação vai para a fila do time da ligação |
| D11 | Numeração de ramal | Automática a partir de 201; o admin pode trocar (2 a 4 dígitos, único na organização) |
| D12 | Áudio até o Asterisk | **Volume compartilhado**: o worker escreve, o Asterisk só lê; o Storage é a fonte da verdade |
| D13 | Ordem da tela para o worker | **Evento de usuário da ARI**: a API valida e emite, o worker revalida e age |
| D14 | Onde testar | **(61) 3686-1503**, que é o número de teste da Totus |
| D15 | Quando a ElevenLabs é chamada | **Só ao gerar prévia na tela**, nunca numa ligação. Fluxo prévia → ouvir → "Salvar e usar"; o mesmo texto com a mesma voz não é cobrado duas vezes (§4) |

## 2. Passo zero — duas medições antes de escrever a URA

Cada uma pode mudar o desenho, por isso vêm primeiro.

1. **O Asterisk toca o nosso arquivo?**
   - Onde: contêiner da imagem `deskcomm-asterisk`, local, sem SIP e sem operadora.
   - O que: gerar um `.ulaw` na ElevenLabs (`output_format=ulaw_8000`), montar num volume e tocar pela ARI com caminho absoluto (`sound:/var/lib/deskcomm/falas/<org>/<hash>`).
   - Critério: sai `PlaybackFinished` sem erro, com o `format_pcm` carregado e o arquivo legível pelo usuário do Asterisk.
   - Se o caminho absoluto falhar, montar o volume dentro de `astdatadir` (`/usr/share/asterisk/sounds/deskcomm`) e tocar por caminho relativo.
2. **As teclas da operadora chegam como `ChannelDtmfReceived`?**
   - Onde: numa ligação real para o 3686-1503, com o log de DTMF ligado no Asterisk de produção. É só log, nada muda no atendimento.
   - Pré-requisitos: autorização do dono e o dono teclando durante a ligação.
   - O tronco anuncia `dtmf_mode=rfc4733`. Se a operadora mandar o DTMF na banda do áudio ou por SIP INFO, a URA precisa de `dtmf_mode=auto` ou `info`, e isso se mede aqui, não na prova final.

## 3. Dados

- **Tripla de migration:** cada versão tem a sua migration, o apêndice idempotente no `baseline.sql` e a linha no MANIFEST. A primeira é a **0288**; confira com o comando do CLAUDE.md antes de criar.
- **Tabelas novas:**
  - têm `organization_id uuid not null references organizations(id) on delete cascade` e a RLS `tenant_isolation_<tabela>_select` (`for select`) via `fn_user_org_ids()`. É a mesma forma de `attendance_teams`: a escrita passa só pela API com o cliente de serviço, e o `rbac-config-ia-canais` reprova policy ALL que só confere a organização;
  - toda referência entre tabelas tenant-aware é uma **FK composta** `(organization_id, <coluna>)`, para o próprio banco recusar o cruzamento de organizações;
  - leitura para membros da organização;
  - escrita só pela API, com o cliente de serviço filtrando a organização resolvida da sessão.
- **Funções novas:** `revoke ... from public, anon` (CLAUDE.md, migrations item 9).

### 3.1 Versão 1 — URA e falas

- **`phone_prompts`**, uma linha por fala:
  - `kind`: `menu`, `invalid`, `waiting`, `nobody`, `after_hours`, `emergency`, com CHECK;
  - conteúdo: `text`, `voice_id`, `model_id`;
  - `content_hash`, que é o sha256 de texto + voz + modelo;
  - `storage_path` (`<org>/<hash>.ulaw`), `duration_ms`;
  - `status` (`ready` ou `failed`, com CHECK), `error`;
  - `created_by`, `created_at`, `updated_at`.
  - Editar o texto regrava a linha com hash e arquivo novos, e o objeto antigo sai do Storage.
- **`phone_settings`**, uma linha por organização: `voice_id`, `model_id` e as falas gerais (`waiting_prompt_id`, `nobody_prompt_id`, `after_hours_prompt_id`).
- **`phone_menus`**:
  - `name`, `prompt_id` (fala do menu), `invalid_prompt_id` (opcional);
  - `default_team_id` obrigatório, com FK para `attendance_teams`;
  - `accepts_extension boolean default false` (usado na versão 3), `archived_at`.
- **`phone_menu_options`**:
  - `menu_id`, `digit`, com CHECK `^[0-9]$`; as teclas `*` e `#` ficam reservadas;
  - `team_id`;
  - `unique (menu_id, digit)`.
- **`channel_sessions.sip_menu_id`**, com FK para `phone_menus`, e o CHECK `not (sip_team_id is not null and sip_menu_id is not null)`.
- **`attendance_teams`**:
  - `phone_emergency_prompt_id`;
  - `phone_emergency_active_since` (nulo quando desligado);
  - `phone_emergency_expires_at` (nulo quando ligado "até eu desligar");
  - `phone_emergency_activated_by`.
- **`voice_calls`**:
  - `menu_id`, `menu_digit`;
  - `menu_outcome`: `chosen`, `default_no_input` ou `default_invalid`, com CHECK;
  - `emergency_heard_at timestamptz`, quando o cliente ouviu o aviso de emergência. É a fonte do "ouviu o aviso de instabilidade" no cartão;
  - `end_reason` ganha o valor `after_hours`. A coluna é de vocabulário aberto e não tem CHECK.
- **Bucket privado `phone-prompts`**.

### 3.2 Versão 2 — transferência

**`voice_call_transfers`**:
- `voice_call_id`, `from_user_id`, `to_user_id` ou `to_team_id` (CHECK: exatamente um dos dois);
- `kind`: `blind` ou `attended`;
- `outcome`: `answered`, `returned`, `queued` ou `cancelled`;
- `answered_by`, `started_at`, `ended_at`.

### 3.3 Versão 3 — ramais

- **`phone_extensions`**: `user_id` e `number` (CHECK `^[0-9]{2,4}$`), com `unique (organization_id, number)` e `unique (organization_id, user_id)`.
- **Atribuição automática:**
  - uma função devolve o próximo número livre a partir de 201;
  - ela é chamada por gatilho quando alguém ganha papel de atendimento (`agent`, `manager` ou `admin`);
  - na migration, o backfill cobre quem já existe.
- **`voice_calls.direction`** passa a aceitar `internal`.
  - O CHECK é refeito no apêndice de forma idempotente.
  - Não há dado para deduplicar, porque o valor é novo.

## 4. Áudio: da ElevenLabs ao Asterisk (D12)

**A ElevenLabs só é chamada quando alguém cria ou altera uma fala na tela. NUNCA durante uma ligação.** Toda ligação toca um arquivo já gravado; mil ligações custam zero na ElevenLabs. Um teste de unidade reprova o CI se qualquer módulo do caminho da ligação (`lib/channels/telefonia/`, `workers/`) importar o cliente da ElevenLabs.

**Fluxo de edição: prévia, ouvir, salvar (pedido do dono em 2026-09-28).** Nada muda nas ligações até o "Salvar e usar".

1. **Gerar prévia.**
   - A rota calcula `content_hash` = sha256 de texto + voz + modelo.
   - Se o objeto `<org>/<hash>.ulaw` já existe no Storage, **reaproveita e não chama a ElevenLabs**.
   - Senão, chama a ElevenLabs uma vez (`POST /v1/text-to-speech/{voice_id}?output_format=ulaw_8000`, header `xi-api-key`, modelo `eleven_multilingual_v2`) e grava o objeto.
   - Limite de 30 prévias por hora por organização, contra clique repetido, com o limitador Upstash que o CRM já usa.
2. **Ouvir.** A tela recebe o áudio da prévia: o navegador converte μ-law em PCM16 e monta um WAV para o `<audio>`. Ouvir de novo não custa nada.
3. **Salvar e usar.**
   - A linha de `phone_prompts` passa a apontar para o hash da prévia e fica `ready`. Não há chamada à ElevenLabs aqui.
   - A partir desse momento, as ligações tocam o áudio novo.
   - A API recusa salvar um hash cujo objeto não existe no Storage.
4. **Limpeza.**
   - Prévia não salva: sai do Storage depois de 24 h.
   - Áudio antigo: sai quando nenhuma linha o referencia.
   - Quem limpa é a passada do worker.
5. **Levar ao Asterisk.** O volume nomeado `telefonia-falas` é montado com leitura e escrita no `worker` e só leitura no `asterisk`. A passada de 60 s que já reconcilia os troncos passa a:
   - baixar do Storage as falas `ready` que faltam no volume;
   - apagar do volume os arquivos que nenhuma linha referencia mais.
6. **Antes de tocar.** O worker confere se o arquivo existe; se faltar, baixa do Storage na hora. Isso nunca chama a ElevenLabs.
   - Se não conseguir, a ligação **pula a fala** e segue.
   - Um menu sem áudio manda direto para o time padrão.
   - Abre um item na Central, `phone_prompt_unplayable`.
7. **Validação na API.** A API recusa apontar um número para um menu enquanto alguma fala dele não estiver `ready`.

**Chave sem crédito ou revogada:** as falas salvas continuam tocando. Só gerar prévia falha, com a mensagem da ElevenLabs traduzida na tela.

**Texto sugerido de "fora do horário":** já traz o número de WhatsApp da organização quando houver um conectado, e continua editável antes de gerar.

## 5. Fluxo da ligação

### 5.1 Recebida (versão 1)

1. **Entrada.** O número aponta para um time e a ligação vai para a fila (5.2), como hoje; ou aponta para um menu, e a ligação é atendida e vai para a URA.
2. **URA:**
   - Toca a fala do menu. Qualquer tecla interrompe a fala.
   - Terminada a fala, espera 5 s.
   - Opção válida: fila do time da opção, com `menu_outcome=chosen`.
   - Opção inválida: toca `invalid`, se houver, e repete.
   - Sem tecla: repete.
   - Depois de 2 repetições: fila do time padrão, com `default_invalid` ou `default_no_input`.
   - Se o cliente desliga no menu, a ligação vira **perdida**, com aviso "Ligar de volta" no time padrão.
3. **Relógio.** Os 2 min de fila começam a contar na entrada da fila (5.2), não no início da ligação.

### 5.2 Fila do time (ligação vinda de fora)

1. **Time fora do horário**, pela agenda do time, a mesma que `disponiveisNoTime` já lê: toca `after_hours` e desliga.
   - `end_reason=after_hours`, sem aviso na Central.
   - É preciso separar "time fora do horário" de "ninguém disponível", que hoje devolvem a mesma lista vazia.
2. **Emergência ligada e não vencida** (`active_since` preenchido e `expires_at` nulo ou no futuro): toca o aviso **inteiro**, sem que a tecla interrompa, e segue.
3. **Toque nos atendentes:** a regra atual fica intacta (rodízio, 20 s, 2 voltas, 120 s de fila).
4. **Se o cliente precisa esperar:** toca `waiting`, depois a música, e repete `waiting` a cada ~40 s (para a música, toca a fala, volta a música).
5. **Se um atendente atende no meio de uma fala:** a fala para e a ponte se forma.
6. **Esgotou:** toca `nobody` e desliga. Vira perdida com aviso, como hoje.

### 5.3 Transferência (versão 2)

**Como a ordem chega ao worker.** A tela chama `POST /api/v1/telefonia/chamadas/[id]/transferir`. A API confere:
- a ligação está em curso;
- quem pede é o dono atual da ligação, ou um gerente ou admin;
- o destino é da mesma organização e tem papel de atendimento;
- um time de destino está dentro do horário. Fora do horário, a API recusa com motivo.

Passando na validação, a API emite o evento de usuário da ARI (`POST /events/user/transferir?application=crm`). O worker revalida contra o seu estado em memória. Só pode haver **uma transferência por vez** em cada ligação.

**Direta para pessoa P**, pedida por A:
1. O cliente passa a ouvir música na ponte dele. O canal de A sai e é desligado.
2. O ramal de P toca por 20 s, com os headers `X-Ligacao-Id` e `X-Transferida-Por`.
3. Se P atende, entra na ponte, a música para e a conversa é atribuída a P (`answered`).
4. Se P não atende, recusa ou está offline, o ramal de A toca de volta por 20 s (`returned`).
5. Se A também não atende, a ligação vai para a fila do time da ligação (5.2, sem emergência nem fora do horário).

**Direta para time T:**
- entra na fila de T (5.2 a partir do passo 3), com A fora do rodízio (`queued`);
- esgotou: perdida com aviso para T.

**Consultada** (só para pessoa):
- O cliente fica com música na ponte dele. A vai para uma ponte de consulta, e o ramal de P toca nela.
- **Completar:** P passa para a ponte do cliente e A é desligado.
- **Voltar ao cliente:** P é desligado e A volta à ponte do cliente.
- **P não atende:** A volta sozinho ao cliente.
- **A desliga no meio:** com P já na linha, completa; com P ainda tocando, vira transferência direta.
- **Cliente desliga no meio:** tudo encerra (`cancelled`).

**Rede de proteção.** `allow_transfer=no` nos endpoints `ramal-*`, que fecha a transferência por REFER. Entra já na versão 1, porque é defesa independente.

### 5.4 Ramais (versão 3)

- **Discador:** 2 a 4 dígitos é ramal.
  - `POST /chamadas` cria um pedido `internal`, e o worker faz a ponte entre `ramal-A` e `ramal-B`.
  - A ligação não passa pela operadora, não usa prefixo e não cria contato nem conversa.
  - Fica em `voice_calls` com `direction=internal`.
- **Transferência:** o seletor aceita o número do ramal.
- **URA com `accepts_extension`:**
  - depois da primeira tecla, a URA espera 2 s por mais dígitos;
  - sequência que é ramal: toca na pessoa por 20 s; se ela não atende, a ligação vai para o time padrão do menu;
  - ramal inexistente: `invalid`;
  - a opção de 1 dígito continua valendo, com 2 s de atraso.

### 5.5 Mudanças no worker

- **`PortaAri`:** `tocarFala(canal, arquivo) → playbackId` e `pararFala(playbackId)`.
- **Versão 2:** `musicaNaPonte`, `pararMusicaNaPonte` e `tirarDaPonte` na `PortaAri`. A emissão do evento de usuário é do cliente da ARI do lado da API (`ari.ts`), não da porta do worker.
- **Eventos tratados:** `ChannelDtmfReceived`, `PlaybackFinished` e `ChannelUserevent`.
- **Passada de 60 s:** sincroniza as falas e desliga as emergências vencidas. Ao desligar uma, grava a auditoria `phone.emergency_expired` e o item `phone_emergency_expired` na Central.
- **Correção na hora da ligação:** o worker lê `expires_at` e não depende da passada.

## 6. Telas

Na versão 1 nenhuma rota de tela é criada; tudo entra em telas que já têm porta em `lib/navigation/catalogo.ts`.

1. **Credenciais de IA** (`/app/ai/credentials`):
   - cartão "ElevenLabs (voz da URA)";
   - a chave é validada listando as vozes da conta, e a tela mostra os 4 últimos dígitos.
2. **Conexões › Telefone** (`/app/connections`), com abas **Números · Menus · Voz e falas** (`?aba=`):
   - **Voz e falas:**
     - escolha da voz numa lista das vozes da conta, com "Ouvir amostra";
     - as três falas gerais, com texto sugerido, "Gerar prévia", "Ouvir" e "Salvar e usar" (§4), e o estado (em uso, prévia não salva, falhou com motivo);
     - sem chave: aviso com link para Credenciais de IA.
   - **Menus:**
     - lista e editor: nome, opções (tecla → time), time padrão e `accepts_extension` (versão 3);
     - a fala do menu é **montada a partir das opções**, por exemplo "Para Suporte Técnico, digite 1. Para Financeiro, digite 2.", e é editável antes de gerar;
     - a fala `invalid` é opcional;
     - bloco "últimos 7 dias": escolhas por opção e quantos caíram no padrão sem escolher (§8, laço de retorno).
   - **Números:**
     - "Quando ligarem: [tocar no time ▾] ou [tocar o menu ▾]";
     - um menu com fala pendente aparece desabilitado, com o motivo.
3. **Configurações › Times** (`/app/settings/teams`), cartão "Aviso de instabilidade (telefone)" em cada time:
   - Desligado: o texto salvo e o botão "Ligar aviso". Ele abre uma janela com o texto editável, a duração e "Ligar". Se o texto mudou, é preciso "Gerar prévia" e "Ouvir" antes de "Ligar" (§4).
   - Ligado: "Ligado às HH:MM por Fulano · desliga às HH:MM" e o botão "Desligar agora".
   - Os botões aparecem só para gerente e admin.
4. **Faixa em todo o CRM:**
   - aparece para todos os membros da organização enquanto houver aviso ligado;
   - texto: "Aviso de instabilidade ligado no telefone do <time> · desliga às HH:MM";
   - para gerente e admin, tem [Desligar];
   - aparece e some sem recarregar a página.
5. **Painel do telefone** (versão 2):
   - **Transferir:** busca por nome ou ramal.
     - As pessoas aparecem como disponível, em ligação ou offline; só as disponíveis podem ser escolhidas.
     - Os times aparecem com a contagem de disponíveis, ou como "fora do horário".
     - Botões: Transferir e Falar antes (pessoa); Transferir (time).
   - **Durante a consulta:** "Completar transferência" e "Voltar ao cliente".
   - **Quem recebe** vê "Transferida por Ana · cliente João".
   - **Quem recebe de volta** vê "Bruno não atendeu, o cliente voltou".
6. **Cartão da ligação** (`CartaoDaLigacao`):
   - a escolha no menu, ou "sem escolha → <time padrão>";
   - "ouviu o aviso de instabilidade";
   - a corrente de transferências;
   - o motivo "fora do horário".
7. **Membros** (versão 3): coluna "Ramal", editável pelo admin. O painel do telefone mostra "Seu ramal: 201".
8. **Central:** `phone_prompt_unplayable` e `phone_emergency_expired`, além do `voice_call_missed` que já existe.

## 7. Segurança

- **Autenticação e cifra:**
  - a chave da ElevenLabs nunca volta à tela depois de salva (só os 4 últimos dígitos);
  - vai só no header, nunca em query;
  - é cifrada com `AI_CRED_AES_KEY`.
- **Papéis:**
  - menus, falas e a escolha do destino do número: **admin**, a mesma régua das rotas de `numeros`;
  - aviso de emergência: **gerente ou admin**;
  - transferir: dono atual da ligação, ou gerente ou admin.
- **Quem manda no worker:**
  - o evento de usuário da ARI só é emitido pela API, na rede interna, porque a ARI não é exposta;
  - o worker revalida organização, ligação e destino contra o banco e o estado em memória antes de agir.
- **Proteção das ligações:**
  - `allow_transfer=no` nos ramais;
  - canais que não são `PJSIP/` continuam sendo derrubados.
- **Storage e texto:**
  - o bucket é privado e só o worker lê, com o cliente de serviço;
  - o texto das falas passa pelo Zod (tamanho máximo, sem texto vazio).
- **Auditoria** das mutações: `phone.prompt_saved`, `phone.menu_saved`, `phone.number_destination_changed`, `phone.emergency_activated`, `phone.emergency_deactivated`, `phone.emergency_expired`, `phone.call_transferred` e `phone.extension_changed`.

## 8. Living System Checklist

| Invariante | Resposta concreta |
|---|---|
| Entrada e saída | **Entrada:** tela de menus, falas e emergência, tecla do cliente, botão Transferir. **Saída:** a ligação chega ao time certo, o cartão e a atividade aparecem na conversa, os itens caem na Central |
| Log | `voice_calls.menu_*`, `voice_call_transfers`, `api_audit_log` e `logger` do worker (fala que não tocou, ordem recusada) |
| Aparece na tela | O cartão da ligação, a faixa de emergência, o bloco "últimos 7 dias" do menu e o painel do telefone |
| Porta na navegação | Abas em Conexões › Telefone, o cartão em Configurações › Times e o cartão em Credenciais de IA, todas telas já catalogadas |
| Anti-morte | A emergência vence sozinha; a fala ausente é pulada e avisada; a transferência não atendida volta a quem transferiu; o cliente sem escolha vai ao time padrão |
| Laço de retorno (inv. 7) | **Menu que confunde:** muitos `default_no_input` aparecem no "últimos 7 dias", e o dono reescreve a fala. **Transferência que não pega:** muitos `returned` aparecem na corrente do cartão |
| Mapa vivo | `docs/architecture/telefonia.architecture.json` ganha as peças novas, com as arestas descritas abaixo |

As peças novas do mapa e suas arestas:
- `phone_prompts`: ElevenLabs → Storage → volume → Asterisk;
- `phone_menus`: `channel_sessions` → URA → `attendance_teams`;
- emergência: `attendance_teams` → fila → Central;
- `voice_call_transfers`: painel → API → ARI → worker → conversa.

## 9. Fora desta fase

- **Aparelho externo como ramal** (telefone IP ou app SIP): exige abrir porta SIP e depende da rotação de credenciais (spec 20 §10.2).
- **Envio de gravação** como fala (D3).
- **Falas gerais por time:** só se a Totus pedir.
- **O agente de IA do WhatsApp avisar o mesmo incidente.** É o laço natural com a emergência, e fica anotado para depois.
- **Gravação, transcrição e relatórios de telefonia:** F3 a F5 da spec 20.

## 10. Testes e prova

- **Unitários (CI):**
  - `controle.test.ts`, com a ARI de mentira, cobrindo todos os caminhos de §5;
  - regras puras: montagem do texto do menu, decisão da URA, vencimento da emergência, próximo ramal livre.
- **Invariantes (`pnpm test:db`):**
  - isolamento RLS das tabelas novas entre 2 organizações;
  - o CHECK de time ou menu;
  - o `revoke` das funções novas;
  - unicidade e backfill dos ramais;
  - o apêndice do baseline em modo install e em modo update.
- **Kit:** `pnpm test:shell`. O volume novo tem que chegar a quem já instalou só pelo `update.sh`.
- **E2E das telas:** Playwright com um receptor HTTP falso da ElevenLabs. A URL base é configurável **só em teste**, nunca como knob de produção.
- **Prova na VPS, pela tela, no 3686-1503, com o dono ligando do celular.**
  - **Versão 1:**
    - cadastrar a chave pela tela; a chave nunca passa pelo chat;
    - gerar as falas e montar o menu;
    - ligações cobrindo opção 1, opção 2, tecla errada, sem tecla e desligar no menu;
    - emergência ligada e depois desligada;
    - fora do horário.
  - **Versão 2:** duas contas de teste em dois navegadores; transferência direta, consultada, não atendeu e volta, e para time.
  - **Versão 3:** ramal para ramal, ramal digitado na URA.
  - As evidências ficam em `.superpowers/evidence/telefonia/`.
- **Documentos de autoridade (DoD 16):**
  - a spec 20 §8 aponta para este desenho;
  - `docs/current-state.md` deixa de dizer que a telefonia não está na `main`;
  - `docs/testing/user-journey-map.md` ganha as jornadas;
  - `.changes/`: um fragmento `capacidade_nova` por versão.

## 11. Riscos aceitos

- **Worker reiniciando** no meio de uma URA ou de uma transferência perde o estado daquela ligação. É a mesma limitação das ligações de hoje.
- **OOM do worker** (investigação separada): a fase 2 acrescenta pouco uso de memória. O paliativo `NODE_OPTIONS` segue valendo.
- **Ordem da tela perdida** se o worker reiniciar naquele segundo. O atendente clica de novo; a API responde em sucesso só depois de emitir, e o painel reflete o estado real da ligação.
