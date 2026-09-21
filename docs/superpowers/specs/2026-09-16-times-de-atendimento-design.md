# Times de atendimento (setores) — desenho

> Spec de desenho, validada com o dono do produto em 2026-09-16.
> Repositório na v1.28.0. Implementação ainda não iniciada.

---

## 1. O problema

Hoje o CRM tem **um** destino humano. Quando a IA decide passar a conversa, ela escolhe
entre: um atendente específico (se estiver elegível agora), o rodízio entre os elegíveis,
ou — sem ninguém — a **fila única da organização**.

Quem opera um negócio com setores não tem como expressar isso. Um provedor de internet
(caso motivador: um provedor de internet real) precisa de cinco destinos distintos — Suporte Técnico,
Financeiro/Cobrança, Comercial, Cancelamentos e Fornecedores —, e hoje um pedido de
cancelamento e uma dúvida de boleto caem no mesmo lugar, para a mesma pessoa.

Há ainda um requisito de horário que o modelo atual não consegue expressar: o setor de
Cancelamentos desse provedor atende **seg–sex 08h–18h**, enquanto a empresa atende **seg–sáb
08h–20h** e **dom/feriado 08h–13h**.

---

## 2. As cinco decisões

| # | Decisão | O que foi recusado, e por quê |
|---|---|---|
| 1 | Atendente pode estar em **vários times** (N:N). Capacidade continua **do atendente**, uma só e global | Um time por atendente (forçaria a empresa pequena a escolher um setor para quem faz dois). "Time primário" com `is_primary` (mais um conceito na tela sem evidência de que alguém precise) |
| 2 | Sem ninguém elegível, a conversa espera na **fila do time**, sem transbordo | Transbordo automático após N minutos — entregaria justamente o cancelamento de sábado ao comercial, que é o que a feature existe para evitar. Fila geral sempre — o assunto se perderia no momento em que mais importa |
| 3 | Horário = **interseção**: janela do atendente ∧ janela do time | Só do atendente (uma pessoa tem uma agenda só, e a decisão 1 põe a mesma pessoa em dois setores com horários diferentes). Time sobrescreve o atendente (entregaria conversa a quem está fora do próprio expediente) |
| 4 | O agente descobre os times **em runtime**, por tool, e escolhe pelo assunto | Enum fixo de papéis do produto (fecharia o vocabulário e quebraria o multi-nicho; a doutrina do repo é `text` + check, nunca enum). Slug escrito no prompt de cada org (colaria a identidade da empresa no prompt) |
| 5 | Fork independente que **continua puxando** o upstream | Fork duro (perderia correção de segurança e de bug que outra pessoa mantém). PR upstream antes do deploy (bloquearia a o cliente motivador na revisão de um mantenedor que não somos nós) |

**Consequência da 5:** o código nasce no padrão da doutrina do repo — tripla de migration,
apêndice idempotente, fragmento de release, teste que fica vermelho sem a mudança. Não por
obrigação com terceiros, mas porque é o que mantém o custo de `git merge upstream/main` baixo:
o apêndice do `baseline.sql` cresce dos dois lados, e conflito de "ficar com os dois blocos"
só é barato se os dois blocos seguirem a mesma forma.

---

## 3. Modelo de dados

Duas tabelas e uma coluna. Espelham a convenção de `channel_routing_policies` /
`channel_routing_responsibles` (`baseline.sql:22343`), inclusive a **FK composta** — que é o
que torna *impossível*, e não só improvável, vincular um usuário de outra organização.

```sql
create table if not exists public.attendance_teams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  slug            text not null,
  description     text not null default '',
  schedule        jsonb not null default '{}'::jsonb,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table if not exists public.attendance_team_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  team_id         uuid not null,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (organization_id, team_id)
    references public.attendance_teams(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.user_organizations(organization_id, user_id) on delete cascade
);

create index if not exists attendance_team_members_org_user
  on public.attendance_team_members(organization_id, user_id);

alter table public.conversations
  add column if not exists team_id uuid references public.attendance_teams(id) on delete set null;

create index if not exists conversations_org_team
  on public.conversations(organization_id, team_id) where team_id is not null;
```

