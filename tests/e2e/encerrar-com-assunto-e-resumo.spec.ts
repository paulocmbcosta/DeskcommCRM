/**
 * J41 — ENCERRAR COM ASSUNTO E RESUMO (migration 0293).
 *
 * A jornada inteira, pela tela, como quem administra e como quem atende:
 *
 *   1. cadastra os assuntos de cada time em Configurações › Times;
 *   2. liga "exigir o assunto" e "exigir o resumo" em Configurações › Atendimento;
 *   3. no Inbox, "Fechar" abre a JANELA (e não o `confirm()` do navegador);
 *      em branco ela recusa, e a conversa segue aberta;
 *   4. a conversa não tem time: quem atende escolhe o SETOR na hora, o assunto
 *      arquivado não é oferecido, e o registro fecha o atendimento;
 *   5. o registro aparece na ficha, na linha do tempo, na aba Fechadas e em
 *      "Atendimentos anteriores";
 *   6. "Reabrir" e "Fechar" de novo: a janela volta preenchida;
 *   7. Métricas mostra o assunto contado no setor dele.
 *
 * Cria a PRÓPRIA organização (admin sem MFA) e a apaga no fim — não toca a
 * organização compartilhada da suíte.
 *
 * Times entram por SQL direto: `attendance_teams` só aceita escrita por RPC com
 * sessão. Os ASSUNTOS, que são o que esta jornada mede, entram pela tela.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/encerramento-assunto";

const RESUMO = "Cliente sem sinal no quarto. Orientei a mudar o roteador de lugar e o sinal voltou.";

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

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

/**
 * Abre uma aba do painel da conversa SEM fechá-la por engano: clicar na aba que
 * já está aberta recolhe o painel, então o clique só acontece se ela não for a atual.
 */
async function abrirAba(page: Page, aba: "detalhes" | "historico" | "linha"): Promise<void> {
  const painel = page.getByTestId("painel-da-conversa").first();
  if ((await painel.getAttribute("data-aba")) !== aba) await page.getByTestId(`painel-aba-${aba}`).click();
  await expect(painel).toHaveAttribute("data-aba", aba);
}

async function adicionarAssunto(page: Page, timeSlug: string, nome: string): Promise<void> {
  const cartao = page.getByTestId(`assuntos-do-time-${timeSlug}`);
  await cartao.getByTestId("assunto-novo-nome").fill(nome);
  await cartao.getByTestId("assunto-adicionar").click();
  await expect(cartao.locator(`[data-testid="assunto-item"][data-nome="${nome}"]`)).toBeVisible();
}

