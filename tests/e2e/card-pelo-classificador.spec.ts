/**
 * O CARD NASCE QUANDO A CONVERSA É COMERCIAL — provado PELA TELA (DoD 12).
 *
 * Os testes de unidade e o invariante provam a REGRA. Esta spec prova o que
 * interessa a quem instalou numa VPS: o admin liga "Só conversas comerciais" na
 * tela de funis, a mensagem de suporte NÃO vira card no quadro, a de mudança de
 * plano vira — e o dossiê do card diz por quê.
 *
 * O QUE É REAL AQUI:
 *  - a regra é ligada PELA TELA, pela server action de verdade, no Postgres do
 *    baseline — é a prova da trava otimista (`.eq("updated_at", …)` em
 *    `app/actions/settings/definirNascimentoDoCard.ts`) contra o gatilho real
 *    `trg_organizations_touch`: se a igualdade de timestamp não casar, a tela
 *    mostra "Outra pessoa mudou…" e o primeiro teste reprova;
 *  - a mensagem entra pelo CAMINHO DE PRODUÇÃO (`POST /api/v1/webhooks/waha/[token]`,
 *    como em `conversa-vira-lead.spec.ts`), sem insert à mão;
 *  - o evento é drenado pela rota de cron de verdade (`/api/v1/cron/event-log-drain`),
 *    o mecanismo de produção acionado à mão em vez de esperar o relógio — e ela
 *    drena no contexto `worker`, que é quem de fato chama o classificador: no
 *    dreno que corre DENTRO do POST do webhook ele é ADIADO (ver
 *    `VOLTAS_DO_DRENO` abaixo, que é o orçamento de espera desta spec);
 *  - o worker lê a chave da credencial `openrouter` da organização (semeada
 *    cifrada como o produto cifra) e chama um Jev FALSO local — um receiver HTTP
 *    de verdade, no endereço de `CLASSIFICADOR_COMERCIAL_BASE_URL` do `.env.e2e`.
 *
 * O FALSO responde "comercial" quando a última fala do CLIENTE fala de
 * plano/mega/contratar, e CONTA as chamadas: é assim que se prova que quem já
 * tem card NÃO chama o Jev (a decisão 3 do dono — cada chamada custa).
 *
 * ⚠️ A PORTA NÃO É A 3998. Ela é do `UPSTASH_REDIS_REST_URL` do `.env.e2e`
 * (placeholder sem ninguém escutando, e é por isso que o limitador cai para a
 * memória). Um receiver ali atenderia as chamadas do rate limit do login e do
 * webhook, contaria cada uma como "chamada ao Jev" e responderia ao Redis com
 * JSON de classificação. A porta sai de `CLASSIFICADOR_COMERCIAL_BASE_URL` —
 * uma fonte só — e a spec recusa rodar sem ela.
 *
 * A organização de e2e é compartilhada: o `beforeAll` parte do modo de sempre e
 * o `afterAll` o devolve (`seed-e2e-classificador-comercial.ts restaurar`), mesmo
 * quando um teste reprova. `conversa-vira-lead.spec.ts` roda depois desta na
 * mesma parte do CI e é o controle: o modo de sempre continua abrindo card na
 * primeira mensagem.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { ESPERA_DO_ADIAMENTO_MS } from "../../lib/event-log/dispatcher";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds as lerCredsAdmin, loginComoAdmin } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
/** O mesmo literal de `scripts/seed-e2e-classificador-comercial.ts`. */
const CHAVE_FALSA_DA_OPENROUTER = "sk-or-e2e-falsa-0000";
const CHAVE_DO_HANDLER = "classificador-comercial.v1";

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
  nascimento?: { webhook_token: string; session_name: string; pipeline_default_id: string };
}

