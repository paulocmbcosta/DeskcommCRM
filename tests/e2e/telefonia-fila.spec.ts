/**
 * [P1] A FILA DO TELEFONE PELA TELA — a aba "Telefone" do Inbox e a espera máxima
 * por time (fila visível, entrega 2; migration 0295; J44 do mapa de jornadas), e
 * o que a aba deixa FAZER com quem espera — atender e mover (entrega 3; migration
 * 0296; J45).
 *
 * Desenho: docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md (§4.2 e §4.3).
 *
 * O que só a tela prova, e esta spec mede:
 *  1. o ATENDENTE (papel agent) abre o Inbox e o trilho ganha a aba "Telefone",
 *     com o selo de quem ESPERA (3 — quem está em ligação ou ainda nos avisos não
 *     conta); a aba lista as ligações por seção — na fila POR ORDEM DE CHEGADA
 *     (a mais antiga é a 1ª, com o "cai em"), nos avisos, em ligação e as
 *     perdidas de há pouco —, no lugar da lista de conversas e da busca; clicar
 *     numa linha abre a conversa dela à direita; e, quando a fila anda (a 1ª
 *     desliga), a linha sai, a 2ª vira a 1ª e o selo cai para 2 — SEM recarregar
 *     a página. Nenhuma linha vaza da coluna (medido no elemento);
 *  2. o GERENTE (papel manager) troca a espera máxima do time em Configurações ›
 *     Times: o seletor mostra o que o banco tem, grava na hora (coluna
 *     `attendance_teams.phone_queue_max_wait_seconds` e auditoria
 *     `phone.queue_wait_changed`), e o valor VOLTA DO BANCO depois do reload;
 *  3. numa organização SEM número de telefone, na MESMA instalação, a aba não
 *     existe — e o link guardado (`?filter=phone`) diz o porquê em vez de
 *     mostrar uma fila vazia;
 *  4. AGIR NA FILA, quem vê o quê (entrega 3): o GERENTE tem o botão de mover em
 *     cada ligação que espera por uma pessoa — aguardando ou tocando, inclusive a
 *     que toca para ele, que a linha chama de "Tocando para você" —, e o menu
 *     lista os OUTROS times; a ligação que ainda ouve os avisos não tem botão
 *     nenhum; o ATENDENTE, na mesma fila, não tem o de mover. A faixa das ações
 *     fica EMBAIXO do texto da linha e não faz a coluna rolar para o lado (medido
 *     no elemento);
 *  5. com uma ORDEM ABERTA sobre a ligação (alguém pediu para atender, ou para
 *     mover), a linha diz quem está cuidando — "Bruno Atendente está atendendo…",
 *     "Movendo para <time>…" — no lugar dos botões; e, quando a ordem acaba sem a
 *     ligação mudar de mãos, os botões voltam, sem recarregar a página;
 *  6. o CARTÃO da ligação, na conversa, conta o que se fez com ela na fila:
 *     "Movida de <time> para <time> por <quem>" e "Puxada da fila por <quem>" — e
 *     o cartão da ligação em que ninguém agiu não ganha linha nenhuma.
 *
 * ⚠️ O QUE A ENTREGA 3 NÃO PROVA AQUI. O botão "Atender" só existe para quem tem
 * ramal neste navegador, e a credencial do ramal só sai depois de a rota gravá-la
 * no Asterisk (`POST /api/v1/telefonia/ramal`) — no CI nada escuta a ARI. O caso
 * 4 mede esse estado (a rota não entrega ramal, e a tela não oferece "Atender"),
 * e não o botão. O CLIQUE em "Atender" e em um time do menu de mover também fica
 * de fora: a rota grava a ordem e a entrega ao worker pela ARI, e quem age é ele.
 * O botão, o atendimento automático e o que o worker faz com a ordem estão em
 * unidade (`components/telefonia/fila/LinhaDaFila.test.tsx`,
 * `components/telefonia/TelefoniaContext.fila.test.tsx`,
 * `lib/channels/telefonia/controle.test.ts`) e no Postgres real
 * (`tests/invariants/telefonia-pedido-da-fila.test.ts`,
 * `telefonia-ordens-da-fila-repositorio.test.ts`); a ligação de verdade é o
 * roteiro `docs/runbooks/telefonia-fila-visivel.md` (§3) — o estado dele está na
 * J45 de `docs/testing/user-journey-map.md`.
 *
 * As ligações são SEMEADAS em `voice_calls`, como o worker as deixa
 * (`marcarNaFila`, `marcarPrazoDaFila`, `marcarTocando`, `marcarAtendida` e
 * `encerrarLigacao`, em lib/channels/telefonia/repositorio.ts): a ligação de
 * verdade — Asterisk, ponte, toque — não existe no CI (nada escuta a porta da
 * ARI) e é provada na VPS. Esta spec prova a TELA e a rota que ela lê
 * (`GET /api/v1/telefonia/fila`), não que o worker escreva a fila: isso está em
 * unidade (`lib/channels/telefonia/controle.test.ts`) e no Postgres real
 * (`tests/invariants/telefonia-fila-visivel-repositorio.test.ts` e
 * `telefonia-fila-da-tela.test.ts`). As escritas da semeadura vão como o SISTEMA
 * (postgres): pela REST a linha do telefone é só-leitura (policy da 0288). As
 * ORDENS da fila (`voice_call_queue_orders`) também, e ali nem a service key
 * escreve — o `revoke all` da 0296 tirou a escrita de `service_role`; a ordem
 * aberta é semeada como a rota a deixa (`pedirAtender`/`pedirMover`). O cartão
 * do caso 6 é a mensagem `ligacao:<id>` com `metadata.voice_call.fila`, como
 * `registrarNaConversa` a grava no fim da ligação.
 *
 * Os instantes da semeadura são do relógio do BANCO (`now()` ± um intervalo, no
 * próprio INSERT): a tela mede a espera pelo relógio de lá, e semear pelo relógio
 * do runner poria a diferença entre os dois dentro da medida.
 *
 * ORGANIZAÇÃO PRÓPRIA, gerente e atendente sem MFA (a política padrão não exige),
 * como em `telefonia-gravacao.spec.ts`: nada daqui vaza para as vizinhas.
 *
 * ⚠️ ESTA SPEC EXIGE E2E_TELEFONIA=1: a rota da fila responde `ativa: false`
 * (e a aba não aparece) onde a instalação não oferece telefonia
 * (`TELEFONIA_ARI_URL`/`_PASSWORD` no .env.e2e). No CI, só a parte 3 —
 * `tests/unit/e2e-telefonia-so-na-parte-3.test.ts` prende.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { Pool } from "pg";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = ".superpowers/evidence/telefonia-fila";

const SUFIXO = randomUUID().slice(0, 8);
const QUATRO_DIGITOS = String(1000 + Math.floor(Math.random() * 9000));
/** O time nasce com 10 minutos de espera máxima: o caso 2 lê esse valor na tela antes de trocá-lo. */
const TIME = { id: randomUUID(), nome: `Suporte Fila ${SUFIXO}`, esperaMaximaS: 600 };
/**
 * O SEGUNDO time ativo da organização, só dos casos da entrega 3 (criado por
 * `garantirOOutroTime`, dentro deles): sem outro time não há para onde mover, e
 * o botão de mover nem aparece. Os três primeiros casos rodam com um time só.
 */
const OUTRO_TIME = { id: randomUUID(), nome: `Financeiro Fila ${SUFIXO}` };
const NUMERO = { id: randomUUID(), nome: `Número Fila ${SUFIXO}`, e164: `+55613003${QUATRO_DIGITOS}` };

test.use({ viewport: { width: 1440, height: 900 } });

let pool: Pool | undefined;
let orgId = "";
const gerente = { email: `fila-gerente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "", nome: "Carla Gerente" };
const atendente = { email: `fila-atendente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "", nome: "Bruno Atendente" };

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error("o pool do banco não subiu — o beforeAll falhou antes");
  return (await pool.query<T>(texto, valores)).rows;
}

async function criarUsuario(email: string, senha: string, nome: string): Promise<string> {
  const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { full_name: nome } });
  if (criado.error || !criado.data.user) throw criado.error ?? new Error(`usuário ${email} não foi criado`);
  return criado.data.user.id;
}