RLS: `tenant_isolation_attendance_teams_all` e `tenant_isolation_attendance_team_members_all`
via `fn_user_org_ids()`, com `revoke all` + `grant select to authenticated, service_role` no
molde das gêmeas — **escrita só por RPC `security definer`**.

⚠️ **Eu resolvi esta tensão ERRADO, e o CI mostrou.** O parágrafo original dizia: o `CLAUDE.md`
manda nomear `tenant_isolation_<tabela>_all`, as gêmeas usam `_select`, "vale a doutrina: policy
`for all`, e o GRANT continua só de SELECT — policy larga com grant estreito é seguro".

O raciocínio sobre segurança estava certo e a conclusão estava errada, porque eu li uma linha sobre
o **nome** da policy como se mandasse o **comando**. E existe um gate que proíbe exatamente isso:
`tests/invariants/rbac-config-ia-canais.test.ts` — *"nenhuma tabela NOVA entra com policy ALL
só-tenancy"* — reprova toda policy `cmd = ALL` cujo predicado não mencione `role_at_least`, porque
essa é a forma da dívida de RBAC que o repo parou de aceitar.

**O estado correto, entregue pela migration 0265:** as duas policies são `for select`, com o nome
acompanhando (`tenant_isolation_<tabela>_select`), como as gêmeas. O `for all` nunca foi necessário:
a escrita não passa por RLS (é pelas três `security definer`, que rodam como o dono) e o `revoke all`
tira INSERT/UPDATE/DELETE dos três papéis do PostgREST — medido em produção.

A leitura **não** ganha `role_at_least` de propósito: o inbox precisa NOMEAR o time de uma conversa,
e o selo é visível a `viewer`. Restringir a leitura por papel imprimiria "Sem time" numa conversa
que tem time.

A lição: "policy larga com grant estreito é seguro" é verdade sobre segurança e irrelevante para a
pergunta que o gate faz, que é sobre **dívida**. Largura sem consumidor é dívida mesmo quando é
inofensiva.

### Por que cada campo (DIRC)

- **`slug`** — armazenado, não derivado de `name`. É identidade própria: a empresa pode querer
  `financeiro` para um time chamado "Financeiro / Cobrança". E como o agente lê o catálogo em
  runtime (decisão 4), renomear o time ou trocar o slug **não quebra prompt nenhum** — essa é a
  virtude concreta daquela decisão, e o motivo de o slug poder ser editável sem medo.
- **`description`** — é o "quando usar" que o agente lê para decidir. Vive aqui porque é
  configuração da empresa, não prompt do agente.
- **`schedule`** — mesmo shape `{timezone, windows}` de `attendant_availability.schedule`,
  validado pelo **mesmo** `availabilityScheduleSchema`. `windows: []` (o default `{}`) = sem
  restrição, então time criado sem horário se comporta como hoje.
- **`archived_at`** — arquiva, nunca apaga. Conversa encerrada mês passado aponta para o time;
  apagar seria cascade fantasma (anti-pattern 7) ou perda de histórico. O `on delete set null`
  na conversa é rede de segurança para quem apagar por SQL — a tela só arquiva.

**Não entraram:** `is_primary` no vínculo (recusado na decisão 1), `position` para ordenar (a
tela ordena por nome), `capacity` por time (a capacidade é do atendente — decisão 1).

---

## 4. Roteamento

Uma mudança, em um arquivo, cobrindo os três consumidores. O cabeçalho de `lib/routing/eligibles.ts`
declara que ele unifica worker (cron), handoff v2 e `crm_get_queue_status` — "UM algoritmo, não
três divergentes". Filtrar por time ali cobre os três de uma vez.

`RoutingScope` ganha um campo **opcional** em cada variante. Não é variante nova:

