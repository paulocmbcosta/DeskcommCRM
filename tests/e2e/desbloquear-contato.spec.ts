/**
 * A PORTA DE VOLTA DO OPT-OUT — provada pela tela, como o gerente faz.
 *
 * Em 2026-09-25 um falso positivo do opt-out calou um cliente e a reversão teve
 * de ser SQL à mão. Este spec dirige o browser logado pelas duas portas (o selo
 * do Inbox e o botão da ficha) e mede, a cada passo, o que a tela mostra E o que
 * o banco guardou.
 *
 * O que ele guarda e nenhum teste unitário guardaria:
 *  1. o bloqueio nasce pelo CAMINHO REAL (`aplicarEfeitosPosEntrada` com o texto
 *     "SAIR"), não por um UPDATE à mão que mentiria sobre a origem;
 *  2. `agent` VÊ o bloqueio e NÃO tem porta — nem na tela nem na API (403);
 *  3. o gerente só confirma depois de escrever o motivo E marcar que conferiu —
 *     o botão não é mais fácil de clicar do que a conversa de conferir;
 *  4. o desbloqueio grava `contact.unblocked` com QUEM e POR QUÊ;
 *  5. se o cliente pedir para sair de novo, o bloqueio volta sozinho.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3047 pnpm exec playwright test tests/e2e/desbloquear-contato.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/desbloquear-contato");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
let sessaoId = "";
let conversaId = "";
let contatoId = "";
const sufixo = `${process.pid}`.slice(-6);
const NOME_DO_CONTATO = `Opt-out Engano ${Date.now()}`;
const MOTIVO_INBOX = "Cliente pediu para cancelar o plano, não para sair da lista.";
const MOTIVO_FICHA = "Conferido por telefone: quer continuar recebendo avisos.";

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * O cliente escreve "SAIR" — pela MESMA função que a ingestão do WhatsApp chama
 * depois de gravar a mensagem. Rodada num processo `tsx` porque ela importa o
 * app inteiro pelo alias `@/`.
 */
