/**
 * [P0] URA E FALAS DO TELEFONE PELA TELA — a versão 1 da fase 2 (DYD-10).
 *
 * Desenho: docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md (§6 e §10).
 *
 * O que só a tela prova, e esta spec mede:
 *  1. a chave da ElevenLabs entra por Credenciais de IA, validada — a recusada
 *     volta ao lado do campo ("recusou a chave"), e a chave NUNCA vai numa URL,
 *     nem do navegador para o CRM, nem do CRM para a ElevenLabs;
 *  2. a voz sai de uma lista vinda da conta, e "Gerar prévia" produz um áudio que
 *     o NAVEGADOR toca (duração ~1 s, medida no <audio>, não a olho) SEM mudar
 *     nada nas ligações: a linha de `phone_prompts` só nasce no "Salvar e usar", e
 *     a mesma prévia de novo não chama a ElevenLabs (D15 — contado no receptor falso);
 *  3. o menu nasce das opções ("Para X, digite 1. Para Y, digite 2.") e só salva
 *     com a prévia da fala;
 *  4. o número passa a tocar o menu — e o banco guarda só o menu, nunca os dois;
 *  5. o aviso de instabilidade só liga depois de "Gerar prévia" E "Ouvir" (§6.3),
 *     com a duração escolhida chegando ao banco; a faixa aparece no topo, em
 *     outra tela, para o ATENDENTE (sem o botão) e some sem recarregar quando o
 *     gerente desliga;
 *  6. COM A FAIXA À VISTA (Task 21), medido por `getBoundingClientRect`: ao rolar
 *     uma página longa, a TopBar gruda logo abaixo das faixas, sem sobreposição;
 *     e na Inbox o composer inteiro fica dentro da janela, sem a página rolar pela
 *     altura da faixa.
 *
 * ORGANIZAÇÃO PRÓPRIA, e não a compartilhada do seed: admin e atendente nascem
 * aqui, sem MFA (a política padrão não exige), como em
 * `aviso-de-mensagem-diz-de-quem-e.spec.ts` e `inbox-protocolo-e-historico.spec.ts`.
 * Nada do que esta spec liga (chave de voz, menu, aviso no topo de TODA tela da
 * organização) pode vazar para as specs vizinhas da mesma parte do CI, e nada
 * do que elas deixam pode mudar o que esta mede.
 *
 * ElevenLabs FALSA: um servidor HTTP que a própria spec sobe na porta de
 * ELEVENLABS_API_BASE_URL (.env.e2e), respondendo como o cliente real espera
 * (`lib/telefonia/elevenlabs.ts`): `GET /v1/voices` e
 * `POST /v1/text-to-speech/:voz?output_format=ulaw_8000` com μ-law cru, chave
 * no header `xi-api-key`. A telefonia é "oferecida" pela PRESENÇA de
 * TELEFONIA_ARI_URL/_PASSWORD no .env.e2e — nada escuta aquela porta, de
 * propósito: esta spec prova a TELA; a ligação de verdade é provada na VPS
 * (plano da fase 2, Task 29).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as http from "node:http";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import { AMOSTRAS_POR_SEGUNDO, pcm16ParaUlaw } from "../../lib/telefonia/ulaw";
import { MODELO_DE_VOZ_PADRAO } from "../../lib/telefonia/vocabulario";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = ".superpowers/evidence/telefonia";

/** Único por execução: o banco de e2e local é reaproveitado entre rodadas. */
const SUFIXO = randomUUID().slice(0, 8);
const QUATRO_DIGITOS = String(1000 + Math.floor(Math.random() * 9000));
const CHAVE_VALIDA = `e2e-chave-elevenlabs-valida-${SUFIXO}-0001`;
const CHAVE_ERRADA = `e2e-chave-elevenlabs-errada-${SUFIXO}-9999`;
const VOZ = { voice_id: "voz-e2e-1", name: "Ana E2E", category: "premade", preview_url: null };
const TIME_A = { id: randomUUID(), nome: `Suporte URA ${SUFIXO}` };
const TIME_B = { id: randomUUID(), nome: `Financeiro URA ${SUFIXO}` };
const NUMERO = { id: randomUUID(), nome: `Número URA ${SUFIXO}`, e164: `+55613000${QUATRO_DIGITOS}` };
const MENU_NOME = `Menu E2E ${SUFIXO}`;