```ts
export type RoutingScope =
  | { kind: "conversation_channel"; channelSessionId: string; teamId?: string | null }
  | { kind: "organization_summary"; teamId?: string | null };
```

**Por que campo e não variante.** Uma variante `{ kind: "team"; teamId }` perderia a restrição
de canal — e handoff para time *num canal* precisa das duas ao mesmo tempo. Time é ortogonal ao
canal: canal é **por onde se fala**, time é **sobre o quê**.

Dentro de `loadEligibleAttendants`, duas regras:

1. **Quem** — com `teamId`, carrega `attendance_team_members` e intersecta com o conjunto
   `allowed` que a política de canal já produz. Time sem membros é restrição explícita ⇒ `[]`
   (a mesma leitura que o arquivo já faz de "policy existente vazia é restrição, não ausência").
2. **Quando** — o horário do time é o mesmo para todos os candidatos, então é *uma* checagem,
   não uma por pessoa: `isWithinSchedule(scheduleDoTime, now) === false` ⇒ `[]` imediatamente.
   Fora disso, cada atendente segue passando pelo `isAttendantEligible` de sempre.

**Nenhuma função nova.** A interseção da decisão 3 é composição de duas chamadas da mesma função
pura que já existe.

**Não-regressão:** todo chamador que não passar `teamId` se comporta exatamente como hoje.

### Agenda ilegível: o resolvedor NÃO lança (decisão de 2026-09-16)

`availabilityScheduleSchema.parse` **lança** num `schedule` que o banco aceita — a coluna é `jsonb`
sem CHECK, e um fuso como `America/Asunción` (com o acento que um hispanofalante escreve natural)
passa na escrita e explode na leitura. O mesmo `parse` está em **três** pontos: `lib/times/catalogo.ts`,
`lib/routing/eligibles.ts` na agenda do TIME, e `lib/routing/eligibles.ts` na agenda do ATENDENTE.

Medido: um único registro ilegível derrubaria a tela de Times, a tool `crm_list_teams` **e o
roteamento da organização inteira** — porque o código lança antes de decidir qualquer coisa.

**Decisão: agenda ilegível = fechado, e visível.** `safeParse` nos três pontos; quem não puder ser
lido é tratado como fora do horário (time inelegível, atendente inelegível) e marcado como
`horario_invalido` para a tela.

Por que fechado e não 24/7: fechado parece mais severo, mas é **visível** — a conversa espera na
fila do time e o aviso que já existe na Central dispara quando as tentativas esgotam, nomeando o
time (§7). Já "sem restrição" faria Cancelamentos receber cliente às 3h da manhã com a tela
mostrando "aberto agora", que é uma mentira sem sintoma.

É o mesmo formato do precedente **"Resolvedor NUNCA lança"** do branding (`CLAUDE.md`): peça lida em
toda tela degrada para o padrão e segue, nunca derruba.

**O ponto da agenda do ATENDENTE entra junto, e não é escopo que vazou.** Ele é pré-existente e mais
exposto (`attendant_availability` aceita INSERT/UPDATE de `anon`, `authenticated` e `service_role`,
medido; `attendance_teams` não aceita de nenhum), fica a duas linhas do que estamos consertando, e
usa o mesmo helper. Deixá-lo lançando seria conhecer o defeito e passar ao lado.

**NÃO entra:** validar o jsonb na origem (dentro da RPC). Fecharia o lado dos times e não o do
atendente, que é o mais largo, e exigiria uma 0264 de forward-fix porque a 0263 já está aplicada.
Fica como melhoria posterior.

### A correção que isso arrasta

`getQueuePosition` (`lib/routing/queue.ts`) precisa receber o time e filtrar por ele. Sem isso o
agente diria ao cliente "você é o 3º da fila" contando conversas de outros setores — número
errado dito com confiança, que é a falha-em-verde que a doutrina do repo trata como pior defeito.

---

## 5. As tools do agente

### `crm_list_teams` (nova, leitura)

