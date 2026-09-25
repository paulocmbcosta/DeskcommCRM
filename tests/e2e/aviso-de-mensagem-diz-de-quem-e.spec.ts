/**
 * O AVISO DE MENSAGEM DIZ DE QUEM É — pela tela, como o atendente o vê.
 *
 * Pedido do dono (2026-09-25): o aviso chegava só com o texto do cliente, e o
 * atendente com várias conversas abertas não sabia de quem era. Aqui se prova:
 *
 *   1. fora do Inbox, a mensagem que chega vira um aviso com o NOME do contato,
 *      o TIME da conversa e com quem ela está, e a prévia do texto;
 *   2. a rajada do mesmo cliente ATUALIZA o aviso ("2 mensagens") em vez de
 *      empilhar um por mensagem; mídia chega dita por extenso ("🎤 Áudio");
 *   3. a rajada pede o contexto UMA vez — o cache que impede o aviso de virar
 *      carga no banco, medido nas requisições do próprio navegador — e pela
 *      rota autenticada: a consulta REST direta do navegador saía ANÔNIMA
 *      (cookie httpOnly), a RLS devolvia vazio, e era por isso que o aviso
 *      chegava sem nome;
 *   4. clicar no aviso abre a conversa.
 *
 * Organização, time, contato e conversa nascem pelo banco (service role); a
 * mensagem entra por INSERT, e o aviso chega pelo Realtime de verdade — o mesmo
 * caminho da produção, sem mock.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { expect, test } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/aviso-de-mensagem-diz-de-quem-e";

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

test("o aviso de mensagem diz quem, de qual time, e abre a conversa", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(evidence, { recursive: true });

  const password = `Local-${randomUUID()}!`;
  const email = `aviso-${randomUUID()}@invariant.test`;
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
    slug: `aviso-${randomUUID()}`,
    onboarded_at: new Date().toISOString(),
  });
  // Atendente: o caso do pedido — várias conversas suas, e o padrão dele é
  // "só as minhas" (0281).
  const membership = await db.from("user_organizations").insert({
    organization_id: org,
    user_id: user,
    role: "agent",
    accepted_at: new Date().toISOString(),
  });
  if (membership.error) throw membership.error;

  const canal = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: `aviso-${randomUUID()}`,
    display_name: "Totus",
    phone_number: "+551130250000",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const financeiro = randomUUID();
  await sql(
    `insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, 'Financeiro', 'financeiro')`,
    [financeiro, org],
  );
  await sql(
    `insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`,
    [org, financeiro, user],
  );
  const contato = await insert("contacts", {
    organization_id: org,
    display_name: "Maria Souza",
    phone_number: "+5532984790001",
  });
  const conversa = await insert("conversations", {
    organization_id: org,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    team_id: financeiro,
    assignee_kind: "user",
    assigned_to_user_id: user,
    assigned_to_user_name: "Ana Atendente",
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // Quantas vezes o NAVEGADOR pede o contexto da conversa — cada pedido é uma
  // leitura no banco, e cada navegador aberto da organização faz a sua.
  const leiturasDaConversa: string[] = [];
  // E nenhuma consulta REST direta: ela sairia anônima (cookie httpOnly) e a RLS
  // devolveria vazio — o defeito que deixava o aviso sem nome.
  const consultasAnonimas: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes(`/api/v1/conversations/${conversa}/aviso`)) leiturasDaConversa.push(u);
    if (u.includes("/rest/v1/") && /conversations|contacts/.test(u) && u.includes(conversa)) {
      consultasAnonimas.push(u);
    }
  });

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
  // Fora do Inbox: é onde o aviso é a ÚNICA forma de saber que alguém escreveu.
  await page.goto("/app/contacts");
  await expect(page.locator("main")).toBeVisible();
  // O canal Realtime do aviso precisa estar assinado antes da mensagem chegar.
  await page.waitForTimeout(4_000);

  async function chega(tipo: string, corpo: string | null): Promise<void> {
    const { error } = await db.from("messages").insert({
      organization_id: org,
      conversation_id: conversa,
      channel_session_id: canal,
      contact_id: contato,
      direction: "inbound",
      status: "delivered",
      type: tipo,
      body: corpo,
      metadata: {},
      external_id: `wamid.aviso.${randomUUID()}`,
      sent_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  // 1. Quem, de onde, o quê.
  await chega("text", "Quero a segunda via do boleto");
  const aviso = page.getByTestId("toast-de-mensagem");
  await expect(aviso).toHaveCount(1, { timeout: 20_000 });
  await expect(aviso.getByTestId("toast-de-mensagem-nome")).toHaveText("Maria Souza");
  await expect(aviso.getByTestId("toast-de-mensagem-contexto")).toHaveText("Financeiro · com você");
  await expect(aviso.getByTestId("toast-de-mensagem-previa")).toHaveText("Quero a segunda via do boleto");
  await page.screenshot({ path: `${evidence}/01-aviso-com-nome-e-time.png` });

  // 2. Rajada: o mesmo aviso, atualizado — não um segundo cartão.
  await chega("audio", null);
  await expect(aviso.getByTestId("toast-de-mensagem-previa")).toHaveText("🎤 Áudio", { timeout: 20_000 });
  await expect(aviso).toHaveCount(1);
  await expect(aviso).toContainText("2 mensagens");
  await page.screenshot({ path: `${evidence}/02-rajada-no-mesmo-aviso.png` });

  // 3. A rajada leu a conversa uma vez só (a segunda mensagem veio do cache).
  expect(leiturasDaConversa).toHaveLength(1);
  expect(consultasAnonimas).toEqual([]);

  // 4. O cartão abre a conversa.
  await aviso.getByRole("button", { name: /Abrir conversa com Maria Souza/ }).click();
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversa}`), { timeout: 20_000 });
  await page.screenshot({ path: `${evidence}/03-clique-abre-a-conversa.png` });

  await context.close();
});