function lerCreds(): Creds {
  lerCredsAdmin(); // semeia .e2e-creds.json se não existir
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

/** Telefone único por execução: o banco de e2e é compartilhado entre rodadas. */
const sufixo = String(process.pid).padStart(6, "0").slice(-6);
const TELEFONE = `55318${sufixo}`;
const NOME = `Cliente Classificado ${sufixo}`;
const idDaMensagem = (n: number) => `e2e-clf-${sufixo}-${n}`;

const SEGREDO_DO_CRON = (process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET || "").trim();

interface PedidoAoJev {
  autorizacao: string;
  modelo: string;
  ultimaDoCliente: string;
}
const pedidos: PedidoAoJev[] = [];
/** Tudo que chegou e NÃO era `POST /systemone` — diagnóstico de base URL errada. */
const foraDoContrato: string[] = [];
let servidor: http.Server | undefined;

/**
 * O endereço do Jev falso, lido da MESMA variável que o servidor sob teste lê
 * (`webServer.env` e este processo recebem o `.env.e2e` inteiro).
 */
function enderecoDoJevFalso(): { host: string; porta: number } {
  const bruto = process.env.CLASSIFICADOR_COMERCIAL_BASE_URL ?? "";
  if (bruto === "") {
    throw new Error(
      "CLASSIFICADOR_COMERCIAL_BASE_URL ausente do .env.e2e — rode `pnpm e2e:env` de novo. Sem ela o worker " +
        "chamaria a OpenRouter DE VERDADE com a chave falsa.",
    );
  }
  const url = new URL(bruto);
  expect(["127.0.0.1", "localhost"], "o Jev falso tem de ser local").toContain(url.hostname);
  expect(url.port, "a 3998 é do UPSTASH_REDIS_REST_URL — ver o cabeçalho").not.toBe("3998");
  // O cliente acrescenta `/systemone` à base: com caminho na base, o pedido
  // chegaria em outra rota e cairia no `foraDoContrato`.
  expect(url.pathname.replace(/\/+$/, ""), "a base do Jev falso não pode ter caminho").toBe("");
  return { host: url.hostname, porta: Number(url.port) };
}

function jevFalso(): http.Server {
  return http.createServer((req, res) => {
    let corpo = "";
    req.setEncoding("utf8");
    req.on("data", (pedaco: string) => (corpo += pedaco));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/systemone") {
        foraDoContrato.push(`${req.method} ${req.url}`);
        res.writeHead(404).end();
        return;
      }
      let pedido: { model?: string; state?: { conversa?: Array<{ quem: string; texto: string }> } };
      try {
        pedido = JSON.parse(corpo) as typeof pedido;
      } catch {
        foraDoContrato.push("POST /systemone com corpo que não é JSON");
        res.writeHead(400).end();
        return;
      }
      const ultima = [...(pedido.state?.conversa ?? [])].reverse().find((m) => m.quem === "cliente")?.texto ?? "";
      pedidos.push({
        autorizacao: String(req.headers.authorization ?? ""),
        modelo: String(pedido.model ?? ""),
        ultimaDoCliente: ultima,
      });
      const comercial = /plano|mega|contratar/i.test(ultima);
      // O formato de `tests/fixtures/jev/resposta-real.json` — a resposta crua
      // medida da OpenRouter —, que é o que `lib/classificador-comercial/jev.ts` valida.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            comercial: { type: "noul", noul: comercial ? 0.93 : 0.06 },
            assunto: { type: "choice", choice: comercial ? "mudanca_de_plano" : "suporte", confidence: 0.9 },
          },
          model: "typesafe/jev-1.13-20260917",
          usage: { input_tokens: 400, output_tokens: 20, cost: 0.0000168 },
        }),
      );
    });
  });
}

/** Um inbound de texto, como o WAHA o entrega (sem assinatura, como o WAHA Core). */
async function mandarMensagem(page: Page, texto: string, id: string): Promise<void> {
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id,
        from: `${TELEFONE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: NOME },
      },
    },
  });
  expect(r.status(), "o webhook precisa ACEITAR — 4xx aqui e o resto do teste mede o vazio").toBe(200);
}

/** Um tick do dreno. Devolve o resumo, que carrega o motivo dos `skipped`. */
async function drenar(page: Page): Promise<string> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${SEGREDO_DO_CRON}` },
  });
  expect(r.status(), "o dreno tem que responder 200 — 403 é segredo errado, e aí nada roda").toBe(200);
  return JSON.stringify(((await r.json()) as { data?: unknown }).data ?? null);
}