Devolve, por time não arquivado: `{ slug, name, when_to_use, open_now, eligible_count }`, mais um
`next_action` no padrão já provado do `crm_list_available_attendants` — que é o que impede o
agente de prometer atendimento imediato para um setor fechado.

`category: "read"`, `requiresRole: "agent"`, `requiresScope: "mcp:read"`.

### `crm_request_human_handoff` ganha `team?: string` (o slug)

**A ordem importa:** a validação do slug acontece **antes** do `triggerHandoff`, enquanto nada
foi mutado ainda. Slug inválido devolve recusa estruturada com `available_teams`, e o modelo se
corrige sozinho na chamada seguinte. Validar depois deixaria a conversa em `pending` com o bot
silenciado e sem destino — pior que recusar.

Com `team` válido: grava `conversations.team_id` e passa `teamId` no `RoutingScope`. Sem `team`:
comportamento idêntico ao de hoje.

### Adendo de 2026-09-21 — o catálogo vai DENTRO da ferramenta de transferência

**Medido em produção.** Com os setores `comercial`, `cobranca`, `suporte-tecnico`,
`cancelamentos` e `fornecedores-e-parceiros`, o agente (Claude Sonnet 5) não chamou
`crm_list_teams` antes de transferir e passou `team: "fornecedores"` — slug que não existe.
Numa rodada anterior, transferiu sem `team`, para a fila geral. A recusa estruturada desta seção
funcionou como desenhada: o modelo se corrige na chamada seguinte. Mas gasta um step, e o turno
pode acabar antes da correção. A descoberta por tool pressupunha que o modelo **lembraria** de
consultar — e capacidade que depende de o modelo lembrar existe metade das vezes.

**O que mudou.** Ao montar as ferramentas do turno, o motor lê os setores ativos da organização
e os entrega na própria ferramenta nativa de transferência (`request_human_handoff`,
`ferramentaDeTransferencia` em `lib/agent-engine/agent/inbound-turn.ts`): a descrição lista
`slug — nome — quando usar`, e `team` ganha `enum` com os slugs no JSON Schema que o modelo lê.

**A decisão 4 continua valendo.** O que ela recusou foi o slug **escrito no prompt** de cada
organização e um enum **fixo do produto**. Isto não é nenhum dos dois: o catálogo sai do banco a
cada turno, por organização, e renomear ou trocar um setor continua sem tocar em prompt nenhum.
Muda o **momento** da descoberta — da chamada que o modelo talvez faça para a montagem que o
motor sempre faz —, não a origem.

**Os limites, cada um com o porquê:**

- **Só o estável.** Slug, nome e "quando usar" mudam raramente, e a ferramenta faz parte do
  prefixo de prompt cacheado por organização (`stable-prefix.ts`). "Aberto agora" e quantas
  pessoas podem assumir mudam a cada minuto: no prefixo, derrubariam o cache a cada turno.
  Continuam em `crm_list_teams`, que a descrição ainda cita para essa pergunta.
- **O `enum` está no schema, não na validação do SDK.** É `.meta({ enum })`, não `z.enum`: o
  modelo vê a lista, mas um slug fora dela ainda chega à recusa desta seção — que ensina com a
  lista e com "nada foi alterado" — em vez de morrer num erro de validação cru do SDK.
- **A leitura é a do validador.** `setoresDaTransferencia` usa a mesma consulta `pg` que valida
  o slug em `applyRequestHumanHandoff` — o slug que o modelo vê e o que é aceito saem da mesma
  leitura. Não usa `lib/times/catalogo.ts`: aquele carregador fala supabase-js, que é HTTP, e a
  prévia do botão Testar não pode fazer nenhuma ida HTTP
  (`tests/invariants/autonomia-preview-core.test.ts`).
- **Sem setores, nada muda.** A ferramenta é a mesma de antes, sem `enum`. Leitura que falha
  também cai nela, com um aviso no log: transferir sem o mapa é prejuízo; derrubar o turno seria
  não atender.
