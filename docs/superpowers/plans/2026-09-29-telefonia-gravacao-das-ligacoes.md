# Telefonia · Gravação das ligações — plano de implementação

> **Para quem executa:** este plano foi escrito e executado na MESMA sessão
> autônoma (o dono dormindo, DYD-53), em linha (superpowers:executing-plans),
> com commits por tarefa. O código de cada tarefa é escrito direto nos arquivos
> listados; aqui ficam as interfaces, as regras e os testes que cada uma exige.

**Objetivo:** gravar a conversa das ligações do telefone (com aviso), mostrar a
gravação no cartão da ligação com player auditado, podar pela retenção.

**Arquitetura:** o Asterisk grava a ponte em WAV pela ARI; o worker baixa pela
ARI, converte para MP3 (ffmpeg) e anexa à mensagem da ligação no bucket
`whatsapp-media`; `voice_calls.recording_status` é a fonte da verdade e
`messages.metadata.voice_call.gravacao` a projeção do cartão. Desenho:
`docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md`.

**Stack:** Next.js route handlers, pg (worker e rotas), supabase-js (Storage),
ARI HTTP, ffmpeg (Alpine), Vitest, Playwright.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/telefonia/gravacao.ts` (novo, client-safe) | Vocabulário (espelho dos CHECKs), retenções, leitor da projeção `gravacaoDaLigacao`, nome no Asterisk, duração do WAV, regra "esperar ou falhar". |
| `supabase/migrations/…_0289_telefonia_gravacao.sql` (novo) + apêndice do `baseline.sql` + `MANIFEST.md` | Colunas em `phone_settings` e `voice_calls`, kind da fala, kind da Central, índices, comentários. |
| `lib/channels/telefonia/ari.ts` | `gravarPonte`, `pararGravacao`, `tocarNaPonte`, `baixarGravacao` (stream para arquivo), `apagarGravacao`, `listarGravacoes`. |
| `lib/channels/telefonia/controle.ts` | Porta `PortaGravacao` (6º parâmetro, padrão "sem gravação"), fala `gravacao` antes do menu/fila, gravação na ponte, aviso+gravação no ANSWER da feita, parar no fim, chute ao encerrar. |
| `lib/channels/telefonia/gravacoes.ts` (novo) | `GravacoesDaTelefonia`: implementa `PortaGravacao`, processa (baixar → converter → subir → anexar → apagar), passada (pendentes, falhas vencidas, órfãs). |
| `lib/channels/telefonia/repositorio.ts` | `politicaDeGravacao`, `marcarGravando`, leituras/escritas do processamento, `recording_status` nas colunas da ligação, projeção em `registrarNaConversa`. |
| `lib/channels/telefonia/laco.ts` | Liga o processamento ao laço (porta da ARI, banco, Storage, ffmpeg) e à passada de 60 s. |
| `Dockerfile.worker` | `apk add --no-cache ffmpeg`. |
| `lib/telefonia/falas.ts`, `vocabulario.ts`, `texto-do-menu.ts`, `components/connections/telefone/VozEFalas.tsx` | Fala geral `recording_notice`. |
| `lib/telefonia/gravacao-da-org.ts` (novo, server) + `app/api/v1/telefonia/gravacao/route.ts` (novo) | Ler/salvar a política (admin), 409 sem aviso, auditoria. |
| `app/api/v1/telefonia/chamadas/[id]/gravacao/route.ts` (novo) | Escuta: agent+, RLS, caminho da org, URL assinada 10 min, auditoria. |
| `app/api/v1/messages/[id]/media/route.ts` | Recusa a mensagem de ligação (sem desvio da auditoria). |
| `components/connections/telefone/GravacaoDasLigacoes.tsx` (novo) + `api.ts` + `ConexoesShell.tsx` | Sub-aba Gravação. |
| `components/telefonia/CartaoDaLigacao.tsx` + `hooks/auth/AuthProvider.tsx` | Linha da gravação e player; ação `voice.recording.listen`. |
| `lib/telefonia/poda-das-gravacoes.ts` (novo) + `app/api/v1/cron/data-retention/route.ts` | Poda diária pela retenção. |
| `lib/ai/agent-inbox-copy.ts`, `lib/ai/inbox-destino.ts`, `lib/agent-engine/db/repository.ts` | Kind `phone_recording_failed`. |
| `lib/audit/actions.ts` | `phone.recording_settings_changed`, `phone.recording_listened`. |
| `lib/lgpd/export-collector.ts` | `recording_status` na exportação; comentário que dizia "gravação fora do produto". |
| `lib/i18n/dicionario.ts` | Espanhol de todo texto novo. |
| Docs: spec 20, mapa `docs/architecture/telefonia.architecture.json`, `docs/testing/user-journey-map.md`, `docs/threat-model.md`, `.changes/telefonia-gravacao.md` | Afirmações de estado e fragmento. |
| `tests/e2e/telefonia-gravacao.spec.ts` (novo) + `.github/workflows/e2e.yml` | Prova pela tela (GitHub Actions). |

## Tarefas

### T1 — Vocabulário puro (`lib/telefonia/gravacao.ts`)
- `ESTADOS_DA_GRAVACAO = ["recording","stored","failed","expired"] as const` (CHECK `voice_calls_recording_status_check`).
- `SITUACOES_DA_GRAVACAO = ["processando","pronta","falhou","expirada"] as const`.
- `RETENCOES_DA_GRAVACAO_DIAS = [30,60,90,180,365,730,1825] as const`, `RETENCAO_PADRAO_DIAS = 90`, piso/teto do CHECK 7..3650.
- `gravacaoDaLigacao(bruto): { situacao, duracao_ms } | null` — nunca lança; situação fora do vocabulário → null.
- `nomeNoAsterisk(vcId) = "g-"+vcId`, `vcIdDoNome(nome)` (só UUID), `TETO_DA_GRAVACAO_S = 7200`.
- `duracaoDoWavMs(bytes)` (cabeçalho 44 B, 8 kHz, 16 bits, mono).
- `destinoSemArquivo({ fimEm, agora })`: `"esperar"` até 2 min do fim; `"falhar"` depois. `PRAZO_TOTAL_MS = 30 min`: pendente mais velho que isso falha.
- Testes: `lib/telefonia/gravacao.test.ts` (leitor tolerante, nome↔id, duração, prazos).

### T2 — Migration 0289 + baseline + MANIFEST
- `phone_settings`: `recording_enabled boolean not null default false`, `recording_retention_days integer not null default 90` + CHECK `phone_settings_recording_retention_check` (7..3650), `recording_notice_prompt_id uuid` + FK composta `phone_settings_recording_notice_prompt_id_org_fkey` (on delete set null da coluna) — no bloco de FKs da 0288, que já é genérico.
- `phone_prompts_kind_check`: + `recording_notice`. No baseline, o bloco ÚNICO da 0288 passa a recriar a constraint quando a definição não tem o valor novo (uma só ocorrência de `add constraint`).
- `voice_calls`: `recording_status text`, `recording_notice_at timestamptz`; CHECKs `voice_calls_recording_status_check` e `voice_calls_recording_so_no_telefone_check` (criados uma vez, `not valid` + validação, como os da 0288); índices parciais `voice_calls_gravacao_pendente (ended_at) where recording_status = 'recording'` e `voice_calls_gravacao_guardada (organization_id, ended_at) where recording_status = 'stored'`.
- `agent_inbox_items_kind_check`: lista inteira + `phone_recording_failed` (bloco único do baseline editado; a migration reconstrói a lista inteira).
- Comentários de coluna. `notify pgrst`.
- `tests/invariants/vocabulario-banco-x-typescript.test.ts`: par `voice_calls.recording_status → ESTADOS_DA_GRAVACAO`.
- Prova local barata: `pnpm vitest run tests/unit/baseline-constraint-reconstruida.test.ts tests/unit/kind-check-migration-x-baseline.test.ts tests/unit/manifest*`; `test:db` no CI (`invariants`).

### T3 — Fala geral `recording_notice`
- `TIPOS_DE_FALA` e `FALAS_GERAIS` + `recording_notice`; `COLUNA_DA_FALA_GERAL.recording_notice = "recording_notice_prompt_id"`; `falasGeraisDaOrg` lê a coluna; `TEXTO_SUGERIDO.recording_notice = "Esta ligação poderá ser gravada para garantir a qualidade do atendimento."`; `TITULO`/`QUANDO_TOCA` em `VozEFalas`; espanhol.
- Testes existentes de falas/VozEFalas que enumeram as gerais: atualizar.

### T4 — ARI
- `gravarPonte(ponte, nome, maxS)` → `POST /bridges/{p}/record?name&format=wav&maxDurationSeconds&ifExists=overwrite&beep=false&terminateOn=none`.
- `pararGravacao(nome)` → `POST /recordings/live/{n}/stop` (404 ok).
- `tocarNaPonte(ponte, midia)` → `POST /bridges/{p}/play?media=` → id.
- `baixarGravacao(nome, destino)` → `GET /recordings/stored/{n}/file`, stream para arquivo, prazo 120 s; 404 → `"ausente"`.
- `apagarGravacao(nome)` (404 ok), `listarGravacoes()` → nomes.
- Testes em `ari.test.ts` com `fetch` dublado (caminho, método, 404).

### T5 — Repositório do worker
- `politicaDeGravacao(db, org) → { gravar: boolean; aviso: FalaDoBanco | null }` (só fala `ready`).
- `marcarGravando(db, org, vcId, avisoEm)` → `recording_status='recording', recording_notice_at` (só `sip_trunk`, org presa).
- `recording_status` em `COLUNAS_DA_LIGACAO` e em `LigacaoDoBanco`.
- `registrarNaConversa`: com `recording_status='recording'`, `metadata.voice_call.gravacao = { situacao: "processando", duracao_ms: null }`.
- Processamento: `gravacoesPendentes(db, limite)`, `mensagemDaLigacao(db, org, vcId)`, `anexarGravacao(db, …)` (transação: `update messages … where metadata ? 'voice_call'` com `jsonb_set`; 0 linhas → `"anonimizada"`; senão `voice_calls.recording_status='stored'`), `falharGravacao(db, org, vcId, motivo)` (status `failed`, projeção `falhou`, aviso `phone_recording_failed` com dedup `kind_e_titulo`), `marcarExpirada(db, org, vcId)`, `estadosDasGravacoes(db, ids)`.
- Testes: `tests/invariants/telefonia-gravacao.test.ts` no Postgres real (CI): projeção mesclada (não sobrescreve `voice_call`), anonimizada devolve `"anonimizada"`, org errada não alcança, CHECK recusa `recording_status` em `wacalls`.

### T6 — Controlador
- `PortaGravacao { politica(org); comecar({org,vcId,ponte,avisoEm}): Promise<boolean>; tocarAvisoNaPonte(ponte, midia): Promise<boolean>; parar(vcId): Promise<void>; aoEncerrar(org, vcId): void }`; `SEM_GRAVACAO`.
- Recebida: `gravacao: { avisoEm: number | null; menu: MenuDoBanco | null } | null`. Com conversa + política `gravar` + aviso → `porNoAr(aviso, "gravacao")`; `aposFala("gravacao", tocou)` → `avisoEm` se tocou → segue para menu ou fila. `pulada` → segue sem gravar. `sem_canal` → nada.
- `ramalAtendeu`: depois das duas pernas na ponte, `avisoEm` → `comecar`.
- Feita: política lida em `novaFeita`; no `ANSWER`: `falas.garantir(aviso)` → `tocarAvisoNaPonte` → `comecar(avisoEm = agora)`. Falha em qualquer passo → segue sem gravar.
- Fim (recebida, feita, recuperada): `parar(vcId)` antes de destruir a ponte quando houve ponte; em `finalizar`, `recording_status === 'recording'` → `aoEncerrar`.
- Nada de gravação lança para a ligação (try/catch com log).
- Testes em `controle.test.ts`, bloco próprio no fim: aviso antes do menu e da fila; sem conversa não avisa; aviso sem arquivo não grava e segue; ponte grava com `avisoEm`; ninguém atende → não grava; feita grava no ANSWER com aviso na ponte; sem aviso no disco a feita não grava; fim para a gravação e chuta o processamento; política que lança não derruba a ligação.

### T7 — Processamento (`gravacoes.ts`)
- `GravacoesDaTelefonia(portas)`, implementa `PortaGravacao` delegando ARI/banco.
- `processar(org, vcId)`: em curso → volta. Sem mensagem → espera (falha após 30 min). `baixarGravacao` → `"ausente"` → `destinoSemArquivo`. Converte (`ffmpeg -i g.wav -ac 1 -ar 16000 -c:a libmp3lame -b:a 24k g.mp3`), sobe `<org>/<conversa>/<mensagem>.mp3` (upsert), `anexarGravacao`; `"anonimizada"` → apaga o objeto e `marcarExpirada`. Apaga o WAV no Asterisk. Temporários sempre limpos.
- `passada()`: pendentes (limite 5, em série); órfãs (`listarGravacoes` → `g-<uuid>` cujo estado não é `recording` → apagar).
- Testes `gravacoes.test.ts` com dublês: êxito (ordem das chamadas e caminho), 404 cedo espera, 404 tarde falha, sem mensagem após 30 min falha, anonimizada apaga, conversor falha → tenta de novo e depois falha, órfã apagada e viva preservada, reentrância.

### T8 — Laço + imagem do worker
- `laco.ts`: `portaAriDaGravacao(ari)`, `gravacoesDoWorker(pool, ari, log)` com Storage `createAdminClient()` bucket `whatsapp-media` e conversor ffmpeg (spawn, `-nostdin -y`, erro com cauda do stderr). O controlador recebe a porta; a passada ganha a etapa "gravações das ligações" (guarda própria).
- `Dockerfile.worker`: `RUN apk add --no-cache ffmpeg` com o porquê.

### T9 — Política da organização (API)
- `lib/telefonia/gravacao-da-org.ts`: `lerPoliticaDaOrg(db, org)` → `{ ativa, retencaoDias, aviso: FalaPublica | null }`; `salvarPoliticaDaOrg(db, org, { ativa, retencaoDias })` → `"sem_aviso"` quando liga sem aviso pronto; upsert de `phone_settings`.
- `GET/PUT /api/v1/telefonia/gravacao` (admin, `requireSupportWrite` no PUT, Zod `strict`, 409 `aviso_de_gravacao_ausente`, auditoria `phone.recording_settings_changed` só quando muda). Testes de rota.

### T10 — Escuta (API)
- `GET /api/v1/telefonia/chamadas/[id]/gravacao`: `requireRole("agent")`; id UUID; cliente de SESSÃO lê `messages` por `external_id = 'ligacao:'+id` e org (RLS decide); sem mídia → 404 `gravacao_indisponivel`; `isMediaPathOwnedBy`; `createSignedUrl(path, 600)`; `audit("phone.recording_listened")`; `ok({ url, expira_em })`.
- `/api/v1/messages/[id]/media`: `external_id` começando com `ligacao:` → 404.
- Testes de rota (papel, 404 por RLS, caminho de outra org, auditoria, a rota genérica recusa).

### T11 — Tela: sub-aba Gravação
- `GravacaoDasLigacoes.tsx`: estado do aviso (link para `sub=falas`), interruptor (desabilitado sem aviso, com o porquê), retenção (select), texto de quem ouve / auditoria / espaço, salvar. `useGravacaoDoTelefone`/`useSalvarGravacao` em `api.ts`. `ConexoesShell`: `sub=gravacao`. Espanhol. Teste do componente.

### T12 — Tela: cartão
- `ligacaoDaMensagem` lê `gravacao` por `gravacaoDaLigacao`. Linha: processando / Ouvir (m:ss) → pede a URL → `<audio controls autoPlay>` / falhou / expirada. Botão só com `usePermission("voice.recording.listen")` (agent). Espanhol. Testes do cartão.

### T13 — Poda pela retenção
- `lib/telefonia/poda-das-gravacoes.ts`: `podarGravacoesVencidas({ db, storage, agora, lote })` — vencidas (join `phone_settings`, padrão 90) → remove do Storage → `messages` (limpa mídia, projeção `expirada`) + `voice_calls.expired`. Idempotente; falha do Storage não marca.
- `data-retention`: etapa nova, contagem no `retention.sweep_run`. Testes com dublês.

### T14 — Central, auditoria, LGPD
- Kind `phone_recording_failed` (copy, destino geral admin → `sub=gravacao`, union).
- Ações de auditoria.
- Exportação: `recording_status` no `VoiceCallRow` e no PDF/JSON se a tabela de chamadas lista colunas; comentário corrigido.

### T15 — Docs e fragmento
- Spec 20 (F3 feita, D1–D8), mapa de arquitetura (nós novos com ≥2 arestas), mapa de jornadas, threat model (rota de escuta), `.changes/telefonia-gravacao.md` (`capacidade_nova`).

### T16 — e2e
- `tests/e2e/telefonia-gravacao.spec.ts`: semeia ligação com gravação pronta (objeto no Storage local), atendente abre a conversa, clica em Ouvir, `<audio>` recebe URL assinada, auditoria registrada; admin liga a gravação sem aviso → recusa visível. Entra numa `SPECS_PARTE_*`.

### T17 — Verificação, PR, produção
- Local (leve): `pnpm typecheck`, `pnpm lint`, vitest dos arquivos tocados + cercas (`branding`, `i18n`, `baseline-*`, `navegacao`, `mapas-de-arquitetura`).
- Revisão de segurança por subagente antes do merge.
- PR → 4 checks → merge → release → `update.sh` na VPS → 307, health, banco (colunas), tronco `Registered` + conntrack 5060, ffmpeg no worker, gravação sintética de ponte (bridge play) pelo código do worker até o MP3, limpeza.
- Memória e passagem para o dono.