/**
 * O ORÇAMENTO DE ESPERA DE TODO LAÇO DAQUI, e ele NÃO é um número escolhido.
 *
 * O dreno também roda DENTRO do POST do webhook (`acelerarPipelineDeEventos`,
 * lib/dev/kick-local-pipeline.ts) e, nessa passagem, o classificador é ADIADO
 * para o worker — só na organização que ligou a regra, que é a desta spec. O
 * evento volta a `pending` com `next_attempt_at = agora + ESPERA_DO_ADIAMENTO_MS`,
 * e o dreno do cron (contexto `worker`, que é o que esta spec chama) só pode
 * pegá-lo depois disso.
 *
 * Um laço com orçamento MENOR que essa espera passa na máquina lenta e falha na
 * rápida, e o vermelho leria como "o worker não criou o card". Por isso o
 * orçamento sai da CONSTANTE do produto, mais a mesma folga de novo: se um dia
 * o adiamento crescer, o laço cresce junto, sem ninguém lembrar de vir aqui.
 */
const PAUSA_ENTRE_DRENOS_MS = 750;
const VOLTAS_DO_DRENO = Math.ceil((ESPERA_DO_ADIAMENTO_MS * 2) / PAUSA_ENTRE_DRENOS_MS);

/** Drena até o Jev falso ter sido chamado `esperadas` vezes (ou desistir, dizendo o que viu). */
async function drenarAte(page: Page, esperadas: number): Promise<void> {
  let ultimoResumo = "";
  for (let i = 0; i < VOLTAS_DO_DRENO && pedidos.length < esperadas; i++) {
    ultimoResumo = await drenar(page);
    if (pedidos.length < esperadas) await page.waitForTimeout(PAUSA_ENTRE_DRENOS_MS);
  }
  expect(
    pedidos.length,
    `o Jev falso tinha de ter recebido ${esperadas} chamada(s). Último resumo do dreno: ${ultimoResumo}. ` +
      `Fora do contrato: ${JSON.stringify(foraDoContrato)}`,
  ).toBe(esperadas);
}

/** O `message.received` da mensagem `externalId`, como o dreno o deixou. */
async function eventoDaMensagem(
  externalId: string,
): Promise<{ status: string; consumed_by: string[]; last_error: string | null } | null> {
  const { data, error } = await db
    .from("event_log")
    .select("status, consumed_by, last_error")
    .eq("organization_id", creds.org_id)
    .eq("event_type", "message.received")
    .eq("payload->>external_id", externalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`select event_log: ${error.message}`);
  return data as { status: string; consumed_by: string[]; last_error: string | null } | null;
}