- **O handoff determinístico (regex, antes do modelo) não passa por aqui.** Pedido explícito de
  humano continua indo à fila geral, e o catálogo só é lido depois que esse caminho já retornou.

Provas: `tests/unit/transferencia-conhece-os-setores.test.ts` (forma da ferramenta, queda para a
forma antiga) e `tests/invariants/transferencia-conhece-os-setores.test.ts` (do
`attendance_teams` ao que o provider recebe, com setor arquivado de fora).

---

## 6. Tela e API

Entrada nova em `lib/navigation/catalogo.ts` — grupo `organizacao`, seção "Sua empresa",
`minRole: "manager"`:

> **Times de atendimento** — "Os setores que recebem conversa: quem está em cada um e a que horas atendem."

O rótulo diz "de atendimento" de propósito: **"Equipe" já existe** (`/app/team`) e significa
*todo mundo da organização*. Dois itens vizinhos chamados "Equipe" e "Times" seriam adivinhação.

Rotas no molde exato de `app/api/v1/settings/routing/channels/route.ts`: leitura pelo client do
usuário (RLS de verdade), escrita por RPC `security definer` com a org de `auth.org.orgId`
(**nunca do body**), `requireRole("manager")`, `mfaEmDivida()`, `requireSupportWrite()`, `audit()`
e códigos de erro do Postgres mapeados para mensagens de usuário.

No inbox: o parâmetro `team_id` no filtro (a rota já aceita `comando`, `tag`,
`channel_session_id` — mesma forma) e o selo do time no cabeçalho da conversa, com a ação
"Transferir para time".

### Limite declarado: filtro, não barreira

O filtro do inbox tem padrão inteligente (as filas dos meus times + as sem time), mas **quem
enxerga o quê continua governado por `organizations.settings.visibility_mode`**. Time não é
barreira de leitura nesta entrega.

Transformar time em restrição de visibilidade exigiria mexer em `fn_can_view_conversation`, que
governa **toda** leitura de conversa do produto — errar ali dá vazamento entre organizações ou
tela vazia. Fica para uma segunda entrega, medida à parte. Dizer que é restrição quando é filtro
seria exatamente a falha-em-verde que esta spec se compromete a evitar.

---

## 7. O laço de retorno (Living System Checklist — DoD 13)

Duas das três peças **já existem**. O que parecia construção é extensão:

- `POST /api/v1/conversations/[id]/transfer` já transfere conversa para **pessoa**, via
  `fn_conversation_assign`, com evento auditado na mesma transação.
- `fn_routing_unassigned_notice` (`baseline.sql:22486`) **já abre** o aviso na Central quando as
  tentativas de roteamento esgotam, e `fn_routing_assignment_changed` **já o resolve** quando
  alguém assume.

O que muda: o corpo do aviso hoje diz *"Confira os responsáveis do canal em Configurações →
Atendimento"*. Para uma conversa parada na fila de Cancelamentos, isso manda o manager olhar o
lugar errado. O aviso passa a **nomear o time**.

| Invariante | Artefato concreto |
|---|---|
| Entrada | `crm_request_human_handoff(team)` e a transferência manual pela tela |
| Saída | `conversations.team_id` → fila do time no inbox |
| Log | `conversation_assignment_events` (`reason='team_transfer'`) + `api_audit_log` (`routing.team_changed`) |
| Tela | `/app/settings/teams`, filtro do inbox, selo no cabeçalho da conversa |
| Porta | `NAV_CATALOG` — `tests/unit/navegacao-completude.test.ts` reprova tela sem porta |
| Anti-morte | `fn_routing_unassigned_notice`, passando a nomear o time |
| Laço quando erra | O atendente transfere de time; a Central nomeia o setor vazio; `fn_routing_assignment_changed` resolve o aviso sozinho quando alguém assume |

**Transferência para time** é uma RPC atômica: grava `team_id`, **solta o dono atual** e deixa a
trigger `trg_routing_assignment_changed` pedir o roteamento — que já existe e já faz isso quando
uma conversa fica sem dono. Nenhum caminho novo de distribuição.

