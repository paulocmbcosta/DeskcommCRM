/**
 * CADASTRAR MEMBRO JÁ COM SENHA — e a pessoa entra com ela. Pela TELA.
 *
 * O pedido (2026-09-22): "cadastrar um membro da equipe e, ao invés de receber
 * o convite, eu já cadastrasse a senha dele aqui dentro". A instalação do teste
 * não tem envio de e-mail configurado — o estado real de toda VPS recém-
 * instalada, e o motivo de o convite não servir ali.
 *
 * O que só a tela prova, e por isso está aqui e não num teste de rota:
 *
 *  1. a PORTA: de Equipe, "Adicionar membros" leva ao cadastro, que é a aba
 *     aberta por padrão;
 *  2. "Gerar senha" preenche E MOSTRA — senha gerada que ninguém viu não se
 *     passa adiante;
 *  3. o cartão de dados de acesso mostra endereço, e-mail e a senha;
 *  4. a pessoa ENTRA com essa senha, num navegador limpo, e cai no app;
 *  5. "Definir nova senha" no menu do membro: a antiga para de valer, a nova
 *     entra — o laço de quem esqueceu a senha sem ter e-mail;
 *  6. recadastrar o mesmo e-mail explica, na tela, que a pessoa já é da equipe.
 *
 * E o banco confirma o que a tela não mostra: vínculo `agent` aceito na org do
 * admin, e a auditoria `member.created` sem a senha.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const EVIDENCIA = ".superpowers/evidence/equipe-cadastro-com-senha";
const email = `membro-senha-${randomUUID().slice(0, 8)}@deskcomm.test`;
const nome = "Maria Cadastro Direto";
let criadoId: string | null = null;

test.describe.configure({ mode: "serial", timeout: 240_000 });

test.afterAll(async () => {
  // O banco é compartilhado pelas specs: a conta de teste não fica para trás.
  if (criadoId) {
    await db.from("user_organizations").delete().eq("user_id", criadoId);
    await db.auth.admin.deleteUser(criadoId);
  }
});

// `browser.newContext()` NÃO herda o `use` do config: sem o `baseURL`
// explícito, `goto("/login")` não tem para onde ir.
async function entrarComo(browser: Browser, baseURL: string, senha: string): Promise<Page> {
  const contexto = await browser.newContext({ baseURL });
  const pagina = await contexto.newPage();
  await pagina.goto("/login");
  await pagina.locator("#email").fill(email);
  await pagina.locator("#password").fill(senha);
  await pagina.getByRole("button", { name: /entrar/i }).click();
  return pagina;
}

test("admin cadastra com senha gerada e a pessoa entra com ela", async ({ page, browser, baseURL }) => {
  if (!baseURL) throw new Error("baseURL ausente no config do Playwright");
  mkdirSync(EVIDENCIA, { recursive: true });
  await loginComoAdmin(page, lerCreds());

  // 1. A porta: de Equipe, sem digitar URL.
  await page.goto("/app/team");
  await page.getByRole("link", { name: "Adicionar membros" }).click();
  await page.waitForURL("**/app/team/invite");
  await expect(page.getByRole("tab", { name: "Cadastrar com senha" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByLabel("Nome", { exact: true }).fill(nome);
  await page.getByLabel("E-mail", { exact: true }).fill(email);

  // 2. Gerar preenche E mostra.
  await page.getByRole("button", { name: "Gerar senha" }).click();
  const campo = page.getByLabel("Senha", { exact: true });
  await expect(campo).toHaveAttribute("type", "text");
  const senha = await campo.inputValue();
  expect(senha).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);

  await page.getByRole("button", { name: "Cadastrar membro" }).click();

  // 3. O cartão de acesso — com a senha que foi digitada, não uma da API.
  const cartao = page.getByRole("region", { name: "Dados de acesso" });
  await expect(cartao).toBeVisible({ timeout: 20_000 });
  await expect(cartao).toContainText(`${nome} já pode entrar.`);
  await expect(cartao).toContainText(email);
  await expect(cartao).toContainText(senha);
  await expect(cartao).toContainText("/login");
  // O formulário limpa para o próximo cadastro.
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue("");
  await page.screenshot({ path: `${EVIDENCIA}/1-cartao-de-acesso.png` });

  // O banco: vínculo aceito, papel agent, na org de quem cadastrou.
  const { data: vinculos } = await db
    .from("user_organizations")
    .select("user_id, role, accepted_at, revoked_at, organization_id")
    .eq("role", "agent")
    .is("revoked_at", null)
    .not("accepted_at", "is", null);
  const { data: contas } = await db.auth.admin.listUsers({ perPage: 1000 });
  const conta = contas.users.find((u) => u.email === email);
  expect(conta, "conta criada no provedor de auth").toBeTruthy();
  criadoId = conta!.id;
  expect(conta!.email_confirmed_at, "e-mail já confirmado — sem caixa de entrada").toBeTruthy();
  expect(conta!.user_metadata?.full_name).toBe(nome);
  expect(vinculos?.some((v) => v.user_id === criadoId)).toBe(true);

  const { data: auditoria } = await db
    .from("api_audit_log")
    .select("action, metadata")
    .eq("action", "member.created")
    .eq("metadata->>target_user_id", criadoId);
  expect(auditoria?.length).toBe(1);
  expect(JSON.stringify(auditoria)).not.toContain(senha);

  // 4. A pessoa entra, num navegador que nunca viu o admin.
  const membro = await entrarComo(browser, baseURL, senha);
  await membro.waitForURL(/\/app\//, { timeout: 30_000 });
  await expect(membro.getByText("Você não tem nenhuma organização ativa")).toHaveCount(0);
  await membro.waitForLoadState("networkidle");
  await membro.screenshot({ path: `${EVIDENCIA}/2-membro-entrou.png` });
  await membro.context().close();

  // 6. Recadastrar o mesmo e-mail explica, na tela.
  await page.getByLabel("Nome", { exact: true }).fill(nome);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("outra-senha-123");
  await page.getByRole("button", { name: "Cadastrar membro" }).click();
  // `filter`: o anunciador de rota do Next também é `role="alert"`.
  await expect(
    page.getByRole("alert").filter({ hasText: "Esta pessoa já faz parte da equipe." }),
  ).toBeVisible();
  await page.screenshot({ path: `${EVIDENCIA}/3-ja-e-membro.png` });

  // 5. Definir nova senha pelo menu do membro.
  await page.goto("/app/team?aba=membros");
  const linha = page.locator("tr").filter({ hasText: email });
  await expect(linha).toBeVisible({ timeout: 20_000 });
  await linha.getByRole("button", { name: "Ações" }).click();
  await page.getByRole("menuitem", { name: "Definir nova senha" }).click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toContainText(nome);
  await dialogo.getByRole("button", { name: "Gerar senha" }).click();
  const novaSenha = await dialogo.getByLabel("Senha", { exact: true }).inputValue();
  expect(novaSenha).not.toBe(senha);
  await page.screenshot({ path: `${EVIDENCIA}/4-definir-nova-senha.png` });
  await dialogo.getByRole("button", { name: "Salvar senha" }).click();
  await expect(dialogo).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(`Senha nova definida para ${nome}.`)).toBeVisible();

  // A antiga não entra mais…
  const comAntiga = await entrarComo(browser, baseURL, senha);
  await expect(comAntiga.getByText("Email ou senha incorretos.")).toBeVisible({ timeout: 20_000 });
  await comAntiga.context().close();

  // …e a nova entra.
  const comNova = await entrarComo(browser, baseURL, novaSenha);
  await comNova.waitForURL(/\/app\//, { timeout: 30_000 });
  await comNova.waitForLoadState("networkidle");
  await comNova.screenshot({ path: `${EVIDENCIA}/5-entrou-com-a-nova.png` });
  await comNova.context().close();
});