/** A janela da prova: a mesma das specs vizinhas que medem layout. */
const JANELA = { width: 1440, height: 900 };
/** Baixa de propósito: a página tem de rolar mais que faixa + TopBar para a medida valer. */
const JANELA_BAIXA = { width: 1440, height: 600 };
/** `h-14` da TopBar (components/shell/TopBar.tsx). */
const ALTURA_DA_TOPBAR = 56;
/** Arredondamento de subpixel entre caixas vizinhas. */
const TOLERANCIA = 1;

test.use({ viewport: JANELA });

interface Pedido {
  metodo: string;
  caminho: string;
  consulta: string;
  url: string;
  chave: string | undefined;
  corpo: string;
}
/** Tudo que chegou à ElevenLabs falsa, na ordem. */
const pedidos: Pedido[] = [];
/** O que chegou fora do contrato do cliente — diagnóstico de base URL ou caminho errado. */
const foraDoContrato: string[] = [];
const sinteses = () => pedidos.filter((p) => p.metodo === "POST" && p.caminho.startsWith("/v1/text-to-speech/"));

/**
 * O endereço da ElevenLabs falsa, lido da MESMA variável que o servidor sob teste
 * lê (`webServer.env` e este processo recebem o `.env.e2e` inteiro).
 */
function enderecoDaElevenLabsFalsa(): { host: string; porta: number } {
  const bruto = process.env.ELEVENLABS_API_BASE_URL ?? "";
  if (!bruto) {
    throw new Error(
      "ELEVENLABS_API_BASE_URL ausente do .env.e2e — rode `pnpm e2e:env` de novo. Sem ela a prévia chamaria a ElevenLabs DE VERDADE.",
    );
  }
  if (!(process.env.TELEFONIA_ARI_URL ?? "").trim() || !(process.env.TELEFONIA_ARI_PASSWORD ?? "").trim()) {
    throw new Error(
      "TELEFONIA_ARI_URL/TELEFONIA_ARI_PASSWORD ausentes do .env.e2e — sem elas a instalação não oferece telefonia e as abas do Telefone mostram 'desligada'.",
    );
  }
  const url = new URL(bruto);
  expect(["127.0.0.1", "localhost"], "a ElevenLabs falsa tem de ser local").toContain(url.hostname);
  // As portas vizinhas do .env.e2e: WAHA (3999), Upstash (3998), Jev (3997) e ARI (3995).
  expect(["3995", "3997", "3998", "3999"], "a porta da ElevenLabs falsa é só dela").not.toContain(url.port);
  // O cliente acrescenta `/v1/...` à base: com caminho na base, tudo cairia em `foraDoContrato`.
  expect(url.pathname.replace(/\/+$/, ""), "a base da ElevenLabs falsa não pode ter caminho").toBe("");
  return { host: url.hostname, porta: Number(url.port) };
}

/**
 * Um segundo de fala em μ-law 8 kHz — um tom de 440 Hz codificado por
 * `pcm16ParaUlaw`, o mesmo codec que a tela usa para tocar. Cru, sem WAV: é o que
 * a ElevenLabs devolve em `ulaw_8000`, e o que `sintetizar` aceita.
 */
function umSegundoDeFala(): Buffer {
  const bytes = Buffer.alloc(AMOSTRAS_POR_SEGUNDO);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = pcm16ParaUlaw(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / AMOSTRAS_POR_SEGUNDO)));
  }
  return bytes;
}