test("encerrar com assunto e resumo: cadastro, exigência, janela, histórico e métricas", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  // O `confirm()` do navegador SAIU: se algum diálogo nativo aparecer, a jornada
  // está no caminho antigo — e o teste precisa saber, não aceitar em silêncio.
  const dialogosNativos: string[] = [];
  page.on("dialog", (d) => {
    dialogosNativos.push(d.message());
    void d.dismiss();
  });

  const password = `Local-${randomUUID()}!`;
  const email = `encerramento-${randomUUID()}@invariant.test`;
  let org = "";
  let user = "";

  try {
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Juliana Teste" },
    });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", {
      display_name: "Provedor local",
      legal_name: "Provedor local",
      slug: `encerramento-${randomUUID()}`,
      onboarded_at: new Date().toISOString(),
    });
    const membership = await db.from("user_organizations").insert({
      organization_id: org,
      user_id: user,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    if (membership.error) throw membership.error;

    const contact = await insert("contacts", {
      organization_id: org,
      display_name: "Marta Encerramento",
      phone_number: "+5561993040041",
    });
    const session = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `encerramento-${randomUUID()}`,
      display_name: "Whats Suporte",
      phone_number: "+556130004141",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    // SEM time, de propósito: é o caso de um terço dos encerramentos reais.
    const conversation = await insert("conversations", {
      organization_id: org,
      contact_id: contact,
      channel_session_id: session,
      status: "open",
    });
    const sentAt = new Date().toISOString();
    await insert("messages", {
      organization_id: org,
      contact_id: contact,
      conversation_id: conversation,
      channel_session_id: session,
      direction: "inbound",
      type: "text",
      status: "received",
      sent_via: "ai",
      body: "Meu Wi-Fi não pega no quarto",
      sent_at: sentAt,
    });
    const marked = await db.rpc("fn_mark_conversation_message", {
      p_conv: conversation,
      p_direction: "inbound",
      p_preview: "Meu Wi-Fi não pega no quarto",
      p_at: sentAt,
    });
    if (marked.error) throw marked.error;

    await sql(
      `insert into public.attendance_teams (id, organization_id, name, slug) values
         ($1, $3, 'Suporte', 'suporte'), ($2, $3, 'Cobrança', 'cobranca')`,
      [randomUUID(), randomUUID(), org],
    );

    const registroNoBanco = async () => {
      const { data, error } = await db
        .from("atendimentos")
        .select("closed_at, closure_summary, assunto_id")
        .eq("conversation_id", conversation)
        .order("started_at", { ascending: false })
        .limit(1)
        .single();
      if (error) throw error;
      return data;
    };

    await login(page, email, password);

    // ─── 1. Cadastro dos assuntos, por time ──────────────────────────────────
    await page.goto("/app/settings/teams");
    await expect(page.getByTestId("assuntos-do-time-suporte").getByTestId("assuntos-vazio")).toBeVisible();
    await adicionarAssunto(page, "suporte", "Wi-Fi");
    await adicionarAssunto(page, "suporte", "Lentidão");
    await adicionarAssunto(page, "suporte", "Assunto de teste");
    await adicionarAssunto(page, "cobranca", "Segunda via de boleto");

    // Nome repetido no mesmo time é recusado com frase, não com erro de sistema.
    const suporte = page.getByTestId("assuntos-do-time-suporte");
    await suporte.getByTestId("assunto-novo-nome").fill("wi-fi");
    await suporte.getByTestId("assunto-adicionar").click();
    await expect(page.getByText("Esse time já tem um assunto com esse nome.")).toBeVisible();
    await expect(suporte.getByTestId("assunto-item")).toHaveCount(3);
    await suporte.getByTestId("assunto-novo-nome").fill("");

    // Arquivar tira da lista ativa e deixa à vista, no fim.
    await suporte
      .locator('[data-testid="assunto-item"][data-nome="Assunto de teste"]')
      .getByTestId("assunto-arquivar")
      .click();
    await expect(suporte.getByTestId("assunto-item")).toHaveCount(2);
    await expect(suporte.getByTestId("assuntos-arquivados")).toContainText("Assunto de teste");
    await page.screenshot({ path: `${evidence}/01-cadastro-de-assuntos.png`, fullPage: true });

    // ─── 2. Os interruptores ─────────────────────────────────────────────────
    await page.goto("/app/settings/atendimento");
    const regra = page.getByTestId("regra-de-encerramento");
    await expect(regra.getByTestId("exigir-assunto")).toHaveAttribute("aria-checked", "false");
    await expect(regra.getByTestId("exigir-resumo")).toHaveAttribute("aria-checked", "false");
    await regra.getByTestId("exigir-assunto").click();
    await regra.getByTestId("exigir-resumo").click();
    // Há assuntos cadastrados: o aviso de "nada será exigido" NÃO aparece.
    await expect(regra.getByTestId("aviso-sem-assuntos")).toHaveCount(0);
    await regra.getByTestId("salvar-regra-de-encerramento").click();
    await expect(page.getByText("Regra de encerramento salva.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("regra-de-encerramento").getByTestId("exigir-assunto")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("regra-de-encerramento").getByTestId("exigir-resumo")).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `${evidence}/02-interruptores-ligados.png`, fullPage: true });

    // ─── 3. A janela no lugar do confirm(), e a recusa em branco ─────────────
    await page.goto("/app/inbox?filter=all");
    const card = page.locator(`[data-conversation-id="${conversation}"]`).first();
    await expect(card).toBeVisible();
    await card.click();
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    const janela = page.getByTestId("janela-de-encerramento");
    await expect(janela).toBeVisible();
    await expect(janela).toContainText("Marta Encerramento");
    expect(dialogosNativos, "o confirm() do navegador não pode mais aparecer").toEqual([]);

    // Cabe na tela, medido: nada da janela fica fora da viewport.
    const caixa = await janela.boundingBox();
    expect(caixa, "a janela precisa ter caixa").not.toBeNull();
    expect(caixa!.x).toBeGreaterThanOrEqual(0);
    expect(caixa!.y).toBeGreaterThanOrEqual(0);
    expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(1440);
    expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(1000);

    await janela.getByTestId("encerramento-confirmar").click();
    await expect(janela.getByTestId("encerramento-erro-assunto")).toHaveText("Escolha o assunto do atendimento.");
    await expect(janela.getByTestId("encerramento-erro-resumo")).toBeVisible();
    expect((await registroNoBanco()).closed_at, "recusou: o atendimento segue aberto").toBeNull();
    await page.screenshot({ path: `${evidence}/03-janela-recusa-em-branco.png` });

    // ─── 4. Sem time: escolhe o setor na hora ────────────────────────────────
    await janela.getByTestId("encerramento-setor").click();
    await page.getByRole("option", { name: "Suporte", exact: true }).click();
    const assuntos = janela.getByTestId("encerramento-assunto");
    await expect(assuntos).toHaveCount(2);
    await expect(janela).not.toContainText("Assunto de teste");
    await janela.getByRole("radio", { name: "Wi-Fi", exact: true }).click();
    await expect(janela.getByTestId("encerramento-erro-assunto")).toHaveCount(0);
    await janela.getByTestId("encerramento-resumo").fill(RESUMO);
    await page.screenshot({ path: `${evidence}/04-janela-preenchida.png` });
    await janela.getByTestId("encerramento-confirmar").click();
    await expect(janela).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();

    const gravado = await registroNoBanco();
    expect(gravado.closed_at).not.toBeNull();
    expect(gravado.closure_summary).toBe(RESUMO);
    expect(gravado.assunto_id).not.toBeNull();
    // Escolher o setor do assunto NÃO transfere a conversa.
    const { data: conversaDepois } = await db.from("conversations").select("team_id, status").eq("id", conversation).single();
    expect(conversaDepois).toMatchObject({ team_id: null, status: "closed" });

    // ─── 5. Onde o registro aparece ──────────────────────────────────────────
    const painel = page.getByTestId("painel-da-conversa").first();
    await abrirAba(page, "detalhes");
    await expect(painel.getByTestId("assunto-do-atendimento")).toHaveText("Suporte › Wi-Fi");
    await expect(painel.getByTestId("resumo-do-atendimento")).toContainText(RESUMO);

    await abrirAba(page, "linha");
    const linha = page.getByTestId("linha-do-tempo-da-conversa");
    await expect(linha).toContainText("Conversa encerrada");
    await expect(linha).toContainText("Por Juliana Teste. Assunto: Suporte › Wi-Fi.");
    // O resumo é texto sobre o cliente: fica na ficha, nunca na linha do tempo.
    await expect(linha).not.toContainText("roteador");

    await abrirAba(page, "historico");
    const historico = page.getByTestId("historico-de-atendimentos");
    await expect(historico.getByTestId("assunto-no-historico")).toHaveText("Suporte › Wi-Fi");
    await expect(historico.getByTestId("resumo-no-historico")).toContainText("Cliente sem sinal no quarto");
    await page.screenshot({ path: `${evidence}/05-historico-com-assunto-e-resumo.png` });

    // ─── 6. Reabrir e fechar de novo: a janela volta preenchida ──────────────
    await page.getByRole("button", { name: "Reabrir" }).click();
    await expect(page.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    const deNovo = page.getByTestId("janela-de-encerramento");
    await expect(deNovo.getByRole("radio", { name: "Wi-Fi", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(deNovo.getByTestId("encerramento-resumo")).toHaveValue(RESUMO);
    await page.screenshot({ path: `${evidence}/07-reaberto-volta-preenchido.png` });
    await deNovo.getByTestId("encerramento-confirmar").click();
    await expect(deNovo).toHaveCount(0);
    const refechado = await registroNoBanco();
    expect(refechado.closed_at).not.toBeNull();
    expect(refechado.closure_summary).toBe(RESUMO);

    // A aba Fechadas lista o atendimento com o assunto no card.
    await page.goto("/app/inbox?filter=closed");
    const fechado = page.getByTestId("lista-de-atendimentos-fechados").getByTestId("atendimento-fechado").first();
    await expect(fechado).toContainText("Marta Encerramento");
    await expect(fechado.getByTestId("assunto-do-fechado")).toHaveText("Suporte › Wi-Fi");
    await page.screenshot({ path: `${evidence}/06-fechadas-com-assunto.png` });

    // ─── 7. Os números ───────────────────────────────────────────────────────
    await page.goto("/app/metrics");
    const numeros = page.getByTestId("painel-de-assuntos");
    await expect(numeros).toBeVisible();
    await numeros.getByTestId("periodo-hoje").click();
    await expect(numeros.getByTestId("assuntos-resumo")).toContainText("1");
    await expect(numeros.getByTestId("assuntos-resumo")).toContainText("com assunto (100%)");
    const setor = numeros.getByTestId("assuntos-do-setor");
    await expect(setor).toHaveCount(1);
    await expect(setor).toContainText("Suporte");
    await expect(numeros.locator('[data-testid="assunto-contado"][data-assunto="Wi-Fi"]')).toContainText("1 · 100%");
    await expect(numeros.getByTestId("sem-assunto-por-time")).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/08-metricas-por-assunto.png`, fullPage: true });

    expect(dialogosNativos, "nenhum diálogo nativo em toda a jornada").toEqual([]);
  } finally {
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
