/**
 * [P1] O inbox de quem atende com PROTOCOLO — trilho de abas, filtros recolhidos,
 * card que diz time e canal, e o painel com histórico e linha do tempo.
 *
 * É a jornada de uma operação regulada (telecom): cada atendimento tem número
 * de protocolo; fechou, some da fila; o cliente voltou, nasce atendimento NOVO
 * com protocolo NOVO, e o anterior fica no histórico, navegável e achável pelo
 * número.
 *
 * Dirige o FRONTEND, logada, clicando (doutrina de QA Visual). O que entra por
 * baixo — a mensagem do cliente — entra pelo MESMO caminho da ingestão: INSERT
 * em `messages`, que é o que dispara `fn_service_inbound` e a reabertura. Um
 * `update conversations set status='open'` provaria o trigger de atendimento e
 * não provaria o produto.
 *
 * O que ela mede e teste de unidade não alcança:
 *   1. o trilho e os filtros recolhidos DEVOLVEM altura à lista (medido em px);
 *   2. o protocolo que o banco gerou CHEGA à tela, e muda quando o cliente volta;
 *   3. abrir um atendimento antigo recorta a conversa naquele episódio e trava
 *      o composer — e "voltar ao atual" desfaz os dois;
 *   4. a busca pelo protocolo ANTIGO acha o atendimento estando em outra aba.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/inbox-protocolo";

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Time e vínculo da conversa entram por SQL direto: `attendance_teams` só aceita
 * escrita pela RPC de gestor com MFA (GRANT só de SELECT até para o service
 * role), e o que esta spec mede é o inbox, não o cadastro de times — que tem
 * spec própria.
 */
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