async function entrar(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

/**
 * A EVIDÊNCIA VAI PARA O DISCO E PARA O RELATÓRIO, pelo CAMINHO do arquivo.
 *
 * `testInfo.attach(nome, { body })` guarda os bytes só na memória do resultado:
 * quem os grava é o reporter, e o CI roda com `--reporter=list`, que não grava
 * nada — o anexo sumiria. Com `path`, o Playwright COPIA o arquivo para
 * `test-results/<caso>/attachments/` com qualquer reporter (medido na 1.63:
 * `normalizeAndSaveAttachment`), que é a pasta que o job do e2e publica. A cópia
 * em `.superpowers/evidence/` é a de quem roda local, como nas specs vizinhas.
 */
async function anexarCaptura(page: Page, testInfo: TestInfo, nome: string): Promise<void> {
  const caminho = `${EVIDENCIA}/${nome}.png`;
  await page.screenshot({ path: caminho, fullPage: false });
  await testInfo.attach(nome, { path: caminho, contentType: "image/png" });
}

async function anexarJson(testInfo: TestInfo, nome: string, dados: unknown): Promise<void> {
  const caminho = `${EVIDENCIA}/${nome}.json`;
  writeFileSync(caminho, `${JSON.stringify(dados, null, 2)}\n`);
  await testInfo.attach(nome, { path: caminho, contentType: "application/json" });
}

/** "3:07" → 187. O relógio da aba é "m:ss" (`relogio`, em lib/telefonia/fila.ts). */
function segundos(relogio: string): number {
  const [m, s] = relogio.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
}

/**
 * Uma recebida do TELEFONE em `voice_calls`, como o worker a deixa. Os tempos
 * são segundos em relação ao `now()` do banco, no mesmo INSERT: `null` deixa a
 * coluna nula (`make_interval` é estrita — segundos nulos, instante nulo).
 */
async function semearLigacao(l: {
  id: string;
  ref: string;
  telefone: string;
  status: "ringing" | "connected" | "ended";
  comecouHaS: number;
  /** `queued_at`: há quanto passou a esperar por uma pessoa. `null` = ainda nos avisos. */
  naFilaHaS?: number | null;
  /** `queue_deadline_at`: em quanto a espera sem ninguém livre esgota (no FUTURO). */
  caiEmS?: number | null;
  atendidaHaS?: number | null;
  encerradaHaS?: number | null;
  motivo?: string | null;
  contatoId?: string | null;
  conversaId?: string | null;
  tocandoPara?: string | null;
  dono?: string | null;
}): Promise<void> {
  await sql(
    `insert into public.voice_calls
       (id, organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction, peer_phone, status,
        started_at, queued_at, queue_deadline_at, answered_at, ended_at, end_reason,
        conversation_id, team_id, ringing_user_id, owner_user_id)
     values ($1, $2, $3, $4, 'sip_trunk', $5, 'inbound', $6, $7,
             now() - make_interval(secs => $8::double precision),
             now() - make_interval(secs => $9::double precision),
             now() + make_interval(secs => $10::double precision),
             now() - make_interval(secs => $11::double precision),
             now() - make_interval(secs => $12::double precision),
             $13, $14, $15, $16, $17)`,
    [
      l.id,
      orgId,
      NUMERO.id,
      l.contatoId ?? null,
      l.ref,
      l.telefone,
      l.status,
      l.comecouHaS,
      l.naFilaHaS ?? null,
      l.caiEmS ?? null,
      l.atendidaHaS ?? null,
      l.encerradaHaS ?? null,
      l.motivo ?? null,
      l.conversaId ?? null,
      TIME.id,
      l.tocandoPara ?? null,
      l.dono ?? null,
    ],
  );
}

async function criarContato(nome: string, telefone: string): Promise<string> {
  const [contato] = await sql<{ id: string }>(
    `insert into public.contacts (organization_id, display_name, phone_number, source) values ($1, $2, $3, 'phone_call') returning id`,
    [orgId, nome, telefone],
  );
  return contato!.id;
}

const contarAuditoria = async (acao: string, ator: string) =>
  (
    await sql<{ n: number }>(
      "select count(*)::int as n from api_audit_log where organization_id = $1 and action = $2 and actor_user_id = $3",
      [orgId, acao, ator],
    )
  )[0]?.n ?? 0;

// ─── agir na fila (entrega 3; migration 0296) ───────────────────────────────

/**
 * A fila DESTA organização volta a zero, como o fim de cada ligação a deixa: a
 * ordem que ficou aberta fecha `cancelled` (o UPDATE de `cancelarOrdensDaLigacao`)
 * e a ligação viva é encerrada (o de `encerrarLigacao`). Os casos da entrega 3
 * começam por aqui: os de cima deixam ligações vivas na organização, e cada caso
 * conta só as que semeou.
 */
async function esvaziarAFila(): Promise<void> {
  await sql(
    `update public.voice_call_queue_orders
        set status = 'ended', outcome = 'cancelled', reason = 'ligacao_encerrada', ended_at = now()
      where organization_id = $1 and status = 'open'`,
    [orgId],
  );
  await sql(
    `update public.voice_calls set status = 'ended', ended_at = now(), end_reason = 'cliente_desligou', ringing_user_id = null
      where organization_id = $1 and status <> 'ended'`,
    [orgId],
  );
}

/** O segundo time ativo (ver `OUTRO_TIME`). Chamado por cada caso que precisa dele; a segunda chamada não faz nada. */
async function garantirOOutroTime(): Promise<void> {
  await sql(
    `insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, $3, $4)
     on conflict (id) do nothing`,
    [OUTRO_TIME.id, orgId, OUTRO_TIME.nome, `financeiro-fila-${SUFIXO}`],
  );
}

/**
 * Uma ORDEM ABERTA sobre uma ligação que espera, como a rota a deixa depois de
 * aceitar o pedido (`pedirAtender` e `pedirMover`, em
 * lib/channels/telefonia/pedido-da-fila.ts): no atender, `to_user_id` é quem
 * pediu; no mover, `to_team_id` é o destino; nos dois, `from_team_id` é o time em
 * que a ligação esperava. Pela conexão direta: pela REST esta tabela é só-leitura
 * até para a service key (o `revoke all` da 0296).
 */
async function semearOrdemAberta(o: {
  ligacaoId: string;
  tipo: "pull" | "move";
  quemPediu: string;
  /** Só no mover: o time de destino. */
  paraOTime?: string;
}): Promise<string> {
  const [ordem] = await sql<{ id: string }>(
    `insert into public.voice_call_queue_orders
       (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      orgId,
      o.ligacaoId,
      o.tipo,
      o.quemPediu,
      o.tipo === "pull" ? o.quemPediu : null,
      o.tipo === "move" ? (o.paraOTime ?? null) : null,
      TIME.id,
    ],
  );
  return ordem!.id;
}

/** Do Inbox à aba Telefone, pelo trilho — o caminho do caso 1. Devolve a coluna da fila, já na tela. */
async function abrirAbaTelefone(page: Page): Promise<Locator> {
  await page.goto("/app/inbox");
  const trilho = page.getByTestId("inbox-abas");
  const abaTelefone = trilho.getByRole("tab", { name: "Telefone", exact: true });
  await expect(abaTelefone).toBeVisible({ timeout: 30_000 });
  await abaTelefone.click();
  await expect(page).toHaveURL(/[?&]filter=phone\b/);
  await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Telefone");
  const coluna = page.getByTestId("fila-do-telefone");
  await expect(coluna).toBeVisible({ timeout: 20_000 });
  return coluna;
}

/**
 * O que a rota do ramal responde a ESTE navegador, com a sessão dele — a mesma
 * pergunta que o app faz sozinho ao carregar (`TelefoniaProvider`), feita de
 * dentro da página.
 *
 * É o ramal que decide o botão "Atender" (`disponivel`, em `TelefoniaContext`):
 * só com `ativo: true` a fila o oferece. Perguntar à rota é o controle da
 * ausência: se ela não entrega credencial a esta pessoa aqui, "não há Atender" é
 * o estado da tela, e não um pedido que ainda está no ar.
 */
async function ramalDesteNavegador(page: Page): Promise<{ status: number; ativo: boolean }> {
  return page.evaluate(async () => {
    const r = await fetch("/api/v1/telefonia/ramal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    const corpo = (await r.json().catch(() => null)) as { data?: { ativo?: unknown } } | null;
    return { status: r.status, ativo: r.ok && corpo?.data?.ativo === true };
  });
}

/** A LINHA inteira de uma ligação — a área principal (que abre a conversa) mais a faixa de baixo (os botões, ou quem está cuidando). */
const linhaInteira = (coluna: Locator, id: string) => coluna.locator(`[data-linha-da-fila="${id}"]`);

interface Caixa {
  esquerda: number;
  direita: number;
  topo: number;
  base: number;
  largura: number;
  altura: number;
}
interface MedidaDaLinha extends Caixa {
  scrollWidth: number;
  clientWidth: number;
  /** A área principal: o selo da posição, o nome, os detalhes e o estado. */
  corpo: Caixa | null;
  /** A faixa de baixo: os botões (`data-fila-acoes`) ou a frase da ordem aberta (`data-fila-ordem`). */
  faixa: Caixa | null;
  mover: Caixa | null;
  estado: string | null;
  textoDaFaixa: string | null;
}

/** As caixas de cada linha pedida, lidas no MESMO quadro, mais a coluna que as contém. */
async function medirLinhasDaFila(page: Page, ids: Record<string, string>) {
  return page.evaluate((porNome) => {
    const col = document.querySelector<HTMLElement>('[data-testid="fila-do-telefone"]');
    if (!col) return null;
    const caixa = (el: Element): Caixa => {
      const r = el.getBoundingClientRect();
      return { esquerda: r.left, direita: r.right, topo: r.top, base: r.bottom, largura: r.width, altura: r.height };
    };
    const parte = (raiz: Element, seletor: string): Caixa | null => {
      const el = raiz.querySelector(seletor);
      return el ? caixa(el) : null;
    };
    const linhas: Record<string, MedidaDaLinha | null> = {};
    for (const [nome, id] of Object.entries(porNome)) {
      const el = col.querySelector<HTMLElement>(`[data-linha-da-fila="${id}"]`);
      linhas[nome] = el
        ? {
            ...caixa(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            corpo: parte(el, "[data-ligacao-id]"),
            faixa: parte(el, "[data-fila-acoes], [data-fila-ordem]"),
            mover: parte(el, "[data-fila-mover]"),
            estado: el.querySelector('[data-testid="estado-da-ligacao"]')?.textContent ?? null,
            textoDaFaixa: el.querySelector("[data-fila-ordem]")?.textContent ?? null,
          }
        : null;
    }
    return {
      viewport: { largura: window.innerWidth, altura: window.innerHeight },
      coluna: { ...caixa(col), scrollWidth: col.scrollWidth, clientWidth: col.clientWidth },
      linhas,
    };
  }, ids);
}

test.describe("telefonia — a fila do telefone pela tela", () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    mkdirSync(EVIDENCIA, { recursive: true });
    if (!(process.env.TELEFONIA_ARI_URL ?? "").trim() || !(process.env.TELEFONIA_ARI_PASSWORD ?? "").trim()) {
      throw new Error(
        "Esta spec precisa da telefonia oferecida: rode com E2E_TELEFONIA=1 (`E2E_TELEFONIA=1 pnpm e2e:env`). " +
          "O .env.e2e atual não tem TELEFONIA_ARI_URL/TELEFONIA_ARI_PASSWORD — no CI, só a parte 3 os recebe.",
      );
    }
    if (!credenciais.dbUrl) throw new Error("SUPABASE_DB_URL ausente — rode `pnpm e2e:env` de novo.");
    pool = new Pool({ connectionString: credenciais.dbUrl, max: 2 });

    gerente.id = await criarUsuario(gerente.email, gerente.senha, gerente.nome);
    atendente.id = await criarUsuario(atendente.email, atendente.senha, atendente.nome);
    const org = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Fila ${SUFIXO}`,
        legal_name: `Provedor Fila ${SUFIXO}`,
        slug: `fila-${SUFIXO}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    for (const [usuario, papel] of [
      [gerente.id, "manager"],
      [atendente.id, "agent"],
    ] as const) {
      const vinculo = await db.from("user_organizations").insert({
        organization_id: orgId,
        user_id: usuario,
        role: papel,
        accepted_at: new Date().toISOString(),
      });
      if (vinculo.error) throw vinculo.error;
    }
    // Times por SQL, como na spec da URA: `attendance_teams` só aceita escrita pela RPC de gestor com MFA.
    // A espera máxima já nasce gravada (10 min): é o que a rota da fila devolve como teto do time.
    await sql(
      `insert into public.attendance_teams (id, organization_id, name, slug, phone_queue_max_wait_seconds)
       values ($1, $2, $3, $4, $5)`,
      [TIME.id, orgId, TIME.nome, `suporte-fila-${SUFIXO}`, TIME.esperaMaximaS],
    );
    for (const usuario of [gerente.id, atendente.id]) {
      await sql(`insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`, [
        orgId,
        TIME.id,
        usuario,
      ]);
    }

    // O número da operadora (nada escuta a ARI: a senha não importa). É ele que
    // faz a rota da fila dizer `ativa: true` para esta organização.
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', $4, $5,
               'voip.e2e-fila.com.br', 5060, 'udp', $6, decode('00', 'hex'), $7)`,
      [NUMERO.id, orgId, CHANNEL_PROVIDER_SIP_TRUNK, NUMERO.nome, NUMERO.e164, `fila${SUFIXO}`, TIME.id],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      if (orgId) {
        // Nenhuma ligação "viva" nem ordem aberta fica para trás (o caso 1 deixa quatro ligações), e o número sai de cena.
        await esvaziarAFila();
        await sql(`update public.channel_sessions set archived_at = now() where id = $1 and organization_id = $2`, [NUMERO.id, orgId]);
      }
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  test("a aba Telefone mostra quem espera, por ordem de chegada, e atualiza sozinha quando a fila anda", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // Contatos, conversas e ligações PRÓPRIOS do caso, gerados aqui dentro.
    const marcaDoCaso = randomUUID().slice(0, 6);
    const A = { id: randomUUID(), nome: `Cliente da Fila ${marcaDoCaso}`, telefone: `+55619903${QUATRO_DIGITOS}` };
    const B = { id: randomUUID(), telefone: `+55619904${QUATRO_DIGITOS}` };
    const C = { id: randomUUID(), telefone: `+55619905${QUATRO_DIGITOS}` };
    const D = { id: randomUUID(), nome: `Cliente em Ligação ${marcaDoCaso}`, telefone: `+55619906${QUATRO_DIGITOS}` };
    const E = { id: randomUUID(), nome: `Cliente Perdido ${marcaDoCaso}`, telefone: `+55619907${QUATRO_DIGITOS}` };
    const F = { id: randomUUID(), telefone: `+55619908${QUATRO_DIGITOS}` };

    // A — aguardando há 3 min, a mais antiga; a espera esgota em 7 (3 + 7 = os
    // 10 min do time). Com contato e conversa: a conversa como
    // `acharOuCriarConversa` a deixa (aberta, no time, sem dono).
    const contatoA = await criarContato(A.nome, A.telefone);
    const [conversaA] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4) returning id`,
      [orgId, contatoA, NUMERO.id, TIME.id],
    );
    await semearLigacao({
      id: A.id,
      ref: `canal-fila-${SUFIXO}-a`,
      telefone: A.telefone,
      status: "ringing",
      comecouHaS: 200,
      naFilaHaS: 180,
      caiEmS: 420,
      contatoId: contatoA,
      conversaId: conversaA!.id,
    });
    // B — aguardando há 1 min (a segunda), sem contato: a linha mostra o número.
    await semearLigacao({ id: B.id, ref: `canal-fila-${SUFIXO}-b`, telefone: B.telefone, status: "ringing", comecouHaS: 75, naFilaHaS: 60, caiEmS: 540 });
    // C — na fila há 30 s e TOCANDO para a gerente (com alguém tocando não há prazo).
    await semearLigacao({
      id: C.id,
      ref: `canal-fila-${SUFIXO}-c`,
      telefone: C.telefone,
      status: "ringing",
      comecouHaS: 40,
      naFilaHaS: 30,
      tocandoPara: gerente.id,
    });
    // D — em ligação com o atendente, como `ramalAtendeu` deixa: a conversa
    // atribuída a quem atendeu (`claimed`). É também a conversa das "Minhas" dele.
    const contatoD = await criarContato(D.nome, D.telefone);
    const [conversaD] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee,
          team_id, assignee_kind, assigned_to_user_id, assigned_to_user_name, last_message_at, last_message_preview)
       values ($1, $2, $3, 'phone', 'claimed', false, 0, $4, 'user', $5, $6, now(), $7) returning id`,
      [orgId, contatoD, NUMERO.id, TIME.id, atendente.id, atendente.nome, `Ligação em andamento com ${atendente.nome}`],
    );
    await semearLigacao({
      id: D.id,
      ref: `canal-fila-${SUFIXO}-d`,
      telefone: D.telefone,
      status: "connected",
      comecouHaS: 150,
      naFilaHaS: 140,
      atendidaHaS: 120,
      contatoId: contatoD,
      conversaId: conversaD!.id,
      dono: atendente.id,
    });
    // E — perdida há 5 min: esperou 2 min na fila e a espera esgotou.
    const contatoE = await criarContato(E.nome, E.telefone);
    await semearLigacao({
      id: E.id,
      ref: `canal-fila-${SUFIXO}-e`,
      telefone: E.telefone,
      status: "ended",
      comecouHaS: 450,
      naFilaHaS: 420,
      encerradaHaS: 300,
      motivo: "fila_esgotada",
      contatoId: contatoE,
    });
    // F — acabou de chegar e ainda ouve os avisos (`queued_at` nulo): aparece em
    // "No menu" e NÃO conta no selo, que é só de quem espera por uma pessoa.
    await semearLigacao({ id: F.id, ref: `canal-fila-${SUFIXO}-f`, telefone: F.telefone, status: "ringing", comecouHaS: 8 });

    await entrar(page, atendente.email, atendente.senha);
    await page.goto("/app/inbox");

    const trilho = page.getByTestId("inbox-abas");
    const abaTelefone = trilho.getByRole("tab", { name: "Telefone", exact: true });
    const busca = page.getByRole("textbox", { name: "Buscar conversas" });
    const coluna = page.getByTestId("fila-do-telefone");
    const naFila = coluna.locator('[data-secao="na-fila"]');
    const linhasNaFila = naFila.locator("[data-ligacao-id]");
    const linha = (id: string) => coluna.locator(`[data-ligacao-id="${id}"]`);
    /** O selo da posição na linha: "1º", com o nome acessível "Posição 1 na fila". */
    const posicaoNaLinha = (daLinha: Locator, posicao: number) => daLinha.locator(`[aria-label="Posição ${posicao} na fila"]`);
    const chipDoTime = (esperando: number) =>
      page
        .getByTestId("chips-da-fila")
        .getByRole("button", { name: `Filtrar por time: ${TIME.nome} (${esperando} na fila)`, exact: true });

    await test.step("o trilho ganha a aba Telefone, com o selo de quem espera", async () => {
      await expect(trilho).toBeVisible({ timeout: 30_000 });
      await expect(abaTelefone).toBeVisible({ timeout: 30_000 });
      // A, B e C esperam por alguém; D (em ligação) e F (nos avisos) não entram na conta.
      await expect(abaTelefone).toHaveText("3");
      // Controle do "a busca some" de logo abaixo: fora da aba Telefone ela existe.
      await expect(busca).toBeVisible();
    });

    await test.step("a aba lista as ligações por seção, a fila por ordem de chegada, no lugar das conversas", async () => {
      await abaTelefone.click();
      await expect(page).toHaveURL(/[?&]filter=phone\b/);
      await expect(abaTelefone).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Telefone");
      await expect(coluna).toBeVisible({ timeout: 20_000 });

      // NA FILA: a ordem é a de chegada (`queued_at`) — A (3 min), B (1 min), C (30 s).
      await expect(naFila.getByRole("heading", { name: "Na fila, por ordem de chegada" })).toBeVisible();
      await expect(linhasNaFila).toHaveCount(3);
      const ordemDeChegada = [
        { id: A.id, fase: "aguardando" },
        { id: B.id, fase: "aguardando" },
        { id: C.id, fase: "tocando" },
      ];
      for (const [i, esperado] of ordemDeChegada.entries()) {
        await expect(linhasNaFila.nth(i)).toHaveAttribute("data-ligacao-id", esperado.id);
        await expect(linhasNaFila.nth(i)).toHaveAttribute("data-fase", esperado.fase);
        await expect(posicaoNaLinha(linhasNaFila.nth(i), i + 1)).toHaveText(`${i + 1}º`);
      }

      // A primeira: o nome do contato, há quanto espera e em quanto a espera esgota.
      await expect(linha(A.id)).toContainText(A.nome);
      const estadoDeA = linha(A.id).getByTestId("estado-da-ligacao");
      await expect(estadoDeA).toHaveText(/^Aguardando há \d+:\d{2} · cai em \d+:\d{2}$/);
      // 7 min de 10 ainda pela frente: a espera não pesa (vira "atenção" quando resta metade do teto do time ou menos).
      await expect(estadoDeA).toHaveAttribute("data-urgencia", "normal");
      const lido = /^Aguardando há (\d+:\d{2}) · cai em (\d+:\d{2})$/.exec((await estadoDeA.textContent()) ?? "");
      expect(lido, "o estado da 1ª da fila não veio no formato esperado").not.toBeNull();
      const esperou = segundos(lido![1]!);
      const falta = segundos(lido![2]!);
      // Semeada com 3 min de espera e 7 de prazo. A folga de 5 s para baixo cobre
      // o atraso entre a hora lida do banco e o relógio da tela; a de 2 min para
      // cima, o tempo do login e da carga.
      expect(esperou, "a espera da 1ª da fila sai do relógio do banco (semeada com 3 min)").toBeGreaterThanOrEqual(175);
      expect(esperou).toBeLessThan(300);
      expect(falta, "o 'cai em' da 1ª da fila sai do prazo gravado (semeado em 7 min)").toBeLessThanOrEqual(425);
      expect(falta).toBeGreaterThan(300);
      // Os dois números saem do MESMO relógio, no mesmo desenho: somados dão o
      // teto do time (600 s), a menos do segundo que os dois arredondamentos comem.
      expect(esperou + falta, "o que esperou mais o que falta é a espera máxima do time").toBeGreaterThanOrEqual(TIME.esperaMaximaS - 1);
      expect(esperou + falta).toBeLessThanOrEqual(TIME.esperaMaximaS);

      // A terceira toca para alguém: diz para quem, e não tem prazo.
      const estadoDeC = linha(C.id).getByTestId("estado-da-ligacao");
      await expect(estadoDeC).toHaveText(new RegExp(`^Tocando para ${gerente.nome} · na fila há \\d+:\\d{2}$`));
      await expect(estadoDeC).not.toContainText("cai em");

      // NO MENU: quem ainda ouve os avisos.
      const noMenu = coluna.locator('[data-secao="no-menu"] [data-ligacao-id]');
      await expect(noMenu).toHaveCount(1);
      await expect(noMenu).toHaveAttribute("data-ligacao-id", F.id);
      await expect(noMenu).toHaveAttribute("data-fase", "avisos");
      await expect(noMenu.getByTestId("estado-da-ligacao")).toHaveText(/^Ouvindo os avisos · \d+:\d{2}$/);

      // EM LIGAÇÃO: com quem.
      const emLigacao = coluna.locator('[data-secao="em-ligacao"] [data-ligacao-id]');
      await expect(emLigacao).toHaveCount(1);
      await expect(emLigacao).toHaveAttribute("data-ligacao-id", D.id);
      await expect(emLigacao).toHaveAttribute("data-fase", "em_ligacao");
      await expect(emLigacao).toContainText(D.nome);
      await expect(emLigacao.getByTestId("estado-da-ligacao")).toHaveText(new RegExp(`^Com ${atendente.nome} há \\d+:\\d{2}$`));

      // PERDIDAS: o motivo por extenso e quanto esperou (7 min − 5 min = 2:00, os dois instantes do mesmo INSERT).
      const perdidas = coluna.locator('[data-secao="perdidas"] [data-perdida-id]');
      await expect(perdidas).toHaveCount(1);
      await expect(perdidas).toHaveAttribute("data-perdida-id", E.id);
      await expect(perdidas).toHaveAttribute("data-motivo", "fila_esgotada");
      await expect(perdidas).toContainText(E.nome);
      await expect(perdidas).toContainText(/A fila esgotou · esperou 2:00 · há \d+ min/);

      // Os chips contam o mesmo que o selo, e o do time traz o relógio da mais antiga.
      await expect(chipDoTime(3)).toBeVisible();
      await expect(chipDoTime(3).getByTestId("chip-espera")).toHaveText(/^\d+:\d{2}$/);
      // Um número só na organização: não há seletor de número.
      await expect(page.getByTestId("fila-numero")).toHaveCount(0);

      // E a coluna é das LIGAÇÕES: nem a busca, nem os filtros, nem a lista de
      // conversas (a de D está nas "Minhas" dele — o último passo confere).
      await expect(busca).toHaveCount(0);
      await expect(page.getByTestId("inbox-abrir-filtros")).toHaveCount(0);
      await expect(page.locator("[data-conversation-id]")).toHaveCount(0);
    });

    await test.step("nenhuma linha vaza da coluna (medido no elemento)", async () => {
      // O mouse sai de cima do trilho: sem dica de aba nem realce de linha na captura.
      await page.getByTestId("inbox-aba-atual").hover();
      const medidas = await page.evaluate(() => {
        const col = document.querySelector<HTMLElement>('[data-testid="fila-do-telefone"]');
        if (!col) return null;
        const caixa = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { esquerda: r.left, direita: r.right, topo: r.top, largura: r.width, altura: r.height };
        };
        return {
          viewport: { largura: window.innerWidth, altura: window.innerHeight },
          coluna: {
            ...caixa(col),
            scrollWidth: col.scrollWidth,
            clientWidth: col.clientWidth,
            scrollHeight: col.scrollHeight,
            clientHeight: col.clientHeight,
          },
          linhas: Array.from(col.querySelectorAll<HTMLElement>("[data-ligacao-id], [data-perdida-id]")).map((el) => ({
            secao: el.closest<HTMLElement>("[data-secao]")?.dataset.secao ?? null,
            id: el.dataset.ligacaoId ?? el.dataset.perdidaId ?? null,
            fase: el.dataset.fase ?? el.dataset.motivo ?? null,
            ...caixa(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            // Informativo, não afirmado: o que a reticência cortou nesta largura (o nome e a linha de detalhes truncam de propósito).
            cortados: Array.from(el.querySelectorAll<HTMLElement>(".truncate"))
              .filter((s) => s.scrollWidth > s.clientWidth)
              .map((s) => s.textContent ?? ""),
            estado: el.querySelector('[data-testid="estado-da-ligacao"]')?.textContent ?? null,
          })),
        };
      });
      expect(medidas, "a coluna da fila não foi achada para medir").not.toBeNull();
      await anexarJson(testInfo, "medidas", medidas);

      // A coluna não rola para o lado.
      expect(medidas!.coluna.scrollWidth, "a coluna da fila ganhou rolagem horizontal").toBeLessThanOrEqual(medidas!.coluna.clientWidth);
      const daFila = medidas!.linhas.filter((l) => l.secao === "na-fila");
      expect(daFila, "as três linhas da fila entram na medida").toHaveLength(3);
      for (const l of daFila) {
        expect(l.scrollWidth, `o texto da linha ${l.id} (${l.fase}) vaza da linha`).toBeLessThanOrEqual(l.clientWidth);
        expect(l.direita, `a linha ${l.id} (${l.fase}) passa da borda direita da coluna`).toBeLessThanOrEqual(medidas!.coluna.direita + 1);
        expect(l.altura, `a linha ${l.id} (${l.fase}) não tem altura`).toBeGreaterThan(0);
      }
      await anexarCaptura(page, testInfo, "fila-aba-telefone");
    });

    await test.step("clicar na linha abre a conversa dela à direita", async () => {
      await linha(A.id).click();
      // O cabeçalho da conversa é o `h2` com o nome do contato (o título da aba é o outro `h2`, "Telefone").
      await expect(page.getByRole("heading", { level: 2, name: A.nome, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("chat-thread")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText("Conversa de telefone: as ligações ficam registradas aqui. Para falar com o cliente, ligue."),
      ).toBeVisible();
      // A linha fica marcada, e a aba continua sendo a do telefone — a fila não saiu da tela.
      await expect(linha(A.id)).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Telefone");
      await expect(linhasNaFila).toHaveCount(3);
      await page.getByTestId("inbox-aba-atual").hover();
      await anexarCaptura(page, testInfo, "fila-conversa-aberta");
    });

    await test.step("a fila anda: a 1ª sai, a 2ª vira a 1ª e o selo cai para 2 — sem recarregar", async () => {
      // Uma marca na janela: um recarregamento a apagaria. É o que sustenta o "sem recarregar".
      const marca = randomUUID();
      await page.evaluate((m) => {
        (window as unknown as { __paginaDaFila?: string }).__paginaDaFila = m;
      }, marca);

      // O cliente desliga na fila — o UPDATE de `encerrarLigacao`.
      const desde = Date.now();
      const encerradas = await sql<{ id: string }>(
        `update public.voice_calls
            set status = 'ended', ended_at = now(), end_reason = 'cliente_desligou', ringing_user_id = null
          where id = $1 and organization_id = $2 and status <> 'ended'
          returning id`,
        [A.id, orgId],
      );
      expect(encerradas, "o fim encerra UMA ligação: a 1ª da fila").toHaveLength(1);

      // Chega pelo tempo real de `voice_calls` (juntado em até ~2 s) ou, de
      // segurança, pela releitura de 15 s do hook: o teto cobre os dois.
      await expect(naFila.locator(`[data-ligacao-id="${A.id}"]`)).toHaveCount(0, { timeout: 25_000 });
      await anexarJson(testInfo, "tempo-ate-a-fila-andar", {
        demorou_ms: Date.now() - desde,
        como_ler: "até ~5 s: chegou pelo tempo real; perto de 15 s: foi a releitura de segurança do hook",
      });
      await expect(linhasNaFila).toHaveCount(2);
      await expect(linhasNaFila.nth(0)).toHaveAttribute("data-ligacao-id", B.id);
      await expect(posicaoNaLinha(linhasNaFila.nth(0), 1)).toHaveText("1º");
      await expect(linhasNaFila.nth(1)).toHaveAttribute("data-ligacao-id", C.id);
      await expect(posicaoNaLinha(linhasNaFila.nth(1), 2)).toHaveText("2º");
      await expect(abaTelefone).toHaveText("2");
      await expect(chipDoTime(2)).toBeVisible();
      // Quem desligou esperando não some: vira a perdida mais recente, com o motivo.
      const perdidas = coluna.locator('[data-secao="perdidas"] [data-perdida-id]');
      await expect(perdidas).toHaveCount(2);
      await expect(perdidas.nth(0)).toHaveAttribute("data-perdida-id", A.id);
      await expect(perdidas.nth(0)).toHaveAttribute("data-motivo", "desistiu_na_fila");
      await expect(perdidas.nth(0)).toContainText("Desistiu na fila");

      expect(
        await page.evaluate(() => (window as unknown as { __paginaDaFila?: string }).__paginaDaFila),
        "a página foi recarregada no meio do caso — a fila tinha de andar sozinha",
      ).toBe(marca);
      await page.getByTestId("inbox-aba-atual").hover();
      await anexarCaptura(page, testInfo, "fila-depois-de-andar");
    });

    await test.step("controle: fora da aba Telefone a lista de conversas e a busca voltam", async () => {
      // A consulta de fundo da aba Telefone é a das "Minhas": a conversa de D
      // estava carregada o tempo todo, e a aba não a desenhou.
      await trilho.getByRole("tab", { name: "Minhas", exact: true }).click();
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Minhas");
      await expect(busca).toBeVisible();
      await expect(page.locator(`[data-conversation-id="${conversaD!.id}"]`)).toBeVisible({ timeout: 20_000 });
      await expect(coluna).toHaveCount(0);
    });
  });

  test("o gerente escolhe a espera máxima do time em Configurações › Times", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await entrar(page, gerente.email, gerente.senha);

    // Pela porta, como em `times-de-atendimento.spec.ts`.
    await page.goto("/app/settings");
    await page.getByRole("link", { name: /Times de atendimento/i }).click();
    await page.waitForURL(/\/app\/settings\/teams/);
    await expect(page.getByTestId("painel-de-times")).toBeVisible({ timeout: 30_000 });

    const cartao = page.locator(`[data-espera-da-fila="${TIME.id}"]`);
    await expect(cartao).toBeVisible({ timeout: 20_000 });
    await expect(cartao.getByRole("heading", { name: "Fila do telefone" })).toBeVisible();
    const seletor = cartao.getByRole("combobox", { name: "Espera máxima" });
    // O que o banco tem (600 s), e não o padrão do produto.
    await expect(seletor).toHaveText("10 minutos");
    expect(await contarAuditoria("phone.queue_wait_changed", gerente.id)).toBe(0);

    await seletor.click();
    // `exact`: "15 minutos" contém "5 minutos".
    await page.getByRole("option", { name: "5 minutos", exact: true }).click();
    await expect(page.getByText("Espera máxima do telefone salva.")).toBeVisible({ timeout: 20_000 });
    await expect(seletor).toHaveText("5 minutos");

    const [time] = await sql<{ espera: number | null }>(
      "select phone_queue_max_wait_seconds as espera from attendance_teams where id = $1 and organization_id = $2",
      [TIME.id, orgId],
    );
    expect(time?.espera).toBe(300);
    await expect.poll(() => contarAuditoria("phone.queue_wait_changed", gerente.id), { timeout: 10_000 }).toBe(1);

    await cartao.scrollIntoViewIfNeeded();
    await anexarCaptura(page, testInfo, "espera-maxima-do-time");

    // VOLTA DO BANCO: recarrega e o seletor continua em 5 minutos — não era só o estado do React.
    await page.reload();
    await expect(page.getByTestId("painel-de-times")).toBeVisible({ timeout: 30_000 });
    await expect(cartao.getByRole("combobox", { name: "Espera máxima" })).toHaveText("5 minutos", { timeout: 20_000 });
  });

  test("sem número de telefone na organização a aba não existe", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    // Uma SEGUNDA organização, na mesma instalação (com a telefonia oferecida),
    // sem número nenhum: a diferença para o caso 1 é só essa. O mesmo papel de lá.
    const marcaDoCaso = randomUUID().slice(0, 8);
    const semNumero = { email: `fila-sem-numero-${marcaDoCaso}@invariant.test`, senha: `Local-${randomUUID()}!` };
    const usuario = await criarUsuario(semNumero.email, semNumero.senha, "Dora Atendente");
    const outra = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Sem Telefone ${marcaDoCaso}`,
        legal_name: `Provedor Sem Telefone ${marcaDoCaso}`,
        slug: `sem-telefone-${marcaDoCaso}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (outra.error) throw outra.error;
    const vinculo = await db.from("user_organizations").insert({
      organization_id: outra.data.id as string,
      user_id: usuario,
      role: "agent",
      accepted_at: new Date().toISOString(),
    });
    if (vinculo.error) throw vinculo.error;

    await entrar(page, semNumero.email, semNumero.senha);
    // O controle da ausência: a aba só nasce DEPOIS de a rota responder. Sem
    // esperar a resposta, "não há aba" passaria também com a leitura ainda no ar.
    const [resposta] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/telefonia/fila" && r.request().method() === "GET", {
        timeout: 30_000,
      }),
      page.goto("/app/inbox"),
    ]);
    expect(resposta.status()).toBe(200);
    const corpo = (await resposta.json()) as { data: { ativa: boolean } };
    expect(corpo.data.ativa, "organização sem número: a rota da fila tem de dizer `ativa: false`").toBe(false);

    const trilho = page.getByTestId("inbox-abas");
    await expect(trilho.getByRole("tab", { name: "Fila", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(trilho.getByRole("tab", { name: "Telefone", exact: true })).toHaveCount(0);
    await anexarCaptura(page, testInfo, "trilho-sem-telefone");

    // O link guardado: a coluna diz o porquê, e a aba segue fora do trilho.
    await page.goto("/app/inbox?filter=phone");
    await expect(page.getByText("O telefone não está ligado nesta organização.")).toBeVisible({ timeout: 30_000 });
    await expect(trilho.getByRole("tab", { name: "Fila", exact: true })).toBeVisible();
    await expect(trilho.getByRole("tab", { name: "Telefone", exact: true })).toHaveCount(0);
  });

  // ─── agir na fila (entrega 3; migration 0296; J45) ────────────────────────

  test("agir na fila: o gerente tem o mover em quem espera por uma pessoa, o atendente não, e quem ainda ouve os avisos não tem botão", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    await esvaziarAFila();
    await garantirOOutroTime();
    // Três ligações PRÓPRIAS do caso, sem contato (a linha mostra o número): uma
    // que espera, uma que toca para a gerente e uma que ainda ouve os avisos.
    const marcaDoCaso = randomUUID().slice(0, 6);
    const espera = { id: randomUUID(), telefone: `+55619911${QUATRO_DIGITOS}` };
    const toca = { id: randomUUID(), telefone: `+55619912${QUATRO_DIGITOS}` };
    const avisos = { id: randomUUID(), telefone: `+55619913${QUATRO_DIGITOS}` };
    await semearLigacao({
      id: espera.id,
      ref: `canal-acoes-${marcaDoCaso}-espera`,
      telefone: espera.telefone,
      status: "ringing",
      comecouHaS: 75,
      naFilaHaS: 60,
      caiEmS: 240,
    });
    await semearLigacao({
      id: toca.id,
      ref: `canal-acoes-${marcaDoCaso}-toca`,
      telefone: toca.telefone,
      status: "ringing",
      comecouHaS: 40,
      naFilaHaS: 30,
      tocandoPara: gerente.id,
    });
    // `queued_at` nulo: ainda não espera por uma pessoa — é a que NÃO pode ter botão.
    await semearLigacao({ id: avisos.id, ref: `canal-acoes-${marcaDoCaso}-avisos`, telefone: avisos.telefone, status: "ringing", comecouHaS: 8 });

    await test.step("gerente: o mover em quem espera e em quem toca; nada em quem ouve os avisos; sem ramal, nenhum Atender", async () => {
      await entrar(page, gerente.email, gerente.senha);
      const coluna = await abrirAbaTelefone(page);
      const daEspera = linhaInteira(coluna, espera.id);
      const daQueToca = linhaInteira(coluna, toca.id);
      const dosAvisos = linhaInteira(coluna, avisos.id);

      // As três estão na fase em que foram semeadas.
      await expect(daEspera.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "aguardando", { timeout: 20_000 });
      await expect(daQueToca.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "tocando");
      await expect(dosAvisos.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "avisos");

      // A que espera: o botão de mover, dela — um ícone, com o nome por extenso para quem não o vê.
      const moverAQueEspera = daEspera.locator(`[data-fila-mover="${espera.id}"]`);
      await expect(moverAQueEspera).toBeVisible();
      await expect(moverAQueEspera).toHaveAttribute("aria-label", "Mover para outro time");
      await expect(moverAQueEspera).toBeEnabled();

      // A que toca para QUEM OLHA: a linha diz "você", e o mover continua lá
      // (ela se atende pelo aviso de toque; mandá-la a outro time segue valendo).
      await expect(daQueToca.getByTestId("estado-da-ligacao")).toHaveText(/^Tocando para você · na fila há \d+:\d{2}$/);
      await expect(daQueToca.locator(`[data-fila-mover="${toca.id}"]`)).toBeVisible();

      // A que ainda ouve os avisos: nem faixa, nem botão, nem frase de ordem.
      await expect(dosAvisos.locator("[data-fila-acoes], [data-fila-ordem], [data-fila-atender], [data-fila-mover]")).toHaveCount(0);

      // "ATENDER" NÃO É PROVADO AQUI — só a ausência dele neste estado. O botão é
      // de quem tem ramal neste navegador, e a rota do ramal só entrega a
      // credencial depois de gravá-la no Asterisk: no CI nada escuta a ARI, então
      // o botão em si fica para a prova com ligação real (runbook, §3).
      const ramal = await ramalDesteNavegador(page);
      expect(ramal.ativo, `a rota do ramal entregou uma credencial (HTTP ${ramal.status}): este caso mede a fila SEM ramal no navegador`).toBe(false);
      await expect(coluna.locator("[data-fila-atender]")).toHaveCount(0);

      // O menu de mover lista os OUTROS times ativos — o time em que a ligação já
      // está não é destino. Só abre e fecha: escolher um time manda a ordem ao
      // worker pela ARI, que aqui não existe.
      await moverAQueEspera.click();
      const destino = page.locator(`[data-fila-mover-para="${OUTRO_TIME.id}"]`);
      await expect(destino).toBeVisible();
      await expect(destino).toContainText(OUTRO_TIME.nome);
      await expect(page.locator(`[data-fila-mover-para="${TIME.id}"]`)).toHaveCount(0);
      await anexarCaptura(page, testInfo, "fila-menu-de-mover");
      await page.keyboard.press("Escape");
      await expect(destino).toHaveCount(0);

      // Medido no elemento: a faixa das ações fica EMBAIXO do texto (não ao lado,
      // espremendo-o), a linha cresce em vez de vazar, e a coluna não rola para o lado.
      await page.getByTestId("inbox-aba-atual").hover();
      const medidas = await medirLinhasDaFila(page, { espera: espera.id, toca: toca.id, avisos: avisos.id });
      expect(medidas, "a coluna da fila não foi achada para medir").not.toBeNull();
      await anexarJson(testInfo, "medidas-das-acoes", medidas);
      const { coluna: caixaDaColuna, linhas } = medidas!;
      const comAcoes = linhas.espera;
      const semAcoes = linhas.avisos;
      expect(comAcoes?.corpo && comAcoes.faixa && comAcoes.mover, "a linha que espera não tem a área principal, a faixa ou o botão para medir").toBeTruthy();
      expect(semAcoes, "a linha de quem ouve os avisos não foi achada para medir").toBeTruthy();
      expect(semAcoes!.faixa, "a linha de quem ouve os avisos ganhou uma faixa de ações").toBeNull();
      expect(caixaDaColuna.scrollWidth, "a coluna da fila ganhou rolagem horizontal com os botões").toBeLessThanOrEqual(caixaDaColuna.clientWidth);
      expect(comAcoes!.scrollWidth, "a linha com ações vaza para o lado").toBeLessThanOrEqual(comAcoes!.clientWidth);
      expect(comAcoes!.faixa!.topo, "a faixa das ações não está embaixo do texto da linha").toBeGreaterThanOrEqual(comAcoes!.corpo!.base - 1);
      expect(comAcoes!.faixa!.direita, "a faixa das ações passa da borda direita da coluna").toBeLessThanOrEqual(caixaDaColuna.direita + 1);
      expect(comAcoes!.mover!.esquerda, "o botão de mover começa antes da coluna").toBeGreaterThanOrEqual(caixaDaColuna.esquerda - 1);
      expect(comAcoes!.mover!.direita, "o botão de mover passa da borda direita da coluna").toBeLessThanOrEqual(caixaDaColuna.direita + 1);
      expect(comAcoes!.altura, "a linha com ações deveria ser mais alta que a sem ações (a faixa entra embaixo)").toBeGreaterThan(semAcoes!.altura);
      await anexarCaptura(page, testInfo, "fila-acoes-gerente");
    });

    await test.step("atendente: a mesma fila, a mesma ligação esperando — sem o botão de mover", async () => {
      // Outro navegador, com a gerente ainda logada no primeiro: as duas telas leem a MESMA fila.
      const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await contexto.newPage();
      try {
        await entrar(p, atendente.email, atendente.senha);
        const coluna = await abrirAbaTelefone(p);
        // A mesma ligação, na mesma fase em que a gerente tinha o botão — é o controle da ausência.
        await expect(linhaInteira(coluna, espera.id).locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "aguardando", {
          timeout: 20_000,
        });
        // E para ele a que toca para a gerente tem o NOME dela, não "você".
        await expect(linhaInteira(coluna, toca.id).getByTestId("estado-da-ligacao")).toHaveText(
          new RegExp(`^Tocando para ${gerente.nome} · na fila há \\d+:\\d{2}$`),
        );

        // Mover é de gerente e admin: para o atendente, em linha nenhuma.
        await expect(coluna.locator("[data-fila-mover]")).toHaveCount(0);
        // E, sem ramal neste navegador (o mesmo estado do passo de cima), também
        // não há "Atender": a linha fica sem faixa nenhuma.
        const ramal = await ramalDesteNavegador(p);
        expect(ramal.ativo, `a rota do ramal entregou uma credencial (HTTP ${ramal.status}): este caso mede a fila SEM ramal no navegador`).toBe(false);
        await expect(coluna.locator("[data-fila-atender]")).toHaveCount(0);
        await expect(coluna.locator("[data-fila-acoes]")).toHaveCount(0);
        await p.getByTestId("inbox-aba-atual").hover();
        await anexarCaptura(p, testInfo, "fila-acoes-atendente");
      } finally {
        await contexto.close();
      }
    });
  });

  test("com uma ordem aberta a linha diz quem está cuidando, no lugar dos botões — e eles voltam quando a ordem acaba", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await esvaziarAFila();
    await garantirOOutroTime();
    // Três ligações esperando na MESMA fase e no MESMO time: uma com alguém
    // pedindo para atender, uma sendo movida e uma em que ninguém pediu nada (o controle).
    const marcaDoCaso = randomUUID().slice(0, 6);
    const puxada = { id: randomUUID(), telefone: `+55619914${QUATRO_DIGITOS}` };
    const movida = { id: randomUUID(), telefone: `+55619915${QUATRO_DIGITOS}` };
    const livre = { id: randomUUID(), telefone: `+55619916${QUATRO_DIGITOS}` };
    for (const [i, l] of [puxada, movida, livre].entries()) {
      await semearLigacao({
        id: l.id,
        ref: `canal-ordem-${marcaDoCaso}-${i}`,
        telefone: l.telefone,
        status: "ringing",
        comecouHaS: 100 - i * 20,
        naFilaHaS: 90 - i * 20,
        caiEmS: 200,
      });
    }
    const ordemDeAtender = await semearOrdemAberta({ ligacaoId: puxada.id, tipo: "pull", quemPediu: atendente.id });
    await semearOrdemAberta({ ligacaoId: movida.id, tipo: "move", quemPediu: gerente.id, paraOTime: OUTRO_TIME.id });

    await entrar(page, gerente.email, gerente.senha);
    const coluna = await abrirAbaTelefone(page);
    const daPuxada = linhaInteira(coluna, puxada.id);
    const daMovida = linhaInteira(coluna, movida.id);
    const daLivre = linhaInteira(coluna, livre.id);
    const ordemNaPuxada = daPuxada.locator("[data-fila-ordem]");
    const ordemNaMovida = daMovida.locator("[data-fila-ordem]");
    const botoes = "[data-fila-acoes], [data-fila-atender], [data-fila-mover]";

    await test.step("a ordem aberta troca os botões pela frase de quem está cuidando", async () => {
      // Alguém pediu para ATENDER: o nome de quem pediu, pela régua de nome da fila.
      await expect(ordemNaPuxada).toHaveAttribute("data-fila-ordem", "pull", { timeout: 20_000 });
      await expect(ordemNaPuxada).toHaveText(`${atendente.nome} está atendendo…`);
      await expect(daPuxada.locator(botoes)).toHaveCount(0);
      // A ordem não mexe na ligação: ela segue esperando, na fila.
      await expect(daPuxada.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "aguardando");

      // Alguém pediu para MOVER: o nome do time de destino.
      await expect(ordemNaMovida).toHaveAttribute("data-fila-ordem", "move");
      await expect(ordemNaMovida).toHaveText(`Movendo para ${OUTRO_TIME.nome}…`);
      await expect(daMovida.locator(botoes)).toHaveCount(0);

      // CONTROLE: a ligação em que ninguém pediu nada tem o botão — a mesma
      // pessoa olhando, a mesma fase, o mesmo time. A diferença é só a ordem.
      await expect(daLivre.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "aguardando");
      await expect(daLivre.locator(`[data-fila-mover="${livre.id}"]`)).toBeVisible();
      await expect(daLivre.locator("[data-fila-ordem]")).toHaveCount(0);
    });

    await test.step("a frase fica embaixo do texto da linha e não faz a coluna rolar para o lado (medido no elemento)", async () => {
      await page.getByTestId("inbox-aba-atual").hover();
      const medidas = await medirLinhasDaFila(page, { puxada: puxada.id, movida: movida.id, livre: livre.id });
      expect(medidas, "a coluna da fila não foi achada para medir").not.toBeNull();
      await anexarJson(testInfo, "medidas-da-ordem-aberta", medidas);
      const { coluna: caixaDaColuna, linhas } = medidas!;
      expect(caixaDaColuna.scrollWidth, "a coluna da fila ganhou rolagem horizontal com a frase da ordem").toBeLessThanOrEqual(caixaDaColuna.clientWidth);
      for (const nome of ["puxada", "movida"] as const) {
        const l = linhas[nome];
        expect(l?.corpo && l.faixa, `a linha "${nome}" não tem a área principal ou a faixa para medir`).toBeTruthy();
        expect(l!.scrollWidth, `a linha "${nome}" vaza para o lado`).toBeLessThanOrEqual(l!.clientWidth);
        expect(l!.faixa!.topo, `a frase da ordem da linha "${nome}" não está embaixo do texto`).toBeGreaterThanOrEqual(l!.corpo!.base - 1);
        expect(l!.faixa!.direita, `a frase da ordem da linha "${nome}" passa da borda direita da coluna`).toBeLessThanOrEqual(caixaDaColuna.direita + 1);
      }
      await anexarCaptura(page, testInfo, "fila-ordem-aberta");
    });

    await test.step("a ordem acaba sem a ligação mudar de mãos: os botões voltam, sem recarregar", async () => {
      // Uma marca na janela: um recarregamento a apagaria. É o que sustenta o "sem recarregar".
      const marca = randomUUID();
      await page.evaluate((m) => {
        (window as unknown as { __paginaDaOrdem?: string }).__paginaDaOrdem = m;
      }, marca);

      // Quem pediu para atender não atendeu a tempo: o worker fecha a ordem
      // (`encerrarOrdemDaFila`, `no_answer`) e limpa o "tocando" da ligação
      // (`marcarTocando`). A ordem vai primeiro: é a escrita em `voice_calls` que
      // avisa a aba pelo tempo real, e a releitura que ela dispara já tem de
      // achar a ordem fechada.
      const fechadas = await sql<{ id: string }>(
        `update public.voice_call_queue_orders
            set status = 'ended', outcome = 'no_answer', reason = null, ended_at = now()
          where id = $1 and organization_id = $2 and status = 'open'
          returning id`,
        [ordemDeAtender, orgId],
      );
      expect(fechadas, "o fim fecha UMA ordem: a de atender").toHaveLength(1);
      await sql(
        `update public.voice_calls set status = 'ringing', ringing_user_id = null, updated_at = now()
          where id = $1 and organization_id = $2 and status <> 'ended'`,
        [puxada.id, orgId],
      );

      // Pelo tempo real de `voice_calls` ou, de segurança, pela releitura de 15 s do hook.
      await expect(ordemNaPuxada).toHaveCount(0, { timeout: 25_000 });
      await expect(daPuxada.locator(`[data-fila-mover="${puxada.id}"]`)).toBeVisible();
      await expect(daPuxada.locator("[data-ligacao-id]")).toHaveAttribute("data-fase", "aguardando");
      // Só a linha da ordem que acabou mudou: a outra segue sendo movida.
      await expect(ordemNaMovida).toHaveText(`Movendo para ${OUTRO_TIME.nome}…`);
      expect(
        await page.evaluate(() => (window as unknown as { __paginaDaOrdem?: string }).__paginaDaOrdem),
        "a página foi recarregada no meio do caso — os botões tinham de voltar sozinhos",
      ).toBe(marca);
      await page.getByTestId("inbox-aba-atual").hover();
      await anexarCaptura(page, testInfo, "fila-ordem-encerrada");
    });
  });

  test("o cartão da ligação conta quem a moveu de time e quem a puxou da fila", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await garantirOOutroTime();
    // Contato, conversa e ligações PRÓPRIOS do caso. A conversa como a ligação
    // atendida a deixa: no time, com quem atendeu.
    const marcaDoCaso = randomUUID().slice(0, 6);
    const telefone = `+55619917${QUATRO_DIGITOS}`;
    const contato = await criarContato(`Cliente Puxado da Fila ${marcaDoCaso}`, telefone);
    const [conversa] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee,
          team_id, assignee_kind, assigned_to_user_id, assigned_to_user_name)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4, 'user', $5, $6) returning id`,
      [orgId, contato, NUMERO.id, TIME.id, atendente.id, atendente.nome],
    );

    // Duas recebidas ATENDIDAS e já encerradas, de 65 s cada: a `comum`, em que
    // ninguém agiu na fila (o controle), e a `agida` — que caiu no time errado,
    // a gerente moveu para o time certo, e o atendente puxou para si.
    const comum = randomUUID();
    const agida = randomUUID();
    for (const [i, id] of [comum, agida].entries()) {
      await semearLigacao({
        id,
        ref: `canal-cartao-${marcaDoCaso}-${i}`,
        telefone,
        status: "ended",
        comecouHaS: 600 - i * 300,
        naFilaHaS: 590 - i * 300,
        atendidaHaS: 560 - i * 300,
        encerradaHaS: 495 - i * 300,
        motivo: "cliente_desligou",
        contatoId: contato,
        conversaId: conversa!.id,
        dono: atendente.id,
      });
    }
    // O registro da ligação na conversa, como `registrarNaConversa` o grava no
    // fim: `fila` só entra quando houve ordem que ACONTECEU (`done`), na ordem em
    // que foram pedidas, com os nomes daquela hora. Semeado: que o worker o
    // escreva assim está em `tests/invariants/telefonia-ordens-da-fila-repositorio.test.ts`.
    const oQueSeFezNaFila = [
      { tipo: "move", por_nome: gerente.nome, de_time: OUTRO_TIME.nome, para_time: TIME.nome },
      { tipo: "pull", por_nome: atendente.nome, de_time: TIME.nome, para_time: null },
    ];
    for (const [id, fila] of [
      [comum, null],
      [agida, oQueSeFezNaFila],
    ] as const) {
      await sql(
        `insert into public.messages
           (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body,
            sent_via, status, metadata)
         values ($1, $2, $3, $4, $5, 'outbound', 'system', $6, 'system', 'sent', $7)`,
        [
          orgId,
          conversa!.id,
          contato,
          NUMERO.id,
          `ligacao:${id}`,
          `Ligação recebida, atendida por ${atendente.nome} · 1 min 05 s`,
          JSON.stringify({
            voice_call: {
              id,
              direcao: "inbound",
              desfecho: "atendida",
              duracao_ms: 65_000,
              atendente_id: atendente.id,
              atendente_nome: atendente.nome,
              motivo: "cliente_desligou",
              menu: null,
              ouviu_aviso: false,
              ...(fila ? { fila } : {}),
            },
          }),
        ],
      );
    }

    await entrar(page, atendente.email, atendente.senha);
    await page.goto(`/app/inbox/${conversa!.id}`);
    const cartoes = page.locator('[data-ligacao="atendida"]');
    await expect(cartoes).toHaveCount(2, { timeout: 30_000 });

    // Só o cartão da ligação em que se agiu tem a lista — o outro é o de sempre.
    const comFila = cartoes.filter({ has: page.locator("[data-ligacao-fila]") });
    await expect(comFila).toHaveCount(1);
    await expect(page.locator("[data-ligacao-fila]")).toHaveCount(1);
    await expect(comFila.locator("[data-ligacao-titulo]")).toHaveText("Ligação recebida");
    await expect(comFila).toContainText(`atendida por ${atendente.nome}`);

    // Uma linha por ação, na ordem em que aconteceram: primeiro movida, depois puxada.
    const acoes = comFila.locator("[data-ligacao-fila] > li");
    await expect(acoes).toHaveCount(2);
    await expect(acoes.nth(0)).toHaveAttribute("data-ligacao-acao-na-fila", "move");
    await expect(acoes.nth(0)).toHaveText(`Movida de ${OUTRO_TIME.nome} para ${TIME.nome} por ${gerente.nome}`);
    await expect(acoes.nth(1)).toHaveAttribute("data-ligacao-acao-na-fila", "pull");
    await expect(acoes.nth(1)).toHaveText(`Puxada da fila por ${atendente.nome}`);
    // Não houve transferência: a corrente de transferências não aparece.
    await expect(comFila.locator("[data-ligacao-transferencias]")).toHaveCount(0);

    // Medido no elemento: as linhas ficam embaixo do selo, dentro do chat.
    const medidas = await comFila.evaluate((cartao) => {
      const caixa = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { esquerda: r.left, direita: r.right, topo: r.top, base: r.bottom, largura: r.width, altura: r.height };
      };
      const chat = cartao.closest('[data-testid="chat-thread"]');
      const titulo = cartao.querySelector("[data-ligacao-titulo]");
      const lista = cartao.querySelector("[data-ligacao-fila]");
      if (!chat || !titulo || !lista) return null;
      return {
        viewport: { largura: window.innerWidth, altura: window.innerHeight },
        chat: caixa(chat),
        cartao: caixa(cartao),
        titulo: caixa(titulo),
        lista: caixa(lista),
        linhas: Array.from(lista.querySelectorAll<HTMLElement>("li")).map((li) => ({
          texto: li.textContent ?? "",
          ...caixa(li),
          scrollWidth: li.scrollWidth,
          clientWidth: li.clientWidth,
        })),
      };
    });
    expect(medidas, "o cartão, o selo ou a lista da fila não foram achados para medir").not.toBeNull();
    await anexarJson(testInfo, "medidas-do-cartao-da-fila", medidas);
    expect(medidas!.lista.topo, "as linhas da fila não estão embaixo do selo da ligação").toBeGreaterThanOrEqual(medidas!.titulo.base - 1);
    expect(medidas!.linhas, "as duas linhas da fila entram na medida").toHaveLength(2);
    for (const l of medidas!.linhas) {
      expect(l.esquerda, `"${l.texto}" começa antes do chat`).toBeGreaterThanOrEqual(medidas!.chat.esquerda - 1);
      expect(l.direita, `"${l.texto}" passa da borda direita do chat`).toBeLessThanOrEqual(medidas!.chat.direita + 1);
      expect(l.scrollWidth, `"${l.texto}" vaza da própria linha`).toBeLessThanOrEqual(l.clientWidth);
      expect(l.altura, `"${l.texto}" não tem altura`).toBeGreaterThan(0);
    }
    await anexarCaptura(page, testInfo, "cartao-acoes-na-fila");
  });
});
