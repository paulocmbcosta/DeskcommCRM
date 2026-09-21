/**
 * A barra lateral nasce RECOLHIDA e o Inbox usa a tela inteira — prova pela TELA
 * (DoD item 12), medida por ferramenta e nunca a olho.
 *
 * ─── O que o dono pediu, em três frases ─────────────────────────────────────
 *
 *  1. o chat perdia um respiro à esquerda (junto da barra), à direita e em cima
 *     (junto da linha do cabeçalho) — para ganhar espaço, esse respiro sai;
 *  2. a barra lateral vem recolhida por padrão, e quem quiser as funções a abre;
 *  3. alguns ícones da barra se repetiam (os três "Ver tudo em …").
 *
 * ─── Por que este arquivo desliga o cookie da config ────────────────────────
 *
 * `playwright.config.ts` planta `sidebar_collapsed=0` em todo contexto, porque as
 * outras specs medem a barra ABERTA. Aqui o que está sob medição é justamente a
 * primeira impressão — quem acabou de instalar e nunca tocou na barra —, então o
 * `storageState` volta a ser vazio. Sem isso esta spec mediria o gesto de quem já
 * expandiu, que é o caso que NÃO precisa de prova.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por scripts/seed-e2e-credentials.ts).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });
// `loginComoAdmin` pode esperar a virada da janela TOTP — ver navegacao.spec.ts.
test.describe.configure({ timeout: 120_000 });

const ROTULOS_DOS_HUBS = ["Ver tudo em CRM", "Ver tudo em IA", "Ver tudo em Análise"] as const;

async function abrirInbox(page: Page): Promise<void> {
  creds = await loginComoAdmin(page, creds);
  await page.goto("/app/inbox");
  // A grade do Inbox carrega o estado do tempo real como atributo (ver
  // `InboxLayout`) — existir é o que diz que a tela montou.
  await expect(page.locator("[data-realtime-status]")).toBeVisible({ timeout: 30_000 });
}

/** O desenho (o `<svg>` inteiro) de cada "Ver tudo em …" — é o que o olho compara. */
async function desenhosDosHubs(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Navegação principal" });
  const desenhos: string[] = [];
  for (const rotulo of ROTULOS_DOS_HUBS) {
    // Recolhida a barra, o nome acessível vem do `title`; aberta, do texto. Os
    // dois casos passam por `getByRole`, que é como quem usa leitor de tela acha.
    const link = nav.getByRole("link", { name: rotulo });
    await expect(link, `${rotulo} não está no menu`).toBeVisible();
    desenhos.push(await link.locator("svg").first().evaluate((s) => s.outerHTML));
  }
  return desenhos;
}

async function larguraDaBarra(page: Page): Promise<number> {
  return page.locator("aside").first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

test.describe("barra lateral recolhida por padrão e Inbox de borda a borda", () => {
  test("sem nenhum cookie, a barra vem recolhida e o Inbox encosta nas bordas", async ({ page }) => {
    await abrirInbox(page);

    // A BARRA: trilho de 64px, sem título de grupo — o texto não cabe ali.
    expect(await larguraDaBarra(page), "sem cookie a barra tem de vir recolhida (w-16)").toBe(64);
    await expect(
      page.getByRole("navigation", { name: "Navegação principal" }).getByRole("heading"),
    ).toHaveCount(0);

    // OS ÍCONES: recolhida, o texto some e o ícone é tudo o que resta — então os
    // três "Ver tudo em …" não podem ser o mesmo desenho.
    const desenhos = await desenhosDosHubs(page);
    expect(new Set(desenhos).size, "os três 'Ver tudo em …' repetem o ícone").toBe(3);

    // O INBOX: medido contra as três caixas que o cercam.
    const m = await page.evaluate(() => {
      const caixa = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      return {
        barra: caixa(document.querySelector("aside")),
        topo: caixa(document.querySelector("header")), // a TopBar: o primeiro <header> do DOM
        grade: caixa(document.querySelector("[data-realtime-status]")),
        largura: document.documentElement.clientWidth,
        altura: window.innerHeight,
        rolagemDaPagina: document.documentElement.scrollHeight - window.innerHeight,
      };
    });

    const TOLERANCIA = 1;
    expect(
      Math.abs(m.grade.left - m.barra.right),
      `à esquerda a grade (${m.grade.left}px) tem de encostar na barra (${m.barra.right}px)`,
    ).toBeLessThanOrEqual(TOLERANCIA);
    expect(
      Math.abs(m.grade.top - m.topo.bottom),
      `em cima a grade (${m.grade.top}px) tem de encostar na linha do cabeçalho (${m.topo.bottom}px)`,
    ).toBeLessThanOrEqual(TOLERANCIA);
    expect(
      Math.abs(m.grade.right - m.largura),
      `à direita a grade (${m.grade.right}px) tem de ir até a borda da tela (${m.largura}px)`,
    ).toBeLessThanOrEqual(TOLERANCIA);
    expect(
      Math.abs(m.grade.bottom - m.altura),
      `embaixo a grade (${m.grade.bottom}px) tem de ir até a borda da tela (${m.altura}px)`,
    ).toBeLessThanOrEqual(TOLERANCIA);
    // A conta de altura fecha: a grade não pode passar da tela e obrigar a rolar
    // — é o composer que pagaria, nascendo abaixo da borda.
    expect(m.rolagemDaPagina, "a página não pode rolar por causa da grade").toBeLessThanOrEqual(TOLERANCIA);

    await page.screenshot({ path: path.join(EVIDENCE, "inbox-barra-recolhida-borda-a-borda.png") });
  });

  test("quem expande a barra a mantém expandida, e os ícones seguem distintos", async ({ page }) => {
    await abrirInbox(page);
    expect(await larguraDaBarra(page)).toBe(64);

    await page.getByRole("button", { name: "Expandir sidebar" }).click();
    await expect.poll(() => larguraDaBarra(page), { message: "a barra não expandiu" }).toBe(240);

    // Aberta, os títulos de grupo voltam, e os três hubs continuam distintos.
    await expect(
      page.getByRole("navigation", { name: "Navegação principal" }).getByRole("heading"),
    ).toHaveText(["Atendimento", "CRM", "Agente de IA", "Canais", "Análise"]);
    expect(new Set(await desenhosDosHubs(page)).size, "aberta, os 'Ver tudo em …' repetem o ícone").toBe(3);

    // O cookie `"0"` é a memória: um F5 e a barra continua aberta.
    await page.reload();
    await expect(page.locator("[data-realtime-status]")).toBeVisible({ timeout: 30_000 });
    expect(await larguraDaBarra(page), "expandida de propósito, a barra deve sobreviver ao F5").toBe(240);

    await page.screenshot({ path: path.join(EVIDENCE, "inbox-barra-expandida.png") });

    // E o caminho de volta: recolher também persiste.
    await page.getByRole("button", { name: "Recolher sidebar" }).click();
    await expect.poll(() => larguraDaBarra(page), { message: "a barra não recolheu" }).toBe(64);
    await page.reload();
    await expect(page.locator("[data-realtime-status]")).toBeVisible({ timeout: 30_000 });
    expect(await larguraDaBarra(page)).toBe(64);
  });
});