test("protocolo por atendimento: fechar, o cliente voltar, histórico e busca pelo número", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const password = `Local-${randomUUID()}!`;
  const email = `protocolo-${randomUUID()}@invariant.test`;
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
      display_name: "Telecom local",
      legal_name: "Telecom local",
      slug: `protocolo-${randomUUID()}`,
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
      display_name: "Fernando Protocolo",
      phone_number: "+5561993040001",
    });
    const session = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `protocolo-${randomUUID()}`,
      display_name: "Whats Suporte",
      phone_number: "+556130004063",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const conversation = await insert("conversations", {
      organization_id: org,
      contact_id: contact,
      channel_session_id: session,
      status: "open",
    });

    async function inbound(body: string): Promise<void> {
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
        body,
        sent_at: sentAt,
      });
      const marked = await db.rpc("fn_mark_conversation_message", {
        p_conv: conversation,
        p_direction: "inbound",
        p_preview: body,
        p_at: sentAt,
      });
      if (marked.error) throw marked.error;
    }

    await inbound("Quero a segunda via do boleto");

    const time = randomUUID();
    await sql(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, 'Cobrança', 'cobranca')`, [time, org]);
    await sql(`update public.conversations set team_id = $1 where id = $2`, [time, conversation]);

    const protocoloDe = async (): Promise<string> => {
      const { data, error } = await db.from("conversations").select("protocol").eq("id", conversation).single();
      if (error) throw error;
      return String(data.protocol);
    };
    const primeiro = await protocoloDe();
    expect(primeiro, "a conversa nasce com protocolo de 14 dígitos").toMatch(/^\d{14}$/);

    // ─── 1. A lista: trilho, filtros recolhidos, card ───────────────────────
    await login(page, email, password);
    await page.goto("/app/inbox?filter=all");

    const trilho = page.getByTestId("inbox-abas");
    await expect(trilho).toBeVisible();
    await expect(page.getByRole("tab", { name: "Fila" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Todas" })).toHaveAttribute("aria-selected", "true");
    // O nome da aba está ESCRITO — no trilho só cabe o ícone.
    await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Todas");

    // Medido, não estimado: o trilho é estreito e fica À ESQUERDA da lista.
    const caixaDoTrilho = await trilho.boundingBox();
    expect(caixaDoTrilho?.width ?? 0).toBeLessThanOrEqual(48);

    const card = page.locator(`[data-conversation-id="${conversation}"]`);
    await expect(card).toBeVisible();
    // Em 1440px a lista tem os 300px cheios. Já ficou presa em 248px com a regra
    // de 1400px escrita e sem valer — a do `xl` vinha depois no CSS e vencia.
    expect((await card.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(296);
    // A primeira conversa começa ALTO na coluna: busca + título, sem faixa de
    // abas nem seletores abertos por cima. 140px é o teto com folga.
    const caixaDoCard = await card.boundingBox();
    const caixaDaColuna = await page.getByTestId("inbox-aba-atual").boundingBox();
    expect((caixaDoCard?.y ?? 999) - (caixaDaColuna?.y ?? 0)).toBeLessThan(140);

    // Filtros recolhidos: abrem no funil, fecham no funil.
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toHaveCount(0);
    await page.getByTestId("inbox-abrir-filtros").click();
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toBeVisible();
    await expect(page.getByLabel("Filtrar por time")).toBeVisible();
    await page.screenshot({ path: `${evidence}/01-filtros-abertos.png` });
    await page.getByTestId("inbox-abrir-filtros").click();
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toHaveCount(0);

    // O card diz DE QUEM é e POR ONDE entrou, antes de abrir — e há quanto tempo espera.
    const rodape = card.getByTestId("rodape-da-conversa");
    await expect(rodape).toContainText("Cobrança");
    await expect(rodape).toContainText("Whats Suporte · 4063");
    // Nada cortado: o rodapé existe para dizer o nome INTEIRO do time e do canal.
    const cortado = await rodape.evaluate((el) =>
      [...el.querySelectorAll("span.truncate")].some((s) => s.scrollWidth > s.clientWidth + 1),
    );
    expect(cortado, "time ou canal com reticências no card").toBe(false);
    await expect(card.getByTestId("espera-da-conversa")).toContainText("Aguardando há");
    await page.screenshot({ path: `${evidence}/02-lista-com-time-e-canal.png` });

    // ─── 2. O painel: protocolo e ficha da conversa ─────────────────────────
    await card.click();
    const painel = page.getByTestId("painel-da-conversa").first();
    await expect(painel.getByTestId("protocolo-do-atendimento")).toContainText(primeiro);
    const ficha = painel.getByTestId("ficha-da-conversa");
    await expect(ficha).toContainText(primeiro);
    await expect(ficha).toContainText("Whats Suporte");
    await expect(ficha).toContainText("Cobrança");
    await page.screenshot({ path: `${evidence}/03-painel-detalhes.png` });

    // Fechar o painel devolve a largura à conversa (clicar na aba aberta fecha).
    const larguraAntes = (await page.getByTestId("chat-thread").boundingBox())?.width ?? 0;
    await page.getByTestId("painel-aba-detalhes").click();
    await expect(painel).toHaveAttribute("data-aba", "fechado");
    const larguraDepois = (await page.getByTestId("chat-thread").boundingBox())?.width ?? 0;
    expect(larguraDepois).toBeGreaterThan(larguraAntes + 200);
    await page.getByTestId("painel-aba-detalhes").click();

    // ─── 3. Assumir e fechar; a linha do tempo conta, com autor ─────────────
    await page.getByRole("button", { name: "Assumir", exact: true }).click();
    await expect(page.getByTestId("comando-da-conversa")).toContainText("Juliana Teste");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();

    await page.getByTestId("painel-aba-linha").click();
    const linha = page.getByTestId("linha-do-tempo-da-conversa");
    await expect(linha).toContainText("Conversa aberta");
    await expect(linha).toContainText("Transferida para a fila do time");
    await expect(linha).toContainText("Cobrança. Aguardando operador disponível.");
    await expect(linha).toContainText("Atendimento assumido");
    await expect(linha).toContainText("Juliana Teste assumiu a conversa.");
    await expect(linha).toContainText("Conversa encerrada");
    await expect(linha).toContainText("Por Juliana Teste.");
    await page.screenshot({ path: `${evidence}/04-linha-do-tempo.png` });

    // Fechada, ela SOME da fila de quem atende.
    await page.goto("/app/inbox?filter=mine");
    await expect(page.locator(`[data-conversation-id="${conversation}"]`)).toHaveCount(0);

    // ─── 4. O cliente volta: atendimento NOVO, protocolo NOVO ───────────────
    await inbound("Voltei, agora é sobre a instalação");
    const segundo = await protocoloDe();
    expect(segundo).toMatch(/^\d{14}$/);
    expect(segundo, "o retorno do cliente abre protocolo novo").not.toBe(primeiro);

    await page.goto(`/app/inbox?filter=all&id=${conversation}`);
    await expect(page.getByTestId("painel-da-conversa").first().getByTestId("protocolo-do-atendimento")).toContainText(segundo);
    // A conversa mostra SÓ o atendimento de agora: a mensagem antiga não está.
    const thread = page.getByTestId("chat-thread");
    await expect(thread).toContainText("Voltei, agora é sobre a instalação");
    await expect(thread).not.toContainText("Quero a segunda via do boleto");

    // ─── 5. O histórico: abrir o atendimento anterior ───────────────────────
    await page.getByTestId("painel-aba-historico").click();
    const historico = page.getByTestId("historico-de-atendimentos");
    await expect(historico.getByTestId("atendimento-do-historico")).toHaveCount(2);
    await expect(historico).toContainText(primeiro);
    await expect(historico).toContainText("Fechada");
    // O trilho diz qual aba está aberta — e só ela.
    await expect(page.getByTestId("painel-aba-historico")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("painel-aba-detalhes")).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(700, 500);
    await page.screenshot({ path: `${evidence}/05-historico.png` });
    await page.getByTestId("painel-trilho").first().screenshot({ path: `${evidence}/05b-trilho.png` });

    await historico.getByTestId("atendimento-do-historico").filter({ hasText: primeiro }).click();
    const aviso = page.getByTestId("aviso-atendimento-antigo");
    await expect(aviso).toContainText(primeiro);
    await expect(thread).toContainText("Quero a segunda via do boleto");
    await expect(thread).not.toContainText("Voltei, agora é sobre a instalação");
    // As ações agem sobre a conversa de HOJE: em cima de um atendimento antigo
    // elas somem, para ninguém fechar o atual achando que mexia no anterior.
    await expect(page.getByTestId("acoes-da-conversa")).toBeHidden();
    // Não se responde num atendimento que acabou.
    await expect(page.getByText("Este atendimento já foi encerrado. Volte ao atendimento atual para responder.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/06-atendimento-antigo.png` });

    await aviso.getByRole("button", { name: "Voltar ao atendimento atual" }).click();
    await expect(aviso).toHaveCount(0);
    await expect(thread).toContainText("Voltei, agora é sobre a instalação");

    // ─── 6. A busca pelo protocolo ANTIGO, de outra aba ─────────────────────
    await page.goto("/app/inbox?filter=mine");
    await page.getByLabel("Buscar conversas").fill(primeiro);
    const achado = page.getByTestId("resultado-por-protocolo").filter({ hasText: primeiro });
    await expect(achado).toBeVisible();
    await expect(achado).toContainText("Fernando Protocolo");
    await page.screenshot({ path: `${evidence}/07-busca-por-protocolo.png` });
    await achado.click();
    await expect(page.getByTestId("aviso-atendimento-antigo")).toContainText(primeiro);
  } finally {
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