function clienteEscreveSair(): void {
  const script = `
    import { createClient } from "@supabase/supabase-js";
    import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
    import { credenciaisSupabaseDeTeste } from "./lib/env-de-teste";
    const c = credenciaisSupabaseDeTeste();
    const db = createClient(c.url, c.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    async function main() {
      await aplicarEfeitosPosEntrada(db, {
        organizationId: ${JSON.stringify(creds.org_id)},
        contactId: ${JSON.stringify(contatoId)},
        conversationId: ${JSON.stringify(conversaId)},
        messageId: null,
        channelSessionId: ${JSON.stringify(sessaoId)},
        texto: "SAIR",
        nomeDoContato: null,
        origem: "e2e-desbloquear-contato",
      });
      console.info("SAIR_OK");
    }
    void main();
  `;
  const tmp = path.join(process.cwd(), "scripts", `zz-sair-${sufixo}.ts`);
  fs.writeFileSync(tmp, script);
  try {
    const saida = execFileSync("npx", ["tsx", tmp], { encoding: "utf8" });
    expect(saida, "o pedido de saída precisa ter sido processado").toContain("SAIR_OK");
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function contatoNoBanco(): Promise<{ is_blocked: boolean; blocked_reason: string | null; blocked_at: string | null }> {
  const { data, error } = await admin
    .from("contacts")
    .select("is_blocked, blocked_reason, blocked_at")
    .eq("id", contatoId)
    .single();
  if (error) throw new Error(`leitura do contato falhou: ${error.message}`);
  return data as { is_blocked: boolean; blocked_reason: string | null; blocked_at: string | null };
}

async function desbloqueiosAuditados(): Promise<Array<{ actor_user_id: string; metadata: Record<string, unknown> }>> {
  const { data, error } = await admin
    .from("api_audit_log")
    .select("actor_user_id, metadata, created_at")
    .eq("organization_id", creds.org_id)
    .eq("action", "contact.unblocked")
    .eq("resource_id", contatoId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`leitura da auditoria falhou: ${error.message}`);
  return (data ?? []) as Array<{ actor_user_id: string; metadata: Record<string, unknown> }>;
}

test.describe("Desbloquear contato — a porta de volta do opt-out", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

    const { data: sessao } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    sessaoId = (sessao as { id: string } | null)?.id ?? "";
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-desbloquear-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_preview: "SAIR",
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    clienteEscreveSair();
    const depois = await contatoNoBanco();
    expect(depois.is_blocked, "o caminho real do opt-out tem de ter bloqueado").toBe(true);
    expect(depois.blocked_reason).toBe("stop_keyword");
  });

  test("atendente (agent) VÊ o bloqueio, mas não tem porta — nem na tela nem na API", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.goto(`/app/inbox/${conversaId}`);
    const selo = page.getByTestId("badge-atendimento-humano");
    await expect(selo).toHaveText(/pediu para não receber mensagens/i, { timeout: 30_000 });
    // Para quem não pode desbloquear, o selo é só selo: botão que a rota
    // recusaria seria controle decorativo.
    expect(await selo.evaluate((el) => el.tagName)).not.toBe("BUTTON");

    await page.goto(`/app/contacts/${contatoId}`);
    await expect(page.locator("header").getByText("Bloqueado", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("desbloquear-contato")).toHaveCount(0);
    await captura(page, "01-agent-ve-bloqueio-sem-porta");

    // E a API recusa, com a mesma régua.
    const r = await page.request.post(`/api/v1/contacts/${contatoId}/unblock`, {
      data: { motivo: "tentando desbloquear como atendente" },
    });
    expect(r.status()).toBe(403);
    expect((await contatoNoBanco()).is_blocked, "agent não pode ter desbloqueado").toBe(true);
  });

  test("gerente desbloqueia pelo selo do Inbox, com motivo e conferência, e a auditoria guarda", async ({ page }) => {
    const gerente = creds.users.manager!;
    await login(page, gerente.email);

    await page.goto(`/app/inbox/${conversaId}`);
    const selo = page.getByRole("button", { name: /pediu para não receber mensagens/i });
    await expect(selo).toBeVisible({ timeout: 30_000 });
    await selo.click();

    const dialogo = page.getByTestId("dialogo-desbloquear-contato");
    await expect(dialogo).toBeVisible();
    // A confirmação diz o que está em jogo, não só "tem certeza?".
    await expect(dialogo.getByText(/pode ter sido um pedido de verdade/i)).toBeVisible();
    await expect(dialogo.getByText(/LGPD/)).toBeVisible();

    const confirmar = dialogo.getByTestId("confirmar-desbloqueio");
    await expect(confirmar).toBeDisabled();

    await dialogo.getByLabel(/motivo do desbloqueio/i).fill(MOTIVO_INBOX);
    // Motivo sozinho não basta: falta afirmar que conferiu a conversa.
    await expect(confirmar).toBeDisabled();
    await dialogo.getByRole("checkbox").check();
    await expect(confirmar).toBeEnabled();
    await captura(page, "02-gerente-dialogo-preenchido");

    await confirmar.click();
    await expect(page.getByText(/contato desbloqueado/i)).toBeVisible({ timeout: 20_000 });
    await expect(dialogo).toHaveCount(0);

    // O BANCO, não a cor da tela.
    const depois = await contatoNoBanco();
    expect(depois).toEqual({ is_blocked: false, blocked_reason: null, blocked_at: null });

    const auditoria = await desbloqueiosAuditados();
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]!.actor_user_id).toBe(gerente.id);
    expect(auditoria[0]!.metadata).toMatchObject({
      motivo: MOTIVO_INBOX,
      blocked_reason_anterior: "stop_keyword",
    });

    // O selo do opt-out saiu da tela (a lista de conversas foi reconsultada).
    await expect(page.getByText(/pediu para não receber mensagens/i)).toHaveCount(0, { timeout: 20_000 });
    await page.reload();
    await expect(page.getByTestId("acoes-da-conversa")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/pediu para não receber mensagens/i)).toHaveCount(0);
    await captura(page, "03-inbox-sem-selo-depois");
  });

  test("se o cliente pedir para sair de novo, bloqueia de novo — e a ficha também desbloqueia", async ({ page }) => {
    clienteEscreveSair();
    expect((await contatoNoBanco()).is_blocked, "o desbloqueio não imuniza ninguém").toBe(true);

    await login(page, creds.users.manager!.email);
    await page.goto(`/app/contacts/${contatoId}`);
    await expect(page.locator("header").getByText("Bloqueado", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("desbloquear-contato").click();
    const dialogo = page.getByTestId("dialogo-desbloquear-contato");
    // A ficha tem a data do bloqueio — e o diálogo a cita.
    await expect(dialogo.getByText(/bloqueado em \d{2}\/\d{2}\/\d{4}/i)).toBeVisible();
    await dialogo.getByLabel(/motivo do desbloqueio/i).fill(MOTIVO_FICHA);
    await dialogo.getByRole("checkbox").check();
    await captura(page, "04-ficha-dialogo");
    await dialogo.getByTestId("confirmar-desbloqueio").click();

    await expect(page.getByText(/contato desbloqueado/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("desbloquear-contato")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator("header").getByText("Bloqueado", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.locator("h1")).toContainText(NOME_DO_CONTATO, { timeout: 30_000 });
    await expect(page.locator("header").getByText("Bloqueado", { exact: true })).toHaveCount(0);
    await captura(page, "05-ficha-desbloqueada");

    expect((await contatoNoBanco()).is_blocked).toBe(false);
    const auditoria = await desbloqueiosAuditados();
    expect(auditoria.map((a) => a.metadata.motivo)).toEqual([MOTIVO_INBOX, MOTIVO_FICHA]);
  });
});
