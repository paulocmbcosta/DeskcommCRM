# Telefonia fase 2 — Versão 1 (URA e falas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A organização monta pela tela, com voz da ElevenLabs, um menu de voz (URA) que leva a ligação recebida ao time certo, as falas de aguarde / ninguém atendeu / fora do horário e um aviso de instabilidade por time — e o worker toca tudo isso nas ligações reais do tronco SIP.

**Architecture:** A API gera cada fala na ElevenLabs (`ulaw_8000`), guarda o áudio no bucket privado `phone-prompts` (`<org>/<hash>.ulaw`) e grava a linha em `phone_prompts`. O worker copia as falas prontas para o volume `telefonia-falas` (escrita no `worker`, só leitura no `asterisk`) e, na aplicação Stasis `crm`, toca-as pela ARI. A decisão da URA é uma regra pura (`lib/telefonia/ura.ts`); o controlador só executa ações. Schema na migration 0288 (tripla: migration + apêndice idempotente no `baseline.sql` + MANIFEST), RLS `tenant_isolation_<tabela>_all`, escrita só pela API com a organização resolvida da sessão.

**Tech Stack:** Next.js 16 Route Handlers, `pg` (Pool), Zod 4, Supabase Storage (service role), Asterisk ARI (HTTP + WebSocket), React 19 + TanStack Query, Vitest (jsdom/node), Playwright, Postgres 15 (`pnpm test:db`), Docker Compose.

**Desenho aprovado:** [`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`](../specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md). Este plano cobre só a **versão 1**: §2, §3.1, §4, §5.1, §5.2, §5.5 (parte da v1), §6 itens 1–4, 6 (menu, fora do horário, emergência) e 8, §7 e §10 no que tocam a v1, e o `allow_transfer=no` dos ramais (§5.3, "Rede de proteção"). Transferência (v2) e ramais (v3) ficam fora — exceto a coluna `phone_menus.accepts_extension`, que nasce na 0288 sem uso.

---

## Convenções que valem para TODAS as tasks

1. **Onde:** worktree `/Volumes/T9/Dyper/.claude/worktrees/bia-ixc-cobranca-tools-32a240`, branch `claude/telefonia-sip-fase2-ura-236f1e`. Antes da Task 1 (e ao retomar depois de qualquer merge na `main`): `git fetch origin && git merge origin/main` — nunca `reset`/force (doutrina de branches do CLAUDE.md).
2. **Rodar um teste de unidade:** `pnpm exec vitest run <arquivo>`. O `vitest.config.ts` usa `jsdom`; testes que precisam de Node puro (fs, `AbortController` do Node) começam com a linha `// @vitest-environment node`.
3. **Rodar invariantes de banco:** `pnpm test:db <arquivo>` (precisa de Docker local). Não edite arquivo enquanto ele roda: o script recusa o resultado se a árvore mudar no meio.
4. **i18n (gate `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`):** todo texto de tela em `app/` e `components/` passa por `t("...")`, e toda chave literal de `t()` precisa de entrada em `DICIONARIO` (`lib/i18n/dicionario.ts`) com `es`. As entradas novas vão logo antes do `};` que fecha `DICIONARIO` (a linha acima do comentário `/**\n * Traduz, ou devolve o próprio texto.`). **Chave repetida é erro TS1117**: as tasks já trazem só as chaves que NÃO existem (conferido em 2026-09-28); se o typecheck acusar duplicata, apague a linha nova. Chaves de uma palavra só aparecem sem aspas no arquivo (`Editar: { es: "Editar" }`).
5. **`lint:channels`:** fora de `lib/channels/`, nunca escreva o identificador do provider do tronco (o que começa com `sip_` e termina com `trunk`) nem em comentário. `lib/telefonia/`, `app/` e `components/` falam de "telefone"/"número", não do provider.
6. **`lint:role-rank`:** rota em `app/api` nunca compara `ROLE_RANK`; só `requireRole()`.
7. **Falha da ElevenLabs volta como 422 ou 502 — nunca 429/503.** O `apiClient` do navegador repete 429/503 sozinho, e cada repetição de síntese gasta crédito da conta do cliente.
8. **Commits:** mensagem em português, e o corpo termina com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Cada task diz o `git add` exato.
9. **`test:unit` completo** (só na Task 25): o protocolo do CLAUDE.md — log redirecionado, exit code como autoridade, rodapé e `grep FAIL` comparados.

---

## Estrutura de arquivos

### Criados

| Arquivo | Responsabilidade |
|---|---|
| `lib/telefonia/vocabulario.ts` | Vocabulário client-safe: tipos de fala, estados, desfechos do menu (espelhos dos CHECKs), bucket, teto de texto, DTOs (`FalaPublica`, `MenuPublico`, `AvisoDoTimePublico`) e mensagens de falha |
| `lib/telefonia/ulaw.ts` (+ `.test.ts`) | G.711 μ-law puro: decodificar/codificar, `ulawParaWav`, `lerWav`, duração = bytes/8 |
| `lib/telefonia/texto-do-menu.ts` (+ `.test.ts`) | `montarTextoDoMenu(opcoes)` e textos sugeridos das falas |
| `lib/telefonia/elevenlabs.ts` (+ `.test.ts`) | Cliente puro (fetch injetável): `listarVozes`, `sintetizar`, tradução de erro |
| `lib/telefonia/ura.ts` (+ `.test.ts`) | Máquina da URA: estado + evento → ação |
| `lib/telefonia/vencimento-da-emergencia.ts` (+ `.test.ts`) | Durações do aviso, `expiraEm`, `avisoVigente` |
| `lib/telefonia/ultimos-sete-dias.ts` (+ `.test.ts`) | Soma das escolhas do menu e o alerta "menu que confunde" |
| `lib/telefonia/chave-elevenlabs.ts` (+ `.test.ts`) | Chave da ElevenLabs em `ai_provider_credentials` (guardar, estado, decifrar) |
| `lib/telefonia/armazem.ts` | Porta do Storage (`phone-prompts`) e a implementação com o cliente de serviço |
| `lib/telefonia/falas.ts` (+ `.test.ts`) | Gerar/regravar/descartar fala; voz da organização; falas gerais |
| `lib/telefonia/servico-de-falas.ts` | Fiação da instalação para as rotas: sintetizador, armazém, contexto (chave + voz), status HTTP da falha |
| `lib/telefonia/menus.ts` (+ `.test.ts`) | Zod do menu, leitura com estatística, gravação em transação, arquivamento, "menu pronto para número" |
| `lib/telefonia/emergencias.ts` | Zod e SQL do aviso de instabilidade por time |
| `app/api/v1/telefonia/voz/chave/route.ts` (+ `.test.ts`) | GET estado (manager) / PUT chave (admin, valida listando vozes) |
| `app/api/v1/telefonia/voz/route.ts` | GET voz + falas gerais / PUT voz (admin) |
| `app/api/v1/telefonia/voz/vozes/route.ts` | GET vozes da conta (admin) |
| `app/api/v1/telefonia/falas/gerais/[tipo]/route.ts` (+ `.test.ts`) | PUT gerar fala geral (admin) |
| `app/api/v1/telefonia/falas/[id]/audio/route.ts` | GET bytes μ-law da fala (membro) |
| `app/api/v1/telefonia/menus/_salvar.ts` | Miolo comum de POST/PATCH do menu |
| `app/api/v1/telefonia/menus/route.ts` (+ `.test.ts`) | GET lista / POST cria (admin) |
| `app/api/v1/telefonia/menus/[id]/route.ts` | PATCH / DELETE arquiva (admin) |
| `app/api/v1/telefonia/emergencias/route.ts` | GET avisos dos times (membro) |
| `app/api/v1/telefonia/emergencias/[teamId]/route.ts` (+ `.test.ts`) | PUT liga / DELETE desliga (manager) |
| `app/api/v1/telefonia/emergencias/[teamId]/fala/route.ts` | POST gera a fala do aviso para ouvir (manager) |
| `lib/channels/telefonia/falas-no-disco.ts` (+ `.test.ts`) | Storage → volume: passada de 60 s, `garantir` antes de tocar, escrita atômica, órfãos |
| `supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql` | Migration 0288 |
| `tests/invariants/telefonia-ura-e-falas.test.ts` | RLS entre 2 organizações, grants, CHECKs, bucket, reaplicação do apêndice |
| `tests/invariants/telefonia-repositorio-da-ura.test.ts` | SQL do worker contra Postgres real |
| `tests/unit/telefonia-falas-no-volume.test.ts` | O volume `telefonia-falas` no compose (worker rw, asterisk ro, mesmo caminho do código) |
| `components/connections/telefone/api.ts` | Hooks de leitura das abas do telefone |
| `components/connections/telefone/TelefoniaDesligada.tsx` | Cartão "telefonia desligada" (extraído de `CanalTelefoneClient`) |
| `components/connections/telefone/EstadoDaFala.tsx` | Selo pronta / falhou / gerando / voz anterior |
| `components/connections/telefone/VozEFalas.tsx` | Aba Voz e falas |
| `components/connections/telefone/MenusDoTelefone.tsx` | Aba Menus (lista, editor, últimos 7 dias) |
| `components/telefonia/OuvirFala.tsx` | Busca o μ-law, converte em WAV, `<audio>` |
| `components/telefonia/useAvisosDeInstabilidade.ts` | Consulta (polling 60 s) e mutações do aviso |
| `components/telefonia/AvisoDeInstabilidadeDoTime.tsx` | Cartão do aviso em Configurações › Times |
| `components/telefonia/FaixaDoAvisoDeInstabilidade.tsx` (+ `.test.tsx`) | Faixa em todo o CRM |
| `components/telefonia/CartaoDaLigacao.test.tsx` | Cartão da ligação com menu, aviso e fora do horário |
| `components/connections/CanalTelefoneClient.destino.test.tsx` | Número apontando para menu |
| `app/app/ai/credentials/_components/CartaoElevenLabs.tsx` | Cartão da chave da ElevenLabs |
| `tests/e2e/telefonia-ura-e-falas.spec.ts` | Prova pela tela com ElevenLabs falsa |
| `.changes/telefonia-ura-e-falas.md` | Fragmento de release `capacidade_nova` |

### Modificados

| Arquivo | O quê |
|---|---|
| `lib/env.ts`, `.env.example` | `ELEVENLABS_API_BASE_URL` (opcional, só teste) |
| `supabase/baseline.sql` | Bloco único do `agent_inbox_items_kind_check` (+2 kinds) e apêndice da 0288 antes da varredura anon |
| `supabase/migrations/MANIFEST.md` | Linha da 0288 |
| `lib/agent-engine/db/repository.ts`, `lib/ai/agent-inbox-copy.ts`, `lib/ai/inbox-destino.ts` | Kinds `phone_prompt_unplayable` e `phone_emergency_expired` |
| `lib/audit/actions.ts` | Ações `phone.*` da v1 |
| `tests/invariants/vocabulario-banco-x-typescript.test.ts` | 3 pares novos |
| `tests/invariants/rls-completude-varredura.test.ts` | 4 tabelas em `PROVA_PROPRIA` |
| `lib/channels/telefonia/numeros.ts` (+ `numeros.test.ts`) | `menu_id`, validação do destino, leitura do menu |
| `app/api/v1/telefonia/numeros/route.ts`, `.../numeros/[id]/route.ts` | Destino e auditoria `phone.number_destination_changed` |
| `lib/channels/telefonia/repositorio.ts` | Situação do time, menu, falas, aviso, registro do menu, avisos vencidos, metadado do cartão |
| `lib/channels/telefonia/ari.ts` | `tocarFala` |
| `lib/channels/telefonia/pjsip.ts` (+ `pjsip.test.ts`) | `allow_transfer=no` no ramal |
| `lib/channels/telefonia/controle.ts` (+ `controle.test.ts`) | Falas na fila (§5.2) e URA (§5.1) |
| `lib/channels/telefonia/laco.ts` | Portas novas, passada das falas e dos avisos vencidos |
| `docker-compose.prod.yml` | Volume `telefonia-falas` |
| `components/connections/ConexoesShell.tsx` | Sub-abas do Telefone (`?sub=menus|falas`) |
| `components/connections/CanalTelefoneClient.tsx` | "Quando ligarem: time ou menu" |
| `components/telefonia/CartaoDaLigacao.tsx` | Menu, aviso ouvido, fora do horário |
| `app/app/ai/credentials/page.tsx`, `.../_components/CredentialsList.tsx` | Cartão ElevenLabs; lista só de LLM |
| `app/app/settings/teams/_client.tsx` | Cartão do aviso por time |
| `app/app/layout.tsx` | Faixa global |
| `lib/i18n/dicionario.ts` | Chaves novas |
| `scripts/gerar-env-e2e.sh`, `.github/workflows/e2e.yml` | Env da e2e e spec na `SPECS_PARTE_3` |
| `docs/specs/20-spec-telefonia-sip.md`, `docs/current-state.md`, `docs/testing/user-journey-map.md`, `docs/architecture/telefonia.architecture.json`, `tests/unit/mapas-de-arquitetura.test.ts` | DoD 16 e mapa vivo |

### Decisões de implementação registradas aqui (o desenho não as fixava)

- **Faixa global por polling de 60 s, não Realtime.** Medido em 2026-09-28: `attendance_teams` **não** está na publicação `supabase_realtime` (`grep -n "supabase_realtime" supabase/baseline.sql` não a cita), embora a RLS deixe o membro ler (`tenant_isolation_attendance_teams_select`). Pôr a tabela na publicação transmitiria toda edição de nome e horário de time, e o Realtime do navegador já falhou em silêncio como anônimo neste repo. O aviso vive horas; um minuto nas outras abas é aceitável, e na aba de quem liga/desliga a mutação invalida a consulta na hora.
- **Sub-abas do Telefone em `?sub=`**, não `?aba=`: `?aba=` já escolhe o canal em `ConexoesShell` (`?aba=telefone`). A URL fica `/app/connections?aba=telefone&sub=menus|falas` — o mesmo padrão de `?aba=oficial&sub=templates`.
- **Fora do horário sem fala gerada segue a fase 1** (fila de 2 min → perdida com "Ligar de volta"). Desligar em silêncio, sem explicação e sem aviso, seria um beco sem saída para quem ainda não cadastrou a chave da ElevenLabs. Ver "Pontos para o orquestrador decidir".
- **`default_invalid` = houve ao menos uma tecla errada no menu**; `default_no_input` = nenhuma tecla.
- **A chave da ElevenLabs não entra em `PROVEDORES`** (`lib/ai/pontos/provedores.ts`): aquela lista é de quem executa modelo de linguagem e casa com o registry do motor (`tests/unit/provedores-x-registry.test.ts`). Ela mora em `ai_provider_credentials` com `provider = 'elevenlabs'` (coluna de vocabulário aberto desde a 0127) e tem rota própria.

---
## Task 0: Passo zero A — o Asterisk toca o nosso `.ulaw` (medição local)

**Quem:** subagente implementador (ou o orquestrador). **Nada é commitado**: o que sai daqui é a evidência (em `.superpowers/`, que o `.gitignore` já ignora) e a decisão "ramo A" ou "ramo B", reportada ao orquestrador antes da Task 12.

**Por quê:** o desenho (§2.1) toca a fala por caminho absoluto num volume só leitura. Se o Asterisk da imagem `Dockerfile.asterisk` não tocar, o caminho muda (ramo B) — e isso decide duas constantes da Task 12 e a montagem do compose da Task 16. O arquivo de teste é um seno de 1 s codificado em μ-law 8 kHz: é byte a byte o formato que a ElevenLabs devolve em `ulaw_8000`, então não precisa da chave.

**Files:** nenhum arquivo do repositório. Trabalho em `.superpowers/passo-zero/`; evidência em `.superpowers/evidence/telefonia/`.

- [ ] **Step 1: Construir a imagem local**

```bash
cd /Volumes/T9/Dyper/.claude/worktrees/bia-ixc-cobranca-tools-32a240
docker build -f Dockerfile.asterisk -t deskcomm-asterisk:passo-zero .
```

Esperado: `naming to docker.io/library/deskcomm-asterisk:passo-zero` sem erro.

- [ ] **Step 2: Gerar o seno de 1 s em μ-law (8000 bytes)**

```bash
mkdir -p .superpowers/passo-zero .superpowers/evidence/telefonia
node -e '
const fs = require("node:fs");
function codificar(s) {
  const BIAS = 0x84, CLIP = 32635;
  const sinal = (s >> 8) & 0x80;
  if (sinal) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let expoente = 7;
  for (let m = 0x4000; (s & m) === 0 && expoente > 0; m >>= 1) expoente--;
  const mantissa = (s >> (expoente + 3)) & 0x0f;
  return ~(sinal | (expoente << 4) | mantissa) & 0xff;
}
const b = Buffer.alloc(8000);
for (let i = 0; i < 8000; i++) b[i] = codificar(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
fs.writeFileSync(".superpowers/passo-zero/seno.ulaw", b);
console.log("bytes", b.length);
'
```

Esperado: `bytes 8000`.

- [ ] **Step 3: Pôr o arquivo num volume NOMEADO, como o worker vai pôr (root, 0644/0755)**

`docker cp` em vez de bind mount: `/Volumes/T9` é disco externo, e o compartilhamento de arquivos do Docker Desktop pode esconder permissão real.

```bash
docker volume create passo-zero-falas
docker create --name passo-zero-carga -v passo-zero-falas:/dados alpine:3.22 \
  sh -c 'mkdir -p /dados/org-teste && cp /tmp/seno.ulaw /dados/org-teste/seno.ulaw && chmod 755 /dados /dados/org-teste && chmod 644 /dados/org-teste/seno.ulaw && ls -ln /dados/org-teste'
docker cp .superpowers/passo-zero/seno.ulaw passo-zero-carga:/tmp/seno.ulaw
docker start -a passo-zero-carga
docker rm passo-zero-carga
```

Esperado: uma linha `-rw-r--r-- 1 0 0 8000 ... seno.ulaw`.

- [ ] **Step 4: Subir o Asterisk com o volume só leitura no caminho absoluto (ramo A)**

```bash
docker run -d --name passo-zero-asterisk \
  -e TELEFONIA_ARI_PASSWORD=passo-zero-senha -e TELEFONIA_IP_PUBLICO=203.0.113.10 \
  -p 127.0.0.1:18088:8088 \
  -v passo-zero-falas:/var/lib/deskcomm/falas:ro \
  deskcomm-asterisk:passo-zero
timeout 90 sh -c 'until curl -fsS -u crm:passo-zero-senha http://127.0.0.1:18088/ari/asterisk/ping >/dev/null 2>&1; do sleep 2; done' && echo ARI-OK
```

Esperado: `ARI-OK`. (Se a ferramenta de shell bloquear `sleep`, espere pela mesma condição com a ferramenta de espera/Monitor.)

- [ ] **Step 5: Conferir módulo de formato, leitura pelo usuário do Asterisk e formatos**

```bash
{
  echo "== module show like format_pcm"; docker exec passo-zero-asterisk asterisk -rx "module show like format_pcm"
  echo "== core show file formats (ulaw)"; docker exec passo-zero-asterisk asterisk -rx "core show file formats" | grep -i ulaw
  echo "== id do usuario que roda o asterisk"; docker exec passo-zero-asterisk sh -c 'ps -o user,comm | grep asterisk | head -1'; docker exec -u asterisk passo-zero-asterisk id
  echo "== bytes lidos pelo usuario asterisk"; docker exec -u asterisk passo-zero-asterisk sh -c 'wc -c < /var/lib/deskcomm/falas/org-teste/seno.ulaw'
} 2>&1 | tee .superpowers/evidence/telefonia/passo-zero-a-ambiente.log
```

Esperado: `format_pcm.so ... Running`; a linha `ulaw` com as extensões (`pcm|ulaw|ul|mu|ulw`); o processo `asterisk` rodando como `asterisk`; `8000`.

- [ ] **Step 6: Escrever o cliente ARI de medição (um canal `Local/` entra no Stasis e toca a fala)**

Crie `.superpowers/passo-zero/ari-toca-fala.mjs` com exatamente:

```js
// Medição do passo zero A. Um canal Local entra na aplicação Stasis "crm" (nada
// mais está conectado a ela neste contêiner local) e a ARI toca a fala.
const BASE = process.env.ARI ?? "http://127.0.0.1:18088";
const AUTH = "Basic " + Buffer.from("crm:passo-zero-senha").toString("base64");
const MIDIA = process.argv[2];
if (!MIDIA) { console.error("uso: node ari-toca-fala.mjs <media>"); process.exit(64); }

const eventos = [];
const pedir = async (metodo, caminho) => {
  const r = await fetch(`${BASE}/ari${caminho}`, { method: metodo, headers: { Authorization: AUTH } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${caminho} -> ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
const url = `${BASE.replace(/^http/, "ws")}/ari/events?app=crm&subscribeAll=false`;
const ws = new WebSocket(url, { headers: { Authorization: AUTH } });
let canal = null;
const terminar = (codigo, resultado) => {
  console.log(JSON.stringify({ midia: MIDIA, resultado, eventos }, null, 2));
  try { ws.close(); } catch {}
  process.exit(codigo);
};
setTimeout(() => terminar(2, "prazo de 20 s estourado sem PlaybackFinished"), 20_000);

ws.onmessage = async (m) => {
  const ev = JSON.parse(String(m.data));
  eventos.push({
    tipo: ev.type,
    canal: ev.channel?.name,
    args: ev.args,
    playback: ev.playback && { id: ev.playback.id, state: ev.playback.state, media: ev.playback.media_uri },
    em: ev.timestamp,
  });
  try {
    if (ev.type === "StasisStart" && !canal) {
      canal = ev.channel.id;
      await pedir("POST", `/channels/${canal}/answer`);
      await pedir("POST", `/channels/${canal}/play?media=${encodeURIComponent(MIDIA)}`);
    }
    if (ev.type === "PlaybackFinished") {
      await pedir("DELETE", `/channels/${canal}`).catch(() => undefined);
      terminar(ev.playback.state === "done" ? 0 : 1, `PlaybackFinished state=${ev.playback.state}`);
    }
  } catch (e) {
    terminar(3, `erro: ${e.message}`);
  }
};
ws.onopen = () => {
  pedir("POST", `/channels?endpoint=${encodeURIComponent("Local/s@de-tronco")}&app=crm&appArgs=passo-zero`)
    .catch((e) => terminar(3, `originar falhou: ${e.message}`));
};
```

- [ ] **Step 7: Tocar pelo caminho ABSOLUTO (ramo A) e guardar a evidência**

```bash
node .superpowers/passo-zero/ari-toca-fala.mjs "sound:/var/lib/deskcomm/falas/org-teste/seno" \
  | tee .superpowers/evidence/telefonia/passo-zero-a-absoluto.json; echo "exit=${PIPESTATUS[0]}"
docker logs passo-zero-asterisk 2>&1 | grep -iE "seno|unable|does not exist|no such file|failed" \
  | tee .superpowers/evidence/telefonia/passo-zero-a-log-asterisk.txt
```

**Critério (ramo A aprovado):** `exit=0`; `resultado` = `PlaybackFinished state=done`; entre o `PlaybackStarted` e o `PlaybackFinished` o campo `em` avança ~1 s (0,8–1,5 s); o `grep` do log do Asterisk vem **vazio**. Aprovado → pule para o Step 9 e reporte "ramo A".

- [ ] **Step 8 (só se o Step 7 reprovar): ramo B — montar dentro de `astdatadir` e tocar por caminho relativo**

```bash
docker rm -f passo-zero-asterisk
docker run -d --name passo-zero-asterisk \
  -e TELEFONIA_ARI_PASSWORD=passo-zero-senha -e TELEFONIA_IP_PUBLICO=203.0.113.10 \
  -p 127.0.0.1:18088:8088 \
  -v passo-zero-falas:/usr/share/asterisk/sounds/deskcomm:ro \
  deskcomm-asterisk:passo-zero
timeout 90 sh -c 'until curl -fsS -u crm:passo-zero-senha http://127.0.0.1:18088/ari/asterisk/ping >/dev/null 2>&1; do sleep 2; done' && echo ARI-OK
node .superpowers/passo-zero/ari-toca-fala.mjs "sound:deskcomm/org-teste/seno" \
  | tee .superpowers/evidence/telefonia/passo-zero-b-relativo.json; echo "exit=${PIPESTATUS[0]}"
```

Mesmo critério do Step 7. **Ramo B aprovado** → reporte "ramo B" ao orquestrador; na Task 12 use `DIRETORIO_NO_ASTERISK = "deskcomm"` e na Task 16 monte o volume do `asterisk` em `/usr/share/asterisk/sounds/deskcomm:ro` (as duas tasks trazem o texto exato do ramo B). **Os dois ramos reprovados → PARE** e reporte ao orquestrador com os dois JSON e o log: o desenho de áudio (D12) precisa ser revisto antes de qualquer outra task.

- [ ] **Step 9: Limpar**

```bash
docker rm -f passo-zero-asterisk; docker volume rm passo-zero-falas
```

Esperado: os dois nomes impressos. Resultado da task = "ramo A" ou "ramo B", com os arquivos de `.superpowers/evidence/telefonia/passo-zero-a-*` (e `-b-*`).

---

## Task 0B: Passo zero B — as teclas da operadora chegam? (VPS de produção) — **ORQUESTRADOR, manual**

**Quem:** o orquestrador, **nunca um subagente**. Exige (1) autorização explícita do dono para mexer no log do Asterisk de produção e (2) o dono ligando do celular para o **(61) 3686-1503** e teclando. É só log: nada muda no atendimento. **Não** abra uma segunda conexão WebSocket da ARI na aplicação `crm` — ela roubaria os eventos do worker e derrubaria as ligações de verdade.

**Por quê:** o tronco anuncia `dtmf_mode=rfc4733` (`objetosDoTronco`, `pjsip.ts`). Se a operadora manda o DTMF na banda do áudio ou por SIP INFO, a URA nunca recebe `ChannelDtmfReceived` — e isso tem de aparecer aqui, não na prova final.

- [ ] **Step 1: Pedir ao dono** autorização para ligar o log de DTMF no Asterisk de produção por ~10 min, e combinar a ligação de teste. Peça também que **ninguém do time do número esteja disponível** (pausa): assim o worker atende a ligação com música em até 5 s (fila da fase 1) e a ligação fica ATENDIDA — DTMF antes de atender não é confiável.

- [ ] **Step 2: Entrar na VPS e achar o contêiner**

```bash
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0
cd /root/DeskcommCRM
AST="$(docker ps --filter name=asterisk --format '{{.Names}}' | head -1)"; echo "$AST"
docker exec "$AST" asterisk -rx "core show version"
```

Esperado: o nome do contêiner e `Asterisk 20.x`.

- [ ] **Step 3: Ligar um canal de log só de DTMF (dinâmico, sem tocar em arquivo de configuração)**

```bash
docker exec "$AST" asterisk -rx "logger add channel dtmf-teste dtmf,notice,warning"
docker exec "$AST" asterisk -rx "logger show channels"
docker exec "$AST" asterisk -rx "pjsip set logger method INFO"
```

Esperado: `dtmf-teste` listado com o nível `DTMF`. (O terceiro comando mostra no console um eventual SIP INFO; se a versão não aceitar `method`, ignore.)

**Se `logger add channel` não existir nesta versão:** abra um console interativo e deixe-o aberto durante a ligação: `docker exec -it "$AST" asterisk -rvvv`, digite `logger set level DTMF on` e `core set debug 1`, e copie as linhas com `DTMF` que aparecerem enquanto o dono tecla. Ao final, no mesmo console: `logger set level DTMF off`, `core set debug 0`, `exit`.

- [ ] **Step 4: O dono liga para (61) 3686-1503**, espera a música, tecla `1`, `2`, `3`, `*`, `#` com ~1 s entre elas, e desliga.

- [ ] **Step 5: Colher a evidência (da sua máquina local, em outra aba)**

```bash
cd /Volumes/T9/Dyper/.claude/worktrees/bia-ixc-cobranca-tools-32a240
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0 \
  'AST="$(docker ps --filter name=asterisk --format "{{.Names}}" | head -1)"; docker exec "$AST" cat /var/log/asterisk/dtmf-teste; echo "== INFO no log"; docker logs --since 15m "$AST" 2>&1 | grep -iE "INFO sip|application/dtmf|Signal=" | tail -20' \
  | tee ".superpowers/evidence/telefonia/passo-zero-b-dtmf-$(date +%F).log"
```

**Critério (DTMF chega):** o log tem as cinco teclas como `DTMF end '1' received on PJSIP/tronco-…` (e `2`, `3`, `*`, `#`). Chegou → **pule a Task 0C**.

- [ ] **Step 6: Desligar o log e limpar (sempre, mesmo se falhar)**

```bash
docker exec "$AST" asterisk -rx "logger remove channel dtmf-teste"
docker exec "$AST" asterisk -rx "pjsip set logger off"
docker exec "$AST" rm -f /var/log/asterisk/dtmf-teste
```

- [ ] **Step 7: Registrar o veredito** para as tasks seguintes: "DTMF chega por RFC 4733" (segue o plano) **ou** "não chegou" (+ se o log mostrou SIP INFO) → execute a Task 0C antes da Task 15.

---

## Task 0C (CONDICIONAL — só se a Task 0B reprovar): `dtmf_mode` do tronco

**Files:**
- Modify: `lib/channels/telefonia/pjsip.ts:118` (a linha `f("dtmf_mode", "rfc4733"),` de `objetosDoTronco`)
- Test: `lib/channels/telefonia/pjsip.test.ts`

Valor: **`info`** se o Step 5 da Task 0B mostrou `application/dtmf` / `Signal=` (SIP INFO); **`auto`** se não mostrou nada (o Asterisk passa a detectar DTMF na banda do áudio quando o RFC 4733 não é negociado). Abaixo, o código para `auto`; para `info`, troque só a string.

- [ ] **Step 1: Teste que falha**

Acrescente ao fim de `lib/channels/telefonia/pjsip.test.ts`:

```ts
describe("DTMF do tronco — medido na operadora (Task 0B do plano da fase 2)", () => {
  it("o endpoint do tronco usa o modo medido na ligação real", () => {
    const endpoint = objetosDoTronco(tronco).find((o) => o.tipo === "endpoint");
    expect(campo(endpoint, "dtmf_mode")).toEqual([DTMF_DO_TRONCO]);
    expect(DTMF_DO_TRONCO).toBe("auto");
  });
});
```

E troque o import do topo do arquivo por:

```ts
import { DTMF_DO_TRONCO, enderecoDeSaida, objetosDoTronco, problemaDoTronco, type ObjetoPjsip, type TroncoSip } from "./pjsip";
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/pjsip.test.ts`
Expected: FAIL — `DTMF_DO_TRONCO` não é exportado (`undefined`).

- [ ] **Step 3: Implementação**

Em `lib/channels/telefonia/pjsip.ts`, logo abaixo de `const f = (attribute: string, value: string | number): CampoPjsip => ...`, acrescente:

```ts
/**
 * Como o tronco recebe as teclas do cliente. Medido na operadora da Totus com
 * uma ligação real para o (61) 3686-1503 (plano da fase 2, Task 0B): com
 * `rfc4733` as teclas não chegavam como `ChannelDtmfReceived`, e a URA ficaria
 * surda. `auto` usa RFC 4733 quando negociado e detecta na banda do áudio quando
 * não. Evidência em `.superpowers/evidence/telefonia/passo-zero-b-dtmf-*.log`.
 */
export const DTMF_DO_TRONCO = "auto";
```

e troque, em `objetosDoTronco`, `f("dtmf_mode", "rfc4733"),` por `f("dtmf_mode", DTMF_DO_TRONCO),`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia/pjsip.test.ts`
Expected: PASS (todos os casos).

- [ ] **Step 5: Commit**

```bash
git add lib/channels/telefonia/pjsip.ts lib/channels/telefonia/pjsip.test.ts
git commit -m "fix(telefonia): DTMF do tronco no modo medido na operadora

A ligação real para o 3686-1503 não entregou as teclas com rfc4733; a URA
dependeria delas. O tronco muda de hash e é recriado no próximo arranque.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Nova medição** — depois do deploy desta correção (Task 28), o orquestrador repete a Task 0B. Só então a Task 29 (prova da URA) começa.

---

## Task 1: Vocabulário, μ-law e texto do menu (regras puras)

**Files:**
- Create: `lib/telefonia/vocabulario.ts`
- Create: `lib/telefonia/ulaw.ts`, `lib/telefonia/ulaw.test.ts`
- Create: `lib/telefonia/texto-do-menu.ts`, `lib/telefonia/texto-do-menu.test.ts`

- [ ] **Step 1: Criar o vocabulário (sem teste próprio: é espelho de CHECK, medido pela Task 5)**

Crie `lib/telefonia/vocabulario.ts`:

```ts
/**
 * O VOCABULÁRIO DA URA E DAS FALAS DO TELEFONE (migration 0288) — client-safe.
 *
 * Cada lista `as const` aqui espelha um CHECK do banco, e o espelho é MECÂNICO:
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara as duas contra
 * o Postgres real. Quem acrescenta um valor numa migration acrescenta aqui na
 * mesma mudança.
 *
 * Sem import nenhum, de propósito: a tela importa este arquivo, e o que ele
 * puxasse iria para o JavaScript do navegador.
 */

/** `phone_prompts.kind` — uma fala por linha. */
export const TIPOS_DE_FALA = ["menu", "invalid", "waiting", "nobody", "after_hours", "emergency"] as const;
export type TipoDeFala = (typeof TIPOS_DE_FALA)[number];

/** `phone_prompts.status`. "Gerando" não é estado do banco: é a requisição em curso na tela. */
export const ESTADOS_DA_FALA = ["ready", "failed"] as const;
export type EstadoDaFala = (typeof ESTADOS_DA_FALA)[number];

/** `voice_calls.menu_outcome` — o que aconteceu no menu de voz. */
export const DESFECHOS_DO_MENU = ["chosen", "default_no_input", "default_invalid"] as const;
export type DesfechoDoMenu = (typeof DESFECHOS_DO_MENU)[number];

/** As falas gerais da organização (`phone_settings.<tipo>_prompt_id`). */
export const FALAS_GERAIS = ["waiting", "nobody", "after_hours"] as const;
export type FalaGeral = (typeof FALAS_GERAIS)[number];

/** `voice_calls.end_reason` da ligação encerrada porque o time estava fora do horário. */
export const MOTIVO_FORA_DO_HORARIO = "after_hours";

/** Bucket PRIVADO do Storage com o áudio de cada fala (`<org>/<hash>.ulaw`). */
export const BUCKET_DAS_FALAS = "phone-prompts";

/** Teto de caracteres de uma fala — o mesmo do CHECK `phone_prompts_text_check`. */
export const TAMANHO_MAXIMO_DA_FALA = 1000;

/** O modelo de voz da ElevenLabs usado quando a organização não escolheu outro. */
export const MODELO_DE_VOZ_PADRAO = "eleven_multilingual_v2";

export type MotivoDoErroDaElevenLabs =
  | "chave_invalida"
  | "sem_credito"
  | "texto_recusado"
  | "voz_inexistente"
  | "limite_de_uso"
  | "sem_resposta"
  | "erro_do_provedor";

/** Por que uma fala não foi gerada. Gravado em `phone_prompts.error` quando `status = failed`. */
export type FalhaDaFala = "sem_chave" | "sem_voz" | "armazenamento" | MotivoDoErroDaElevenLabs;

/** O que a tela diz de cada falha. Em português; a tela passa por `t()`. */
export const MENSAGEM_DA_FALHA_DA_FALA: Record<FalhaDaFala, string> = {
  sem_chave: "Cadastre a chave da ElevenLabs em Credenciais de IA para gerar as falas.",
  sem_voz: "Escolha a voz das falas na aba Voz e falas antes de gerar.",
  armazenamento: "Não foi possível guardar o áudio da fala. Tente de novo em instantes.",
  chave_invalida: "A ElevenLabs recusou a chave. Confira a chave em Credenciais de IA.",
  sem_credito: "A conta da ElevenLabs está sem crédito. As falas já geradas continuam tocando.",
  texto_recusado: "A ElevenLabs recusou este texto. Encurte ou reescreva e tente de novo.",
  voz_inexistente: "Essa voz não existe mais na conta da ElevenLabs. Escolha outra voz.",
  limite_de_uso: "A ElevenLabs pediu para esperar um pouco. Tente de novo em instantes.",
  sem_resposta: "A ElevenLabs não respondeu. Tente de novo em instantes.",
  erro_do_provedor: "A ElevenLabs devolveu um erro. Tente de novo em instantes.",
};

export function ehFalhaDaFala(valor: string | null | undefined): valor is FalhaDaFala {
  return typeof valor === "string" && Object.hasOwn(MENSAGEM_DA_FALHA_DA_FALA, valor);
}

/** Uma fala como a tela a vê. Nunca leva o caminho do Storage nem o hash. */
export interface FalaPublica {
  id: string;
  tipo: TipoDeFala;
  texto: string;
  voice_id: string;
  status: EstadoDaFala;
  /** O código de `FalhaDaFala` quando `status = failed`. */
  erro: string | null;
  duracao_ms: number | null;
  atualizada_em: string;
}

export interface FalhaNaResposta {
  motivo: FalhaDaFala;
  mensagem: string;
}

export interface OpcaoDoMenuPublica {
  tecla: string;
  time_id: string;
  time_nome: string;
}

/** O laço de retorno do menu (desenho §8): o que as ligações dos últimos 7 dias fizeram nele. */
export interface UltimosSeteDias {
  total: number;
  por_tecla: Record<string, number>;
  sem_escolha: number;
  tecla_errada: number;
  desligou_no_menu: number;
}

export interface MenuPublico {
  id: string;
  nome: string;
  time_padrao_id: string;
  time_padrao_nome: string;
  opcoes: OpcaoDoMenuPublica[];
  fala: FalaPublica | null;
  fala_invalida: FalaPublica | null;
  /** A fala do menu (e a de tecla inválida, se houver) está pronta: pode ser ligado a um número. */
  pronto: boolean;
  /** Nomes dos números que tocam este menu. */
  numeros: string[];
  ultimos_7_dias: UltimosSeteDias;
}

export interface AvisoDoTimePublico {
  team_id: string;
  time_nome: string;
  /** Ligado e não vencido AGORA (a passada de 60 s do worker desliga os vencidos no banco). */
  ativa: boolean;
  desde: string | null;
  expira_em: string | null;
  ligada_por: string | null;
  fala: FalaPublica | null;
}
```

- [ ] **Step 2: Escrever o teste do μ-law (falha: o módulo não existe)**

Crie `lib/telefonia/ulaw.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { duracaoDoUlawMs, lerWav, pcm16ParaUlaw, ulawParaPcm16, ulawParaWav } from "./ulaw";

/** Um WAV μ-law (formato 7), como a ElevenLabs PODERIA devolver — para provar que `lerWav` o desembrulha. */
function wavMuLaw(dados: Uint8Array): Uint8Array {
  const b = new Uint8Array(44 + dados.length);
  const v = new DataView(b.buffer);
  const escrever = (i: number, s: string) => {
    for (let k = 0; k < 4; k++) b[i + k] = s.charCodeAt(k);
  };
  escrever(0, "RIFF");
  v.setUint32(4, 36 + dados.length, true);
  escrever(8, "WAVE");
  escrever(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 7, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  escrever(36, "data");
  v.setUint32(40, dados.length, true);
  b.set(dados, 44);
  return b;
}

describe("G.711 μ-law", () => {
  it("decodifica os valores de referência da tabela", () => {
    expect(ulawParaPcm16(0xff)).toBe(0);
    expect(ulawParaPcm16(0x7f)).toBe(0);
    expect(ulawParaPcm16(0x00)).toBe(-32124);
    expect(ulawParaPcm16(0x80)).toBe(32124);
  });

  it("codificar e decodificar volta perto do original (erro de quantização ≤ 4%)", () => {
    for (const s of [-30000, -1000, -100, 0, 100, 1000, 30000]) {
      const volta = ulawParaPcm16(pcm16ParaUlaw(s));
      expect(Math.abs(volta - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) * 0.04));
    }
  });

  it("silêncio codifica em 0xFF", () => {
    expect(pcm16ParaUlaw(0)).toBe(0xff);
  });

  it("1 byte por amostra a 8 kHz: 8000 bytes = 1000 ms", () => {
    expect(duracaoDoUlawMs(8000)).toBe(1000);
    expect(duracaoDoUlawMs(4)).toBe(1);
  });
});

describe("ulawParaWav — o que o navegador consegue tocar", () => {
  it("monta WAV PCM16 mono 8 kHz com o cabeçalho certo e as amostras decodificadas", () => {
    const wav = ulawParaWav(new Uint8Array([0xff, 0x00, 0x80]));
    const v = new DataView(wav.buffer);
    const txt = (i: number) => String.fromCharCode(...wav.subarray(i, i + 4));
    expect([txt(0), txt(8), txt(12), txt(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(16000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, -32124, 32124]);
  });

  it("o WAV montado é lido de volta por lerWav (PCM, mono, 8 kHz)", () => {
    const lido = lerWav(ulawParaWav(new Uint8Array(10)));
    expect(lido).toMatchObject({ formato: 1, canais: 1, taxa: 8000 });
    expect(lido!.dados.length).toBe(20);
  });
});

describe("lerWav", () => {
  it("bytes que não são WAV → null", () => {
    expect(lerWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it("WAV μ-law (formato 7) → só os bytes do bloco data", () => {
    const lido = lerWav(wavMuLaw(new Uint8Array([0xff, 0x7f, 0x00])));
    expect(lido).toMatchObject({ formato: 7, canais: 1, taxa: 8000 });
    expect([...lido!.dados]).toEqual([0xff, 0x7f, 0x00]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/ulaw.test.ts`
Expected: FAIL — `Failed to resolve import "./ulaw"`.

- [ ] **Step 4: Implementar o μ-law**

Crie `lib/telefonia/ulaw.ts`:

```ts
/**
 * μ-law (G.711), 8 kHz, mono — o formato que a ElevenLabs devolve em
 * `output_format=ulaw_8000` e que o Asterisk toca sem converter.
 *
 * Funções puras e client-safe: a tela usa `ulawParaWav` para OUVIR a fala no
 * navegador (navegador não toca μ-law cru), e o cliente da ElevenLabs usa
 * `lerWav` para desembrulhar o áudio se ele vier dentro de um WAV.
 */

export const AMOSTRAS_POR_SEGUNDO = 8000;

/** 1 byte por amostra a 8 kHz: 8 bytes = 1 ms. */
export function duracaoDoUlawMs(bytes: number): number {
  return Math.round(bytes / 8);
}

/** Um byte μ-law → uma amostra PCM de 16 bits. */
export function ulawParaPcm16(byte: number): number {
  const b = ~byte & 0xff;
  const sinal = b & 0x80;
  const expoente = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  const amostra = (((mantissa << 3) + 0x84) << expoente) - 0x84;
  // `0 - x`, e não `-x`: o zero negativo do JavaScript não é 0 para `Object.is`.
  return sinal ? 0 - amostra : amostra;
}

/** Uma amostra PCM de 16 bits → um byte μ-law. */
export function pcm16ParaUlaw(amostra: number): number {
  const BIAS = 0x84;
  const TETO = 32635;
  let s = Math.trunc(amostra);
  const sinal = (s >> 8) & 0x80;
  if (sinal) s = -s;
  if (s > TETO) s = TETO;
  s += BIAS;
  let expoente = 7;
  for (let mascara = 0x4000; (s & mascara) === 0 && expoente > 0; mascara >>= 1) expoente--;
  const mantissa = (s >> (expoente + 3)) & 0x0f;
  return ~(sinal | (expoente << 4) | mantissa) & 0xff;
}

/** WAV PCM16 mono 8 kHz com as amostras decodificadas — o que um `<audio>` toca. */
export function ulawParaWav(ulaw: Uint8Array): Uint8Array<ArrayBuffer> {
  const tamanhoDosDados = ulaw.length * 2;
  const wav = new Uint8Array(new ArrayBuffer(44 + tamanhoDosDados));
  const v = new DataView(wav.buffer);
  const escrever = (i: number, s: string) => {
    for (let k = 0; k < 4; k++) wav[i + k] = s.charCodeAt(k);
  };
  escrever(0, "RIFF");
  v.setUint32(4, 36 + tamanhoDosDados, true);
  escrever(8, "WAVE");
  escrever(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, AMOSTRAS_POR_SEGUNDO, true);
  v.setUint32(28, AMOSTRAS_POR_SEGUNDO * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  escrever(36, "data");
  v.setUint32(40, tamanhoDosDados, true);
  for (let i = 0; i < ulaw.length; i++) v.setInt16(44 + i * 2, ulawParaPcm16(ulaw[i]!), true);
  return wav;
}

/** Lê um WAV: formato (1 = PCM, 7 = μ-law), canais, taxa e os bytes do bloco `data`. `null` se não for WAV. */
export function lerWav(
  bytes: Uint8Array,
): { formato: number; canais: number; taxa: number; dados: Uint8Array } | null {
  if (bytes.length < 12) return null;
  const txt = (i: number) => String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
  if (txt(0) !== "RIFF" || txt(8) !== "WAVE") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let formato = -1;
  let canais = 0;
  let taxa = 0;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = txt(i);
    const tamanho = v.getUint32(i + 4, true);
    const inicio = i + 8;
    if (id === "fmt " && tamanho >= 8) {
      formato = v.getUint16(inicio, true);
      canais = v.getUint16(inicio + 2, true);
      taxa = v.getUint32(inicio + 4, true);
    }
    if (id === "data") {
      if (formato < 0) return null;
      return { formato, canais, taxa, dados: bytes.subarray(inicio, Math.min(inicio + tamanho, bytes.length)) };
    }
    i = inicio + tamanho + (tamanho % 2);
  }
  return null;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/ulaw.test.ts`
Expected: PASS (8 testes).

- [ ] **Step 6: Escrever o teste do texto do menu**

Crie `lib/telefonia/texto-do-menu.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FRASE_DA_OPCAO, TEXTO_SUGERIDO, montarTextoDoMenu } from "./texto-do-menu";

describe("montarTextoDoMenu", () => {
  it("monta a fala a partir das opções, na ordem das teclas", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "2", nomeDoTime: "Financeiro" },
        { tecla: "1", nomeDoTime: "Suporte Técnico" },
      ]),
    ).toBe("Para Suporte Técnico, digite 1. Para Financeiro, digite 2.");
  });

  it("o 0 vem por último — é a tecla de 'falar com alguém' por costume", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "0", nomeDoTime: "Recepção" },
        { tecla: "1", nomeDoTime: "Vendas" },
      ]),
    ).toBe("Para Vendas, digite 1. Para Recepção, digite 0.");
  });

  it("ignora opção sem time escolhido e tecla fora de 0–9", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "1", nomeDoTime: "  " },
        { tecla: "*", nomeDoTime: "Suporte" },
        { tecla: "3", nomeDoTime: " Cobrança " },
      ]),
    ).toBe("Para Cobrança, digite 3.");
  });

  it("aceita a frase traduzida pela tela", () => {
    expect(montarTextoDoMenu([{ tecla: "1", nomeDoTime: "Ventas" }], "Para {time}, marque {tecla}.")).toBe(
      "Para Ventas, marque 1.",
    );
  });

  it("a frase padrão e os textos sugeridos existem", () => {
    expect(FRASE_DA_OPCAO).toContain("{time}");
    expect(FRASE_DA_OPCAO).toContain("{tecla}");
    for (const texto of Object.values(TEXTO_SUGERIDO)) expect(texto.trim().length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 7: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/texto-do-menu.test.ts`
Expected: FAIL — `Failed to resolve import "./texto-do-menu"`.

- [ ] **Step 8: Implementar**

Crie `lib/telefonia/texto-do-menu.ts`:

```ts
/**
 * O texto que a URA fala, montado a partir das opções do menu, e os textos
 * sugeridos das falas (desenho da fase 2, §6.2). Puro e client-safe: a tela monta
 * a prévia enquanto a pessoa escolhe as opções, e ela edita antes de gerar a voz.
 */
import type { FalaGeral } from "./vocabulario";

export interface OpcaoParaTexto {
  tecla: string;
  nomeDoTime: string;
}

/** A frase de cada opção; `{time}` e `{tecla}` são trocados. A tela a passa por `t()`. */
export const FRASE_DA_OPCAO = "Para {time}, digite {tecla}.";

/** O 0 por último: é, por costume, a tecla de "falar com alguém". */
const ordemDaTecla = (tecla: string) => (tecla === "0" ? 10 : Number(tecla));

export function montarTextoDoMenu(opcoes: readonly OpcaoParaTexto[], frase: string = FRASE_DA_OPCAO): string {
  return [...opcoes]
    .filter((o) => /^[0-9]$/.test(o.tecla) && o.nomeDoTime.trim() !== "")
    .sort((a, b) => ordemDaTecla(a.tecla) - ordemDaTecla(b.tecla))
    .map((o) => frase.replaceAll("{time}", o.nomeDoTime.trim()).replaceAll("{tecla}", o.tecla))
    .join(" ");
}

/** Os textos que a tela sugere antes de a pessoa escrever o dela. A tela os passa por `t()`. */
export const TEXTO_SUGERIDO: Record<FalaGeral | "emergency" | "invalid", string> = {
  waiting: "Todos os nossos atendentes estão ocupados no momento. Por favor, aguarde na linha que já vamos atender você.",
  nobody: "No momento não conseguimos atender. Registramos a sua ligação e vamos retornar assim que possível. Obrigado.",
  after_hours: "Nosso atendimento está fechado agora. Ligue de novo no nosso horário de atendimento. Obrigado pela ligação.",
  emergency: "Estamos com uma instabilidade no momento e já estamos trabalhando para resolver. Obrigado pela paciência.",
  invalid: "Opção inválida.",
};
```

- [ ] **Step 9: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/texto-do-menu.test.ts lib/telefonia/ulaw.test.ts`
Expected: PASS (13 testes).

- [ ] **Step 10: Commit**

```bash
git add lib/telefonia/vocabulario.ts lib/telefonia/ulaw.ts lib/telefonia/ulaw.test.ts lib/telefonia/texto-do-menu.ts lib/telefonia/texto-do-menu.test.ts
git commit -m "feat(telefonia): vocabulário da URA, μ-law e texto do menu

Regras puras e client-safe da fase 2 (versão 1): o vocabulário que espelha os
CHECKs da 0288, a conversão μ-law → WAV para ouvir a fala no navegador e a fala
do menu montada a partir das opções.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Cliente da ElevenLabs e a URL base só de teste

**Files:**
- Create: `lib/telefonia/elevenlabs.ts`, `lib/telefonia/elevenlabs.test.ts`
- Modify: `lib/env.ts:213` (logo depois de `CLASSIFICADOR_COMERCIAL_BASE_URL`)
- Modify: `.env.example:176` (logo depois da linha `CLASSIFICADOR_COMERCIAL_BASE_URL=`)

- [ ] **Step 1: Teste que falha**

Crie `lib/telefonia/elevenlabs.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ErroDaElevenLabs, listarVozes, motivoDaResposta, sintetizar } from "./elevenlabs";

const CHAVE = "sk_teste_elevenlabs_1234";

function resposta(status: number, corpo: unknown, tipo = "application/json"): Response {
  const body = corpo instanceof Uint8Array ? corpo : JSON.stringify(corpo);
  return new Response(body, { status, headers: { "Content-Type": tipo } });
}

describe("listarVozes — também é como a chave é validada", () => {
  it("manda a chave SÓ no header, e devolve as vozes em ordem de nome", async () => {
    const f = vi.fn(async () =>
      resposta(200, {
        voices: [
          { voice_id: "v2", name: "Bruna", category: "premade", preview_url: "https://cdn.exemplo/b.mp3" },
          { voice_id: "v1", name: "Ana", category: "cloned", preview_url: "http://inseguro/a.mp3" },
          { voice_id: "../x", name: "Invasora" },
        ],
      }),
    );
    const vozes = await listarVozes(CHAVE, { fetch: f as unknown as typeof fetch, baseUrl: "http://falsa.local/" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://falsa.local/v1/voices");
    expect(url).not.toContain(CHAVE);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(CHAVE);
    expect(vozes).toEqual([
      { voice_id: "v1", nome: "Ana", categoria: "cloned", amostra_url: null },
      { voice_id: "v2", nome: "Bruna", categoria: "premade", amostra_url: "https://cdn.exemplo/b.mp3" },
    ]);
  });

  it.each([
    [401, { detail: { status: "invalid_api_key" } }, "chave_invalida"],
    [401, { detail: { status: "quota_exceeded" } }, "sem_credito"],
    [402, null, "sem_credito"],
    [429, null, "limite_de_uso"],
    [500, null, "erro_do_provedor"],
  ] as const)("HTTP %i %j → %s", async (status, corpo, motivo) => {
    const f = vi.fn(async () => resposta(status, corpo));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({ motivo, status });
  });

  it("rede que falha → sem_resposta", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const erro = await listarVozes(CHAVE, { fetch: f as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDaElevenLabs);
    expect(erro).toMatchObject({ motivo: "sem_resposta", status: null });
  });
});

describe("sintetizar — μ-law 8 kHz", () => {
  it("pede ulaw_8000 à voz escolhida, com texto e modelo no corpo, e devolve os bytes crus", async () => {
    const audio = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const f = vi.fn(async () => resposta(200, audio, "audio/basic"));
    const bytes = await sintetizar(
      { chave: CHAVE, voiceId: "voz 1", texto: "Para Suporte, digite 1." },
      { fetch: f as unknown as typeof fetch },
    );

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz%201?output_format=ulaw_8000");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(CHAVE);
    expect(JSON.parse(String(init.body))).toEqual({ text: "Para Suporte, digite 1.", model_id: "eleven_multilingual_v2" });
    expect([...bytes]).toEqual([0xff, 0x7f, 0x00, 0x80]);
  });

  it("áudio que venha dentro de um WAV μ-law é desembrulhado", async () => {
    const wav = new Uint8Array(46);
    const v = new DataView(wav.buffer);
    const w = (i: number, s: string) => [...s].forEach((c, k) => (wav[i + k] = c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 38, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 7, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
    w(36, "data"); v.setUint32(40, 2, true); wav[44] = 0x11; wav[45] = 0x22;
    const f = vi.fn(async () => resposta(200, wav, "audio/wav"));
    const bytes = await sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch });
    expect([...bytes]).toEqual([0x11, 0x22]);
  });

  it("WAV que não é μ-law 8 kHz mono não serve ao Asterisk → erro_do_provedor", async () => {
    const wav = new Uint8Array(46);
    const v = new DataView(wav.buffer);
    const w = (i: number, s: string) => [...s].forEach((c, k) => (wav[i + k] = c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 38, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
    w(36, "data"); v.setUint32(40, 2, true);
    const f = vi.fn(async () => resposta(200, wav, "audio/wav"));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "erro_do_provedor",
    });
  });

  it("corpo vazio → erro_do_provedor", async () => {
    const f = vi.fn(async () => resposta(200, new Uint8Array(0), "audio/basic"));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "erro_do_provedor",
    });
  });

  it.each([
    [422, null, "texto_recusado"],
    [400, { detail: { status: "voice_not_found" } }, "voz_inexistente"],
    [404, null, "voz_inexistente"],
  ] as const)("HTTP %i %j → %s", async (status, corpo, motivo) => {
    const f = vi.fn(async () => resposta(status, corpo));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo,
    });
  });
});

describe("motivoDaResposta", () => {
  it("o status do corpo vence o HTTP quando diz mais", () => {
    expect(motivoDaResposta(401, { detail: { status: "quota_exceeded" } })).toBe("sem_credito");
    expect(motivoDaResposta(403, null)).toBe("chave_invalida");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/elevenlabs.test.ts`
Expected: FAIL — `Failed to resolve import "./elevenlabs"`.

- [ ] **Step 3: Implementar o cliente**

Crie `lib/telefonia/elevenlabs.ts`:

```ts
/**
 * Cliente da ElevenLabs — só as duas chamadas que a URA usa: listar as vozes da
 * conta (é também como a chave é VALIDADA) e sintetizar uma fala em μ-law 8 kHz,
 * o formato que o Asterisk toca sem converter.
 *
 * Puro no que importa para o teste: o `fetch` e a URL base entram como opção. A
 * base só muda em teste (`ELEVENLABS_API_BASE_URL`, a ElevenLabs falsa do e2e);
 * produção usa a pública. A chave vai no header `xi-api-key`, nunca na URL.
 *
 * Toda falha vira `ErroDaElevenLabs` com um motivo do vocabulário — a tela traduz
 * o motivo, e o texto cru do provedor nunca chega a ela.
 */
import { lerWav } from "./ulaw";
import { MODELO_DE_VOZ_PADRAO, type MotivoDoErroDaElevenLabs } from "./vocabulario";

export const ELEVENLABS_BASE_PADRAO = "https://api.elevenlabs.io";
/** Uma fala de 1000 caracteres leva alguns segundos para sair; 20 s é folga, não expectativa. */
const PRAZO_PADRAO_MS = 20_000;
/** `audioFormat` 7 do WAV = μ-law. Qualquer outro não serve ao Asterisk sem conversão. */
const FORMATO_WAV_ULAW = 7;
const ID_DE_VOZ = /^[A-Za-z0-9_-]{1,64}$/;

export class ErroDaElevenLabs extends Error {
  constructor(
    readonly motivo: MotivoDoErroDaElevenLabs,
    readonly status: number | null,
  ) {
    super(`elevenlabs_${motivo}${status ? `_${status}` : ""}`);
    this.name = "ErroDaElevenLabs";
  }
}

export interface OpcoesDoCliente {
  baseUrl?: string;
  fetch?: typeof fetch;
  prazoMs?: number;
}

export interface VozDaElevenLabs {
  voice_id: string;
  nome: string;
  categoria: string | null;
  /** Amostra pública da voz (só `https:`), para o botão "Ouvir amostra". */
  amostra_url: string | null;
}

/** HTTP + corpo de erro → motivo. O `detail.status` do corpo vence quando diz mais que o HTTP. */
export function motivoDaResposta(status: number, corpo: unknown): MotivoDoErroDaElevenLabs {
  const doCorpo = (corpo as { detail?: { status?: unknown } } | null)?.detail?.status;
  if (doCorpo === "quota_exceeded" || status === 402) return "sem_credito";
  if (doCorpo === "voice_not_found" || status === 404) return "voz_inexistente";
  if (status === 401 || status === 403) return "chave_invalida";
  if (status === 400 || status === 422) return "texto_recusado";
  if (status === 429) return "limite_de_uso";
  return "erro_do_provedor";
}

function base(o: OpcoesDoCliente): string {
  return (o.baseUrl?.trim() || ELEVENLABS_BASE_PADRAO).replace(/\/+$/, "");
}

async function chamar(url: string, init: RequestInit, o: OpcoesDoCliente): Promise<Response> {
  const f = o.fetch ?? fetch;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), o.prazoMs ?? PRAZO_PADRAO_MS);
  let resp: Response;
  try {
    resp = await f(url, { ...init, signal: controle.signal });
  } catch {
    throw new ErroDaElevenLabs("sem_resposta", null);
  } finally {
    clearTimeout(relogio);
  }
  if (!resp.ok) {
    const corpo = await resp.json().catch(() => null);
    throw new ErroDaElevenLabs(motivoDaResposta(resp.status, corpo), resp.status);
  }
  return resp;
}

export async function listarVozes(chave: string, o: OpcoesDoCliente = {}): Promise<VozDaElevenLabs[]> {
  const resp = await chamar(
    `${base(o)}/v1/voices`,
    { method: "GET", headers: { "xi-api-key": chave, Accept: "application/json" } },
    o,
  );
  const corpo = (await resp.json().catch(() => null)) as {
    voices?: Array<{ voice_id?: unknown; name?: unknown; category?: unknown; preview_url?: unknown }>;
  } | null;
  if (!corpo || !Array.isArray(corpo.voices)) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
  return corpo.voices
    .filter((v): v is { voice_id: string; name?: unknown; category?: unknown; preview_url?: unknown } =>
      typeof v.voice_id === "string" && ID_DE_VOZ.test(v.voice_id),
    )
    .map((v) => ({
      voice_id: v.voice_id,
      nome: typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 80) : v.voice_id,
      categoria: typeof v.category === "string" ? v.category : null,
      amostra_url: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export async function sintetizar(
  p: { chave: string; voiceId: string; modelId?: string; texto: string },
  o: OpcoesDoCliente = {},
): Promise<Uint8Array> {
  const url = `${base(o)}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=ulaw_8000`;
  const resp = await chamar(
    url,
    {
      method: "POST",
      headers: { "xi-api-key": p.chave, "Content-Type": "application/json", Accept: "audio/basic" },
      body: JSON.stringify({ text: p.texto, model_id: p.modelId ?? MODELO_DE_VOZ_PADRAO }),
    },
    o,
  );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch {
    throw new ErroDaElevenLabs("sem_resposta", resp.status);
  }
  const wav = lerWav(bytes);
  if (wav) {
    if (wav.formato !== FORMATO_WAV_ULAW || wav.canais !== 1 || wav.taxa !== 8000) {
      throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
    }
    bytes = wav.dados;
  }
  if (bytes.length === 0) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
  return bytes;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/elevenlabs.test.ts`
Expected: PASS (15 testes).

- [ ] **Step 5: A URL base na validação de env**

Em `lib/env.ts`, logo depois da linha `CLASSIFICADOR_COMERCIAL_BASE_URL: z.string().optional().default(""),`, acrescente:

```ts
  // Base da API da ElevenLabs (a voz da URA do telefone). Vazio = a pública
  // (https://api.elevenlabs.io). Existe SÓ para o e2e apontar para uma ElevenLabs
  // falsa local — não é knob de produção. A CHAVE não mora aqui: é por
  // organização, cadastrada pela tela. Lido por lib/telefonia/servico-de-falas.ts.
  ELEVENLABS_API_BASE_URL: z.string().optional().default(""),
```

Em `.env.example`, logo depois da linha que começa com `CLASSIFICADOR_COMERCIAL_BASE_URL=`, acrescente:

```
# Só para teste (a ElevenLabs falsa do e2e). Vazio = https://api.elevenlabs.io.
# A CHAVE da ElevenLabs é por organização e se cadastra pela tela (Credenciais de IA).
ELEVENLABS_API_BASE_URL=
```

- [ ] **Step 6: Conferir o gate de env e o typecheck**

Run: `pnpm exec vitest run tests/unit/env-example-sync.test.ts && pnpm typecheck`
Expected: PASS e `tsc` sem erro.

- [ ] **Step 7: Commit**

```bash
git add lib/telefonia/elevenlabs.ts lib/telefonia/elevenlabs.test.ts lib/env.ts .env.example
git commit -m "feat(telefonia): cliente da ElevenLabs para as falas da URA

Listar vozes (valida a chave) e sintetizar em ulaw_8000, com a chave só no
header e toda falha traduzida para um motivo que a tela explica. A URL base é
configurável só para o receptor falso do e2e.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Regras puras — URA, vencimento do aviso e estatística do menu

**Files:**
- Create: `lib/telefonia/ura.ts`, `lib/telefonia/ura.test.ts`
- Create: `lib/telefonia/vencimento-da-emergencia.ts`, `lib/telefonia/vencimento-da-emergencia.test.ts`
- Create: `lib/telefonia/ultimos-sete-dias.ts`, `lib/telefonia/ultimos-sete-dias.test.ts`

- [ ] **Step 1: Teste da URA**

Crie `lib/telefonia/ura.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ESPERA_APOS_O_MENU_MS,
  ESTADO_INICIAL_DA_URA,
  VEZES_DO_MENU,
  passoDaUra,
  type EstadoDaUra,
  type EventoDaUra,
  type MenuDaUra,
} from "./ura";

const SUPORTE = "time-suporte";
const FINANCEIRO = "time-financeiro";
const menu: MenuDaUra = {
  opcoes: [
    { digito: "1", teamId: SUPORTE },
    { digito: "2", teamId: FINANCEIRO },
  ],
  defaultTeamId: SUPORTE,
  temFalaInvalida: false,
};

/** Aplica uma sequência de eventos e devolve o estado e TODAS as ações. */
function rodar(m: MenuDaUra, eventos: EventoDaUra[]) {
  let estado: EstadoDaUra = ESTADO_INICIAL_DA_URA;
  const acoes = eventos.map((ev) => {
    const r = passoDaUra(m, estado, ev);
    estado = r.estado;
    return r.acao;
  });
  return { estado, acoes };
}

describe("URA — a regra pura (D5)", () => {
  it("são 3 vezes do menu (a primeira + 2 repetições) e 5 s de espera", () => {
    expect(VEZES_DO_MENU).toBe(3);
    expect(ESPERA_APOS_O_MENU_MS).toBe(5_000);
  });

  it("tecla válida DURANTE a fala: para a fala e encaminha ao time da opção", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "2" }]);
    expect(acoes).toEqual([{ tipo: "encaminhar", teamId: FINANCEIRO, desfecho: "chosen", digito: "2", pararAtual: true }]);
  });

  it("fim da fala → espera 5 s; tecla na espera não precisa parar fala nenhuma", () => {
    const { acoes } = rodar(menu, [{ tipo: "fim_da_fala" }, { tipo: "tecla", digito: "1" }]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS },
      { tipo: "encaminhar", teamId: SUPORTE, desfecho: "chosen", digito: "1", pararAtual: false },
    ]);
  });

  it("sem tecla: repete o menu duas vezes e na terceira vai ao padrão com default_no_input", () => {
    const passo = [{ tipo: "fim_da_fala" }, { tipo: "prazo" }] as EventoDaUra[];
    const { acoes } = rodar(menu, [...passo, ...passo, ...passo]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: 5_000 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000 },
      { tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_no_input", digito: null, pararAtual: false },
    ]);
  });

  it("tecla inválida sem fala de inválida: repete o menu na hora", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "9" }]);
    expect(acoes).toEqual([{ tipo: "tocar", fala: "menu", pararAtual: true }]);
  });

  it("tecla inválida COM fala de inválida: toca a inválida, e o fim dela volta ao menu", () => {
    const { acoes } = rodar({ ...menu, temFalaInvalida: true }, [{ tipo: "tecla", digito: "7" }, { tipo: "fim_da_fala" }]);
    expect(acoes).toEqual([
      { tipo: "tocar", fala: "invalida", pararAtual: true },
      { tipo: "tocar", fala: "menu", pararAtual: false },
    ]);
  });

  it("* e # são reservadas: contam como inválidas", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "*" }, { tipo: "tecla", digito: "#" }]);
    expect(acoes.map((a) => a.tipo)).toEqual(["tocar", "tocar"]);
  });

  it("três teclas erradas → padrão com default_invalid", () => {
    const { acoes } = rodar(menu, [
      { tipo: "tecla", digito: "9" },
      { tipo: "tecla", digito: "8" },
      { tipo: "tecla", digito: "#" },
    ]);
    expect(acoes.at(-1)).toEqual({ tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_invalid", digito: null, pararAtual: true });
  });

  it("uma tecla errada e depois silêncio → padrão com default_invalid (houve tecla errada)", () => {
    const { acoes } = rodar(menu, [
      { tipo: "tecla", digito: "9" },
      { tipo: "fim_da_fala" },
      { tipo: "prazo" },
      { tipo: "fim_da_fala" },
      { tipo: "prazo" },
    ]);
    expect(acoes.at(-1)).toEqual({ tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_invalid", digito: null, pararAtual: false });
  });

  it("prazo fora da espera e fim de fala sem fala tocando são ignorados", () => {
    expect(passoDaUra(menu, ESTADO_INICIAL_DA_URA, { tipo: "prazo" }).acao).toEqual({ tipo: "ignorar" });
    const semFala: EstadoDaUra = { ...ESTADO_INICIAL_DA_URA, tocando: null };
    expect(passoDaUra(menu, semFala, { tipo: "fim_da_fala" }).acao).toEqual({ tipo: "ignorar" });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/ura.test.ts`
Expected: FAIL — `Failed to resolve import "./ura"`.

- [ ] **Step 3: Implementar a URA**

Crie `lib/telefonia/ura.ts`:

```ts
/**
 * A URA DA LIGAÇÃO RECEBIDA — regra pura (desenho da fase 2, §5.1 e D5).
 *
 * Estado + evento → estado novo + UMA ação. Quem executa a ação (tocar, parar a
 * fala, armar o prazo, levar ao time) é o controlador de chamadas
 * (`lib/channels/telefonia/controle.ts`); aqui só se decide. Assim cada caminho
 * do menu se prova sem Asterisk nem relógio.
 *
 * As regras, na ordem em que o cliente as vive:
 *  - toca a fala do menu; QUALQUER tecla a interrompe;
 *  - terminada a fala, espera 5 s;
 *  - tecla de uma opção → o time da opção (`chosen`);
 *  - tecla que não é opção (inclusive `*` e `#`, reservadas) → a fala de tecla
 *    inválida, se houver, e o menu de novo;
 *  - sem tecla em 5 s → o menu de novo;
 *  - o menu toca no máximo 3 vezes (a primeira + 2 repetições); falhou a terceira
 *    → o time padrão, com `default_invalid` se ALGUMA tecla errada foi apertada,
 *    ou `default_no_input` se nenhuma.
 */
import type { DesfechoDoMenu } from "./vocabulario";

export const ESPERA_APOS_O_MENU_MS = 5_000;
export const VEZES_DO_MENU = 3;

export interface OpcaoDaUra {
  digito: string;
  teamId: string;
}

export interface MenuDaUra {
  opcoes: readonly OpcaoDaUra[];
  defaultTeamId: string;
  temFalaInvalida: boolean;
}

export type FalaDaUra = "menu" | "invalida";

export interface EstadoDaUra {
  /** Quantas vezes o menu já foi (ou está sendo) oferecido, a partir de 1. */
  vez: number;
  tocando: FalaDaUra | null;
  esperando: boolean;
  houveInvalida: boolean;
}

export const ESTADO_INICIAL_DA_URA: EstadoDaUra = { vez: 1, tocando: "menu", esperando: false, houveInvalida: false };

export type EventoDaUra = { tipo: "tecla"; digito: string } | { tipo: "fim_da_fala" } | { tipo: "prazo" };

export type AcaoDaUra =
  | { tipo: "tocar"; fala: FalaDaUra; pararAtual: boolean }
  | { tipo: "esperar"; ms: number }
  | { tipo: "encaminhar"; teamId: string; desfecho: DesfechoDoMenu; digito: string | null; pararAtual: boolean }
  | { tipo: "ignorar" };

export function passoDaUra(
  menu: MenuDaUra,
  estado: EstadoDaUra,
  evento: EventoDaUra,
): { estado: EstadoDaUra; acao: AcaoDaUra } {
  switch (evento.tipo) {
    case "tecla": {
      const pararAtual = estado.tocando !== null;
      const opcao = menu.opcoes.find((o) => o.digito === evento.digito);
      if (opcao) {
        return {
          estado: { ...estado, tocando: null, esperando: false },
          acao: { tipo: "encaminhar", teamId: opcao.teamId, desfecho: "chosen", digito: opcao.digito, pararAtual },
        };
      }
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { ...estado, tocando: null, esperando: false, houveInvalida: true },
          acao: { tipo: "encaminhar", teamId: menu.defaultTeamId, desfecho: "default_invalid", digito: null, pararAtual },
        };
      }
      const fala: FalaDaUra = menu.temFalaInvalida ? "invalida" : "menu";
      return { estado: { vez, tocando: fala, esperando: false, houveInvalida: true }, acao: { tipo: "tocar", fala, pararAtual } };
    }
    case "fim_da_fala": {
      if (estado.tocando === "menu") {
        return { estado: { ...estado, tocando: null, esperando: true }, acao: { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS } };
      }
      if (estado.tocando === "invalida") {
        return { estado: { ...estado, tocando: "menu", esperando: false }, acao: { tipo: "tocar", fala: "menu", pararAtual: false } };
      }
      return { estado, acao: { tipo: "ignorar" } };
    }
    case "prazo": {
      if (!estado.esperando) return { estado, acao: { tipo: "ignorar" } };
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { ...estado, esperando: false },
          acao: {
            tipo: "encaminhar",
            teamId: menu.defaultTeamId,
            desfecho: estado.houveInvalida ? "default_invalid" : "default_no_input",
            digito: null,
            pararAtual: false,
          },
        };
      }
      return { estado: { ...estado, vez, tocando: "menu", esperando: false }, acao: { tipo: "tocar", fala: "menu", pararAtual: false } };
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/ura.test.ts`
Expected: PASS (10 testes).

- [ ] **Step 5: Teste do vencimento do aviso e da estatística**

Crie `lib/telefonia/vencimento-da-emergencia.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DURACAO_PADRAO, DURACOES_DA_EMERGENCIA, avisoVigente, expiraEm } from "./vencimento-da-emergencia";

const AGORA = new Date("2026-09-28T13:00:00Z");

describe("vencimento do aviso de instabilidade (D8)", () => {
  it("as durações da tela, com 2 h por padrão", () => {
    expect(DURACOES_DA_EMERGENCIA).toEqual(["1h", "2h", "4h", "indefinida"]);
    expect(DURACAO_PADRAO).toBe("2h");
  });

  it.each([
    ["1h", "2026-09-28T14:00:00.000Z"],
    ["2h", "2026-09-28T15:00:00.000Z"],
    ["4h", "2026-09-28T17:00:00.000Z"],
  ] as const)("%s → vence em %s", (duracao, iso) => {
    expect(expiraEm(duracao, AGORA)?.toISOString()).toBe(iso);
  });

  it("'até eu desligar' não vence", () => {
    expect(expiraEm("indefinida", AGORA)).toBeNull();
  });

  it("vigente: ligado e sem prazo, ou com prazo no futuro; não vigente: desligado ou vencido", () => {
    expect(avisoVigente({ desde: AGORA, expiraEm: null }, AGORA)).toBe(true);
    expect(avisoVigente({ desde: AGORA, expiraEm: "2026-09-28T13:00:01Z" }, AGORA)).toBe(true);
    expect(avisoVigente({ desde: AGORA, expiraEm: "2026-09-28T13:00:00Z" }, AGORA)).toBe(false);
    expect(avisoVigente({ desde: null, expiraEm: null }, AGORA)).toBe(false);
  });
});
```

Crie `lib/telefonia/ultimos-sete-dias.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { menuConfunde, somarUltimosSeteDias } from "./ultimos-sete-dias";

describe("últimos 7 dias do menu — o laço de retorno", () => {
  it("soma por tecla, sem escolha, tecla errada e quem desligou no menu", () => {
    expect(
      somarUltimosSeteDias([
        { menu_outcome: "chosen", menu_digit: "1", n: 4 },
        { menu_outcome: "chosen", menu_digit: "2", n: 1 },
        { menu_outcome: "default_no_input", menu_digit: null, n: 3 },
        { menu_outcome: "default_invalid", menu_digit: null, n: 2 },
        { menu_outcome: null, menu_digit: null, n: 5 },
      ]),
    ).toEqual({ total: 15, por_tecla: { "1": 4, "2": 1 }, sem_escolha: 3, tecla_errada: 2, desligou_no_menu: 5 });
  });

  it("nada → zeros", () => {
    expect(somarUltimosSeteDias([])).toEqual({ total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 });
  });

  it("confunde: 5+ ligações e 30%+ caindo no padrão", () => {
    const base = { por_tecla: {}, desligou_no_menu: 0 };
    expect(menuConfunde({ ...base, total: 10, sem_escolha: 2, tecla_errada: 1 })).toBe(true);
    expect(menuConfunde({ ...base, total: 10, sem_escolha: 2, tecla_errada: 0 })).toBe(false);
    expect(menuConfunde({ ...base, total: 4, sem_escolha: 4, tecla_errada: 0 })).toBe(false);
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/vencimento-da-emergencia.test.ts lib/telefonia/ultimos-sete-dias.test.ts`
Expected: FAIL — os dois módulos não existem.

- [ ] **Step 7: Implementar os dois**

Crie `lib/telefonia/vencimento-da-emergencia.ts`:

```ts
/**
 * O PRAZO DO AVISO DE INSTABILIDADE (desenho da fase 2, D8) — puro e client-safe.
 *
 * Quem liga escolhe a duração (1 h, 2 h por padrão, 4 h ou "até eu desligar").
 * Vencido, o aviso para de tocar NA HORA — o worker lê `expires_at` a cada
 * ligação — e a passada de 60 s do worker o desliga no banco e avisa na Central.
 */
export const DURACOES_DA_EMERGENCIA = ["1h", "2h", "4h", "indefinida"] as const;
export type DuracaoDaEmergencia = (typeof DURACOES_DA_EMERGENCIA)[number];
export const DURACAO_PADRAO: DuracaoDaEmergencia = "2h";

const HORAS: Record<Exclude<DuracaoDaEmergencia, "indefinida">, number> = { "1h": 1, "2h": 2, "4h": 4 };

export function expiraEm(duracao: DuracaoDaEmergencia, desde: Date): Date | null {
  if (duracao === "indefinida") return null;
  return new Date(desde.getTime() + HORAS[duracao] * 3_600_000);
}

export function avisoVigente(
  a: { desde: Date | string | null; expiraEm: Date | string | null },
  agora: Date,
): boolean {
  if (!a.desde) return false;
  if (!a.expiraEm) return true;
  return new Date(a.expiraEm).getTime() > agora.getTime();
}
```

Crie `lib/telefonia/ultimos-sete-dias.ts`:

```ts
/**
 * O "últimos 7 dias" de cada menu (desenho da fase 2, §6.2 e §8) — puro e
 * client-safe. É o laço de retorno da URA: muita gente caindo no time padrão sem
 * escolher é o sinal de que a fala confunde, e o dono reescreve.
 */
import type { DesfechoDoMenu, UltimosSeteDias } from "./vocabulario";

export interface LinhaDoMenuNaSemana {
  menu_outcome: DesfechoDoMenu | null;
  menu_digit: string | null;
  n: number;
}

export const MINIMO_PARA_ALERTA = 5;
export const PROPORCAO_QUE_CONFUNDE = 0.3;

export function somarUltimosSeteDias(linhas: readonly LinhaDoMenuNaSemana[]): UltimosSeteDias {
  const u: UltimosSeteDias = { total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 };
  for (const l of linhas) {
    u.total += l.n;
    if (l.menu_outcome === "chosen" && l.menu_digit) u.por_tecla[l.menu_digit] = (u.por_tecla[l.menu_digit] ?? 0) + l.n;
    else if (l.menu_outcome === "default_no_input") u.sem_escolha += l.n;
    else if (l.menu_outcome === "default_invalid") u.tecla_errada += l.n;
    else if (l.menu_outcome === null) u.desligou_no_menu += l.n;
  }
  return u;
}

export function menuConfunde(u: UltimosSeteDias): boolean {
  return u.total >= MINIMO_PARA_ALERTA && (u.sem_escolha + u.tecla_errada) / u.total >= PROPORCAO_QUE_CONFUNDE;
}
```

- [ ] **Step 8: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/`
Expected: PASS (todos os arquivos de `lib/telefonia/`, inclusive os da fase 1).

- [ ] **Step 9: Commit**

```bash
git add lib/telefonia/ura.ts lib/telefonia/ura.test.ts lib/telefonia/vencimento-da-emergencia.ts lib/telefonia/vencimento-da-emergencia.test.ts lib/telefonia/ultimos-sete-dias.ts lib/telefonia/ultimos-sete-dias.test.ts
git commit -m "feat(telefonia): regra pura da URA, prazo do aviso e últimos 7 dias do menu

A URA decide (tecla, fim da fala, prazo de 5 s, 3 vezes, padrão) e o controlador
só executa. O aviso de instabilidade vence em 1/2/4 h ou nunca. O menu mostra o
que as ligações fizeram nele — e avisa quando confunde.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Migration 0288 — tripla, prova no banco e vocabulário da Central

**Files:**
- Create: `tests/invariants/telefonia-ura-e-falas.test.ts`
- Create: `supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql`
- Modify: `supabase/baseline.sql` (bloco único de `agent_inbox_items_kind_check`, ~linha 10132; apêndice novo imediatamente ANTES da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`)
- Modify: `supabase/migrations/MANIFEST.md` (linha nova depois da `0287`)
- Modify: `tests/invariants/vocabulario-banco-x-typescript.test.ts` (3 pares no fim de `PARES`)
- Modify: `tests/invariants/rls-completude-varredura.test.ts` (4 entradas no começo de `PROVA_PROPRIA`, linha 77)
- Modify: `lib/agent-engine/db/repository.ts:74-75`, `lib/ai/agent-inbox-copy.ts:76-77`, `lib/ai/inbox-destino.ts:73`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 0: Conferir o número da migration**

Run: `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`
Expected: `0287` → a nova é `0288`. Se sair outro número, use o seguinte a ele em TODOS os nomes desta task (arquivo, rótulo do apêndice, MANIFEST, comentários).

- [ ] **Step 1: Escrever a prova do banco (vai falhar: as tabelas não existem)**

Crie `tests/invariants/telefonia-ura-e-falas.test.ts`:

```ts
/**
 * A URA E AS FALAS DO TELEFONE NO BANCO (migration 0288) — medido em Postgres real.
 *
 * O que se prova, e por que cada um:
 *  1. ISOLAMENTO. As quatro tabelas novas (`phone_prompts`, `phone_settings`,
 *     `phone_menus`, `phone_menu_options`) nasceriam com CRUD inteiro para
 *     `authenticated` no Supabase real (default ACL). O que isola é a policy e o
 *     `revoke`. Medido como `authenticated` com o JWT de um membro — como
 *     `postgres` (rolbypassrls = t) não se mediria nada. Controle positivo: o
 *     membro de A lê as linhas de A.
 *  2. A REST SÓ LÊ. A escrita é da API (organização resolvida da sessão) e do
 *     worker; `authenticated` não grava nem na própria organização.
 *  3. AS CATRACAS DO SCHEMA. O caminho do áudio amarrado a organização + hash (o
 *     worker escreve esse caminho no disco); tecla só 0–9; número aponta para time
 *     OU menu; opção e time padrão só levam a time da MESMA organização (FK
 *     composta); aviso de instabilidade coerente.
 *  4. O bucket é privado.
 *  5. O bloco do apêndice — lido do `baseline.sql` pelo rótulo, não copiado à mão
 *     — reaplica sem erro e cura a linha que viola o CHECK de destino.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "c0de0288-0000-4000-8000-00000000000a";
const ORG_B = "c0de0288-0000-4000-8000-00000000000b";
const USER_A = "c0de0288-1111-4000-8000-00000000000a";
const USER_B = "c0de0288-1111-4000-8000-00000000000b";
const TIME_A = "c0de0288-2222-4000-8000-00000000000a";
const TIME_B = "c0de0288-2222-4000-8000-00000000000b";
const FALA_A = "c0de0288-3333-4000-8000-00000000000a";
const FALA_B = "c0de0288-3333-4000-8000-00000000000b";
const MENU_A = "c0de0288-4444-4000-8000-00000000000a";
const MENU_B = "c0de0288-4444-4000-8000-00000000000b";
const NUMERO_A = "c0de0288-5555-4000-8000-00000000000a";
const HASH = "a".repeat(64);
const TABELAS = ["phone_prompts", "phone_settings", "phone_menus", "phone_menu_options"] as const;

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO = "-- ---- telefonia fase 2: URA e falas (migration 0288) ----";

/** O bloco rotulado da 0288, do rótulo até o próximo rótulo de apêndice — o texto que o self-host aplica. */
function blocoDa0288(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0288 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0288 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0288 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** `null` quando o comando passa; a mensagem do psql quando falha. */
function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return `${err instanceof Error ? err.message : String(err)}${typeof stderr === "string" ? stderr : ""}`;
  }
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'ura-0288-a@invariant.test'), ('${USER_B}', 'ura-0288-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ura-0288-a', 'URA 0288 A', 'URA A'), ('${ORG_B}', 'ura-0288-b', 'URA 0288 B', 'URA B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()), ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A}', '${ORG_A}', 'Suporte', 'suporte-0288'), ('${TIME_B}', '${ORG_B}', 'Suporte', 'suporte-0288')
      on conflict (id) do nothing;
    insert into public.phone_prompts
      (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
    values
      ('${FALA_A}', '${ORG_A}', 'menu', 'Para Suporte, digite 1.', 'voz', 'eleven_multilingual_v2', '${HASH}',
       '${ORG_A}/${HASH}.ulaw', 1000, 'ready'),
      ('${FALA_B}', '${ORG_B}', 'menu', 'Para Suporte, digite 1.', 'voz', 'eleven_multilingual_v2', '${HASH}',
       '${ORG_B}/${HASH}.ulaw', 1000, 'ready')
      on conflict (id) do nothing;
    insert into public.phone_settings (organization_id, voice_id) values ('${ORG_A}', 'voz'), ('${ORG_B}', 'voz')
      on conflict (organization_id) do nothing;
    insert into public.phone_menus (id, organization_id, name, prompt_id, default_team_id) values
      ('${MENU_A}', '${ORG_A}', 'Principal', '${FALA_A}', '${TIME_A}'),
      ('${MENU_B}', '${ORG_B}', 'Principal', '${FALA_B}', '${TIME_B}')
      on conflict (id) do nothing;
    insert into public.phone_menu_options (organization_id, menu_id, digit, team_id) values
      ('${ORG_A}', '${MENU_A}', '1', '${TIME_A}'), ('${ORG_B}', '${MENU_B}', '1', '${TIME_B}')
      on conflict do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'URA 0288', '+556130000288',
            'voip.exemplo-0288.com.br', 5060, 'udp', 'u0288', '\\x00')
      on conflict (id) do nothing;
  `);
});

describe("isolamento entre organizações (JWT de membro, como a REST)", () => {
  it.each(TABELAS)("%s: o membro de A lê as de A e ZERO de B; o de B, zero de A", (tabela) => {
    expect(countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("sem filtro de organização, o membro de A enxerga só a própria (sem porta dos fundos)", () => {
    expect(countAs(USER_A, "select count(distinct organization_id) from public.phone_prompts;")).toBe(1);
  });
});

describe("a REST só lê — a escrita é da API e do worker", () => {
  it.each([
    [`update public.phone_prompts set "text" = 'x' where organization_id = '${ORG_A}'`],
    [`insert into public.phone_menus (organization_id, name, default_team_id) values ('${ORG_A}', 'x', '${TIME_A}')`],
    [`delete from public.phone_menu_options where organization_id = '${ORG_A}'`],
    [`update public.phone_settings set voice_id = 'outra' where organization_id = '${ORG_A}'`],
  ])("authenticated não grava: %s", (dml) => {
    expect(writeCountAs(USER_A, dml)).toBe(0);
  });

  it("e nada mudou de fato", () => {
    expect(sql(`select count(*) from public.phone_prompts where "text" = 'x';`)).toBe("0");
    expect(sql(`select voice_id from public.phone_settings where organization_id = '${ORG_A}';`)).toBe("voz");
    expect(sql(`select count(*) from public.phone_menu_options where organization_id = '${ORG_A}';`)).toBe("1");
  });

  it("anon não lê", () => {
    expect(tenta("set role anon; select count(*) from public.phone_prompts;")).toMatch(/permission denied/);
  });
});

describe("as catracas do schema", () => {
  const insereFala = (valores: string) =>
    tenta(`insert into public.phone_prompts
      (organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
      values ${valores};`);

  it("kind e status fora do vocabulário são recusados", () => {
    expect(insereFala(`('${ORG_A}', 'musica', 't', 'v', 'm', '${HASH}', null, null, 'failed')`)).toContain(
      "phone_prompts_kind_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', null, null, 'gerando')`)).toContain(
      "phone_prompts_status_check",
    );
  });

  it("o caminho do áudio é amarrado à organização e ao hash — nada de pasta de outra org", () => {
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', '${ORG_B}/${HASH}.ulaw', 10, 'ready')`)).toContain(
      "phone_prompts_storage_path_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', '../../etc/passwd', 10, 'ready')`)).toContain(
      "phone_prompts_storage_path_check",
    );
  });

  it("pronta sem arquivo é recusada; texto vazio também", () => {
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', null, null, 'ready')`)).toContain(
      "phone_prompts_ready_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', '', 'v', 'm', '${HASH}', null, null, 'failed')`)).toContain(
      "phone_prompts_text_check",
    );
  });

  it("tecla só 0–9 (* e # ficam reservadas)", () => {
    expect(
      tenta(`insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
             values ('${ORG_A}', '${MENU_A}', '*', '${TIME_A}');`),
    ).toContain("phone_menu_options_digit_check");
  });

  it("a opção e o time padrão só levam a time da MESMA organização (FK composta)", () => {
    expect(
      tenta(`insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
             values ('${ORG_A}', '${MENU_A}', '2', '${TIME_B}');`),
    ).toMatch(/foreign key/);
    expect(
      tenta(`insert into public.phone_menus (organization_id, name, default_team_id) values ('${ORG_A}', 'x', '${TIME_B}');`),
    ).toMatch(/foreign key/);
  });

  it("o número aponta para um time OU um menu, nunca os dois", () => {
    expect(
      tenta(`update public.channel_sessions set sip_team_id = '${TIME_A}', sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';`),
    ).toContain("channel_sessions_sip_destino_check");
    expect(tenta(`update public.channel_sessions set sip_team_id = null, sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';`)).toBeNull();
  });

  it("aviso de instabilidade coerente: vence depois de ligar, e só há prazo com o aviso ligado", () => {
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = now(),
               phone_emergency_expires_at = now() - interval '1 minute' where id = '${TIME_A}';`),
    ).toContain("attendance_teams_phone_emergency_check");
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = null,
               phone_emergency_expires_at = now() + interval '1 hour' where id = '${TIME_A}';`),
    ).toContain("attendance_teams_phone_emergency_check");
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = now(),
               phone_emergency_expires_at = null where id = '${TIME_A}';`),
    ).toBeNull();
    sql(`update public.attendance_teams set phone_emergency_active_since = null, phone_emergency_expires_at = null
          where id = '${TIME_A}';`);
  });

  it("voice_calls: desfecho do menu e tecla dentro do vocabulário", () => {
    const liga = (outcome: string, digito: string) =>
      tenta(`insert into public.voice_calls
               (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status,
                menu_outcome, menu_digit)
             values ('${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'ref-0288-' || gen_random_uuid(), 'inbound',
                     '+5561999990288', 'ended', ${outcome}, ${digito});`);
    expect(liga("'talvez'", "null")).toContain("voice_calls_menu_outcome_check");
    expect(liga("'chosen'", "'#'")).toContain("voice_calls_menu_digit_check");
    expect(liga("'chosen'", "'2'")).toBeNull();
    expect(liga("null", "null")).toBeNull();
  });

  it("a Central aceita os dois avisos novos do telefone", () => {
    expect(
      tenta(`insert into public.agent_inbox_items (organization_id, kind, severity, title) values
               ('${ORG_A}', 'phone_prompt_unplayable', 'warn', 'fala'),
               ('${ORG_A}', 'phone_emergency_expired', 'info', 'aviso');`),
    ).toBeNull();
  });
});

describe("o bucket e o apêndice", () => {
  it("o bucket phone-prompts é PRIVADO e só aceita μ-law", () => {
    expect(
      sql(`select public::text || '|' || array_to_string(allowed_mime_types, ',')
             from storage.buckets where id = 'phone-prompts';`),
    ).toBe("false|audio/basic");
  });

  it("reaplicar o bloco do apêndice não dá erro, e cura a linha que viola o destino", () => {
    sql(`alter table public.channel_sessions drop constraint channel_sessions_sip_destino_check;
         update public.channel_sessions set sip_team_id = '${TIME_A}', sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';`);
    expect(tenta(blocoDa0288())).toBeNull();
    expect(
      sql(`select coalesce(sip_team_id::text, '-') || '|' || coalesce(sip_menu_id::text, '-')
             from public.channel_sessions where id = '${NUMERO_A}';`),
    ).toBe(`${TIME_A}|-`);
    expect(sql(`select count(*) from pg_constraint where conname = 'channel_sessions_sip_destino_check';`)).toBe("1");
    expect(
      sql(`select count(*) from pg_policies
            where tablename in ('phone_prompts', 'phone_settings', 'phone_menus', 'phone_menu_options')
              and policyname like 'tenant_isolation_%_all';`),
    ).toBe("4");
  });
});
```

- [ ] **Step 2: Os pares de vocabulário e a varredura de RLS**

Em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, acrescente ao FIM do array `PARES` (depois do par de `team_invites`, antes do `];`):

```ts
  {
    tabela: "phone_prompts",
    coluna: "kind",
    // migration 0288 — as falas do telefone. Nasce com o par no mesmo commit.
    arquivo: "lib/telefonia/vocabulario.ts",
    simbolo: "TIPOS_DE_FALA",
  },
  {
    tabela: "phone_prompts",
    coluna: "status",
    arquivo: "lib/telefonia/vocabulario.ts",
    simbolo: "ESTADOS_DA_FALA",
  },
  {
    tabela: "voice_calls",
    coluna: "menu_outcome",
    // O que o menu de voz fez com a ligação: é a fonte do "últimos 7 dias".
    arquivo: "lib/telefonia/vocabulario.ts",
    simbolo: "DESFECHOS_DO_MENU",
  },
```

Em `tests/invariants/rls-completude-varredura.test.ts`, logo depois da linha `const PROVA_PROPRIA: readonly Excecao[] = [`, acrescente:

```ts
  { tabela: "phone_prompts", razao: "tests/invariants/telefonia-ura-e-falas.test.ts — JWT do membro de A lê as de A e zero de B (e o de B, zero de A); authenticated sem escrita (GRANT só de SELECT) e anon sem leitura (migration 0288)" },
  { tabela: "phone_settings", razao: "tests/invariants/telefonia-ura-e-falas.test.ts — mesma prova da linha acima" },
  { tabela: "phone_menus", razao: "tests/invariants/telefonia-ura-e-falas.test.ts — mesma prova, mais a FK composta que recusa time padrão de outra organização" },
  { tabela: "phone_menu_options", razao: "tests/invariants/telefonia-ura-e-falas.test.ts — mesma prova, mais a FK composta que recusa opção com time de outra organização e a tecla fora de 0–9" },
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:db tests/invariants/telefonia-ura-e-falas.test.ts`
Expected: FAIL — `relation "public.phone_prompts" does not exist` no `beforeAll`.

- [ ] **Step 4: A migration**

Crie `supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql`:

```sql
-- 0288 — telefonia, fase 2, versão 1: URA (menu de voz) e falas.
--
-- Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md
-- (§3.1, §4, §5.1, §5.2). Fase 1: docs/specs/20-spec-telefonia-sip.md.
--
-- ─── O que muda, e por que cada peça ───────────────────────────────────────
--
-- 1. `phone_prompts` — uma linha por FALA gravada (menu, tecla inválida, aguarde,
--    ninguém atendeu, fora do horário, aviso de instabilidade). O áudio mora no
--    bucket privado `phone-prompts`, em `<org>/<sha256(modelo, voz, texto)>.ulaw`;
--    a linha diz qual texto, qual voz e se está pronta (`ready`) ou falhou
--    (`failed` + o motivo em `error`). O CHECK do caminho amarra o arquivo à
--    organização e ao hash: o worker escreve esse caminho no disco, e um valor
--    gravado por fora (REST, psql) não aponta para fora da pasta da organização.
-- 2. `phone_settings` — uma linha por organização: a voz da ElevenLabs e as três
--    falas gerais (aguarde, ninguém atendeu, fora do horário).
-- 3. `phone_menus` + `phone_menu_options` — o menu é da ORGANIZAÇÃO (D2) e serve a
--    vários números. FK COMPOSTA para `attendance_teams(organization_id, id)`: é o
--    que torna impossível, e não só improvável, uma opção levar ao time de outra
--    organização. `accepts_extension` nasce aqui e só é usada na versão 3.
-- 4. `channel_sessions.sip_menu_id` — o número aponta para um time OU um menu,
--    nunca os dois (CHECK). Linha com os dois (impossível até aqui) mantém o time.
-- 5. `attendance_teams.phone_emergency_*` — o aviso de instabilidade é do TIME
--    (D7): a fala, desde quando está ligado, até quando (nulo = até alguém
--    desligar) e quem ligou. CHECK de coerência; linha incoerente é desligada
--    ANTES de o CHECK entrar.
-- 6. `voice_calls` — o que o menu fez (`menu_id`, `menu_digit`, `menu_outcome`) e
--    quando o cliente ouviu o aviso inteiro (`emergency_heard_at`). `end_reason`
--    ganha `after_hours` sem migration: é coluna de vocabulário aberto.
-- 7. `agent_inbox_items.kind` ganha `phone_prompt_unplayable` (a fala não tocou
--    e a ligação seguiu sem ela) e `phone_emergency_expired` (o aviso venceu e
--    desligou sozinho). No baseline, quem muda é o bloco ÚNICO da constraint.
-- 8. Bucket PRIVADO `phone-prompts`: só o cliente de serviço (API e worker) lê.
--
-- Segurança: as quatro tabelas novas têm RLS `tenant_isolation_<tabela>_all`
-- (leitura para membros da organização) e GRANT só de SELECT — a escrita é da
-- API, com a organização resolvida da sessão, e do worker. O `revoke` explícito é
-- o que protege no Supabase real (o default ACL concede tudo a tabela nova).
-- Nenhuma função nova.
--
-- Idempotente e auto-curativa: `if not exists` em tabela, coluna e índice;
-- CHECKs com drop + add depois de corrigir o dado que os violaria; policies com
-- drop + create; gatilhos com `create or replace`; bucket com `on conflict`.
-- O trecho entre os marcadores `[apêndice 0288]` é copiado, sem mudança, para o
-- apêndice do baseline.sql.

-- [apêndice 0288: início]
-- 1. phone_prompts ----------------------------------------------------------
create table if not exists public.phone_prompts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind            text not null,
  "text"          text not null,
  voice_id        text not null,
  model_id        text not null,
  content_hash    text not null,
  storage_path    text,
  duration_ms     integer,
  status          text not null,
  error           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

-- Cura antes dos CHECKs: a tabela é nova, e só uma linha gravada por fora os violaria.
update public.phone_prompts
   set status = 'failed', error = coalesce(error, 'erro_do_provedor'), storage_path = null, duration_ms = null
 where storage_path is not null
   and storage_path <> organization_id::text || '/' || content_hash || '.ulaw';
update public.phone_prompts
   set status = 'failed', error = coalesce(error, 'erro_do_provedor')
 where status = 'ready' and (storage_path is null or duration_ms is null or duration_ms <= 0);

alter table public.phone_prompts drop constraint if exists phone_prompts_kind_check;
alter table public.phone_prompts add constraint phone_prompts_kind_check
  check (kind in ('menu', 'invalid', 'waiting', 'nobody', 'after_hours', 'emergency'));
alter table public.phone_prompts drop constraint if exists phone_prompts_status_check;
alter table public.phone_prompts add constraint phone_prompts_status_check
  check (status in ('ready', 'failed'));
alter table public.phone_prompts drop constraint if exists phone_prompts_text_check;
alter table public.phone_prompts add constraint phone_prompts_text_check
  check (char_length("text") between 1 and 1000);
alter table public.phone_prompts drop constraint if exists phone_prompts_hash_check;
alter table public.phone_prompts add constraint phone_prompts_hash_check
  check (content_hash ~ '^[0-9a-f]{64}$');
alter table public.phone_prompts drop constraint if exists phone_prompts_storage_path_check;
alter table public.phone_prompts add constraint phone_prompts_storage_path_check
  check (storage_path is null or storage_path = organization_id::text || '/' || content_hash || '.ulaw');
alter table public.phone_prompts drop constraint if exists phone_prompts_ready_check;
alter table public.phone_prompts add constraint phone_prompts_ready_check
  check (status <> 'ready' or (storage_path is not null and duration_ms is not null and duration_ms > 0));

create index if not exists phone_prompts_org on public.phone_prompts (organization_id);
create index if not exists phone_prompts_caminho_pronto on public.phone_prompts (storage_path) where status = 'ready';

-- 2. phone_settings -----------------------------------------------------------
create table if not exists public.phone_settings (
  organization_id       uuid primary key references public.organizations(id) on delete cascade,
  voice_id              text,
  model_id              text not null default 'eleven_multilingual_v2',
  waiting_prompt_id     uuid references public.phone_prompts(id) on delete set null,
  nobody_prompt_id      uuid references public.phone_prompts(id) on delete set null,
  after_hours_prompt_id uuid references public.phone_prompts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- 3. phone_menus + phone_menu_options ----------------------------------------
create table if not exists public.phone_menus (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  prompt_id         uuid references public.phone_prompts(id) on delete set null,
  invalid_prompt_id uuid references public.phone_prompts(id) on delete set null,
  default_team_id   uuid not null,
  accepts_extension boolean not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, default_team_id) references public.attendance_teams(organization_id, id)
);
alter table public.phone_menus drop constraint if exists phone_menus_name_check;
alter table public.phone_menus add constraint phone_menus_name_check
  check (char_length(btrim(name)) between 1 and 80);

create table if not exists public.phone_menu_options (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  menu_id         uuid not null,
  digit           text not null,
  team_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (menu_id, digit),
  foreign key (organization_id, menu_id) references public.phone_menus(organization_id, id) on delete cascade,
  foreign key (organization_id, team_id) references public.attendance_teams(organization_id, id)
);
delete from public.phone_menu_options where digit !~ '^[0-9]$';
alter table public.phone_menu_options drop constraint if exists phone_menu_options_digit_check;
alter table public.phone_menu_options add constraint phone_menu_options_digit_check
  check (digit ~ '^[0-9]$');

create index if not exists phone_menus_org on public.phone_menus (organization_id) where archived_at is null;
create index if not exists phone_menu_options_team on public.phone_menu_options (organization_id, team_id);

-- 4. channel_sessions.sip_menu_id ---------------------------------------------
alter table public.channel_sessions
  add column if not exists sip_menu_id uuid references public.phone_menus(id) on delete set null;
update public.channel_sessions
   set sip_menu_id = null
 where sip_team_id is not null and sip_menu_id is not null;
alter table public.channel_sessions drop constraint if exists channel_sessions_sip_destino_check;
alter table public.channel_sessions add constraint channel_sessions_sip_destino_check
  check (not (sip_team_id is not null and sip_menu_id is not null));
create index if not exists idx_channel_sessions_sip_menu
  on public.channel_sessions (sip_menu_id) where sip_menu_id is not null;

-- 5. attendance_teams.phone_emergency_* -----------------------------------------
alter table public.attendance_teams
  add column if not exists phone_emergency_prompt_id uuid references public.phone_prompts(id) on delete set null,
  add column if not exists phone_emergency_active_since timestamptz,
  add column if not exists phone_emergency_expires_at timestamptz,
  add column if not exists phone_emergency_activated_by uuid references auth.users(id) on delete set null;
update public.attendance_teams
   set phone_emergency_active_since = null, phone_emergency_expires_at = null, phone_emergency_activated_by = null
 where (phone_emergency_active_since is null and phone_emergency_expires_at is not null)
    or (phone_emergency_expires_at is not null and phone_emergency_expires_at <= phone_emergency_active_since);
alter table public.attendance_teams drop constraint if exists attendance_teams_phone_emergency_check;
alter table public.attendance_teams add constraint attendance_teams_phone_emergency_check check (
  (phone_emergency_active_since is null and phone_emergency_expires_at is null)
  or (phone_emergency_active_since is not null
      and (phone_emergency_expires_at is null or phone_emergency_expires_at > phone_emergency_active_since))
);
create index if not exists attendance_teams_aviso_com_prazo
  on public.attendance_teams (phone_emergency_expires_at) where phone_emergency_expires_at is not null;

-- 6. voice_calls ----------------------------------------------------------------
alter table public.voice_calls
  add column if not exists menu_id uuid references public.phone_menus(id) on delete set null,
  add column if not exists menu_digit text,
  add column if not exists menu_outcome text,
  add column if not exists emergency_heard_at timestamptz;
update public.voice_calls set menu_digit = null where menu_digit is not null and menu_digit !~ '^[0-9]$';
update public.voice_calls set menu_outcome = null
 where menu_outcome is not null and menu_outcome not in ('chosen', 'default_no_input', 'default_invalid');
alter table public.voice_calls drop constraint if exists voice_calls_menu_digit_check;
alter table public.voice_calls add constraint voice_calls_menu_digit_check
  check (menu_digit is null or menu_digit ~ '^[0-9]$');
alter table public.voice_calls drop constraint if exists voice_calls_menu_outcome_check;
alter table public.voice_calls add constraint voice_calls_menu_outcome_check
  check (menu_outcome is null or menu_outcome in ('chosen', 'default_no_input', 'default_invalid'));
create index if not exists idx_voice_calls_menu_recentes
  on public.voice_calls (menu_id, started_at) where menu_id is not null;

-- 7. RLS, GRANT e policies ------------------------------------------------------
alter table public.phone_prompts      enable row level security;
alter table public.phone_settings     enable row level security;
alter table public.phone_menus        enable row level security;
alter table public.phone_menu_options enable row level security;

revoke all on public.phone_prompts, public.phone_settings, public.phone_menus, public.phone_menu_options
  from public, anon, authenticated, service_role;
grant select on public.phone_prompts, public.phone_settings, public.phone_menus, public.phone_menu_options
  to authenticated, service_role;

drop policy if exists tenant_isolation_phone_prompts_all on public.phone_prompts;
create policy tenant_isolation_phone_prompts_all on public.phone_prompts for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_settings_all on public.phone_settings;
create policy tenant_isolation_phone_settings_all on public.phone_settings for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_menus_all on public.phone_menus;
create policy tenant_isolation_phone_menus_all on public.phone_menus for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_phone_menu_options_all on public.phone_menu_options;
create policy tenant_isolation_phone_menu_options_all on public.phone_menu_options for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- 8. updated_at ------------------------------------------------------------------
create or replace trigger trg_phone_prompts_updated_at
  before update on public.phone_prompts for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_settings_updated_at
  before update on public.phone_settings for each row execute function public.fn_set_updated_at();
create or replace trigger trg_phone_menus_updated_at
  before update on public.phone_menus for each row execute function public.fn_set_updated_at();

-- 9. Bucket privado --------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('phone-prompts', 'phone-prompts', false, 2097152, array['audio/basic'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 10. Comentários ----------------------------------------------------------------
comment on table public.phone_prompts is
  'Uma fala do telefone (URA, aguarde, ninguém atendeu, fora do horário, aviso de instabilidade). Áudio μ-law 8 kHz no bucket privado phone-prompts; gerado pela API na ElevenLabs e copiado pelo worker para o volume telefonia-falas, que o Asterisk lê. Escrita só pela API/worker (GRANT só de SELECT).';
comment on column public.phone_prompts.storage_path is
  '<organization_id>/<content_hash>.ulaw no bucket phone-prompts — amarrado por CHECK, porque o worker escreve este caminho no disco. NULL quando a geração falhou.';
comment on table public.phone_menus is
  'Menu de voz (URA) da organização: serve a vários números (channel_sessions.sip_menu_id). Tecla → time em phone_menu_options; quem não escolhe vai ao default_team_id. accepts_extension é da versão 3 (ramais).';
comment on column public.channel_sessions.sip_menu_id is
  'Menu de voz que atende as ligações deste número. Excludente com sip_team_id (channel_sessions_sip_destino_check). A API só aceita menu com a fala pronta.';
comment on column public.attendance_teams.phone_emergency_expires_at is
  'Quando o aviso de instabilidade do telefone desliga sozinho. NULL com active_since preenchido = até alguém desligar. O worker lê a cada ligação e desliga os vencidos a cada 60 s (auditoria phone.emergency_expired + aviso na Central).';
comment on column public.voice_calls.menu_outcome is
  'O que o menu de voz fez: chosen (tecla de uma opção), default_no_input (ninguém escolheu), default_invalid (houve tecla errada). NULL com menu_id = desligou no menu. Fonte do "últimos 7 dias" do menu.';
-- [apêndice 0288: fim]

-- 11. agent_inbox_items.kind — a LISTA INTEIRA: a última migration que reconstrói
--     a constraint termina igual ao baseline (tests/unit/kind-check-migration-x-baseline.test.ts).
alter table public.agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items add constraint agent_inbox_items_kind_check check (kind in (
  'appointment_outcome_required',
  'appointment_recovery_review',
  'qr_rescan',
  'routing_unassigned',
  'job_dead',
  'event_dead',
  'budget_exceeded',
  'handoff',
  'promotion_review',
  'judge_unaligned',
  'followup_dead',
  'snooze_expired',
  'next_action_ambiguous',
  'risk_backlog_seeded',
  'reactivation_expired',
  'capabilities_missing',
  'message_send_stuck',
  'midia_nao_lida',
  'channel_template_review',
  'channel_number_alert',
  'promise_unfulfilled',
  'contact_proposal_expired',
  'budget_warning',
  'conhecimento_nao_indexado',
  'voice_call_missed',
  'case_stale',
  'phone_prompt_unplayable',
  'phone_emergency_expired',
  'other'
));

notify pgrst, 'reload schema';
```

- [ ] **Step 5: O baseline — bloco único da Central e o apêndice**

Rode, da raiz do worktree (os `assert` param a edição se o baseline não estiver como esperado):

```bash
python3 - <<'PY'
MIG = "supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql"
BASE = "supabase/baseline.sql"
mig = open(MIG, encoding="utf-8").read()
corpo = mig.split("-- [apêndice 0288: início]\n", 1)[1].split("-- [apêndice 0288: fim]\n", 1)[0]
b = open(BASE, encoding="utf-8").read()

# (a) agent_inbox_items_kind_check: o BLOCO ÚNICO ganha os dois kinds (nunca um bloco novo — #159).
antes = "    'voice_call_missed',\n    'case_stale',\n    'other'\n  ));"
depois = (
    "    'voice_call_missed',\n"
    "    'case_stale',\n"
    "    -- (migration 0288) Telefonia, fase 2: a fala do telefone não tocou (a ligação\n"
    "    -- seguiu sem ela) e o aviso de instabilidade de um time venceu e desligou\n"
    "    -- sozinho. Entram NESTA lista, no fim, pela mesma razão das de cima.\n"
    "    'phone_prompt_unplayable',\n"
    "    'phone_emergency_expired',\n"
    "    'other'\n  ));"
)
assert b.count(antes) == 1, "bloco do kind_check não encontrado exatamente uma vez"
b = b.replace(antes, depois, 1)

# (b) o apêndice da 0288, ANTES da varredura anon (que tem de ser o último bloco).
alvo = "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----"
assert b.count(alvo) == 1 and "(migration 0288) ----" not in b
bloco = (
    "-- ---- telefonia fase 2: URA e falas (migration 0288) ----\n"
    "-- Racional completo no cabeçalho de supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql\n"
    "-- e no desenho docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md.\n"
    "-- agent_inbox_items_kind_check: bloco único (acima), não aqui.\n\n"
    + corpo
    + "\nnotify pgrst, 'reload schema';\n\n"
)
b = b.replace(alvo, bloco + alvo, 1)
open(BASE, "w", encoding="utf-8").write(b)
print("ok")
PY
```

Expected: `ok`. Conferir: `grep -n "(migration 0288) ----\|'phone_prompt_unplayable'" supabase/baseline.sql` → o rótulo uma vez e o kind uma vez.

- [ ] **Step 6: MANIFEST**

Em `supabase/migrations/MANIFEST.md`, logo depois da linha que começa com `` | `20260928200000` | `0287_telefonia_prefixo_de_discagem` ``, acrescente a linha:

```
| `20260928230000` | `0288_telefonia_ura_e_falas` | **Telefonia, fase 2, versão 1: URA (menu de voz) e falas** (desenho `docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`). (1) `phone_prompts`: uma linha por fala (menu, tecla inválida, aguarde, ninguém atendeu, fora do horário, aviso de instabilidade) com texto, voz, modelo, `content_hash` (sha256), `storage_path` amarrado por CHECK a `<org>/<hash>.ulaw` no bucket PRIVADO `phone-prompts`, `duration_ms` e `status` `ready`/`failed` + `error`. (2) `phone_settings`: a voz da ElevenLabs e as três falas gerais por organização. (3) `phone_menus` + `phone_menu_options`: menu da organização, tecla 0–9 → time, time padrão, `accepts_extension` (reservada para a versão 3); FK composta a `attendance_teams(organization_id, id)`. (4) `channel_sessions.sip_menu_id` + CHECK `channel_sessions_sip_destino_check` (time OU menu; linha com os dois mantém o time). (5) `attendance_teams.phone_emergency_*` (fala, desde, até, quem ligou) com CHECK de coerência (linha incoerente é desligada antes). (6) `voice_calls.menu_id/menu_digit/menu_outcome/emergency_heard_at`; `end_reason` ganha `after_hours` (vocabulário aberto, sem CHECK). (7) `agent_inbox_items.kind` + `phone_prompt_unplayable` e `phone_emergency_expired` (bloco único do baseline editado; esta migration reconstrói a lista inteira). RLS `tenant_isolation_<tabela>_all` e GRANT só de SELECT nas quatro tabelas novas — escrita pela API e pelo worker. Nenhuma função nova. Gate: `tests/invariants/telefonia-ura-e-falas.test.ts`. |
```

- [ ] **Step 7: O vocabulário da Central no TypeScript**

Em `lib/agent-engine/db/repository.ts`, troque as linhas 74–75:

```ts
  | 'voice_call_missed'
  | 'other';
```

por:

```ts
  | 'voice_call_missed'
  // (migration 0288) Telefonia, URA e falas: a fala do telefone não tocou (a
  // ligação seguiu sem ela) e o aviso de instabilidade de um time venceu e
  // desligou sozinho.
  | 'phone_prompt_unplayable'
  | 'phone_emergency_expired'
  | 'other';
```

Em `lib/ai/agent-inbox-copy.ts`, troque as linhas 76–77:

```ts
  voice_call_missed: "Alguém ligou e ninguém atendeu",
  other: "Aviso do assistente",
```

por:

```ts
  voice_call_missed: "Alguém ligou e ninguém atendeu",
  // Diz o que aconteceu com quem ligou: a fala faltou, a ligação seguiu. Não é
  // "erro de áudio" — quem lê precisa saber que o cliente não ouviu o menu ou o aviso.
  phone_prompt_unplayable: "Uma fala do telefone não tocou",
  phone_emergency_expired: "O aviso de instabilidade do telefone desligou sozinho",
  other: "Aviso do assistente",
```

Em `lib/ai/inbox-destino.ts`, logo ANTES da linha 73 (`  other: { refs: ["lead", "channel_session", "appointment", "ai_agent"], ...`), acrescente:

```ts
  // Sem referência de propósito (`ref_kind`/`ref_id` nulos): o aviso é da fala,
  // e a fala se conserta na aba do telefone — o contexto geral é a porta certa.
  phone_prompt_unplayable: {
    refs: [],
    orientacao: "Gere a fala de novo em Conexões › Telefone. Enquanto isso, as ligações seguem sem ela.",
    geral: { papel: "admin", href: "/app/connections?aba=telefone&sub=falas", rotulo: "Revisar as falas do telefone" },
  },
  phone_emergency_expired: {
    refs: [],
    orientacao: "Se a instabilidade continua, ligue o aviso de novo no time.",
    geral: { papel: "manager", href: "/app/settings/teams", rotulo: "Abrir os times" },
  },
```

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — avisos da Central (migration 0288)
  "Uma fala do telefone não tocou": { es: "Una locución del teléfono no se reprodujo" },
  "O aviso de instabilidade do telefone desligou sozinho": { es: "El aviso de inestabilidad del teléfono se desactivó solo" },
  "Gere a fala de novo em Conexões › Telefone. Enquanto isso, as ligações seguem sem ela.": {
    es: "Genera la locución de nuevo en Conexiones › Teléfono. Mientras tanto, las llamadas siguen sin ella.",
  },
  "Revisar as falas do telefone": { es: "Revisar las locuciones del teléfono" },
  "Se a instabilidade continua, ligue o aviso de novo no time.": {
    es: "Si la inestabilidad continúa, vuelve a activar el aviso en el equipo.",
  },
  "Abrir os times": { es: "Abrir los equipos" },
```

- [ ] **Step 8: Gates de unidade do schema e typecheck**

Run:

```bash
pnpm exec vitest run tests/unit/kind-check-migration-x-baseline.test.ts tests/unit/manifest-x-migrations.test.ts \
  tests/unit/baseline-constraint-reconstruida.test.ts tests/unit/midia-nao-lida.test.ts \
  tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts lib/ai/agent-inbox-copy.test.ts lib/ai/inbox-destino.test.ts \
  && pnpm typecheck
```

Expected: PASS em todos e `tsc` sem erro.

- [ ] **Step 9: A prova no banco, e a suíte inteira de invariantes (install + update do baseline)**

Run: `pnpm test:db tests/invariants/telefonia-ura-e-falas.test.ts`
Expected: PASS (todos os casos).

Run: `pnpm test:db > /tmp/test-db-0288.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests " /tmp/test-db-0288.log | tail -2`
Expected: `exit=0`, `0 failed` — inclusive `vocabulario-banco-x-typescript` (os 3 pares novos e o `InboxKind`), `rls-completude-varredura` e `hardening-definer-varredura`.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/20260928230000_0288_telefonia_ura_e_falas.sql supabase/baseline.sql supabase/migrations/MANIFEST.md \
  tests/invariants/telefonia-ura-e-falas.test.ts tests/invariants/vocabulario-banco-x-typescript.test.ts \
  tests/invariants/rls-completude-varredura.test.ts lib/agent-engine/db/repository.ts lib/ai/agent-inbox-copy.ts \
  lib/ai/inbox-destino.ts lib/i18n/dicionario.ts
git commit -m "feat(telefonia): migration 0288 — URA, falas e aviso de instabilidade no schema

phone_prompts, phone_settings, phone_menus e phone_menu_options com RLS de
leitura por organização e escrita só pela API/worker; número aponta para time OU
menu; aviso de instabilidade por time com prazo; o que o menu fez em voice_calls;
dois avisos novos na Central; bucket privado phone-prompts. Tripla: migration,
apêndice idempotente no baseline e MANIFEST, provada em Postgres real.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: A chave da ElevenLabs — guardar cifrada, validar listando vozes, auditar

**Files:**
- Create: `lib/telefonia/chave-elevenlabs.ts`, `lib/telefonia/chave-elevenlabs.test.ts`
- Create: `lib/telefonia/servico-de-falas.ts` (primeira versão; a Task 6 a completa)
- Create: `app/api/v1/telefonia/voz/chave/route.ts`, `app/api/v1/telefonia/voz/chave/route.test.ts`
- Modify: `lib/audit/actions.ts` (fim de `AUDIT_ACTIONS`, antes de `] as const;`)
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste da camada de banco (falha: o módulo não existe)**

Crie `lib/telefonia/chave-elevenlabs.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// A cifra real depende de AI_CRED_AES_KEY; aqui importa só QUE o texto puro não chega ao banco.
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (p: string) => ({
    ciphertext: Buffer.from(`cifrado:${p}`),
    iv: Buffer.alloc(12, 1),
    tag: Buffer.alloc(16, 2),
    last4: p.slice(-4),
  }),
  decryptKey: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString().replace(/^cifrado:/, ""),
  byteaToBuffer: (v: unknown) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v))),
}));

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ, chaveDeVoz, estadoDaChaveDeVoz, guardarChaveDeVoz } from "./chave-elevenlabs";

function bancoFalso(linhas: Record<string, unknown>[] = []) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      return { rows: linhas, rowCount: linhas.length };
    }) as unknown as Queryable["query"],
  };
  return { db, consultas };
}

describe("a chave da ElevenLabs da organização", () => {
  it("guarda CIFRADA, com provider e rótulo fixos (uma por organização), e nunca o texto puro", async () => {
    const { db, consultas } = bancoFalso([{ id: "cred-1", substituiu: false }]);
    const r = await guardarChaveDeVoz(db, { organizationId: "org-1", userId: "user-1", chave: "sk_abcdefgh1234" });

    expect(r).toEqual({ id: "cred-1", last4: "1234", substituiu: false });
    expect(consultas[0]!.params.slice(0, 3)).toEqual(["org-1", PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ]);
    expect(consultas[0]!.params).not.toContain("sk_abcdefgh1234");
    expect(consultas[0]!.sql).toMatch(/on conflict \(organization_id, provider, label\) do update/);
  });

  it("estado: cadastrada com os 4 últimos, ou ausente", async () => {
    expect(
      await estadoDaChaveDeVoz(bancoFalso([{ last4: "1234", validada_em: new Date("2026-09-28T13:00:00Z") }]).db, "org-1"),
    ).toEqual({ cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" });
    expect(await estadoDaChaveDeVoz(bancoFalso([]).db, "org-1")).toEqual({ cadastrada: false, last4: null, validada_em: null });
  });

  it("decifra só a da própria organização; sem linha, null", async () => {
    const { db, consultas } = bancoFalso([{ c: Buffer.from("cifrado:sk_x"), iv: Buffer.alloc(12), tag: Buffer.alloc(16) }]);
    expect(await chaveDeVoz(db, "org-1")).toBe("sk_x");
    expect(consultas[0]!.params).toEqual(["org-1", PROVEDOR_DE_VOZ]);
    expect(await chaveDeVoz(bancoFalso([]).db, "org-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/chave-elevenlabs.test.ts`
Expected: FAIL — `Failed to resolve import "./chave-elevenlabs"`.

- [ ] **Step 3: Implementar a camada de banco**

Crie `lib/telefonia/chave-elevenlabs.ts`:

```ts
/**
 * A CHAVE DA ELEVENLABS DA ORGANIZAÇÃO (desenho da fase 2, D4 e §7).
 *
 * Uma por organização, em `ai_provider_credentials` com `provider = 'elevenlabs'`
 * e rótulo fixo — o UNIQUE `(organization_id, provider, label)` é o que faz
 * "trocar a chave" substituir em vez de somar. Cifrada com AI_CRED_AES_KEY como
 * toda chave de IA; a tela só vê os 4 últimos dígitos.
 *
 * NÃO entra em `PROVEDORES` (lib/ai/pontos/provedores.ts): aquela lista é de
 * quem executa modelo de linguagem e casa com o registry do motor. A ElevenLabs
 * só dá voz ao telefone; quem a usa é este módulo.
 *
 * Server-only. O banco entra como `Queryable` (a rota passa o pool do request).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

export const PROVEDOR_DE_VOZ = "elevenlabs";
export const ROTULO_DA_CHAVE_DE_VOZ = "ElevenLabs";

export interface EstadoDaChaveDeVoz {
  cadastrada: boolean;
  last4: string | null;
  validada_em: string | null;
}

export async function estadoDaChaveDeVoz(db: Queryable, organizationId: string): Promise<EstadoDaChaveDeVoz> {
  const { rows } = await db.query<{ last4: string; validada_em: Date | string | null }>(
    `select api_key_last4 as last4, validated_at as validada_em
       from ai_provider_credentials
      where organization_id = $1 and provider = $2 and is_active = true
      order by created_at desc limit 1`,
    [organizationId, PROVEDOR_DE_VOZ],
  );
  const r = rows[0];
  if (!r) return { cadastrada: false, last4: null, validada_em: null };
  return { cadastrada: true, last4: r.last4, validada_em: r.validada_em ? new Date(r.validada_em).toISOString() : null };
}

/** Grava (ou substitui) a chave JÁ VALIDADA pela rota. O texto puro vive só nesta chamada. */
export async function guardarChaveDeVoz(
  db: Queryable,
  p: { organizationId: string; userId: string; chave: string },
): Promise<{ id: string; last4: string; substituiu: boolean }> {
  const cifra = encryptKey(p.chave);
  const { rows } = await db.query<{ id: string; substituiu: boolean }>(
    `insert into ai_provider_credentials
       (organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4,
        is_active, created_by, validated_at, validation_error)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8, now(), null)
     on conflict (organization_id, provider, label) do update
       set api_key_encrypted = excluded.api_key_encrypted,
           api_key_iv = excluded.api_key_iv,
           api_key_tag = excluded.api_key_tag,
           api_key_last4 = excluded.api_key_last4,
           is_active = true, validated_at = now(), validation_error = null, updated_at = now()
     returning id, (xmax::text <> '0') as substituiu`,
    [
      p.organizationId,
      PROVEDOR_DE_VOZ,
      ROTULO_DA_CHAVE_DE_VOZ,
      cifra.ciphertext,
      cifra.iv,
      cifra.tag,
      cifra.last4,
      p.userId,
    ],
  );
  return { id: rows[0]!.id, last4: cifra.last4, substituiu: Boolean(rows[0]!.substituiu) };
}

/**
 * A chave em claro, para chamar a ElevenLabs agora. Nunca lança: falha de leitura
 * ou de decifragem vira `null` (a tela diz "cadastre a chave"), e o log leva só a
 * classe do erro — nunca a mensagem, que pode carregar material da credencial.
 */
export async function chaveDeVoz(db: Queryable, organizationId: string): Promise<string | null> {
  try {
    const { rows } = await db.query<{ c: unknown; iv: unknown; tag: unknown }>(
      `select api_key_encrypted as c, api_key_iv as iv, api_key_tag as tag
         from ai_provider_credentials
        where organization_id = $1 and provider = $2 and is_active = true
        order by created_at desc limit 1`,
      [organizationId, PROVEDOR_DE_VOZ],
    );
    const r = rows[0];
    if (!r) return null;
    const chave = decryptKey({ ciphertext: byteaToBuffer(r.c), iv: byteaToBuffer(r.iv), tag: byteaToBuffer(r.tag) }).trim();
    return chave || null;
  } catch (e) {
    logger.warn("[telefonia] chave da ElevenLabs ilegível", {
      organization_id: organizationId,
      classe: e instanceof Error ? e.name : "desconhecida",
    });
    return null;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/chave-elevenlabs.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: A primeira versão da fiação da instalação**

Crie `lib/telefonia/servico-de-falas.ts`:

```ts
/**
 * A FIAÇÃO DA INSTALAÇÃO para as rotas do telefone — o único lugar que lê o env
 * da ElevenLabs e decide o status HTTP de cada falha. Server-only.
 */
import { env } from "@/lib/env";

import type { OpcoesDoCliente } from "./elevenlabs";
import type { FalhaDaFala } from "./vocabulario";

/** A URL base só muda no e2e (a ElevenLabs falsa de tests/e2e/telefonia-ura-e-falas.spec.ts). */
export function opcoesDaElevenLabs(): OpcoesDoCliente {
  return env.ELEVENLABS_API_BASE_URL ? { baseUrl: env.ELEVENLABS_API_BASE_URL } : {};
}

/**
 * 422 (a pessoa pode consertar) ou 502 (o provedor/Storage falhou) — NUNCA 429
 * ou 503: o `apiClient` do navegador repete esses sozinho, e cada repetição de
 * síntese gasta crédito da conta do cliente.
 */
export const STATUS_DA_FALHA: Record<FalhaDaFala, 422 | 502> = {
  sem_chave: 422,
  sem_voz: 422,
  chave_invalida: 422,
  sem_credito: 422,
  texto_recusado: 422,
  voz_inexistente: 422,
  limite_de_uso: 422,
  armazenamento: 502,
  sem_resposta: 502,
  erro_do_provedor: 502,
};
```

- [ ] **Step 6: As ações de auditoria da fase 2 (todas de uma vez)**

Em `lib/audit/actions.ts`, logo depois da linha `  "phone_extension.credential_issued",` (antes de `] as const;`), acrescente:

```ts
  // Telefonia, fase 2 — URA e falas (migration 0288). `metadata` NUNCA leva a
  // chave da ElevenLabs nem o áudio: só ids, tipo e estado da fala, o destino do
  // número e o prazo do aviso. A chave em si é auditada como
  // `ai.credential_created` com `provider = elevenlabs`.
  "phone.voice_changed",
  "phone.prompt_saved",
  "phone.menu_saved",
  "phone.menu_archived",
  "phone.number_destination_changed",
  "phone.emergency_activated",
  "phone.emergency_deactivated",
  // Gravado pelo WORKER na passada de 60 s, sem ator: o aviso venceu sozinho.
  "phone.emergency_expired",
```

- [ ] **Step 7: Teste da rota (falha: a rota não existe)**

Crie `app/api/v1/telefonia/voz/chave/route.test.ts`:

```ts
/**
 * A CHAVE DA ELEVENLABS PELA ROTA: validada ANTES de gravar, auditada sem o texto
 * da chave, e a resposta só traz os 4 últimos dígitos (desenho da fase 2, §7).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const estado = vi.hoisted(() => ({ falhaDaElevenLabs: null as null | string }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  opcoesDaElevenLabs: () => ({}),
  STATUS_DA_FALHA: { chave_invalida: 422, sem_credito: 422, sem_resposta: 502, erro_do_provedor: 502 },
}));
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof import("@/lib/telefonia/elevenlabs")>("@/lib/telefonia/elevenlabs");
  return {
    ...real,
    listarVozes: vi.fn(async () => {
      if (estado.falhaDaElevenLabs) throw new real.ErroDaElevenLabs(estado.falhaDaElevenLabs as "chave_invalida", 401);
      return [{ voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null }];
    }),
  };
});
vi.mock("@/lib/telefonia/chave-elevenlabs", () => ({
  PROVEDOR_DE_VOZ: "elevenlabs",
  guardarChaveDeVoz: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", last4: "1234", substituiu: false })),
  estadoDaChaveDeVoz: vi.fn(async () => ({ cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { guardarChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";

import { GET, PUT } from "./route";

const CHAVE = "sk_segredo_da_elevenlabs_1234";
const pedido = (corpo: unknown) =>
  new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/voz/chave", { method: "PUT", body: JSON.stringify(corpo) });

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(guardarChaveDeVoz).mockClear();
  vi.mocked(requireRole).mockClear();
  estado.falhaDaElevenLabs = null;
});

describe("PUT /api/v1/telefonia/voz/chave", () => {
  it("só admin grava", async () => {
    await PUT(pedido({ chave: CHAVE }));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
  });

  it("chave que a ElevenLabs recusa NÃO é guardada nem auditada, e a mensagem vem traduzida", async () => {
    estado.falhaDaElevenLabs = "chave_invalida";
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("chave_invalida");
    expect(corpo.error.message).toMatch(/recusou a chave/);
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("chave válida: guarda, audita sem a chave, e a resposta só tem os 4 últimos", async () => {
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(200);
    const texto = await r.text();
    expect(texto).not.toContain(CHAVE);
    expect(texto).toContain("1234");
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({ action: "ai.credential_created", metadata: { provider: "elevenlabs", last4: "1234", vozes: 1 } });
    expect(JSON.stringify(entrada)).not.toContain(CHAVE);
  });

  it("corpo inválido → 422, sem ir à ElevenLabs nem gravar", async () => {
    const r = await PUT(pedido({ chave: "curta" }));
    expect(r.status).toBe(422);
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/telefonia/voz/chave", () => {
  it("gerente lê o estado — sem a chave", async () => {
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(await r.json()).toMatchObject({ data: { cadastrada: true, last4: "1234" } });
  });
});
```

- [ ] **Step 8: Rodar e ver falhar**

Run: `pnpm exec vitest run app/api/v1/telefonia/voz/chave/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 9: Implementar a rota**

Crie `app/api/v1/telefonia/voz/chave/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/voz/chave — a chave da ElevenLabs está cadastrada? (manager+; só os 4 últimos)
 * PUT /api/v1/telefonia/voz/chave — cadastra ou troca a chave (admin).
 *
 * Desenho da fase 2, §6.1 e §7. A chave é VALIDADA antes de gravar, listando as
 * vozes da conta: chave que a ElevenLabs recusa não é guardada. Uma por
 * organização (trocar substitui). O texto puro entra só no corpo deste PUT e sai
 * só no header da chamada à ElevenLabs; é cifrado com AI_CRED_AES_KEY e nunca volta.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { PROVEDOR_DE_VOZ, estadoDaChaveDeVoz, guardarChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes } from "@/lib/telefonia/elevenlabs";
import { STATUS_DA_FALHA, opcoesDaElevenLabs } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const chaveSchema = z.object({ chave: z.string().trim().min(8).max(256) }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  return ok(await estadoDaChaveDeVoz(getRequestPool(), authz.org.orgId), { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = chaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Cole a chave da ElevenLabs (pelo menos 8 caracteres)."), 422, { requestId });
  }

  let vozes: number;
  try {
    vozes = (await listarVozes(parsed.data.chave, opcoesDaElevenLabs())).length;
  } catch (e) {
    const motivo: FalhaDaFala = e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor";
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }

  const pool = getRequestPool();
  const guardada = await guardarChaveDeVoz(pool, {
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    chave: parsed.data.chave,
  });
  void audit({
    action: "ai.credential_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_provider_credential",
    resourceId: guardada.id,
    metadata: { provider: PROVEDOR_DE_VOZ, last4: guardada.last4, substituiu: guardada.substituiu, vozes },
    requestId,
  });
  return ok(await estadoDaChaveDeVoz(pool, authz.org.orgId), { requestId });
}
```

- [ ] **Step 10: Dicionário (mensagens que a rota traduz)**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — falhas da fala e da chave de voz
  "Cole a chave da ElevenLabs (pelo menos 8 caracteres).": { es: "Pega la clave de ElevenLabs (al menos 8 caracteres)." },
  "Cadastre a chave da ElevenLabs em Credenciais de IA para gerar as falas.": {
    es: "Registra la clave de ElevenLabs en Credenciales de IA para generar las locuciones.",
  },
  "Escolha a voz das falas na aba Voz e falas antes de gerar.": {
    es: "Elige la voz de las locuciones en la pestaña Voz y locuciones antes de generar.",
  },
  "Não foi possível guardar o áudio da fala. Tente de novo em instantes.": {
    es: "No se pudo guardar el audio de la locución. Inténtalo de nuevo en unos instantes.",
  },
  "A ElevenLabs recusou a chave. Confira a chave em Credenciais de IA.": {
    es: "ElevenLabs rechazó la clave. Revisa la clave en Credenciales de IA.",
  },
  "A conta da ElevenLabs está sem crédito. As falas já geradas continuam tocando.": {
    es: "La cuenta de ElevenLabs no tiene crédito. Las locuciones ya generadas siguen sonando.",
  },
  "A ElevenLabs recusou este texto. Encurte ou reescreva e tente de novo.": {
    es: "ElevenLabs rechazó este texto. Acórtalo o reescríbelo e inténtalo de nuevo.",
  },
  "Essa voz não existe mais na conta da ElevenLabs. Escolha outra voz.": {
    es: "Esa voz ya no existe en la cuenta de ElevenLabs. Elige otra voz.",
  },
  "A ElevenLabs pediu para esperar um pouco. Tente de novo em instantes.": {
    es: "ElevenLabs pidió esperar un poco. Inténtalo de nuevo en unos instantes.",
  },
  "A ElevenLabs não respondeu. Tente de novo em instantes.": { es: "ElevenLabs no respondió. Inténtalo de nuevo en unos instantes." },
  "A ElevenLabs devolveu um erro. Tente de novo em instantes.": {
    es: "ElevenLabs devolvió un error. Inténtalo de nuevo en unos instantes.",
  },
```

- [ ] **Step 11: Rodar e ver passar**

Run: `pnpm exec vitest run app/api/v1/telefonia/voz/chave/route.test.ts lib/telefonia/chave-elevenlabs.test.ts tests/unit/audit-resource-id-e-uuid.test.ts && pnpm typecheck && pnpm lint:role-rank && pnpm lint:channels`
Expected: PASS nos três arquivos; `tsc`, `lint:role-rank` e `lint:channels` sem erro.

- [ ] **Step 12: Commit**

```bash
git add lib/telefonia/chave-elevenlabs.ts lib/telefonia/chave-elevenlabs.test.ts lib/telefonia/servico-de-falas.ts \
  app/api/v1/telefonia/voz/chave/route.ts app/api/v1/telefonia/voz/chave/route.test.ts lib/audit/actions.ts lib/i18n/dicionario.ts
git commit -m "feat(telefonia): chave da ElevenLabs por organização, validada antes de gravar

Uma por organização em ai_provider_credentials (provider elevenlabs), cifrada
com AI_CRED_AES_KEY; a rota valida listando as vozes da conta e nunca devolve a
chave. Ações de auditoria da fase 2 registradas no vocabulário.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: As falas — armazém e geração (regravar, reaproveitar, descartar)

**Files:**
- Create: `lib/telefonia/armazem.ts`
- Create: `lib/telefonia/falas.ts`, `lib/telefonia/falas.test.ts`
- Modify: `lib/telefonia/servico-de-falas.ts` (versão final, arquivo inteiro)

- [ ] **Step 1: A porta do Storage**

Crie `lib/telefonia/armazem.ts`:

```ts
/**
 * O STORAGE DAS FALAS — a porta e a implementação com o cliente de serviço.
 *
 * O bucket `phone-prompts` é PRIVADO: só o cliente de serviço (API e worker) lê e
 * escreve. A tela nunca recebe URL do Storage — ouve pela rota
 * `/api/v1/telefonia/falas/[id]/audio`, que confere a organização antes.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

import { BUCKET_DAS_FALAS } from "./vocabulario";

export interface PortaDoArmazem {
  enviar(caminho: string, bytes: Uint8Array): Promise<void>;
  baixar(caminho: string): Promise<Uint8Array<ArrayBuffer> | null>;
  apagar(caminhos: string[]): Promise<void>;
}

export function armazemDoSupabase(admin: ReturnType<typeof createAdminClient>): PortaDoArmazem {
  const bucket = () => admin.storage.from(BUCKET_DAS_FALAS);
  return {
    async enviar(caminho, bytes) {
      const { error } = await bucket().upload(caminho, bytes, { contentType: "audio/basic", upsert: true });
      if (error) throw new Error(`armazem_envio: ${error.message}`);
    },
    async baixar(caminho) {
      const { data, error } = await bucket().download(caminho);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async apagar(caminhos) {
      if (caminhos.length === 0) return;
      await bucket().remove(caminhos);
    },
  };
}
```

- [ ] **Step 2: Teste da geração (falha: o módulo não existe)**

Crie `lib/telefonia/falas.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs } from "./elevenlabs";
import { caminhoDaFala, descartarFala, gerarFala, hashDaFala, type LinhaDaFala, type PedidoDeFala } from "./falas";

const ORG = "00000000-0000-4000-8000-00000000000a";
const VOZ = { voiceId: "voz-1", modelId: "eleven_multilingual_v2" };

type Linha = LinhaDaFala & { organization_id: string; model_id: string };

/** O banco em memória: só as cinco consultas que `falas.ts` faz. */
class BancoDeFalas {
  linhas = new Map<string, Linha>();
  private seq = 0;
  db: Queryable = {
    query: (async (sqlBruto: string, p: unknown[] = []) => {
      const sql = sqlBruto.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select") && sql.includes("from phone_prompts where id = $1")) {
        const l = this.linhas.get(p[0] as string);
        const rows = l && l.organization_id === p[1] ? [l] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("insert into phone_prompts")) {
        const l: Linha = {
          id: `fala-${++this.seq}`,
          organization_id: p[0] as string,
          tipo: p[1] as Linha["tipo"],
          texto: p[2] as string,
          voice_id: p[3] as string,
          model_id: p[4] as string,
          content_hash: p[5] as string,
          storage_path: p[6] as string | null,
          duracao_ms: p[7] as number | null,
          status: p[8] as Linha["status"],
          erro: p[9] as string | null,
          atualizada_em: new Date("2026-09-28T13:00:00Z"),
        };
        this.linhas.set(l.id, l);
        return { rows: [l], rowCount: 1 };
      }
      if (sql.startsWith("update phone_prompts")) {
        const l = this.linhas.get(p[0] as string);
        if (!l || l.organization_id !== p[1]) return { rows: [], rowCount: 0 };
        Object.assign(l, {
          texto: p[2], voice_id: p[3], model_id: p[4], content_hash: p[5],
          storage_path: p[6], duracao_ms: p[7], status: p[8], erro: p[9],
        });
        return { rows: [l], rowCount: 1 };
      }
      if (sql.startsWith("select 1 from phone_prompts where storage_path = $1")) {
        const achou = [...this.linhas.values()].some((l) => l.storage_path === p[0]);
        return { rows: achou ? [{ um: 1 }] : [], rowCount: achou ? 1 : 0 };
      }
      if (sql.startsWith("delete from phone_prompts")) {
        const l = this.linhas.get(p[0] as string);
        if (!l || l.organization_id !== p[1]) return { rows: [], rowCount: 0 };
        this.linhas.delete(l.id);
        return { rows: [{ storage_path: l.storage_path }], rowCount: 1 };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    }) as unknown as Queryable["query"],
  };
}

class ArmazemFalso implements PortaDoArmazem {
  objetos = new Map<string, Uint8Array>();
  apagados: string[] = [];
  falharEnvio = false;
  enviar = async (caminho: string, bytes: Uint8Array) => {
    if (this.falharEnvio) throw new Error("storage fora");
    this.objetos.set(caminho, bytes);
  };
  baixar = async (caminho: string) => {
    const b = this.objetos.get(caminho);
    return b ? new Uint8Array(b) : null;
  };
  apagar = async (caminhos: string[]) => {
    this.apagados.push(...caminhos);
    for (const c of caminhos) this.objetos.delete(c);
  };
}

let banco: BancoDeFalas;
let armazem: ArmazemFalso;
let sintetizar: ReturnType<typeof vi.fn>;

const pedido = (p: Partial<PedidoDeFala> = {}): PedidoDeFala => ({
  db: banco.db,
  armazem,
  sintetizar: sintetizar as unknown as PedidoDeFala["sintetizar"],
  organizationId: ORG,
  userId: "user-1",
  tipo: "waiting",
  texto: "Aguarde, por favor.",
  falaAtualId: null,
  chave: "sk_x",
  voz: VOZ,
  ...p,
});

beforeEach(() => {
  banco = new BancoDeFalas();
  armazem = new ArmazemFalso();
  sintetizar = vi.fn(async () => new Uint8Array(1600));
});

describe("gerarFala", () => {
  it("sem voz ou sem chave: nada é gerado nem gravado", async () => {
    expect(await gerarFala(pedido({ voz: null }))).toEqual({ ok: false, motivo: "sem_voz", fala: null });
    expect(await gerarFala(pedido({ chave: null }))).toEqual({ ok: false, motivo: "sem_chave", fala: null });
    expect(sintetizar).not.toHaveBeenCalled();
    expect(banco.linhas.size).toBe(0);
  });

  it("fala nova: sintetiza, sobe em <org>/<hash>.ulaw e grava pronta com a duração (bytes/8)", async () => {
    const r = await gerarFala(pedido());
    const hash = hashDaFala("Aguarde, por favor.", VOZ.voiceId, VOZ.modelId);
    expect(r).toMatchObject({ ok: true, gerada: true, fala: { status: "ready", duracao_ms: 200, texto: "Aguarde, por favor." } });
    expect([...armazem.objetos.keys()]).toEqual([caminhoDaFala(ORG, hash)]);
    expect(sintetizar).toHaveBeenCalledWith({ chave: "sk_x", voiceId: "voz-1", modelId: "eleven_multilingual_v2", texto: "Aguarde, por favor." });
  });

  it("mesmo texto, mesma voz, já pronta: não sintetiza de novo (a ElevenLabs cobra por caractere)", async () => {
    const primeira = await gerarFala(pedido());
    sintetizar.mockClear();
    const segunda = await gerarFala(pedido({ falaAtualId: primeira.fala!.id }));
    expect(segunda).toMatchObject({ ok: true, gerada: false, fala: { id: primeira.fala!.id } });
    expect(sintetizar).not.toHaveBeenCalled();
  });

  it("texto novo: regrava a MESMA linha com arquivo novo e apaga o antigo", async () => {
    const primeira = await gerarFala(pedido());
    const antigo = banco.linhas.get(primeira.fala!.id)!.storage_path!;
    const segunda = await gerarFala(pedido({ falaAtualId: primeira.fala!.id, texto: "Só um instante." }));
    expect(segunda.fala!.id).toBe(primeira.fala!.id);
    expect(banco.linhas.get(primeira.fala!.id)!.storage_path).not.toBe(antigo);
    expect(armazem.apagados).toEqual([antigo]);
  });

  it("o arquivo antigo que outra fala ainda usa NÃO é apagado", async () => {
    const a = await gerarFala(pedido());
    await gerarFala(pedido({ tipo: "nobody" }));
    await gerarFala(pedido({ falaAtualId: a.fala!.id, texto: "Outro texto." }));
    expect(armazem.apagados).toEqual([]);
  });

  it("a ElevenLabs falha numa fala que JÁ tinha áudio: o áudio antigo continua valendo, nada muda", async () => {
    const primeira = await gerarFala(pedido());
    sintetizar.mockRejectedValueOnce(new ErroDaElevenLabs("sem_credito", 401));
    const r = await gerarFala(pedido({ falaAtualId: primeira.fala!.id, texto: "Texto novo." }));
    expect(r).toMatchObject({ ok: false, motivo: "sem_credito", fala: { id: primeira.fala!.id, status: "ready", texto: "Aguarde, por favor." } });
    expect(armazem.apagados).toEqual([]);
  });

  it("a ElevenLabs falha numa fala sem áudio: a linha fica 'failed' com o motivo, sem arquivo", async () => {
    sintetizar.mockRejectedValueOnce(new ErroDaElevenLabs("texto_recusado", 422));
    const r = await gerarFala(pedido());
    expect(r).toMatchObject({ ok: false, motivo: "texto_recusado", fala: { status: "failed", erro: "texto_recusado" } });
    expect(banco.linhas.get(r.fala!.id)!.storage_path).toBeNull();
  });

  it("Storage fora do ar: motivo 'armazenamento', e nenhuma linha fica pronta", async () => {
    armazem.falharEnvio = true;
    const r = await gerarFala(pedido());
    expect(r).toMatchObject({ ok: false, motivo: "armazenamento", fala: { status: "failed" } });
  });
});

describe("descartarFala", () => {
  it("apaga a linha e o arquivo que ninguém mais usa", async () => {
    const r = await gerarFala(pedido());
    const caminho = banco.linhas.get(r.fala!.id)!.storage_path!;
    await descartarFala(banco.db, armazem, ORG, r.fala!.id);
    expect(banco.linhas.size).toBe(0);
    expect(armazem.apagados).toEqual([caminho]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/falas.test.ts`
Expected: FAIL — `Failed to resolve import "./falas"`.

- [ ] **Step 4: Implementar**

Crie `lib/telefonia/falas.ts`:

```ts
/**
 * AS FALAS DO TELEFONE — gerar, regravar e descartar (desenho da fase 2, §3.1 e §4).
 *
 * Uma fala = uma linha de `phone_prompts` + um arquivo μ-law no bucket privado
 * `phone-prompts`, em `<org>/<hash>.ulaw`, com hash = sha256(modelo, voz, texto).
 *
 *  - Mesmo texto, mesma voz, mesmo modelo, já pronta → nada a fazer e nada a
 *    pagar (a ElevenLabs cobra por caractere).
 *  - Texto (ou voz) novo → gera, sobe o arquivo novo, regrava a MESMA linha e
 *    apaga o arquivo antigo se nenhuma outra fala o usa.
 *  - A ElevenLabs (ou o Storage) falhou → se a fala já tinha áudio, ELE CONTINUA
 *    TOCANDO e nada muda — a chave sem crédito só impede editar; se não tinha, a
 *    linha fica `failed` com o motivo, e a tela o mostra.
 *
 * Server-only (sha256 do Node). Banco, Storage e síntese entram como portas: o
 * teste troca os três.
 */
import { createHash } from "node:crypto";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs } from "./elevenlabs";
import { duracaoDoUlawMs } from "./ulaw";
import {
  MODELO_DE_VOZ_PADRAO,
  type EstadoDaFala,
  type FalaGeral,
  type FalaPublica,
  type FalhaDaFala,
  type TipoDeFala,
} from "./vocabulario";

export function hashDaFala(texto: string, voiceId: string, modelId: string): string {
  return createHash("sha256").update(`${modelId}\n${voiceId}\n${texto}`).digest("hex");
}

export function caminhoDaFala(organizationId: string, hash: string): string {
  return `${organizationId}/${hash}.ulaw`;
}

/** A linha como o `pg` a devolve (datas chegam como `Date`). */
export interface LinhaDaFala {
  id: string;
  tipo: TipoDeFala;
  texto: string;
  voice_id: string;
  status: EstadoDaFala;
  erro: string | null;
  duracao_ms: number | null;
  atualizada_em: Date | string;
  content_hash: string;
  storage_path: string | null;
}

export const COLUNAS_DA_FALA = `id, kind as tipo, "text" as texto, voice_id, status, error as erro,
  duration_ms as duracao_ms, updated_at as atualizada_em, content_hash, storage_path`;

export function falaPublica(l: LinhaDaFala): FalaPublica {
  return {
    id: l.id,
    tipo: l.tipo,
    texto: l.texto,
    voice_id: l.voice_id,
    status: l.status,
    erro: l.erro,
    duracao_ms: l.duracao_ms,
    atualizada_em: new Date(l.atualizada_em).toISOString(),
  };
}

export async function falaPorId(db: Queryable, organizationId: string, id: string): Promise<LinhaDaFala | null> {
  const { rows } = await db.query<LinhaDaFala>(
    `select ${COLUNAS_DA_FALA} from phone_prompts where id = $1 and organization_id = $2`,
    [id, organizationId],
  );
  return rows[0] ?? null;
}

export interface VozDaOrganizacao {
  voiceId: string;
  modelId: string;
}

export async function vozDaOrganizacao(db: Queryable, organizationId: string): Promise<VozDaOrganizacao | null> {
  const { rows } = await db.query<{ voice_id: string | null; model_id: string | null }>(
    "select voice_id, model_id from phone_settings where organization_id = $1",
    [organizationId],
  );
  const r = rows[0];
  return r?.voice_id ? { voiceId: r.voice_id, modelId: r.model_id || MODELO_DE_VOZ_PADRAO } : null;
}

/** A coluna de `phone_settings` de cada fala geral — lista fechada: nunca texto de fora no SQL. */
export const COLUNA_DA_FALA_GERAL: Record<FalaGeral, "waiting_prompt_id" | "nobody_prompt_id" | "after_hours_prompt_id"> = {
  waiting: "waiting_prompt_id",
  nobody: "nobody_prompt_id",
  after_hours: "after_hours_prompt_id",
};

export async function falasGeraisDaOrg(
  db: Queryable,
  organizationId: string,
): Promise<Record<FalaGeral, FalaPublica | null>> {
  const { rows } = await db.query<{
    waiting_prompt_id: string | null;
    nobody_prompt_id: string | null;
    after_hours_prompt_id: string | null;
  }>(
    "select waiting_prompt_id, nobody_prompt_id, after_hours_prompt_id from phone_settings where organization_id = $1",
    [organizationId],
  );
  const s = rows[0];
  const ler = async (id: string | null | undefined) => {
    if (!id) return null;
    const l = await falaPorId(db, organizationId, id);
    return l ? falaPublica(l) : null;
  };
  return {
    waiting: await ler(s?.waiting_prompt_id),
    nobody: await ler(s?.nobody_prompt_id),
    after_hours: await ler(s?.after_hours_prompt_id),
  };
}

export type Sintetizador = (p: { chave: string; voiceId: string; modelId: string; texto: string }) => Promise<Uint8Array>;

export interface PedidoDeFala {
  db: Queryable;
  armazem: PortaDoArmazem;
  sintetizar: Sintetizador;
  organizationId: string;
  userId: string | null;
  tipo: TipoDeFala;
  texto: string;
  /** A fala que esta substitui (mesmo lugar: a mesma fala geral, o mesmo menu). `null` = nova. */
  falaAtualId: string | null;
  chave: string | null;
  voz: VozDaOrganizacao | null;
}

export type ResultadoDaFala =
  | { ok: true; fala: FalaPublica; gerada: boolean }
  | { ok: false; motivo: FalhaDaFala; fala: FalaPublica | null };

interface DadosDaLinha {
  organizationId: string;
  userId: string | null;
  tipo: TipoDeFala;
  texto: string;
  voiceId: string;
  modelId: string;
  hash: string;
  storagePath: string | null;
  duracaoMs: number | null;
  status: EstadoDaFala;
  erro: string | null;
}

async function gravar(db: Queryable, d: DadosDaLinha, idExistente: string | null): Promise<LinhaDaFala> {
  if (idExistente) {
    const { rows } = await db.query<LinhaDaFala>(
      `update phone_prompts
          set "text" = $3, voice_id = $4, model_id = $5, content_hash = $6, storage_path = $7,
              duration_ms = $8, status = $9, error = $10, updated_at = now()
        where id = $1 and organization_id = $2
        returning ${COLUNAS_DA_FALA}`,
      [idExistente, d.organizationId, d.texto, d.voiceId, d.modelId, d.hash, d.storagePath, d.duracaoMs, d.status, d.erro],
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await db.query<LinhaDaFala>(
    `insert into phone_prompts
       (organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status, error, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning ${COLUNAS_DA_FALA}`,
    [d.organizationId, d.tipo, d.texto, d.voiceId, d.modelId, d.hash, d.storagePath, d.duracaoMs, d.status, d.erro, d.userId],
  );
  return rows[0]!;
}

/** Apaga o objeto do Storage se nenhuma fala (desta organização — o caminho começa por ela) o usa mais. */
async function apagarSeOrfao(db: Queryable, armazem: PortaDoArmazem, caminho: string): Promise<void> {
  const { rows } = await db.query("select 1 from phone_prompts where storage_path = $1 limit 1", [caminho]);
  if (rows.length === 0) await armazem.apagar([caminho]).catch(() => undefined);
}

export async function gerarFala(p: PedidoDeFala): Promise<ResultadoDaFala> {
  const texto = p.texto.trim();
  if (!p.voz) return { ok: false, motivo: "sem_voz", fala: null };
  if (!p.chave) return { ok: false, motivo: "sem_chave", fala: null };
  const { voiceId, modelId } = p.voz;
  const hash = hashDaFala(texto, voiceId, modelId);
  const atual = p.falaAtualId ? await falaPorId(p.db, p.organizationId, p.falaAtualId) : null;
  if (atual && atual.content_hash === hash && atual.status === "ready") {
    return { ok: true, fala: falaPublica(atual), gerada: false };
  }
  const base = { organizationId: p.organizationId, userId: p.userId, tipo: p.tipo, texto, voiceId, modelId, hash };

  const falhar = async (motivo: FalhaDaFala): Promise<ResultadoDaFala> => {
    // O áudio que já existe continua tocando: uma falha ao EDITAR não apaga nada.
    if (atual?.status === "ready") return { ok: false, motivo, fala: falaPublica(atual) };
    const linha = await gravar(p.db, { ...base, storagePath: null, duracaoMs: null, status: "failed", erro: motivo }, atual?.id ?? null);
    return { ok: false, motivo, fala: falaPublica(linha) };
  };

  let bytes: Uint8Array;
  try {
    bytes = await p.sintetizar({ chave: p.chave, voiceId, modelId, texto });
  } catch (e) {
    return falhar(e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor");
  }
  const caminho = caminhoDaFala(p.organizationId, hash);
  try {
    await p.armazem.enviar(caminho, bytes);
  } catch {
    return falhar("armazenamento");
  }
  const pronta = await gravar(
    p.db,
    { ...base, storagePath: caminho, duracaoMs: Math.max(1, duracaoDoUlawMs(bytes.length)), status: "ready", erro: null },
    atual?.id ?? null,
  );
  if (atual?.storage_path && atual.storage_path !== caminho) await apagarSeOrfao(p.db, p.armazem, atual.storage_path);
  return { ok: true, fala: falaPublica(pronta), gerada: true };
}

/** Remove a fala (ex.: a de tecla inválida que o menu deixou de ter) e o arquivo, se órfão. */
export async function descartarFala(
  db: Queryable,
  armazem: PortaDoArmazem,
  organizationId: string,
  id: string,
): Promise<void> {
  const { rows } = await db.query<{ storage_path: string | null }>(
    "delete from phone_prompts where id = $1 and organization_id = $2 returning storage_path",
    [id, organizationId],
  );
  const caminho = rows[0]?.storage_path;
  if (caminho) await apagarSeOrfao(db, armazem, caminho);
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/falas.test.ts`
Expected: PASS (9 testes).

- [ ] **Step 6: A fiação completa da instalação**

Substitua o conteúdo inteiro de `lib/telefonia/servico-de-falas.ts` por:

```ts
/**
 * A FIAÇÃO DA INSTALAÇÃO para as rotas do telefone — o único lugar que lê o env
 * da ElevenLabs, monta o armazém com o cliente de serviço e decide o status HTTP
 * de cada falha. Server-only.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { armazemDoSupabase, type PortaDoArmazem } from "./armazem";
import { chaveDeVoz } from "./chave-elevenlabs";
import { sintetizar, type OpcoesDoCliente } from "./elevenlabs";
import { vozDaOrganizacao, type Sintetizador, type VozDaOrganizacao } from "./falas";
import type { FalhaDaFala } from "./vocabulario";

/** A URL base só muda no e2e (a ElevenLabs falsa de tests/e2e/telefonia-ura-e-falas.spec.ts). */
export function opcoesDaElevenLabs(): OpcoesDoCliente {
  return env.ELEVENLABS_API_BASE_URL ? { baseUrl: env.ELEVENLABS_API_BASE_URL } : {};
}

/**
 * 422 (a pessoa pode consertar) ou 502 (o provedor/Storage falhou) — NUNCA 429
 * ou 503: o `apiClient` do navegador repete esses sozinho, e cada repetição de
 * síntese gasta crédito da conta do cliente.
 */
export const STATUS_DA_FALHA: Record<FalhaDaFala, 422 | 502> = {
  sem_chave: 422,
  sem_voz: 422,
  chave_invalida: 422,
  sem_credito: 422,
  texto_recusado: 422,
  voz_inexistente: 422,
  limite_de_uso: 422,
  armazenamento: 502,
  sem_resposta: 502,
  erro_do_provedor: 502,
};

export function sintetizadorDaInstalacao(): Sintetizador {
  const opcoes = opcoesDaElevenLabs();
  return (p) => sintetizar(p, opcoes);
}

export function armazemDaInstalacao(): PortaDoArmazem {
  return armazemDoSupabase(createAdminClient());
}

/** A chave (decifrada) e a voz da organização — o que toda geração de fala precisa. */
export async function contextoDeFala(
  db: Queryable,
  organizationId: string,
): Promise<{ chave: string | null; voz: VozDaOrganizacao | null }> {
  const [chave, voz] = await Promise.all([chaveDeVoz(db, organizationId), vozDaOrganizacao(db, organizationId)]);
  return { chave, voz };
}
```

- [ ] **Step 7: Rodar o que depende dela e o typecheck**

Run: `pnpm exec vitest run lib/telefonia/ app/api/v1/telefonia/voz/chave/route.test.ts && pnpm typecheck`
Expected: PASS e `tsc` sem erro.

- [ ] **Step 8: Commit**

```bash
git add lib/telefonia/armazem.ts lib/telefonia/falas.ts lib/telefonia/falas.test.ts lib/telefonia/servico-de-falas.ts
git commit -m "feat(telefonia): gerar, regravar e descartar as falas do telefone

Cada fala é uma linha de phone_prompts e um μ-law no bucket privado, com hash de
modelo+voz+texto: o mesmo texto não é pago duas vezes, o arquivo antigo sai do
Storage quando ninguém mais o usa, e uma falha ao editar mantém o áudio que já
tocava.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Rotas de voz, falas gerais e áudio da fala

**Files:**
- Create: `app/api/v1/telefonia/voz/route.ts`
- Create: `app/api/v1/telefonia/voz/vozes/route.ts`
- Create: `app/api/v1/telefonia/falas/gerais/[tipo]/route.ts`, `app/api/v1/telefonia/falas/gerais/[tipo]/route.test.ts`
- Create: `app/api/v1/telefonia/falas/[id]/audio/route.ts`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste da rota da fala geral (falha: a rota não existe)**

Crie `app/api/v1/telefonia/falas/gerais/[tipo]/route.test.ts`:

```ts
/**
 * A FALA GERAL PELA ROTA: tipo fora da lista não existe, a fala gerada é ligada à
 * coluna certa de `phone_settings`, a falha da ElevenLabs volta como estado (com a
 * mensagem traduzida) e toda gravação é auditada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const estado = vi.hoisted(() => ({
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  resultado: null as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: vi.fn(() => ({
    query: async (sql: string, params: unknown[] = []) => {
      estado.consultas.push({ sql, params });
      if (/^\s*select/i.test(sql)) return { rows: [{ id: null }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  })),
}));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  STATUS_DA_FALHA: {
    sem_chave: 422, sem_voz: 422, chave_invalida: 422, sem_credito: 422, texto_recusado: 422,
    voz_inexistente: 422, limite_de_uso: 422, armazenamento: 502, sem_resposta: 502, erro_do_provedor: 502,
  },
  contextoDeFala: vi.fn(async () => ({ chave: "sk_x", voz: { voiceId: "v1", modelId: "eleven_multilingual_v2" } })),
  armazemDaInstalacao: vi.fn(() => ({})),
  sintetizadorDaInstalacao: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/telefonia/falas", async () => {
  const real = await vi.importActual<typeof import("@/lib/telefonia/falas")>("@/lib/telefonia/falas");
  return { ...real, gerarFala: vi.fn(async () => estado.resultado) };
});

import { audit } from "@/lib/audit";
import { gerarFala } from "@/lib/telefonia/falas";

import { PUT } from "./route";

const FALA = {
  id: "33333333-3333-4333-8333-333333333333",
  tipo: "waiting",
  texto: "Aguarde.",
  voice_id: "v1",
  status: "ready",
  erro: null,
  duracao_ms: 900,
  atualizada_em: "2026-09-28T13:00:00.000Z",
};
const chamar = (tipo: string, corpo: unknown = { texto: "Aguarde." }) =>
  PUT(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/falas/gerais/${tipo}`, { method: "PUT", body: JSON.stringify(corpo) }),
    { params: Promise.resolve({ tipo }) },
  );

beforeEach(() => {
  estado.consultas = [];
  estado.resultado = { ok: true, fala: FALA, gerada: true };
  vi.mocked(audit).mockClear();
  vi.mocked(gerarFala).mockClear();
});

describe("PUT /api/v1/telefonia/falas/gerais/[tipo]", () => {
  it("tipo que não é fala geral → 404, sem gerar nada", async () => {
    const r = await chamar("menu");
    expect(r.status).toBe(404);
    expect(gerarFala).not.toHaveBeenCalled();
  });

  it("gera e liga a fala à coluna do tipo em phone_settings, auditando", async () => {
    const r = await chamar("after_hours");
    expect(r.status).toBe(200);
    expect(vi.mocked(gerarFala).mock.calls[0]![0]).toMatchObject({ tipo: "after_hours", texto: "Aguarde.", organizationId: ORG });
    const update = estado.consultas.find((c) => /^\s*update phone_settings/i.test(c.sql))!;
    expect(update.sql).toMatch(/set after_hours_prompt_id = \$2/);
    expect(update.params).toEqual([ORG, FALA.id]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ action: "phone.prompt_saved", resourceId: FALA.id });
  });

  it("a ElevenLabs falhou mas há linha (failed ou o áudio antigo): 200 com a falha traduzida", async () => {
    estado.resultado = { ok: false, motivo: "sem_credito", fala: { ...FALA, status: "failed", erro: "sem_credito" } };
    const r = await chamar("waiting");
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { falha: { motivo: string; mensagem: string } } };
    expect(corpo.data.falha).toEqual({ motivo: "sem_credito", mensagem: expect.stringMatching(/sem crédito/) });
  });

  it("sem chave (nenhuma linha): 422, e nada é ligado", async () => {
    estado.resultado = { ok: false, motivo: "sem_chave", fala: null };
    const r = await chamar("nobody");
    expect(r.status).toBe(422);
    expect(estado.consultas.some((c) => /^\s*update/i.test(c.sql))).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run "app/api/v1/telefonia/falas/gerais/[tipo]/route.test.ts"`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: A rota da fala geral**

Crie `app/api/v1/telefonia/falas/gerais/[tipo]/route.ts`:

```ts
/**
 * PUT /api/v1/telefonia/falas/gerais/[tipo] — gera (ou regrava) uma fala geral da
 * organização: `waiting` (aguarde), `nobody` (ninguém atendeu) ou `after_hours`
 * (fora do horário). Admin.
 *
 * Desenho da fase 2, §4 e §6.2. A fala é gerada na ElevenLabs e ligada a
 * `phone_settings`. Falha da ElevenLabs com linha (a `failed` nova, ou o áudio
 * antigo que continua tocando) volta 200 com `falha` — a tela mostra o estado e a
 * mensagem; sem linha nenhuma (sem chave, sem voz), 422.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { COLUNA_DA_FALA_GERAL, gerarFala } from "@/lib/telefonia/falas";
import {
  STATUS_DA_FALHA,
  armazemDaInstalacao,
  contextoDeFala,
  sintetizadorDaInstalacao,
} from "@/lib/telefonia/servico-de-falas";
import {
  FALAS_GERAIS,
  MENSAGEM_DA_FALHA_DA_FALA,
  TAMANHO_MAXIMO_DA_FALA,
  type FalaGeral,
  type FalhaDaFala,
} from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const textoSchema = z.object({ texto: z.string().trim().min(1).max(TAMANHO_MAXIMO_DA_FALA) }).strict();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ tipo: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_falas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const tipoBruto = (await ctx.params).tipo;
  if (!(FALAS_GERAIS as readonly string[]).includes(tipoBruto)) {
    return fail("not_found", t("Fala não encontrada."), 404, { requestId });
  }
  const tipo = tipoBruto as FalaGeral;
  const parsed = textoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = getRequestPool();
  const org = authz.org.orgId;
  const coluna = COLUNA_DA_FALA_GERAL[tipo];
  const { chave, voz } = await contextoDeFala(db, org);
  const { rows } = await db.query<{ id: string | null }>(`select ${coluna} as id from phone_settings where organization_id = $1`, [org]);

  const r = await gerarFala({
    db,
    armazem: armazemDaInstalacao(),
    sintetizar: sintetizadorDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    tipo,
    texto: parsed.data.texto,
    falaAtualId: rows[0]?.id ?? null,
    chave,
    voz,
  });
  const fala = r.fala;
  if (!fala) {
    const motivo: FalhaDaFala = r.ok ? "erro_do_provedor" : r.motivo;
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }

  await db.query(`update phone_settings set ${coluna} = $2, updated_at = now() where organization_id = $1`, [org, fala.id]);
  void audit({
    action: "phone.prompt_saved",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_prompt",
    resourceId: fala.id,
    metadata: { tipo, status: fala.status, gerada: r.ok ? r.gerada : false, falha: r.ok ? null : r.motivo },
    requestId,
  });
  return ok(
    { fala, falha: r.ok ? null : { motivo: r.motivo, mensagem: t(MENSAGEM_DA_FALHA_DA_FALA[r.motivo]) } },
    { requestId },
  );
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run "app/api/v1/telefonia/falas/gerais/[tipo]/route.test.ts"`
Expected: PASS (4 testes).

- [ ] **Step 5: A rota da voz**

Crie `app/api/v1/telefonia/voz/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/voz — a voz e as falas gerais da organização (admin).
 * PUT /api/v1/telefonia/voz — escolhe a voz da ElevenLabs (admin).
 *
 * Desenho da fase 2, §6.2 (aba Voz e falas). Trocar a voz NÃO regrava as falas: o
 * hash de cada uma inclui a voz, e a tela mostra "pronta, com a voz anterior" até
 * a pessoa gerar de novo — regravar sozinho gastaria crédito sem ninguém pedir.
 * A voz é conferida contra as vozes da conta antes de gravar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { chaveDeVoz, estadoDaChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes } from "@/lib/telefonia/elevenlabs";
import { falasGeraisDaOrg, vozDaOrganizacao } from "@/lib/telefonia/falas";
import { STATUS_DA_FALHA, opcoesDaElevenLabs } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const vozSchema = z.object({ voice_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const db = getRequestPool();
  const org = authz.org.orgId;
  const [chave, voz, falas] = await Promise.all([
    estadoDaChaveDeVoz(db, org),
    vozDaOrganizacao(db, org),
    falasGeraisDaOrg(db, org),
  ]);
  return ok(
    {
      oferecida: configAriDoAmbiente() !== null,
      chave: { cadastrada: chave.cadastrada, last4: chave.last4 },
      voz: voz ? { voice_id: voz.voiceId, model_id: voz.modelId } : null,
      falas,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = vozSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = getRequestPool();
  const org = authz.org.orgId;
  const falhar = (motivo: FalhaDaFala) =>
    fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });

  const chave = await chaveDeVoz(db, org);
  if (!chave) return falhar("sem_chave");
  try {
    const vozes = await listarVozes(chave, opcoesDaElevenLabs());
    if (!vozes.some((v) => v.voice_id === parsed.data.voice_id)) return falhar("voz_inexistente");
  } catch (e) {
    return falhar(e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor");
  }

  const anterior = await vozDaOrganizacao(db, org);
  await db.query(
    `insert into phone_settings (organization_id, voice_id) values ($1, $2)
     on conflict (organization_id) do update set voice_id = excluded.voice_id, updated_at = now()`,
    [org, parsed.data.voice_id],
  );
  void audit({
    action: "phone.voice_changed",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_settings",
    resourceId: authz.org.orgId,
    metadata: { voice_id: parsed.data.voice_id, anterior: anterior?.voiceId ?? null },
    requestId,
  });
  return ok({ voice_id: parsed.data.voice_id }, { requestId });
}
```

Crie `app/api/v1/telefonia/voz/vozes/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/voz/vozes — as vozes da conta da ElevenLabs da organização (admin).
 *
 * A lista vem ao vivo da ElevenLabs (com a amostra pública de cada voz, para o
 * "Ouvir amostra"); nada é copiado para o banco — o nome de uma voz é da conta
 * do cliente, e muda lá.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { chaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes } from "@/lib/telefonia/elevenlabs";
import { STATUS_DA_FALHA, opcoesDaElevenLabs } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const chave = await chaveDeVoz(getRequestPool(), authz.org.orgId);
  if (!chave) return fail("sem_chave", t(MENSAGEM_DA_FALHA_DA_FALA.sem_chave), 422, { requestId });
  try {
    return ok({ vozes: await listarVozes(chave, opcoesDaElevenLabs()) }, { requestId });
  } catch (e) {
    const motivo: FalhaDaFala = e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor";
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }
}
```

- [ ] **Step 6: A rota do áudio da fala**

Crie `app/api/v1/telefonia/falas/[id]/audio/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/falas/[id]/audio — os bytes μ-law de uma fala pronta, para
 * a tela OUVIR (membro da organização).
 *
 * O bucket é privado: a tela nunca recebe URL do Storage. Esta rota confere que a
 * fala é da organização da sessão, baixa com o cliente de serviço e devolve
 * `audio/basic`; o navegador converte em WAV (`ulawParaWav`). Uma chamada só, sem
 * custo na ElevenLabs. Leitura não audita.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { falaPorId } from "@/lib/telefonia/falas";
import { armazemDaInstalacao } from "@/lib/telefonia/servico-de-falas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_falas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Fala não encontrada."), 404, { requestId });
  const fala = await falaPorId(getRequestPool(), authz.org.orgId, id.data);
  if (!fala || fala.status !== "ready" || !fala.storage_path) {
    return fail("not_found", t("Fala não encontrada."), 404, { requestId });
  }
  const bytes = await armazemDaInstalacao().baixar(fala.storage_path);
  if (!bytes) return fail("audio_indisponivel", t("O áudio desta fala não está disponível agora."), 502, { requestId });
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "audio/basic", "Cache-Control": "private, max-age=300", "X-Request-Id": requestId },
  });
}
```

- [ ] **Step 7: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Fala não encontrada.": { es: "Locución no encontrada." },
  "O áudio desta fala não está disponível agora.": { es: "El audio de esta locución no está disponible ahora." },
```

- [ ] **Step 8: Rodar, typecheck e lints**

Run: `pnpm exec vitest run "app/api/v1/telefonia/" tests/unit/audit-resource-id-e-uuid.test.ts && pnpm typecheck && pnpm lint:role-rank && pnpm lint:channels`
Expected: PASS; `tsc` e os dois lints sem erro.

- [ ] **Step 9: Commit**

```bash
git add app/api/v1/telefonia/voz/route.ts app/api/v1/telefonia/voz/vozes/route.ts \
  "app/api/v1/telefonia/falas/gerais/[tipo]/route.ts" "app/api/v1/telefonia/falas/gerais/[tipo]/route.test.ts" \
  "app/api/v1/telefonia/falas/[id]/audio/route.ts" lib/i18n/dicionario.ts
git commit -m "feat(telefonia): rotas da voz, das falas gerais e do áudio da fala

A voz da organização (conferida contra a conta da ElevenLabs), as falas de
aguarde, ninguém atendeu e fora do horário, e o μ-law de cada fala para a tela
ouvir — o bucket segue privado.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Menus de voz — leitura com "últimos 7 dias", gravação em transação, rotas

**Files:**
- Create: `lib/telefonia/menus.ts`, `lib/telefonia/menus.test.ts`
- Create: `app/api/v1/telefonia/menus/_salvar.ts`
- Create: `app/api/v1/telefonia/menus/route.ts`, `app/api/v1/telefonia/menus/route.test.ts`
- Create: `app/api/v1/telefonia/menus/[id]/route.ts`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste da camada de menus (falha: o módulo não existe)**

Crie `lib/telefonia/menus.test.ts`:

```ts
// @vitest-environment node
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { arquivarMenu, gravarMenu, menuSchema, situacaoDoMenuParaNumero, teclaRepetida } from "./menus";

const TIME = "44444444-4444-4444-8444-444444444444";
const valido = {
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME }],
  time_padrao_id: TIME,
  texto_menu: "Para Suporte, digite 1.",
  texto_invalida: "",
};

function dbCom(linhas: Record<string, unknown>[]) {
  const consultas: string[] = [];
  const db: Queryable = {
    query: (async (sql: string) => {
      consultas.push(sql);
      return { rows: /^\s*update/i.test(sql) ? [] : linhas, rowCount: linhas.length };
    }) as unknown as Queryable["query"],
  };
  return { db, consultas };
}

function poolFalso(respostas: { update?: Array<{ id: string }> } = {}) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  let liberado = false;
  const cliente = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/^\s*insert into phone_menus/i.test(sql)) return { rows: [{ id: "menu-novo" }], rowCount: 1 };
      if (/^\s*update phone_menus/i.test(sql)) return { rows: respostas.update ?? [{ id: "menu-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      liberado = true;
    },
  };
  const pool = { connect: async () => cliente } as unknown as pg.Pool;
  return { pool, consultas, liberado: () => liberado };
}

describe("menuSchema", () => {
  it("aceita o menu válido e trata fala de inválida vazia como ausente", () => {
    const r = menuSchema.parse(valido);
    expect(r.texto_invalida).toBeNull();
  });

  it.each([
    ["tecla reservada", { ...valido, opcoes: [{ tecla: "*", time_id: TIME }] }],
    ["sem opção", { ...valido, opcoes: [] }],
    ["campo que não existe", { ...valido, aceita_ramal: true }],
    ["fala vazia", { ...valido, texto_menu: "  " }],
    ["mais de 10 opções", { ...valido, opcoes: Array.from({ length: 11 }, () => ({ tecla: "1", time_id: TIME })) }],
  ])("recusa: %s", (_caso, entrada) => {
    expect(menuSchema.safeParse(entrada).success).toBe(false);
  });
});

describe("teclaRepetida", () => {
  it("a mesma tecla para dois times é repetida", () => {
    expect(teclaRepetida([{ tecla: "1" }, { tecla: "1" }])).toBe(true);
    expect(teclaRepetida([{ tecla: "1" }, { tecla: "2" }])).toBe(false);
  });
});

describe("gravarMenu — menu e opções numa transação só", () => {
  it("menu novo: begin, insere, grava as opções pelo JSON e faz commit", async () => {
    const { pool, consultas, liberado } = poolFalso();
    const id = await gravarMenu(pool, {
      organizationId: "org-1",
      id: null,
      entrada: menuSchema.parse(valido),
      falaId: "fala-1",
      falaInvalidaId: null,
    });
    expect(id).toBe("menu-novo");
    expect(consultas.map((c) => c.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "insert into phone_menus",
      "insert into phone_menu_options",
      "commit",
    ]);
    expect(consultas[2]!.params).toEqual(["org-1", "menu-novo", JSON.stringify([{ tecla: "1", time_id: TIME }])]);
    expect(liberado()).toBe(true);
  });

  it("editar menu de outra organização (ou arquivado): rollback, nada de opções, null", async () => {
    const { pool, consultas } = poolFalso({ update: [] });
    const id = await gravarMenu(pool, {
      organizationId: "org-1",
      id: "menu-x",
      entrada: menuSchema.parse(valido),
      falaId: null,
      falaInvalidaId: null,
    });
    expect(id).toBeNull();
    expect(consultas.map((c) => c.sql.split(" ")[0])).toEqual(["begin", "update", "rollback"]);
  });
});

describe("situacaoDoMenuParaNumero", () => {
  it("inexistente, pendente ou pronto", async () => {
    expect(await situacaoDoMenuParaNumero(dbCom([]).db, "org-1", "m")).toBe("inexistente");
    expect(await situacaoDoMenuParaNumero(dbCom([{ pronto: false }]).db, "org-1", "m")).toBe("pendente");
    expect(await situacaoDoMenuParaNumero(dbCom([{ pronto: true }]).db, "org-1", "m")).toBe("pronto");
  });
});

describe("arquivarMenu", () => {
  it("menu que atende um número não é arquivado", async () => {
    const { db, consultas } = dbCom([{ em_uso: true }]);
    expect(await arquivarMenu(db, "org-1", "m")).toBe("menu_em_uso");
    expect(consultas.some((s) => /^\s*update/i.test(s))).toBe(false);
  });

  it("menu livre é arquivado; inexistente é 'nao_encontrado'", async () => {
    const livre = dbCom([{ em_uso: false }]);
    expect(await arquivarMenu(livre.db, "org-1", "m")).toBe("ok");
    expect(livre.consultas.some((s) => /^\s*update phone_menus/i.test(s))).toBe(true);
    expect(await arquivarMenu(dbCom([]).db, "org-1", "m")).toBe("nao_encontrado");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/telefonia/menus.test.ts`
Expected: FAIL — `Failed to resolve import "./menus"`.

- [ ] **Step 3: Implementar**

Crie `lib/telefonia/menus.ts`:

```ts
/**
 * OS MENUS DE VOZ (URA) DA ORGANIZAÇÃO — leitura, gravação e arquivamento
 * (desenho da fase 2, D2, §3.1 e §6.2). Server-only.
 *
 * O menu é da ORGANIZAÇÃO e serve a vários números. As opções levam a times da
 * mesma organização — a FK composta do banco é a catraca; `timesValidos` é a
 * mensagem boa antes dela. Um número só aponta para um menu com a fala pronta
 * (`situacaoDoMenuParaNumero`), e um menu que atende um número não é arquivado.
 */
import type pg from "pg";
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { somarUltimosSeteDias, type LinhaDoMenuNaSemana } from "./ultimos-sete-dias";
import { TAMANHO_MAXIMO_DA_FALA, type FalaPublica, type MenuPublico, type OpcaoDoMenuPublica } from "./vocabulario";

export const menuSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    opcoes: z
      .array(z.object({ tecla: z.string().regex(/^[0-9]$/), time_id: z.string().uuid() }).strict())
      .min(1)
      .max(10),
    time_padrao_id: z.string().uuid(),
    texto_menu: z.string().trim().min(1).max(TAMANHO_MAXIMO_DA_FALA),
    // Vazio = o menu não tem fala de tecla inválida (a URA só repete o menu).
    texto_invalida: z
      .string()
      .trim()
      .max(TAMANHO_MAXIMO_DA_FALA)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .strict();

export type EntradaDoMenu = z.infer<typeof menuSchema>;

export type FalhaDoMenu = "tecla_repetida" | "time_invalido" | "nao_encontrado" | "menu_em_uso";

export const MENSAGEM_DA_FALHA_DO_MENU: Record<FalhaDoMenu, string> = {
  tecla_repetida: "Cada tecla só pode levar a um time.",
  time_invalido: "Algum time escolhido não existe nesta organização ou está arquivado.",
  nao_encontrado: "Menu não encontrado.",
  menu_em_uso: "Este menu atende um número. Troque o destino do número antes de arquivar.",
};

export function teclaRepetida(opcoes: ReadonlyArray<{ tecla: string }>): boolean {
  return new Set(opcoes.map((o) => o.tecla)).size !== opcoes.length;
}

export async function timesValidos(db: Queryable, organizationId: string, ids: readonly string[]): Promise<boolean> {
  const unicos = [...new Set(ids)];
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from attendance_teams
      where organization_id = $1 and id = any($2::uuid[]) and archived_at is null`,
    [organizationId, unicos],
  );
  return (rows[0]?.n ?? 0) === unicos.length;
}

export async function menuDaOrg(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<{ id: string; prompt_id: string | null; invalid_prompt_id: string | null } | null> {
  const { rows } = await db.query<{ id: string; prompt_id: string | null; invalid_prompt_id: string | null }>(
    "select id, prompt_id, invalid_prompt_id from phone_menus where id = $1 and organization_id = $2 and archived_at is null",
    [id, organizationId],
  );
  return rows[0] ?? null;
}

/** Menu + opções numa transação: a URA nunca lê um menu com metade das opções. `null` = menu não achado. */
export async function gravarMenu(
  pool: pg.Pool,
  p: { organizationId: string; id: string | null; entrada: EntradaDoMenu; falaId: string | null; falaInvalidaId: string | null },
): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    let id = p.id;
    if (id) {
      const r = await c.query<{ id: string }>(
        `update phone_menus
            set name = $3, default_team_id = $4, prompt_id = $5, invalid_prompt_id = $6, updated_at = now()
          where id = $1 and organization_id = $2 and archived_at is null
          returning id`,
        [id, p.organizationId, p.entrada.nome, p.entrada.time_padrao_id, p.falaId, p.falaInvalidaId],
      );
      if (!r.rows[0]) {
        await c.query("rollback");
        return null;
      }
      await c.query("delete from phone_menu_options where menu_id = $1 and organization_id = $2", [id, p.organizationId]);
    } else {
      const r = await c.query<{ id: string }>(
        `insert into phone_menus (organization_id, name, default_team_id, prompt_id, invalid_prompt_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [p.organizationId, p.entrada.nome, p.entrada.time_padrao_id, p.falaId, p.falaInvalidaId],
      );
      id = r.rows[0]!.id;
    }
    await c.query(
      `insert into phone_menu_options (organization_id, menu_id, digit, team_id)
       select $1, $2, x.tecla, x.time_id from jsonb_to_recordset($3::jsonb) as x(tecla text, time_id uuid)`,
      [p.organizationId, id, JSON.stringify(p.entrada.opcoes)],
    );
    await c.query("commit");
    return id;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const falaJson = (a: string) => `case when ${a}.id is null then null else jsonb_build_object(
  'id', ${a}.id, 'tipo', ${a}.kind, 'texto', ${a}."text", 'voice_id', ${a}.voice_id, 'status', ${a}.status,
  'erro', ${a}.error, 'duracao_ms', ${a}.duration_ms, 'atualizada_em', ${a}.updated_at) end`;

interface LinhaDoMenu {
  id: string;
  nome: string;
  time_padrao_id: string;
  time_padrao_nome: string;
  opcoes: OpcaoDoMenuPublica[];
  fala: FalaPublica | null;
  fala_invalida: FalaPublica | null;
  numeros: string[];
}

export async function menusDaOrg(db: Queryable, organizationId: string): Promise<MenuPublico[]> {
  const { rows } = await db.query<LinhaDoMenu>(
    `select m.id, m.name as nome, m.default_team_id as time_padrao_id, dt.name as time_padrao_nome,
            coalesce((select jsonb_agg(jsonb_build_object('tecla', o.digit, 'time_id', o.team_id, 'time_nome', t.name)
                                       order by o.digit)
                        from phone_menu_options o
                        join attendance_teams t on t.id = o.team_id and t.organization_id = o.organization_id
                       where o.menu_id = m.id and o.organization_id = m.organization_id), '[]'::jsonb) as opcoes,
            ${falaJson("p")} as fala,
            ${falaJson("i")} as fala_invalida,
            coalesce((select jsonb_agg(coalesce(c.display_name, c.phone_number) order by c.created_at)
                        from channel_sessions c
                       where c.organization_id = m.organization_id and c.sip_menu_id = m.id
                         and c.archived_at is null), '[]'::jsonb) as numeros
       from phone_menus m
       join attendance_teams dt on dt.id = m.default_team_id and dt.organization_id = m.organization_id
       left join phone_prompts p on p.id = m.prompt_id and p.organization_id = m.organization_id
       left join phone_prompts i on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id
      where m.organization_id = $1 and m.archived_at is null
      order by m.created_at`,
    [organizationId],
  );
  if (rows.length === 0) return [];
  const { rows: semana } = await db.query<LinhaDoMenuNaSemana & { menu_id: string }>(
    `select menu_id, menu_outcome, menu_digit, count(*)::int as n
       from voice_calls
      where organization_id = $1 and menu_id = any($2::uuid[]) and started_at >= now() - interval '7 days'
      group by menu_id, menu_outcome, menu_digit`,
    [organizationId, rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    ...r,
    pronto: r.fala?.status === "ready" && (!r.fala_invalida || r.fala_invalida.status === "ready"),
    ultimos_7_dias: somarUltimosSeteDias(semana.filter((s) => s.menu_id === r.id)),
  }));
}

export async function arquivarMenu(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<"ok" | "nao_encontrado" | "menu_em_uso"> {
  const { rows } = await db.query<{ em_uso: boolean }>(
    `select exists (select 1 from channel_sessions c
                     where c.sip_menu_id = m.id and c.organization_id = m.organization_id and c.archived_at is null) as em_uso
       from phone_menus m
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [id, organizationId],
  );
  if (!rows[0]) return "nao_encontrado";
  if (rows[0].em_uso) return "menu_em_uso";
  await db.query(
    "update phone_menus set archived_at = now(), updated_at = now() where id = $1 and organization_id = $2 and archived_at is null",
    [id, organizationId],
  );
  return "ok";
}

/** Um número só toca um menu desta organização, não arquivado, com a fala (e a de inválida, se houver) pronta. */
export async function situacaoDoMenuParaNumero(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<"pronto" | "pendente" | "inexistente"> {
  const { rows } = await db.query<{ pronto: boolean }>(
    `select coalesce(p.status = 'ready' and (m.invalid_prompt_id is null or i.status = 'ready'), false) as pronto
       from phone_menus m
       left join phone_prompts p on p.id = m.prompt_id and p.organization_id = m.organization_id
       left join phone_prompts i on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [id, organizationId],
  );
  if (!rows[0]) return "inexistente";
  return rows[0].pronto ? "pronto" : "pendente";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/telefonia/menus.test.ts`
Expected: PASS (12 testes).

- [ ] **Step 5: Teste da rota POST (falha: a rota não existe)**

Crie `app/api/v1/telefonia/menus/route.test.ts`:

```ts
/**
 * SALVAR UM MENU DE VOZ: validação antes de gastar crédito, fala gerada e ligada
 * ao menu, falha da ElevenLabs que não perde o menu, e auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TIME = "44444444-4444-4444-8444-444444444444";
const estado = vi.hoisted(() => ({
  timesOk: true,
  contexto: { chave: "sk_x" as string | null, voz: { voiceId: "v1", modelId: "eleven_multilingual_v2" } as unknown },
  resultado: null as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => ({ baseUrl: "http://a", senha: "x" })) }));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  STATUS_DA_FALHA: {
    sem_chave: 422, sem_voz: 422, chave_invalida: 422, sem_credito: 422, texto_recusado: 422,
    voz_inexistente: 422, limite_de_uso: 422, armazenamento: 502, sem_resposta: 502, erro_do_provedor: 502,
  },
  contextoDeFala: vi.fn(async () => estado.contexto),
  armazemDaInstalacao: vi.fn(() => ({})),
  sintetizadorDaInstalacao: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/telefonia/falas", () => ({
  gerarFala: vi.fn(async () => estado.resultado),
  descartarFala: vi.fn(async () => undefined),
}));
vi.mock("@/lib/telefonia/menus", async () => {
  const real = await vi.importActual<typeof import("@/lib/telefonia/menus")>("@/lib/telefonia/menus");
  return {
    ...real,
    timesValidos: vi.fn(async () => estado.timesOk),
    menuDaOrg: vi.fn(async () => null),
    gravarMenu: vi.fn(async () => "55555555-5555-4555-8555-555555555555"),
    menusDaOrg: vi.fn(async () => [{ id: "55555555-5555-4555-8555-555555555555", nome: "Principal" }]),
  };
});

import { audit } from "@/lib/audit";
import { gerarFala } from "@/lib/telefonia/falas";
import { gravarMenu } from "@/lib/telefonia/menus";

import { POST } from "./route";

const FALA = { id: "66666666-6666-4666-8666-666666666666", tipo: "menu", status: "ready" };
const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME }],
  time_padrao_id: TIME,
  texto_menu: "Para Suporte, digite 1.",
  ...extra,
});
const post = (c: unknown) =>
  POST(new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/menus", { method: "POST", body: JSON.stringify(c) }));

beforeEach(() => {
  estado.timesOk = true;
  estado.contexto = { chave: "sk_x", voz: { voiceId: "v1", modelId: "eleven_multilingual_v2" } };
  estado.resultado = { ok: true, fala: FALA, gerada: true };
  vi.mocked(audit).mockClear();
  vi.mocked(gerarFala).mockClear();
  vi.mocked(gravarMenu).mockClear();
});

describe("POST /api/v1/telefonia/menus", () => {
  it("a mesma tecla para dois times → 422, sem gastar crédito", async () => {
    const r = await post(corpo({ opcoes: [{ tecla: "1", time_id: TIME }, { tecla: "1", time_id: TIME }] }));
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("tecla_repetida");
    expect(gerarFala).not.toHaveBeenCalled();
  });

  it("time de outra organização → 422 time_invalido", async () => {
    estado.timesOk = false;
    const r = await post(corpo());
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("time_invalido");
    expect(gerarFala).not.toHaveBeenCalled();
  });

  it("sem a chave da ElevenLabs → 422 sem_chave, sem gravar menu", async () => {
    estado.contexto = { chave: null, voz: null };
    const r = await post(corpo());
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("sem_chave");
    expect(gravarMenu).not.toHaveBeenCalled();
  });

  it("sucesso: gera a fala, liga ao menu e audita o menu e a fala", async () => {
    const r = await post(corpo());
    expect(r.status).toBe(201);
    expect(vi.mocked(gravarMenu).mock.calls[0]![1]).toMatchObject({ id: null, falaId: FALA.id, falaInvalidaId: null });
    const acoes = vi.mocked(audit).mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(expect.arrayContaining(["phone.menu_saved", "phone.prompt_saved"]));
  });

  it("a ElevenLabs falhou: o menu é salvo com a fala 'failed' e a resposta traz a falha", async () => {
    estado.resultado = { ok: false, motivo: "texto_recusado", fala: { ...FALA, status: "failed" } };
    const r = await post(corpo());
    expect(r.status).toBe(201);
    const json = (await r.json()) as { data: { falha: { motivo: string } } };
    expect(json.data.falha.motivo).toBe("texto_recusado");
    expect(vi.mocked(gravarMenu).mock.calls[0]![1]).toMatchObject({ falaId: FALA.id });
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `pnpm exec vitest run app/api/v1/telefonia/menus/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 7: O miolo comum e as rotas**

Crie `app/api/v1/telefonia/menus/_salvar.ts`:

```ts
/**
 * O miolo de POST (cria) e PATCH (edita) de um menu de voz — a mesma sequência
 * nos dois: validar ANTES de gastar crédito, gerar as falas na ElevenLabs, gravar
 * menu + opções numa transação, auditar. Uma falha da ElevenLabs NÃO perde o
 * menu: ele é salvo com a fala `failed` (e não pode ser ligado a número até ficar
 * pronta), e a resposta traz `falha` para a tela dizer o porquê.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { descartarFala, gerarFala, type ResultadoDaFala } from "@/lib/telefonia/falas";
import {
  MENSAGEM_DA_FALHA_DO_MENU,
  gravarMenu,
  menuDaOrg,
  menuSchema,
  menusDaOrg,
  teclaRepetida,
  timesValidos,
} from "@/lib/telefonia/menus";
import {
  STATUS_DA_FALHA,
  armazemDaInstalacao,
  contextoDeFala,
  sintetizadorDaInstalacao,
} from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export async function salvarMenu(req: NextRequest, idDoMenu: string | null): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = menuSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const e = parsed.data;
  const org = authz.org.orgId;
  const pool = getRequestPool();

  if (teclaRepetida(e.opcoes)) {
    return fail("tecla_repetida", t(MENSAGEM_DA_FALHA_DO_MENU.tecla_repetida), 422, { requestId });
  }
  if (!(await timesValidos(pool, org, [...e.opcoes.map((o) => o.time_id), e.time_padrao_id]))) {
    return fail("time_invalido", t(MENSAGEM_DA_FALHA_DO_MENU.time_invalido), 422, { requestId });
  }
  const atual = idDoMenu ? await menuDaOrg(pool, org, idDoMenu) : null;
  if (idDoMenu && !atual) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });

  const { chave, voz } = await contextoDeFala(pool, org);
  if (!chave || !voz) {
    const motivo: FalhaDaFala = !chave ? "sem_chave" : "sem_voz";
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }

  const armazem = armazemDaInstalacao();
  const base = { db: pool, armazem, sintetizar: sintetizadorDaInstalacao(), organizationId: org, userId: authz.user.id, chave, voz };
  const fala = await gerarFala({ ...base, tipo: "menu", texto: e.texto_menu, falaAtualId: atual?.prompt_id ?? null });
  const invalida = e.texto_invalida
    ? await gerarFala({ ...base, tipo: "invalid", texto: e.texto_invalida, falaAtualId: atual?.invalid_prompt_id ?? null })
    : null;

  const menuId = await gravarMenu(pool, {
    organizationId: org,
    id: idDoMenu,
    entrada: e,
    falaId: fala.fala?.id ?? atual?.prompt_id ?? null,
    falaInvalidaId: e.texto_invalida ? (invalida?.fala?.id ?? atual?.invalid_prompt_id ?? null) : null,
  });
  if (!menuId) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
  if (!e.texto_invalida && atual?.invalid_prompt_id) await descartarFala(pool, armazem, org, atual.invalid_prompt_id);

  void audit({
    action: "phone.menu_saved",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_menu",
    resourceId: menuId,
    metadata: { novo: !idDoMenu, nome: e.nome, opcoes: e.opcoes, time_padrao_id: e.time_padrao_id, com_fala_invalida: Boolean(e.texto_invalida) },
    requestId,
  });
  for (const r of [fala, invalida]) {
    if (!r?.fala) continue;
    void audit({
      action: "phone.prompt_saved",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: r.fala.id,
      metadata: { tipo: r.fala.tipo, status: r.fala.status, gerada: r.ok ? r.gerada : false, falha: r.ok ? null : r.motivo, menu_id: menuId },
      requestId,
    });
  }

  const falhou = [fala, invalida].find(
    (r): r is Extract<ResultadoDaFala, { ok: false }> => r !== null && !r.ok,
  );
  const menus = await menusDaOrg(pool, org);
  return ok(
    {
      menu: menus.find((m) => m.id === menuId) ?? null,
      falha: falhou ? { motivo: falhou.motivo, mensagem: t(MENSAGEM_DA_FALHA_DA_FALA[falhou.motivo]) } : null,
    },
    { requestId, status: idDoMenu ? 200 : 201 },
  );
}
```

Crie `app/api/v1/telefonia/menus/route.ts`:

```ts
/**
 * GET  /api/v1/telefonia/menus — os menus de voz da organização, com o "últimos 7 dias" (admin).
 * POST /api/v1/telefonia/menus — cria um menu e gera a fala dele (admin).
 *
 * Desenho da fase 2, §6.2 (aba Menus). O miolo do POST mora em `_salvar.ts`,
 * igual ao do PATCH.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { menusDaOrg } from "@/lib/telefonia/menus";

import { salvarMenu } from "./_salvar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  return ok(
    { oferecida: configAriDoAmbiente() !== null, menus: await menusDaOrg(getRequestPool(), authz.org.orgId) },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  return salvarMenu(req, null);
}
```

Crie `app/api/v1/telefonia/menus/[id]/route.ts`:

```ts
/**
 * PATCH  /api/v1/telefonia/menus/[id] — edita o menu (opções, time padrão, falas) (admin).
 * DELETE /api/v1/telefonia/menus/[id] — arquiva o menu (admin). Recusado (409)
 *        enquanto algum número o toca: arquivar calaria a URA daquele número.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MENSAGEM_DA_FALHA_DO_MENU, arquivarMenu } from "@/lib/telefonia/menus";

import { salvarMenu } from "../_salvar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", "Menu não encontrado.", 404);
  return salvarMenu(req, id.data);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
  const menuId = id.data;
  const r = await arquivarMenu(getRequestPool(), authz.org.orgId, menuId);
  if (r === "nao_encontrado") return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
  if (r === "menu_em_uso") return fail("menu_em_uso", t(MENSAGEM_DA_FALHA_DO_MENU.menu_em_uso), 409, { requestId });

  void audit({
    action: "phone.menu_archived",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "phone_menu",
    resourceId: menuId,
    metadata: {},
    requestId,
  });
  return ok({ arquivado: true }, { requestId });
}
```

- [ ] **Step 8: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Cada tecla só pode levar a um time.": { es: "Cada tecla solo puede llevar a un equipo." },
  "Algum time escolhido não existe nesta organização ou está arquivado.": {
    es: "Algún equipo elegido no existe en esta organización o está archivado.",
  },
  "Menu não encontrado.": { es: "Menú no encontrado." },
  "Este menu atende um número. Troque o destino do número antes de arquivar.": {
    es: "Este menú atiende un número. Cambia el destino del número antes de archivar.",
  },
```

- [ ] **Step 9: Rodar, typecheck e lints**

Run: `pnpm exec vitest run app/api/v1/telefonia/menus/route.test.ts lib/telefonia/menus.test.ts tests/unit/audit-resource-id-e-uuid.test.ts && pnpm typecheck && pnpm lint:role-rank && pnpm lint:channels`
Expected: PASS (5 + 12 testes e o gate de auditoria); `tsc` e lints sem erro.

- [ ] **Step 10: Commit**

```bash
git add lib/telefonia/menus.ts lib/telefonia/menus.test.ts app/api/v1/telefonia/menus/_salvar.ts \
  app/api/v1/telefonia/menus/route.ts app/api/v1/telefonia/menus/route.test.ts "app/api/v1/telefonia/menus/[id]/route.ts" \
  lib/i18n/dicionario.ts
git commit -m "feat(telefonia): menus de voz da organização, com a fala gerada e os últimos 7 dias

Tecla → time, time padrão e as falas do menu e de tecla inválida, gravados numa
transação; validação antes de gastar crédito; falha da ElevenLabs não perde o
menu; menu que atende um número não é arquivado.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: O número aponta para um time OU um menu

**Files:**
- Modify: `lib/channels/telefonia/numeros.ts` (schema linha 44; `NumeroPublico` 64–79; `numerosDaOrg` 81–94; `FalhaDoCadastro` 96–103; `criarNumero` 134–172; `atualizarNumero` 198–258; `MENSAGEM_DA_FALHA` 275–284)
- Modify: `lib/channels/telefonia/numeros.test.ts` (acrescentar um `describe` no fim)
- Modify: `app/api/v1/telefonia/numeros/route.ts` (metadata do audit), `app/api/v1/telefonia/numeros/[id]/route.ts` (PATCH)
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Testes que falham**

Acrescente ao FIM de `lib/channels/telefonia/numeros.test.ts`:

```ts
describe("destino do número: time OU menu (fase 2)", () => {
  const MENU = "33333333-3333-4333-8333-333333333333";
  const TIME = "44444444-4444-4444-8444-444444444444";

  function bancoComMenu(situacao: "pronto" | "pendente" | "inexistente") {
    const consultas: Consulta[] = [];
    const db: Queryable = {
      query: (async (sql: string, params: unknown[] = []) => {
        consultas.push({ sql, params });
        if (/from phone_menus/.test(sql)) {
          return situacao === "inexistente" ? { rows: [], rowCount: 0 } : { rows: [{ pronto: situacao === "pronto" }], rowCount: 1 };
        }
        if (/from attendance_teams/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        if (/^\s*select/i.test(sql) && /from channel_sessions/.test(sql)) return { rows: [GUARDADA], rowCount: 1 };
        if (/^\s*update channel_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
        throw new Error(`consulta inesperada: ${sql}`);
      }) as unknown as Queryable["query"],
    };
    return { db, updates: () => consultas.filter((c) => /^\s*update channel_sessions/i.test(c.sql)) };
  }

  it("time E menu ao mesmo tempo é recusado, sem escrita", async () => {
    const { db, updates } = bancoComMenu("pronto");
    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ time_id: TIME, menu_id: MENU }));
    expect(r).toEqual({ ok: false, motivo: "destino_duplo" });
    expect(updates()).toHaveLength(0);
  });

  it("menu com a fala pendente não é aceito", async () => {
    const { db, updates } = bancoComMenu("pendente");
    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: false, motivo: "menu_com_fala_pendente" });
    expect(updates()).toHaveLength(0);
  });

  it("menu de outra organização (ou arquivado) é recusado", async () => {
    const { db } = bancoComMenu("inexistente");
    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: false, motivo: "menu_invalido" });
  });

  it("menu pronto: o UPDATE grava o menu ($15) e sabe que ele veio ($14)", async () => {
    const { db, updates } = bancoComMenu("pronto");
    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: true });
    expect(updates()[0]!.params[13]).toBe(true);
    expect(updates()[0]!.params[14]).toBe(MENU);
  });

  it("escolher um TIME sem mandar menu_id tira o menu guardado (a regra mora no UPDATE)", async () => {
    const { db, updates } = bancoComMenu("pronto");
    await atualizarNumero(db, ORG, NUMERO, entrada({ time_id: TIME }));
    expect(updates()[0]!.params[13]).toBe(false);
    expect(updates()[0]!.sql).toMatch(/when \$10::uuid is not null then null/);
  });

  it("as mensagens novas existem", () => {
    expect(MENSAGEM_DA_FALHA.menu_com_fala_pendente).toMatch(/ainda não está pronta/);
    expect(MENSAGEM_DA_FALHA.destino_duplo).toMatch(/um time ou um menu/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/numeros.test.ts`
Expected: FAIL — `menu_id` é recusado pelo `.strict()` do schema (`Unrecognized key`), e `destino_duplo` não existe.

- [ ] **Step 3: Implementar em `numeros.ts`**

1. No topo, logo depois de `import { numeroParaLigar } from "@/lib/telefonia/numero";`, acrescente:

```ts
import { situacaoDoMenuParaNumero } from "@/lib/telefonia/menus";
```

2. No `numeroSchema`, logo depois da linha `    time_id: z.string().uuid().nullable().default(null),`, acrescente:

```ts
    // O MENU de voz que atende as ligações deste número (fase 2). Excludente com
    // `time_id`. AUSENTE (`undefined`) = manter o guardado, pela mesma razão do
    // prefixo: uma aba aberta antes da atualização não pode apagar o menu.
    menu_id: z.string().uuid().nullable().optional(),
```

3. Em `NumeroPublico`, logo depois de `  time_nome: string | null;`, acrescente:

```ts
  /** O menu de voz que atende este número (excludente com `time_id`). */
  menu_id: string | null;
  menu_nome: string | null;
```

4. Em `numerosDaOrg`, troque o SELECT inteiro por:

```ts
  const { rows } = await db.query<NumeroPublico>(
    `select c.id, c.display_name as nome, c.phone_number as numero, c.sip_server as servidor,
            coalesce(c.sip_port, 5060) as porta, coalesce(c.sip_transport, 'udp') as transporte,
            c.sip_username as usuario, c.sip_dial_prefix as prefixo, c.sip_team_id as time_id, t.name as time_nome,
            c.sip_menu_id as menu_id, pm.name as menu_nome,
            c.status, c.status_reason, c.created_at
       from channel_sessions c
       left join attendance_teams t on t.id = c.sip_team_id and t.organization_id = c.organization_id
       left join phone_menus pm on pm.id = c.sip_menu_id and pm.organization_id = c.organization_id
      where c.organization_id = $1 and c.provider = $2 and c.archived_at is null
      order by c.created_at asc`,
    [organizationId, PROVIDER],
  );
```

5. Troque o tipo `FalhaDoCadastro` por:

```ts
export type FalhaDoCadastro =
  | "numero_invalido"
  | "time_invalido"
  | "senha_obrigatoria"
  | "senha_obrigatoria_na_troca"
  | "numero_ja_existe"
  | "conta_ja_usada"
  | "nao_encontrado"
  | "destino_duplo"
  | "menu_invalido"
  | "menu_com_fala_pendente";
```

6. Logo depois da função `timeDaOrg`, acrescente:

```ts
/**
 * O destino das ligações: um time OU um menu (CHECK `channel_sessions_sip_destino_check`,
 * migration 0288). Menu só da própria organização, não arquivado e com a fala
 * pronta — um menu sem áudio mandaria toda ligação direto ao time padrão.
 */
async function problemaDoDestino(db: Queryable, organizationId: string, e: EntradaDoNumero): Promise<FalhaDoCadastro | null> {
  if (e.time_id && e.menu_id) return "destino_duplo";
  if (!e.menu_id) return null;
  const situacao = await situacaoDoMenuParaNumero(db, organizationId, e.menu_id);
  if (situacao === "inexistente") return "menu_invalido";
  if (situacao === "pendente") return "menu_com_fala_pendente";
  return null;
}

/** O destino guardado agora — para a rota auditar a troca. */
export async function destinoDoNumero(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<{ time_id: string | null; menu_id: string | null } | null> {
  const { rows } = await db.query<{ time_id: string | null; menu_id: string | null }>(
    `select sip_team_id as time_id, sip_menu_id as menu_id from channel_sessions
      where id = $1 and organization_id = $2 and provider = $3 and archived_at is null`,
    [id, organizationId, PROVIDER],
  );
  return rows[0] ?? null;
}
```

7. Em `criarNumero`, logo depois da linha `  if (!(await timeDaOrg(db, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };`, acrescente:

```ts
  const destino = await problemaDoDestino(db, organizationId, e);
  if (destino) return { ok: false, motivo: destino };
```

e troque o INSERT (comando e parâmetros) por:

```ts
    const { rows } = await db.query<{ id: string }>(
      `insert into channel_sessions
         (organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id,
          sip_dial_prefix, sip_menu_id)
       values ($1, $2, decode('00', 'hex'), 'STARTING', $3, $4, $5, $6, $7, $8,
               public.fn_encrypt_oauth($9), $10, $11, $12)
       returning id`,
      [
        organizationId,
        PROVIDER,
        e.nome,
        numero,
        e.servidor,
        e.porta,
        e.transporte,
        e.usuario,
        e.senha,
        e.time_id,
        e.prefixo ?? null,
        e.menu_id ?? null,
      ],
    );
```

8. Em `atualizarNumero`, logo depois da linha `  if (!(await timeDaOrg(db, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };`, acrescente:

```ts
  const destino = await problemaDoDestino(db, organizationId, e);
  if (destino) return { ok: false, motivo: destino };
```

e, no UPDATE, troque a linha

```
              sip_dial_prefix = case when $12::boolean then $13::text else sip_dial_prefix end,
```

por

```
              sip_dial_prefix = case when $12::boolean then $13::text else sip_dial_prefix end,
              sip_menu_id = case when $14::boolean then $15::uuid
                                 when $10::uuid is not null then null
                                 else sip_menu_id end,
```

e, no array de parâmetros do mesmo UPDATE, logo depois de `        e.prefixo ?? null,`, acrescente:

```ts
        e.menu_id !== undefined,
        e.menu_id ?? null,
```

9. Em `MENSAGEM_DA_FALHA`, logo depois de `  nao_encontrado: "Número não encontrado.",`, acrescente:

```ts
  destino_duplo: "Escolha só um destino: um time ou um menu.",
  menu_invalido: "Esse menu não existe nesta organização ou foi arquivado.",
  menu_com_fala_pendente: "A fala desse menu ainda não está pronta. Gere a fala na aba Menus antes de ligar o menu ao número.",
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia/numeros.test.ts`
Expected: PASS (todos os casos antigos — a posição dos parâmetros `$11`–`$13` não mudou — e os 6 novos).

- [ ] **Step 5: As rotas auditam o destino**

Em `app/api/v1/telefonia/numeros/route.ts` (POST), no `metadata` do `audit` de `channel.phone_trunk_created`, logo depois de `      time_id: parsed.data.time_id,`, acrescente:

```ts
      menu_id: parsed.data.menu_id ?? null,
```

Em `app/api/v1/telefonia/numeros/[id]/route.ts`:

(a) troque o import de `numeros` por:

```ts
import {
  MENSAGEM_DA_FALHA,
  arquivarNumero,
  atualizarNumero,
  destinoDoNumero,
  numeroSchema,
  numerosDaOrg,
} from "@/lib/channels/telefonia/numeros";
```

(b) no PATCH, troque as linhas

```ts
  const numeroId = id.data;
  const pool = getRequestPool();
  const r = await atualizarNumero(pool, authz.org.orgId, numeroId, parsed.data);
```

por

```ts
  const numeroId = id.data;
  const pool = getRequestPool();
  const antes = await destinoDoNumero(pool, authz.org.orgId, numeroId);
  const r = await atualizarNumero(pool, authz.org.orgId, numeroId, parsed.data);
```

(c) logo depois do bloco `void audit({ action: "channel.phone_trunk_updated", ... });` do PATCH, acrescente:

```ts
  // A troca de destino (time ↔ menu) é o que muda o que o CLIENTE ouve ao ligar:
  // ganha uma linha própria, com o antes e o depois.
  const depois = await destinoDoNumero(pool, authz.org.orgId, numeroId);
  if (antes && depois && (antes.time_id !== depois.time_id || antes.menu_id !== depois.menu_id)) {
    void audit({
      action: "phone.number_destination_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: numeroId,
      metadata: { de: antes, para: depois },
      requestId,
    });
  }
```

- [ ] **Step 6: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Escolha só um destino: um time ou um menu.": { es: "Elige un solo destino: un equipo o un menú." },
  "Esse menu não existe nesta organização ou foi arquivado.": { es: "Ese menú no existe en esta organización o fue archivado." },
  "A fala desse menu ainda não está pronta. Gere a fala na aba Menus antes de ligar o menu ao número.": {
    es: "La locución de ese menú aún no está lista. Genera la locución en la pestaña Menús antes de conectar el menú al número.",
  },
```

- [ ] **Step 7: Rodar o que toca números, typecheck e lints**

Run: `pnpm exec vitest run lib/channels/telefonia/ app/api/v1/telefonia/ && pnpm typecheck && pnpm lint:channels`
Expected: PASS; `tsc` e `lint:channels` sem erro.

- [ ] **Step 8: Commit**

```bash
git add lib/channels/telefonia/numeros.ts lib/channels/telefonia/numeros.test.ts app/api/v1/telefonia/numeros/route.ts \
  "app/api/v1/telefonia/numeros/[id]/route.ts" lib/i18n/dicionario.ts
git commit -m "feat(telefonia): o número aponta para um time ou para um menu de voz

Só menu da própria organização e com a fala pronta; escolher um time tira o
menu; a troca de destino ganha auditoria própria com o antes e o depois.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Aviso de instabilidade do time — ligar, desligar, ouvir

**Files:**
- Create: `lib/telefonia/emergencias.ts`
- Create: `app/api/v1/telefonia/emergencias/route.ts`
- Create: `app/api/v1/telefonia/emergencias/[teamId]/route.ts`, `app/api/v1/telefonia/emergencias/[teamId]/route.test.ts`
- Create: `app/api/v1/telefonia/emergencias/[teamId]/fala/route.ts`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste da rota de ligar/desligar (falha: a rota não existe)**

Crie `app/api/v1/telefonia/emergencias/[teamId]/route.test.ts`:

```ts
/**
 * O AVISO DE INSTABILIDADE PELA ROTA (desenho da fase 2, D7/D8): gerente ou admin;
 * time de outra organização não existe; sem a fala do texto pedido nada liga; o
 * prazo sai da duração escolhida (2 h por padrão); ligar e desligar auditam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TIME = "44444444-4444-4444-8444-444444444444";
const estado = vi.hoisted(() => ({
  time: { id: "44444444-4444-4444-8444-444444444444", nome: "Suporte", falaId: null as string | null } as unknown,
  resultado: null as unknown,
  desligado: { desde: "2026-09-28T13:00:00.000Z", expiraEm: null } as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  STATUS_DA_FALHA: {
    sem_chave: 422, sem_voz: 422, chave_invalida: 422, sem_credito: 422, texto_recusado: 422,
    voz_inexistente: 422, limite_de_uso: 422, armazenamento: 502, sem_resposta: 502, erro_do_provedor: 502,
  },
  contextoDeFala: vi.fn(async () => ({ chave: "sk_x", voz: { voiceId: "v1", modelId: "eleven_multilingual_v2" } })),
  armazemDaInstalacao: vi.fn(() => ({})),
  sintetizadorDaInstalacao: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/telefonia/falas", () => ({ gerarFala: vi.fn(async () => estado.resultado) }));
vi.mock("@/lib/telefonia/emergencias", async () => {
  const real = await vi.importActual<typeof import("@/lib/telefonia/emergencias")>("@/lib/telefonia/emergencias");
  return {
    ...real,
    timeParaAviso: vi.fn(async () => estado.time),
    vincularFalaAoTime: vi.fn(async () => undefined),
    ligarAviso: vi.fn(async () => true),
    desligarAviso: vi.fn(async () => estado.desligado),
    avisosDaOrg: vi.fn(async () => []),
  };
});

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ligarAviso } from "@/lib/telefonia/emergencias";

import { DELETE, PUT } from "./route";

const FALA = { id: "66666666-6666-4666-8666-666666666666", tipo: "emergency", status: "ready" };
const params = { params: Promise.resolve({ teamId: TIME }) };
const ligar = (corpo: unknown) =>
  PUT(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/emergencias/${TIME}`, { method: "PUT", body: JSON.stringify(corpo) }), params);
const desligar = () => DELETE(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/emergencias/${TIME}`, { method: "DELETE" }), params);

beforeEach(() => {
  estado.time = { id: TIME, nome: "Suporte", falaId: null };
  estado.resultado = { ok: true, fala: FALA, gerada: true };
  estado.desligado = { desde: "2026-09-28T13:00:00.000Z", expiraEm: null };
  vi.mocked(audit).mockClear();
  vi.mocked(ligarAviso).mockClear();
  vi.mocked(requireRole).mockClear();
});

describe("PUT /api/v1/telefonia/emergencias/[teamId] — ligar", () => {
  it("gerente ou admin (a régua é manager)", async () => {
    await ligar({ texto: "Instabilidade.", duracao: "1h" });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  it("time de outra organização (ou arquivado) → 404", async () => {
    estado.time = null;
    expect((await ligar({ texto: "Instabilidade." })).status).toBe(404);
    expect(ligarAviso).not.toHaveBeenCalled();
  });

  it("a fala do texto pedido não saiu → nada liga, e a mensagem vem traduzida", async () => {
    estado.resultado = { ok: false, motivo: "sem_credito", fala: null };
    const r = await ligar({ texto: "Instabilidade." });
    expect(r.status).toBe(422);
    expect(ligarAviso).not.toHaveBeenCalled();
  });

  it("liga com o prazo da duração escolhida (2 h por padrão) e audita", async () => {
    const r = await ligar({ texto: "Instabilidade." });
    expect(r.status).toBe(200);
    const pedido = vi.mocked(ligarAviso).mock.calls[0]![1];
    expect(pedido.expiraEm!.getTime() - pedido.desde.getTime()).toBe(2 * 3_600_000);
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).toContain("phone.emergency_activated");
  });

  it("'até eu desligar' liga sem prazo", async () => {
    await ligar({ texto: "Instabilidade.", duracao: "indefinida" });
    expect(vi.mocked(ligarAviso).mock.calls[0]![1].expiraEm).toBeNull();
  });
});

describe("DELETE /api/v1/telefonia/emergencias/[teamId] — desligar", () => {
  it("estava ligado: desliga e audita", async () => {
    const r = await desligar();
    expect(r.status).toBe(200);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ action: "phone.emergency_deactivated", resourceId: TIME });
  });

  it("já estava desligado: nada mudou, nada a auditar", async () => {
    estado.desligado = null;
    await desligar();
    expect(audit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run "app/api/v1/telefonia/emergencias/[teamId]/route.test.ts"`
Expected: FAIL — `Failed to resolve import "@/lib/telefonia/emergencias"`.

- [ ] **Step 3: A camada de banco do aviso**

Crie `lib/telefonia/emergencias.ts`:

```ts
/**
 * O AVISO DE INSTABILIDADE DO TELEFONE, POR TIME (desenho da fase 2, D7 e D8).
 * Server-only.
 *
 * Ligado, toda ligação DE FORA que entra na fila do time ouve o aviso inteiro
 * antes de tocar nos atendentes. Liga e desliga gerente ou admin; a duração é
 * escolhida ao ligar. Vencido, o worker para de tocar na hora (lê
 * `expires_at`) e a passada de 60 s o desliga no banco, com auditoria e aviso na
 * Central (`desligarAvisosVencidos`, em lib/channels/telefonia/repositorio.ts).
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { COLUNAS_DA_FALA, falaPublica, type LinhaDaFala } from "./falas";
import { DURACAO_PADRAO, DURACOES_DA_EMERGENCIA, avisoVigente } from "./vencimento-da-emergencia";
import { TAMANHO_MAXIMO_DA_FALA, type AvisoDoTimePublico, type FalaPublica } from "./vocabulario";

export const ligarAvisoSchema = z
  .object({
    texto: z.string().trim().min(1).max(TAMANHO_MAXIMO_DA_FALA),
    duracao: z.enum(DURACOES_DA_EMERGENCIA).default(DURACAO_PADRAO),
  })
  .strict();

export const falaDoAvisoSchema = z.object({ texto: z.string().trim().min(1).max(TAMANHO_MAXIMO_DA_FALA) }).strict();

export async function avisosDaOrg(db: Queryable, organizationId: string, agora: Date): Promise<AvisoDoTimePublico[]> {
  const { rows } = await db.query<{
    team_id: string;
    time_nome: string;
    desde: Date | string | null;
    expira_em: Date | string | null;
    ligada_por: string | null;
    fala_id: string | null;
  }>(
    `select t.id as team_id, t.name as time_nome,
            t.phone_emergency_active_since as desde, t.phone_emergency_expires_at as expira_em,
            coalesce(u.raw_user_meta_data->>'full_name', u.email) as ligada_por,
            t.phone_emergency_prompt_id as fala_id
       from attendance_teams t
       left join auth.users u on u.id = t.phone_emergency_activated_by
      where t.organization_id = $1 and t.archived_at is null
      order by t.name`,
    [organizationId],
  );
  const ids = rows.map((r) => r.fala_id).filter((id): id is string => Boolean(id));
  const falas = new Map<string, FalaPublica>();
  if (ids.length > 0) {
    const { rows: linhas } = await db.query<LinhaDaFala>(
      `select ${COLUNAS_DA_FALA} from phone_prompts where organization_id = $1 and id = any($2::uuid[])`,
      [organizationId, ids],
    );
    for (const l of linhas) falas.set(l.id, falaPublica(l));
  }
  return rows.map((r) => {
    const ativa = avisoVigente({ desde: r.desde, expiraEm: r.expira_em }, agora);
    return {
      team_id: r.team_id,
      time_nome: r.time_nome,
      ativa,
      desde: ativa && r.desde ? new Date(r.desde).toISOString() : null,
      expira_em: ativa && r.expira_em ? new Date(r.expira_em).toISOString() : null,
      ligada_por: ativa ? r.ligada_por : null,
      fala: r.fala_id ? (falas.get(r.fala_id) ?? null) : null,
    };
  });
}

export async function timeParaAviso(
  db: Queryable,
  organizationId: string,
  teamId: string,
): Promise<{ id: string; nome: string; falaId: string | null } | null> {
  const { rows } = await db.query<{ id: string; nome: string; fala_id: string | null }>(
    `select id, name as nome, phone_emergency_prompt_id as fala_id
       from attendance_teams where id = $1 and organization_id = $2 and archived_at is null`,
    [teamId, organizationId],
  );
  const r = rows[0];
  return r ? { id: r.id, nome: r.nome, falaId: r.fala_id } : null;
}

export async function vincularFalaAoTime(db: Queryable, organizationId: string, teamId: string, falaId: string): Promise<void> {
  await db.query(
    "update attendance_teams set phone_emergency_prompt_id = $3, updated_at = now() where id = $1 and organization_id = $2",
    [teamId, organizationId, falaId],
  );
}

export async function ligarAviso(
  db: Queryable,
  p: { organizationId: string; teamId: string; falaId: string; userId: string; desde: Date; expiraEm: Date | null },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update attendance_teams
        set phone_emergency_prompt_id = $3, phone_emergency_active_since = $4, phone_emergency_expires_at = $5,
            phone_emergency_activated_by = $6, updated_at = now()
      where id = $1 and organization_id = $2 and archived_at is null`,
    [p.teamId, p.organizationId, p.falaId, p.desde, p.expiraEm, p.userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Desliga. `null` = já estava desligado (nada mudou, nada a auditar). */
export async function desligarAviso(
  db: Queryable,
  organizationId: string,
  teamId: string,
): Promise<{ desde: string; expiraEm: string | null } | null> {
  const { rows } = await db.query<{ desde: Date | string; expira_em: Date | string | null }>(
    `with antes as (
       select id, phone_emergency_active_since, phone_emergency_expires_at
         from attendance_teams
        where id = $1 and organization_id = $2 and phone_emergency_active_since is not null
        for update
     )
     update attendance_teams t
        set phone_emergency_active_since = null, phone_emergency_expires_at = null,
            phone_emergency_activated_by = null, updated_at = now()
       from antes
      where t.id = antes.id
      returning antes.phone_emergency_active_since as desde, antes.phone_emergency_expires_at as expira_em`,
    [teamId, organizationId],
  );
  const r = rows[0];
  return r ? { desde: new Date(r.desde).toISOString(), expiraEm: r.expira_em ? new Date(r.expira_em).toISOString() : null } : null;
}
```

- [ ] **Step 4: As três rotas**

Crie `app/api/v1/telefonia/emergencias/route.ts`:

```ts
/**
 * GET /api/v1/telefonia/emergencias — o aviso de instabilidade de cada time da
 * organização (qualquer membro).
 *
 * É o que a faixa em todo o CRM e o cartão de Configurações › Times leem. `ativa`
 * é calculada contra o relógio da requisição: um aviso vencido que o worker ainda
 * não desligou já aparece desligado. Leitura não audita.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { avisosDaOrg } from "@/lib/telefonia/emergencias";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const oferecida = configAriDoAmbiente() !== null;
  const times = oferecida ? await avisosDaOrg(getRequestPool(), authz.org.orgId, new Date()) : [];
  return ok({ oferecida, times }, { requestId });
}
```

Crie `app/api/v1/telefonia/emergencias/[teamId]/route.ts`:

```ts
/**
 * PUT    /api/v1/telefonia/emergencias/[teamId] — liga o aviso de instabilidade do time (manager+).
 * DELETE /api/v1/telefonia/emergencias/[teamId] — desliga (manager+).
 *
 * Desenho da fase 2, D7/D8 e §6.3. Ligar gera (ou reaproveita) a fala do texto
 * pedido; se a ElevenLabs não entregar ESSE texto, nada liga — tocar um aviso
 * antigo com texto diferente do que o gerente acabou de escrever seria pior que
 * não tocar. A duração vira `expires_at` (nulo = até alguém desligar).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  avisosDaOrg,
  desligarAviso,
  ligarAviso,
  ligarAvisoSchema,
  timeParaAviso,
  vincularFalaAoTime,
} from "@/lib/telefonia/emergencias";
import { gerarFala } from "@/lib/telefonia/falas";
import {
  STATUS_DA_FALHA,
  armazemDaInstalacao,
  contextoDeFala,
  sintetizadorDaInstalacao,
} from "@/lib/telefonia/servico-de-falas";
import { expiraEm } from "@/lib/telefonia/vencimento-da-emergencia";
import { MENSAGEM_DA_FALHA_DA_FALA } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t("Time não encontrado."), 404, { requestId });
  const parsed = ligarAvisoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = getRequestPool();
  const org = authz.org.orgId;
  const time = await timeParaAviso(db, org, id.data);
  if (!time) return fail("not_found", t("Time não encontrado."), 404, { requestId });

  const { chave, voz } = await contextoDeFala(db, org);
  const r = await gerarFala({
    db,
    armazem: armazemDaInstalacao(),
    sintetizar: sintetizadorDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    tipo: "emergency",
    texto: parsed.data.texto,
    falaAtualId: time.falaId,
    chave,
    voz,
  });
  if (!r.ok) {
    // A linha `failed` fica ligada ao time, para a tela mostrar o porquê da próxima vez.
    if (r.fala?.status === "failed") await vincularFalaAoTime(db, org, time.id, r.fala.id);
    return fail(r.motivo, t(MENSAGEM_DA_FALHA_DA_FALA[r.motivo]), STATUS_DA_FALHA[r.motivo], { requestId });
  }

  const desde = new Date();
  const prazo = expiraEm(parsed.data.duracao, desde);
  await ligarAviso(db, { organizationId: org, teamId: time.id, falaId: r.fala.id, userId: authz.user.id, desde, expiraEm: prazo });
  void audit({
    action: "phone.emergency_activated",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "attendance_team",
    resourceId: time.id,
    metadata: { duracao: parsed.data.duracao, expira_em: prazo?.toISOString() ?? null, fala_id: r.fala.id },
    requestId,
  });
  if (r.gerada) {
    void audit({
      action: "phone.prompt_saved",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: r.fala.id,
      metadata: { tipo: "emergency", status: r.fala.status, gerada: true, team_id: time.id },
      requestId,
    });
  }
  const aviso = (await avisosDaOrg(db, org, new Date())).find((a) => a.team_id === time.id) ?? null;
  return ok({ aviso }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t("Time não encontrado."), 404, { requestId });
  const teamId = id.data;
  const desligado = await desligarAviso(getRequestPool(), authz.org.orgId, teamId);
  if (desligado) {
    void audit({
      action: "phone.emergency_deactivated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "attendance_team",
      resourceId: teamId,
      metadata: { ligado_em: desligado.desde, expiraria_em: desligado.expiraEm },
      requestId,
    });
  }
  return ok({ desligado: desligado !== null }, { requestId });
}
```

Crie `app/api/v1/telefonia/emergencias/[teamId]/fala/route.ts`:

```ts
/**
 * POST /api/v1/telefonia/emergencias/[teamId]/fala — gera a fala do aviso SEM
 * ligar, para o gerente ouvir antes (o botão "Ouvir" da janela). Manager+.
 *
 * A fala fica ligada ao time (a próxima vez que ligar com o mesmo texto não paga
 * de novo). Falha com linha volta 200 com `falha`; sem linha, 422.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { falaDoAvisoSchema, timeParaAviso, vincularFalaAoTime } from "@/lib/telefonia/emergencias";
import { gerarFala } from "@/lib/telefonia/falas";
import {
  STATUS_DA_FALHA,
  armazemDaInstalacao,
  contextoDeFala,
  sintetizadorDaInstalacao,
} from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = z.string().uuid().safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t("Time não encontrado."), 404, { requestId });
  const parsed = falaDoAvisoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = getRequestPool();
  const org = authz.org.orgId;
  const time = await timeParaAviso(db, org, id.data);
  if (!time) return fail("not_found", t("Time não encontrado."), 404, { requestId });

  const { chave, voz } = await contextoDeFala(db, org);
  const r = await gerarFala({
    db,
    armazem: armazemDaInstalacao(),
    sintetizar: sintetizadorDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    tipo: "emergency",
    texto: parsed.data.texto,
    falaAtualId: time.falaId,
    chave,
    voz,
  });
  const fala = r.fala;
  if (!fala) {
    const motivo: FalhaDaFala = r.ok ? "erro_do_provedor" : r.motivo;
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }
  await vincularFalaAoTime(db, org, time.id, fala.id);
  void audit({
    action: "phone.prompt_saved",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_prompt",
    resourceId: fala.id,
    metadata: { tipo: "emergency", status: fala.status, gerada: r.ok ? r.gerada : false, falha: r.ok ? null : r.motivo, team_id: time.id },
    requestId,
  });
  return ok(
    { fala, falha: r.ok ? null : { motivo: r.motivo, mensagem: t(MENSAGEM_DA_FALHA_DA_FALA[r.motivo]) } },
    { requestId },
  );
}
```

- [ ] **Step 5: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Time não encontrado.": { es: "Equipo no encontrado." },
```

- [ ] **Step 6: Rodar, typecheck e lints**

Run: `pnpm exec vitest run "app/api/v1/telefonia/emergencias/[teamId]/route.test.ts" tests/unit/audit-resource-id-e-uuid.test.ts && pnpm typecheck && pnpm lint:role-rank && pnpm lint:channels`
Expected: PASS (7 testes + o gate); `tsc` e lints sem erro.

- [ ] **Step 7: Commit**

```bash
git add lib/telefonia/emergencias.ts app/api/v1/telefonia/emergencias/route.ts "app/api/v1/telefonia/emergencias/[teamId]/route.ts" \
  "app/api/v1/telefonia/emergencias/[teamId]/route.test.ts" "app/api/v1/telefonia/emergencias/[teamId]/fala/route.ts" lib/i18n/dicionario.ts
git commit -m "feat(telefonia): aviso de instabilidade por time — ligar com prazo, desligar, ouvir antes

Gerente ou admin liga o aviso com a duração escolhida (2 h por padrão, ou até
desligar); sem a fala do texto pedido nada liga; ligar e desligar auditam. A
leitura calcula o vencimento contra o relógio da requisição.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: O banco do worker — situação do time, menu, falas, aviso e o registro da URA

**Files:**
- Modify: `lib/channels/telefonia/repositorio.ts` (vários pontos, descritos abaixo com o texto atual)
- Create: `tests/invariants/telefonia-repositorio-da-ura.test.ts`

- [ ] **Step 1: A prova no Postgres real (falha: as funções não existem)**

Crie `tests/invariants/telefonia-repositorio-da-ura.test.ts`:

```ts
/**
 * O SQL DO WORKER DA URA CONTRA POSTGRES REAL (migration 0288).
 *
 * O controlador (`controle.ts`) é provado com um banco de mentira; aqui se prova o
 * outro lado — que cada consulta do repositório devolve, no schema de verdade, o
 * que o controlador espera: só falas PRONTAS, só times não arquivados, só a
 * organização pedida; o aviso vencido já não toca; a passada de 60 s desliga o
 * vencido com auditoria e aviso na Central, uma vez só; e o cartão da ligação
 * leva o que o menu fez.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repo from "@/lib/channels/telefonia/repositorio";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const ORG = "c0de0289-0000-4000-8000-00000000000a";
const OUTRA = "c0de0289-0000-4000-8000-00000000000b";
const ABERTO = "c0de0289-2222-4000-8000-000000000001";
const FECHADO = "c0de0289-2222-4000-8000-000000000002";
const ARQUIVADO = "c0de0289-2222-4000-8000-000000000003";
const TIME_OUTRA = "c0de0289-2222-4000-8000-000000000004";
const PRONTA = "c0de0289-3333-4000-8000-000000000001";
const FALHOU = "c0de0289-3333-4000-8000-000000000002";
const AVISO = "c0de0289-3333-4000-8000-000000000003";
const MENU = "c0de0289-4444-4000-8000-000000000001";
const MENU_ARQUIVADO = "c0de0289-4444-4000-8000-000000000002";
const NUMERO = "c0de0289-5555-4000-8000-000000000001";
/** Segunda-feira, 10h em Brasília. */
const AGORA = new Date("2026-09-28T13:00:00Z");
const hash = (c: string) => c.repeat(64);

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'ura-repo-a', 'URA repo A', 'URA repo A'), ($2, 'ura-repo-b', 'URA repo B', 'URA repo B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug, schedule, archived_at) values
       ($1, $5, 'Suporte', 'suporte', '{}'::jsonb, null),
       ($2, $5, 'Financeiro', 'financeiro',
        '{"timezone":"America/Sao_Paulo","windows":[{"dow":0,"start":"08:00","end":"09:00"}]}'::jsonb, null),
       ($3, $5, 'Antigo', 'antigo', '{}'::jsonb, now()),
       ($4, $6, 'Suporte', 'suporte', '{}'::jsonb, null)
     on conflict (id) do nothing`,
    [ABERTO, FECHADO, ARQUIVADO, TIME_OUTRA, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.phone_prompts
       (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status, error)
     values
       ($1, $4, 'menu', 'Para Suporte, digite 1.', 'v', 'm', $5, $4 || '/' || $5 || '.ulaw', 1500, 'ready', null),
       ($2, $4, 'waiting', 'Aguarde.', 'v', 'm', $6, null, null, 'failed', 'sem_credito'),
       ($3, $4, 'emergency', 'Instabilidade.', 'v', 'm', $7, $4 || '/' || $7 || '.ulaw', 2000, 'ready', null)
     on conflict (id) do nothing`,
    [PRONTA, FALHOU, AVISO, ORG, hash("a"), hash("b"), hash("c")],
  );
  await pool.query(
    `insert into public.phone_settings (organization_id, voice_id, waiting_prompt_id, nobody_prompt_id)
     values ($1, 'v', $2, $3) on conflict (organization_id) do nothing`,
    [ORG, FALHOU, PRONTA],
  );
  await pool.query(
    `insert into public.phone_menus (id, organization_id, name, prompt_id, default_team_id, archived_at) values
       ($1, $3, 'Principal', $4, $5, null), ($2, $3, 'Velho', $4, $5, now())
     on conflict (id) do nothing`,
    [MENU, MENU_ARQUIVADO, ORG, PRONTA, ABERTO],
  );
  await pool.query(
    `insert into public.phone_menu_options (organization_id, menu_id, digit, team_id) values
       ($1, $2, '1', $3), ($1, $2, '2', $4), ($1, $2, '3', $5)
     on conflict do nothing`,
    [ORG, MENU, ABERTO, FECHADO, ARQUIVADO],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_menu_id)
     values ($1, $2, 'sip_trunk', '\\x00', 'STARTING', 'URA repo', '+556130000289',
             'voip.exemplo-0289.com.br', 5060, 'udp', 'u0289', '\\x00', $3)
     on conflict (id) do nothing`,
    [NUMERO, ORG, MENU],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("situação do time — 'fora do horário' separado de 'ninguém disponível'", () => {
  it("aberto, fora do horário, arquivado e de outra organização", async () => {
    expect(await repo.situacaoDoTime(pool, ORG, ABERTO, AGORA)).toBe("aberto");
    expect(await repo.situacaoDoTime(pool, ORG, FECHADO, AGORA)).toBe("fora_do_horario");
    expect(await repo.situacaoDoTime(pool, ORG, ARQUIVADO, AGORA)).toBe("indisponivel");
    expect(await repo.situacaoDoTime(pool, ORG, TIME_OUTRA, AGORA)).toBe("indisponivel");
  });

  it("disponiveisNoTime segue devolvendo lista vazia fora do horário (os chamadores da fase 1 não mudam)", async () => {
    expect(await repo.disponiveisNoTime(pool, ORG, FECHADO, AGORA)).toEqual([]);
  });
});

describe("menuPorId", () => {
  it("só a fala pronta, e só as opções de times não arquivados", async () => {
    const menu = await repo.menuPorId(pool, ORG, MENU);
    expect(menu).toEqual({
      id: MENU,
      nome: "Principal",
      defaultTeamId: ABERTO,
      fala: { id: PRONTA, storagePath: `${ORG}/${hash("a")}.ulaw` },
      falaInvalida: null,
      opcoes: [
        { digito: "1", teamId: ABERTO },
        { digito: "2", teamId: FECHADO },
      ],
    });
  });

  it("menu de outra organização ou arquivado → null", async () => {
    expect(await repo.menuPorId(pool, OUTRA, MENU)).toBeNull();
    expect(await repo.menuPorId(pool, ORG, MENU_ARQUIVADO)).toBeNull();
  });

  it("o tronco carrega o menu do número", async () => {
    expect((await repo.troncoPorId(pool, NUMERO))?.menuId).toBe(MENU);
  });
});

describe("falas gerais e aviso do time", () => {
  it("fala 'failed' não toca: só a pronta volta", async () => {
    expect(await repo.falasGerais(pool, ORG)).toEqual({
      aguarde: null,
      ninguem: { id: PRONTA, storagePath: `${ORG}/${hash("a")}.ulaw` },
      foraDoHorario: null,
    });
    expect(await repo.falasGerais(pool, OUTRA)).toEqual({ aguarde: null, ninguem: null, foraDoHorario: null });
  });

  it("o aviso toca enquanto vigente e para de tocar no instante em que vence — sem depender da passada", async () => {
    await pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = $2, phone_emergency_active_since = $3::timestamptz - interval '1 hour',
              phone_emergency_expires_at = $3::timestamptz + interval '1 hour'
        where id = $1`,
      [ABERTO, AVISO, AGORA.toISOString()],
    );
    expect(await repo.emergenciaDoTime(pool, ORG, ABERTO, AGORA)).toEqual({ id: AVISO, storagePath: `${ORG}/${hash("c")}.ulaw` });
    expect(await repo.emergenciaDoTime(pool, ORG, ABERTO, new Date(AGORA.getTime() + 2 * 3_600_000))).toBeNull();
    expect(await repo.emergenciaDoTime(pool, OUTRA, ABERTO, AGORA)).toBeNull();
  });

  it("a passada desliga só o vencido, audita e avisa na Central — uma vez", async () => {
    // ABERTO vence em AGORA + 1 h; FECHADO fica ligado "até alguém desligar".
    await pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = $2, phone_emergency_active_since = $3::timestamptz - interval '1 hour',
              phone_emergency_expires_at = $3::timestamptz + interval '1 hour'
        where id = $1`,
      [ABERTO, AVISO, AGORA.toISOString()],
    );
    await pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = $2, phone_emergency_active_since = $3::timestamptz - interval '1 hour',
              phone_emergency_expires_at = null
        where id = $1`,
      [FECHADO, AVISO, AGORA.toISOString()],
    );
    const depois = new Date(AGORA.getTime() + 2 * 3_600_000);
    const desligados = await repo.desligarAvisosVencidos(pool, depois);
    expect(desligados.map((d) => d.id)).toEqual([ABERTO]);

    const { rows: times } = await pool.query(
      "select id, phone_emergency_active_since is null as desligado from public.attendance_teams where id = any($1::uuid[]) order by name",
      [[ABERTO, FECHADO]],
    );
    expect(times).toEqual([
      { id: FECHADO, desligado: false },
      { id: ABERTO, desligado: true },
    ]);
    const { rows: auditoria } = await pool.query(
      "select count(*)::int as n from public.api_audit_log where action = 'phone.emergency_expired' and resource_id = $1",
      [ABERTO],
    );
    expect(auditoria[0].n).toBe(1);
    const { rows: avisos } = await pool.query(
      "select count(*)::int as n from public.agent_inbox_items where organization_id = $1 and kind = 'phone_emergency_expired'",
      [ORG],
    );
    expect(avisos[0].n).toBe(1);

    expect(await repo.desligarAvisosVencidos(pool, depois)).toEqual([]);
  });

  it("aviso de fala intocável não se repete enquanto o anterior está aberto", async () => {
    await repo.avisarFalaIntocavel(pool, ORG, "menu Principal");
    await repo.avisarFalaIntocavel(pool, ORG, "menu Principal");
    const { rows } = await pool.query(
      "select count(*)::int as n from public.agent_inbox_items where organization_id = $1 and kind = 'phone_prompt_unplayable' and status = 'open'",
      [ORG],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("a ligação guarda o que a URA fez, e o cartão da conversa o mostra", () => {
  it("menu, tecla, desfecho, time escolhido e o aviso ouvido chegam ao metadado da mensagem", async () => {
    const contato = await repo.acharOuCriarContato(pool, ORG, "+5561999990289", "Cliente URA");
    const conversa = await repo.acharOuCriarConversa(pool, ORG, contato, NUMERO, ABERTO);
    const id = await repo.criarLigacao(pool, {
      organizationId: ORG,
      troncoId: NUMERO,
      sipCallRef: "ura-repo-1",
      direcao: "inbound",
      numeroDoOutroLado: "+5561999990289",
      contactId: contato,
      conversationId: conversa,
      teamId: ABERTO,
      status: "ringing",
      menuId: MENU,
    });
    await repo.registrarMenu(pool, id, { digito: "2", desfecho: "chosen" });
    await repo.definirTimeDaLigacao(pool, id, FECHADO);
    await repo.registrarAvisoOuvido(pool, id);
    const l = await repo.encerrarLigacao(pool, id, "cliente_desligou");
    expect(l).toMatchObject({ menu_id: MENU, menu_digit: "2", menu_outcome: "chosen", team_id: FECHADO, end_reason: "cliente_desligou" });
    await repo.registrarNaConversa(pool, l!, "perdida", null);

    const { rows } = await pool.query(
      "select metadata->'voice_call' as vc from public.messages where organization_id = $1 and external_id = $2",
      [ORG, `ligacao:${id}`],
    );
    expect(rows[0].vc).toMatchObject({
      menu: { desfecho: "chosen", tecla: "2", time_nome: "Financeiro" },
      ouviu_aviso: true,
      motivo: "cliente_desligou",
    });
  });

  it("fora do horário: o registro na conversa diz isso", async () => {
    const contato = await repo.acharOuCriarContato(pool, ORG, "+5561999990290", "Cliente fora");
    const conversa = await repo.acharOuCriarConversa(pool, ORG, contato, NUMERO, FECHADO);
    const id = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "ura-repo-2", direcao: "inbound",
      numeroDoOutroLado: "+5561999990290", contactId: contato, conversationId: conversa, teamId: FECHADO, status: "ringing",
    });
    const l = await repo.encerrarLigacao(pool, id, "after_hours");
    await repo.registrarNaConversa(pool, l!, "perdida", null);
    const { rows } = await pool.query(
      "select body from public.messages where organization_id = $1 and external_id = $2",
      [ORG, `ligacao:${id}`],
    );
    expect(rows[0].body).toBe("Ligação recebida fora do horário");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:db tests/invariants/telefonia-repositorio-da-ura.test.ts`
Expected: FAIL — `repo.situacaoDoTime is not a function` (e as demais).

- [ ] **Step 3: Implementar em `repositorio.ts`**

1. Logo depois da linha `import type { CandidatoAoToque } from "@/lib/telefonia/distribuicao";`, acrescente:

```ts
import { MOTIVO_FORA_DO_HORARIO, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";
```

2. Em `TroncoDoBanco`, logo depois do campo `prefixo: string | null;` (e do comentário dele), acrescente:

```ts
  /**
   * O menu de voz que atende as ligações deste número (`sip_menu_id`, migration
   * 0288). Opcional no tipo para o teste da fase 1 não precisar declará-lo.
   */
  menuId?: string | null;
```

3. Em `LinhaDoTronco`, logo depois de `  sip_dial_prefix?: string | null;`, acrescente `  sip_menu_id?: string | null;`. Em `paraTronco`, logo depois de `    prefixo: r.sip_dial_prefix ?? null,`, acrescente `    menuId: r.sip_menu_id ?? null,`. Em `SELECT_TRONCO`, troque `sip_transport, sip_username, sip_team_id, sip_dial_prefix,` por `sip_transport, sip_username, sip_team_id, sip_dial_prefix, sip_menu_id,`.

4. Logo ANTES do comentário `/**\n * Quem do time pode receber uma ligação AGORA, com a contagem do dia.` (antes de `disponiveisNoTime`), acrescente:

```ts
/**
 * O time pode receber ligação agora? Separa "fora do horário" (toca a fala de
 * fora do horário e desliga, desenho da fase 2 §5.2) de "ninguém disponível"
 * (fila) — antes, as duas perguntas voltavam como a mesma lista vazia.
 * Agenda que o parser não lê conta como "indisponível", não como fechada: sem
 * certeza do horário, a ligação segue a fila e vira "Ligar de volta", em vez de
 * ouvir que está fora do horário.
 */
export type SituacaoDoTime = "aberto" | "fora_do_horario" | "indisponivel";

export async function situacaoDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<SituacaoDoTime> {
  const { rows } = await db.query<{ schedule: unknown; archived_at: string | null }>(
    "select schedule, archived_at from attendance_teams where id = $1 and organization_id = $2",
    [teamId, organizationId],
  );
  const time = rows[0];
  if (!time || time.archived_at) return "indisponivel";
  const { agenda, valida } = lerAgenda(time.schedule);
  if (!valida) return "indisponivel";
  return isWithinSchedule(agenda, agora) ? "aberto" : "fora_do_horario";
}
```

5. Em `disponiveisNoTime`, troque as linhas

```ts
  const { rows: times } = await db.query<{ schedule: unknown; archived_at: string | null }>(
    "select schedule, archived_at from attendance_teams where id = $1 and organization_id = $2",
    [teamId, organizationId],
  );
  const time = times[0];
  if (!time || time.archived_at) return [];
  const { agenda: agendaDoTime, valida } = lerAgenda(time.schedule);
  if (!valida || !isWithinSchedule(agendaDoTime, agora)) return [];
```

por

```ts
  if ((await situacaoDoTime(db, organizationId, teamId, agora)) !== "aberto") return [];
```

6. Logo depois da função `acharOuCriarConversa`, acrescente:

```ts
// ─── URA e falas (fase 2, migration 0288) ─────────────────────────────────

/** Uma fala PRONTA para tocar: só o que o worker precisa para garantir o arquivo. */
export interface FalaDoBanco {
  id: string;
  storagePath: string;
}

export interface FalasGerais {
  aguarde: FalaDoBanco | null;
  ninguem: FalaDoBanco | null;
  foraDoHorario: FalaDoBanco | null;
}

export interface MenuDoBanco {
  id: string;
  nome: string;
  defaultTeamId: string;
  fala: FalaDoBanco | null;
  falaInvalida: FalaDoBanco | null;
  opcoes: Array<{ digito: string; teamId: string }>;
}

const falaOuNada = (id: string | null, caminho: string | null): FalaDoBanco | null =>
  id && caminho ? { id, storagePath: caminho } : null;

/** O menu da ORGANIZAÇÃO do tronco — só falas prontas, só opções de times não arquivados. */
export async function menuPorId(db: Queryable, organizationId: string, menuId: string): Promise<MenuDoBanco | null> {
  const { rows } = await db.query<{
    id: string;
    nome: string;
    default_team_id: string;
    fala_id: string | null;
    fala_caminho: string | null;
    invalida_id: string | null;
    invalida_caminho: string | null;
    opcoes: Array<{ digito: string; teamId: string }>;
  }>(
    `select m.id, m.name as nome, m.default_team_id,
            p.id as fala_id, p.storage_path as fala_caminho,
            i.id as invalida_id, i.storage_path as invalida_caminho,
            coalesce((
              select jsonb_agg(jsonb_build_object('digito', o.digit, 'teamId', o.team_id) order by o.digit)
                from phone_menu_options o
                join attendance_teams t
                  on t.id = o.team_id and t.organization_id = o.organization_id and t.archived_at is null
               where o.menu_id = m.id and o.organization_id = m.organization_id
            ), '[]'::jsonb) as opcoes
       from phone_menus m
       left join phone_prompts p
         on p.id = m.prompt_id and p.organization_id = m.organization_id and p.status = 'ready'
       left join phone_prompts i
         on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id and i.status = 'ready'
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [menuId, organizationId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    nome: r.nome,
    defaultTeamId: r.default_team_id,
    fala: falaOuNada(r.fala_id, r.fala_caminho),
    falaInvalida: falaOuNada(r.invalida_id, r.invalida_caminho),
    opcoes: r.opcoes,
  };
}

export async function falasGerais(db: Queryable, organizationId: string): Promise<FalasGerais> {
  const { rows } = await db.query<{
    aguarde_id: string | null;
    aguarde_caminho: string | null;
    ninguem_id: string | null;
    ninguem_caminho: string | null;
    fora_id: string | null;
    fora_caminho: string | null;
  }>(
    `select w.id as aguarde_id, w.storage_path as aguarde_caminho,
            n.id as ninguem_id, n.storage_path as ninguem_caminho,
            a.id as fora_id, a.storage_path as fora_caminho
       from phone_settings s
       left join phone_prompts w
         on w.id = s.waiting_prompt_id and w.organization_id = s.organization_id and w.status = 'ready'
       left join phone_prompts n
         on n.id = s.nobody_prompt_id and n.organization_id = s.organization_id and n.status = 'ready'
       left join phone_prompts a
         on a.id = s.after_hours_prompt_id and a.organization_id = s.organization_id and a.status = 'ready'
      where s.organization_id = $1`,
    [organizationId],
  );
  const r = rows[0];
  return {
    aguarde: falaOuNada(r?.aguarde_id ?? null, r?.aguarde_caminho ?? null),
    ninguem: falaOuNada(r?.ninguem_id ?? null, r?.ninguem_caminho ?? null),
    foraDoHorario: falaOuNada(r?.fora_id ?? null, r?.fora_caminho ?? null),
  };
}

/** O aviso de instabilidade do time, se ligado e NÃO vencido agora — o worker não depende da passada de 60 s. */
export async function emergenciaDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<FalaDoBanco | null> {
  const { rows } = await db.query<{ id: string; storage_path: string }>(
    `select p.id, p.storage_path
       from attendance_teams t
       join phone_prompts p
         on p.id = t.phone_emergency_prompt_id and p.organization_id = t.organization_id and p.status = 'ready'
      where t.id = $1 and t.organization_id = $2
        and t.phone_emergency_active_since is not null
        and (t.phone_emergency_expires_at is null or t.phone_emergency_expires_at > $3)`,
    [teamId, organizationId, agora],
  );
  const r = rows[0];
  return r ? { id: r.id, storagePath: r.storage_path } : null;
}

export async function registrarMenu(
  db: Queryable,
  id: string,
  m: { digito: string | null; desfecho: DesfechoDoMenu },
): Promise<void> {
  await db.query(
    "update voice_calls set menu_digit = $2, menu_outcome = $3, updated_at = now() where id = $1",
    [id, m.digito, m.desfecho],
  );
}

/** O time da ligação passa a ser o que a URA escolheu (é o que o "Ligar de volta" e a distribuição leem). */
export async function definirTimeDaLigacao(db: Queryable, id: string, teamId: string): Promise<void> {
  await db.query("update voice_calls set team_id = $2, updated_at = now() where id = $1", [id, teamId]);
}

/** O cliente ouviu o aviso de instabilidade INTEIRO — a fonte do "ouviu o aviso" no cartão. */
export async function registrarAvisoOuvido(db: Queryable, id: string): Promise<void> {
  await db.query(
    "update voice_calls set emergency_heard_at = coalesce(emergency_heard_at, now()), updated_at = now() where id = $1",
    [id],
  );
}

/**
 * A fala não tocou (arquivo ausente ou reprodução falha) e a ligação seguiu sem
 * ela: aviso na Central, com destino geral (a aba das falas). Um só enquanto o
 * anterior da MESMA fala estiver aberto — sem isto, cada ligação abriria um.
 */
export async function avisarFalaIntocavel(db: Queryable, organizationId: string, rotulo: string): Promise<void> {
  const titulo = `Uma fala do telefone não tocou: ${rotulo}`.slice(0, 200);
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body)
     select $1, 'phone_prompt_unplayable', 'warn', $2,
            'A ligação seguiu sem ela. Gere a fala de novo em Conexões › Telefone e confira se o serviço de telefonia está de pé.'
      where not exists (
        select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'phone_prompt_unplayable' and status = 'open' and title = $2
      )`,
    [organizationId, titulo],
  );
}

/**
 * A passada de 60 s: desliga os avisos de instabilidade vencidos, audita
 * (`phone.emergency_expired`, sem ator) e avisa na Central — num comando só, para
 * a auditoria e o aviso não se perderem se o worker cair no meio.
 */
export async function desligarAvisosVencidos(
  db: Queryable,
  agora: Date,
): Promise<Array<{ id: string; organizationId: string; nome: string }>> {
  const { rows } = await db.query<{ id: string; organization_id: string; name: string }>(
    `with vencidos as (
       select id, organization_id, name, phone_emergency_active_since as desde,
              phone_emergency_expires_at as expirou_em, phone_emergency_activated_by as ligado_por
         from attendance_teams
        where phone_emergency_active_since is not null
          and phone_emergency_expires_at is not null
          and phone_emergency_expires_at <= $1
        for update skip locked
     ), desligados as (
       update attendance_teams t
          set phone_emergency_active_since = null, phone_emergency_expires_at = null,
              phone_emergency_activated_by = null, updated_at = now()
         from vencidos v
        where t.id = v.id
        returning v.id, v.organization_id, v.name, v.desde, v.expirou_em, v.ligado_por
     ), auditados as (
       insert into api_audit_log (organization_id, action, resource_type, resource_id, metadata)
       select organization_id, 'phone.emergency_expired', 'attendance_team', id,
              jsonb_build_object('time', name, 'ligado_em', desde, 'expirou_em', expirou_em, 'ligado_por', ligado_por)
         from desligados
       returning 1
     ), avisados as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body)
       select organization_id, 'phone_emergency_expired', 'info',
              left('O aviso de instabilidade do telefone de ' || name || ' desligou sozinho', 200),
              'Ele venceu no horário escolhido quando foi ligado. Se a instabilidade continua, ligue o aviso de novo em Configurações › Times.'
         from desligados
       returning 1
     )
     select id, organization_id, name from desligados`,
    [agora],
  );
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, nome: r.name }));
}
```

7. Em `NovaLigacao`, logo depois de `  status: "starting" | "ringing";`, acrescente `  /** O menu de voz que atendeu (fase 2). */\n  menuId?: string | null;` — isto é, as duas linhas:

```ts
  /** O menu de voz que atendeu (fase 2). */
  menuId?: string | null;
```

E troque `criarLigacao` inteira por:

```ts
export async function criarLigacao(db: Queryable, l: NovaLigacao): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into voice_calls
       (organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction,
        peer_phone, status, conversation_id, team_id, menu_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (organization_id, sip_call_ref) where sip_call_ref is not null do update
       set updated_at = now()
     returning id`,
    [
      l.organizationId,
      l.troncoId,
      l.contactId,
      PROVIDER,
      l.sipCallRef,
      l.direcao,
      l.numeroDoOutroLado,
      l.status,
      l.conversationId,
      l.teamId,
      l.menuId ?? null,
    ],
  );
  return rows[0]!.id;
}
```

8. Em `LigacaoDoBanco`, logo depois de `  sip_call_ref: string | null;`, acrescente:

```ts
  // Fase 2 (0288). Opcionais no tipo: os testes da fase 1 montam ligações sem eles.
  menu_id?: string | null;
  menu_digit?: string | null;
  menu_outcome?: DesfechoDoMenu | null;
  emergency_heard_at?: string | null;
  end_reason?: string | null;
```

e logo DEPOIS da interface, acrescente a constante:

```ts
const COLUNAS_DA_LIGACAO = `id, organization_id, channel_session_id, contact_id, conversation_id, direction,
  peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
  provider, sip_call_ref, menu_id, menu_digit, menu_outcome, emergency_heard_at, end_reason`;
```

Em `ligacaoPorId`, `ligacoesVivas` e no `returning` de `encerrarLigacao`, troque a lista de colunas escrita à mão (`id, organization_id, channel_session_id, contact_id, conversation_id, direction, peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at, provider, sip_call_ref`) por `${COLUNAS_DA_LIGACAO}` — os três comandos passam a ser template strings:

```ts
export async function ligacaoPorId(db: Queryable, id: string): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(`select ${COLUNAS_DA_LIGACAO} from voice_calls where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Ligações de telefone que o banco acha que ainda estão vivas (para `recuperar()`). */
export async function ligacoesVivas(db: Queryable): Promise<LigacaoDoBanco[]> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls where provider = $1 and status <> 'ended'`,
    [PROVIDER],
  );
  return rows;
}
```

e, em `encerrarLigacao`, a linha `      returning id, organization_id, ...` (duas linhas) vira `      returning ${COLUNAS_DA_LIGACAO}`, com o comando entre crases.

9. Troque `textoDoRegistro` inteira por:

```ts
export function textoDoRegistro(p: {
  direcao: "inbound" | "outbound";
  desfecho: DesfechoDaLigacao;
  duracaoMs: number | null;
  quem: string | null;
  motivo?: string | null;
}): string {
  const d = duracaoLegivel(p.duracaoMs);
  if (p.direcao === "inbound") {
    if (p.desfecho === "atendida") return `Ligação recebida${p.quem ? `, atendida por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
    if (p.motivo === MOTIVO_FORA_DO_HORARIO) return "Ligação recebida fora do horário";
    return "Ligação recebida não atendida";
  }
  if (p.desfecho === "atendida") return `Ligação feita${p.quem ? ` por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
  if (p.desfecho === "recusada_pela_rede") return "Ligação feita · não completou";
  return "Ligação feita · sem resposta";
}
```

10. Em `registrarNaConversa`, troque a linha

```ts
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem });
```

por

```ts
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem, motivo: l.end_reason ?? null });
  // O que a URA fez (fase 2): o cartão mostra "escolheu 2 → Financeiro" ou "sem escolha → Suporte".
  let menu: { desfecho: DesfechoDoMenu; tecla: string | null; time_nome: string | null } | null = null;
  if (l.menu_outcome) {
    let timeNome: string | null = null;
    if (l.team_id) {
      const { rows: t } = await db.query<{ name: string }>(
        "select name from attendance_teams where id = $1 and organization_id = $2",
        [l.team_id, l.organization_id],
      );
      timeNome = t[0]?.name ?? null;
    }
    menu = { desfecho: l.menu_outcome, tecla: l.menu_digit ?? null, time_nome: timeNome };
  }
```

e, no `JSON.stringify({ voice_call: { ... } })` do INSERT da mensagem, logo depois de `          atendente_nome: quem,`, acrescente:

```ts
          motivo: l.end_reason ?? null,
          menu,
          ouviu_aviso: Boolean(l.emergency_heard_at),
```

- [ ] **Step 4: Typecheck e os testes da fase 1 (o banco de mentira ainda satisfaz a porta)**

Run: `pnpm typecheck && pnpm exec vitest run lib/channels/telefonia/`
Expected: `tsc` sem erro e PASS em todos os testes da telefonia.

- [ ] **Step 5: A prova no Postgres real**

Run: `pnpm test:db tests/invariants/telefonia-repositorio-da-ura.test.ts`
Expected: PASS (11 testes).

- [ ] **Step 6: Commit**

```bash
git add lib/channels/telefonia/repositorio.ts tests/invariants/telefonia-repositorio-da-ura.test.ts
git commit -m "feat(telefonia): o banco do worker conhece a URA, as falas e o aviso do time

Situação do time separa fora do horário de ninguém disponível; menu, falas gerais
e aviso só voltam prontos e da organização do tronco; o aviso vencido para de
tocar na hora; a passada desliga os vencidos com auditoria e aviso na Central; e
o cartão da ligação leva a escolha do menu e o aviso ouvido. Provado em Postgres
real.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: As falas no disco — do Storage para o volume que o Asterisk lê

**Files:**
- Create: `lib/channels/telefonia/falas-no-disco.ts`, `lib/channels/telefonia/falas-no-disco.test.ts`

**Ramo B (só se a Task 0 terminou em "ramo B"):** use `export const DIRETORIO_NO_ASTERISK = "deskcomm";` no Step 3 e, no teste, espere `sound:deskcomm/<org>/<hash>`. O resto da task não muda.

- [ ] **Step 1: Teste (falha: o módulo não existe)**

Crie `lib/channels/telefonia/falas-no-disco.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { FalasNoDisco, caminhoValido, midiaDaFala } from "./falas-no-disco";

const ORG = "00000000-0000-4000-8000-00000000000a";
const caminho = (c: string) => `${ORG}/${c.repeat(64)}.ulaw`;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let dir: string;
let prontas: string[];
let objetos: Map<string, Uint8Array>;
let baixar: ReturnType<typeof vi.fn>;

const db: Queryable = {
  query: (async () => ({ rows: prontas.map((storage_path) => ({ storage_path })), rowCount: prontas.length })) as unknown as Queryable["query"],
};
const disco = () =>
  new FalasNoDisco(dir, db, { baixar: baixar as unknown as (c: string) => Promise<Uint8Array<ArrayBuffer> | null> }, log);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "falas-"));
  prontas = [];
  objetos = new Map();
  baixar = vi.fn(async (c: string) => (objetos.has(c) ? new Uint8Array(objetos.get(c)!) : null));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("o endereço de mídia e a régua do caminho", () => {
  it("sound: + caminho absoluto SEM extensão (o Asterisk escolhe o formato pelo arquivo)", () => {
    expect(midiaDaFala(caminho("a"))).toBe(`sound:/var/lib/deskcomm/falas/${ORG}/${"a".repeat(64)}`);
  });

  it("só aceita <uuid>/<sha256>.ulaw — nada de subir diretório", () => {
    expect(caminhoValido(caminho("a"))).toBe(true);
    expect(caminhoValido(`${ORG}/../../etc/passwd`)).toBe(false);
    expect(caminhoValido(`outra/${"a".repeat(64)}.ulaw`)).toBe(false);
  });
});

describe("garantir — antes de tocar", () => {
  it("arquivo que já está no disco: não baixa", async () => {
    await mkdir(join(dir, ORG), { recursive: true });
    await writeFile(join(dir, caminho("a")), new Uint8Array([1]));
    expect(await disco().garantir({ id: "f1", storagePath: caminho("a") })).toBe(midiaDaFala(caminho("a")));
    expect(baixar).not.toHaveBeenCalled();
  });

  it("arquivo ausente: baixa na hora, grava 0644 dentro de pasta 0755", async () => {
    objetos.set(caminho("b"), new Uint8Array([0xff, 0x7f]));
    expect(await disco().garantir({ id: "f2", storagePath: caminho("b") })).toBe(midiaDaFala(caminho("b")));
    expect([...(await readFile(join(dir, caminho("b"))))]).toEqual([0xff, 0x7f]);
    expect((await stat(join(dir, caminho("b")))).mode & 0o777).toBe(0o644);
    expect((await stat(join(dir, ORG))).mode & 0o777).toBe(0o755);
  });

  it("nem no disco nem no Storage: null (a ligação pula a fala)", async () => {
    expect(await disco().garantir({ id: "f3", storagePath: caminho("c") })).toBeNull();
  });

  it("caminho fora da régua: null, sem baixar", async () => {
    expect(await disco().garantir({ id: "f4", storagePath: `${ORG}/../x.ulaw` })).toBeNull();
    expect(baixar).not.toHaveBeenCalled();
  });
});

describe("sincronizar — a passada de 60 s", () => {
  it("baixa as prontas que faltam e apaga só os órfãos VELHOS", async () => {
    prontas = [caminho("a"), caminho("b")];
    objetos.set(caminho("a"), new Uint8Array([1]));
    objetos.set(caminho("b"), new Uint8Array([2]));
    await mkdir(join(dir, ORG), { recursive: true });
    await writeFile(join(dir, caminho("a")), new Uint8Array([1]));
    await writeFile(join(dir, caminho("d")), new Uint8Array([4]));
    await writeFile(join(dir, caminho("e")), new Uint8Array([5]));
    const velho = new Date(Date.now() - 10 * 60_000);
    await utimes(join(dir, caminho("d")), velho, velho);

    const r = await disco().sincronizar();

    expect(r).toEqual({ baixadas: 1, apagadas: 1, falhas: 0 });
    expect(baixar).toHaveBeenCalledTimes(1);
    await expect(stat(join(dir, caminho("b")))).resolves.toBeTruthy();
    await expect(stat(join(dir, caminho("d")))).rejects.toThrow();
    // Recém-escrito não é órfão ainda: a fala pode ter nascido depois da leitura do banco.
    await expect(stat(join(dir, caminho("e")))).resolves.toBeTruthy();
  });

  it("fala pronta que o Storage não devolve conta como falha, e não derruba a passada", async () => {
    prontas = [caminho("z")];
    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 1 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/falas-no-disco.test.ts`
Expected: FAIL — `Failed to resolve import "./falas-no-disco"`.

- [ ] **Step 3: Implementar**

Crie `lib/channels/telefonia/falas-no-disco.ts`:

```ts
/**
 * AS FALAS DO TELEFONE NO DISCO — do Storage para o volume que o Asterisk lê
 * (desenho da fase 2, §4 e D12).
 *
 * O Storage é a fonte da verdade; o volume `telefonia-falas` é cópia. O worker o
 * monta com escrita, o Asterisk só com leitura (docker-compose.prod.yml). Dois
 * caminhos:
 *   - a passada de 60 s (`sincronizar`): baixa as falas prontas que faltam e
 *     apaga os arquivos que nenhuma fala pronta referencia mais;
 *   - antes de tocar (`garantir`): o arquivo existe? se não, baixa na hora. Não
 *     deu → `null`, e a ligação pula a fala (o controlador avisa na Central).
 *
 * Escrita atômica (temporário + `rename`): o Asterisk nunca abre um arquivo pela
 * metade. Permissões 0644/0755: o Asterisk roda como o usuário `asterisk` e só lê;
 * o worker roda como root. Medido no passo zero (Task 0 do plano da fase 2).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { PortaDoArmazem } from "@/lib/telefonia/armazem";

import type { Registro } from "./controle";
import type { FalaDoBanco } from "./repositorio";

/** Onde o worker escreve: o volume `telefonia-falas`, montado com escrita no serviço `worker`. */
export const DIRETORIO_DAS_FALAS = "/var/lib/deskcomm/falas";
/**
 * Como o Asterisk enxerga o MESMO volume (só leitura). Passo zero, ramo A:
 * caminho absoluto, no mesmo ponto de montagem do worker.
 */
export const DIRETORIO_NO_ASTERISK = "/var/lib/deskcomm/falas";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CAMINHO_VALIDO = new RegExp(`^${UUID}/[0-9a-f]{64}\\.ulaw$`);
const ORG_VALIDA = new RegExp(`^${UUID}$`);
/** Arquivo recém-escrito não é órfão ainda: a fala pode ter nascido depois da leitura do banco. */
const CARENCIA_DO_ORFAO_MS = 5 * 60_000;

/** A mesma régua do CHECK `phone_prompts_storage_path_check`: `<org>/<sha256>.ulaw`, nada de `..`. */
export function caminhoValido(storagePath: string): boolean {
  return CAMINHO_VALIDO.test(storagePath);
}

/** O endereço que a ARI toca: `sound:` + caminho SEM a extensão. */
export function midiaDaFala(storagePath: string): string {
  return `sound:${DIRETORIO_NO_ASTERISK}/${storagePath.replace(/\.ulaw$/, "")}`;
}

async function existe(caminho: string): Promise<boolean> {
  try {
    return (await stat(caminho)).isFile();
  } catch {
    return false;
  }
}

export class FalasNoDisco {
  constructor(
    private readonly dir: string,
    private readonly db: Queryable,
    private readonly armazem: Pick<PortaDoArmazem, "baixar">,
    private readonly log: Registro,
    private readonly agora: () => number = Date.now,
  ) {}

  private arquivo(storagePath: string): string {
    return join(this.dir, storagePath);
  }

  /** O endereço de mídia com o arquivo garantido no disco, ou `null`. Nunca lança. */
  async garantir(fala: FalaDoBanco): Promise<string | null> {
    if (!caminhoValido(fala.storagePath)) {
      this.log.warn("telefonia: caminho de fala fora da régua — não tocado", { fala: fala.id });
      return null;
    }
    if (await existe(this.arquivo(fala.storagePath))) return midiaDaFala(fala.storagePath);
    return (await this.baixar(fala.storagePath)) ? midiaDaFala(fala.storagePath) : null;
  }

  private async baixar(storagePath: string): Promise<boolean> {
    try {
      const bytes = await this.armazem.baixar(storagePath);
      if (!bytes || bytes.length === 0) {
        this.log.warn("telefonia: fala ausente no Storage", { caminho: storagePath });
        return false;
      }
      const pasta = join(this.dir, storagePath.split("/")[0]!);
      await mkdir(pasta, { recursive: true, mode: 0o755 });
      await chmod(pasta, 0o755);
      const temporario = join(pasta, `.${randomBytes(6).toString("hex")}.tmp`);
      await writeFile(temporario, bytes, { mode: 0o644 });
      await chmod(temporario, 0o644);
      await rename(temporario, this.arquivo(storagePath));
      return true;
    } catch (e) {
      this.log.warn("telefonia: fala não gravada no disco", {
        caminho: storagePath,
        erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
      return false;
    }
  }

  async sincronizar(): Promise<{ baixadas: number; apagadas: number; falhas: number }> {
    const { rows } = await this.db.query<{ storage_path: string }>(
      "select distinct storage_path from phone_prompts where status = 'ready' and storage_path is not null",
    );
    const prontas = new Set(rows.map((r) => r.storage_path));
    let baixadas = 0;
    let falhas = 0;
    let apagadas = 0;
    for (const c of prontas) {
      if (!caminhoValido(c) || (await existe(this.arquivo(c)))) continue;
      if (await this.baixar(c)) baixadas++;
      else falhas++;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o755 });
    for (const org of await readdir(this.dir).catch(() => [] as string[])) {
      if (!ORG_VALIDA.test(org)) continue;
      const pasta = join(this.dir, org);
      for (const nome of await readdir(pasta).catch(() => [] as string[])) {
        const caminho = join(pasta, nome);
        const info = await stat(caminho).catch(() => null);
        if (!info?.isFile() || prontas.has(`${org}/${nome}`)) continue;
        if (this.agora() - info.mtimeMs < CARENCIA_DO_ORFAO_MS) continue;
        await unlink(caminho).catch(() => undefined);
        apagadas++;
      }
    }
    if (baixadas || apagadas || falhas) this.log.info("telefonia: falas sincronizadas no disco", { baixadas, apagadas, falhas });
    return { baixadas, apagadas, falhas };
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia/falas-no-disco.test.ts`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/channels/telefonia/falas-no-disco.ts lib/channels/telefonia/falas-no-disco.test.ts
git commit -m "feat(telefonia): as falas prontas chegam ao volume que o Asterisk lê

A passada de 60 s baixa do Storage o que falta e apaga os órfãos velhos; antes de
tocar, a fala é garantida no disco ou pulada. Escrita atômica, 0644/0755, e o
caminho conferido pela mesma régua do CHECK.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: ARI toca a fala; o ramal não transfere por REFER

**Files:**
- Modify: `lib/channels/telefonia/ari.ts` (logo depois de `pararReproducao`, ~linha 223)
- Create: `lib/channels/telefonia/ari.test.ts`
- Modify: `lib/channels/telefonia/pjsip.ts:225` (campos do endpoint de `objetosDoRamal`)
- Modify: `lib/channels/telefonia/pjsip.test.ts`

- [ ] **Step 1: Testes que falham**

Crie `lib/channels/telefonia/ari.test.ts`:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClienteAri } from "./ari";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClienteAri.tocarFala", () => {
  it("POST /channels/<id>/play com a mídia na query e a senha SÓ no header", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "pb-1" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const ari = new ClienteAri({ baseUrl: "http://asterisk:8088", senha: "segredo-ari" });

    const r = await ari.tocarFala("canal-1", "sound:/var/lib/deskcomm/falas/org/abc");

    expect(r).toEqual({ id: "pb-1" });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "http://asterisk:8088/ari/channels/canal-1/play?media=sound%3A%2Fvar%2Flib%2Fdeskcomm%2Ffalas%2Forg%2Fabc",
    );
    expect(init.method).toBe("POST");
    expect(String(url)).not.toContain("segredo-ari");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
});
```

No FIM de `lib/channels/telefonia/pjsip.test.ts`, acrescente:

```ts
describe("o ramal do navegador não transfere por REFER (rede de proteção da fase 2, §5.3)", () => {
  it("allow_transfer=no no endpoint do ramal", () => {
    const endpoint = objetosDoRamal({ userId: "u1", senha: "s".repeat(32), nome: "Ana" }).find((o) => o.tipo === "endpoint");
    expect(campo(endpoint, "allow_transfer")).toEqual(["no"]);
  });
});
```

e acrescente `objetosDoRamal` à lista de nomes importados de `./pjsip` no topo desse arquivo (o import passa a ter `objetosDoRamal` ao lado de `objetosDoTronco`).

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/ari.test.ts lib/channels/telefonia/pjsip.test.ts`
Expected: FAIL — `ari.tocarFala is not a function` e `expected [] to deeply equal [ 'no' ]`.

- [ ] **Step 3: Implementar**

Em `lib/channels/telefonia/ari.ts`, logo depois do método `pararReproducao` (antes de `listarCanais`), acrescente:

```ts
  /**
   * Toca uma fala do telefone no canal (URA, aguarde, aviso). `midia` é
   * `sound:<caminho SEM extensão>` — o Asterisk escolhe o arquivo pelo formato
   * (`.ulaw`). Devolve o playback, cujo fim chega como `PlaybackFinished`.
   */
  tocarFala(canalId: string, midia: string) {
    return this.pedir<{ id: string }>("POST", `/channels/${canalId}/play`, { query: { media: midia } });
  }
```

Em `lib/channels/telefonia/pjsip.ts`, em `objetosDoRamal`, logo depois da linha `        f("rtp_timeout", 30),` (e do comentário dela), acrescente:

```ts
        // Transferência por REFER fechada (desenho da fase 2, §5.3): quem transfere
        // é o CRM, pela ARI, com a regra de quem pode e para onde. Um REFER vindo
        // do navegador mandaria o cliente para qualquer lugar sem passar por ela.
        // Ramais já registrados recebem o campo quando o Asterisk é recriado — o
        // que o `update.sh` faz nesta versão, porque o serviço ganha um volume.
        f("allow_transfer", "no"),
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia/ari.test.ts lib/channels/telefonia/pjsip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/channels/telefonia/ari.ts lib/channels/telefonia/ari.test.ts lib/channels/telefonia/pjsip.ts lib/channels/telefonia/pjsip.test.ts
git commit -m "feat(telefonia): a ARI toca a fala da URA, e o ramal não transfere por REFER

tocarFala pela ARI (senha só no header). allow_transfer=no nos ramais: a
transferência é do CRM, com regra, nunca do navegador.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: O controlador — as falas na fila do time (§5.2)

**Files:**
- Modify: `lib/channels/telefonia/controle.ts` (arquivo inteiro — o novo texto está no Step 3)
- Modify: `lib/channels/telefonia/controle.test.ts` (linhas 1–183: imports, dublês e `beforeEach`; e um `describe` novo no fim)
- Modify: `lib/channels/telefonia/laco.ts` (`portaAri` 25–52 e `portaBanco` 54–71)

O que muda na ligação que chega a um TIME (a regra do toque — rodízio, 20 s, 2 voltas, 120 s — fica intacta):
1. **Fora do horário com fala pronta** → atende, toca "fora do horário" e desliga (`end_reason=after_hours`, sem aviso na Central). Sem fala, segue a fase 1.
2. **Aviso de instabilidade vigente** → atende e toca o aviso INTEIRO (tecla não interrompe); ouvido até o fim → `emergency_heard_at`; depois, os ramais.
3. **Quem espera** → "aguarde" em vez da música direto; música depois; "aguarde" de novo a cada 40 s (para a música, fala, volta a música).
4. **Atendente atende no meio de uma fala** → a fala para antes da ponte.
5. **Esgotou** → "ninguém atendeu" e só então desliga (perdida com aviso, como hoje).
6. **Fala sem arquivo ou que o Asterisk não tocou** → pulada, com `phone_prompt_unplayable` na Central.

- [ ] **Step 1: Trocar os dublês do teste (a porta cresce) e escrever os casos novos**

Em `lib/channels/telefonia/controle.test.ts`, substitua TUDO da linha 1 até a linha 183 (a definição de `ramalAtende`, inclusive) por:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanalAri } from "./ari";
import { ControladorDeChamadas, REPETIR_AGUARDE_MS, type PortaAri, type PortaBanco, type PortaFalas } from "./controle";
import type {
  FalaDoBanco,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  SituacaoDoTime,
  TroncoDoBanco,
} from "./repositorio";

const ORG = "00000000-0000-0000-0000-00000000000a";
const TRONCO = "11111111-1111-1111-1111-111111111111";
const TIME = "22222222-2222-2222-2222-222222222222";
const TIME2 = "33333333-3333-3333-3333-333333333333";
const MENU = "44444444-4444-4444-4444-444444444444";
const ANA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BIA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const tronco: TroncoDoBanco = {
  id: TRONCO,
  organizationId: ORG,
  numero: "+556136861503",
  nome: "Totus",
  servidor: "voip.exemplo.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  senha: "x",
  teamId: TIME,
  prefixo: null,
};

/** Uma fala pronta; o dublê do disco a entrega como `sound:/falas/<id>`. */
const falaDe = (id: string): FalaDoBanco => ({ id, storagePath: `${ORG}/${id}.ulaw` });

function canal(id: string, name: string, extra: Partial<CanalAri> = {}): CanalAri {
  return {
    id,
    name,
    state: "Ring",
    caller: { name: "", number: "61988887777" },
    connected: { name: "", number: "" },
    dialplan: { context: "de-tronco", exten: "6136861503", priority: 1 },
    creationtime: new Date().toISOString(),
    ...extra,
  };
}

class AriFalso implements PortaAri {
  chamadas: Array<[string, ...unknown[]]> = [];
  online = new Set<string>();
  private seq = 0;
  private seqFala = 0;
  pontesVivas: Array<{ id: string; channels: string[] }> = [];
  canaisVivos: Array<{ id: string }> = [];
  private reg(nome: string, ...args: unknown[]) {
    this.chamadas.push([nome, ...args]);
    return Promise.resolve(undefined);
  }
  atender = (c: string) => this.reg("atender", c);
  indicarChamando = (c: string) => this.reg("indicarChamando", c);
  desligar = (c: string, m?: string) => this.reg("desligar", c, m);
  originar = async (p: { endpoint: string; appArgs: string }) => {
    await this.reg("originar", p.endpoint, p.appArgs);
    return { id: `ramal-canal-${++this.seq}` };
  };
  criarCanal = async (p: { endpoint: string; appArgs: string; callerId?: string }) => {
    await this.reg("criarCanal", p.endpoint, p.appArgs, p.callerId);
    return { id: `perna-${++this.seq}` };
  };
  discar = (c: string, s: number) => this.reg("discar", c, s);
  criarPonte = async (id: string) => {
    await this.reg("criarPonte", id);
    return { id };
  };
  porNaPonte = (p: string, c: string) => this.reg("porNaPonte", p, c);
  destruirPonte = (p: string) => this.reg("destruirPonte", p);
  musicaDeEspera = (c: string) => this.reg("musicaDeEspera", c);
  pararMusica = (c: string) => this.reg("pararMusica", c);
  tocarTom = async (c: string, t: string) => {
    await this.reg("tocarTom", c, t);
    return { id: "tom-1" };
  };
  pararReproducao = (id: string) => this.reg("pararReproducao", id);
  tocarFala = async (c: string, m: string) => {
    await this.reg("tocarFala", c, m);
    return { id: `fala-${++this.seqFala}` };
  };
  pararFala = (id: string) => this.reg("pararFala", id);
  ramalOnline = async (u: string) => this.online.has(u);
  pontes = async () => this.pontesVivas;
  canais = async () => this.canaisVivos;

  nomes() {
    return this.chamadas.map((c) => c[0]);
  }
  originados() {
    return this.chamadas.filter((c) => c[0] === "originar").map((c) => c[1]);
  }
  ultimoOriginado() {
    const n = this.chamadas.filter((c) => c[0] === "originar").length;
    return `ramal-canal-${n}`;
  }
  /** As mídias tocadas, em ordem. */
  falas() {
    return this.chamadas.filter((c) => c[0] === "tocarFala").map((c) => c[2]);
  }
  ultimaFala() {
    return `fala-${this.seqFala}`;
  }
}

class BancoFalso implements PortaBanco {
  ligacoes = new Map<string, LigacaoDoBanco>();
  criadas: NovaLigacao[] = [];
  disponiveis: Array<{ userId: string; atendidasHoje: number; ultimaAtendidaEm: Date | null }> = [];
  timesConsultados: string[] = [];
  eventos: Array<[string, ...unknown[]]> = [];
  situacao: SituacaoDoTime = "aberto";
  gerais: FalasGerais = { aguarde: null, ninguem: null, foraDoHorario: null };
  aviso: FalaDoBanco | null = null;
  menus = new Map<string, MenuDoBanco>();
  private seq = 0;

  troncoAtual: TroncoDoBanco = tronco;
  troncoPorId = async (id: string) => (id === TRONCO ? this.troncoAtual : null);
  disponiveisNoTime = async (_o: string, teamId: string) => {
    this.timesConsultados.push(teamId);
    return this.disponiveis;
  };
  situacaoDoTime = async () => this.situacao;
  falasGerais = async () => this.gerais;
  emergenciaDoTime = async () => this.aviso;
  menuPorId = async (_o: string, id: string) => this.menus.get(id) ?? null;
  registrarMenu = async (id: string, m: { digito: string | null; desfecho: string }) => {
    this.eventos.push(["menu", id, m.digito, m.desfecho]);
  };
  definirTimeDaLigacao = async (id: string, teamId: string) => {
    this.eventos.push(["time", id, teamId]);
  };
  registrarAvisoOuvido = async (id: string) => {
    this.eventos.push(["ouviu_aviso", id]);
  };
  avisarFalaIntocavel = async (_o: string, rotulo: string) => {
    this.eventos.push(["fala_intocavel", rotulo]);
  };
  acharOuCriarContato = async () => "contato-1";
  acharOuCriarConversa = async () => "conversa-1";
  criarLigacao = async (l: NovaLigacao) => {
    this.criadas.push(l);
    const id = `vc-${++this.seq}`;
    this.ligacoes.set(id, {
      id,
      organization_id: l.organizationId,
      channel_session_id: l.troncoId,
      contact_id: l.contactId,
      conversation_id: l.conversationId,
      direction: l.direcao,
      peer_phone: l.numeroDoOutroLado,
      status: l.status,
      owner_user_id: null,
      created_by: null,
      team_id: l.teamId,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: l.sipCallRef,
      menu_id: l.menuId ?? null,
    });
    return id;
  };
  ligacaoPorId = async (id: string) => this.ligacoes.get(id) ?? null;
  ligacoesVivas = async () => [...this.ligacoes.values()].filter((l) => l.status !== "ended");
  marcarTocando = async (id: string, u: string | null) => {
    this.eventos.push(["tocando", id, u]);
  };
  marcarAtendida = async (id: string, u: string) => {
    const l = this.ligacoes.get(id)!;
    l.status = "connected";
    l.answered_at = new Date().toISOString();
    l.owner_user_id = l.owner_user_id ?? u;
    this.eventos.push(["atendida", id, u]);
  };
  encerrarLigacao = async (id: string, motivo: string) => {
    const l = this.ligacoes.get(id);
    if (!l || l.status === "ended") return null;
    l.status = "ended";
    this.eventos.push(["encerrada", id, motivo]);
    return { ...l };
  };
  atribuirConversa = async (_o: string, c: string, u: string) => {
    this.eventos.push(["atribuida", c, u]);
  };
  registrarNaConversa = async (l: LigacaoDoBanco, d: string) => {
    this.eventos.push(["registro", l.id, d]);
  };
  avisarPerdida = async (l: LigacaoDoBanco) => {
    this.eventos.push(["perdida", l.id]);
  };
  registrarFim = async (l: LigacaoDoBanco, d: string, m: string) => {
    this.eventos.push(["fim", l.id, d, m]);
  };
  tem(nome: string) {
    return this.eventos.filter((e) => e[0] === nome);
  }
}

/** O disco das falas: tudo está lá, menos o que o teste tirar. */
class FalasFalsas implements PortaFalas {
  semArquivo = new Set<string>();
  garantir = async (f: FalaDoBanco) => (this.semArquivo.has(f.id) ? null : `sound:/falas/${f.id}`);
}

const log = { info: () => undefined, warn: () => undefined, error: vi.fn() };

let ari: AriFalso;
let banco: BancoFalso;
let falas: FalasFalsas;
let ctl: ControladorDeChamadas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
  ari = new AriFalso();
  banco = new BancoFalso();
  falas = new FalasFalsas();
  ctl = new ControladorDeChamadas(ari, banco, log, () => Date.now(), falas);
  log.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  expect(log.error).not.toHaveBeenCalled();
});

const cliente = canal("cli-1", `PJSIP/tronco-${TRONCO}-00000001`);
const entrar = () => ctl.tratar({ type: "StasisStart", channel: cliente, args: ["entrada"] });
const destruir = (id: string, cause = 16) =>
  ctl.tratar({ type: "ChannelDestroyed", channel: canal(id, "x"), cause });
const ramalAtende = (canalId: string, vcId = "vc-1") =>
  ctl.tratar({ type: "StasisStart", channel: canal(canalId, "PJSIP/ramal-x-00000009"), args: ["oferta", vcId] });
const terminou = (id: string, state = "done") => ctl.tratar({ type: "PlaybackFinished", playback: { id, state } });
```

(Os `describe` existentes — "recebida", "feita", "feita — prefixo…", "feita — a operadora recusa…", "recuperar após reinício" — ficam como estão, depois deste bloco.)

No FIM do arquivo, acrescente:

```ts
describe("fila do time — as falas da fase 2 (§5.2)", () => {
  const FORA = falaDe("fora");
  const AVISO = falaDe("aviso");
  const AGUARDE = falaDe("aguarde");
  const NINGUEM = falaDe("ninguem");
  const anaDisponivel = () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  };

  it("time fora do horário COM fala: atende, toca e desliga — sem aviso de perdida na Central", async () => {
    banco.situacao = "fora_do_horario";
    banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
    await entrar();
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/fora"]);
    expect(ari.originados()).toEqual([]);
    expect(banco.tem("encerrada")).toEqual([]);

    await terminou("fala-1");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "perdida"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("o cliente desliga durante o 'fora do horário': continua sem aviso de perdida", async () => {
    banco.situacao = "fora_do_horario";
    banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
    await entrar();
    await destruir("cli-1");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("fora do horário SEM fala gerada: segue a fase 1 — fila e perdida com aviso", async () => {
    banco.situacao = "fora_do_horario";
    await entrar();
    expect(ari.falas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(banco.tem("perdida")).toHaveLength(1);
  });

  it("aviso de instabilidade: toca INTEIRO antes dos ramais, tecla não interrompe, e fica o 'ouviu'", async () => {
    banco.aviso = AVISO;
    anaDisponivel();
    await entrar();
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/aviso"]);
    expect(ari.originados()).toEqual([]);

    await ctl.tratar({ type: "ChannelDtmfReceived", channel: cliente, digit: "1" });
    expect(ari.nomes()).not.toContain("pararFala");

    await terminou("fala-1");
    expect(banco.tem("ouviu_aviso")).toEqual([["ouviu_aviso", "vc-1"]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
  });

  it("aviso sem arquivo no disco: pula, avisa na Central e segue para os ramais, sem 'ouviu'", async () => {
    banco.aviso = AVISO;
    falas.semArquivo.add(AVISO.id);
    anaDisponivel();
    await entrar();
    expect(ari.falas()).toEqual([]);
    expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", "aviso de instabilidade"]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    expect(banco.tem("ouviu_aviso")).toEqual([]);
  });

  it("o Asterisk não conseguiu tocar (PlaybackFinished failed): avisa e segue, sem 'ouviu'", async () => {
    banco.aviso = AVISO;
    anaDisponivel();
    await entrar();
    await terminou("fala-1", "failed");
    expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", "aviso de instabilidade"]]);
    expect(banco.tem("ouviu_aviso")).toEqual([]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
  });

  it("quem espera ouve 'aguarde', depois a música, e o 'aguarde' volta a cada 40 s", async () => {
    banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
    await entrar();
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/aguarde"]);
    expect(ari.nomes()).not.toContain("musicaDeEspera");

    await terminou("fala-1");
    expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);

    await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
    expect(ari.falas()).toEqual(["sound:/falas/aguarde", "sound:/falas/aguarde"]);
    const nomes = ari.nomes();
    expect(nomes.lastIndexOf("pararMusica")).toBeLessThan(nomes.lastIndexOf("tocarFala"));
  });

  it("atendente atende NO MEIO do 'aguarde': a fala para antes da ponte, e o fim atrasado dela não religa a música", async () => {
    banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
    await entrar();
    anaDisponivel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

    await ramalAtende(ari.ultimoOriginado());
    const nomes = ari.nomes();
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(nomes.indexOf("pararFala")).toBeLessThan(nomes.indexOf("criarPonte"));
    expect(banco.tem("atendida")).toHaveLength(1);

    const antes = ari.chamadas.length;
    await terminou("fala-1");
    expect(ari.chamadas.slice(antes)).toEqual([]);
  });

  it("esgotou a fila: toca 'ninguém atendeu' e só desliga no fim da fala (perdida com aviso)", async () => {
    banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
    await entrar();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(ari.falas()).toEqual(["sound:/falas/ninguem"]);
    expect(banco.tem("encerrada")).toEqual([]);

    await terminou(ari.ultimaFala());
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(banco.tem("perdida")).toHaveLength(1);
  });

  it("o cliente desliga durante o 'ninguém atendeu': vale o motivo original", async () => {
    banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
    await entrar();
    await vi.advanceTimersByTimeAsync(125_000);
    await destruir("cli-1");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/controle.test.ts`
Expected: FAIL — `REPETIR_AGUARDE_MS` não é exportado e o construtor ignora o dublê do disco (nenhuma fala tocada: `expected [] to deeply equal [ 'sound:/falas/fora' ]`).

- [ ] **Step 3: O controlador novo**

Substitua o conteúdo INTEIRO de `lib/channels/telefonia/controle.ts` por:

```ts
/**
 * O CÉREBRO DA TELEFONIA — a aplicação Stasis `crm` (spec 20 §4.2; fase 2 em
 * docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md).
 *
 * O Asterisk entrega aqui toda ligação (o dialplan só diz `Stasis(crm)`),
 * e este controlador decide tudo o que não é áudio:
 *
 *   RECEBIDA  tronco → contato/conversa/voice_calls → FILA DO TIME:
 *             time fora do horário, com a fala pronta → "fora do horário" e
 *             desliga (sem aviso de perdida); aviso de instabilidade ligado →
 *             toca o aviso INTEIRO; então toca UM ramal por vez, quem atendeu
 *             menos hoje primeiro, 20 s cada, 2 voltas → ponte. Quem espera
 *             ouve "aguarde", música, e o "aguarde" de novo a cada ~40 s, até
 *             2 min contados da entrada na fila. Esgotou: "ninguém atendeu" e
 *             desliga, e a ligação vira "Ligar de volta" na Central.
 *   FEITA     o ramal disca `c-<voice_call_id>` → confere que a API criou essa
 *             ligação para ESTE atendente há menos de 60 s → cria a perna da
 *             operadora, põe as duas numa ponte e disca.
 *
 * Fala sem arquivo no disco, ou que o Asterisk não conseguiu tocar, é PULADA —
 * a ligação segue — e vira `phone_prompt_unplayable` na Central.
 *
 * Estado em memória por ligação. Se o worker reinicia no meio de uma ligação,
 * `recuperar()` reencontra as pontes vivas pelo nome (`p-<voice_call_id>`) e
 * volta a vigiar o fim delas; o que estava só tocando é encerrado como perdido.
 *
 * ARI, banco e disco das falas entram como PORTAS (interfaces): o teste troca os
 * três por dublês e exercita a máquina de estados inteira sem Asterisk nem Postgres.
 */
import {
  ESPERA_NA_FILA_MS,
  ESTADO_INICIAL,
  REAVALIAR_FILA_MS,
  TOQUE_POR_ATENDENTE_MS,
  proximoToque,
  type CandidatoAoToque,
  type EstadoDoToque,
} from "@/lib/telefonia/distribuicao";
import { RECUSA_DA_SAIDA, fimDaSaidaNaoAtendida } from "@/lib/telefonia/fim-da-saida";
import { binaParaE164, numeroParaLigar } from "@/lib/telefonia/numero";
import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";

import type { CanalAri } from "./ari";
import { donoDoEndpoint, endpointDoCanal, enderecoDeSaida, idDoRamal } from "./pjsip";
import type {
  DesfechoDaLigacao,
  FalaDoBanco,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  SituacaoDoTime,
  TroncoDoBanco,
} from "./repositorio";

// ─── portas ────────────────────────────────────────────────────────────────

export interface PortaAri {
  atender(canal: string): Promise<unknown>;
  indicarChamando(canal: string): Promise<unknown>;
  desligar(canal: string, motivo?: "normal" | "busy" | "congestion" | "no_answer"): Promise<unknown>;
  originar(p: {
    endpoint: string;
    appArgs: string;
    callerId?: string;
    prazoS: number;
    variaveis?: Record<string, string>;
  }): Promise<{ id: string }>;
  criarCanal(p: { endpoint: string; appArgs: string; callerId?: string }): Promise<{ id: string }>;
  discar(canal: string, prazoS: number): Promise<unknown>;
  criarPonte(id: string): Promise<{ id: string }>;
  porNaPonte(ponte: string, canal: string): Promise<unknown>;
  destruirPonte(ponte: string): Promise<unknown>;
  musicaDeEspera(canal: string): Promise<unknown>;
  pararMusica(canal: string): Promise<unknown>;
  tocarTom(canal: string, tom: "ring" | "busy" | "congestion"): Promise<{ id: string }>;
  pararReproducao(id: string): Promise<unknown>;
  /** Toca uma fala do telefone (`sound:<caminho sem extensão>`); o fim chega como `PlaybackFinished`. */
  tocarFala(canal: string, midia: string): Promise<{ id: string }>;
  pararFala(playbackId: string): Promise<unknown>;
  /** O ramal está registrado (há navegador para tocar)? */
  ramalOnline(userId: string): Promise<boolean>;
  /** Pontes vivas com os canais de cada uma — para `recuperar()`. */
  pontes(): Promise<Array<{ id: string; channels: string[] }>>;
  canais(): Promise<Array<{ id: string }>>;
}

export interface PortaBanco {
  troncoPorId(id: string): Promise<TroncoDoBanco | null>;
  disponiveisNoTime(org: string, teamId: string, agora: Date): Promise<CandidatoAoToque[]>;
  situacaoDoTime(org: string, teamId: string, agora: Date): Promise<SituacaoDoTime>;
  falasGerais(org: string): Promise<FalasGerais>;
  emergenciaDoTime(org: string, teamId: string, agora: Date): Promise<FalaDoBanco | null>;
  menuPorId(org: string, menuId: string): Promise<MenuDoBanco | null>;
  registrarMenu(id: string, m: { digito: string | null; desfecho: "chosen" | "default_no_input" | "default_invalid" }): Promise<void>;
  definirTimeDaLigacao(id: string, teamId: string): Promise<void>;
  registrarAvisoOuvido(id: string): Promise<void>;
  avisarFalaIntocavel(org: string, rotulo: string): Promise<void>;
  acharOuCriarContato(org: string, e164: string, nome: string | null): Promise<string>;
  acharOuCriarConversa(org: string, contactId: string, troncoId: string, teamId: string | null): Promise<string>;
  criarLigacao(l: NovaLigacao): Promise<string>;
  ligacaoPorId(id: string): Promise<LigacaoDoBanco | null>;
  ligacoesVivas(): Promise<LigacaoDoBanco[]>;
  marcarTocando(id: string, userId: string | null): Promise<void>;
  marcarAtendida(id: string, userId: string): Promise<void>;
  encerrarLigacao(id: string, motivo: string): Promise<LigacaoDoBanco | null>;
  atribuirConversa(org: string, conversationId: string, userId: string): Promise<void>;
  registrarNaConversa(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, duracaoMs: number | null): Promise<void>;
  avisarPerdida(l: LigacaoDoBanco): Promise<void>;
  registrarFim(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, motivo: string): Promise<void>;
}

/** O disco das falas (`falas-no-disco.ts`): o endereço de mídia com o arquivo garantido, ou `null`. */
export interface PortaFalas {
  garantir(fala: FalaDoBanco): Promise<string | null>;
}

/** Sem disco (instalação antiga, teste da fase 1): nenhuma fala toca, e a fila segue a fase 1. */
const SEM_FALAS: PortaFalas = { garantir: async () => null };

export interface Registro {
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
  error(msg: string, campos?: Record<string, unknown>): void;
}

// ─── eventos da ARI que importam ───────────────────────────────────────────

export type EventoAri =
  | { type: "StasisStart"; channel: CanalAri; args: string[] }
  | { type: "StasisEnd"; channel: CanalAri }
  | { type: "ChannelDestroyed"; channel: CanalAri; cause: number; cause_txt?: string }
  | { type: "Dial"; peer: CanalAri; dialstatus: string }
  | { type: "ChannelDtmfReceived"; channel: CanalAri; digit: string; duration_ms?: number }
  | { type: "PlaybackFinished"; playback: { id: string; state?: string } }
  | { type: string; [k: string]: unknown };

// ─── estado por ligação ────────────────────────────────────────────────────

/** Para que serve a fala tocando agora — decide o que vem depois dela. */
type PapelDaFala = "aviso" | "espera" | "fora_do_horario" | "ninguem";

interface FalaEmCurso {
  playbackId: string;
  papel: PapelDaFala;
  /** Como a Central chama esta fala se ela não tocar ("aguarde", "menu Principal"…). */
  rotulo: string;
}

interface Recebida {
  tipo: "recebida";
  vcId: string;
  org: string;
  tronco: TroncoDoBanco;
  cliente: string;
  numeroExibido: string;
  /** Início do relógio da FILA (entrada na fila do time, não o início da ligação — §5.1.3). */
  inicio: number;
  estado: EstadoDoToque;
  ramal: { canal: string; userId: string } | null;
  atendidaPor: string | null;
  conversationId: string | null;
  atendidaPelaRede: boolean;
  /** Atendida e segurando (música ou "aguarde"): o cliente já está esperando. */
  segurando: boolean;
  naFila: boolean;
  inicioFila: number | null;
  ponte: string | null;
  relogio: ReturnType<typeof setTimeout> | null;
  /** O time da ligação: o do número (ou, com a URA, o escolhido). */
  teamId: string | null;
  falasGerais: FalasGerais | null;
  fala: FalaEmCurso | null;
  relogioDaEspera: ReturnType<typeof setTimeout> | null;
  /** Motivo do fim enquanto a última fala toca ("fora do horário", "ninguém atendeu"). */
  encerrando: string | null;
  fim: boolean;
}

interface Feita {
  tipo: "feita";
  vcId: string;
  org: string;
  userId: string;
  ramal: string;
  perna: string | null;
  ponte: string;
  tom: string | null;
  atendida: boolean;
  /** Chegou `Dial` RINGING (180) ou PROGRESS (183): a rede completou até o telefone. */
  tocou: boolean;
  causaDaRede: number | null;
  fim: boolean;
}

/** Só a vigia do fim: ligação reencontrada depois de um reinício do worker. */
interface Recuperada {
  tipo: "recuperada";
  vcId: string;
  ponte: string;
  canais: string[];
  fim: boolean;
}

type Ligacao = Recebida | Feita | Recuperada;

/** Depois de tocar tanto sem atender, a rede pode derrubar a ligação: atende e segue na fila. */
const ATENDER_E_SEGURAR_APOS_MS = 45_000;
/** Ligação de saída: prazo para a pessoa do outro lado atender. */
const PRAZO_DA_SAIDA_S = 60;
/** A API cria a voice_calls e o navegador disca logo em seguida — mais que isto é reuso. */
const VALIDADE_DO_PEDIDO_DE_SAIDA_MS = 60_000;
/** Entre um "aguarde" e o próximo, a música toca por este tempo (desenho §5.2.4: ~40 s). */
export const REPETIR_AGUARDE_MS = 40_000;

const ponteDe = (vcId: string) => `p-${vcId}`;

export class ControladorDeChamadas {
  private readonly porCanal = new Map<string, Ligacao>();
  private readonly porId = new Map<string, Ligacao>();
  /** A que ligação pertence cada fala tocando — o `PlaybackFinished` só traz o id dela. */
  private readonly porReproducao = new Map<string, Recebida>();
  /** Última causa Q.850 vista por canal (ChannelHangupRequest), para quando o fim chega sem ela. */
  private readonly causas = new Map<string, number>();
  /**
   * Por onde os relógios (toque vencido, reavaliar a fila, repetir o aguarde)
   * entram. O laço do worker troca por sua fila serial, para um relógio nunca
   * rodar no meio do tratamento de um evento da mesma ligação.
   */
  private emFila: (fn: () => Promise<void>) => Promise<void> = (fn) => fn();

  usarFila(fila: (fn: () => Promise<void>) => Promise<void>) {
    this.emFila = fila;
  }

  constructor(
    private readonly ari: PortaAri,
    private readonly banco: PortaBanco,
    private readonly log: Registro,
    private readonly agora: () => number = Date.now,
    private readonly falas: PortaFalas = SEM_FALAS,
  ) {}

  /** Quantas ligações o controlador está acompanhando (para /healthz e testes). */
  get ativas(): number {
    return this.porId.size;
  }

  async tratar(ev: EventoAri): Promise<void> {
    try {
      switch (ev.type) {
        case "StasisStart":
          return await this.aoEntrarNoStasis(ev as Extract<EventoAri, { type: "StasisStart" }>);
        // StasisEnd também é fim: canal desligado DENTRO do Stasis pode sair da
        // aplicação sem que o ChannelDestroyed chegue depois (a aplicação deixa
        // de assinar o canal). Os dois caminhos são idempotentes.
        case "StasisEnd":
        case "ChannelDestroyed":
          return await this.aoDestruirCanal(ev as Extract<EventoAri, { type: "ChannelDestroyed" }>);
        case "ChannelHangupRequest": {
          const h = ev as { channel?: { id: string }; cause?: number };
          if (h.channel?.id && typeof h.cause === "number") this.causas.set(h.channel.id, h.cause);
          return;
        }
        case "Dial":
          return await this.aoDiscar(ev as Extract<EventoAri, { type: "Dial" }>);
        case "PlaybackFinished":
          return await this.aoTerminarFala(ev as Extract<EventoAri, { type: "PlaybackFinished" }>);
        default:
          return;
      }
    } catch (e) {
      this.log.error("telefonia: evento falhou", {
        tipo: ev.type,
        erro: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  // ─── entrada no Stasis ───────────────────────────────────────────────────

  private async aoEntrarNoStasis(ev: Extract<EventoAri, { type: "StasisStart" }>) {
    const [papel, vcId] = ev.args;
    if (papel === "entrada") return this.novaRecebida(ev.channel);
    if (papel === "saida") return this.novaFeita(ev.channel);
    if (papel === "oferta" && vcId) return this.ramalAtendeu(ev.channel, vcId);
    // "perna": a perna da operadora nasce já dentro do Stasis (channels/create);
    // quem cuida dela é a ligação feita, pelos eventos Dial e ChannelDestroyed.
    if (papel === "perna") return;
    this.log.warn("telefonia: canal sem papel conhecido — desligado", { canal: ev.channel.name, papel });
    await this.ari.desligar(ev.channel.id);
  }

  private registrar(l: Ligacao, canal: string) {
    this.porCanal.set(canal, l);
    this.porId.set(l.vcId, l);
  }

  // ─── recebida ────────────────────────────────────────────────────────────

  private async novaRecebida(canal: CanalAri) {
    const endpoint = endpointDoCanal(canal.name);
    const dono = endpoint ? donoDoEndpoint(endpoint) : null;
    if (dono?.tipo !== "tronco") {
      this.log.warn("telefonia: entrada que não veio de tronco — desligada", { canal: canal.name });
      await this.ari.desligar(canal.id, "congestion");
      return;
    }
    const tronco = await this.banco.troncoPorId(dono.id);
    if (!tronco) {
      this.log.warn("telefonia: tronco desconhecido ou arquivado — desligada", { tronco: dono.id });
      await this.ari.desligar(canal.id, "congestion");
      return;
    }

    // O chamar que quem ligou ouve enquanto escolhemos quem atende.
    await this.ari.indicarChamando(canal.id).catch(() => undefined);

    const teamId = tronco.teamId;
    const e164 = binaParaE164(canal.caller.number);
    let contactId: string | null = null;
    let conversationId: string | null = null;
    if (e164) {
      contactId = await this.banco.acharOuCriarContato(tronco.organizationId, e164, canal.caller.name || null);
      conversationId = await this.banco.acharOuCriarConversa(tronco.organizationId, contactId, tronco.id, teamId);
    }
    const vcId = await this.banco.criarLigacao({
      organizationId: tronco.organizationId,
      troncoId: tronco.id,
      sipCallRef: canal.id,
      direcao: "inbound",
      numeroDoOutroLado: e164 ?? (canal.caller.number || "desconhecido"),
      contactId,
      conversationId,
      teamId,
      status: "ringing",
    });

    const l = this.novoEstadoDaRecebida(vcId, tronco, canal, e164, conversationId, teamId);
    this.registrar(l, canal.id);
    this.log.info("telefonia: ligação recebida", { voice_call: vcId, tronco: tronco.id, time: teamId });
    await this.entrarNaFila(l);
  }

  private novoEstadoDaRecebida(
    vcId: string,
    tronco: TroncoDoBanco,
    canal: CanalAri,
    e164: string | null,
    conversationId: string | null,
    teamId: string | null,
  ): Recebida {
    return {
      tipo: "recebida",
      vcId,
      org: tronco.organizationId,
      tronco,
      cliente: canal.id,
      numeroExibido: e164 ?? canal.caller.number ?? "",
      inicio: this.agora(),
      estado: ESTADO_INICIAL,
      ramal: null,
      atendidaPor: null,
      conversationId,
      atendidaPelaRede: false,
      segurando: false,
      naFila: false,
      inicioFila: null,
      ponte: null,
      relogio: null,
      teamId,
      falasGerais: null,
      fala: null,
      relogioDaEspera: null,
      encerrando: null,
      fim: false,
    };
  }

  /**
   * A FILA DO TIME (desenho §5.2): agenda, aviso de instabilidade, então os
   * ramais. O relógio da fila começa AQUI, não no início da ligação (§5.1.3).
   */
  private async entrarNaFila(l: Recebida): Promise<void> {
    if (l.fim) return;
    l.inicio = this.agora();
    if (!l.teamId) return this.tocarProximo(l);
    const agora = new Date(this.agora());
    const [situacao, gerais] = await Promise.all([
      this.banco.situacaoDoTime(l.org, l.teamId, agora),
      this.banco.falasGerais(l.org),
    ]);
    l.falasGerais = gerais;

    // Fora do horário: SÓ com a fala pronta. Sem ela, a fase 1 (fila e "Ligar de
    // volta"): desligar em silêncio seria um beco sem saída para quem ligou.
    if (situacao === "fora_do_horario" && gerais.foraDoHorario) {
      const midia = await this.midiaDe(l, gerais.foraDoHorario, "fora do horário");
      if (midia) {
        l.encerrando = MOTIVO_FORA_DO_HORARIO;
        await this.garantirAtendida(l);
        if (await this.tocar(l, midia, "fora_do_horario", "fora do horário")) return;
        return this.encerrarRecebida(l, MOTIVO_FORA_DO_HORARIO);
      }
    }

    const aviso = await this.banco.emergenciaDoTime(l.org, l.teamId, agora);
    if (aviso) {
      const midia = await this.midiaDe(l, aviso, "aviso de instabilidade");
      if (midia) {
        await this.garantirAtendida(l);
        if (await this.tocar(l, midia, "aviso", "aviso de instabilidade")) return;
      }
    }
    return this.tocarProximo(l);
  }

  private async disponiveisComRamal(l: Recebida): Promise<CandidatoAoToque[]> {
    if (!l.teamId) return [];
    const todos = await this.banco.disponiveisNoTime(l.org, l.teamId, new Date(this.agora()));
    const online = await Promise.all(todos.map((c) => this.ari.ramalOnline(c.userId).catch(() => false)));
    return todos.filter((_, i) => online[i]);
  }

  private async garantirAtendida(l: Recebida) {
    if (l.atendidaPelaRede) return;
    l.atendidaPelaRede = true;
    await this.ari.atender(l.cliente);
  }

  /** O cliente vai esperar: "aguarde" (se houver) e música depois; senão, música direto. */
  private async segurarNaLinha(l: Recebida) {
    if (l.segurando) return;
    l.segurando = true;
    await this.garantirAtendida(l);
    const midia = await this.midiaDe(l, l.falasGerais?.aguarde ?? null, "aguarde");
    if (midia && (await this.tocar(l, midia, "espera", "aguarde"))) return;
    await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
  }

  private async tocarProximo(l: Recebida): Promise<void> {
    if (l.fim || l.atendidaPor || l.encerrando) return;
    const disponiveis = await this.disponiveisComRamal(l);
    const p = proximoToque(disponiveis, l.estado);

    if (p.tipo === "desistir") return this.encerrarComFala(l, "ninguem_atendeu");

    if (p.tipo === "esperar") {
      if (!l.naFila) {
        l.naFila = true;
        l.inicioFila = this.agora();
        await this.segurarNaLinha(l);
        await this.banco.marcarTocando(l.vcId, null);
      }
      if (this.agora() - (l.inicioFila ?? this.agora()) >= ESPERA_NA_FILA_MS) {
        return this.encerrarComFala(l, "fila_esgotada");
      }
      this.armar(l, REAVALIAR_FILA_MS, () => this.tocarProximo(l));
      return;
    }

    l.estado = p.estado;
    // Tocou demais sem ninguém pegar (ou começou a segunda volta): atende e
    // segura — a rede costuma derrubar ligação que só chama.
    if (p.estado.volta > 1 || this.agora() - l.inicio >= ATENDER_E_SEGURAR_APOS_MS) {
      await this.segurarNaLinha(l);
    }

    let canalDoRamal: { id: string };
    try {
      canalDoRamal = await this.ari.originar({
        endpoint: `PJSIP/${idDoRamal(p.userId)}`,
        appArgs: `oferta,${l.vcId}`,
        callerId: l.numeroExibido,
        prazoS: Math.round(TOQUE_POR_ATENDENTE_MS / 1000),
        variaveis: { "PJSIP_HEADER(add,X-Ligacao-Id)": l.vcId },
      });
    } catch (e) {
      // Ramal que sumiu entre a pergunta e o toque: conta como tocado e segue.
      this.log.warn("telefonia: não consegui tocar o ramal — próximo", {
        voice_call: l.vcId,
        erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
      return this.tocarProximo(l);
    }
    l.ramal = { canal: canalDoRamal.id, userId: p.userId };
    this.porCanal.set(canalDoRamal.id, l);
    await this.banco.marcarTocando(l.vcId, p.userId);
    // Rede de segurança: se o Asterisk não derrubar o toque no prazo, derrubamos.
    const canalEsperado = canalDoRamal.id;
    this.armar(l, TOQUE_POR_ATENDENTE_MS + 3_000, async () => {
      if (l.ramal?.canal === canalEsperado && !l.atendidaPor) await this.ari.desligar(canalEsperado, "no_answer");
    });
  }

  private armar(l: Recebida, ms: number, fn: () => Promise<unknown>) {
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = setTimeout(() => {
      l.relogio = null;
      if (!l.fim)
        void this.emFila(async () => {
          if (!l.fim) await fn();
        }).catch((e) => this.log.error("telefonia: relógio falhou", { erro: String(e) }));
    }, ms);
  }

  // ─── falas ───────────────────────────────────────────────────────────────

  /**
   * A mídia de uma fala, com o arquivo garantido no disco. Fala que existe mas
   * não tem arquivo é PULADA: `null`, e a Central fica sabendo.
   */
  private async midiaDe(l: Recebida, fala: FalaDoBanco | null, rotulo: string): Promise<string | null> {
    if (!fala) return null;
    const midia = await this.falas.garantir(fala).catch(() => null);
    if (!midia) {
      this.log.warn("telefonia: fala sem arquivo no disco — pulada", { voice_call: l.vcId, fala: fala.id });
      await this.avisarIntocavel(l, rotulo);
    }
    return midia;
  }

  private async avisarIntocavel(l: Recebida, rotulo: string) {
    await this.banco
      .avisarFalaIntocavel(l.org, rotulo)
      .catch((e) => this.log.warn("telefonia: aviso de fala intocável não gravado", { erro: String(e) }));
  }

  /** Toca no canal do cliente. `false` = não deu (quem chama segue como se a fala tivesse acabado). */
  private async tocar(l: Recebida, midia: string, papel: PapelDaFala, rotulo: string): Promise<boolean> {
    try {
      const p = await this.ari.tocarFala(l.cliente, midia);
      l.fala = { playbackId: p.id, papel, rotulo };
      this.porReproducao.set(p.id, l);
      return true;
    } catch (e) {
      this.log.warn("telefonia: não consegui tocar a fala", {
        voice_call: l.vcId,
        papel,
        erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
      return false;
    }
  }

  /** Para a fala em curso. O `PlaybackFinished` que chegar depois é ignorado (já saiu do mapa). */
  private async pararFalaAtual(l: Recebida) {
    if (!l.fala) return;
    const id = l.fala.playbackId;
    l.fala = null;
    this.porReproducao.delete(id);
    await this.ari.pararFala(id).catch(() => undefined);
  }

  private async aoTerminarFala(ev: Extract<EventoAri, { type: "PlaybackFinished" }>) {
    const id = ev.playback?.id;
    const l = id ? this.porReproducao.get(id) : undefined;
    if (!l || !id) return;
    this.porReproducao.delete(id);
    if (l.fim || l.fala?.playbackId !== id) return;
    const fala = l.fala;
    l.fala = null;
    const tocou = ev.playback.state !== "failed";
    if (!tocou) {
      this.log.warn("telefonia: o Asterisk não tocou a fala", { voice_call: l.vcId, papel: fala.papel });
      await this.avisarIntocavel(l, fala.rotulo);
    }
    return this.aposFala(l, fala.papel, tocou);
  }

  /** O que vem depois de cada fala — ou de uma fala que não tocou. */
  private async aposFala(l: Recebida, papel: PapelDaFala, tocou: boolean): Promise<void> {
    if (l.fim) return;
    switch (papel) {
      case "aviso":
        if (tocou) {
          await this.banco
            .registrarAvisoOuvido(l.vcId)
            .catch((e) => this.log.warn("telefonia: 'ouviu o aviso' não gravado", { erro: String(e) }));
        }
        return this.tocarProximo(l);
      case "espera":
        if (l.atendidaPor || l.encerrando) return;
        await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
        this.armarEspera(l);
        return;
      case "fora_do_horario":
      case "ninguem":
        return this.encerrarRecebida(l, l.encerrando ?? "ninguem_atendeu");
      default:
        return;
    }
  }

  /** Daqui a ~40 s: para a música, toca o "aguarde" de novo, e a música volta no fim dele. */
  private armarEspera(l: Recebida) {
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    l.relogioDaEspera = setTimeout(() => {
      l.relogioDaEspera = null;
      if (l.fim) return;
      void this.emFila(async () => {
        if (l.fim || l.atendidaPor || l.encerrando || l.fala) return;
        const midia = await this.midiaDe(l, l.falasGerais?.aguarde ?? null, "aguarde");
        if (!midia) return;
        await this.ari.pararMusica(l.cliente).catch(() => undefined);
        if (await this.tocar(l, midia, "espera", "aguarde")) return;
        await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
        this.armarEspera(l);
      }).catch((e) => this.log.error("telefonia: relógio do aguarde falhou", { erro: String(e) }));
    }, REPETIR_AGUARDE_MS);
  }

  /** Esgotou: "ninguém atendeu" (se houver) e só então desliga. */
  private async encerrarComFala(l: Recebida, motivo: string): Promise<void> {
    if (l.fim || l.encerrando) return;
    l.encerrando = motivo;
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = null;
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    l.relogioDaEspera = null;
    const midia = await this.midiaDe(l, l.falasGerais?.ninguem ?? null, "ninguém atendeu");
    if (!midia) return this.encerrarRecebida(l, motivo);
    await this.pararFalaAtual(l);
    await this.ari.pararMusica(l.cliente).catch(() => undefined);
    await this.garantirAtendida(l);
    if (await this.tocar(l, midia, "ninguem", "ninguém atendeu")) return;
    return this.encerrarRecebida(l, motivo);
  }

  // ─── atendimento e fim da recebida ───────────────────────────────────────

  private async ramalAtendeu(canal: CanalAri, vcId: string) {
    const l = this.porId.get(vcId);
    if (!l || l.tipo !== "recebida" || l.fim || l.encerrando || l.ramal?.canal !== canal.id || l.atendidaPor) {
      // Atendeu tarde (a ligação já foi para outro, acabou ou está se despedindo): larga o ramal.
      await this.ari.desligar(canal.id);
      return;
    }
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = null;
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    l.relogioDaEspera = null;
    l.atendidaPor = l.ramal.userId;

    // Atendeu no meio de uma fala (o "aguarde"): a fala para e a ponte se forma.
    await this.pararFalaAtual(l);
    if (l.atendidaPelaRede) await this.ari.pararMusica(l.cliente);
    else {
      l.atendidaPelaRede = true;
      await this.ari.atender(l.cliente);
    }
    l.ponte = ponteDe(vcId);
    await this.ari.criarPonte(l.ponte);
    await this.ari.porNaPonte(l.ponte, l.cliente);
    await this.ari.porNaPonte(l.ponte, canal.id);
    await this.banco.marcarAtendida(vcId, l.atendidaPor);
    if (l.conversationId) {
      await this.banco.atribuirConversa(l.org, l.conversationId, l.atendidaPor).catch((e) =>
        this.log.warn("telefonia: conversa não atribuída a quem atendeu", { erro: String(e) }),
      );
    }
    this.log.info("telefonia: ligação atendida", { voice_call: vcId, atendente: l.atendidaPor });
  }

  private async encerrarRecebida(l: Recebida, motivo: string) {
    if (l.fim) return;
    l.fim = true;
    if (l.relogio) clearTimeout(l.relogio);
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    if (l.fala) this.porReproducao.delete(l.fala.playbackId);
    l.fala = null;
    const outros = [l.cliente, l.ramal?.canal].filter((c): c is string => Boolean(c));
    for (const c of outros) {
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    if (l.ponte) await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    await this.finalizar(l.vcId, l.atendidaPor ? "atendida" : "perdida", motivo);
  }

  // ─── feita ───────────────────────────────────────────────────────────────

  private async novaFeita(canal: CanalAri) {
    const endpoint = endpointDoCanal(canal.name);
    const dono = endpoint ? donoDoEndpoint(endpoint) : null;
    const m = /^c-([0-9a-f-]{36})$/.exec(canal.dialplan.exten);
    const recusar = async (motivo: string, extra: Record<string, unknown> = {}) => {
      this.log.warn(`telefonia: saída recusada — ${motivo}`, { canal: canal.name, ...extra });
      await this.ari.desligar(canal.id, "congestion");
    };
    if (dono?.tipo !== "ramal") return recusar("não veio de ramal");
    if (!m) return recusar("destino não é um pedido de ligação");

    const vc = await this.banco.ligacaoPorId(m[1]!);
    if (!vc) return recusar("pedido inexistente");
    // A autorização inteira da ligação de saída: o pedido existe, é de saída,
    // ainda não começou, é DESTE atendente e é recente. A senha do ramal, sozinha,
    // não disca para lugar nenhum.
    if (vc.direction !== "outbound" || vc.status !== "starting") return recusar("pedido já usado", { voice_call: vc.id });
    if (vc.owner_user_id !== dono.id) return recusar("pedido de outro atendente", { voice_call: vc.id });
    if (this.agora() - new Date(vc.started_at).getTime() > VALIDADE_DO_PEDIDO_DE_SAIDA_MS) {
      await this.banco.encerrarLigacao(vc.id, "pedido_expirado");
      return recusar("pedido expirado", { voice_call: vc.id });
    }
    const numero = numeroParaLigar(vc.peer_phone);
    if (!numero.ok) {
      await this.banco.encerrarLigacao(vc.id, `numero_${numero.motivo}`);
      return recusar("número fora da política", { voice_call: vc.id, motivo: numero.motivo });
    }
    const tronco = await this.banco.troncoPorId(vc.channel_session_id);
    if (!tronco || tronco.organizationId !== vc.organization_id) {
      await this.banco.encerrarLigacao(vc.id, RECUSA_DA_SAIDA.troncoIndisponivel);
      return recusar("tronco indisponível", { voice_call: vc.id });
    }
    // O prefixo de discagem é DO TRONCO (vem do banco, nunca do que o atendente
    // digitou) e entra na frente do número que a política acabou de julgar.
    const destino = enderecoDeSaida(tronco, numero.discar);
    if (!destino.ok) {
      await this.banco.encerrarLigacao(vc.id, RECUSA_DA_SAIDA.troncoConfiguracaoInvalida);
      return recusar("tronco com configuração inválida", { voice_call: vc.id, problema: destino.problema });
    }

    const l: Feita = {
      tipo: "feita",
      vcId: vc.id,
      org: vc.organization_id,
      userId: dono.id,
      ramal: canal.id,
      perna: null,
      ponte: ponteDe(vc.id),
      tom: null,
      atendida: false,
      tocou: false,
      causaDaRede: null,
      fim: false,
    };
    this.registrar(l, canal.id);

    await this.ari.atender(canal.id);
    await this.ari.criarPonte(l.ponte);
    await this.ari.porNaPonte(l.ponte, canal.id);
    const perna = await this.ari.criarCanal({
      endpoint: destino.endpoint,
      appArgs: `perna,${vc.id}`,
      ...(tronco.numero ? { callerId: tronco.numero.replace(/^\+55/, "") } : {}),
    });
    l.perna = perna.id;
    this.porCanal.set(perna.id, l);
    await this.ari.porNaPonte(l.ponte, perna.id);
    // O chamar local até a operadora mandar áudio próprio (183) ou atender.
    l.tom = (await this.ari.tocarTom(canal.id, "ring").catch(() => null))?.id ?? null;
    await this.banco.marcarTocando(vc.id, null);
    await this.ari.discar(perna.id, PRAZO_DA_SAIDA_S);
    this.log.info("telefonia: ligação feita", { voice_call: vc.id, tronco: tronco.id });
  }

  private async pararTom(l: Feita) {
    if (!l.tom) return;
    const id = l.tom;
    l.tom = null;
    await this.ari.pararReproducao(id).catch(() => undefined);
  }

  private async aoDiscar(ev: Extract<EventoAri, { type: "Dial" }>) {
    const l = this.porCanal.get(ev.peer.id);
    if (!l || l.tipo !== "feita" || l.perna !== ev.peer.id || l.fim) return;
    const s = ev.dialstatus;
    // O desfecho da discagem vira causa Q.850 aproximada, para o caso de o fim
    // do canal chegar sem causa própria (StasisEnd não traz).
    const causaDoDial: Record<string, number> = { BUSY: 17, NOANSWER: 19, CHANUNAVAIL: 34, CONGESTION: 34 };
    if (causaDoDial[s] !== undefined) this.causas.set(ev.peer.id, causaDoDial[s]!);
    if (s === "RINGING" || s === "PROGRESS") l.tocou = true;
    if (s === "PROGRESS") return this.pararTom(l);
    if (s === "ANSWER") {
      await this.pararTom(l);
      l.atendida = true;
      await this.banco.marcarAtendida(l.vcId, l.userId);
      this.log.info("telefonia: ligação feita atendida", { voice_call: l.vcId });
    }
  }

  private async encerrarFeita(l: Feita, motivo: string) {
    if (l.fim) return;
    l.fim = true;
    // O tom ANTES dos canais: desligar o ramal com o chamar ainda tocando faz o
    // Asterisk registrar "Playback failed for tone:ring;tonezone=br" — medido
    // num Asterisk 20.11.1 local, só nesse caso; parado pela ARI, o mesmo tom
    // termina "done". Era o aviso do log de produção na saída recusada em 0,2 s,
    // em que nem PROGRESS nem ANSWER chegaram para pará-lo.
    await this.pararTom(l);
    for (const c of [l.ramal, l.perna]) {
      if (!c) continue;
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    let desfecho: DesfechoDaLigacao = l.atendida ? "atendida" : "sem_resposta";
    let motivoFinal = motivo;
    // A perna da operadora acabou antes de alguém atender (e não foi o atendente
    // que desistiu): o motivo diz o que a rede fez, e a tela do atendente o lê.
    if (!l.atendida && l.causaDaRede !== null) {
      ({ desfecho, motivo: motivoFinal } = fimDaSaidaNaoAtendida({ causa: l.causaDaRede, tocou: l.tocou }));
    }
    await this.finalizar(l.vcId, desfecho, motivoFinal);
  }

  // ─── fim de canal ────────────────────────────────────────────────────────

  private async aoDestruirCanal(ev: Extract<EventoAri, { type: "ChannelDestroyed" }>) {
    const causaVista = this.causas.get(ev.channel.id);
    this.causas.delete(ev.channel.id);
    const l = this.porCanal.get(ev.channel.id);
    if (!l || l.fim) return;
    this.porCanal.delete(ev.channel.id);
    const causa = typeof ev.cause === "number" ? ev.cause : (causaVista ?? 16);
    this.log.info("telefonia: canal encerrado", { voice_call: l.vcId, canal: ev.channel.name, causa });

    if (l.tipo === "recebida") {
      // Enquanto a última fala toca (fora do horário, ninguém atendeu), o motivo já está decidido.
      if (ev.channel.id === l.cliente) return this.encerrarRecebida(l, l.encerrando ?? "cliente_desligou");
      if (l.ramal?.canal === ev.channel.id) {
        if (l.atendidaPor) return this.encerrarRecebida(l, "atendente_desligou");
        // Não atendeu, recusou ou o ramal caiu: próximo da lista.
        l.ramal = null;
        if (l.relogio) clearTimeout(l.relogio);
        l.relogio = null;
        await this.banco.marcarTocando(l.vcId, null);
        return this.tocarProximo(l);
      }
      return;
    }

    if (l.tipo === "feita") {
      if (ev.channel.id === l.perna) {
        // `causa`, não `ev.cause`: o fim da perna chega primeiro pelo StasisEnd,
        // que não traz causa — era o `rede_undefined` do log de produção.
        l.causaDaRede = causa;
        return this.encerrarFeita(l, "cliente_desligou");
      }
      return this.encerrarFeita(l, "atendente_desligou");
    }

    // Recuperada: qualquer ponta que cai derruba as outras.
    l.fim = true;
    for (const c of l.canais) {
      this.porCanal.delete(c);
      if (c !== ev.channel.id) await this.ari.desligar(c).catch(() => undefined);
    }
    await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    await this.finalizar(l.vcId, "atendida", "encerrada_apos_reinicio");
  }

  private async finalizar(vcId: string, desfechoPedido: DesfechoDaLigacao, motivo: string) {
    const l = await this.banco.encerrarLigacao(vcId, motivo);
    if (!l) return; // já encerrada por outro caminho
    const desfecho: DesfechoDaLigacao = l.answered_at ? "atendida" : desfechoPedido === "atendida" ? "perdida" : desfechoPedido;
    const duracao = l.answered_at ? this.agora() - new Date(l.answered_at).getTime() : null;
    await this.banco.registrarNaConversa(l, desfecho, duracao);
    // Fora do horário NÃO vira "Ligar de volta" (desenho §5.2.1): o cliente ouviu o porquê.
    if (desfecho === "perdida" && l.direction === "inbound" && motivo !== MOTIVO_FORA_DO_HORARIO) {
      await this.banco.avisarPerdida(l);
    }
    await this.banco.registrarFim(l, desfecho, motivo);
    this.log.info("telefonia: ligação encerrada", { voice_call: vcId, desfecho, motivo });
  }

  // ─── reinício do worker ──────────────────────────────────────────────────

  /**
   * Depois de (re)conectar à ARI: o que o banco diz estar vivo é conferido com
   * o que o Asterisk tem. Ponte viva `p-<id>` = ligação em curso: volta a ser
   * vigiada. Qualquer outra ligação "viva" no banco e sem ponte morreu com o
   * worker anterior — encerrada, e a recebida vira perdida (alguém liga de volta).
   * Uma URA ou uma fala em curso também morre aqui (risco aceito, desenho §11).
   */
  async recuperar(): Promise<void> {
    const [vivas, pontes, canais] = await Promise.all([
      this.banco.ligacoesVivas(),
      this.ari.pontes(),
      this.ari.canais(),
    ]);
    const canaisVivos = new Set(canais.map((c) => c.id));
    for (const vc of vivas) {
      if (this.porId.has(vc.id)) continue;
      const ponte = pontes.find((p) => p.id === ponteDe(vc.id));
      const canaisDaPonte = (ponte?.channels ?? []).filter((c) => canaisVivos.has(c));
      if (ponte && canaisDaPonte.length >= 2) {
        const r: Recuperada = { tipo: "recuperada", vcId: vc.id, ponte: ponte.id, canais: canaisDaPonte, fim: false };
        this.porId.set(vc.id, r);
        for (const c of canaisDaPonte) this.porCanal.set(c, r);
        this.log.info("telefonia: ligação em curso retomada após reinício", { voice_call: vc.id });
        continue;
      }
      for (const c of canaisDaPonte) await this.ari.desligar(c).catch(() => undefined);
      if (vc.sip_call_ref && canaisVivos.has(vc.sip_call_ref)) await this.ari.desligar(vc.sip_call_ref).catch(() => undefined);
      if (ponte) await this.ari.destruirPonte(ponte.id).catch(() => undefined);
      await this.finalizar(vc.id, vc.answered_at ? "atendida" : "perdida", "interrompida_no_reinicio");
    }
  }
}
```

(O tipo `MenuDoBanco` já é importado aqui porque a porta `menuPorId` existe desde já; a Task 15 é quem o usa.)

- [ ] **Step 4: O laço do worker implementa as portas novas**

Em `lib/channels/telefonia/laco.ts`, em `portaAri`, logo depois da linha `    pararReproducao: (id) => ari.pararReproducao(id),`, acrescente:

```ts
    tocarFala: (c, m) => ari.tocarFala(c, m),
    pararFala: (id) => ari.pararReproducao(id),
```

e em `portaBanco`, logo depois da linha `    disponiveisNoTime: (org, team, agora) => repo.disponiveisNoTime(pool, org, team, agora),`, acrescente:

```ts
    situacaoDoTime: (org, team, agora) => repo.situacaoDoTime(pool, org, team, agora),
    falasGerais: (org) => repo.falasGerais(pool, org),
    emergenciaDoTime: (org, team, agora) => repo.emergenciaDoTime(pool, org, team, agora),
    menuPorId: (org, id) => repo.menuPorId(pool, org, id),
    registrarMenu: (id, m) => repo.registrarMenu(pool, id, m),
    definirTimeDaLigacao: (id, team) => repo.definirTimeDaLigacao(pool, id, team),
    registrarAvisoOuvido: (id) => repo.registrarAvisoOuvido(pool, id),
    avisarFalaIntocavel: (org, rotulo) => repo.avisarFalaIntocavel(pool, org, rotulo),
```

- [ ] **Step 5: Rodar e ver passar (os casos da fase 1 inclusive)**

Run: `pnpm exec vitest run lib/channels/telefonia/controle.test.ts && pnpm typecheck`
Expected: PASS em todos os casos antigos e nos 10 novos; `tsc` sem erro.

- [ ] **Step 6: Commit**

```bash
git add lib/channels/telefonia/controle.ts lib/channels/telefonia/controle.test.ts lib/channels/telefonia/laco.ts
git commit -m "feat(telefonia): as falas na fila do time — fora do horário, aviso, aguarde, ninguém atendeu

Fora do horário com fala: toca e desliga sem 'Ligar de volta'. Aviso de
instabilidade inteiro antes dos ramais, com o 'ouviu' gravado. Aguarde e música,
de novo a cada 40 s; quem atende no meio da fala para a fala antes da ponte.
Esgotou: 'ninguém atendeu' e só então desliga. Fala sem arquivo é pulada e
avisada. A regra do toque (rodízio, 20 s, 2 voltas, 120 s) não mudou.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: O controlador — a URA (§5.1)

**Files:**
- Modify: `lib/channels/telefonia/controle.ts` (o arquivo da Task 14; cada edição abaixo cita o texto atual exato)
- Modify: `lib/channels/telefonia/controle.test.ts` (um `describe` novo no fim)

**Pré-requisito:** a Task 0B aprovada (as teclas da operadora chegam como `ChannelDtmfReceived`) ou a Task 0C aplicada.

- [ ] **Step 1: Os casos da URA (falham: o controlador não conhece menu)**

No FIM de `lib/channels/telefonia/controle.test.ts`, acrescente:

```ts
describe("URA (§5.1)", () => {
  const FALA_MENU = falaDe("menu");
  const FALA_INVALIDA = falaDe("invalida");
  const menu = (p: Partial<MenuDoBanco> = {}): MenuDoBanco => ({
    id: MENU,
    nome: "Atendimento",
    defaultTeamId: TIME,
    fala: FALA_MENU,
    falaInvalida: null,
    opcoes: [
      { digito: "1", teamId: TIME },
      { digito: "2", teamId: TIME2 },
    ],
    ...p,
  });
  const tecla = (digit: string, canalId = "cli-1") =>
    ctl.tratar({ type: "ChannelDtmfReceived", channel: canal(canalId, "x"), digit });
  const anaDisponivel = () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  };

  beforeEach(() => {
    banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
    banco.menus.set(MENU, menu());
  });

  it("número com menu: nasce no time padrão, atende e toca o menu; a tecla válida interrompe e leva ao time da opção", async () => {
    anaDisponivel();
    await entrar();
    expect(banco.criadas[0]).toMatchObject({ teamId: TIME, menuId: MENU });
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/menu"]);
    expect(ari.originados()).toEqual([]);

    await tecla("2");
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(banco.tem("menu")).toEqual([["menu", "vc-1", "2", "chosen"]]);
    expect(banco.tem("time")).toEqual([["time", "vc-1", TIME2]]);
    expect(banco.timesConsultados.at(-1)).toBe(TIME2);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
  });

  it("sem tecla: 5 s depois da fala o menu repete; falhou a 3ª vez → time padrão com default_no_input", async () => {
    await entrar();
    await terminou("fala-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.falas()).toHaveLength(2);
    await terminou("fala-2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.falas()).toHaveLength(3);
    await terminou("fala-3");
    expect(banco.tem("menu")).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(banco.tem("menu")).toEqual([["menu", "vc-1", null, "default_no_input"]]);
    expect(banco.tem("time")).toEqual([["time", "vc-1", TIME]]);
  });

  it("tecla errada toca a fala de inválida e repete o menu; na 3ª errada → padrão com default_invalid", async () => {
    banco.menus.set(MENU, menu({ falaInvalida: FALA_INVALIDA }));
    await entrar(); //                         fala-1: menu
    await tecla("9"); //                       interrompe; fala-2: inválida
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/menu", "sound:/falas/invalida"]);
    await terminou("fala-2"); //               fala-3: o menu de novo
    await tecla("#"); //                       reservada = inválida; fala-4: inválida
    await terminou("fala-4"); //               fala-5: o menu
    expect(ari.falas()).toHaveLength(5);

    await tecla("*"); //                       terceira errada
    expect(banco.tem("menu")).toEqual([["menu", "vc-1", null, "default_invalid"]]);
    expect(banco.tem("time")).toEqual([["time", "vc-1", TIME]]);
  });

  it("o cliente desliga no menu: perdida com aviso (no time padrão), sem desfecho de menu, e nenhum prazo sobra", async () => {
    await entrar();
    await destruir("cli-1");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    expect(banco.tem("menu")).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ari.falas()).toHaveLength(1);
  });

  it("menu sem áudio no disco: vai direto ao time padrão e avisa na Central", async () => {
    falas.semArquivo.add(FALA_MENU.id);
    anaDisponivel();
    await entrar();
    expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", "menu Atendimento"]]);
    expect(banco.tem("menu")).toEqual([["menu", "vc-1", null, "default_no_input"]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
  });

  it("os 2 min de fila contam da ENTRADA na fila, não do início da ligação", async () => {
    await entrar();
    await vi.advanceTimersByTimeAsync(30_000); // o cliente ouve o menu inteiro, devagar
    await tecla("1");
    await vi.advanceTimersByTimeAsync(100_000); // 130 s de ligação, 100 s de fila
    expect(banco.tem("encerrada")).toEqual([]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("tecla vinda do canal do RAMAL não mexe na URA", async () => {
    await entrar();
    await tecla("1", "ramal-canal-9");
    expect(banco.tem("menu")).toEqual([]);
  });

  it("número que aponta para um menu que não existe mais: segue sem time, como a fase 1", async () => {
    banco.menus.clear();
    await entrar();
    expect(ari.falas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/controle.test.ts -t "URA"`
Expected: FAIL — nenhuma fala de menu tocada (`expected [] to deeply equal [ 'sound:/falas/menu' ]`).

- [ ] **Step 3: Implementar — edições em `controle.ts`**

(a) Troque a linha `import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";` por:

```ts
import { ESTADO_INICIAL_DA_URA, passoDaUra, type EstadoDaUra, type EventoDaUra, type MenuDaUra } from "@/lib/telefonia/ura";
import { MOTIVO_FORA_DO_HORARIO, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";
```

(b) Troque `type PapelDaFala = "aviso" | "espera" | "fora_do_horario" | "ninguem";` por:

```ts
type PapelDaFala = "aviso" | "espera" | "fora_do_horario" | "ninguem" | "menu" | "invalida";

/** A URA em curso numa ligação: a regra pura decide, o controlador executa. */
interface UraEmCurso {
  menu: MenuDoBanco;
  regra: MenuDaUra;
  estado: EstadoDaUra;
  midiaDoMenu: string;
  midiaInvalida: string | null;
  prazo: ReturnType<typeof setTimeout> | null;
}
```

(c) Em `interface Recebida`, logo depois da linha `  encerrando: string | null;`, acrescente:

```ts
  /** A URA, enquanto o cliente escolhe (número que aponta para menu). */
  ura: UraEmCurso | null;
```

e em `novoEstadoDaRecebida`, logo depois de `      encerrando: null,`, acrescente `      ura: null,`.

(d) Em `tratar`, logo depois das linhas

```ts
        case "PlaybackFinished":
          return await this.aoTerminarFala(ev as Extract<EventoAri, { type: "PlaybackFinished" }>);
```

acrescente:

```ts
        case "ChannelDtmfReceived":
          return await this.aoReceberTecla(ev as Extract<EventoAri, { type: "ChannelDtmfReceived" }>);
```

(e) Em `novaRecebida`, troque a linha

```ts
    const teamId = tronco.teamId;
```

por

```ts
    // O número aponta para um time OU um menu (0288). Com menu, a ligação nasce no
    // time PADRÃO do menu — é para ele o "Ligar de volta" de quem desliga na URA.
    const menu = tronco.menuId ? await this.banco.menuPorId(tronco.organizationId, tronco.menuId) : null;
    if (tronco.menuId && !menu) {
      this.log.warn("telefonia: o número aponta para um menu que não existe mais — segue sem menu", { tronco: tronco.id });
    }
    const teamId = menu ? menu.defaultTeamId : tronco.teamId;
```

no objeto passado a `this.banco.criarLigacao({ ... })`, logo depois de `      status: "ringing",`, acrescente `      menuId: menu?.id ?? null,`, e troque a última linha da função, `    await this.entrarNaFila(l);`, por:

```ts
    if (menu) return this.iniciarUra(l, menu);
    await this.entrarNaFila(l);
```

(f) Em `aposFala`, logo ANTES de `      default:`, acrescente:

```ts
      case "menu":
      case "invalida": {
        const ura = l.ura;
        if (!ura) return;
        // O menu que o Asterisk não tocou não se repete no silêncio: vai ao time padrão.
        if (!tocou && papel === "menu") {
          return this.sairDaUra(l, ura.regra.defaultTeamId, ura.estado.houveInvalida ? "default_invalid" : "default_no_input", null);
        }
        return this.passoDaUraNaLigacao(l, { tipo: "fim_da_fala" });
      }
```

(g) Em `encerrarRecebida`, logo depois da linha `    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);`, acrescente:

```ts
    if (l.ura?.prazo) clearTimeout(l.ura.prazo);
    l.ura = null;
```

(h) Logo DEPOIS do método `encerrarComFala` (antes do comentário `// ─── atendimento e fim da recebida`), acrescente:

```ts
  // ─── URA (desenho §5.1) ──────────────────────────────────────────────────

  /** O número aponta para um menu: atende e toca a fala dele. Sem áudio → direto ao time padrão (§4.5). */
  private async iniciarUra(l: Recebida, menu: MenuDoBanco): Promise<void> {
    await this.garantirAtendida(l);
    const rotulo = `menu ${menu.nome}`;
    if (!menu.fala) await this.avisarIntocavel(l, rotulo);
    const midiaDoMenu = await this.midiaDe(l, menu.fala, rotulo);
    if (!midiaDoMenu) return this.sairDaUra(l, menu.defaultTeamId, "default_no_input", null);
    const midiaInvalida = await this.midiaDe(l, menu.falaInvalida, `tecla inválida do menu ${menu.nome}`);
    l.ura = {
      menu,
      regra: { opcoes: menu.opcoes, defaultTeamId: menu.defaultTeamId, temFalaInvalida: midiaInvalida !== null },
      estado: ESTADO_INICIAL_DA_URA,
      midiaDoMenu,
      midiaInvalida,
      prazo: null,
    };
    if (await this.tocar(l, midiaDoMenu, "menu", rotulo)) return;
    return this.sairDaUra(l, menu.defaultTeamId, "default_no_input", null);
  }

  /** Um passo da regra pura (`lib/telefonia/ura.ts`), executado. */
  private async passoDaUraNaLigacao(l: Recebida, evento: EventoDaUra): Promise<void> {
    const ura = l.ura;
    if (!ura || l.fim) return;
    const { estado, acao } = passoDaUra(ura.regra, ura.estado, evento);
    ura.estado = estado;
    switch (acao.tipo) {
      case "ignorar":
        return;
      case "esperar":
        this.armarPrazoDaUra(l, acao.ms);
        return;
      case "tocar": {
        if (ura.prazo) clearTimeout(ura.prazo);
        ura.prazo = null;
        if (acao.pararAtual) await this.pararFalaAtual(l);
        const invalida = acao.fala === "invalida" && ura.midiaInvalida !== null;
        const midia = invalida && ura.midiaInvalida ? ura.midiaInvalida : ura.midiaDoMenu;
        const rotulo = invalida ? `tecla inválida do menu ${ura.menu.nome}` : `menu ${ura.menu.nome}`;
        if (await this.tocar(l, midia, acao.fala, rotulo)) return;
        // Não tocou: a URA segue como se a fala tivesse acabado.
        return this.passoDaUraNaLigacao(l, { tipo: "fim_da_fala" });
      }
      case "encaminhar":
        if (ura.prazo) clearTimeout(ura.prazo);
        ura.prazo = null;
        if (acao.pararAtual) await this.pararFalaAtual(l);
        return this.sairDaUra(l, acao.teamId, acao.desfecho, acao.digito);
    }
  }

  private armarPrazoDaUra(l: Recebida, ms: number) {
    const ura = l.ura;
    if (!ura) return;
    if (ura.prazo) clearTimeout(ura.prazo);
    ura.prazo = setTimeout(() => {
      ura.prazo = null;
      if (l.fim || l.ura !== ura) return;
      void this.emFila(async () => {
        if (!l.fim && l.ura === ura) await this.passoDaUraNaLigacao(l, { tipo: "prazo" });
      }).catch((e) => this.log.error("telefonia: prazo da URA falhou", { erro: String(e) }));
    }, ms);
  }

  /** A URA decidiu o time: grava o que o menu fez, e a ligação entra na fila dele (§5.2). */
  private async sairDaUra(l: Recebida, teamId: string, desfecho: DesfechoDoMenu, digito: string | null): Promise<void> {
    if (l.ura?.prazo) clearTimeout(l.ura.prazo);
    l.ura = null;
    l.teamId = teamId;
    await this.banco
      .registrarMenu(l.vcId, { digito, desfecho })
      .catch((e) => this.log.warn("telefonia: escolha do menu não gravada", { erro: String(e) }));
    await this.banco
      .definirTimeDaLigacao(l.vcId, teamId)
      .catch((e) => this.log.warn("telefonia: time da ligação não gravado", { erro: String(e) }));
    this.log.info("telefonia: a URA decidiu o time", { voice_call: l.vcId, desfecho, time: teamId });
    return this.entrarNaFila(l);
  }

  /** Só a tecla do CLIENTE, e só durante a URA: no aviso de instabilidade a tecla não interrompe. */
  private async aoReceberTecla(ev: Extract<EventoAri, { type: "ChannelDtmfReceived" }>) {
    const l = this.porCanal.get(ev.channel.id);
    if (!l || l.tipo !== "recebida" || l.fim || !l.ura || ev.channel.id !== l.cliente) return;
    if (typeof ev.digit !== "string" || ev.digit.length !== 1) return;
    return this.passoDaUraNaLigacao(l, { tipo: "tecla", digito: ev.digit });
  }
```

- [ ] **Step 4: Rodar e ver passar (a suíte inteira do controlador)**

Run: `pnpm exec vitest run lib/channels/telefonia/controle.test.ts lib/telefonia/ura.test.ts && pnpm typecheck`
Expected: PASS em todos (fase 1, falas da fila e os 8 da URA); `tsc` sem erro.

- [ ] **Step 5: Commit**

```bash
git add lib/channels/telefonia/controle.ts lib/channels/telefonia/controle.test.ts
git commit -m "feat(telefonia): a URA na ligação recebida

Número que aponta para menu: atende, toca o menu, a tecla interrompe; opção
válida leva ao time dela, tecla errada toca a inválida e repete, sem tecla
repete; na 3ª vez vai ao time padrão com o desfecho gravado. O relógio da fila
começa na entrada da fila. A regra é a pura de lib/telefonia/ura.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: O laço do worker e o volume `telefonia-falas`

**Files:**
- Modify: `lib/channels/telefonia/laco.ts` (imports; `runTelefoniaLoop`, linhas 93–110)
- Modify: `docker-compose.prod.yml` (serviço `worker` ~linha 99; serviço `asterisk` ~linha 351; `volumes:` do topo ~linha 380)
- Create: `tests/unit/telefonia-falas-no-volume.test.ts`

**Ramo B (só se a Task 0 terminou em "ramo B"):** no Step 4, a linha do `asterisk` é `- telefonia-falas:/usr/share/asterisk/sounds/deskcomm:ro`. O teste do Step 1 já aceita os dois ramos (ele lê `DIRETORIO_NO_ASTERISK`).

- [ ] **Step 1: O teste do compose (falha: o volume não existe)**

Crie `tests/unit/telefonia-falas-no-volume.test.ts`:

```ts
/**
 * O VOLUME DAS FALAS CHEGA A QUEM JÁ INSTALOU — e no caminho que o código usa.
 *
 * O worker escreve as falas do telefone num volume nomeado e o Asterisk o lê só
 * leitura (desenho da fase 2, D12). Três coisas que nenhum outro gate mede:
 *  1. o volume está DECLARADO no topo — o `dc up -d` do update.sh cria volume
 *     declarado, e é assim que ele chega a quem já instalou, sem editar arquivo;
 *  2. o worker monta com escrita e o asterisk SÓ leitura (`:ro`);
 *  3. os dois no caminho que `falas-no-disco.ts` escreve e manda o Asterisk tocar
 *     — um caminho trocado de um lado só daria silêncio em toda URA.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DIRETORIO_DAS_FALAS, DIRETORIO_NO_ASTERISK } from "@/lib/channels/telefonia/falas-no-disco";

const compose = readFileSync(join(process.cwd(), "docker-compose.prod.yml"), "utf8");
const linhas = compose.split("\n");

/** O bloco de um serviço: da linha `  nome:` até a próxima chave do mesmo nível (ou do topo). */
function bloco(nome: string): string {
  const inicio = linhas.findIndex((l) => l === `  ${nome}:`);
  if (inicio === -1) throw new Error(`serviço ${nome} não encontrado no compose`);
  const fim = linhas.findIndex((l, i) => i > inicio && (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(l) || /^[a-z]/.test(l)));
  return linhas.slice(inicio, fim === -1 ? undefined : fim).join("\n");
}

function volumesDoTopo(): string[] {
  const inicio = linhas.findIndex((l) => l === "volumes:");
  if (inicio === -1) throw new Error("bloco volumes: do topo não encontrado");
  const nomes: string[] = [];
  for (const l of linhas.slice(inicio + 1)) {
    if (/^[a-z]/.test(l)) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
    if (m) nomes.push(m[1]!);
  }
  return nomes;
}

describe("o volume das falas do telefone no compose de produção", () => {
  it("está declarado no topo (o update.sh só cria volume declarado)", () => {
    expect(volumesDoTopo()).toContain("telefonia-falas");
  });

  it("o worker monta com escrita, no caminho em que o código escreve", () => {
    expect(bloco("worker")).toMatch(new RegExp(`^\\s+- telefonia-falas:${DIRETORIO_DAS_FALAS}\\s*$`, "m"));
  });

  it("o asterisk monta SÓ LEITURA, no caminho que o código manda tocar", () => {
    const destino = DIRETORIO_NO_ASTERISK.startsWith("/") ? DIRETORIO_NO_ASTERISK : "/usr/share/asterisk/sounds/deskcomm";
    expect(bloco("asterisk")).toMatch(new RegExp(`^\\s+- telefonia-falas:${destino}:ro\\s*$`, "m"));
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run tests/unit/telefonia-falas-no-volume.test.ts`
Expected: FAIL — `expected [ 'waha-data', … ] to include 'telefonia-falas'`.

- [ ] **Step 3: O laço — o disco das falas, e a passada que não depende da ARI**

Em `lib/channels/telefonia/laco.ts`:

(a) logo depois de `import type pg from "pg";`, acrescente:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { armazemDoSupabase, type PortaDoArmazem } from "@/lib/telefonia/armazem";
```

e logo depois de `import { ControladorDeChamadas, type EventoAri, type PortaAri, type PortaBanco, type Registro } from "./controle";`, acrescente:

```ts
import { DIRETORIO_DAS_FALAS, FalasNoDisco } from "./falas-no-disco";
```

(b) logo ANTES de `export interface EstadoDaTelefonia {`, acrescente:

```ts
/** O Storage visto do worker (cliente de serviço). Sem credencial, nenhuma fala baixa — e o log diz por quê. */
function armazemDoWorker(log: Registro): Pick<PortaDoArmazem, "baixar"> {
  try {
    return armazemDoSupabase(createAdminClient());
  } catch (e) {
    log.error("telefonia: sem cliente do Storage — as falas não chegam ao disco", { erro: String(e).slice(0, 200) });
    return { baixar: async () => null };
  }
}
```

(c) em `runTelefoniaLoop`, troque a linha

```ts
  const ctl = new ControladorDeChamadas(portaAri(ari), portaBanco(opts.pool), opts.log);
```

por

```ts
  const falasNoDisco = new FalasNoDisco(DIRETORIO_DAS_FALAS, opts.pool, armazemDoWorker(opts.log), opts.log);
  const ctl = new ControladorDeChamadas(portaAri(ari), portaBanco(opts.pool), opts.log, Date.now, {
    garantir: (fala) => falasNoDisco.garantir(fala),
  });
```

(d) troque o bloco

```ts
  const reconciliar = setInterval(() => {
    if (estado.conectada) void enfileirar(() => sync.sincronizar(false));
  }, RECONCILIAR_MS);
```

por

```ts
  // A passada do telefone que NÃO depende da ARI: as falas do Storage para o disco
  // e os avisos de instabilidade vencidos (desenho da fase 2, §5.5). Fora da fila
  // serial — baixar arquivo não pode atrasar o evento de uma ligação — e sem
  // reentrância: uma passada lenta não empilha outra.
  let passadaEmCurso = false;
  const passadaDoTelefone = async () => {
    if (passadaEmCurso) return;
    passadaEmCurso = true;
    try {
      await falasNoDisco.sincronizar();
      for (const v of await repo.desligarAvisosVencidos(opts.pool, new Date())) {
        opts.log.info("telefonia: aviso de instabilidade venceu e foi desligado", {
          time: v.id,
          organization_id: v.organizationId,
        });
      }
    } catch (e) {
      opts.log.warn("telefonia: passada das falas e dos avisos falhou", { erro: String(e).slice(0, 200) });
    } finally {
      passadaEmCurso = false;
    }
  };
  void passadaDoTelefone();

  const reconciliar = setInterval(() => {
    if (estado.conectada) void enfileirar(() => sync.sincronizar(false));
    void passadaDoTelefone();
  }, RECONCILIAR_MS);
```

- [ ] **Step 4: O compose**

Em `docker-compose.prod.yml`, no serviço `worker`, troque

```yaml
    environment:
      # dentro da rede do compose, o WAHA é o serviço 'waha' na porta interna 3000
      WAHA_API_BASE_URL: http://waha:3000
    networks:
```

por

```yaml
    environment:
      # dentro da rede do compose, o WAHA é o serviço 'waha' na porta interna 3000
      WAHA_API_BASE_URL: http://waha:3000
    volumes:
      # As falas do telefone (URA, aguarde, aviso de instabilidade): o worker as
      # baixa do Storage e escreve aqui; o Asterisk lê o MESMO volume, só leitura
      # (desenho da fase 2, D12). Montado mesmo com a telefonia desligada: vazio,
      # não custa nada, e ligar a telefonia depois não pede editar este arquivo.
      - telefonia-falas:/var/lib/deskcomm/falas
    networks:
```

no serviço `asterisk`, troque

```yaml
      TELEFONIA_RTP_FIM: ${TELEFONIA_RTP_FIM:-20039}
    ports:
```

por

```yaml
      TELEFONIA_RTP_FIM: ${TELEFONIA_RTP_FIM:-20039}
    volumes:
      # Só leitura: quem escreve é o worker. O mesmo caminho de lá, porque é o
      # caminho absoluto que a ARI manda tocar (passo zero da fase 2, ramo A).
      - telefonia-falas:/var/lib/deskcomm/falas:ro
    ports:
```

e, no `volumes:` do topo, logo depois de `  caddy-config:`, acrescente a linha `  telefonia-falas:`.

- [ ] **Step 5: Rodar os gates do compose e do kit**

Run: `pnpm exec vitest run tests/unit/telefonia-falas-no-volume.test.ts tests/unit/portas-do-compose.test.ts tests/unit/packaging-artefato-do-cliente.test.ts lib/channels/telefonia/ && pnpm typecheck && pnpm test:shell`
Expected: PASS em todos; `tsc` sem erro; `test:shell` termina sem `✗` (o `update.sh` roda `dc up -d`, que cria o volume declarado e recria `worker` e `asterisk` com a montagem nova — nenhuma edição manual pedida ao operador).

Conferir também que o compose continua válido para o Docker (o `.env` vazio só existe para o `env_file:` resolver):

Run: `d=$(mktemp -d) && cp docker-compose.prod.yml "$d"/ && touch "$d/.env" && docker compose -f "$d/docker-compose.prod.yml" --profile telefonia config --quiet && echo compose-ok; rm -rf "$d"`
Expected: `compose-ok` (avisos de variável vazia são esperados; erro de sintaxe ou de volume não declarado, não).

- [ ] **Step 6: Commit**

```bash
git add lib/channels/telefonia/laco.ts docker-compose.prod.yml tests/unit/telefonia-falas-no-volume.test.ts
git commit -m "feat(telefonia): o worker leva as falas ao volume do Asterisk e desliga os avisos vencidos

Volume nomeado telefonia-falas (escrita no worker, só leitura no asterisk),
declarado no compose para o update.sh criá-lo em quem já instalou. A passada de
60 s sincroniza as falas e desliga os avisos vencidos, fora da fila serial dos
eventos das ligações.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Tela — o cartão da ElevenLabs em Credenciais de IA

**Files:**
- Create: `app/app/ai/credentials/_components/CartaoElevenLabs.tsx`, `app/app/ai/credentials/_components/CartaoElevenLabs.test.tsx`
- Modify: `app/app/ai/credentials/page.tsx` (imports e o `return`)
- Modify: `app/app/ai/credentials/_components/CredentialsList.tsx:31` (`const credentials = data ?? [];`)
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste do cartão (falha: o componente não existe)**

Crie `app/app/ai/credentials/_components/CartaoElevenLabs.test.tsx`:

```tsx
/**
 * O CARTÃO DA ELEVENLABS: mostra só os 4 últimos dígitos, a chave recusada volta
 * como mensagem ao lado do campo (não some num toast), e quem não é admin não vê
 * o campo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.hoisted(() => ({
  estado: { cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" } as Record<string, unknown>,
  put: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: api.estado })),
    put: api.put,
  },
}));

import { CartaoElevenLabs } from "./CartaoElevenLabs";

function pintar(podeEditar: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CartaoElevenLabs podeEditar={podeEditar} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.put.mockReset();
  api.estado = { cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" };
});
afterEach(() => cleanup());

describe("cartão da ElevenLabs em Credenciais de IA", () => {
  it("mostra só os 4 últimos dígitos da chave guardada", async () => {
    pintar(true);
    expect(await screen.findByText("…1234")).toBeInTheDocument();
  });

  it("chave recusada: a mensagem da API aparece AO LADO do campo", async () => {
    api.put.mockRejectedValueOnce(
      new ApiError(422, "chave_invalida", undefined, "req-1", "A ElevenLabs recusou a chave. Confira a chave em Credenciais de IA."),
    );
    pintar(true);
    await userEvent.type(await screen.findByLabelText("Trocar a chave"), "sk_errada_000000");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A ElevenLabs recusou a chave.");
    expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/voz/chave", { chave: "sk_errada_000000" });
  });

  it("quem não é admin vê o estado, mas não o campo", async () => {
    pintar(false);
    expect(await screen.findByText("…1234")).toBeInTheDocument();
    expect(screen.queryByLabelText("Trocar a chave")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run app/app/ai/credentials/_components/CartaoElevenLabs.test.tsx`
Expected: FAIL — `Failed to resolve import "./CartaoElevenLabs"`.

- [ ] **Step 3: O cartão**

Crie `app/app/ai/credentials/_components/CartaoElevenLabs.tsx`:

```tsx
"use client";
/**
 * O cartão da ElevenLabs em Credenciais de IA (desenho da fase 2, §6.1).
 *
 * A chave que dá voz ao telefone. Uma por organização: salvar de novo TROCA. A
 * rota valida a chave listando as vozes da conta antes de gravar, e a tela nunca
 * a recebe de volta — só os 4 últimos dígitos. Chave recusada vira mensagem ao
 * lado do campo, porque é ali que a pessoa vai corrigir.
 *
 * Toda leitura passa pela rota: no navegador o cliente do Supabase consultaria
 * como anônimo (cookie httpOnly) e voltaria vazio, sem erro.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { Key } from "@/lib/ui/icons";

interface EstadoDaChave {
  cadastrada: boolean;
  last4: string | null;
  validada_em: string | null;
}

const CHAVE_DO_ESTADO = ["telefonia", "chave-de-voz"] as const;

export function CartaoElevenLabs({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [chave, setChave] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const estado = useQuery({
    queryKey: CHAVE_DO_ESTADO,
    queryFn: async () => (await apiClient.get<{ data: EstadoDaChave }>("/api/v1/telefonia/voz/chave")).data,
  });

  const salvar = useMutation({
    mutationFn: async () => apiClient.put<{ data: EstadoDaChave }>("/api/v1/telefonia/voz/chave", { chave }),
    onSuccess: async () => {
      setChave("");
      setErro(null);
      toast.success(t("Chave da ElevenLabs salva e validada."));
      await qc.invalidateQueries({ queryKey: CHAVE_DO_ESTADO });
      await qc.invalidateQueries({ queryKey: ["telefonia", "voz"] });
    },
    onError: (e) => setErro(e instanceof ApiError ? e.message : t("Não foi possível salvar a chave. Tente de novo.")),
  });

  const d = estado.data;
  const rotulo = d?.cadastrada ? t("Trocar a chave") : t("Chave da ElevenLabs");

  return (
    <section className="space-y-2" data-cartao-elevenlabs>
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Key size={16} aria-hidden /> {t("ElevenLabs (voz da URA)")}
      </h2>
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t(
            "A chave que dá voz ao telefone: o menu, o aguarde, o fora do horário e o aviso de instabilidade. Uma por organização. Ela é validada listando as vozes da sua conta, e nunca mais aparece na tela.",
          )}
        </p>
        {d?.cadastrada ? (
          <p className="text-sm">
            {t("Chave terminada em")} <span className="font-mono" data-chave-de-voz-last4>{`…${d.last4 ?? ""}`}</span>
          </p>
        ) : (
          <p className="text-sm">{t("Nenhuma chave cadastrada.")}</p>
        )}
        {podeEditar ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              salvar.mutate();
            }}
          >
            <div className="min-w-[16rem] flex-1 space-y-1.5">
              <Label htmlFor="chave-elevenlabs">{rotulo}</Label>
              <Input
                id="chave-elevenlabs"
                type="password"
                autoComplete="off"
                value={chave}
                onChange={(e) => setChave(e.target.value)}
                aria-invalid={erro !== null}
                aria-describedby={erro ? "chave-elevenlabs-erro" : undefined}
              />
            </div>
            <Button type="submit" disabled={chave.trim().length < 8 || salvar.isPending}>
              {salvar.isPending ? t("Validando…") : t("Salvar chave")}
            </Button>
            {erro ? (
              <p id="chave-elevenlabs-erro" role="alert" className="w-full text-sm text-destructive">
                {erro}
              </p>
            ) : null}
          </form>
        ) : null}
      </Card>
    </section>
  );
}
```

- [ ] **Step 4: A página mostra o cartão (só onde a telefonia é oferecida) e a lista fica só com LLM**

Em `app/app/ai/credentials/page.tsx`, acrescente aos imports:

```ts
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { CartaoElevenLabs } from "./_components/CartaoElevenLabs";
```

e troque

```tsx
      <CredentialsList
        initialData={credentials}
        canWrite={canWrite}
        usageMap={usageMap}
      />
    </div>
```

por

```tsx
      <CredentialsList
        initialData={credentials}
        canWrite={canWrite}
        usageMap={usageMap}
      />
      {/* A voz do telefone: só onde a instalação oferece telefonia. */}
      {configAriDoAmbiente() !== null ? <CartaoElevenLabs podeEditar={canWrite} /> : null}
    </div>
```

Em `app/app/ai/credentials/_components/CredentialsList.tsx`, troque

```ts
  const credentials = data ?? [];
```

por

```ts
  // Só as chaves de MODELO DE LINGUAGEM: a da ElevenLabs (voz do telefone) mora na
  // mesma tabela e tem cartão próprio. Sem este filtro ela contava como "já tem
  // credencial" e escondia o estado vazio de quem ainda não cadastrou nenhum modelo.
  const credentials = (data ?? []).filter((c) => PROVIDER_LABELS[c.provider] !== undefined);
```

- [ ] **Step 5: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — Credenciais de IA
  "ElevenLabs (voz da URA)": { es: "ElevenLabs (voz del IVR)" },
  "A chave que dá voz ao telefone: o menu, o aguarde, o fora do horário e o aviso de instabilidade. Uma por organização. Ela é validada listando as vozes da sua conta, e nunca mais aparece na tela.": {
    es: "La clave que da voz al teléfono: el menú, el espere, el fuera de horario y el aviso de inestabilidad. Una por organización. Se valida listando las voces de tu cuenta y no vuelve a aparecer en pantalla.",
  },
  "Chave terminada em": { es: "Clave terminada en" },
  "Nenhuma chave cadastrada.": { es: "Ninguna clave registrada." },
  "Trocar a chave": { es: "Cambiar la clave" },
  "Chave da ElevenLabs": { es: "Clave de ElevenLabs" },
  "Chave da ElevenLabs salva e validada.": { es: "Clave de ElevenLabs guardada y validada." },
  "Não foi possível salvar a chave. Tente de novo.": { es: "No se pudo guardar la clave. Inténtalo de nuevo." },
```

- [ ] **Step 6: Rodar, typecheck e o gate de i18n**

Run: `pnpm exec vitest run app/app/ai/credentials/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS (inclusive os testes antigos de `CredentialCard` e `AddCredentialDialog`); `tsc` sem erro.

- [ ] **Step 7: Commit**

```bash
git add app/app/ai/credentials/_components/CartaoElevenLabs.tsx app/app/ai/credentials/_components/CartaoElevenLabs.test.tsx \
  app/app/ai/credentials/page.tsx app/app/ai/credentials/_components/CredentialsList.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): a chave da ElevenLabs em Credenciais de IA

Cartão próprio (só onde a telefonia é oferecida), com os 4 últimos dígitos, a
recusa da ElevenLabs ao lado do campo e o campo só para admin. A lista de
credenciais fica só com os modelos de linguagem.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: Tela — Conexões › Telefone ganha abas; a aba Voz e falas

**Files:**
- Create: `components/connections/telefone/api.ts`
- Create: `components/connections/telefone/TelefoniaDesligada.tsx`
- Create: `components/connections/telefone/EstadoDaFala.tsx`
- Create: `components/telefonia/OuvirFala.tsx`
- Create: `components/connections/telefone/VozEFalas.tsx`, `components/connections/telefone/VozEFalas.test.tsx`
- Create: `components/connections/telefone/MenusDoTelefone.tsx` (casca mínima aqui; a Task 19 a completa)
- Modify: `components/connections/ConexoesShell.tsx` (linha 62 `const sub = …`, linha 67 do `irPara`, e o `<TabsContent value="telefone">`)
- Modify: `components/connections/CanalTelefoneClient.tsx` (o bloco `if (dados && !dados.oferecida) { … }`)
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste da aba Voz e falas (falha: o componente não existe)**

Crie `components/connections/telefone/VozEFalas.test.tsx`:

```tsx
/**
 * A ABA VOZ E FALAS: sem a chave, diz onde cadastrar; com chave e voz, as três
 * falas gerais aparecem com o texto sugerido, e "Gerar e ouvir" manda o texto
 * digitado para a rota da fala certa.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/telefonia/OuvirFala", () => ({ OuvirFala: () => null }));

const api = vi.hoisted(() => ({
  voz: null as unknown,
  put: vi.fn(async () => ({ data: { fala: null, falha: null } })),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) =>
      url.endsWith("/vozes") ? { data: { vozes: [{ voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null }] } } : { data: api.voz },
    ),
    put: api.put,
  },
}));

import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";

import { VozEFalas } from "./VozEFalas";

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VozEFalas />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.put.mockClear();
  api.voz = {
    oferecida: true,
    chave: { cadastrada: true, last4: "1234" },
    voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
    falas: { waiting: null, nobody: null, after_hours: null },
  };
});
afterEach(() => cleanup());

describe("aba Voz e falas", () => {
  it("sem a chave da ElevenLabs: explica e aponta para Credenciais de IA", async () => {
    api.voz = { ...(api.voz as object), chave: { cadastrada: false, last4: null } };
    pintar();
    const link = await screen.findByRole("link", { name: "Cadastrar a chave em Credenciais de IA" });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
  });

  it("as três falas gerais aparecem com o texto sugerido; 'Gerar e ouvir' manda o texto para a rota da fala", async () => {
    pintar();
    const cartao = (await screen.findByText("Fora do horário")).closest("[data-fala-geral]") as HTMLElement;
    expect(cartao).toHaveAttribute("data-fala-geral", "after_hours");
    expect(within(cartao).getByRole("textbox")).toHaveValue(TEXTO_SUGERIDO.after_hours);
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(3);

    await userEvent.click(within(cartao).getByRole("button", { name: /Gerar e ouvir/ }));
    expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/falas/gerais/after_hours", { texto: TEXTO_SUGERIDO.after_hours });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/connections/telefone/VozEFalas.test.tsx`
Expected: FAIL — `Failed to resolve import "./VozEFalas"`.

- [ ] **Step 3: As peças compartilhadas**

Crie `components/connections/telefone/api.ts`:

```ts
"use client";
/**
 * O acesso das abas Menus e Voz e falas (Conexões › Telefone) às rotas
 * `/api/v1/telefonia/...`. Toda leitura passa pela API: no navegador o cliente do
 * Supabase consultaria como ANÔNIMO (o cookie é httpOnly) e voltaria vazio, sem
 * erro nenhum — a tela mostraria "nenhum menu" para quem tem menus.
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FalaGeral, FalaPublica, FalhaNaResposta, MenuPublico } from "@/lib/telefonia/vocabulario";

export interface VozDoTelefone {
  oferecida: boolean;
  chave: { cadastrada: boolean; last4: string | null };
  voz: { voice_id: string; model_id: string } | null;
  falas: Record<FalaGeral, FalaPublica | null>;
}

export interface VozDaConta {
  voice_id: string;
  nome: string;
  categoria: string | null;
  amostra_url: string | null;
}

export interface RespostaDaFala {
  fala: FalaPublica | null;
  falha: FalhaNaResposta | null;
}

export interface RespostaDoMenu {
  menu: MenuPublico | null;
  falha: FalhaNaResposta | null;
}

export const CHAVE_DA_VOZ = ["telefonia", "voz"] as const;
export const CHAVE_DAS_VOZES = ["telefonia", "vozes"] as const;
export const CHAVE_DOS_MENUS = ["telefonia", "menus"] as const;

export function useVozDoTelefone() {
  return useQuery({
    queryKey: CHAVE_DA_VOZ,
    queryFn: async () => (await apiClient.get<{ data: VozDoTelefone }>("/api/v1/telefonia/voz")).data,
  });
}

/** Vozes da conta da ElevenLabs — só com a chave cadastrada (sem ela a rota responde 422). */
export function useVozesDaConta(ligado: boolean) {
  return useQuery({
    queryKey: CHAVE_DAS_VOZES,
    enabled: ligado,
    staleTime: 5 * 60_000,
    queryFn: async () => (await apiClient.get<{ data: { vozes: VozDaConta[] } }>("/api/v1/telefonia/voz/vozes")).data.vozes,
  });
}

export function useMenusDoTelefone() {
  return useQuery({
    queryKey: CHAVE_DOS_MENUS,
    queryFn: async () => {
      const r = await apiClient.get<{ data: { oferecida?: boolean; menus?: MenuPublico[] } }>("/api/v1/telefonia/menus");
      return { oferecida: r.data.oferecida ?? true, menus: r.data.menus ?? [] };
    },
  });
}
```

Crie `components/connections/telefone/TelefoniaDesligada.tsx`:

```tsx
"use client";
/** O cartão de "telefonia desligada nesta instalação" — o mesmo nas três abas do Telefone. */
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

export function TelefoniaDesligada() {
  const t = useT();
  return (
    <Card className="space-y-2 p-5" data-telefonia-desligada>
      <h2 className="text-base font-semibold">{t("Telefonia desligada nesta instalação")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Para fazer e receber ligações pelo CRM, quem administra o servidor precisa ligar a telefonia (perfil “telefonia” do Docker Compose) e rodar a atualização. Depois disso, os números são cadastrados aqui.",
        )}
      </p>
    </Card>
  );
}
```

Crie `components/connections/telefone/EstadoDaFala.tsx`:

```tsx
"use client";
/**
 * O selo de uma fala: gerando (a requisição em curso), ainda não gerada, pronta,
 * pronta com a voz anterior (trocou-se a voz e ela não foi regravada) ou falhou —
 * com o motivo traduzido, porque "falhou" sem porquê não diz o que fazer.
 */
import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_FALHA_DA_FALA, ehFalhaDaFala, type FalaPublica } from "@/lib/telefonia/vocabulario";

export function EstadoDaFala({
  fala,
  vozAtual,
  gerando = false,
}: {
  fala: FalaPublica | null;
  vozAtual: string | null;
  gerando?: boolean;
}) {
  const t = useT();
  if (gerando) {
    return (
      <Badge variant="secondary" data-estado-da-fala="gerando">
        {t("Gerando…")}
      </Badge>
    );
  }
  if (!fala) {
    return (
      <Badge variant="outline" data-estado-da-fala="ausente">
        {t("Ainda não gerada")}
      </Badge>
    );
  }
  if (fala.status === "failed") {
    const motivo = t(MENSAGEM_DA_FALHA_DA_FALA[ehFalhaDaFala(fala.erro) ? fala.erro : "erro_do_provedor"]);
    return (
      <Badge variant="destructive" title={motivo} data-estado-da-fala="falhou">
        {t("Falhou:")} {motivo}
      </Badge>
    );
  }
  if (vozAtual && fala.voice_id !== vozAtual) {
    return (
      <Badge variant="outline" data-estado-da-fala="outra-voz">
        {t("Pronta, com a voz anterior")}
      </Badge>
    );
  }
  return (
    <Badge className="bg-emerald-600 text-white hover:bg-emerald-600" data-estado-da-fala="pronta">
      {t("Pronta")}
    </Badge>
  );
}
```

Crie `components/telefonia/OuvirFala.tsx`:

```tsx
"use client";
/**
 * Toca uma fala do telefone no navegador. A rota devolve o μ-law (8 kHz)
 * exatamente como o Asterisk o toca; aqui ele vira PCM16 dentro de um WAV
 * (`ulawParaWav`), porque navegador não toca μ-law cru. Uma chamada só, sem
 * custo na ElevenLabs.
 */
import { useEffect, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ulawParaWav } from "@/lib/telefonia/ulaw";

export function OuvirFala({ falaId, tocarAoCarregar = false }: { falaId: string; tocarAoCarregar?: boolean }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let vivo = true;
    let criada: string | null = null;
    setUrl(null);
    setErro(false);
    fetch(`/api/v1/telefonia/falas/${falaId}/audio`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return new Uint8Array(await r.arrayBuffer());
      })
      .then((bytes) => {
        if (!vivo) return;
        criada = URL.createObjectURL(new Blob([ulawParaWav(bytes)], { type: "audio/wav" }));
        setUrl(criada);
      })
      .catch(() => {
        if (vivo) setErro(true);
      });
    return () => {
      vivo = false;
      if (criada) URL.revokeObjectURL(criada);
    };
  }, [falaId]);

  useEffect(() => {
    if (url && tocarAoCarregar) void audio.current?.play().catch(() => undefined);
  }, [url, tocarAoCarregar]);

  if (erro) return <span className="text-xs text-destructive">{t("Não foi possível carregar o áudio desta fala.")}</span>;
  if (!url) return <span className="text-xs text-muted-foreground">{t("Carregando o áudio…")}</span>;
  return <audio ref={audio} controls src={url} data-fala-audio={falaId} className="h-8 max-w-full" />;
}
```

Crie `components/connections/telefone/MenusDoTelefone.tsx` (casca; a Task 19 troca o arquivo inteiro):

```tsx
"use client";
/** Conexões › Telefone › Menus — o conteúdo chega na próxima task. */
export function MenusDoTelefone() {
  return <div data-menus-do-telefone />;
}
```

- [ ] **Step 4: A aba Voz e falas**

Crie `components/connections/telefone/VozEFalas.tsx`:

```tsx
"use client";
/**
 * Conexões › Telefone › Voz e falas (desenho da fase 2, §6.2).
 *
 * A voz das falas e as três falas gerais da organização — aguarde, ninguém
 * atendeu e fora do horário. Cada fala é gerada na ElevenLabs pela API, fica no
 * Storage e é tocada pelo worker; aqui a pessoa escreve, gera e ouve. Sem a chave
 * da ElevenLabs nada é gerado, e a tela diz onde cadastrar.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";
import {
  FALAS_GERAIS,
  MENSAGEM_DA_FALHA_DA_FALA,
  TAMANHO_MAXIMO_DA_FALA,
  type FalaGeral,
  type FalaPublica,
} from "@/lib/telefonia/vocabulario";
import { Play } from "@/lib/ui/icons";

import { CHAVE_DA_VOZ, useVozDoTelefone, useVozesDaConta, type RespostaDaFala } from "./api";
import { EstadoDaFala } from "./EstadoDaFala";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

const TITULO: Record<FalaGeral, string> = {
  waiting: "Aguarde",
  nobody: "Ninguém atendeu",
  after_hours: "Fora do horário",
};

const QUANDO_TOCA: Record<FalaGeral, string> = {
  waiting: "Toca quando o cliente precisa esperar na fila, e de novo a cada 40 segundos, entre a música.",
  nobody: "Toca antes de desligar, quando ninguém do time atendeu a tempo.",
  after_hours: "Toca quando o time está fora do horário, e a ligação é encerrada em seguida.",
};

export function VozEFalas() {
  const t = useT();
  const qc = useQueryClient();
  const consulta = useVozDoTelefone();
  const dados = consulta.data;
  const temChave = Boolean(dados?.chave.cadastrada);
  const vozes = useVozesDaConta(temChave);

  const salvarVoz = useMutation({
    mutationFn: (voice_id: string) => apiClient.put("/api/v1/telefonia/voz", { voice_id }),
    onSuccess: async () => {
      toast.success(t("Voz salva. Gere as falas de novo para usar a voz nova."));
      await qc.invalidateQueries({ queryKey: CHAVE_DA_VOZ });
    },
    onError: (e) => showApiError(e),
  });

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (consulta.isError || !dados) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        {t("Não foi possível carregar a voz do telefone. Recarregue a página.")}
      </Card>
    );
  }
  if (!dados.oferecida) return <TelefoniaDesligada />;

  if (!temChave) {
    return (
      <Card className="space-y-3 p-5" data-telefonia-sem-chave>
        <h2 className="text-base font-semibold">{t("Falta a chave da ElevenLabs")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "As falas do telefone (menu, aguarde, fora do horário e aviso de instabilidade) são geradas pela ElevenLabs, com a chave da sua conta. Sem a chave, nenhuma fala é gerada e nenhum menu pode ser ligado a um número.",
          )}
        </p>
        <Button asChild variant="outline">
          <Link href="/app/ai/credentials">{t("Cadastrar a chave em Credenciais de IA")}</Link>
        </Button>
      </Card>
    );
  }

  const vozAtual = dados.voz?.voice_id ?? null;
  const amostra = (vozes.data ?? []).find((v) => v.voice_id === vozAtual)?.amostra_url ?? null;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{t("Voz das falas")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "A mesma voz vale para todas as falas desta organização. Trocar a voz não regrava as falas já geradas: gere cada uma de novo.",
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="tel-voz">{t("Voz")}</Label>
            <Select value={vozAtual ?? ""} onValueChange={(v) => salvarVoz.mutate(v)} disabled={salvarVoz.isPending || vozes.isLoading}>
              <SelectTrigger id="tel-voz">
                <SelectValue placeholder={vozes.isLoading ? t("Carregando…") : t("Escolha uma voz")} />
              </SelectTrigger>
              <SelectContent>
                {(vozes.data ?? []).map((v) => (
                  <SelectItem key={v.voice_id} value={v.voice_id}>
                    {v.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!amostra}
            onClick={() => {
              if (amostra) void new Audio(amostra).play().catch(() => undefined);
            }}
          >
            <Play size={16} aria-hidden /> {t("Ouvir amostra")}
          </Button>
        </div>
        {vozes.isError ? (
          <p className="text-sm text-destructive">
            {t("Não foi possível listar as vozes da sua conta da ElevenLabs. Confira a chave em Credenciais de IA.")}
          </p>
        ) : null}
      </Card>

      {FALAS_GERAIS.map((tipo) => (
        <CartaoDaFalaGeral key={tipo} tipo={tipo} fala={dados.falas[tipo]} vozAtual={vozAtual} />
      ))}
    </div>
  );
}

function CartaoDaFalaGeral({ tipo, fala, vozAtual }: { tipo: FalaGeral; fala: FalaPublica | null; vozAtual: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [texto, setTexto] = useState(fala?.texto ?? t(TEXTO_SUGERIDO[tipo]));
  const [ouvir, setOuvir] = useState<string | null>(null);

  const gerar = useMutation({
    mutationFn: async () =>
      (await apiClient.put<{ data: RespostaDaFala }>(`/api/v1/telefonia/falas/gerais/${tipo}`, { texto })).data,
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: CHAVE_DA_VOZ });
      if (r?.falha) {
        toast.error(t(MENSAGEM_DA_FALHA_DA_FALA[r.falha.motivo]));
        return;
      }
      if (r?.fala) setOuvir(r.fala.id);
      toast.success(t("Fala gerada."));
    },
    onError: (e) => showApiError(e),
  });

  const idParaOuvir = ouvir ?? (fala?.status === "ready" ? fala.id : null);
  const idDoCampo = `tel-fala-${tipo}`;

  return (
    <Card className="space-y-3 p-5" data-fala-geral={tipo}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(TITULO[tipo])}</h3>
        <EstadoDaFala fala={fala} vozAtual={vozAtual} gerando={gerar.isPending} />
      </div>
      <p className="text-xs text-muted-foreground">{t(QUANDO_TOCA[tipo])}</p>
      <Label htmlFor={idDoCampo} className="sr-only">
        {t("Texto da fala")}
      </Label>
      <Textarea
        id={idDoCampo}
        rows={3}
        maxLength={TAMANHO_MAXIMO_DA_FALA}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => gerar.mutate()} disabled={!vozAtual || !texto.trim() || gerar.isPending}>
          <Play size={16} aria-hidden /> {gerar.isPending ? t("Gerando…") : t("Gerar e ouvir")}
        </Button>
        {!vozAtual ? <span className="text-xs text-muted-foreground">{t("Escolha a voz acima antes de gerar.")}</span> : null}
        {idParaOuvir ? <OuvirFala falaId={idParaOuvir} tocarAoCarregar={ouvir !== null} /> : null}
      </div>
    </Card>
  );
}
```

- [ ] **Step 5: As abas do Telefone e o cartão "desligada" compartilhado**

Em `components/connections/ConexoesShell.tsx`:

(a) acrescente aos imports:

```ts
import { MenusDoTelefone } from "./telefone/MenusDoTelefone";
import { VozEFalas } from "./telefone/VozEFalas";
```

(b) logo depois da linha `  const sub = params.get("sub") === "templates" ? "templates" : "conexao";`, acrescente:

```ts
  // As sub-abas do Telefone (fase 2): `?aba=telefone&sub=menus|falas`. `?aba=` já
  // escolhe o canal, então a aba de dentro mora em `?sub=` — o mesmo padrão de
  // `?aba=oficial&sub=templates`. É para cá que o aviso "uma fala não tocou" da
  // Central aponta (`/app/connections?aba=telefone&sub=falas`).
  const subDoTelefone = params.get("sub") === "menus" ? "menus" : params.get("sub") === "falas" ? "falas" : "numeros";
```

(c) em `irPara`, troque a linha `    if (proximaSub && proximaSub !== "conexao") q.set("sub", proximaSub);` por:

```ts
    if (proximaSub && proximaSub !== "conexao" && proximaSub !== "numeros") q.set("sub", proximaSub);
```

(d) troque

```tsx
      <TabsContent value="telefone" className="mt-0">
        <CanalTelefoneClient />
      </TabsContent>
```

por

```tsx
      <TabsContent value="telefone" className="mt-0">
        <Tabs value={subDoTelefone} onValueChange={(v) => irPara("telefone", v)} className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="numeros">{t("Números")}</TabsTrigger>
            <TabsTrigger value="menus">{t("Menus")}</TabsTrigger>
            <TabsTrigger value="falas">{t("Voz e falas")}</TabsTrigger>
          </TabsList>
          <TabsContent value="numeros" className="mt-0">
            <CanalTelefoneClient />
          </TabsContent>
          <TabsContent value="menus" className="mt-0">
            <MenusDoTelefone />
          </TabsContent>
          <TabsContent value="falas" className="mt-0">
            <VozEFalas />
          </TabsContent>
        </Tabs>
      </TabsContent>
```

Em `components/connections/CanalTelefoneClient.tsx`, acrescente o import `import { TelefoniaDesligada } from "./telefone/TelefoniaDesligada";` e troque o bloco

```tsx
  if (dados && !dados.oferecida) {
    return (
      <Card className="space-y-2 p-5" data-telefonia-desligada>
        <h2 className="text-base font-semibold">{t("Telefonia desligada nesta instalação")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Para fazer e receber ligações pelo CRM, quem administra o servidor precisa ligar a telefonia (perfil “telefonia” do Docker Compose) e rodar a atualização. Depois disso, os números são cadastrados aqui.",
          )}
        </p>
      </Card>
    );
  }
```

por

```tsx
  if (dados && !dados.oferecida) return <TelefoniaDesligada />;
```

- [ ] **Step 6: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — Conexões › Telefone (abas, voz e falas)
  Números: { es: "Números" },
  Menus: { es: "Menús" },
  "Voz e falas": { es: "Voz y locuciones" },
  "Não foi possível carregar a voz do telefone. Recarregue a página.": {
    es: "No se pudo cargar la voz del teléfono. Recarga la página.",
  },
  "Falta a chave da ElevenLabs": { es: "Falta la clave de ElevenLabs" },
  "As falas do telefone (menu, aguarde, fora do horário e aviso de instabilidade) são geradas pela ElevenLabs, com a chave da sua conta. Sem a chave, nenhuma fala é gerada e nenhum menu pode ser ligado a um número.": {
    es: "Las locuciones del teléfono (menú, espere, fuera de horario y aviso de inestabilidad) las genera ElevenLabs con la clave de tu cuenta. Sin la clave no se genera ninguna locución y ningún menú puede conectarse a un número.",
  },
  "Cadastrar a chave em Credenciais de IA": { es: "Registrar la clave en Credenciales de IA" },
  "Voz das falas": { es: "Voz de las locuciones" },
  "A mesma voz vale para todas as falas desta organização. Trocar a voz não regrava as falas já geradas: gere cada uma de novo.": {
    es: "La misma voz vale para todas las locuciones de esta organización. Cambiar la voz no regraba las locuciones ya generadas: genera cada una de nuevo.",
  },
  Voz: { es: "Voz" },
  "Escolha uma voz": { es: "Elige una voz" },
  "Ouvir amostra": { es: "Escuchar muestra" },
  "Não foi possível listar as vozes da sua conta da ElevenLabs. Confira a chave em Credenciais de IA.": {
    es: "No se pudieron listar las voces de tu cuenta de ElevenLabs. Revisa la clave en Credenciales de IA.",
  },
  "Voz salva. Gere as falas de novo para usar a voz nova.": {
    es: "Voz guardada. Genera las locuciones de nuevo para usar la voz nueva.",
  },
  Aguarde: { es: "Espere" },
  "Ninguém atendeu": { es: "Nadie atendió" },
  "Fora do horário": { es: "Fuera de horario" },
  "Toca quando o cliente precisa esperar na fila, e de novo a cada 40 segundos, entre a música.": {
    es: "Suena cuando el cliente necesita esperar en la fila, y de nuevo cada 40 segundos, entre la música.",
  },
  "Toca antes de desligar, quando ninguém do time atendeu a tempo.": {
    es: "Suena antes de colgar, cuando nadie del equipo atendió a tiempo.",
  },
  "Toca quando o time está fora do horário, e a ligação é encerrada em seguida.": {
    es: "Suena cuando el equipo está fuera de horario, y la llamada se cierra a continuación.",
  },
  "Texto da fala": { es: "Texto de la locución" },
  "Gerar e ouvir": { es: "Generar y escuchar" },
  "Escolha a voz acima antes de gerar.": { es: "Elige la voz arriba antes de generar." },
  "Fala gerada.": { es: "Locución generada." },
  "Ainda não gerada": { es: "Aún no generada" },
  "Falhou:": { es: "Falló:" },
  "Pronta, com a voz anterior": { es: "Lista, con la voz anterior" },
  Pronta: { es: "Lista" },
  "Não foi possível carregar o áudio desta fala.": { es: "No se pudo cargar el audio de esta locución." },
  "Carregando o áudio…": { es: "Cargando el audio…" },
  // Os textos sugeridos das falas (lib/telefonia/texto-do-menu.ts), passados por t()
  "Todos os nossos atendentes estão ocupados no momento. Por favor, aguarde na linha que já vamos atender você.": {
    es: "Todos nuestros agentes están ocupados en este momento. Por favor, espere en línea que enseguida le atenderemos.",
  },
  "No momento não conseguimos atender. Registramos a sua ligação e vamos retornar assim que possível. Obrigado.": {
    es: "En este momento no podemos atender. Registramos su llamada y le devolveremos la llamada lo antes posible. Gracias.",
  },
  "Nosso atendimento está fechado agora. Ligue de novo no nosso horário de atendimento. Obrigado pela ligação.": {
    es: "Nuestra atención está cerrada ahora. Llame de nuevo en nuestro horario de atención. Gracias por su llamada.",
  },
  "Estamos com uma instabilidade no momento e já estamos trabalhando para resolver. Obrigado pela paciência.": {
    es: "Tenemos una inestabilidad en este momento y ya estamos trabajando para resolverla. Gracias por su paciencia.",
  },
  "Opção inválida.": { es: "Opción inválida." },
  "Para {time}, digite {tecla}.": { es: "Para {time}, marque {tecla}." },
```

- [ ] **Step 7: Rodar os testes da tela, o gate de i18n e o typecheck**

Run: `pnpm exec vitest run components/connections/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/templates-do-parceiro.test.ts && pnpm typecheck`
Expected: PASS (inclusive `CanalTelefoneClient.prefixo.test.tsx`); `tsc` sem erro.

- [ ] **Step 8: Commit**

```bash
git add components/connections/telefone/ components/telefonia/OuvirFala.tsx components/connections/ConexoesShell.tsx \
  components/connections/CanalTelefoneClient.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): abas Números, Menus e Voz e falas em Conexões › Telefone

A voz da organização (com amostra) e as três falas gerais, com texto sugerido,
Gerar e ouvir e o estado de cada uma. O áudio é ouvido no navegador a partir do
μ-law que o Asterisk toca, convertido em WAV. Sem a chave, a aba diz onde
cadastrar.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 19: Tela — a aba Menus (lista, editor e "últimos 7 dias")

**Files:**
- Modify: `components/connections/telefone/MenusDoTelefone.tsx` (arquivo inteiro — troca a casca da Task 18)
- Create: `components/connections/telefone/MenusDoTelefone.test.tsx`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste (falha: a casca não mostra nada)**

Crie `components/connections/telefone/MenusDoTelefone.test.tsx`:

```tsx
/**
 * A ABA MENUS: o cartão de cada menu diz o que ele faz (tecla → time, padrão,
 * números que o tocam) e o que as ligações fizeram nele nos últimos 7 dias — com o
 * alerta quando muita gente cai no padrão sem escolher (o laço de retorno da URA).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MenuPublico } from "@/lib/telefonia/vocabulario";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/telefonia/OuvirFala", () => ({ OuvirFala: () => null }));

const MENU: MenuPublico = {
  id: "m1",
  nome: "Principal",
  time_padrao_id: "t1",
  time_padrao_nome: "Suporte",
  opcoes: [
    { tecla: "1", time_id: "t1", time_nome: "Suporte" },
    { tecla: "2", time_id: "t2", time_nome: "Financeiro" },
  ],
  fala: {
    id: "f1",
    tipo: "menu",
    texto: "Para Suporte, digite 1. Para Financeiro, digite 2.",
    voice_id: "v1",
    status: "ready",
    erro: null,
    duracao_ms: 3000,
    atualizada_em: "2026-09-28T13:00:00.000Z",
  },
  fala_invalida: null,
  pronto: true,
  numeros: ["Totus 3025"],
  ultimos_7_dias: { total: 10, por_tecla: { "1": 4, "2": 1 }, sem_escolha: 4, tecla_errada: 1, desligou_no_menu: 0 },
};

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) =>
      url.endsWith("/menus")
        ? { data: { oferecida: true, menus: [MENU] } }
        : {
            data: {
              oferecida: true,
              chave: { cadastrada: true, last4: "1234" },
              voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
              falas: { waiting: null, nobody: null, after_hours: null },
            },
          },
    ),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { MenusDoTelefone } from "./MenusDoTelefone";

afterEach(() => cleanup());

describe("aba Menus", () => {
  it("o cartão diz o que o menu faz e o que as ligações fizeram nele — com o alerta de menu que confunde", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MenusDoTelefone />
      </QueryClientProvider>,
    );
    const cartao = (await screen.findByText("Principal")).closest("[data-menu]") as HTMLElement;
    expect(within(cartao).getByText(/1 → Suporte/)).toBeInTheDocument();
    expect(within(cartao).getByText(/2 → Financeiro/)).toBeInTheDocument();
    expect(within(cartao).getByText(/Totus 3025/)).toBeInTheDocument();

    const semana = within(cartao).getByTestId("menu-ultimos-7-dias");
    expect(semana).toHaveTextContent("10 ligações");
    expect(semana).toHaveTextContent("Sem escolha: 4");
    expect(semana).toHaveTextContent("Tecla errada: 1");
    expect(within(semana).getByText(/talvez a fala do menu esteja confusa/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/connections/telefone/MenusDoTelefone.test.tsx`
Expected: FAIL — `Unable to find an element with the text: Principal`.

- [ ] **Step 3: A aba Menus**

Substitua o conteúdo inteiro de `components/connections/telefone/MenusDoTelefone.tsx` por:

```tsx
"use client";
/**
 * Conexões › Telefone › Menus (desenho da fase 2, §6.2).
 *
 * O menu de voz (URA) da organização: tecla → time, o time padrão para quem não
 * escolhe, e a fala — montada a partir das opções e editável antes de gerar. Um
 * menu serve a vários números; quem liga o menu a um número é a aba Números, e só
 * com a fala pronta. O bloco "últimos 7 dias" é o laço de retorno (desenho §8):
 * muita gente caindo no padrão sem escolher é o sinal de que a fala confunde.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { useT } from "@/hooks/i18n/useT";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { FRASE_DA_OPCAO, TEXTO_SUGERIDO, montarTextoDoMenu } from "@/lib/telefonia/texto-do-menu";
import { menuConfunde } from "@/lib/telefonia/ultimos-sete-dias";
import { MENSAGEM_DA_FALHA_DA_FALA, TAMANHO_MAXIMO_DA_FALA, type MenuPublico } from "@/lib/telefonia/vocabulario";
import { PencilSimple, Plus, Trash, TreeStructure } from "@/lib/ui/icons";

import { CHAVE_DOS_MENUS, useMenusDoTelefone, useVozDoTelefone, type RespostaDoMenu } from "./api";
import { EstadoDaFala } from "./EstadoDaFala";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

interface LinhaDeOpcao {
  tecla: string;
  time_id: string;
}

interface Rascunho {
  nome: string;
  opcoes: LinhaDeOpcao[];
  time_padrao_id: string;
  /** Texto escrito à mão; enquanto `textoEditado` for falso, vale o montado das opções. */
  texto_menu: string;
  textoEditado: boolean;
  texto_invalida: string;
}

export function MenusDoTelefone() {
  const t = useT();
  const consulta = useMenusDoTelefone();
  const voz = useVozDoTelefone();
  const [editando, setEditando] = useState<string | "novo" | null>(null);

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (consulta.isError || !consulta.data) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">{t("Não foi possível carregar os menus. Recarregue a página.")}</Card>
    );
  }
  if (!consulta.data.oferecida) return <TelefoniaDesligada />;

  const menus = consulta.data.menus;
  const semVoz = !voz.data?.chave.cadastrada || !voz.data?.voz;
  const vozAtual = voz.data?.voz?.voice_id ?? null;

  return (
    <div className="space-y-4">
      <Card className="space-y-1 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <TreeStructure size={18} aria-hidden /> {t("Menus de voz")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "O menu atende a ligação, fala as opções e leva o cliente ao time da tecla que ele apertar. Quem não escolhe vai para o time padrão. Depois de pronto, ligue o menu a um número na aba Números.",
          )}
        </p>
        {semVoz ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t("Para gerar a fala do menu, cadastre a chave da ElevenLabs e escolha a voz na aba Voz e falas.")}
          </p>
        ) : null}
      </Card>

      {menus.map((m) =>
        editando === m.id ? (
          <EditorDeMenu key={m.id} menu={m} aoFechar={() => setEditando(null)} />
        ) : (
          <CartaoDoMenu key={m.id} menu={m} vozAtual={vozAtual} aoEditar={() => setEditando(m.id)} />
        ),
      )}

      {editando === "novo" ? (
        <EditorDeMenu menu={null} aoFechar={() => setEditando(null)} />
      ) : (
        <Button type="button" variant="outline" onClick={() => setEditando("novo")} disabled={semVoz}>
          <Plus size={16} aria-hidden /> {t("Novo menu")}
        </Button>
      )}
    </div>
  );
}

function CartaoDoMenu({ menu, vozAtual, aoEditar }: { menu: MenuPublico; vozAtual: string | null; aoEditar: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const u = menu.ultimos_7_dias;

  const arquivar = useMutation({
    mutationFn: () => apiClient.delete(`/api/v1/telefonia/menus/${menu.id}`),
    onSuccess: async () => {
      toast.success(t("Menu arquivado."));
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_MENUS });
    },
    onError: (e) => showApiError(e),
  });

  return (
    <Card className="space-y-3 p-4" data-menu={menu.id}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{menu.nome}</p>
        <EstadoDaFala fala={menu.fala} vozAtual={vozAtual} />
        <Button type="button" variant="ghost" size="icon" aria-label={t("Editar")} onClick={aoEditar}>
          <PencilSimple size={16} aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("Arquivar")}
          disabled={arquivar.isPending}
          onClick={() => {
            if (window.confirm(t("Arquivar este menu? Ele sai da lista e não pode mais ser ligado a um número."))) arquivar.mutate();
          }}
        >
          <Trash size={16} aria-hidden />
        </Button>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {menu.opcoes.map((o) => (
          <li key={o.tecla}>
            {t("Tecla")} {`${o.tecla} → ${o.time_nome}`}
          </li>
        ))}
        <li>
          {t("Padrão (sem escolha):")} {menu.time_padrao_nome}
        </li>
      </ul>
      <p className="text-xs text-muted-foreground">
        {menu.numeros.length > 0
          ? `${t("Usado por:")} ${menu.numeros.join(", ")}`
          : t("Nenhum número usa este menu ainda. Ligue-o a um número na aba Números.")}
      </p>
      {menu.fala?.status === "ready" ? <OuvirFala falaId={menu.fala.id} /> : null}

      <div className="rounded-md border bg-muted/30 p-3 text-xs" data-testid="menu-ultimos-7-dias">
        <p className="font-medium">{t("Últimos 7 dias")}</p>
        {u.total === 0 ? (
          <p className="text-muted-foreground">{t("Nenhuma ligação passou por este menu ainda.")}</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <li>
              {u.total} {t("ligações")}
            </li>
            {menu.opcoes.map((o) => (
              <li key={o.tecla}>
                {t("Tecla")} {`${o.tecla} (${o.time_nome}): ${u.por_tecla[o.tecla] ?? 0}`}
              </li>
            ))}
            <li>
              {t("Sem escolha")}: {u.sem_escolha}
            </li>
            <li>
              {t("Tecla errada")}: {u.tecla_errada}
            </li>
            <li>
              {t("Desligou no menu")}: {u.desligou_no_menu}
            </li>
          </ul>
        )}
        {menuConfunde(u) ? (
          <p className="mt-1 text-amber-700 dark:text-amber-400">
            {t("Muita gente cai no time padrão sem escolher: talvez a fala do menu esteja confusa.")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function EditorDeMenu({ menu, aoFechar }: { menu: MenuPublico | null; aoFechar: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const times = (useTimesDoInbox().data ?? []).filter((x) => !x.archived);
  const nomeDoTime = (id: string) => times.find((x) => x.id === id)?.name ?? "";

  const [r, setR] = useState<Rascunho>(() =>
    menu
      ? {
          nome: menu.nome,
          opcoes: menu.opcoes.map((o) => ({ tecla: o.tecla, time_id: o.time_id })),
          time_padrao_id: menu.time_padrao_id,
          texto_menu: menu.fala?.texto ?? "",
          textoEditado: Boolean(menu.fala?.texto),
          texto_invalida: menu.fala_invalida?.texto ?? "",
        }
      : { nome: "", opcoes: [{ tecla: "1", time_id: "" }], time_padrao_id: "", texto_menu: "", textoEditado: false, texto_invalida: "" },
  );

  const textoMontado = montarTextoDoMenu(
    r.opcoes.map((o) => ({ tecla: o.tecla, nomeDoTime: nomeDoTime(o.time_id) })),
    t(FRASE_DA_OPCAO),
  );
  const textoDoMenu = r.textoEditado ? r.texto_menu : textoMontado;
  const teclasUsadas = r.opcoes.map((o) => o.tecla);
  const repetida = new Set(teclasUsadas).size !== teclasUsadas.length;
  const proximaTecla = TECLAS.find((k) => !teclasUsadas.includes(k));
  const podeSalvar =
    r.nome.trim() !== "" &&
    r.opcoes.length > 0 &&
    r.opcoes.every((o) => o.time_id) &&
    !repetida &&
    r.time_padrao_id !== "" &&
    textoDoMenu.trim() !== "";

  const salvar = useMutation({
    mutationFn: async () => {
      const corpo = {
        nome: r.nome,
        opcoes: r.opcoes,
        time_padrao_id: r.time_padrao_id,
        texto_menu: textoDoMenu,
        texto_invalida: r.texto_invalida.trim() || null,
      };
      const resp = menu
        ? await apiClient.patch<{ data: RespostaDoMenu }>(`/api/v1/telefonia/menus/${menu.id}`, corpo)
        : await apiClient.post<{ data: RespostaDoMenu }>("/api/v1/telefonia/menus", corpo);
      return resp.data;
    },
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_MENUS });
      if (d?.falha) toast.error(t(MENSAGEM_DA_FALHA_DA_FALA[d.falha.motivo]));
      else toast.success(t("Menu salvo, com a fala pronta."));
      aoFechar();
    },
    onError: (e) => showApiError(e),
  });

  const mudarOpcao = (i: number, m: Partial<LinhaDeOpcao>) =>
    setR((x) => ({ ...x, opcoes: x.opcoes.map((o, j) => (j === i ? { ...o, ...m } : o)) }));

  return (
    <Card className="space-y-4 p-5" data-editor-de-menu>
      <h3 className="text-sm font-semibold">{menu ? t("Editar menu") : t("Novo menu")}</h3>
      <div className="space-y-1.5">
        <Label htmlFor="menu-nome">{t("Nome do menu")}</Label>
        <Input
          id="menu-nome"
          value={r.nome}
          maxLength={80}
          onChange={(e) => setR((x) => ({ ...x, nome: e.target.value }))}
          placeholder={t("Ex.: Atendimento principal")}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("Opções")}</legend>
        {r.opcoes.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-opcao-do-menu={i}>
            <span className="text-sm text-muted-foreground">{t("Tecla")}</span>
            <Select value={o.tecla} onValueChange={(v) => mudarOpcao(i, { tecla: v })}>
              <SelectTrigger className="w-20" aria-label={t("Tecla da opção")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TECLAS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">→</span>
            <Select value={o.time_id} onValueChange={(v) => mudarOpcao(i, { time_id: v })}>
              <SelectTrigger className="min-w-[12rem] flex-1" aria-label={t("Time da opção")}>
                <SelectValue placeholder={t("Escolha o time")} />
              </SelectTrigger>
              <SelectContent>
                {times.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Remover opção")}
              disabled={r.opcoes.length === 1}
              onClick={() => setR((x) => ({ ...x, opcoes: x.opcoes.filter((_, j) => j !== i) }))}
            >
              <Trash size={16} aria-hidden />
            </Button>
          </div>
        ))}
        {repetida ? <p className="text-xs text-destructive">{t("Cada tecla só pode levar a um time.")}</p> : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!proximaTecla}
          onClick={() => {
            if (proximaTecla) setR((x) => ({ ...x, opcoes: [...x.opcoes, { tecla: proximaTecla, time_id: "" }] }));
          }}
        >
          <Plus size={14} aria-hidden /> {t("Adicionar opção")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("As teclas * e # ficam reservadas.")}</p>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="menu-padrao">{t("Time padrão (quem não escolhe nada)")}</Label>
        <Select value={r.time_padrao_id} onValueChange={(v) => setR((x) => ({ ...x, time_padrao_id: v }))}>
          <SelectTrigger id="menu-padrao">
            <SelectValue placeholder={t("Escolha o time")} />
          </SelectTrigger>
          <SelectContent>
            {times.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="menu-texto">{t("Fala do menu")}</Label>
        <Textarea
          id="menu-texto"
          rows={3}
          maxLength={TAMANHO_MAXIMO_DA_FALA}
          value={textoDoMenu}
          onChange={(e) => setR((x) => ({ ...x, texto_menu: e.target.value, textoEditado: true }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("Montada a partir das opções. Você pode editar antes de gerar.")}</p>
          {r.textoEditado ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setR((x) => ({ ...x, textoEditado: false, texto_menu: "" }))}
            >
              {t("Refazer a partir das opções")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="menu-invalida">{t("Fala de tecla inválida (opcional)")}</Label>
        <Textarea
          id="menu-invalida"
          rows={2}
          maxLength={TAMANHO_MAXIMO_DA_FALA}
          value={r.texto_invalida}
          placeholder={t(TEXTO_SUGERIDO.invalid)}
          onChange={(e) => setR((x) => ({ ...x, texto_invalida: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          {t("Toca quando o cliente aperta uma tecla que não é opção, antes de repetir o menu.")}
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending}>
          {salvar.isPending ? t("Gerando a fala…") : t("Salvar e gerar a fala")}
        </Button>
        <Button type="button" variant="ghost" onClick={aoFechar} disabled={salvar.isPending}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — aba Menus
  "Não foi possível carregar os menus. Recarregue a página.": { es: "No se pudieron cargar los menús. Recarga la página." },
  "Menus de voz": { es: "Menús de voz" },
  "O menu atende a ligação, fala as opções e leva o cliente ao time da tecla que ele apertar. Quem não escolhe vai para o time padrão. Depois de pronto, ligue o menu a um número na aba Números.": {
    es: "El menú atiende la llamada, dice las opciones y lleva al cliente al equipo de la tecla que marque. Quien no elige va al equipo predeterminado. Cuando esté listo, conecta el menú a un número en la pestaña Números.",
  },
  "Para gerar a fala do menu, cadastre a chave da ElevenLabs e escolha a voz na aba Voz e falas.": {
    es: "Para generar la locución del menú, registra la clave de ElevenLabs y elige la voz en la pestaña Voz y locuciones.",
  },
  "Novo menu": { es: "Nuevo menú" },
  "Arquivar este menu? Ele sai da lista e não pode mais ser ligado a um número.": {
    es: "¿Archivar este menú? Sale de la lista y ya no se puede conectar a un número.",
  },
  "Menu arquivado.": { es: "Menú archivado." },
  Tecla: { es: "Tecla" },
  "Padrão (sem escolha):": { es: "Predeterminado (sin elección):" },
  "Usado por:": { es: "Usado por:" },
  "Nenhum número usa este menu ainda. Ligue-o a um número na aba Números.": {
    es: "Ningún número usa este menú todavía. Conéctalo a un número en la pestaña Números.",
  },
  "Nenhuma ligação passou por este menu ainda.": { es: "Ninguna llamada pasó por este menú todavía." },
  ligações: { es: "llamadas" },
  "Sem escolha": { es: "Sin elección" },
  "Tecla errada": { es: "Tecla incorrecta" },
  "Desligou no menu": { es: "Colgó en el menú" },
  "Muita gente cai no time padrão sem escolher: talvez a fala do menu esteja confusa.": {
    es: "Mucha gente cae en el equipo predeterminado sin elegir: tal vez la locución del menú sea confusa.",
  },
  "Editar menu": { es: "Editar menú" },
  "Nome do menu": { es: "Nombre del menú" },
  "Ex.: Atendimento principal": { es: "Ej.: Atención principal" },
  Opções: { es: "Opciones" },
  "Tecla da opção": { es: "Tecla de la opción" },
  "Time da opção": { es: "Equipo de la opción" },
  "Remover opção": { es: "Quitar opción" },
  "Adicionar opção": { es: "Agregar opción" },
  "As teclas * e # ficam reservadas.": { es: "Las teclas * y # quedan reservadas." },
  "Time padrão (quem não escolhe nada)": { es: "Equipo predeterminado (quien no elige nada)" },
  "Fala do menu": { es: "Locución del menú" },
  "Montada a partir das opções. Você pode editar antes de gerar.": {
    es: "Armada a partir de las opciones. Puedes editarla antes de generar.",
  },
  "Refazer a partir das opções": { es: "Rehacer a partir de las opciones" },
  "Fala de tecla inválida (opcional)": { es: "Locución de tecla inválida (opcional)" },
  "Toca quando o cliente aperta uma tecla que não é opção, antes de repetir o menu.": {
    es: "Suena cuando el cliente marca una tecla que no es opción, antes de repetir el menú.",
  },
  "Gerando a fala…": { es: "Generando la locución…" },
  "Salvar e gerar a fala": { es: "Guardar y generar la locución" },
  "Menu salvo, com a fala pronta.": { es: "Menú guardado, con la locución lista." },
```

- [ ] **Step 5: Rodar, gate de i18n e typecheck**

Run: `pnpm exec vitest run components/connections/telefone/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS; `tsc` sem erro.

- [ ] **Step 6: Commit**

```bash
git add components/connections/telefone/MenusDoTelefone.tsx components/connections/telefone/MenusDoTelefone.test.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): aba Menus — editor de tecla → time e o 'últimos 7 dias'

A fala do menu nasce das opções ('Para Suporte, digite 1…') e pode ser editada
antes de gerar; a fala de tecla inválida é opcional. Cada menu mostra o que as
ligações fizeram nele e avisa quando muita gente cai no padrão sem escolher.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 20: Tela — "Quando ligarem: tocar no time ou tocar o menu"

**Files:**
- Modify: `components/connections/CanalTelefoneClient.tsx` (tipos 37–74; `abrirEdicao` 123–136; `salvar` 138–151; a linha do "Recebe:" 244–246; `podeSalvar` 200–206; o bloco do time 351–371)
- Create: `components/connections/CanalTelefoneClient.destino.test.tsx`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste (falha: o número não conhece menu)**

Crie `components/connections/CanalTelefoneClient.destino.test.tsx`:

```tsx
/**
 * O NÚMERO QUE TOCA UM MENU (fase 2): o cartão diz qual menu atende, e editar o
 * número mantém o menu — o PATCH manda `menu_id` e `time_id: null`, nunca os dois.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const api = vi.hoisted(() => ({ patch: vi.fn(async () => ({ data: null })) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) =>
      url.endsWith("/menus")
        ? { data: { oferecida: true, menus: [{ id: "m1", nome: "Principal", pronto: true }] } }
        : {
            data: {
              oferecida: true,
              numeros: [
                {
                  id: "n1",
                  nome: "Totus 3025",
                  numero: "+556136861503",
                  servidor: "voip.totussistema.com.br",
                  porta: 5060,
                  transporte: "udp",
                  usuario: "6136861503",
                  prefixo: "0",
                  time_id: null,
                  time_nome: null,
                  menu_id: "m1",
                  menu_nome: "Principal",
                  status: "WORKING",
                  status_reason: null,
                },
              ],
            },
          },
    ),
    patch: api.patch,
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { CanalTelefoneClient } from "./CanalTelefoneClient";

afterEach(() => cleanup());

describe("o número que toca um menu", () => {
  it("o cartão diz o menu, e salvar sem mexer mantém o menu (e só ele)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CanalTelefoneClient />
      </QueryClientProvider>,
    );
    const cartao = (await screen.findByText("Totus 3025")).closest("[data-telefonia-numero]") as HTMLElement;
    expect(within(cartao).getByText(/Quando ligarem: menu Principal/)).toBeInTheDocument();

    await userEvent.click(within(cartao).getByRole("button", { name: "Editar" }));
    await userEvent.click(screen.getByRole("button", { name: "Salvar e conectar" }));

    const [, corpo] = api.patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(corpo).toMatchObject({ menu_id: "m1", time_id: null });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/connections/CanalTelefoneClient.destino.test.tsx`
Expected: FAIL — `Unable to find an element with the text: /Quando ligarem: menu Principal/`.

- [ ] **Step 3: Implementar em `CanalTelefoneClient.tsx`**

(a) Acrescente ao import de `./telefone/…` e dos hooks:

```ts
import { useMenusDoTelefone } from "./telefone/api";
```

(b) Em `interface NumeroSip`, logo depois de `  time_nome: string | null;`, acrescente:

```ts
  /** O menu de voz que atende este número (fase 2). Ausente numa API antiga. */
  menu_id?: string | null;
  menu_nome?: string | null;
```

(c) Em `interface Formulario`, logo depois de `  time_id: string;`, acrescente:

```ts
  destino: "time" | "menu";
  menu_id: string;
```

e em `VAZIO`, logo depois de `  time_id: "",`, acrescente:

```ts
  destino: "time",
  menu_id: "",
```

(d) Logo depois de `const SEM_TIME = "__nenhum__";`, acrescente `const SEM_MENU = "__sem_menu__";`.

(e) Dentro de `CanalTelefoneClient`, logo depois de `  const times = useTimesDoInbox();`, acrescente:

```ts
  const menus = useMenusDoTelefone().data?.menus ?? [];
```

(f) Em `abrirEdicao`, logo depois de `      time_id: n.time_id ?? "",`, acrescente:

```ts
      destino: n.menu_id ? "menu" : "time",
      menu_id: n.menu_id ?? "",
```

(g) Em `salvar`, troque a linha `      time_id: form.time_id || null,` por:

```ts
      // Um destino só (CHECK channel_sessions_sip_destino_check): o time OU o menu.
      time_id: form.destino === "time" ? form.time_id || null : null,
      menu_id: form.destino === "menu" ? form.menu_id || null : null,
```

(h) Troque as linhas do cartão

```tsx
            <p className="truncate text-xs text-muted-foreground">
              {n.time_nome ? `${t("Recebe:")} ${n.time_nome}` : t("Nenhum time recebe as ligações deste número")}
            </p>
```

por

```tsx
            <p className="truncate text-xs text-muted-foreground">
              {n.menu_nome
                ? `${t("Quando ligarem: menu")} ${n.menu_nome}`
                : n.time_nome
                  ? `${t("Recebe:")} ${n.time_nome}`
                  : t("Nenhum time recebe as ligações deste número")}
            </p>
```

(i) Em `podeSalvar`, troque a linha `    (editando !== "novo" || form.senha);` por:

```ts
    (editando !== "novo" || form.senha) &&
    (form.destino === "time" || form.menu_id !== "");
```

(j) Troque o bloco inteiro do time (do `<div className="space-y-1.5 sm:col-span-2">` que contém `<Label htmlFor="tel-time">` até o `</div>` que fecha esse bloco) por:

```tsx
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tel-destino">{t("Quando ligarem")}</Label>
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Select
                  value={form.destino}
                  onValueChange={(v) => setForm((f) => ({ ...f, destino: v as "time" | "menu" }))}
                >
                  <SelectTrigger id="tel-destino">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="time">{t("Tocar no time")}</SelectItem>
                    <SelectItem value="menu">{t("Tocar o menu")}</SelectItem>
                  </SelectContent>
                </Select>
                {form.destino === "time" ? (
                  <Select
                    value={form.time_id || SEM_TIME}
                    onValueChange={(v) => setForm((f) => ({ ...f, time_id: v === SEM_TIME ? "" : v }))}
                  >
                    <SelectTrigger id="tel-time" aria-label={t("Time que recebe as ligações")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_TIME}>{t("Nenhum (só ligações de saída)")}</SelectItem>
                      {(times.data ?? [])
                        .filter((x) => !x.archived)
                        .map((x) => (
                          <SelectItem key={x.id} value={x.id}>
                            {x.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={form.menu_id || SEM_MENU}
                    onValueChange={(v) => setForm((f) => ({ ...f, menu_id: v === SEM_MENU ? "" : v }))}
                  >
                    <SelectTrigger id="tel-menu" aria-label={t("Menu que atende as ligações")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_MENU} disabled>
                        {t("Escolha o menu")}
                      </SelectItem>
                      {menus.map((m) => (
                        // Menu com a fala pendente aparece, desabilitado, com o motivo:
                        // a API recusaria, e sumir com ele esconderia por quê.
                        <SelectItem key={m.id} value={m.id} disabled={!m.pronto}>
                          {m.pronto ? m.nome : `${m.nome} — ${t("fala pendente")}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {form.destino === "menu" && menus.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("Nenhum menu criado ainda. Crie um na aba Menus.")}</p>
              ) : null}
            </div>
```

- [ ] **Step 4: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Quando ligarem: menu": { es: "Cuando llamen: menú" },
  "Quando ligarem": { es: "Cuando llamen" },
  "Tocar no time": { es: "Sonar en el equipo" },
  "Tocar o menu": { es: "Reproducir el menú" },
  "Menu que atende as ligações": { es: "Menú que atiende las llamadas" },
  "Escolha o menu": { es: "Elige el menú" },
  "fala pendente": { es: "locución pendiente" },
  "Nenhum menu criado ainda. Crie um na aba Menus.": { es: "Ningún menú creado todavía. Crea uno en la pestaña Menús." },
```

- [ ] **Step 5: Rodar (o teste do prefixo inclusive), gate de i18n e typecheck**

Run: `pnpm exec vitest run components/connections/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS (`CanalTelefoneClient.prefixo.test.tsx` e o novo); `tsc` sem erro.

- [ ] **Step 6: Commit**

```bash
git add components/connections/CanalTelefoneClient.tsx components/connections/CanalTelefoneClient.destino.test.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): o número escolhe tocar no time ou tocar o menu

'Quando ligarem: tocar no time ou tocar o menu'; menu com a fala pendente aparece
desabilitado, com o motivo; o cartão diz qual menu atende o número.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 21: Tela — o aviso de instabilidade em Configurações › Times e a faixa em todo o CRM

**Files:**
- Create: `components/telefonia/useAvisosDeInstabilidade.ts`
- Create: `components/telefonia/AvisoDeInstabilidadeDoTime.tsx`
- Create: `components/telefonia/FaixaDoAvisoDeInstabilidade.tsx`, `components/telefonia/FaixaDoAvisoDeInstabilidade.test.tsx`
- Modify: `app/app/settings/teams/_client.tsx:60-62`
- Modify: `app/app/layout.tsx:248` (logo depois de `<ConexaoCaidaBanner caidas={conexoesCaidas} />`)
- Modify: `lib/i18n/dicionario.ts`

**Decisão registrada (polling, não Realtime):** ver "Decisões de implementação" no topo do plano — `attendance_teams` não está na publicação `supabase_realtime`; a faixa relê a cada 60 s (só onde a telefonia é oferecida) e na volta do foco, e a aba de quem liga/desliga invalida a consulta na hora.

- [ ] **Step 1: Teste da faixa (falha: o componente não existe)**

Crie `components/telefonia/FaixaDoAvisoDeInstabilidade.test.tsx`:

```tsx
/**
 * A FAIXA DO AVISO DE INSTABILIDADE: aparece para todo membro enquanto houver
 * aviso ligado, diz de qual time e até quando; o botão Desligar só para gerente e
 * admin; e some sem recarregar quando o aviso é desligado.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const estado = vi.hoisted(() => ({
  papel: "agent",
  ativo: true,
  apagar: vi.fn(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "o1", name: "Org", role: estado.papel },
  }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        oferecida: true,
        times: [
          {
            team_id: "t1",
            time_nome: "Suporte",
            ativa: estado.ativo,
            desde: estado.ativo ? "2026-09-28T13:00:00.000Z" : null,
            expira_em: estado.ativo ? "2026-09-28T15:00:00.000Z" : null,
            ligada_por: estado.ativo ? "Ana" : null,
            fala: null,
          },
        ],
      },
    })),
    delete: estado.apagar,
  },
}));

import { FaixaDoAvisoDeInstabilidade } from "./FaixaDoAvisoDeInstabilidade";

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FaixaDoAvisoDeInstabilidade />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.papel = "agent";
  estado.ativo = true;
  estado.apagar.mockReset();
  estado.apagar.mockImplementation(async () => {
    estado.ativo = false;
    return { data: { desligado: true } };
  });
});
afterEach(() => cleanup());

describe("faixa do aviso de instabilidade", () => {
  it("atendente vê a faixa com o time e a hora, mas não o botão", async () => {
    pintar();
    const faixa = await screen.findByRole("status");
    expect(faixa).toHaveTextContent("Aviso de instabilidade ligado no telefone do Suporte");
    expect(faixa).toHaveTextContent(/desliga às \d{2}:\d{2}/);
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
  });

  it("gerente desliga pela faixa, e ela some sem recarregar", async () => {
    estado.papel = "manager";
    pintar();
    await userEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    expect(estado.apagar).toHaveBeenCalledWith("/api/v1/telefonia/emergencias/t1");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("sem aviso ligado, nada aparece", async () => {
    estado.ativo = false;
    pintar();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/telefonia/FaixaDoAvisoDeInstabilidade.test.tsx`
Expected: FAIL — `Failed to resolve import "./FaixaDoAvisoDeInstabilidade"`.

- [ ] **Step 3: O hook compartilhado**

Crie `components/telefonia/useAvisosDeInstabilidade.ts`:

```ts
"use client";
/**
 * O aviso de instabilidade de cada time — o que a faixa em todo o CRM e o cartão
 * de Configurações › Times leem (desenho da fase 2, §6.3 e §6.4).
 *
 * Polling de 60 s, e não Realtime, por decisão medida: `attendance_teams` não
 * está na publicação `supabase_realtime` (a RLS deixa o membro ler, mas não há o
 * que assinar), e pôr a tabela lá transmitiria toda edição de nome e horário de
 * time. O aviso vive horas; um minuto nas OUTRAS abas é aceitável, e na aba de
 * quem liga ou desliga a mutação invalida a consulta na hora. Sem telefonia na
 * instalação (`oferecida: false`), não relê nada.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { DuracaoDaEmergencia } from "@/lib/telefonia/vencimento-da-emergencia";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  type AvisoDoTimePublico,
  type FalaPublica,
  type FalhaNaResposta,
} from "@/lib/telefonia/vocabulario";

export const CHAVE_DOS_AVISOS = ["telefonia", "avisos"] as const;

export function useAvisosDeInstabilidade() {
  const { activeOrg } = useAuth();
  return useQuery({
    queryKey: CHAVE_DOS_AVISOS,
    enabled: activeOrg !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.oferecida ? 60_000 : false),
    queryFn: async () =>
      (await apiClient.get<{ data: { oferecida: boolean; times: AvisoDoTimePublico[] } }>("/api/v1/telefonia/emergencias")).data,
  });
}

export function useDesligarAviso() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: (teamId: string) => apiClient.delete(`/api/v1/telefonia/emergencias/${teamId}`),
    onSuccess: async () => {
      toast.success(t("Aviso de instabilidade desligado."));
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_AVISOS });
    },
    onError: (e) => showApiError(e),
  });
}

export function useLigarAviso() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: (p: { teamId: string; texto: string; duracao: DuracaoDaEmergencia }) =>
      apiClient.put(`/api/v1/telefonia/emergencias/${p.teamId}`, { texto: p.texto, duracao: p.duracao }),
    onSuccess: async () => {
      toast.success(t("Aviso de instabilidade ligado."));
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_AVISOS });
    },
    onError: (e) => showApiError(e),
  });
}

/** Gera a fala do aviso SEM ligar — o botão "Ouvir" da janela. */
export function useGerarFalaDoAviso() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (p: { teamId: string; texto: string }) =>
      (
        await apiClient.post<{ data: { fala: FalaPublica | null; falha: FalhaNaResposta | null } }>(
          `/api/v1/telefonia/emergencias/${p.teamId}/fala`,
          { texto: p.texto },
        )
      ).data,
    onSuccess: async (r) => {
      if (r?.falha) toast.error(t(MENSAGEM_DA_FALHA_DA_FALA[r.falha.motivo]));
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_AVISOS });
    },
    onError: (e) => showApiError(e),
  });
}
```

- [ ] **Step 4: A faixa**

Crie `components/telefonia/FaixaDoAvisoDeInstabilidade.tsx`:

```tsx
"use client";
/**
 * A faixa do aviso de instabilidade do telefone, em TODA tela do CRM (desenho da
 * fase 2, §6.4): todo membro vê que os clientes estão ouvindo um aviso — o
 * atendente que atende o telefone precisa saber o que o cliente acabou de ouvir.
 * Gerente e admin desligam por aqui mesmo. Aparece e some sem recarregar a página
 * (`useAvisosDeInstabilidade`).
 */
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { Siren } from "@/lib/ui/icons";

import { useAvisosDeInstabilidade, useDesligarAviso } from "./useAvisosDeInstabilidade";

export function FaixaDoAvisoDeInstabilidade() {
  const t = useT();
  const locale = useLocaleDeData();
  const { user, activeOrg } = useAuth();
  const { data } = useAvisosDeInstabilidade();
  const desligar = useDesligarAviso();

  const ativos = (data?.times ?? []).filter((a) => a.ativa);
  if (!data?.oferecida || ativos.length === 0) return null;
  const podeDesligar =
    (user.is_platform_admin && !user.support) || (activeOrg !== null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  return (
    <div
      role="status"
      aria-live="polite"
      data-faixa-aviso-de-instabilidade
      className="sticky top-0 z-40 flex flex-col gap-1 border-b border-amber-300 bg-amber-100/95 px-4 py-2 text-sm text-amber-950 backdrop-blur dark:border-amber-700/60 dark:bg-amber-950/70 dark:text-amber-50"
    >
      {ativos.map((a) => (
        <div key={a.team_id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Siren size={16} aria-hidden />
            <span>
              {t("Aviso de instabilidade ligado no telefone do")} {a.time_nome}
              {" · "}
              {a.expira_em ? `${t("desliga às")} ${format(new Date(a.expira_em), "HH:mm", { locale })}` : t("até alguém desligar")}
            </span>
          </span>
          {podeDesligar ? (
            <Button type="button" size="sm" variant="outline" onClick={() => desligar.mutate(a.team_id)} disabled={desligar.isPending}>
              {t("Desligar")}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: O cartão em Configurações › Times**

Crie `components/telefonia/AvisoDeInstabilidadeDoTime.tsx`:

```tsx
"use client";
/**
 * O cartão "Aviso de instabilidade (telefone)" de cada time, em Configurações ›
 * Times (desenho da fase 2, D7/D8 e §6.3).
 *
 * Desligado: o texto guardado e "Ligar aviso", que abre a janela com o texto
 * editável, "Ouvir", a duração (2 h por padrão) e "Ligar". Ligado: quando, por
 * quem e até quando, e "Desligar agora". Os botões são de gerente e admin — a
 * mesma régua da rota. Só aparece onde a instalação oferece telefonia.
 */
import { useState } from "react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";
import { DURACAO_PADRAO, type DuracaoDaEmergencia } from "@/lib/telefonia/vencimento-da-emergencia";
import { TAMANHO_MAXIMO_DA_FALA, type AvisoDoTimePublico } from "@/lib/telefonia/vocabulario";
import { Play, Siren } from "@/lib/ui/icons";

import { OuvirFala } from "./OuvirFala";
import { useAvisosDeInstabilidade, useDesligarAviso, useGerarFalaDoAviso, useLigarAviso } from "./useAvisosDeInstabilidade";

export function AvisoDeInstabilidadeDoTime({ teamId }: { teamId: string }) {
  const t = useT();
  const locale = useLocaleDeData();
  const { user, activeOrg } = useAuth();
  const { data } = useAvisosDeInstabilidade();
  const desligar = useDesligarAviso();
  const [aberto, setAberto] = useState(false);

  if (!data?.oferecida) return null;
  const aviso = data.times.find((a) => a.team_id === teamId);
  if (!aviso) return null;
  const podeMexer =
    (user.is_platform_admin && !user.support) || (activeOrg !== null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  const hora = (iso: string) => format(new Date(iso), "HH:mm", { locale });

  return (
    <Card className="space-y-2 p-4" data-aviso-de-instabilidade={teamId} data-ativo={aviso.ativa ? "sim" : "nao"}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Siren size={16} aria-hidden /> {t("Aviso de instabilidade (telefone)")}
      </h3>
      {aviso.ativa && aviso.desde ? (
        <>
          <p className="text-sm">
            {t("Ligado às")} {hora(aviso.desde)}
            {aviso.ligada_por ? ` ${t("por")} ${aviso.ligada_por}` : ""}
            {" · "}
            {aviso.expira_em ? `${t("desliga às")} ${hora(aviso.expira_em)}` : t("até alguém desligar")}
          </p>
          {podeMexer ? (
            <Button type="button" variant="outline" onClick={() => desligar.mutate(teamId)} disabled={desligar.isPending}>
              {t("Desligar agora")}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {aviso.fala?.texto ??
              t(
                "Nenhum aviso gravado ainda. Toda ligação de fora que entrar na fila deste time ouve o aviso inteiro antes de tocar nos atendentes.",
              )}
          </p>
          {podeMexer ? (
            <Button type="button" onClick={() => setAberto(true)}>
              {t("Ligar aviso")}
            </Button>
          ) : null}
        </>
      )}
      {aberto ? <JanelaDoAviso aviso={aviso} aoFechar={() => setAberto(false)} /> : null}
    </Card>
  );
}

function JanelaDoAviso({ aviso, aoFechar }: { aviso: AvisoDoTimePublico; aoFechar: () => void }) {
  const t = useT();
  const [texto, setTexto] = useState(aviso.fala?.texto ?? t(TEXTO_SUGERIDO.emergency));
  const [duracao, setDuracao] = useState<DuracaoDaEmergencia>(DURACAO_PADRAO);
  const [ouvir, setOuvir] = useState<string | null>(null);
  const gerar = useGerarFalaDoAviso();
  const ligar = useLigarAviso();

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) aoFechar();
      }}
    >
      <DialogContent data-janela-do-aviso>
        <DialogHeader>
          <DialogTitle>{t("Ligar o aviso de instabilidade")}</DialogTitle>
          <DialogDescription>
            {t(
              "Toda ligação de fora que entrar na fila do time ouve este aviso inteiro antes de tocar nos atendentes. A ligação transferida por um atendente não ouve.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="aviso-texto">{t("Texto do aviso")}</Label>
          <Textarea
            id="aviso-texto"
            rows={4}
            maxLength={TAMANHO_MAXIMO_DA_FALA}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!texto.trim() || gerar.isPending}
            onClick={() =>
              gerar.mutate(
                { teamId: aviso.team_id, texto },
                {
                  onSuccess: (r) => {
                    if (r?.fala?.status === "ready") setOuvir(r.fala.id);
                  },
                },
              )
            }
          >
            <Play size={16} aria-hidden /> {gerar.isPending ? t("Gerando…") : t("Ouvir")}
          </Button>
          {ouvir ? <OuvirFala falaId={ouvir} tocarAoCarregar /> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="aviso-duracao">{t("Desligar sozinho depois de")}</Label>
          <Select value={duracao} onValueChange={(v) => setDuracao(v as DuracaoDaEmergencia)}>
            <SelectTrigger id="aviso-duracao">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">{t("1 hora")}</SelectItem>
              <SelectItem value="2h">{t("2 horas (padrão)")}</SelectItem>
              <SelectItem value="4h">{t("4 horas")}</SelectItem>
              <SelectItem value="indefinida">{t("Até eu desligar")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={() => ligar.mutate({ teamId: aviso.team_id, texto, duracao }, { onSuccess: aoFechar })}
            disabled={!texto.trim() || ligar.isPending}
          >
            {ligar.isPending ? t("Ligando…") : t("Ligar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: As portas — o cartão em cada time, a faixa no layout**

Em `app/app/settings/teams/_client.tsx`, acrescente o import `import { AvisoDeInstabilidadeDoTime } from "@/components/telefonia/AvisoDeInstabilidadeDoTime";` e troque

```tsx
      {ativos.map((x) => (
        <EditorDeTime key={x.id} time={x} membros={membros} />
      ))}
```

por

```tsx
      {ativos.map((x) => (
        <div key={x.id} className="space-y-2">
          <EditorDeTime time={x} membros={membros} />
          {/* O aviso de instabilidade do telefone é do TIME (desenho da fase 2, D7). */}
          <AvisoDeInstabilidadeDoTime teamId={x.id} />
        </div>
      ))}
```

Em `app/app/layout.tsx`, acrescente o import `import { FaixaDoAvisoDeInstabilidade } from "@/components/telefonia/FaixaDoAvisoDeInstabilidade";` e troque

```tsx
        <ConexaoCaidaBanner caidas={conexoesCaidas} />
```

por

```tsx
        <ConexaoCaidaBanner caidas={conexoesCaidas} />
        {/* O aviso de instabilidade do telefone ligado: todo membro vê (desenho da fase 2, §6.4). */}
        <FaixaDoAvisoDeInstabilidade />
```

- [ ] **Step 7: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  // Telefonia, fase 2 — aviso de instabilidade (Times e faixa)
  "Aviso de instabilidade (telefone)": { es: "Aviso de inestabilidad (teléfono)" },
  "Ligado às": { es: "Activado a las" },
  "desliga às": { es: "se desactiva a las" },
  "até alguém desligar": { es: "hasta que alguien lo desactive" },
  "Desligar agora": { es: "Desactivar ahora" },
  "Nenhum aviso gravado ainda. Toda ligação de fora que entrar na fila deste time ouve o aviso inteiro antes de tocar nos atendentes.": {
    es: "Ningún aviso grabado todavía. Toda llamada externa que entre en la fila de este equipo escucha el aviso completo antes de sonar para los agentes.",
  },
  "Ligar aviso": { es: "Activar aviso" },
  "Ligar o aviso de instabilidade": { es: "Activar el aviso de inestabilidad" },
  "Toda ligação de fora que entrar na fila do time ouve este aviso inteiro antes de tocar nos atendentes. A ligação transferida por um atendente não ouve.": {
    es: "Toda llamada externa que entre en la fila del equipo escucha este aviso completo antes de sonar para los agentes. La llamada transferida por un agente no lo escucha.",
  },
  "Texto do aviso": { es: "Texto del aviso" },
  Ouvir: { es: "Escuchar" },
  "Desligar sozinho depois de": { es: "Desactivar solo después de" },
  "1 hora": { es: "1 hora" },
  "2 horas (padrão)": { es: "2 horas (predeterminado)" },
  "4 horas": { es: "4 horas" },
  "Até eu desligar": { es: "Hasta que yo lo desactive" },
  "Aviso de instabilidade ligado no telefone do": { es: "Aviso de inestabilidad activado en el teléfono de" },
  "Aviso de instabilidade desligado.": { es: "Aviso de inestabilidad desactivado." },
  "Aviso de instabilidade ligado.": { es: "Aviso de inestabilidad activado." },
```

- [ ] **Step 8: Rodar (a cerca do layout inclusive), gate de i18n e typecheck**

Run: `pnpm exec vitest run components/telefonia/ tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts app/app/settings/ && pnpm typecheck`
Expected: PASS (3 testes novos da faixa e as cercas existentes); `tsc` sem erro.

- [ ] **Step 9: Commit**

```bash
git add components/telefonia/useAvisosDeInstabilidade.ts components/telefonia/AvisoDeInstabilidadeDoTime.tsx \
  components/telefonia/FaixaDoAvisoDeInstabilidade.tsx components/telefonia/FaixaDoAvisoDeInstabilidade.test.tsx \
  app/app/settings/teams/_client.tsx app/app/layout.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): aviso de instabilidade no cartão do time e a faixa em todo o CRM

Gerente ou admin liga o aviso com texto, 'Ouvir' e duração; ligado, o cartão diz
quando, por quem e até quando. A faixa aparece para todo membro enquanto houver
aviso, com Desligar para gerente e admin, e some sem recarregar (polling de 60 s:
attendance_teams não está na publicação do Realtime).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 22: Tela — o cartão da ligação conta o que a URA fez

**Files:**
- Modify: `components/telefonia/CartaoDaLigacao.tsx` (interface 17–23; título e spans 40–74)
- Create: `components/telefonia/CartaoDaLigacao.test.tsx`
- Modify: `lib/i18n/dicionario.ts`

- [ ] **Step 1: Teste (falha: o cartão ignora o menu)**

Crie `components/telefonia/CartaoDaLigacao.test.tsx`:

```tsx
/**
 * O CARTÃO DA LIGAÇÃO NA CONVERSA (desenho da fase 2, §6.6): a escolha no menu (ou
 * "sem escolha → time padrão"), o "ouviu o aviso de instabilidade" e o motivo
 * "fora do horário" — o metadado que o worker grava em `messages.metadata.voice_call`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));

import { CartaoDaLigacao, ligacaoDaMensagem } from "./CartaoDaLigacao";

afterEach(() => cleanup());

const EM = "2026-09-28T13:00:00.000Z";

describe("cartão da ligação", () => {
  it("escolha no menu e aviso ouvido", () => {
    const ligacao = ligacaoDaMensagem({
      voice_call: {
        id: "vc-1",
        direcao: "inbound",
        desfecho: "atendida",
        duracao_ms: 65_000,
        atendente_nome: "Ana",
        menu: { desfecho: "chosen", tecla: "2", time_nome: "Financeiro" },
        ouviu_aviso: true,
      },
    })!;
    render(<CartaoDaLigacao ligacao={ligacao} em={EM} />);
    expect(screen.getByText(/escolheu 2 → Financeiro/)).toBeInTheDocument();
    expect(screen.getByText(/ouviu o aviso de instabilidade/)).toBeInTheDocument();
  });

  it("sem escolha → time padrão; tecla inválida → time padrão", () => {
    const sem = ligacaoDaMensagem({
      voice_call: { id: "vc-2", direcao: "inbound", desfecho: "perdida", duracao_ms: null, menu: { desfecho: "default_no_input", tecla: null, time_nome: "Suporte" } },
    })!;
    const { unmount } = render(<CartaoDaLigacao ligacao={sem} em={EM} />);
    expect(screen.getByText(/sem escolha → Suporte/)).toBeInTheDocument();
    unmount();

    const errada = ligacaoDaMensagem({
      voice_call: { id: "vc-3", direcao: "inbound", desfecho: "perdida", duracao_ms: null, menu: { desfecho: "default_invalid", tecla: null, time_nome: "Suporte" } },
    })!;
    render(<CartaoDaLigacao ligacao={errada} em={EM} />);
    expect(screen.getByText(/tecla inválida → Suporte/)).toBeInTheDocument();
  });

  it("fora do horário tem título próprio", () => {
    const fora = ligacaoDaMensagem({
      voice_call: { id: "vc-4", direcao: "inbound", desfecho: "perdida", duracao_ms: null, motivo: "after_hours" },
    })!;
    render(<CartaoDaLigacao ligacao={fora} em={EM} />);
    expect(screen.getByText("Ligação fora do horário")).toBeInTheDocument();
  });

  it("ligação da fase 1 (sem nada disso) continua igual", () => {
    const antiga = ligacaoDaMensagem({ voice_call: { id: "vc-5", direcao: "inbound", desfecho: "perdida", duracao_ms: null } })!;
    render(<CartaoDaLigacao ligacao={antiga} em={EM} />);
    expect(screen.getByText("Ligação perdida")).toBeInTheDocument();
    expect(screen.queryByText(/escolh/)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/telefonia/CartaoDaLigacao.test.tsx`
Expected: FAIL — `Unable to find an element with the text: /escolheu 2 → Financeiro/`.

- [ ] **Step 3: Implementar**

Em `components/telefonia/CartaoDaLigacao.tsx`:

(a) acrescente o import `import { MOTIVO_FORA_DO_HORARIO, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";`

(b) em `MetadadoDaLigacao`, logo depois de `  atendente_nome?: string | null;`, acrescente:

```ts
  /** Por que terminou (`voice_calls.end_reason`). Só `after_hours` muda o cartão. */
  motivo?: string | null;
  /** O que a URA fez, quando o número tocava um menu (fase 2). */
  menu?: { desfecho: DesfechoDoMenu; tecla: string | null; time_nome: string | null } | null;
  /** O cliente ouviu o aviso de instabilidade do time até o fim. */
  ouviu_aviso?: boolean;
```

(c) troque a declaração de `titulo` por:

```ts
  const foraDoHorario = recebida && !atendida && ligacao.motivo === MOTIVO_FORA_DO_HORARIO;
  const titulo = recebida
    ? atendida
      ? t("Ligação recebida")
      : foraDoHorario
        ? t("Ligação fora do horário")
        : t("Ligação perdida")
    : atendida
      ? t("Ligação feita")
      : ligacao.desfecho === "recusada_pela_rede"
        ? t("Ligação não completada")
        : t("Ligação sem resposta");
  const escolha = ligacao.menu
    ? ligacao.menu.desfecho === "chosen"
      ? `${t("escolheu")} ${ligacao.menu.tecla ?? ""}`
      : ligacao.menu.desfecho === "default_invalid"
        ? t("tecla inválida")
        : t("sem escolha")
    : null;
```

(d) troque a abertura da pílula `className={\`flex items-center gap-2 rounded-full ...` — a linha

```tsx
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
```

por

```tsx
        className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-full border px-3 py-1.5 text-xs ${
```

(e) logo depois da linha `        {tempo ? <span className="tabular-nums text-muted-foreground">· {tempo}</span> : null}`, acrescente:

```tsx
        {escolha ? (
          <span className="text-muted-foreground" data-ligacao-menu={ligacao.menu?.desfecho}>
            · {escolha}
            {ligacao.menu?.time_nome ? ` → ${ligacao.menu.time_nome}` : ""}
          </span>
        ) : null}
        {ligacao.ouviu_aviso ? (
          <span className="text-muted-foreground" data-ligacao-ouviu-aviso>
            · {t("ouviu o aviso de instabilidade")}
          </span>
        ) : null}
```

- [ ] **Step 4: Dicionário**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO`, acrescente:

```ts
  "Ligação fora do horário": { es: "Llamada fuera de horario" },
  escolheu: { es: "eligió" },
  "tecla inválida": { es: "tecla inválida" },
  "sem escolha": { es: "sin elección" },
  "ouviu o aviso de instabilidade": { es: "escuchó el aviso de inestabilidad" },
```

- [ ] **Step 5: Rodar, gate de i18n e typecheck**

Run: `pnpm exec vitest run components/telefonia/ components/inbox/ tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS (4 novos e os do inbox que desenham o cartão); `tsc` sem erro.

- [ ] **Step 6: Commit**

```bash
git add components/telefonia/CartaoDaLigacao.tsx components/telefonia/CartaoDaLigacao.test.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): o cartão da ligação conta a escolha no menu, o aviso ouvido e o fora do horário

'escolheu 2 → Financeiro', 'sem escolha → Suporte' ou 'tecla inválida → Suporte',
'ouviu o aviso de instabilidade' e o título 'Ligação fora do horário'. Ligação da
fase 1 continua igual.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 23: E2E — a URA e as falas pela tela, com a ElevenLabs falsa

**Files:**
- Create: `tests/e2e/telefonia-ura-e-falas.spec.ts`
- Modify: `scripts/gerar-env-e2e.sh:132` (logo depois de `CLASSIFICADOR_COMERCIAL_BASE_URL=http://127.0.0.1:3997`)
- Modify: `.github/workflows/e2e.yml:697` (fim de `SPECS_PARTE_3`)

- [ ] **Step 1: O ambiente da suíte**

Em `scripts/gerar-env-e2e.sh`, logo depois da linha `CLASSIFICADOR_COMERCIAL_BASE_URL=http://127.0.0.1:3997`, acrescente (dentro do mesmo heredoc; as crases vão escapadas, como as linhas vizinhas):

```
# A ElevenLabs FALSA de \`tests/e2e/telefonia-ura-e-falas.spec.ts\` (receptor HTTP
# que a própria spec sobe). Sem esta linha a suíte chamaria a ElevenLabs de verdade.
ELEVENLABS_API_BASE_URL=http://127.0.0.1:3996
# A telefonia "oferecida" na suíte: a PRESENÇA destas duas liga as abas do
# Telefone (lib/channels/telefonia/ari.ts). Nada escuta a porta: empurrar o tronco
# falha rápido e é engolido (empurrar.ts), e o ramal do navegador fica inativo sem
# aviso na tela. A ligação de verdade é provada na VPS, não aqui.
TELEFONIA_ARI_URL=http://127.0.0.1:3995
TELEFONIA_ARI_PASSWORD=e2e-placeholder-nao-e-segredo
```

Rode `pnpm e2e:env` (precisa do Supabase local de pé) e confira: `grep -E '^(ELEVENLABS_API_BASE_URL|TELEFONIA_ARI_URL)=' .env.e2e` → as duas linhas.

- [ ] **Step 2: A spec na lista do CI**

Em `.github/workflows/e2e.yml`, troque a linha `        devolver-ao-proprio-time.spec.ts` (a última de `SPECS_PARTE_3`) por:

```
        devolver-ao-proprio-time.spec.ts
        telefonia-ura-e-falas.spec.ts
```

- [ ] **Step 3: A spec**

Crie `tests/e2e/telefonia-ura-e-falas.spec.ts`:

```ts
/**
 * [P0] URA E FALAS DO TELEFONE PELA TELA — a versão 1 da fase 2 (DYD-10).
 *
 * Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md (§6 e §10).
 *
 * O que só a tela prova, e esta spec mede:
 *  1. a chave da ElevenLabs entra por Credenciais de IA, validada — a recusada
 *     volta ao lado do campo, e a chave NUNCA vai na URL;
 *  2. a voz sai de uma lista vinda da conta, e "Gerar e ouvir" produz um áudio que
 *     o NAVEGADOR toca (duração ~1 s, medida no <audio>, não a olho);
 *  3. o menu nasce das opções ("Para X, digite 1. Para Y, digite 2.") e fica pronto;
 *  4. o número passa a tocar o menu — e o banco guarda só o menu, nunca os dois;
 *  5. o aviso de instabilidade é ligado no time, a faixa aparece em outra tela
 *     para o ATENDENTE (sem o botão) e some sem recarregar quando o gerente desliga.
 *
 * ElevenLabs FALSA: um servidor HTTP que a própria spec sobe na porta de
 * ELEVENLABS_API_BASE_URL (.env.e2e). A telefonia é "oferecida" pela PRESENÇA de
 * TELEFONIA_ARI_URL/_PASSWORD no .env.e2e — nada escuta aquela porta, de
 * propósito: esta spec prova a TELA; a ligação de verdade é provada na VPS
 * (plano da fase 2, Task 29).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const CHAVE_VALIDA = "e2e-chave-elevenlabs-valida-0001";
const CHAVE_ERRADA = "e2e-chave-elevenlabs-errada-9999";
const VOZ = { voice_id: "voz-e2e-1", name: "Ana E2E", category: "premade", preview_url: null };
const SUFIXO = Date.now().toString().slice(-6);
const TIME_A = { id: randomUUID(), nome: `Suporte URA ${SUFIXO}` };
const TIME_B = { id: randomUUID(), nome: `Financeiro URA ${SUFIXO}` };
const NUMERO = { id: randomUUID(), nome: `Número URA ${SUFIXO}` };
const MENU_NOME = `Menu E2E ${SUFIXO}`;
const EVIDENCIA = ".superpowers/evidence/telefonia";

interface Pedido {
  metodo: string;
  url: string;
  chave: string | undefined;
  corpo: string;
}
const pedidos: Pedido[] = [];

function enderecoDaElevenLabsFalsa(): { host: string; porta: number } {
  const bruto = process.env.ELEVENLABS_API_BASE_URL ?? "";
  if (!bruto) throw new Error("ELEVENLABS_API_BASE_URL ausente do .env.e2e — rode `pnpm e2e:env` de novo.");
  const url = new URL(bruto);
  expect(["127.0.0.1", "localhost"], "a ElevenLabs falsa tem de ser local").toContain(url.hostname);
  return { host: url.hostname, porta: Number(url.port) };
}

function elevenLabsFalsa(): http.Server {
  return http.createServer((req, res) => {
    let corpo = "";
    req.setEncoding("utf8");
    req.on("data", (pedaco: string) => (corpo += pedaco));
    req.on("end", () => {
      const chave = req.headers["xi-api-key"] as string | undefined;
      pedidos.push({ metodo: req.method ?? "", url: req.url ?? "", chave, corpo });
      if (chave !== CHAVE_VALIDA) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: { status: "invalid_api_key" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: [VOZ] }));
        return;
      }
      if (req.method === "POST" && req.url === `/v1/text-to-speech/${VOZ.voice_id}?output_format=ulaw_8000`) {
        // 1 s de silêncio em μ-law (0xFF é o zero): o navegador converte em WAV e toca.
        res.writeHead(200, { "Content-Type": "audio/basic" }).end(Buffer.alloc(8000, 0xff));
        return;
      }
      res.writeHead(404).end();
    });
  });
}

/**
 * Outra janela, logada como o ATENDENTE do seed (papel `agent`, sem MFA). O
 * contexto criado pelo fixture `browser` herda o `baseURL` do projeto, como em
 * `aviso-de-mensagem-diz-de-quem-e.spec.ts`.
 */
async function abrirComoAtendente(browser: Browser): Promise<Page> {
  const creds = lerCreds();
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await contexto.newPage();
  await p.goto("/login");
  await p.locator("#email").fill(creds.users.agent!.email);
  await p.locator("#password").fill(creds.password);
  await p.getByRole("button", { name: /entrar/i }).click();
  await p.waitForURL(/\/app\//);
  return p;
}

const credenciais = credenciaisSupabaseDeTeste();
let pool: pg.Pool;
let servidor: http.Server;
let orgId: string;

async function contagem(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

test.describe("telefonia — URA e falas pela tela", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    lerCreds();
    orgId = (JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { org_id: string }).org_id;
    pool = new pg.Pool({ connectionString: credenciais.dbUrl, max: 3 });
    // O que uma rodada anterior interrompida possa ter deixado nesta organização.
    await pool.query("delete from ai_provider_credentials where organization_id = $1 and provider = 'elevenlabs'", [orgId]);
    await pool.query("delete from phone_settings where organization_id = $1", [orgId]);
    await pool.query(
      `insert into attendance_teams (id, organization_id, name, slug) values ($1, $3, $4, $5), ($2, $3, $6, $7)`,
      [TIME_A.id, TIME_B.id, orgId, TIME_A.nome, `suporte-ura-${SUFIXO}`, TIME_B.nome, `financeiro-ura-${SUFIXO}`],
    );
    await pool.query(
      `insert into channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, 'sip_trunk', decode('00', 'hex'), 'WORKING', $3, $4,
               'voip.e2e-ura.com.br', 5060, 'udp', $5, decode('00', 'hex'), $6)`,
      [NUMERO.id, orgId, NUMERO.nome, `+55613000${SUFIXO.slice(-4)}`, `ura${SUFIXO}`, TIME_A.id],
    );
    const { host, porta } = enderecoDaElevenLabsFalsa();
    servidor = elevenLabsFalsa();
    await new Promise<void>((ok) => servidor.listen(porta, host, () => ok()));
  });

  test.afterAll(async () => {
    if (servidor) await new Promise<void>((ok) => servidor.close(() => ok()));
    if (!pool) return;
    await pool.query("delete from channel_sessions where id = $1", [NUMERO.id]);
    await pool.query(
      `update attendance_teams set phone_emergency_active_since = null, phone_emergency_expires_at = null,
              phone_emergency_activated_by = null, phone_emergency_prompt_id = null
        where id = any($1::uuid[])`,
      [[TIME_A.id, TIME_B.id]],
    );
    await pool.query("delete from phone_menus where organization_id = $1 and name = $2", [orgId, MENU_NOME]);
    await pool.query("delete from phone_settings where organization_id = $1", [orgId]);
    await pool.query("delete from phone_prompts where organization_id = $1", [orgId]);
    await pool.query("delete from attendance_teams where id = any($1::uuid[])", [[TIME_A.id, TIME_B.id]]);
    await pool.query("delete from ai_provider_credentials where organization_id = $1 and provider = 'elevenlabs'", [orgId]);
    await pool.end();
  });

  test("o admin monta a URA pela tela e liga o aviso; o atendente vê a faixa", async ({ page, browser }) => {
    await loginComoAdmin(page, lerCreds());

    await test.step("a chave da ElevenLabs: a errada é recusada ao lado do campo, a certa é guardada", async () => {
      await page.goto("/app/ai/credentials");
      const cartao = page.locator("[data-cartao-elevenlabs]");
      await expect(cartao).toBeVisible({ timeout: 20_000 });
      await cartao.getByLabel("Chave da ElevenLabs").fill(CHAVE_ERRADA);
      await cartao.getByRole("button", { name: "Salvar chave" }).click();
      await expect(cartao.getByRole("alert")).toContainText("recusou a chave");
      await cartao.getByLabel("Chave da ElevenLabs").fill(CHAVE_VALIDA);
      await cartao.getByRole("button", { name: "Salvar chave" }).click();
      await expect(cartao.locator("[data-chave-de-voz-last4]")).toHaveText("…0001");
      expect(pedidos.length).toBeGreaterThan(0);
      for (const p of pedidos) expect(p.url, "a chave nunca vai na URL").not.toContain("e2e-chave");
    });

    await test.step("a voz e a fala de aguarde: gerar e ouvir no navegador", async () => {
      await page.goto("/app/connections?aba=telefone&sub=falas");
      await page.locator("#tel-voz").click();
      await page.getByRole("option", { name: VOZ.name }).click();
      await expect(page.getByText("Voz salva.", { exact: false })).toBeVisible();

      const cartao = page.locator('[data-fala-geral="waiting"]');
      await cartao.getByRole("button", { name: /Gerar e ouvir/ }).click();
      await expect(cartao.locator('[data-estado-da-fala="pronta"]')).toBeVisible({ timeout: 20_000 });
      const audio = cartao.locator("audio[data-fala-audio]");
      await expect(audio).toBeVisible();
      const duracao = await audio.evaluate(
        (el) =>
          new Promise<number>((ok) => {
            const a = el as HTMLAudioElement;
            if (a.readyState >= 1) ok(a.duration);
            else a.addEventListener("loadedmetadata", () => ok(a.duration), { once: true });
          }),
      );
      expect(duracao).toBeGreaterThan(0.9);
      expect(duracao).toBeLessThan(1.1);
      const sintese = pedidos.find((p) => p.metodo === "POST");
      expect(JSON.parse(sintese!.corpo)).toMatchObject({ model_id: "eleven_multilingual_v2" });
      await page.screenshot({ path: `${EVIDENCIA}/e2e-voz-e-falas.png`, fullPage: true });
    });

    await test.step("o menu nasce das opções e fica pronto", async () => {
      await page.getByRole("tab", { name: "Menus" }).click();
      await page.getByRole("button", { name: "Novo menu" }).click();
      const editor = page.locator("[data-editor-de-menu]");
      await editor.locator("#menu-nome").fill(MENU_NOME);
      await editor.getByLabel("Time da opção").first().click();
      await page.getByRole("option", { name: TIME_A.nome }).click();
      await editor.getByRole("button", { name: /Adicionar opção/ }).click();
      await editor.getByLabel("Time da opção").nth(1).click();
      await page.getByRole("option", { name: TIME_B.nome }).click();
      await editor.locator("#menu-padrao").click();
      await page.getByRole("option", { name: TIME_A.nome }).click();
      await expect(editor.locator("#menu-texto")).toHaveValue(
        `Para ${TIME_A.nome}, digite 1. Para ${TIME_B.nome}, digite 2.`,
      );
      await editor.getByRole("button", { name: "Salvar e gerar a fala" }).click();
      const cartao = page.locator("[data-menu]").filter({ hasText: MENU_NOME });
      await expect(cartao.locator('[data-estado-da-fala="pronta"]')).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${EVIDENCIA}/e2e-menu-pronto.png`, fullPage: true });
    });

    await test.step("o número passa a tocar o menu — e o banco guarda só o menu", async () => {
      await page.getByRole("tab", { name: "Números" }).click();
      const numero = page.locator("[data-telefonia-numero]").filter({ hasText: NUMERO.nome });
      await numero.getByRole("button", { name: "Editar" }).click();
      await page.locator("#tel-destino").click();
      await page.getByRole("option", { name: "Tocar o menu" }).click();
      await page.locator("#tel-menu").click();
      await page.getByRole("option", { name: MENU_NOME }).click();
      await page.getByRole("button", { name: "Salvar e conectar" }).click();
      await expect(numero).toContainText(`Quando ligarem: menu ${MENU_NOME}`);

      await page.reload();
      await expect(page.locator("[data-telefonia-numero]").filter({ hasText: NUMERO.nome })).toContainText(
        `Quando ligarem: menu ${MENU_NOME}`,
      );
      const { rows } = await pool.query("select sip_team_id, sip_menu_id is not null as tem_menu from channel_sessions where id = $1", [
        NUMERO.id,
      ]);
      expect(rows[0]).toEqual({ sip_team_id: null, tem_menu: true });
    });

    await test.step("o aviso de instabilidade é ligado no time, e a faixa aparece no topo", async () => {
      await page.goto("/app/settings/teams");
      const cartao = page.locator(`[data-aviso-de-instabilidade="${TIME_A.id}"]`);
      await expect(cartao).toHaveAttribute("data-ativo", "nao", { timeout: 20_000 });
      await cartao.getByRole("button", { name: "Ligar aviso" }).click();
      const janela = page.locator("[data-janela-do-aviso]");
      await janela.getByRole("button", { name: /Ouvir/ }).click();
      await expect(janela.locator("audio[data-fala-audio]")).toBeVisible({ timeout: 20_000 });
      await janela.locator("#aviso-duracao").click();
      await page.getByRole("option", { name: "1 hora" }).click();
      await janela.getByRole("button", { name: "Ligar", exact: true }).click();

      await expect(cartao).toHaveAttribute("data-ativo", "sim");
      await expect(cartao).toContainText("Ligado às");
      const faixa = page.locator("[data-faixa-aviso-de-instabilidade]");
      await expect(faixa).toContainText(`Aviso de instabilidade ligado no telefone do ${TIME_A.nome}`);
      // No topo da página — medido, não a olho (acima dela, no máximo a faixa de conexão caída).
      const caixa = await faixa.boundingBox();
      expect(caixa).not.toBeNull();
      expect(caixa!.y).toBeLessThan(200);
      await expect
        .poll(() => contagem("select count(*)::int as n from api_audit_log where action = 'phone.emergency_activated' and resource_id = $1", [TIME_A.id]))
        .toBe(1);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-aviso-ligado.png`, fullPage: true });
    });

    await test.step("o atendente vê a faixa em outra tela, sem o botão de desligar", async () => {
      const agente = await abrirComoAtendente(browser);
      await agente.goto("/app/inbox");
      const faixa = agente.locator("[data-faixa-aviso-de-instabilidade]");
      await expect(faixa).toContainText(TIME_A.nome, { timeout: 20_000 });
      await expect(faixa.getByRole("button", { name: "Desligar" })).toHaveCount(0);
      await agente.screenshot({ path: `${EVIDENCIA}/e2e-faixa-do-atendente.png` });
      await agente.context().close();
    });

    await test.step("desligar pela faixa: ela some sem recarregar, e o cartão volta a 'desligado'", async () => {
      const faixa = page.locator("[data-faixa-aviso-de-instabilidade]");
      await faixa.getByRole("button", { name: "Desligar" }).click();
      await expect(faixa).toHaveCount(0);
      await expect(page.locator(`[data-aviso-de-instabilidade="${TIME_A.id}"]`)).toHaveAttribute("data-ativo", "nao");
      await expect
        .poll(() => contagem("select count(*)::int as n from api_audit_log where action = 'phone.emergency_deactivated' and resource_id = $1", [TIME_A.id]))
        .toBe(1);
    });
  });
});
```

- [ ] **Step 4: O gate de cobertura da e2e (unidade)**

Run: `pnpm exec vitest run tests/unit/e2e-cobertura-completa.test.ts tests/unit/e2e-workflow-honra-o-env.test.ts`
Expected: PASS — a spec nova está em `SPECS_PARTE_3`.

- [ ] **Step 5: Rodar a spec contra o ambiente local (Supabase local + build de produção)**

Run: `pnpm e2e:env && pnpm e2e:build && pnpm exec playwright test tests/e2e/telefonia-ura-e-falas.spec.ts`
Expected: `1 passed`. As três capturas ficam em `.superpowers/evidence/telefonia/e2e-*.png`.

Se a spec falhar por seletor (não por comportamento), conserte a SPEC; se falhar por comportamento, volte à task da tela correspondente (17–22) e conserte lá, com teste de unidade que reproduza.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/telefonia-ura-e-falas.spec.ts scripts/gerar-env-e2e.sh .github/workflows/e2e.yml
git commit -m "test(telefonia): e2e da URA e das falas pela tela, com a ElevenLabs falsa

Chave validada (a recusada ao lado do campo, nunca na URL), voz, fala ouvida no
navegador com duração medida, menu montado das opções, número tocando o menu (só
o menu no banco), aviso ligado com a faixa para o atendente e desligado sem
recarregar.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 24: Documentos de autoridade, mapa vivo e fragmento de release (DoD 13, 16 e 17)

**Files:**
- Modify: `tests/unit/mapas-de-arquitetura.test.ts:176-182` (caso novo no fim do `describe("mapas de arquitetura — coerência interna")`)
- Modify: `docs/architecture/telefonia.architecture.json` (fim de `nodes`, fim de `edges`, fim de `cards`)
- Modify: `docs/specs/20-spec-telefonia-sip.md:312-313` (tabela do §8)
- Modify: `docs/current-state.md:143` (linha da Telefonia SIP)
- Modify: `docs/testing/user-journey-map.md` (J36 no fim do arquivo)
- Create: `.changes/telefonia-ura-e-falas.md`

- [ ] **Step 1: O caso do mapa (falha: as peças novas não existem)**

Em `tests/unit/mapas-de-arquitetura.test.ts`, troque o fim do caso do índice de atrito:

```ts
    for (const peca of ["demandas", "fnatrito", "libradar", "toolradar", "inbox", "rotalead", "crmleads"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
  });
});
```

por:

```ts
    for (const peca of ["demandas", "fnatrito", "libradar", "toolradar", "inbox", "rotalead", "crmleads"]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
  });

  it("a URA e as falas do telefone estão no mapa da telefonia, e nenhuma peça nova é ilha", () => {
    // O caso concreto do DoD 13 para a fase 2, versão 1 (migration 0288). As
    // cadeias são as do §8 do desenho: a fala vai da ElevenLabs ao Storage, ao
    // volume e ao Asterisk; o menu sai do número, passa pela URA e chega à fila
    // do time; o aviso vencido vira item da Central.
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "telefonia.architecture.json"), "utf8"),
    ) as Mapa;
    const grau = (id: string) =>
      (m.edges ?? []).filter((e) => e.from === id || e.to === id).length;
    for (const peca of [
      "elevenlabs",
      "volume_falas",
      "falas_no_disco",
      "ura",
      "rota_chave",
      "rota_voz",
      "rota_emergencias",
      "aba_voz",
      "cartao_elevenlabs",
      "faixa_aviso",
      "t_credenciais",
      "bucket_falas",
      "t_prompts",
      "t_menus",
      "t_times",
    ]) {
      expect(grau(peca), `${peca} com menos de 2 arestas — é ilha pelo invariante 1`).toBeGreaterThanOrEqual(2);
    }
    const arestas = (m.edges ?? []).map((e) => `${e.from}→${e.to}`);
    // A fala chega ao Asterisk pelo volume, só de leitura — nunca pela rede.
    expect(arestas).toEqual(
      expect.arrayContaining([
        "rota_voz→elevenlabs",
        "rota_voz→bucket_falas",
        "bucket_falas→falas_no_disco",
        "falas_no_disco→volume_falas",
        "volume_falas→asterisk_core",
        "t_sessions→t_menus",
        "ura→distribuicao",
        "repositorio→t_inbox",
      ]),
    );
  });
});
```

Run: `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts`
Expected: FAIL — `elevenlabs com menos de 2 arestas — é ilha pelo invariante 1` (grau 0).

- [ ] **Step 2: As peças e as arestas no mapa**

O arquivo é formatado à mão (um objeto por linha nas arestas); o script abaixo insere texto nos três pontos e não reformata o resto. Rode da raiz do worktree:

```bash
python3 - <<'PY'
import json

CAMINHO = "docs/architecture/telefonia.architecture.json"
s = open(CAMINHO, encoding="utf-8").read()

NOS = [
    ("elevenlabs", "fora", 2, "external", "ElevenLabs — a conta da PRÓPRIA organização: lista as vozes e gera cada fala em μ-law 8 kHz (`ulaw_8000`). A chave vai só no header `xi-api-key`"),
    ("volume_falas", "infra", 5, "backend", "Volume `telefonia-falas` (`docker-compose.prod.yml`): escrita no `worker`, SÓ LEITURA no `asterisk`, montado nos dois em `/var/lib/deskcomm/falas`"),
    ("falas_no_disco", "worker", 6, "backend", "`lib/channels/telefonia/falas-no-disco.ts` — passada de 60 s (baixa do Storage as falas prontas, apaga órfãs) e `garantir` antes de tocar; escrita atômica, caminho conferido pela régua `<org>/<hash>.ulaw`"),
    ("ura", "worker", 7, "backend", "`lib/telefonia/ura.ts` — a URA como regra pura: estado + evento (fim da fala, tecla, prazo de 5 s, desligou) → ação. Duas repetições e o time padrão"),
    ("rota_chave", "api", 12, "backend", "`/api/v1/telefonia/voz/chave` — GET estado (gerente+) / PUT chave (admin): valida listando as vozes, cifra, devolve só os 4 últimos dígitos"),
    ("rota_voz", "api", 13, "backend", "`/api/v1/telefonia/{voz, voz/vozes, falas/gerais/[tipo], falas/[id]/audio, menus}` — voz, falas gerais, áudio da fala e menus; organização da SESSÃO; falha da ElevenLabs volta 422/502, nunca 429/503"),
    ("rota_emergencias", "api", 14, "backend", "`/api/v1/telefonia/emergencias` — GET (membro) e, por time, PUT liga com prazo / DELETE desliga / POST fala para ouvir (gerente+)"),
    ("aba_voz", "tela", 9, "frontend", "Conexões › Telefone › **Menus** e **Voz e falas** (`?aba=telefone&sub=menus|falas`): voz, as três falas gerais, editor de menu com a fala montada das opções e \"últimos 7 dias\""),
    ("cartao_elevenlabs", "tela", 10, "frontend", "Credenciais de IA › cartão **ElevenLabs (voz do telefone)**: a chave entra, é validada e nunca volta"),
    ("faixa_aviso", "tela", 11, "frontend", "Cartão do aviso de instabilidade em Configurações › Times + faixa no topo de todo o CRM (relê a cada 60 s; Desligar só para gerente e admin)"),
    ("t_credenciais", "banco", 11, "database", "`ai_provider_credentials` com `provider = 'elevenlabs'` — a chave cifrada (`AI_CRED_AES_KEY`) e o `last4`"),
    ("bucket_falas", "banco", 12, "database", "Storage `phone-prompts` (PRIVADO): `<org>/<hash>.ulaw`; só a service role lê e escreve"),
    ("t_prompts", "banco", 13, "database", "`phone_prompts` + `phone_settings` — a fala (texto, voz, hash, caminho, duração, `ready`/`failed`) e a voz e as falas gerais da organização"),
    ("t_menus", "banco", 14, "database", "`phone_menus` + `phone_menu_options` — tecla 0–9 → time, time padrão; `channel_sessions.sip_menu_id` (CHECK: time OU menu); `voice_calls.menu_*` guarda o que o cliente fez"),
    ("t_times", "banco", 15, "database", "`attendance_teams.phone_emergency_*` — o aviso de instabilidade do time: fala, desde, até (nulo = até desligar), quem ligou"),
]

ARESTAS = [
    ("cartao_elevenlabs", "rota_chave", "PUT da chave (só no corpo, nunca na URL)"),
    ("rota_chave", "elevenlabs", "valida listando as vozes da conta"),
    ("rota_chave", "t_credenciais", "guarda cifrada; `ai.credential_created`"),
    ("rota_chave", "t_audit", "`ai.credential_created` com `provider = elevenlabs` — sem a chave"),
    ("aba", "aba_voz", "sub-abas do Telefone (`?sub=`)"),
    ("aba_voz", "cartao_elevenlabs", "sem chave: o link para Credenciais de IA"),
    ("aba_voz", "rota_voz", "voz, falas gerais, menus; \"Ouvir\" busca o μ-law e toca em WAV"),
    ("rota_voz", "t_credenciais", "`chaveDeVoz` decifrada só para sintetizar"),
    ("rota_voz", "elevenlabs", "texto + voz → áudio `ulaw_8000`"),
    ("rota_voz", "bucket_falas", "grava `<org>/<hash>.ulaw` (mesmo texto e voz reaproveitam)"),
    ("rota_voz", "t_prompts", "linha da fala: `ready` ou `failed` com motivo"),
    ("rota_voz", "t_menus", "menu e opções numa transação"),
    ("rota_voz", "t_audit", "`phone.voice_changed`, `phone.prompt_saved`, `phone.menu_saved`, `phone.menu_archived`"),
    ("rota_numeros", "t_menus", "`sip_menu_id` só aponta para menu com a fala pronta; `phone.number_destination_changed`"),
    ("faixa_aviso", "rota_emergencias", "GET a cada 60 s e na volta do foco; PUT/DELETE"),
    ("faixa_aviso", "rota_voz", "\"Ouvir\" o aviso antes de ligar"),
    ("rota_emergencias", "t_times", "liga com prazo (1 h, 2 h, 4 h ou até desligar) / desliga"),
    ("rota_emergencias", "t_audit", "`phone.emergency_activated` / `phone.emergency_deactivated`"),
    ("bucket_falas", "falas_no_disco", "baixa as falas prontas pela service role"),
    ("laco", "falas_no_disco", "passada de 60 s: falas e avisos vencidos"),
    ("controle", "falas_no_disco", "`garantir` a fala antes de tocar"),
    ("falas_no_disco", "volume_falas", "escreve `.ulaw` (tmp + rename)"),
    ("volume_falas", "asterisk_core", "`sound:/var/lib/deskcomm/falas/<org>/<hash>` — só leitura"),
    ("controle", "ura", "cada tecla, fim de fala e prazo vira um passo"),
    ("ura", "distribuicao", "a tecla (ou o time padrão) escolhe a fila do time"),
    ("t_sessions", "t_menus", "`sip_menu_id`: o número toca o menu"),
    ("repositorio", "t_menus", "menu do número e `registrarMenu` na ligação"),
    ("repositorio", "t_prompts", "falas gerais e a fala do menu e do aviso"),
    ("repositorio", "t_times", "aviso vigente na hora da ligação; desliga os vencidos"),
    ("t_times", "controle", "aviso vigente: tocado INTEIRO na entrada da fila (tecla não interrompe)"),
    ("repositorio", "t_inbox", "`phone_prompt_unplayable` (fala não tocou) e `phone_emergency_expired` (aviso venceu)"),
]

CARTAO = {
    "dot": "amber",
    "title": "Fase 2, versão 1 — URA e falas: o laço de retorno (invariante 7)",
    "items": [
        "Menu que confunde: o bloco \"últimos 7 dias\" do cartão do menu conta escolhas por tecla, sem escolha, tecla errada e quem desligou no menu, e avisa quando muita gente cai no time padrão sem escolher — o dono reescreve a fala",
        "Fala que não toca (arquivo ausente ou ElevenLabs fora): a ligação segue sem ela, e a Central recebe `phone_prompt_unplayable` com o link para a aba Voz e falas",
        "Aviso de instabilidade esquecido: vence sozinho no prazo escolhido; o worker desliga na passada de 60 s, audita `phone.emergency_expired` e avisa na Central (`phone_emergency_expired`). Na hora da ligação o worker lê `expires_at` e não depende da passada",
        "Fora do horário SEM fala gerada segue a fase 1 (fila de 2 min → perdida com \"Ligar de volta\"): desligar em silêncio seria beco sem saída para quem ainda não cadastrou a chave",
    ],
}


def linha_do_no(no):
    i, lane, col, tipo, rotulo = no
    corpo = json.dumps(
        {"id": i, "lane": lane, "col": col, "type": tipo, "label": rotulo}, ensure_ascii=False, indent=2
    )
    return "\n".join("    " + l for l in corpo.splitlines())


def linha_da_aresta(a):
    return "    " + json.dumps({"from": a[0], "to": a[1], "label": a[2]}, ensure_ascii=False).replace('{"', '{ "').replace('"}', '" }').replace('", "', '", "')


fim_dos_nos = "\n    }\n  ],\n  \"edges\": ["
assert s.count(fim_dos_nos) == 1, "âncora do fim de nodes mudou"
s = s.replace(fim_dos_nos, "\n    },\n" + ",\n".join(linha_do_no(n) for n in NOS) + "\n  ],\n  \"edges\": [")

ultima_aresta = '    { "from": "t_sessions", "to": "controle", "label": "`sip_dial_prefix` do tronco usado, lido junto com ele" }\n  ],\n  "cards": ['
assert s.count(ultima_aresta) == 1, "âncora da última aresta mudou"
s = s.replace(
    ultima_aresta,
    ultima_aresta.split("\n")[0] + ",\n" + ",\n".join(linha_da_aresta(a) for a in ARESTAS) + "\n  ],\n  \"cards\": [",
)

fim_dos_cartoes = "\n    }\n  ]\n}\n"
assert s.endswith(fim_dos_cartoes), "âncora do fim de cards mudou"
cartao = "\n".join("    " + l for l in json.dumps(CARTAO, ensure_ascii=False, indent=2).splitlines())
s = s[: -len(fim_dos_cartoes)] + "\n    },\n" + cartao + "\n  ]\n}\n"

json.loads(s)  # reprova aqui se o texto inserido quebrou o JSON
open(CAMINHO, "w", encoding="utf-8").write(s)
print("ok:", len(NOS), "peças,", len(ARESTAS), "arestas, 1 cartão")
PY
```

Expected: `ok: 15 peças, 31 arestas, 1 cartão`.

- [ ] **Step 3: Rodar o gate dos mapas**

Run: `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts`
Expected: PASS — inclusive "toda aresta liga ids que existem" e "nenhuma peça é ilha" para `telefonia.architecture.json`.

- [ ] **Step 4: Spec 20 §8 — a tabela de fases**

Em `docs/specs/20-spec-telefonia-sip.md`, troque as duas linhas

```markdown
| **F1 + distribuição** (release A) | §4–§7 | em implementação |
| F2 | URA configurável, horário do time e mensagem de fora do horário com WhatsApp, anúncio de "ninguém disponível", transferência | a fazer |
```

por:

```markdown
| **F1 + distribuição** (release A) | §4–§7 | publicada na 1.49.0 — para conferir: `grep -n '^## \[1.49.0\]' CHANGELOG.md` |
| F2 v1 | URA e falas: menu por tecla com time padrão, aguarde, "ninguém disponível", fora do horário pela agenda do time, aviso de instabilidade por time. Desenho: `docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano: `docs/superpowers/plans/2026-09-28-telefonia-fase2-v1-ura.md`; migration 0288 | implementada; prova na VPS pendente (J36 do mapa de jornadas) |
| F2 v2 | Transferência (mesmo desenho, §5.3) | a fazer |
| F2 v3 | Ramais (mesmo desenho, §5.4) | a fazer |
```

- [ ] **Step 5: `docs/current-state.md` — a linha da telefonia**

Na linha que começa com `| **Telefonia SIP — DYD-10**`, faça duas trocas.

Troque

```markdown
F1 + distribuição **implementada e NÃO publicada**: em 2026-09-28 não está na `main`, em release nem em produção (a última release é a 1.47.0, sem telefonia).
```

por

```markdown
F1 + distribuição **publicada na release 1.49.0** (para conferir: `grep -n '^## \[1.49.0\]' CHANGELOG.md`).
```

E troque

```markdown
**Fases seguintes, a fazer:** F2 — URA configurável, horário do time com mensagem de fora do horário apontando o WhatsApp, anúncio de "ninguém disponível", transferência;
```

por

```markdown
**F2 v1 — URA e falas: implementada, prova na VPS pendente** (J36; migration 0288; desenho `docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`): menu por tecla com time padrão, fala de aguarde a cada ~40 s, "ninguém disponível", fora do horário pela agenda do time, aviso de instabilidade por time com prazo e faixa em todo o CRM; as falas são geradas pela ElevenLabs com a chave da própria organização, cadastrada em Credenciais de IA. Sem a chave, nada muda: a ligação segue como na F1. **Fases seguintes, a fazer:** F2 v2 — transferência; F2 v3 — ramais;
```

Confira que as duas trocas pegaram: `grep -c "publicada na release 1.49.0" docs/current-state.md` → `1`; `grep -c "F2 v1 — URA e falas: implementada" docs/current-state.md` → `1`.

- [ ] **Step 6: Mapa de jornadas — J36**

Acrescente ao FIM de `docs/testing/user-journey-map.md` (depois do parágrafo "**Não medido:** CPU por ligação na VPS; …" da J35), com uma linha em branco antes:

```markdown

## J36 — URA e falas do telefone: o cliente escolhe o time pela tecla `[P0]` (2026-09-28)

Pedido do dono (DYD-10, fase 2, versão 1): quem liga para a empresa ouve um menu gravado com a
voz escolhida e vai para o time certo; quem espera ouve "aguarde"; fora do horário e em
instabilidade, ouve o aviso certo. Desenho em
`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano em
`docs/superpowers/plans/2026-09-28-telefonia-fase2-v1-ura.md`; mapa em
`docs/architecture/telefonia.architecture.json`; migration 0288.

`[P0]` porque a URA é a PRIMEIRA coisa que o cliente final ouve da empresa — antes de qualquer
atendente.

**Como é provado.** As telas, por `tests/e2e/telefonia-ura-e-falas.spec.ts`, com um receptor
HTTP que faz o papel da ElevenLabs (a URL base só muda em teste: `ELEVENLABS_API_BASE_URL` no
`.env.e2e`). A ligação de verdade — tecla, fala tocada, fila — só se prova na VPS, com a
operadora real e o dono ligando do celular para o (61) 3686-1503 (Task 29 do plano). A máquina
da URA e as falas na fila estão em unidade (`lib/telefonia/ura.test.ts`,
`lib/channels/telefonia/controle.test.ts`), e o SQL do worker contra Postgres real
(`tests/invariants/telefonia-repositorio-da-ura.test.ts`).

| Caso | Prioridade | Resultado |
|---|---|---|
| J36.1 O admin cola a chave da ElevenLabs em Credenciais de IA: a errada é recusada ao lado do campo; a certa é guardada e a tela mostra só os 4 últimos dígitos | `[P0]` | **PASS** (e2e, ElevenLabs falsa); a chave nunca foi para a URL |
| J36.2 Voz escolhida numa lista vinda da conta; "Gerar e ouvir" da fala de aguarde toca no navegador | `[P0]` | **PASS** (e2e; duração medida no `<audio>`, ~1 s) |
| J36.3 Menu novo: a fala é montada das opções ("Para X, digite 1. Para Y, digite 2.") e fica pronta | `[P0]` | **PASS** (e2e) |
| J36.4 O número passa a "tocar o menu"; o banco guarda só o menu (`sip_team_id` nulo) | `[P0]` | **PASS** (e2e) |
| J36.5 Aviso de instabilidade ligado por 1 hora no time: a faixa aparece no topo para o atendente, sem o botão; o gerente desliga pela faixa e ela some sem recarregar | `[P0]` | **PASS** (e2e; auditoria `phone.emergency_activated` e `phone.emergency_deactivated` conferida no banco) |
| J36.6 Ligação real, opção 1: o cliente ouve o menu, digita 1 e toca no time da opção 1; o cartão diz a escolha | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.7 Ligação real, opção 2 | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.8 Tecla errada: ouve a fala de tecla inválida (se houver) e o menu repete; depois de 2 repetições, time padrão com "sem escolha" | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.9 Sem tecla: o menu repete 2 vezes e a ligação vai ao time padrão (`default_no_input`) | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.10 Desligar no menu: vira perdida com "Ligar de volta" no time padrão | `[P1]` | pendente — prova na VPS (Task 29) |
| J36.11 Aviso de instabilidade ligado: o cliente ouve o aviso inteiro (tecla não interrompe) e segue para a fila; desligado, não ouve | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.12 Fora do horário do time, com a fala pronta: ouve a fala e a ligação cai; o cartão diz "fora do horário" e a Central não recebe aviso | `[P0]` | pendente — prova na VPS (Task 29) |
| J36.13 Ninguém atende: "aguarde" a cada ~40 s entre a música; em 2 min, "ninguém disponível" e a perdida vai para a Central | `[P1]` | pendente — prova na VPS (Task 29) |

**Não medido:** a qualidade da voz no celular do cliente (G.711 da operadora); tecla enviada
por RFC 2833 × SIP INFO em outras operadoras (medido só na da Totus, Task 0B); o cliente que
digita durante o aviso de instabilidade em aparelho que manda a tecla em áudio (inband).
```

- [ ] **Step 7: O fragmento de release**

Crie `.changes/telefonia-ura-e-falas.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Menu de voz (URA) no telefone, falas gravadas com a voz da ElevenLabs e aviso de instabilidade por time
---

Quem liga para um número SIP da empresa pode ouvir um **menu de voz** e escolher o time pela
tecla: "Para Suporte, digite 1. Para Financeiro, digite 2." O menu é montado em
**Conexões › Telefone › Menus** a partir das opções (tecla → time, mais o time de quem não
escolhe nada), e cada número escolhe, em **Números**, se toca direto num time ou toca o menu.
O cartão de cada menu mostra os últimos 7 dias: quantos escolheram cada tecla, quantos não
escolheram, quantos erraram a tecla e quantos desligaram no menu.

As falas são geradas pela **ElevenLabs**, com a conta da própria empresa: a chave é cadastrada
em **Credenciais de IA** (validada na hora; depois disso a tela mostra só os 4 últimos dígitos),
a voz é escolhida em **Conexões › Telefone › Voz e falas**, e cada fala pode ser ouvida no
navegador antes de ir para as ligações. Além do menu, há três falas gerais: **aguarde** (repetida
a cada ~40 s enquanto o cliente espera), **ninguém disponível** e **fora do horário** (pela agenda
do time).

Em **Configurações › Times**, gerentes e admins ligam um **aviso de instabilidade** por time, com
prazo (1 h, 2 h, 4 h ou até desligar): quem liga para aquele time ouve o aviso
antes da fila, e uma faixa no topo do CRM avisa a equipe inteira enquanto ele estiver ligado. O
aviso desliga sozinho no fim do prazo e avisa na Central.

Nada muda para quem não configurar: sem a chave da ElevenLabs e sem menu, as ligações seguem
exatamente como antes. A atualização cria as tabelas novas e o volume das falas sozinha.
```

Run: `pnpm release:conferir`
Expected: exit 0; uma linha `<versão base> + minor = <versão>  (N fragmento(s))` e, entre os fragmentos, `capacidade_nova  adicionado   Menu de voz (URA) no telefone, …`; por fim `(conferência: nada foi escrito — use --escrever)`. **Não** rode com `--escrever`: o corte da versão é da release (Task 28).

- [ ] **Step 8: Commit**

```bash
git add tests/unit/mapas-de-arquitetura.test.ts docs/architecture/telefonia.architecture.json \
  docs/specs/20-spec-telefonia-sip.md docs/current-state.md docs/testing/user-journey-map.md \
  .changes/telefonia-ura-e-falas.md
git commit -m "docs(telefonia): URA e falas nos documentos de autoridade, no mapa vivo e no fragmento

Spec 20 §8 e current-state dizem o estado da F1 (1.49.0) e da F2 v1; J36 no mapa
de jornadas; 15 peças e 31 arestas no mapa da telefonia, com o caso do DoD 13
cobrando grau ≥2; fragmento capacidade_nova.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 25: Verificação completa antes do PR

**Files:** nenhum arquivo novo. Esta task só mede; o que ela achar volta para a task de origem, com teste que reproduza, e com commit próprio.

- [ ] **Step 1: Trazer a `main` e conferir o número da migration**

```bash
git fetch origin && git merge origin/main
ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
ls supabase/migrations/ | grep -c '_0288_'
```

Expected: o merge termina sem conflito (ou com conflito resolvido à mão, preservando os dois lados — doutrina de branches); o maior `NNNN` é `0288`; e só **um** arquivo tem `_0288_`. Se a `main` ganhou uma `0288` enquanto você trabalhava, renomeie a sua para o próximo número livre (arquivo, cabeçalho, marcadores `[apêndice NNNN]`, rótulo do bloco no `baseline.sql`, linha do MANIFEST, citações no teste de invariante e nos comentários) num commit próprio — e rode de novo esta task desde o Step 1.

- [ ] **Step 2: Tipos, lint e as cercas de texto**

```bash
pnpm typecheck; echo "typecheck exit=$?"
pnpm lint; echo "lint exit=$?"
pnpm lint:channels; echo "lint:channels exit=$?"
pnpm lint:role-rank; echo "lint:role-rank exit=$?"
```

Expected: os quatro com `exit=0`. `lint:channels` reprova se `lib/telefonia/`, `app/` ou `components/` citarem o identificador do provider do tronco (nem em comentário); `lint:role-rank` reprova comparação de `ROLE_RANK` em `app/api`.

- [ ] **Step 3: A suíte de unidade inteira, com o protocolo do CLAUDE.md**

```bash
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/vt.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"
grep -aE "^ *Errors " /tmp/vt.log
```

Expected: `exit=0`, rodapé sem `failed`, `grep contou: 0` e a linha `Errors` vazia. **O exit code é a autoridade.**

Vermelhos conhecidos DESTA máquina (macOS), que passam no CI e não são do diff — só eles podem aparecer, e só nestes arquivos:
- `tests/unit/leads-import-route.test.ts` — 11 casos;
- `lib/ai/dispatcher/rate-limit.test.ts` — 5 casos, quando o `.env.local` tem `UPSTASH_REDIS_REST_URL`/`TOKEN` e o Redis local não está de pé (suba o `serverless-redis-http` ou rode sem essas variáveis).

Se o rodapé e o `grep` não baterem, a sonda está cega: rode de novo com `pnpm test:unit --reporter=verbose > /tmp/vt.log 2>&1`. Qualquer outro arquivo vermelho é deste trabalho até prova em contrário — e a prova é o mesmo arquivo vermelho na `origin/main` limpa.

- [ ] **Step 4: Invariantes contra Postgres real (precisa de Docker)**

Run: `pnpm test:db > /tmp/db.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests " /tmp/db.log | tail -2`
Expected: `exit=0`, sem `failed`. Entre os arquivos, `tests/invariants/telefonia-ura-e-falas.test.ts` e `tests/invariants/telefonia-repositorio-da-ura.test.ts`, os varredores que a Task 4 tocou (`rls-completude-varredura`, `vocabulario-banco-x-typescript`) e o `hardening-definer-varredura`. O script aplica o `baseline.sql` em modo install (`ON_ERROR_STOP=1`) e update — os dois têm de passar.

- [ ] **Step 5: O kit (o único gate que exercita o `update.sh`)**

Run: `pnpm test:shell > /tmp/sh.log 2>&1; echo "exit=$?"; grep -aiE "falhou|FAIL|✗" /tmp/sh.log | head -20`
Expected: `exit=0`. Vermelho conhecido desta máquina: UM caso de `hostgator-setup-kit/test-validators.sh` ("nome antigo com apóstrofo: esperava [Sant'Ana Odontologia] …"), que passa no CI. Qualquer outro — em especial em `tests/shell/update-guard.test.sh` ou `tests/shell/asterisk-entrypoint.test.sh` — é deste trabalho (o volume `telefonia-falas` da Task 16).

- [ ] **Step 6: O build de produção (o TS2589 só aparece aqui)**

Run: `pnpm build > /tmp/build.log 2>&1; echo "exit=$?"; grep -aE "Type error|TS2589|Failed to compile" /tmp/build.log | head`
Expected: `exit=0` e nenhuma linha no `grep`. `Type instantiation is excessively deep` (TS2589) em rota nova se resolve tipando o resultado da consulta explicitamente (`db.query<Linha>(…)`), nunca com `// @ts-ignore`.

- [ ] **Step 7: A e2e desta fase, depois do merge da `main`**

Run: `pnpm e2e:env && pnpm e2e:build && pnpm exec playwright test tests/e2e/telefonia-ura-e-falas.spec.ts`
Expected: `1 passed`. (O `e2e` do CI não roda em PR neste repositório; esta execução local é a prova das telas até o push na `main`.)

- [ ] **Step 8: Árvore limpa**

Run: `git status --short && git log --oneline origin/main..HEAD | wc -l`
Expected: `git status` vazio (os `.superpowers/evidence/` são ignorados pelo `.gitignore`) e a contagem de commits da branch maior que zero. Nada a commitar nesta task.

---

## Task 26: Revisão de segurança cética — **ORQUESTRADOR**

**Quem:** o orquestrador despacha UM subagente novo, sem o contexto desta implementação, e só para ler. Nenhuma correção sai do subagente; quem corrige é o orquestrador (ou um implementador), com teste, depois de ler o relatório.

- [ ] **Step 1: Despachar o revisor**

Ferramenta `Agent`, `subagent_type: "general-purpose"`, com este prompt (copie inteiro):

```text
Você é um revisor de segurança CÉTICO do DeskcommCRM (Next.js 16 + Supabase, multi-tenant com RLS,
self-host em VPS). Leia o CLAUDE.md da raiz e docs/threat-model.md. NÃO edite nenhum arquivo, NÃO
rode nada que escreva no disco além de /tmp, NÃO faça commit. Sua saída é um relatório.

Escopo: o diff `git diff origin/main...HEAD` da branch claude/telefonia-sip-fase2-ura-236f1e
(telefonia, fase 2, versão 1: URA e falas da ElevenLabs; desenho em
docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md §7).

Tente QUEBRAR, com prova (arquivo:linha e o passo a passo do ataque), cada uma destas afirmações:
1. A chave da ElevenLabs nunca volta ao navegador depois de salva (só os 4 últimos dígitos), nunca
   vai em query string, nunca aparece em log, Sentry, api_audit_log, mensagem de erro ou resposta.
2. Toda rota nova resolve a organização da SESSÃO (requireRole), nunca do corpo, da URL ou do id
   recebido; toda consulta com o pool `postgres` (que ignora RLS) filtra organization_id. Tente ler
   ou mudar menu, fala, áudio, voz ou aviso de OUTRA organização passando ids dela.
3. Papéis: menus, falas, voz e destino do número = admin; aviso de instabilidade = gerente ou admin;
   ler o áudio de uma fala e a lista de avisos = qualquer membro. Procure rota que aceite papel menor.
4. O áudio sai do bucket privado `phone-prompts` só pela rota autenticada; o caminho do Storage vem
   do banco (CHECK `<org>/<hash>.ulaw`), nunca do pedido.
5. O worker só escreve no volume `telefonia-falas` caminhos que passam pela régua (sem `..`, sem
   barra absoluta, sem organização trocada) e o Asterisk monta o volume só para leitura; o `media`
   do playback da ARI não aceita nada que o cliente final ou a tela controlem.
6. A tecla (DTMF) do cliente final só escolhe entre as opções do menu daquele número; `*`, `#` e
   tecla fora do menu não levam a lugar nenhum além do time padrão.
7. `allow_transfer=no` está em TODO ramal que o worker empurra; canais que não são PJSIP/ continuam
   derrubados.
8. `ELEVENLABS_API_BASE_URL` não vira porta de SSRF: quem o define é só o operador (env), e o valor
   padrão é a ElevenLabs de verdade.
9. Tabelas novas: RLS ligada, policy tenant_isolation_<tabela>_all, GRANT só de SELECT, nenhum
   GRANT a anon; nenhuma função nova exposta pelo PostgREST.
10. Falha da ElevenLabs volta 422/502, nunca 429/503 (o apiClient do navegador repetiria e
    gastaria crédito da conta do cliente); Zod em todo corpo (texto vazio, texto > 1000, tecla fora
    de 0–9, time de outra organização).

Para cada item: CONFIRMADO (com a evidência de comportamento — teste que existe e o que ele mede,
ou o trecho que impede) ou QUEBRADO (com o ataque). Separe o que você MEDIU (rodou teste/consulta)
do que só LEU. Termine com uma seção "NÃO MEDIDO". Seja específico; "parece ok" não conta.
```

- [ ] **Step 2: Triar o relatório**

Para cada QUEBRADO: reproduza com um teste que falha (unidade ou invariante), conserte na causa raiz, veja o teste passar e faça um commit próprio (`fix(telefonia): …`, corpo terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Achado que o orquestrador julgar falso positivo fica registrado com o porquê, para o corpo do PR.

- [ ] **Step 3: Medir de novo**

Se houve correção, repita a Task 25 do Step 2 ao Step 6 (e o Step 7 se a correção tocou tela ou rota).

---

## Task 27: PR — **ORQUESTRADOR** (perguntar ao dono antes de mesclar)

- [ ] **Step 1: Empurrar a branch**

Run: `git push -u origin claude/telefonia-sip-fase2-ura-236f1e`
Expected: a branch aparece em `origin` (a primeira vez cria o rastreamento).

- [ ] **Step 2: Abrir o PR**

Escreva o corpo num arquivo temporário do scratchpad e abra o PR com ele:

```bash
cat > "$SCRATCH/pr-ura.md" <<'CORPO'
## O quê

Telefonia, fase 2, **versão 1 — URA e falas** (DYD-10). Desenho:
`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano:
`docs/superpowers/plans/2026-09-28-telefonia-fase2-v1-ura.md`.

- Chave da ElevenLabs em Credenciais de IA (validada listando as vozes; só os 4 últimos dígitos voltam).
- Conexões › Telefone ganha as abas **Menus** e **Voz e falas**; o número escolhe tocar no time ou o menu.
- Worker: URA (menu, tecla, 5 s, 2 repetições, time padrão), aguarde a cada ~40 s, "ninguém disponível",
  fora do horário pela agenda do time, aviso de instabilidade tocado inteiro na entrada da fila.
- Aviso de instabilidade por time com prazo, faixa em todo o CRM e desligamento automático com aviso na Central.
- Ramais com `allow_transfer=no`.
- Migration **0288** (migration + apêndice do `baseline.sql` + MANIFEST); volume `telefonia-falas`
  (worker escreve, Asterisk só lê).

## Como foi provado

- `pnpm typecheck`, `pnpm lint`, `lint:channels`, `lint:role-rank`, `pnpm test:unit` (protocolo do
  CLAUDE.md), `pnpm test:db`, `pnpm test:shell`, `pnpm build` — resultados da Task 25.
- E2E pela tela com a ElevenLabs falsa: `tests/e2e/telefonia-ura-e-falas.spec.ts` (`1 passed`, local).
- Revisão de segurança cética (Task 26): <achados e o que foi feito com cada um>.

## Não medido

- A ligação real com a URA (tecla, fala tocada, fila): é a Task 29, na VPS, depois da release.
- <o "NÃO MEDIDO" do revisor>

## Efeito no operador

`.changes/telefonia-ura-e-falas.md` — `capacidade_nova`. Nada muda sem a chave da ElevenLabs e sem menu.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
CORPO
gh pr create --base main --head claude/telefonia-sip-fase2-ura-236f1e \
  --title "feat(telefonia): URA e falas da ElevenLabs — fase 2, versão 1 (0288)" \
  --body-file "$SCRATCH/pr-ura.md"
```

(`$SCRATCH` é o diretório de scratchpad da sessão; preencha os dois `<…>` com o que a Task 26 produziu antes de rodar.)

Expected: a URL do PR.

- [ ] **Step 3: Esperar os checks obrigatórios**

Run: `gh pr checks <número> --watch`
Expected: `verify`, `build-and-size`, `invariants` e `imagens-ok` verdes (os quatro obrigatórios — confira a lista em vigor com `gh api repos/paulocmbcosta/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`). Vermelho → volta à task de origem, conserta, empurra, espera de novo.

- [ ] **Step 4: Perguntar ao dono**

Mande ao dono: o link do PR, o resumo do que muda, os checks, o resultado da revisão de segurança e o "Não medido". **Não mescle sem um "pode mesclar" explícito para ESTE PR.** Com a autorização: `gh pr merge <número> --merge` (commit de merge, como os PRs anteriores).

---

## Task 28: Release e deploy na VPS — **ORQUESTRADOR, só com autorização explícita**

Autorização de merge não é autorização de release, e release não é autorização de VPS. Cada uma é pedida ao dono, para este trabalho, antes de acontecer.

- [ ] **Step 1: Cortar a release (com autorização)**

```bash
gh workflow run release.yml --ref main
gh run list --workflow release.yml --limit 1
```

Expected: o workflow abre o PR `Release X.Y.Z` (assinado pelo App de release), com o CHANGELOG montado a partir dos fragmentos — inclusive `telefonia-ura-e-falas.md` em "Adicionado". Espere os checks do PR de release (`gh pr checks <n> --watch`) e mescle **com commit de merge** (`gh pr merge <n> --merge`): o corte da tag lê `HEAD^2`. Depois confira que a tag e as quatro imagens saíram: `git fetch --tags && git tag --list 'vX.Y.Z'` e `gh run list --workflow publish-image.yml --limit 2` (sucesso).

- [ ] **Step 2: Atualizar a VPS (com autorização)**

```bash
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0 \
  'cd /root/DeskcommCRM && nohup bash hostgator-setup-kit/update.sh > /root/deskcomm-update-X.Y.Z.log 2>&1 < /dev/null &'
```

Não faça `git checkout` da tag antes: o `update.sh` busca a tag e decide sozinho. Para saber se terminou, leia o log (nunca `pgrep`, que casa com a própria sessão SSH):

```bash
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0 \
  'grep -E "Atualização concluída|ERRO|erro" /root/deskcomm-update-X.Y.Z.log | tail -5'
```

Expected: `✓ Atualização concluída — app no ar e saudável.`

- [ ] **Step 3: Conferir o que chegou**

```bash
curl -sI https://app.dyper.com.br/ | head -1
curl -s https://app.dyper.com.br/api/v1/health
```

Expected: `HTTP/2 307` (redireciona para o login — `404` significa roteamento perdido, ver `docs/runbooks/deploy.md` §2) e a versão `X.Y.Z` no health.

Crie localmente `$SCRATCH/confere-0288.sql` com:

```sql
select to_regclass('public.phone_prompts') is not null as prompts,
       to_regclass('public.phone_menus') is not null as menus,
       exists (select 1 from storage.buckets where id = 'phone-prompts' and public = false) as bucket_privado;
```

e rode na VPS (o arquivo vai pelo stdin do ssh; `load_env` antes de `url_do_schema`):

```bash
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0 \
  'cd /root/DeskcommCRM && . hostgator-setup-kit/_common.sh && load_env && docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" -At -f -' \
  < "$SCRATCH/confere-0288.sql"
```

Expected: `t|t|t`.

E o volume das falas nos dois contêineres:

```bash
ssh -p 22022 -i ~/.ssh/id_ed25519_pessoal root@143.95.162.0 '
  for c in $(docker ps --format "{{.Names}}" | grep -E "asterisk|worker"); do
    echo "$c"; docker inspect "$c" --format "{{range .Mounts}}{{.Destination}} rw={{.RW}}{{\"\n\"}}{{end}}" | grep falas
  done'
```

Expected: no `asterisk`, `/var/lib/deskcomm/falas rw=false`; no `worker`, `/var/lib/deskcomm/falas rw=true` (no ramo B da Task 0, o destino do `asterisk` é `/usr/share/asterisk/sounds/deskcomm`). O paliativo `NODE_OPTIONS` do `.env` da VPS fica como está.

- [ ] **Step 4: Se a Task 0B reprovou** — a correção do `dtmf_mode` (Task 0C) está nesta release; repita a Task 0B antes de começar a Task 29.

---

## Task 29: Prova na VPS, pela tela, com o dono ligando — **ORQUESTRADOR** (§10 do desenho, versão 1)

**Quem:** o dono opera a tela e liga do celular para o **(61) 3686-1503**; o orquestrador acompanha, confere banco e logs pela VPS e registra. **A senha do dono e a chave da ElevenLabs nunca passam pelo orquestrador nem pelo chat:** o dono loga e cola a chave ele mesmo, na tela de Credenciais de IA. Evidência em `.superpowers/evidence/telefonia/` (ignorado pelo git): `vps-v1-<caso>.png` e a saída das consultas.

Consulta usada depois de cada ligação — crie `$SCRATCH/ligacoes-ura.sql`:

```sql
select to_char(v.started_at at time zone 'America/Sao_Paulo', 'HH24:MI:SS') as hora,
       v.status, v.menu_digit, v.menu_outcome,
       v.emergency_heard_at is not null as ouviu_aviso,
       v.end_reason,
       (select t.name from attendance_teams t where t.id = v.team_id) as time
  from voice_calls v
 where v.provider = 'sip_trunk' and v.direction = 'inbound'
   and v.started_at > now() - interval '3 hours'
 order by v.started_at desc
 limit 10;
```

e rode com o mesmo `ssh … psql "$(url_do_schema)" -At -f - < "$SCRATCH/ligacoes-ura.sql"` da Task 28. Log do worker: `ssh … 'docker logs --since 15m $(docker ps --format "{{.Names}}" | grep worker) 2>&1 | grep -iE "fala|ura|menu|aviso" | tail -30'`.

- [ ] **Step 1: Montar pela tela** — o dono: (a) cola a chave em Credenciais de IA e vê os 4 últimos dígitos; (b) em Conexões › Telefone › Voz e falas escolhe a voz e gera e ouve as três falas; (c) em Menus cria o menu com os times reais (ex.: 1 → Suporte, 2 → Financeiro), o time padrão e a fala de tecla inválida, e gera; (d) em Números aponta o 3686-1503 para o menu. Captura de cada tela. Expected: as falas "pronta", o cartão do número "Quando ligarem: menu …".

- [ ] **Step 2: Opção 1** — liga, espera o menu, digita 1. Expected: toca no navegador de um atendente do time da opção 1; na consulta, `menu_digit=1`, `menu_outcome=chosen`; o cartão da ligação diz a escolha.

- [ ] **Step 3: Opção 2** — idem com 2. Expected: time da opção 2, `menu_digit=2`, `chosen`.

- [ ] **Step 4: Tecla errada** — digita uma tecla fora do menu (ex.: 9) a cada repetição. Expected: ouve a fala de tecla inválida e o menu de novo; depois de 2 repetições, time padrão com `menu_outcome=default_invalid`; o cartão diz "sem escolha → <time padrão>".

- [ ] **Step 5: Sem tecla** — não digita nada. Expected: o menu repete 2 vezes (5 s depois de cada fala) e a ligação vai ao time padrão com `default_no_input`.

- [ ] **Step 6: Desligar no menu** — desliga durante o menu. Expected: a ligação vira perdida; "Ligar de volta" aparece na Central para o time padrão.

- [ ] **Step 7: Aviso de instabilidade** — o gerente liga o aviso no time da opção 1 (Configurações › Times, "Ouvir", 1 hora, "Ligar"); a faixa aparece para todos. Liga, digita 1 e aperta teclas durante o aviso. Expected: o aviso toca INTEIRO (a tecla não corta), depois a fila; `ouviu_aviso=t`. O gerente desliga; nova ligação com 1 não ouve o aviso (`ouviu_aviso=f`) e a faixa sumiu nas outras abas em até 60 s.

- [ ] **Step 8: Fora do horário** — com o dono, feche temporariamente o horário do time da opção 1 em Configurações › Times (anote o horário original ANTES). Liga e digita 1. Expected: ouve a fala de fora do horário e a ligação cai; `end_reason=after_hours`; o cartão diz "fora do horário"; **nenhum** aviso novo na Central. Restaure o horário original e confira na tela.

- [ ] **Step 9: Ninguém disponível** — com os atendentes do time da opção 2 fora (sem o navegador aberto ou em pausa), liga e digita 2. Expected: "aguarde", música, "aguarde" de novo a cada ~40 s; em 2 min, "ninguém disponível" e a ligação cai; "Ligar de volta" na Central.

- [ ] **Step 10: Registrar** — numa branch nova a partir da `main` (`git fetch origin && git switch -c claude/telefonia-ura-prova-vps origin/main`), troque em `docs/testing/user-journey-map.md` o "pendente — prova na VPS (Task 29)" de J36.6–J36.13 pelo resultado de cada passo (**PASS** com a data e o nome da evidência, ou **FAIL** com o sintoma), e em `docs/current-state.md` troque "prova na VPS pendente" pelo que foi provado. Commit (`docs(telefonia): prova da URA na VPS — J36`, com o `Co-Authored-By`), PR, e pergunta ao dono antes de mesclar. Defeito achado → conserto na causa raiz, com teste que reproduza, em PR próprio; nova release só com nova autorização.

- [ ] **Step 11: Devolver ao estado que o dono quiser** — pergunte se o 3686-1503 continua no menu ou volta a tocar direto no time, e se o aviso de instabilidade fica desligado. Faça pela tela, com ele.

---

## Cobertura do desenho (autoconferência)

| Desenho | Onde |
|---|---|
| §2 Passo zero (playback e DTMF) | Tasks 0, 0B, 0C |
| §3.1 Dados da versão 1 | Task 4 (migration 0288, invariantes), Task 11 (SQL do worker) |
| §4 Áudio: ElevenLabs → Storage → volume → Asterisk | Tasks 1 (μ-law), 2 (cliente), 6 (falas e armazém), 12 (falas no disco), 13 (`tocarFala`), 16 (volume) |
| §5.1 Recebida com URA | Task 3 (`passoDaUra`), Task 15 (controlador), Task 11 (`registrarMenu`, `definirTimeDaLigacao`) |
| §5.2 Fila do time (fora do horário, aviso, aguarde ~40 s, ninguém disponível) | Task 11 (`situacaoDoTime` separa fora do horário de ninguém disponível), Task 14, Task 3 (vencimento) |
| §5.3 Rede de proteção `allow_transfer=no` | Task 13 |
| §5.5 Worker (porta da ARI, eventos, passada de 60 s, `expires_at` na hora) | Tasks 11, 13, 14, 15, 16 |
| §6.1 Credenciais de IA | Tasks 5, 17 |
| §6.2 Conexões › Telefone (Voz e falas, Menus, Números) | Tasks 7, 8, 9, 18, 19, 20 |
| §6.3 e §6.4 Aviso por time e faixa | Tasks 10, 21 |
| §6.6 Cartão da ligação | Task 22 |
| §6.8 Central (`phone_prompt_unplayable`, `phone_emergency_expired`) | Task 4 (vocabulário), Tasks 11, 14–16 (emissão) |
| §7 Segurança | Tasks 4, 5, 7–10, 12, 13; revisão cética na Task 26 |
| §8 Living System Checklist e mapa vivo | Tasks 19 ("últimos 7 dias"), 21 (faixa), 24 (mapa, com teste de grau ≥2) |
| §10 Testes e prova (v1) | Unidade em cada task; invariantes na Task 4 e 11; kit na Task 16; e2e na Task 23; documentos na Task 24; VPS na Task 29 |
| §9 e versões 2 e 3 | Fora deste plano (só a coluna `accepts_extension`, na Task 4) |

---

## Pontos para o orquestrador decidir

Nenhum destes muda o desenho; cada um é uma lacuna ou uma escolha que o plano teve de fazer.

1. **Fora do horário sem fala gerada** (§5.2.1 diz "toca `after_hours` e desliga"). O plano segue a fase 1 quando a fala não existe (fila de 2 min → perdida com "Ligar de volta"): desligar em silêncio seria beco sem saída para quem ainda não cadastrou a chave. Confirmar, ou trocar por "desliga mesmo sem fala".
2. **A faixa em outras abas demora até 60 s** (§6.4: "aparece e some sem recarregar"). `attendance_teams` não está na publicação `supabase_realtime`; o plano relê a cada 60 s e na volta do foco, e só a aba de quem liga/desliga muda na hora. Pôr a tabela no Realtime transmitiria toda edição de time.
3. **Sub-abas em `?sub=`, não `?aba=`** (§6.2): `?aba=` já escolhe o canal em Conexões.
4. **Durações do aviso** (o desenho não fixa): 1 h, 2 h, 4 h ou até desligar; padrão 2 h.
5. **Auditoria além da lista do §7:** `phone.voice_changed` e `phone.menu_archived`; a chave é auditada como `ai.credential_created` com `provider = elevenlabs`.
6. **`accepts_extension`** nasce na 0288 sem controle na tela (o §6.2 lista no editor "(versão 3)"); o editor da v1 não mostra.
7. **Texto sugerido de "fora do horário" não cita o WhatsApp** (a F2 da spec 20 prometia "mensagem de fora do horário com WhatsApp"). É editável; decidir se o sugerido deve trazer o número do WhatsApp da organização — exigiria ler o canal oficial ao montar o texto.
8. **Síntese sem rate limit.** As rotas são só de admin e o mesmo texto + voz reaproveita a fala (hash), mas cada texto novo gasta crédito da conta do cliente. O DoD só exige rate limit em rota pública.
9. **`docs/current-state.md` tem outras afirmações velhas na mesma linha**: além da frase de publicação (a Task 24 corrige), "A RECEBIDA: infraestrutura provada, produto não" e "nenhuma spec Playwright" da F1. A memória do dono registra a recebida atendida no navegador em produção em 28/09; atualizar com evidência fica fora da v1.
10. **Se a Task 0B reprovar**, a Task 0C muda o `dtmf_mode` dos troncos da F1 e precisa de deploy antes da prova da URA — possivelmente uma release só para isso, com a própria autorização.
11. **O `e2e` do CI não roda em PR** neste repositório: a prova das telas antes do merge é a execução local da Task 23/25; o CI só a repete no push da `main`.
12. **Nenhuma função SQL nova** (o §10 pede "o `revoke` das funções novas"): toda escrita vai pela API e pelo worker com o pool `postgres` e filtro manual de `organization_id`. Se o revisor da Task 26 preferir função `security definer` para alguma escrita, ela entra com o `revoke` das duas origens.