function elevenLabsFalsa(): http.Server {
  const audio = umSegundoDeFala();
  return http.createServer((req, res) => {
    const pedacos: Buffer[] = [];
    req.on("data", (p: Buffer) => pedacos.push(p));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://elevenlabs.falsa");
      const chave = req.headers["xi-api-key"];
      const pedido: Pedido = {
        metodo: req.method ?? "",
        caminho: url.pathname,
        consulta: url.search,
        url: req.url ?? "",
        chave: typeof chave === "string" ? chave : undefined,
        corpo: Buffer.concat(pedacos).toString("utf8"),
      };
      pedidos.push(pedido);
      const json = (status: number, corpo: unknown) => {
        const texto = JSON.stringify(corpo);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(texto) }).end(texto);
      };
      if (pedido.chave !== CHAVE_VALIDA) {
        // O corpo de erro da ElevenLabs para chave recusada; o cliente lê o HTTP 401.
        json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
        return;
      }
      if (pedido.metodo === "GET" && pedido.caminho === "/v1/voices") {
        json(200, { voices: [VOZ] });
        return;
      }
      if (
        pedido.metodo === "POST" &&
        pedido.caminho === `/v1/text-to-speech/${VOZ.voice_id}` &&
        url.searchParams.get("output_format") === "ulaw_8000"
      ) {
        res.writeHead(200, { "Content-Type": "audio/basic", "Content-Length": audio.length }).end(audio);
        return;
      }
      foraDoContrato.push(`${pedido.metodo} ${pedido.url}`);
      json(404, { detail: { status: "not_found" } });
    });
  });
}

let pool: Pool | undefined;
let servidor: http.Server | undefined;
let orgId = "";
let conversaId = "";
const admin = { email: `ura-admin-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };
const atendente = { email: `ura-atendente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error("o pool do banco não subiu — o beforeAll falhou antes");
  return (await pool.query<T>(texto, valores)).rows;
}

async function contagem(texto: string, valores: unknown[]): Promise<number> {
  const [linha] = await sql<{ n: number }>(texto, valores);
  return linha?.n ?? 0;
}

