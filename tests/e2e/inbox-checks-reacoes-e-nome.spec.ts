/**
 * CANAL OFICIAL: CHECKS, REAÇÕES E O NOME DE QUEM RESPONDEU — pela tela.
 *
 * Três pedidos do dono (Linear DYD-15, DYD-16, DYD-13), provados como o
 * atendente os vê:
 *
 *   1. a bolha enviada mostra um check (enviada), dois (entregue) e dois azuis
 *      (lida) — em produção, 300 de 300 mensagens do número oficial ficavam em
 *      um check, porque o webhook gravava tudo como `sent`;
 *   2. a mensagem do COLEGA traz o nome dele, não "Atendente";
 *   3. a reação do cliente aparece colada ao balão, e o botão de ações do
 *      balão leva a "Responder" e "Reagir" (seis emojis + "+");
 *   4. reagir sem credencial válida: a tela diz por que a reação não saiu, e
 *      ela NÃO fica no balão — sem mock da rota.
 *
 * O canal, a conversa e as mensagens nascem pelo banco (service role): um
 * status de entrega de verdade exige a Meta entregando a um celular, que este
 * ambiente não tem. O caminho webhook → status está nos testes de unidade
 * (`tests/unit/meta-status-e-reacao.test.ts`) e no invariante da 0276.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ mode: "serial", timeout: 90_000 });

const EVIDENCE = path.join(
  process.cwd(),
  process.env.REACOES_EVIDENCE_DIR ?? ".superpowers/evidence/inbox-checks-reacoes-e-nome",
);
fs.mkdirSync(EVIDENCE, { recursive: true });

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const sufixo = Date.now().toString().slice(-8);
const NOME_DO_COLEGA = "Daniel Colega";
let sessaoId = "";
let contatoId = "";
let conversaId = "";
let colegaId = "";

test.beforeAll(async () => {
  const creds = lerCreds() as unknown as { org_id: string; users: { admin?: { email: string } } };
  const orgId = creds.org_id;

  const { data: sessao, error: e1 } = await db
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      provider: "meta_cloud",
      meta_phone_number_id: `91${sufixo}`,
      meta_waba_id: `81${sufixo}`,
      meta_token_encrypted: "\\x01",
      webhook_secret_encrypted: "\\x01",
      webhook_path_token: randomBytes(16).toString("hex"),
      phone_number: "+556130250000",
      display_name: "Oficial e2e reações",
      status: "WORKING",
    })
    .select("id")
    .single();
  if (e1) throw e1;
  sessaoId = sessao.id as string;

  const { data: contato, error: e2 } = await db
    .from("contacts")
    .insert({
      organization_id: orgId,
      display_name: `Cliente Reação ${sufixo}`,
      phone_number: `+55619${sufixo.slice(0, 8)}`,
    })
    .select("id")
    .single();
  if (e2) throw e2;
  contatoId = contato.id as string;

  const { data: conv, error: e3 } = await db.rpc("fn_upsert_wa_conversation", {
    p_org: orgId,
    p_contact: contatoId,
    p_session: sessaoId,
  });
  if (e3) throw e3;
  conversaId = conv as string;
  // Janela de 24h ABERTA: o cliente escreveu agora há pouco.
  await db
    .from("conversations")
    .update({ last_inbound_at: new Date().toISOString() })
    .eq("id", conversaId);

  const { data: colega, error: e4 } = await db.auth.admin.createUser({
    email: `colega-${sufixo}@e2e.test`,
    password: randomBytes(12).toString("hex"),
    email_confirm: true,
    user_metadata: { full_name: NOME_DO_COLEGA },
  });
  if (e4) throw e4;
  colegaId = colega.user.id;
  await db
    .from("user_organizations")
    .insert({
      user_id: colegaId,
      organization_id: orgId,
      role: "agent",
      accepted_at: new Date().toISOString(),
    });

  const base = {
    organization_id: orgId,
    conversation_id: conversaId,
    channel_session_id: sessaoId,
    contact_id: contatoId,
    type: "text",
  };
  const t0 = Date.now() - 10 * 60_000;
  const em = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const { error: e5 } = await db.from("messages").insert([
    {
      ...base,
      direction: "inbound",
      status: "delivered",
      sent_via: "ai",
      body: "Oi, minha internet caiu",
      external_id: `wamid.e2e.${sufixo}.1`,
      sent_at: em(0),
    },
    {
      ...base,
      direction: "outbound",
      status: "read",
      sent_via: "user",
      sent_by_user_id: colegaId,
      body: "Já estou verificando para você",
      external_id: `wamid.e2e.${sufixo}.2`,
      sent_at: em(1),
      metadata: { reacoes: { contato: { emoji: "🙏", em: em(2) } } },
    },
    {
      ...base,
      direction: "outbound",
      status: "delivered",
      sent_via: "user",
      sent_by_user_id: colegaId,
      body: "Pode reiniciar o roteador?",
      external_id: `wamid.e2e.${sufixo}.3`,
      sent_at: em(3),
    },
    {
      ...base,
      direction: "outbound",
      status: "sent",
      sent_via: "user",
      sent_by_user_id: colegaId,
      body: "Aguardo seu retorno",
      external_id: `wamid.e2e.${sufixo}.4`,
      sent_at: em(4),
    },
  ]);
  if (e5) throw e5;
});

test.afterAll(async () => {
  if (conversaId) await db.from("messages").delete().eq("conversation_id", conversaId);
  if (conversaId) await db.from("conversations").delete().eq("id", conversaId);
  if (contatoId) await db.from("contacts").delete().eq("id", contatoId);
  if (sessaoId) await db.from("channel_sessions").delete().eq("id", sessaoId);
  if (colegaId) await db.auth.admin.deleteUser(colegaId);
});

async function abrirConversa(page: Page) {
  await loginComoAdmin(page, lerCreds());
  await page.goto(`/app/inbox?id=${conversaId}&filter=all`);
  await expect(page.getByText("Oi, minha internet caiu")).toBeVisible({ timeout: 20_000 });
}

test("⭐ checks, nome do colega e a reação do cliente no balão", async ({ page }) => {
  await abrirConversa(page);

  // DYD-13: o nome, não o rótulo genérico.
  await expect(page.getByText(NOME_DO_COLEGA).first()).toBeVisible();
  await expect(page.getByText("Atendente", { exact: true })).toHaveCount(0);

  // DYD-15: um check, dois, dois azuis.
  await expect(page.getByLabel("Lida")).toHaveCount(1);
  await expect(page.getByLabel("Entregue")).toHaveCount(1);
  await expect(page.getByLabel("Enviada")).toHaveCount(1);
  const corDaLida = await page.getByLabel("Lida").evaluate((el) => getComputedStyle(el).color);
  expect(corDaLida).toBe("rgb(83, 189, 235)");

  // DYD-16: a reação do cliente, colada ao balão da mensagem certa.
  const reacao = page.getByTestId("reacoes-do-balao");
  await expect(reacao).toHaveCount(1);
  await expect(reacao).toContainText("🙏");
  const balao = page.getByText("Já estou verificando para você");
  const [rb, rr] = await Promise.all([balao.boundingBox(), reacao.boundingBox()]);
  // Encostada na borda de baixo do balão (sobrepõe alguns px), não solta na conversa.
  expect(rr!.y).toBeGreaterThan(rb!.y);
  expect(rr!.y - (rb!.y + rb!.height)).toBeLessThan(24);

  await page.screenshot({ path: `${EVIDENCE}/01-checks-nome-reacao.png`, fullPage: false });
});

test("o botão de ações leva a Responder e Reagir, com os emojis e o +", async ({ page }) => {
  await abrirConversa(page);
  await page.getByText("Oi, minha internet caiu").hover();
  await page.getByRole("button", { name: "Ações da mensagem" }).first().click();
  await expect(page.getByRole("button", { name: "Responder a esta mensagem" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/02-menu-de-acoes.png` });

  await page.getByRole("button", { name: "Reagir", exact: true }).click();
  for (const e of ["👍", "❤️", "😂", "😮", "😢", "🙏"]) {
    await expect(page.getByRole("button", { name: `Reagir com ${e}` })).toBeVisible();
  }
  await page.screenshot({ path: `${EVIDENCE}/03-emojis.png` });

  await page.getByRole("button", { name: "Mais emojis" }).click();
  await expect(page.getByRole("group", { name: "Todos os emojis" })).toBeVisible();
  await expect(page.getByLabel("Outro emoji")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/04-mais-emojis.png` });
});

test("sem credencial válida: a tela diz por quê, e a reação não fica", async ({ page }) => {
  await abrirConversa(page);
  await page.getByText("Oi, minha internet caiu").hover();
  await page.getByRole("button", { name: "Ações da mensagem" }).first().click();
  await page.getByRole("button", { name: "Reagir", exact: true }).click();

  const resposta = page.waitForResponse((r) => r.url().includes("/reaction"));
  await page.getByRole("button", { name: "Reagir com 👍" }).click();
  const r = await resposta;
  expect([502, 422]).toContain(r.status());

  await expect(page.getByText(/recusou a reação|não tem credencial da Meta/i).first()).toBeVisible({
    timeout: 15_000,
  });
  // Só a reação do CLIENTE (🙏) continua na conversa; o 👍 otimista voltou atrás.
  await expect(page.getByTestId("reacoes-do-balao")).toHaveCount(1);
  await page.screenshot({ path: `${EVIDENCE}/05-meta-recusou.png` });
});