/** Manager: vê todos os cards da organização e não exige MFA (como em `conversa-vira-lead`). */
async function loginComoManager(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

/** Abre o quadro do funil de entrada e espera ele DESENHAR — senão "não tem card" passa por quadro vazio. */
async function abrirQuadroDeEntrada(page: Page): Promise<void> {
  await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
  await expect(
    page.getByRole("checkbox", { name: /selecionar todos em|desmarcar todos em/i }).first(),
    "o quadro tem de ter desenhado as etapas antes de qualquer conclusão sobre cards",
  ).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("o card nasce quando a conversa é comercial", () => {
  test.beforeAll(() => {
    // Credencial falsa ativa e validada + regra no modo de sempre: o primeiro
    // teste LIGA a regra pela tela, e o botão só habilita quando há mudança.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-classificador-comercial.ts"], { stdio: "inherit" });
  });

  test.beforeAll(async () => {
    const { host, porta } = enderecoDoJevFalso();
    const s = jevFalso();
    await new Promise<void>((ok, falhou) => {
      s.once("error", falhou);
      s.listen(porta, host, () => ok());
    });
    servidor = s;
  });

  test.afterAll(async () => {
    // A restauração vem PRIMEIRO e não depende de nada acima ter dado certo: se
    // ela não rodar, todas as specs seguintes da parte veem a regra ligada e
    // param de ganhar card na primeira mensagem.
    try {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-classificador-comercial.ts", "restaurar"], {
        stdio: "inherit",
      });
    } finally {
      const s = servidor;
      servidor = undefined;
      if (s?.listening) await new Promise<void>((ok) => s.close(() => ok()));
    }
  });

  test("o admin liga 'Só conversas comerciais' pela tela", async ({ page }) => {
    // Login com TOTP pode esperar a janela seguinte (código de uso único).
    test.setTimeout(120_000);
    await loginComoAdmin(page, lerCredsAdmin());
    await page.goto("/app/settings/tenant/pipelines");

    const secao = page.getByTestId("nascimento-do-card");
    await expect(secao.getByRole("heading", { name: "Quando o card nasce" })).toBeVisible({ timeout: 20_000 });
    await expect(secao.getByRole("radio", { name: /toda conversa vira card/i })).toBeChecked();

    await secao.getByRole("radio", { name: /só conversas comerciais/i }).check();
    // A certeza mínima só aparece no modo classificador, e nasce no padrão (70%).
    await expect(secao.getByLabel(/certeza mínima/i)).toContainText("70%");
    await secao.getByRole("button", { name: /^salvar$/i }).click();
    await expect(page.getByText("Regra salva.")).toBeVisible({ timeout: 15_000 });

    // O que a tela mostra DEPOIS de recarregar vem do banco, não do estado do React.
    await page.reload();
    await expect(
      page.getByTestId("nascimento-do-card").getByRole("radio", { name: /só conversas comerciais/i }),
    ).toBeChecked({ timeout: 20_000 });
    // O selo é de quem NÃO pode editar: para o admin, a opção marcada pode ser
    // uma escolha ainda não salva, e chamá-la "Em vigor" seria mentira.
    await expect(page.getByTestId("nascimento-do-card").getByText("Em vigor")).toHaveCount(0);
    fs.mkdirSync("evidence/card-pelo-classificador", { recursive: true });
    await page.screenshot({ path: "evidence/card-pelo-classificador/regra-ligada.png", fullPage: true });
  });

  test("mensagem de suporte NÃO abre card", async ({ page }) => {
    test.setTimeout(150_000);
    await mandarMensagem(page, "minha internet caiu desde ontem", idDaMensagem(1));
    await drenarAte(page, 1);

    // O worker chamou o Jev com a chave DA ORGANIZAÇÃO (decifrada do banco), no
    // modelo fixo, e mostrou a ele a fala do cliente.
    expect(pedidos[0]!.autorizacao).toBe(`Bearer ${CHAVE_FALSA_DA_OPENROUTER}`);
    expect(pedidos[0]!.modelo).toBe("typesafe/jev-1.13");
    expect(pedidos[0]!.ultimaDoCliente).toBe("minha internet caiu desde ontem");

    await loginComoManager(page);

    // O gerente VÊ a regra em vigor (saber por que um card não nasceu é direito
    // de quem opera), mas não recebe um Salvar que a action recusaria.
    await page.goto("/app/settings/tenant/pipelines");
    const secao = page.getByTestId("nascimento-do-card");
    await expect(secao.getByRole("radio", { name: /só conversas comerciais/i })).toBeChecked({ timeout: 20_000 });
    await expect(secao.getByRole("radio", { name: /só conversas comerciais/i })).toBeDisabled();
    await expect(secao.getByRole("button", { name: /salvar/i })).toHaveCount(0);
    await expect(secao.getByText("Só um administrador pode mudar essa regra.")).toBeVisible();
    // Desabilitado não pode apagar QUAL regra vale: o selo fica na opção em vigor, e só nela.
    await expect(secao.getByTestId("opcao-nascimento-classificador").getByText("Em vigor")).toBeVisible();
    await expect(secao.getByText("Em vigor")).toHaveCount(1);
    await page.screenshot({ path: "evidence/card-pelo-classificador/regra-vista-pelo-gerente.png", fullPage: true });

    await abrirQuadroDeEntrada(page);
    await expect(page.getByText(NOME, { exact: false }), "suporte não é conversa comercial").toHaveCount(0);
  });

  test("mensagem de mudança de plano abre o card, e a linha do tempo diz por quê", async ({ page }) => {
    test.setTimeout(150_000);
    await mandarMensagem(page, "e queria aumentar meu plano pra 500 mega", idDaMensagem(2));
    await drenarAte(page, 2);
    expect(pedidos[1]!.ultimaDoCliente).toBe("e queria aumentar meu plano pra 500 mega");

    await loginComoManager(page);
    await abrirQuadroDeEntrada(page);
    const card = page.getByText(NOME, { exact: false }).first();
    await expect(card, "o card tem de aparecer no quadro do funil de entrada").toBeVisible({ timeout: 20_000 });
    await card.click();
    // A razão gravada por `garantirLeadDaConversa` (origem `classificador`),
    // desenhada pela linha do tempo do dossiê (`components/kanban/LeadTimeline.tsx`).
    await expect(
      page.getByText(/conversa identificada como comercial \(93%\) — assunto: mudança de plano/i).first(),
    ).toBeVisible({ timeout: 20_000 });
    fs.mkdirSync("evidence/card-pelo-classificador", { recursive: true });
    // Só a janela, não `fullPage`: o dossiê é um painel FIXO, e num quadro mais
    // alto que a janela (banco compartilhado, cards de outras rodadas) a captura
    // de página inteira desenhava o painel deslocado para o meio da imagem.
    await page.screenshot({ path: "evidence/card-pelo-classificador/card-nascido-comercial.png" });
  });

  test("com o card aberto, a mensagem seguinte NÃO chama o Jev", async ({ page }) => {
    test.setTimeout(150_000);
    const id = idDaMensagem(3);
    await mandarMensagem(page, "quanto fica por mês?", id);

    // Não basta drenar algumas vezes e ver a contagem parada: se o evento nem
    // tivesse sido processado, a contagem também ficaria parada. Drena até o
    // CLASSIFICADOR ter consumido o evento DESTA mensagem — aí sim "não chamou"
    // significa "decidiu não chamar".
    let evento: Awaited<ReturnType<typeof eventoDaMensagem>> = null;
    for (let i = 0; i < VOLTAS_DO_DRENO; i++) {
      await drenar(page);
      evento = await eventoDaMensagem(id);
      // `consumed_by` é a prova de que ele RODOU. O adiamento na requisição
      // devolve `retry`, que NÃO entra em `consumed_by` — então a chave só
      // aparece depois que o dreno de contexto `worker` chamou o handler.
      if (evento?.consumed_by.includes(CHAVE_DO_HANDLER)) break;
      await page.waitForTimeout(PAUSA_ENTRE_DRENOS_MS);
    }
    expect(
      evento?.consumed_by,
      `o classificador tem de ter consumido o evento desta mensagem (status=${evento?.status ?? "sem evento"}, ` +
        `last_error=${evento?.last_error ?? "null"})`,
    ).toContain(CHAVE_DO_HANDLER);
    // O evento terminou: nenhum handler pediu para tentar de novo. Esta era a
    // linha que cobrava `ja_tem_card` no `last_error`, e ela morreu de morte
    // MORRIDA — `ja_tem_card` é um dos pulos de TODA mensagem e perdeu o
    // `detail` de propósito (workers/classificador-comercial.handler.ts), para
    // não encher `event_log.last_error` de rotina e apagar o que é problema.
    // Quem prova o pulo aqui é o par "consumiu" + "não chamou o Jev".
    expect(evento?.status, "o evento tem de ter terminado").toBe("done");
    expect(pedidos.length, "quem já tem card não gera chamada ao Jev").toBe(2);
  });
});
