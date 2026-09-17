/**
 * [P1] A tela de Times de atendimento — a porta dos setores.
 *
 * A feature dá destinos humanos por assunto: a IA transfere para Cobrança, para
 * Cancelamentos, para Suporte, e cada setor tem sua fila e seu horário. O
 * backend inteiro (roteamento por time, catálogo em runtime, handoff com slug)
 * não vale nada se o gestor não conseguir CADASTRAR um time — e cadastrar só
 * acontece aqui.
 *
 * Esta spec dirige o FRONTEND, logada, clicando, como a doutrina de QA Visual
 * do repo exige. `curl` na rota provaria o backend, que já tem teste próprio, e
 * não provaria a porta — que é o que costuma faltar.
 *
 * Três coisas que ela mede e que teste de unidade não alcança:
 *   1. a tela é ALCANÇÁVEL pela navegação, não só digitando a URL;
 *   2. o slug é SUGERIDO a partir do nome (sem isso o gestor tem de inventar um
 *      identificador, e o campo vira obstáculo em vez de ajuda);
 *   3. o que foi salvo VOLTA DO BANCO depois do reload — não do estado local do
 *      React, que é o falso positivo clássico de tela de configuração.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisa()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/** Nome único por execução: a spec cria de verdade, e rodar duas vezes não pode colidir. */
const NOME = `Cancelamentos ${Date.now().toString().slice(-6)}`;

test.describe("times de atendimento — a tela que cadastra os setores", () => {
  test.describe.configure({ timeout: 120_000 });

  test.afterAll(async ({ browser }) => {
    // Arquiva o que a spec criou. Sem isto, a execução seguinte encontra a tela
    // suja e um caso que conte cards mediria o resíduo da anterior.
    const page = await browser.newPage();
    await login(page, creds.users.manager!.email);
    const r = await page.request.get("/api/v1/settings/teams");
    if (r.ok()) {
      const { data } = (await r.json()) as { data: { times: Array<{ id: string; name: string }> } };
      for (const t of data.times.filter((x) => x.name === NOME)) {
        await page.request.post(`/api/v1/settings/teams/${t.id}/archive`, { data: { arquivar: true } });
      }
    }
    await page.close();
  });

  test("manager cria um time pela tela, e ele volta do banco depois do reload", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    // 1. A PORTA: chega-se pela navegação, não só pela URL digitada.
    await page.goto("/app/settings");
    const porta = page.getByRole("link", { name: /Times de atendimento/i });
    await expect(porta).toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings\/teams/);
    // 20s e não os 5 do padrão: esta é a PRIMEIRA visita a esta rota num Next.js
    // frio, e a tela é Server Component que vai ao banco duas vezes (times e
    // nomes dos atendentes) antes do primeiro byte. Medido: passou numa execução
    // e estourou os 5s na seguinte, no mesmo commit — o runner de repositório
    // privado tem metade dos núcleos, e a compilação da rota cai inteira nesta
    // espera. Afrouxar o RELÓGIO não afrouxa a asserção: o que se exige continua
    // sendo o painel VISÍVEL, não um `waitForTimeout` que passaria de qualquer jeito.
    await expect(page.getByTestId("painel-de-times")).toBeVisible({ timeout: 20_000 });

    // 2. O formulário de time novo.
    await page.getByRole("button", { name: /Novo time/i }).click();
    await page.locator("#nome-novo").fill(NOME);

    // 3. O SLUG é sugerido a partir do nome — o gestor não inventa identificador.
    await expect(page.locator("#slug-novo")).toHaveValue(/^cancelamentos-\d+$/);

    await page.locator("#quando-novo").fill("Quando o cliente pede para cancelar o contrato.");
    await page.getByRole("button", { name: /^Salvar$/ }).click();

    // 4. O card aparece, com o estado de horário à vista. Time sem janela é 24/7
    //    (janela existe para RESTRINGIR), então nasce aberto.
    const card = page.getByText(NOME, { exact: true });
    await expect(card).toBeVisible();

    // 5. E VOLTA DO BANCO: recarrega e continua lá. Sem este passo, o teste
    //    passaria com o time existindo só no estado do React.
    await page.reload();
    await expect(page.getByText(NOME, { exact: true })).toBeVisible();
  });

  test("agent não entra na tela de times — ela é de manager para cima", async ({ page }) => {
    await login(page, creds.users.agent!.email);
    await page.goto("/app/settings/teams");
    // Não afirma PARA ONDE vai: afirma que o painel não aparece. O destino do
    // redirecionamento é decisão do layout e pode mudar sem que a regra mude.
    await expect(page.getByTestId("painel-de-times")).toHaveCount(0);
  });
});
