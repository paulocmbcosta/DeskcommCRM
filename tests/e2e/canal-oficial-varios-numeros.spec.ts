/**
 * DOIS NÚMEROS DA API OFICIAL NA MESMA ORGANIZAÇÃO — pela tela.
 *
 * ## O defeito que esta spec vigia
 *
 * Medido em 2026-09-23, na primeira organização com dois números oficiais (de
 * contas diferentes da Meta): a tela de Conexões conhecia UM canal oficial.
 * Conectar o segundo número ATUALIZAVA a linha do primeiro — as conversas dele
 * passavam a apontar para outro número —, e com duas linhas no banco a tela
 * dizia "não conectado". O resto do canal (webhook, ingestão, envio) já era por
 * número; a porta de entrada é que não era.
 *
 * ## O que ela prova, pelo caminho do operador
 *
 *   1. dois números conectados aparecem os DOIS, cada um com a SUA URL de
 *      webhook — é ela que o operador cola na Meta, e trocar uma pela outra
 *      entregaria as mensagens de um número na caixa do outro;
 *   2. "Trocar credencial" de um número trava o ID dele (mudá-lo criaria um
 *      canal novo em vez de trocar a credencial daquele);
 *   3. tentar conectar um TERCEIRO número com credencial ruim é recusado com o
 *      motivo da Meta — Graph API REAL, sem mock — e os dois continuam intactos.
 *
 * Os dois canais nascem pelo banco (service role), não pela tela: conectar pela
 * tela exige credencial VÁLIDA da Meta, que este ambiente não tem. O caminho de
 * sucesso da conexão está nos testes de unidade da rota
 * (`tests/unit/canal-arquivado-caminho-de-volta.test.ts`, "o segundo número é
 * um canal NOVO").
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
  process.env.CANAIS_EVIDENCE_DIR ?? ".superpowers/evidence/canal-oficial-varios-numeros",
);
fs.mkdirSync(EVIDENCE, { recursive: true });

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

/** Ids novos a cada execução: este Supabase é compartilhado entre frentes. */
const sufixo = Date.now().toString().slice(-8);
const PRIMEIRO = { pnid: `90${sufixo}01`, waba: `80${sufixo}01`, telefone: "+556130252461" };
const SEGUNDO = { pnid: `90${sufixo}02`, waba: `80${sufixo}02`, telefone: "+556140637232" };
const criados: string[] = [];

test.beforeAll(async () => {
  const { org_id: orgId } = lerCreds() as unknown as { org_id: string };
  for (const [i, n] of [PRIMEIRO, SEGUNDO].entries()) {
    const { data, error } = await db
      .from("channel_sessions")
      .insert({
        organization_id: orgId,
        provider: "meta_cloud",
        meta_phone_number_id: n.pnid,
        meta_waba_id: n.waba,
        // Um valor qualquer: a tela só diz que a credencial EXISTE.
        meta_token_encrypted: "\\x01",
        // O segundo entrega por OUTRO app da Meta (migration 0275).
        ...(i === 1 ? { meta_app_secret_encrypted: "\\x02" } : {}),
        webhook_secret_encrypted: "\\x01",
        webhook_path_token: randomBytes(16).toString("hex"),
        phone_number: n.telefone,
        display_name: i === 0 ? "Totus 3025" : "Totus 4063",
        status: "WORKING",
      })
      .select("id")
      .single();
    if (error) throw error;
    criados.push(data.id as string);
  }
});

test.afterAll(async () => {
  if (criados.length > 0) await db.from("channel_sessions").delete().in("id", criados);
});

/** O cartão de um número, achado pelo telefone que ele mostra. */
function cartao(page: Page, telefone: string) {
  return page.getByTestId("canal-conectado").filter({ hasText: telefone });
}

test("⭐ os dois números aparecem, cada um com a sua URL de webhook", async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/connections?aba=oficial");
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });

  const um = cartao(page, PRIMEIRO.telefone);
  const dois = cartao(page, SEGUNDO.telefone);
  await expect(um).toBeVisible();
  await expect(dois).toBeVisible();

  const urlDe = async (c: ReturnType<typeof cartao>) =>
    (await c.locator("code").filter({ hasText: "/api/v1/webhooks/meta/" }).innerText()).trim();
  const urlUm = await urlDe(um);
  const urlDois = await urlDe(dois);
  expect(urlUm).toMatch(/\/api\/v1\/webhooks\/meta\/[0-9a-f]{32}$/);
  expect(urlDois).toMatch(/\/api\/v1\/webhooks\/meta\/[0-9a-f]{32}$/);
  expect(urlUm).not.toBe(urlDois);

  // O segundo entrega por outro app da Meta, e a tela diz isso sem mostrar o segredo.
  await expect(dois.getByTestId("app-proprio")).toBeVisible();
  await expect(um.getByTestId("app-proprio")).toHaveCount(0);

  // Com números conectados, o formulário é de ACRESCENTAR, não de substituir.
  await expect(page.getByTestId("titulo-form-oficial")).toHaveText("Adicionar outro número");
  await page.screenshot({ path: `${EVIDENCE}/01-dois-numeros.png`, fullPage: true });
});

test("trocar a credencial de um número trava o ID dele", async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/connections?aba=oficial");
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });

  await cartao(page, SEGUNDO.telefone).getByTestId("btn-trocar-credencial").click();
  await expect(page.getByTestId("titulo-form-oficial")).toContainText("Trocar credencial");
  await expect(page.getByTestId("titulo-form-oficial")).toContainText(SEGUNDO.telefone);
  await expect(page.locator("#pnid")).toHaveValue(SEGUNDO.pnid);
  await expect(page.locator("#pnid")).toHaveAttribute("readonly", "");
  await expect(page.locator("#waba")).toHaveValue(SEGUNDO.waba);
  await page.screenshot({ path: `${EVIDENCE}/02-trocar-credencial.png`, fullPage: true });

  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByTestId("titulo-form-oficial")).toHaveText("Adicionar outro número");
  await expect(page.locator("#pnid")).toHaveValue("");
  await expect(page.locator("#pnid")).not.toHaveAttribute("readonly", "");
});

test("terceiro número com credencial ruim: a Meta recusa e os dois ficam intactos", async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/connections?aba=oficial");
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });

  await page.locator("#pnid").fill("000000000000000");
  await page.locator("#waba").fill("000000000000000");
  await page.locator("#tok").fill("EAAtoken-invalido-de-proposito-para-o-teste");
  await page.getByTestId("campo-app-secret").fill("segredo-invalido-de-proposito-32c");

  const resposta = page.waitForResponse(
    (r) => r.url().includes("/api/v1/channels/official") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByTestId("btn-conectar").click();
  // 422, não 500: credencial ruim é entrada inválida, não falha nossa.
  expect((await resposta).status()).toBe(422);
  await page.screenshot({ path: `${EVIDENCE}/03-terceiro-recusado.png`, fullPage: true });

  await page.reload();
  await expect(page.getByTestId("canal-oficial-root")).toBeVisible({ timeout: 20_000 });
  await expect(cartao(page, PRIMEIRO.telefone)).toContainText(PRIMEIRO.pnid);
  await expect(cartao(page, SEGUNDO.telefone)).toContainText(SEGUNDO.pnid);
  await expect(page.getByTestId("canal-conectado").filter({ hasText: "000000000000000" })).toHaveCount(0);
});
