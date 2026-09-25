/**
 * [P1] Todas por CHIPS de time, a FILA do time e o TERMÔMETRO de espera
 * (migration 0279) — pedido do dono em 2026-09-24.
 *
 * Dirige o FRONTEND, logada, clicando (doutrina de QA Visual). O que entra por
 * baixo — a mensagem do cliente — entra pelo MESMO caminho da ingestão
 * (`fn_mark_conversation_message`), porque é dele que o trigger deriva
 * `espera_desde`: um `update conversations set espera_desde=…` provaria a tela e
 * não o produto.
 *
 * O que ela mede e teste de unidade não alcança:
 *   1. o trigger do banco chega à tela: a cor do card sai da PRIMEIRA mensagem
 *      sem resposta, contra o PostgREST de verdade;
 *   2. os chips contam pelo banco e escolher um time não zera os outros;
 *   3. "Só na fila" e "Mais tempo esperando" filtram e ordenam no servidor;
 *   4. o filtro de número distingue dois canais com o MESMO nome;
 *   5. a régua salva em Configurações muda a cor do card.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/inbox-fila-e-termometro";

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/** Times entram por SQL: `attendance_teams` só aceita escrita pela RPC de gestor com MFA. */
async function sql(texto: string, valores: unknown[] = []): Promise<void> {
  const cliente = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await cliente.connect();
  try {
    await cliente.query(texto, valores);
  } finally {
    await cliente.end();
  }
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

const minutosAtras = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("Todas por chips, fila do time e termômetro de espera", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const password = `Local-${randomUUID()}!`;
  const email = `termometro-${randomUUID()}@invariant.test`;
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Ana Atendente" },
  });
  if (created.error || !created.data.user) throw created.error;
  const user = created.data.user.id;
  const org = await insert("organizations", {
    display_name: "Provedor local",
    legal_name: "Provedor local",
    slug: `termometro-${randomUUID()}`,
    onboarded_at: new Date().toISOString(),
  });
  const membership = await db.from("user_organizations").insert({
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (membership.error) throw membership.error;

  // Dois números com o MESMO nome — o caso dos dois oficiais da Meta ("Totus").
  const canal3025 = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: `termometro-${randomUUID()}`,
    display_name: "Totus",
    phone_number: "+551130250000",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: `termometro-${randomUUID()}`,
    display_name: "Totus",
    phone_number: "+551140630000",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });

  const suporte = randomUUID();
  const vendas = randomUUID();
  await sql(
    `insert into public.attendance_teams (id, organization_id, name, slug) values
       ($1, $3, 'Suporte', 'suporte'), ($2, $3, 'Vendas', 'vendas')`,
    [suporte, vendas, org],
  );

  /** Uma conversa cujo cliente falou há `minutos` e ninguém respondeu. */
  async function conversa(nome: string, telefone: string, minutos: number): Promise<string> {
    const contato = await insert("contacts", { organization_id: org, display_name: nome, phone_number: telefone });
    const id = await insert("conversations", {
      organization_id: org,
      contact_id: contato,
      channel_session_id: canal3025,
      status: "open",
    });
    // A PRIMEIRA sem resposta e depois outra mais recente: a cor tem de sair da primeira.
    for (const [corpo, em] of [
      ["oi", minutosAtras(minutos)],
      ["alguém aí?", minutosAtras(Math.max(0, minutos - 1))],
    ] as const) {
      const r = await db.rpc("fn_mark_conversation_message", {
        p_conv: id,
        p_direction: "inbound",
        p_preview: corpo,
        p_at: em,
      });
      if (r.error) throw r.error;
    }
    return id;
  }

  // A: foi para o Suporte e ninguém pegou (a transferência cala a IA) — 14 min: vermelho.
  const naFila = await conversa("Cliente na fila", "+5561990000001", 14);
  await sql(
    `update public.conversations set team_id = $1, bot_silenced_until = 'infinity' where id = $2`,
    [suporte, naFila],
  );
  // B: com a Ana, em Vendas, 7 min: laranja.
  const laranja = await conversa("Cliente laranja", "+5561990000002", 7);
  await sql(
    `update public.conversations set team_id = $1, assigned_to_user_id = $2, assignee_kind = 'user',
       status = 'claimed', bot_silenced_until = 'infinity' where id = $3`,
    [vendas, user, laranja],
  );
  // C: com a Ana, sem time, 3 min: amarelo.
  const amarelo = await conversa("Cliente amarelo", "+5561990000003", 3);
  await sql(
    `update public.conversations set assigned_to_user_id = $1, assignee_kind = 'user',
       status = 'claimed', bot_silenced_until = 'infinity' where id = $2`,
    [user, amarelo],
  );

  // O TOM DO CLIENTE (migration 0280): a nota entra pela MESMA função que o
  // worker de sentimento chama, não por update direto na coluna.
  for (const [id, notaDoCliente] of [
    [naFila, 0.05],
    [laranja, 0.2],
    [amarelo, 0.8],
  ] as const) {
    const r = await db.rpc("fn_registrar_sentimento_da_conversa", {
      p_org: org,
      p_conversation: id,
      p_score: notaDoCliente,
      p_em: new Date().toISOString(),
    });
    if (r.error) throw r.error;
  }

  try {
    await login(page, email, password);
    await page.goto("/app/inbox?filter=all");

    // ─── 1. O trilho de abas continua; os times viram chips ─────────────────
    await expect(page.getByTestId("inbox-abas")).toBeVisible();
    const chips = page.getByTestId("chips-dos-times");
    await expect(chips).toBeVisible();
    const chipSuporte = page.getByRole("button", { name: "Filtrar por time: Suporte (1 na fila)" });
    await expect(chipSuporte).toHaveText(/Suporte\s*1/);
    await expect(chipSuporte.getByTestId("chip-na-fila")).toHaveText("1");
    await expect(page.getByRole("button", { name: "Filtrar por time: Vendas" })).toHaveText(/Vendas\s*1/);
    await expect(page.getByRole("button", { name: "Filtrar por time: Sem time" })).toHaveText(/Sem time\s*1/);
    await expect(page.getByTestId("inbox-grupo-time")).toHaveCount(0);

    // ─── 2. O termômetro e o selo, pelo trigger do banco ────────────────────
    const card = (id: string) => page.locator(`[data-conversation-id="${id}"]`);
    await expect(card(naFila).getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", "vermelho");
    await expect(card(naFila).getByTestId("espera-da-conversa")).toContainText("Aguardando há 14 min");
    await expect(card(naFila).getByTestId("selo-na-fila-do-time")).toHaveText("Na fila · Suporte");
    await expect(card(laranja).getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", "laranja");
    await expect(card(amarelo).getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", "amarelo");
    await expect(card(laranja).getByTestId("selo-na-fila-do-time")).toHaveCount(0);
    // A sirene anda: a animação está ligada no vermelho, e só nele.
    const animacao = await card(naFila)
      .getByTestId("espera-da-conversa")
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(animacao).toBe("deskcomm-sirene");
    expect(
      await card(laranja).getByTestId("espera-da-conversa").evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    await page.screenshot({ path: `${evidence}/01-todas-chips-e-termometro.png` });

    // ─── 3. Mais tempo esperando: o mais antigo primeiro ────────────────────
    await page.getByRole("button", { name: /Mais tempo esperando/ }).click();
    const lista = page.locator("[data-conversation-id]");
    await expect(lista.first()).toHaveAttribute("data-conversation-id", naFila);
    await expect(lista.nth(1)).toHaveAttribute("data-conversation-id", laranja);
    await expect(lista.nth(2)).toHaveAttribute("data-conversation-id", amarelo);

    // ─── 4. Só na fila ──────────────────────────────────────────────────────
    await page.getByRole("button", { name: /Só na fila/ }).click();
    await expect(lista).toHaveCount(1);
    await expect(lista.first()).toHaveAttribute("data-conversation-id", naFila);
    await page.screenshot({ path: `${evidence}/02-so-na-fila.png` });
    await page.getByRole("button", { name: /Só na fila/ }).click();

    // ─── 5. Escolher um time não zera os outros chips ───────────────────────
    await page.getByRole("button", { name: "Filtrar por time: Vendas" }).click();
    await expect(lista).toHaveCount(1);
    await expect(lista.first()).toHaveAttribute("data-conversation-id", laranja);
    await expect(page.getByRole("button", { name: "Filtrar por time: Suporte" })).toHaveText(/Suporte\s*1/);
    await page.screenshot({ path: `${evidence}/03-chip-vendas.png` });
    await page.getByRole("button", { name: /^Todos/ }).click();
    await expect(lista).toHaveCount(3);

    // ─── 6. O filtro de número distingue os dois "Totus" ────────────────────
    await page.getByTestId("inbox-abrir-filtros").click();
    await page.getByRole("combobox", { name: "Filtrar por número de WhatsApp" }).click();
    await expect(page.getByRole("option", { name: "Totus · +551130250000" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Totus · +551140630000" })).toBeVisible();
    await page.screenshot({ path: `${evidence}/04-filtro-de-numero.png` });
    await page.keyboard.press("Escape");

    // ─── 6b. O tom do cliente: card, filtro e topo da conversa ──────────────
    await expect(card(naFila).getByTestId("selo-sentimento")).toHaveAttribute("data-faixa", "critico");
    await expect(card(laranja).getByTestId("selo-sentimento")).toHaveAttribute("data-faixa", "insatisfeito");
    // Satisfeito não polui o card.
    await expect(card(amarelo).getByTestId("selo-sentimento")).toHaveCount(0);
    await page.getByRole("button", { name: "Insatisfeitos" }).click();
    await expect(lista).toHaveCount(2);
    await page.screenshot({ path: `${evidence}/04b-insatisfeitos.png` });
    await page.getByRole("button", { name: "Insatisfeitos" }).click();
    await expect(lista).toHaveCount(3);
    await card(naFila).click();
    const seloDoTopo = page.getByTestId("selo-sentimento-da-conversa").first();
    await expect(seloDoTopo).toHaveAttribute("data-faixa", "critico");
    await expect(seloDoTopo).toContainText("Crítico · 0,05");
    await page.screenshot({ path: `${evidence}/04c-tom-no-topo.png` });

    // ─── 7. A régua da organização muda a cor ───────────────────────────────
    await page.goto("/app/settings/atendimento");
    const regua = page.getByRole("main").getByTestId("regua-de-espera");
    await expect(regua).toBeVisible();
    await regua.getByLabel("Amarelo a partir de").fill("1");
    await regua.getByLabel("Laranja a partir de").fill("2");
    await regua.getByLabel("Vermelho pulsando a partir de").fill("3");
    await regua.getByRole("button", { name: "Salvar régua" }).click();
    await expect(page.getByText("Régua salva.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/05-regua-salva.png` });
    await page.goto("/app/inbox?filter=all");
    await expect(card(amarelo).getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", "vermelho");
    await page.screenshot({ path: `${evidence}/06-regua-aplicada.png` });
  } finally {
    await context.close();
  }
});