async function inserir(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw error;
  return data.id as string;
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

interface Caixa {
  top: number;
  bottom: number;
  height: number;
}

/** O topo de /app medido na página: as faixas, o aviso dentro delas, a TopBar e a rolagem. */
async function medirOTopo(page: Page) {
  return page.evaluate(() => {
    const caixa = (el: Element | null | undefined): Caixa | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    // A TopBar é o <header> irmão do <main> da casca (app/app/_components/AppShell.tsx).
    const principal = Array.from(document.querySelectorAll("main")).find((m) => m.previousElementSibling?.tagName === "HEADER");
    const topBar = principal?.previousElementSibling ?? null;
    return {
      faixas: caixa(document.querySelector("[data-faixas-do-topo]")),
      aviso: caixa(document.querySelector("[data-faixa-aviso-de-instabilidade]")),
      topBar: caixa(topBar),
      posicaoDaTopBar: topBar ? getComputedStyle(topBar).position : null,
      alturaPublicada: getComputedStyle(document.documentElement).getPropertyValue("--altura-das-faixas").trim(),
      rolagem: window.scrollY,
      janela: window.innerHeight,
      alturaDaPagina: document.documentElement.scrollHeight,
    };
  });
}

test.describe("telefonia — URA e falas pela tela", () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    mkdirSync(EVIDENCIA, { recursive: true });
    const { host, porta } = enderecoDaElevenLabsFalsa();
    if (!credenciais.dbUrl) throw new Error("SUPABASE_DB_URL ausente — rode `pnpm e2e:env` de novo.");
    pool = new Pool({ connectionString: credenciais.dbUrl, max: 2 });

    admin.id = await criarUsuario(admin.email, admin.senha, "Ana Gestora");
    atendente.id = await criarUsuario(atendente.email, atendente.senha, "Bruno Atendente");
    orgId = await inserir("organizations", {
      display_name: `Provedor URA ${SUFIXO}`,
      legal_name: `Provedor URA ${SUFIXO}`,
      slug: `ura-${SUFIXO}`,
      onboarded_at: new Date().toISOString(),
    });
    for (const [usuario, papel] of [
      [admin.id, "admin"],
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

    // Times por SQL: `attendance_teams` só aceita escrita pela RPC de gestor com
    // MFA (GRANT só de SELECT até para o service role) — o cadastro de times tem
    // spec própria; aqui o que se mede é a URA.
    await sql(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $3, $4, $5), ($2, $3, $6, $7)`, [
      TIME_A.id,
      TIME_B.id,
      orgId,
      TIME_A.nome,
      `suporte-ura-${SUFIXO}`,
      TIME_B.nome,
      `financeiro-ura-${SUFIXO}`,
    ]);
    await sql(`insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`, [
      orgId,
      TIME_A.id,
      atendente.id,
    ]);

    // Uma conversa de WhatsApp do atendente: é a Inbox dele que mede o composer
    // com a faixa à vista.
    const canal = await inserir("channel_sessions", {
      organization_id: orgId,
      waha_session_name: `ura-${SUFIXO}`,
      display_name: "WhatsApp do provedor",
      phone_number: `+55613001${QUATRO_DIGITOS}`,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const contato = await inserir("contacts", {
      organization_id: orgId,
      display_name: "Cliente da URA",
      phone_number: `+55619900${QUATRO_DIGITOS}`,
    });
    conversaId = await inserir("conversations", {
      organization_id: orgId,
      contact_id: contato,
      channel_session_id: canal,
      status: "open",
      team_id: TIME_A.id,
      assignee_kind: "user",
      assigned_to_user_id: atendente.id,
      assigned_to_user_name: "Bruno Atendente",
    });

    // O número da operadora, tocando no time A (o estado da fase 1). A senha não
    // importa: nada escuta o ARI, e editar o destino não troca a conta.
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', $4, $5,
               'voip.e2e-ura.com.br', 5060, 'udp', $6, decode('00', 'hex'), $7)`,
      [NUMERO.id, orgId, CHANNEL_PROVIDER_SIP_TRUNK, NUMERO.nome, NUMERO.e164, `ura${SUFIXO}`, TIME_A.id],
    );

    const s = elevenLabsFalsa();
    await new Promise<void>((ok, falhou) => {
      s.once("error", falhou);
      s.listen(porta, host, () => ok());
    });
    servidor = s;
  });

  test.afterAll(async () => {
    const s = servidor;
    servidor = undefined;
    if (s?.listening) {
      s.closeAllConnections();
      await new Promise<void>((ok) => s.close(() => ok()));
    }
    if (!pool) return;
    try {
      if (orgId) {
        // A organização é só desta spec e fica para quem quiser olhar depois; o
        // que se desliga é o que teria efeito: o aviso no topo e o número.
        await sql(
          `update public.attendance_teams
              set phone_emergency_active_since = null, phone_emergency_expires_at = null, phone_emergency_activated_by = null
            where organization_id = $1`,
          [orgId],
        );
        await sql(`update public.channel_sessions set archived_at = now() where id = $1 and organization_id = $2`, [NUMERO.id, orgId]);
      }
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  test("o admin monta a URA pela tela e liga o aviso; o atendente vê a faixa; as faixas não cobrem a TopBar nem o composer", async ({
    page,
    browser,
  }) => {
    test.setTimeout(360_000);
    // Toda URL que o NAVEGADOR pede: a chave colada não pode aparecer em nenhuma.
    const urlsDoNavegador: string[] = [];
    page.on("request", (r) => urlsDoNavegador.push(r.url()));

    await entrar(page, admin.email, admin.senha);

    await test.step("a chave da ElevenLabs: a errada é recusada ao lado do campo, a certa é guardada", async () => {
      await page.goto("/app/ai/credentials");
      const cartao = page.locator("[data-cartao-elevenlabs]");
      await expect(cartao, "o cartão só aparece onde a instalação oferece telefonia").toBeVisible({ timeout: 20_000 });
      await expect(cartao.locator("[data-estado-da-chave]")).toHaveAttribute("data-estado-da-chave", "nao_cadastrada");

      await cartao.locator("#chave-elevenlabs").fill(CHAVE_ERRADA);
      await cartao.getByRole("button", { name: "Salvar chave" }).click();
      await expect(cartao.getByRole("alert")).toContainText("recusou a chave", { timeout: 20_000 });
      await expect(cartao.locator("[data-chave-de-voz-last4]"), "a chave recusada não é guardada").toHaveCount(0);

      await cartao.locator("#chave-elevenlabs").fill(CHAVE_VALIDA);
      await cartao.getByRole("button", { name: "Salvar chave" }).click();
      await expect(cartao.locator("[data-chave-de-voz-last4]")).toHaveText("…0001", { timeout: 20_000 });
      await expect(cartao.locator("[data-estado-da-chave]")).toHaveAttribute("data-estado-da-chave", "validada");

      // As duas validações chegaram à ElevenLabs falsa — pelo header, nunca pela URL.
      const validacoes = pedidos.filter((p) => p.caminho === "/v1/voices");
      expect(validacoes.map((p) => p.chave)).toEqual(expect.arrayContaining([CHAVE_ERRADA, CHAVE_VALIDA]));
      for (const p of pedidos) expect(p.url, "a chave nunca vai na URL da ElevenLabs").not.toContain("e2e-chave");
      for (const u of urlsDoNavegador) expect(u, "a chave nunca vai numa URL do navegador").not.toContain("e2e-chave");
      await page.screenshot({ path: `${EVIDENCIA}/e2e-chave-validada.png`, fullPage: true });
    });

    await test.step("a fala de aguarde: prévia ouvida no navegador, só vira fala no 'Salvar e usar', e a mesma prévia não paga de novo", async () => {
      await page.goto("/app/connections?aba=telefone&sub=falas");
      await page.locator("#tel-voz").click();
      await page.getByRole("option", { name: VOZ.name, exact: true }).click();
      // O seletor só mostra a voz depois de a rota gravá-la e a aba reler.
      await expect(page.locator("#tel-voz")).toContainText(VOZ.name, { timeout: 20_000 });
      expect(sinteses(), "escolher a voz não sintetiza nada").toHaveLength(0);

      const falasDaOrg = () => contagem("select count(*)::int as n from public.phone_prompts where organization_id = $1", [orgId]);
      const falasDeAguarde = () =>
        contagem(
          "select count(*)::int as n from public.phone_prompts where organization_id = $1 and kind = 'waiting' and status = 'ready'",
          [orgId],
        );

      const cartao = page.locator('[data-fala-geral="waiting"]');
      await cartao.getByRole("button", { name: "Gerar prévia" }).click();
      await expect(cartao.locator('[data-estado-da-fala="previa"]')).toBeVisible({ timeout: 20_000 });
      const audio = cartao.locator("audio[data-previa-audio]");
      await expect(audio).toBeVisible();
      // A duração que o NAVEGADOR leu do WAV montado a partir do μ-law (NaN até os metadados chegarem).
      await expect
        .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).duration), { timeout: 15_000 })
        .toBeGreaterThan(0.9);
      expect(await audio.evaluate((el) => (el as HTMLAudioElement).duration)).toBeLessThan(1.1);

      expect(sinteses()).toHaveLength(1);
      const [primeira] = sinteses();
      expect(primeira!.chave, "a síntese usa a chave guardada, decifrada no servidor").toBe(CHAVE_VALIDA);
      expect(JSON.parse(primeira!.corpo)).toMatchObject({ model_id: MODELO_DE_VOZ_PADRAO });
      // A prévia não muda nada nas ligações: nenhuma linha de fala ainda (D15).
      expect(await falasDaOrg()).toBe(0);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-previa-da-fala.png`, fullPage: true });

      await cartao.getByRole("button", { name: "Salvar e usar" }).click();
      await expect(cartao.locator('[data-estado-da-fala="em-uso"]')).toBeVisible({ timeout: 20_000 });
      await expect.poll(falasDeAguarde).toBe(1);
      // Salvar não chamou a ElevenLabs; e a mesma prévia de novo sai do Storage, de graça.
      expect(sinteses()).toHaveLength(1);
      await cartao.getByRole("button", { name: "Gerar prévia" }).click();
      await expect(cartao.locator("audio[data-previa-audio]")).toBeVisible({ timeout: 20_000 });
      await expect(cartao.locator('[data-estado-da-fala="em-uso"]'), "a mesma prévia não vira 'prévia não salva'").toBeVisible();
      expect(sinteses(), "a mesma prévia de novo não chama a ElevenLabs (D15)").toHaveLength(1);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-voz-e-falas.png`, fullPage: true });
    });

    await test.step("o menu nasce das opções e só salva com a prévia da fala", async () => {
      await page.getByRole("tab", { name: "Menus", exact: true }).click();
      await page.getByRole("button", { name: "Novo menu" }).click();
      const editor = page.locator("[data-editor-de-menu]");
      await editor.locator("#menu-nome").fill(MENU_NOME);
      await editor.getByRole("combobox", { name: "Time da opção 1", exact: true }).click();
      await page.getByRole("option", { name: TIME_A.nome, exact: true }).click();
      await editor.getByRole("button", { name: "Adicionar opção" }).click();
      await editor.getByRole("combobox", { name: "Time da opção 2", exact: true }).click();
      await page.getByRole("option", { name: TIME_B.nome, exact: true }).click();
      await editor.locator("#menu-padrao").click();
      await page.getByRole("option", { name: TIME_A.nome, exact: true }).click();
      await expect(editor.locator("#menu-texto")).toHaveValue(`Para ${TIME_A.nome}, digite 1. Para ${TIME_B.nome}, digite 2.`);

      // Sem a prévia do texto, o menu não salva.
      const salvarMenu = editor.getByRole("button", { name: "Salvar menu" });
      await expect(salvarMenu).toBeDisabled();
      await editor.locator('[data-gerar-previa="menu"]').click();
      await expect(editor.locator("audio[data-previa-audio]")).toBeVisible({ timeout: 20_000 });
      expect(sinteses(), "a fala do menu é uma síntese nova").toHaveLength(2);
      await expect(salvarMenu).toBeEnabled();
      await salvarMenu.click();

      const cartao = page.locator("[data-menu]").filter({ hasText: MENU_NOME });
      await expect(cartao.locator('[data-estado-da-fala="em-uso"]')).toBeVisible({ timeout: 20_000 });
      await expect(cartao).toContainText(`1 → ${TIME_A.nome}`);
      await expect(cartao).toContainText(`2 → ${TIME_B.nome}`);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-menu-pronto.png`, fullPage: true });
    });

    await test.step("o número passa a tocar o menu — e o banco guarda só o menu", async () => {
      // "Números", exato: a aba de fora "Números por QR" também casaria.
      await page.getByRole("tab", { name: "Números", exact: true }).click();
      const numero = page.locator("[data-telefonia-numero]").filter({ hasText: NUMERO.nome });
      await expect(numero).toContainText(`Recebe: ${TIME_A.nome}`, { timeout: 20_000 });
      await numero.getByRole("button", { name: "Editar" }).click();
      await page.locator("#tel-destino").click();
      await page.getByRole("option", { name: "Tocar o menu", exact: true }).click();
      await page.locator("#tel-menu").click();
      await page.getByRole("option", { name: MENU_NOME, exact: true }).click();
      await page.getByRole("button", { name: "Salvar e conectar" }).click();
      await expect(numero).toContainText(`Quando ligarem: menu ${MENU_NOME}`, { timeout: 20_000 });

      await page.reload();
      await expect(page.locator("[data-telefonia-numero]").filter({ hasText: NUMERO.nome })).toContainText(
        `Quando ligarem: menu ${MENU_NOME}`,
        { timeout: 20_000 },
      );
      const [linha] = await sql<{ sip_team_id: string | null; tem_menu: boolean }>(
        "select sip_team_id, sip_menu_id is not null as tem_menu from public.channel_sessions where id = $1 and organization_id = $2",
        [NUMERO.id, orgId],
      );
      expect(linha).toEqual({ sip_team_id: null, tem_menu: true });
      await page.screenshot({ path: `${EVIDENCIA}/e2e-numero-toca-o-menu.png`, fullPage: true });
    });

    await test.step("o aviso de instabilidade só liga depois de gerar a prévia e ouvir, e a faixa aparece no topo", async () => {
      await page.goto("/app/settings/teams");
      const cartao = page.locator(`[data-aviso-de-instabilidade="${TIME_A.id}"]`);
      await expect(cartao).toHaveAttribute("data-ativo", "nao", { timeout: 20_000 });
      await cartao.getByRole("button", { name: "Ligar aviso" }).click();
      const janela = page.locator("[data-janela-do-aviso]");
      const ligar = janela.getByRole("button", { name: "Ligar", exact: true });
      // Texto novo: "Ligar" só destrava depois de gerar a prévia E ouvir (§6.3).
      await expect(janela.locator("[data-passo-do-aviso]")).toHaveAttribute("data-passo-do-aviso", "falta-previa");
      await expect(ligar).toBeDisabled();
      await janela.getByRole("button", { name: "Gerar prévia" }).click();
      await expect(janela.locator("audio[data-previa-audio]")).toBeVisible({ timeout: 20_000 });
      expect(sinteses(), "o texto do aviso é uma síntese nova").toHaveLength(3);
      await expect(janela.locator("[data-passo-do-aviso]")).toHaveAttribute("data-passo-do-aviso", "falta-ouvir");
      await expect(ligar).toBeDisabled();
      await janela.getByRole("button", { name: "Ouvir", exact: true }).click();
      await expect(janela.locator("[data-passo-do-aviso]")).toHaveAttribute("data-passo-do-aviso", "pronto");
      await expect(ligar).toBeEnabled();
      await janela.locator("#aviso-duracao").click();
      await page.getByRole("option", { name: "1 hora", exact: true }).click();
      await ligar.click();
      await expect(janela).toHaveCount(0, { timeout: 20_000 });

      await expect(cartao).toHaveAttribute("data-ativo", "sim", { timeout: 20_000 });
      await expect(cartao).toContainText("Ligado às");
      const faixa = page.locator("[data-faixa-aviso-de-instabilidade]");
      await expect(faixa).toContainText(`Aviso de instabilidade ligado no telefone do ${TIME_A.nome}`, { timeout: 20_000 });

      // A duração escolhida chegou ao banco: 1 hora, nem a padrão (2 h) nem "até desligar".
      const [periodo] = await sql<{ segundos: number | null }>(
        `select extract(epoch from (phone_emergency_expires_at - phone_emergency_active_since))::int as segundos
           from public.attendance_teams where id = $1 and organization_id = $2`,
        [TIME_A.id, orgId],
      );
      expect(periodo?.segundos).toBe(3600);

      // No topo da página, dentro do contêiner das faixas, com a TopBar logo abaixo — medido, não a olho.
      const m = await medirOTopo(page);
      expect(m.faixas, "o contêiner das faixas existe").not.toBeNull();
      expect(m.aviso, "a faixa do aviso está na página").not.toBeNull();
      expect(m.topBar, "a TopBar está na página").not.toBeNull();
      expect(m.faixas!.top).toBeLessThanOrEqual(TOLERANCIA);
      expect(m.aviso!.height, "a faixa tem altura — está à vista").toBeGreaterThan(0);
      expect(m.aviso!.top).toBeGreaterThanOrEqual(m.faixas!.top - TOLERANCIA);
      expect(m.aviso!.bottom).toBeLessThanOrEqual(m.faixas!.bottom + TOLERANCIA);
      expect(m.topBar!.top, "a TopBar não fica sob a faixa").toBeGreaterThanOrEqual(m.faixas!.bottom - TOLERANCIA);

      await expect
        .poll(() =>
          contagem(
            "select count(*)::int as n from public.api_audit_log where organization_id = $1 and action = 'phone.emergency_activated' and resource_id::text = $2",
            [orgId, TIME_A.id],
          ),
        )
        .toBe(1);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-aviso-ligado.png`, fullPage: true });
    });

    await test.step("com a faixa à vista, a TopBar gruda logo abaixo dela ao rolar uma página longa", async () => {
      await page.setViewportSize(JANELA_BAIXA);
      await page.goto("/app/connections?aba=telefone&sub=falas");
      await expect(page.locator('[data-fala-geral="after_hours"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-faixa-aviso-de-instabilidade]")).toBeVisible({ timeout: 20_000 });

      const antes = await medirOTopo(page);
      expect(antes.faixas && antes.topBar, "faixas e TopBar na página").toBeTruthy();
      const precisaRolar = antes.faixas!.height + ALTURA_DA_TOPBAR + 100;
      expect(
        antes.alturaDaPagina - antes.janela,
        "a página não é longa o bastante para a medida valer — a TopBar sairia da tela se não grudasse",
      ).toBeGreaterThan(precisaRolar);

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(precisaRolar);
      const m = await medirOTopo(page);

      expect(m.posicaoDaTopBar).toBe("sticky");
      expect(Math.abs(m.faixas!.top), "o contêiner das faixas gruda no topo").toBeLessThanOrEqual(TOLERANCIA);
      expect(m.aviso!.top, "a faixa do aviso segue à vista no topo").toBeGreaterThanOrEqual(m.faixas!.top - TOLERANCIA);
      expect(m.aviso!.bottom).toBeLessThanOrEqual(m.faixas!.bottom + TOLERANCIA);
      expect(m.topBar!.top, "a TopBar não fica sob as faixas").toBeGreaterThanOrEqual(m.faixas!.bottom - TOLERANCIA);
      expect(m.topBar!.top, "a TopBar gruda LOGO abaixo das faixas").toBeLessThanOrEqual(m.faixas!.bottom + TOLERANCIA);
      // A altura que o contêiner publica é a que a TopBar desconta.
      expect(Math.abs(Number.parseFloat(m.alturaPublicada) - m.faixas!.height)).toBeLessThanOrEqual(TOLERANCIA);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-topbar-abaixo-das-faixas-ao-rolar.png` });
      await page.setViewportSize(JANELA);
    });

    await test.step("o atendente vê a faixa em outra tela, sem o botão de desligar, e o composer da Inbox cabe na janela", async () => {
      const contexto = await browser.newContext({ viewport: JANELA });
      try {
        const agente = await contexto.newPage();
        await entrar(agente, atendente.email, atendente.senha);
        await agente.goto(`/app/inbox?id=${conversaId}`);
        const faixa = agente.locator("[data-faixa-aviso-de-instabilidade]");
        await expect(faixa).toContainText(TIME_A.nome, { timeout: 20_000 });
        await expect(faixa.getByRole("button", { name: /Desligar/ })).toHaveCount(0);
        const campo = agente.getByRole("textbox", { name: "Mensagem", exact: true });
        await expect(campo).toBeVisible({ timeout: 20_000 });

        const m = await agente.evaluate(() => {
          const caixa = (el: Element | null | undefined): Caixa | null => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          };
          const textarea = document.querySelector('textarea[aria-label="Mensagem"]');
          return {
            faixas: caixa(document.querySelector("[data-faixas-do-topo]")),
            aviso: caixa(document.querySelector("[data-faixa-aviso-de-instabilidade]")),
            // A raiz do composer (components/inbox/Composer.tsx): a caixa com a borda de cima.
            composer: caixa(textarea?.closest(".border-t")),
            campo: caixa(textarea),
            janela: window.innerHeight,
            rolagemDaPagina: document.documentElement.scrollHeight - window.innerHeight,
          };
        });
        expect(m.aviso?.height ?? 0, "a medida só vale com a faixa à vista").toBeGreaterThan(0);
        expect(m.composer, "a raiz do composer não foi achada").not.toBeNull();
        expect(m.composer!.bottom, "o composer inteiro dentro da janela").toBeLessThanOrEqual(m.janela + TOLERANCIA);
        expect(m.composer!.top, "o composer não fica sob as faixas").toBeGreaterThanOrEqual(m.faixas!.bottom);
        expect(m.campo!.bottom).toBeLessThanOrEqual(m.janela + TOLERANCIA);
        expect(m.rolagemDaPagina, "a página não rola pela altura da faixa").toBeLessThanOrEqual(TOLERANCIA);
        await agente.screenshot({ path: `${EVIDENCIA}/e2e-faixa-do-atendente-na-inbox.png` });
      } finally {
        await contexto.close();
      }
    });

    await test.step("desligar pela faixa: ela some sem recarregar, e o cartão volta a 'desligado'", async () => {
      await page.goto("/app/settings/teams");
      const cartao = page.locator(`[data-aviso-de-instabilidade="${TIME_A.id}"]`);
      await expect(cartao).toHaveAttribute("data-ativo", "sim", { timeout: 20_000 });
      const faixa = page.locator("[data-faixa-aviso-de-instabilidade]");
      await faixa.getByRole("button", { name: /Desligar/ }).click();
      await expect(faixa).toHaveCount(0, { timeout: 20_000 });
      await expect(cartao).toHaveAttribute("data-ativo", "nao", { timeout: 20_000 });
      await expect
        .poll(() =>
          contagem(
            "select count(*)::int as n from public.api_audit_log where organization_id = $1 and action = 'phone.emergency_deactivated' and resource_id::text = $2",
            [orgId, TIME_A.id],
          ),
        )
        .toBe(1);
      await page.screenshot({ path: `${EVIDENCIA}/e2e-aviso-desligado.png`, fullPage: true });
    });

    expect(foraDoContrato, "pedido à ElevenLabs falsa fora do contrato do cliente").toEqual([]);
  });
});