---

## 8. As provas

Teste vermelho **antes** da correção, e **sabotagem** depois para provar que ele vigia:

1. **`lib/routing/eligibles.test.ts`** — atendente fora do time não entra; e a que vigia a
   decisão 3: **time fechado devolve `[]` mesmo com atendente disponível e dentro do horário
   dele**. Sabotagem: remover a checagem do horário do time e confirmar o vermelho.
2. **Posição na fila por time** — impede a falha-em-verde descrita em §4.
3. **`tests/invariants/`** — isolamento RLS entre duas organizações nas duas tabelas novas.
   Roda no `pnpm test:db`, obrigatório porque isto mexe em schema.
4. **E2E pela tela** — criar time, alocar atendente, definir horário, ver a conversa cair na fila
   certa. Precisa entrar em `SPECS_PARTE_*` ou em `FORA_DO_CI` **com motivo escrito**, senão
   `tests/unit/e2e-cobertura-completa.test.ts` reprova.

Gates antes de qualquer PR: `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`, `pnpm test:unit`
(sem caminho — o script alcança o repo inteiro), `pnpm test:db`, `pnpm build`.

---

## 9. Entrega

**Tripla de migration** (o hook de `pre-commit` reprova se faltar peça):

1. `supabase/migrations/20260916HHMMSS_0263_times_de_atendimento.sql` — o próximo `NNNN` medido
   pela régua da doutrina (`ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`
   devolveu `0262` em 2026-09-16; **reconferir na hora**, porque outra sessão pode ter avançado).
2. Apêndice **idempotente** no fim de `supabase/baseline.sql`, rotulado
   `-- ---- times de atendimento (migration 0263) ----`. É o que o kit self-host aplica; o que
   não chegar lá não chega em quem instalou numa VPS.
3. Linha em `supabase/migrations/MANIFEST.md`.

**Fragmento de release** em `.changes/times-de-atendimento.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: O atendimento agora vai para o time certo
---
```

**Ordem sugerida de implementação** (cada passo verde antes do seguinte): schema + RLS +
invariante de isolamento → `eligibles.ts` + testes → `getQueuePosition` por time → tools do
agente → RPCs e rotas → tela + porta na navegação → transferência + aviso nomeando o time →
E2E → fragmento.

---

## 10. Fora de escopo (deliberado)

Transbordo automático (recusado na decisão 2), time primário, capacidade por time, métricas por
time, `crm_get_queue_status` por time, e permissão de **leitura** por time. Nada disso é
bloqueado pelo desenho: os dados ficam gravados desde o dia 1, então qualquer um entra depois
sem retrabalho.

---

## 11. O que NÃO foi medido

Honestidade sobre os limites deste documento, porque desenho não é prova:

- **Nada foi executado.** Esta spec é desenho validado contra o código lido, não contra
  comportamento observado. Nenhuma migration foi aplicada, nenhum teste rodou.
- **A VPS não foi inspecionada.** Se o `.env` de produção não tiver `APP_IMAGE` apontando para
  `ghcr.io/paulocmbcosta/...`, `app.dyper.com.br` está rodando a imagem do upstream e **nenhuma
  linha desta feature chegará lá**, por mais verde que fique o CI. Isso precisa ser verificado
  antes do primeiro deploy — é uma falha-em-verde à espera.
- **O banco de desenvolvimento é o de produção** (decisão consciente do dono). Aplicar a
  migration localmente altera o banco real. Hoje há pouquíssimo dado, mas isso muda quando a
  o primeiro cliente de porte entrar.
- **A carga não foi medida.** `attendance_team_members` entra no caminho quente do roteamento
  (uma query a mais por decisão). Com os volumes de hoje é irrelevante; com cinco setores e
  centenas de conversas/dia, não foi medido.
- **`agent_cases.kind`** aparece no documento de contexto mas **não** em `lib/database.types.ts`.
  Não foi investigado, e não é usado por este desenho.
