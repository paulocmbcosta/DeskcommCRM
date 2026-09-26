/**
 * [P1] A ESPERA QUE PEDE RESPOSTA (migration 0285) — a Assistente dispensa o
 * termômetro quando a fala do cliente não pede resposta, e o atendente religa.
 *
 * Dirige o FRONTEND, logado, clicando (doutrina de QA Visual). Dois testes:
 *
 *  1. A TELA diante da dispensa. A dispensa entra pela MESMA função que o worker
 *     chama (`fn_dispensar_espera`, `lib/espera/dados.ts`) — não por um update na
 *     coluna —, e o resto é pela tela: o card troca o termômetro pelo selo "Não
 *     pede resposta" via realtime, o chat mostra a faixa dispensada, e "Contar
 *     mesmo assim" devolve a espera com a hora ORIGINAL e escreve na linha do
 *     tempo.
 *
 *  2. A ASSISTENTE DE VERDADE. As mensagens entram pelo caminho de produção
 *     (`POST /api/v1/webhooks/waha/[token]`, inclusive a resposta do atendente
 *     pelo celular, `fromMe=true`), o evento é drenado pela rota de cron
 *     (`/api/v1/cron/event-log-drain`) e o worker `espera-da-assistente.v1`
 *     chama um Jev FALSO local — um receiver HTTP de verdade no endereço de
 *     `CLASSIFICADOR_COMERCIAL_BASE_URL` do `.env.e2e`, com a chave OpenRouter
 *     da organização cifrada como o produto cifra. "ok obrigado" ⇒ dispensa;
 *     "e o horário de sábado?" ⇒ o termômetro volta contando DESSA mensagem.
 *
 * ⚠️ A porta do Jev falso não é a 3998 (é do UPSTASH do `.env.e2e`) — a mesma
 * regra de `card-pelo-classificador.spec.ts`, que também sobe um receiver ali;
 * as specs rodam em série (`workers: 1`), então as duas nunca escutam juntas.
 * O worker de sentimento também usa o Jev pela mesma base: o falso só responde
 * a pergunta `pede_resposta` e recusa as outras (400), sem contá-las.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as http from "node:http";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { ESPERA_DO_ADIAMENTO_MS } from "../../lib/event-log/dispatcher";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/espera-que-pede-resposta";
const FUSO = "America/Sao_Paulo";
const SEGREDO_DO_CRON = (process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET || "").trim();

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function sql<T = Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  const cliente = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await cliente.connect();
  try {
    return (await cliente.query(texto, valores)).rows as T[];
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

/** "HH:mm" no fuso do navegador da spec — o mesmo `format(…, "HH:mm")` do card. */
function horaMinuto(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso),
  );
}

const minutosAtras = (min: number) => new Date(Date.now() - min * 60_000);

/** Uma organização nova com uma pessoa admin (a Ana) e um número. */
async function organizacaoComAtendente(prefixo: string): Promise<{
  org: string;
  user: string;
  email: string;
  password: string;
  canal: string;
  webhookToken: string;
  sessionName: string;
}> {
  const password = `Local-${randomUUID()}!`;
  const email = `${prefixo}-${randomUUID()}@invariant.test`;
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Ana Atendente" },
  });
  if (created.error || !created.data.user) throw created.error;
  const user = created.data.user.id;
  const org = await insert("organizations", {
    display_name: "Provedor da espera",
    legal_name: "Provedor da espera",
    slug: `${prefixo}-${randomUUID()}`,
    onboarded_at: new Date().toISOString(),
  });
  const membership = await db.from("user_organizations").insert({
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (membership.error) throw membership.error;
  const webhookToken = `espera-${randomUUID()}`;
  const sessionName = `espera-${randomUUID()}`;
  const canal = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: sessionName,
    display_name: "Suporte",
    phone_number: "+551130250000",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    webhook_path_token: webhookToken,
  });
  return { org, user, email, password, canal, webhookToken, sessionName };
}

test.describe.configure({ mode: "serial" });

test("dispensa pela Assistente, selo no card, faixa no chat e 'Contar mesmo assim'", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: FUSO });
  const page = await context.newPage();

  const { org, user, email, password, canal } = await organizacaoComAtendente("espera-tela");
  const contato = await insert("contacts", { organization_id: org, display_name: "Cliente que agradeceu", phone_number: "+5561990001001" });
  const conversa = await insert("conversations", {
    organization_id: org,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
  });
  // Com a Ana (comando "humano"): é a única espera que a Assistente pode dispensar.
  await sql(
    `update public.conversations set assigned_to_user_id = $1, assignee_kind = 'user',
       status = 'claimed', bot_silenced_until = 'infinity' where id = $2`,
    [user, conversa],
  );
  // A entrada do cliente há 6 min, sem resposta: a mensagem (a RPC exige a
  // entrada que disparou a pergunta) e a marcação, como a ingestão faz.
  const em = minutosAtras(6).toISOString();
  const mensagem = await insert("messages", {
    organization_id: org,
    contact_id: contato,
    conversation_id: conversa,
    channel_session_id: canal,
    direction: "inbound",
    type: "text",
    status: "received",
    body: "ok, obrigado",
    sent_at: em,
  });
  const marcou = await db.rpc("fn_mark_conversation_message", {
    p_conv: conversa,
    p_direction: "inbound",
    p_preview: "ok, obrigado",
    p_at: em,
  });
  if (marcou.error) throw marcou.error;
  const [antes] = await sql<{ espera_desde: Date; last_inbound_at: Date }>(
    `select espera_desde, last_inbound_at from public.conversations where id = $1`,
    [conversa],
  );
  expect(antes?.espera_desde, "o trigger tem de ter ligado a espera").not.toBeNull();
  const esperaOriginal = antes!.espera_desde.toISOString();

  try {
    await login(page, email, password);
    await page.goto("/app/inbox?filter=all");
    const card = page.locator(`[data-conversation-id="${conversa}"]`);

    // ─── 1. Espera contando: laranja no card, faixa no chat ─────────────────
    const termometro = card.getByTestId("espera-da-conversa");
    await expect(termometro).toHaveAttribute("data-nivel", "laranja");
    await expect(termometro).toContainText("Aguardando há 6 min");
    expect(await termometro.getAttribute("title")).toBe(`Cliente sem resposta desde ${horaMinuto(esperaOriginal)}`);
    await expect(card.getByTestId("espera-dispensada")).toHaveCount(0);
    await card.click();
    const faixa = page.getByTestId("faixa-da-espera");
    await expect(faixa).toHaveAttribute("data-nivel", "laranja");
    await expect(faixa).toContainText("Cliente aguardando resposta há 6 min");
    await page.screenshot({ path: `${evidence}/01-espera-contando.png` });

    // ─── 2. A Assistente dispensa — a MESMA RPC do worker ───────────────────
    const dispensou = await db.rpc("fn_dispensar_espera", {
      p_org: org,
      p_conversation: conversa,
      p_espera_desde: esperaOriginal,
      p_last_inbound_at: antes!.last_inbound_at.toISOString(),
      p_mensagem: mensagem,
      p_payload: { probabilidade: 0.05, ate: antes!.last_inbound_at.toISOString(), modelo: "typesafe/jev-1.13" },
    });
    if (dispensou.error) throw dispensou.error;
    expect(dispensou.data, "a RPC tem de ter dispensado").toBe(true);

    // Pelo realtime, sem recarregar: o selo toma o lugar do termômetro.
    const selo = card.getByTestId("espera-dispensada");
    await expect(selo).toHaveText("Não pede resposta", { timeout: 20_000 });
    await expect(termometro).toHaveCount(0);
    const faixaDispensada = page.getByTestId("faixa-da-espera-dispensada");
    await expect(faixaDispensada).toContainText("Assistente: o cliente só confirmou ou agradeceu — não pede resposta.");
    await expect(faixa).toHaveCount(0);
    const painelLinha = page.getByTestId("painel-aba-linha");
    if ((await painelLinha.getAttribute("aria-pressed")) !== "true") await painelLinha.click();
    const linha = page.getByTestId("linha-do-tempo-da-conversa");
    await expect(linha).toContainText("Assistente: a mensagem do cliente não pede resposta");
    await page.screenshot({ path: `${evidence}/02-dispensada-selo-e-faixa.png` });

    // ─── 3. "Contar mesmo assim": volta a espera ORIGINAL ───────────────────
    await faixaDispensada.getByRole("button", { name: "Contar mesmo assim" }).click();
    await expect(termometro).toHaveAttribute("data-nivel", "laranja", { timeout: 20_000 });
    expect(await termometro.getAttribute("title")).toBe(`Cliente sem resposta desde ${horaMinuto(esperaOriginal)}`);
    await expect(selo).toHaveCount(0);
    await expect(faixa).toHaveAttribute("data-nivel", "laranja");
    await expect(faixaDispensada).toHaveCount(0);
    await expect(linha.getByTestId("evento-da-linha").filter({ hasText: "Espera contada mesmo assim" })).toContainText(
      "Ana Atendente",
    );
    await page.screenshot({ path: `${evidence}/03-contada-mesmo-assim.png` });

    // O banco: a espera é a de antes (não "agora"), e a Assistente está travada.
    const [depois] = await sql<{ espera_desde: Date; espera_mantida_em: Date | null; espera_dispensada_ate: Date | null }>(
      `select espera_desde, espera_mantida_em, espera_dispensada_ate from public.conversations where id = $1`,
      [conversa],
    );
    expect(depois!.espera_desde.toISOString()).toBe(esperaOriginal);
    expect(depois!.espera_mantida_em).not.toBeNull();
    expect(depois!.espera_dispensada_ate).toBeNull();
  } finally {
    await context.close();
  }
});

// ─── O Jev falso ─────────────────────────────────────────────────────────────

interface PedidoDaEspera {
  autorizacao: string;
  modelo: string;
  semResposta: string;
}
/**
 * Só os pedidos que vieram com a chave DESTA rodada. O banco de e2e é
 * compartilhado: o dreno pega também eventos que outra rodada deixou na fila, e
 * a Assistente pergunta por eles com a chave da organização de lá.
 */
const todosOsPedidos: PedidoDaEspera[] = [];
let chaveDaRodada = "";
const pedidos = {
  get lista(): PedidoDaEspera[] {
    return todosOsPedidos.filter((p) => p.autorizacao === `Bearer ${chaveDaRodada}`);
  },
};
const foraDoContrato: string[] = [];
/** A probabilidade que o falso devolve para "pede resposta?" — o teste troca. */
let probabilidade = 0.05;
let servidor: http.Server | undefined;

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
  expect(url.port, "a 3998 é do UPSTASH_REDIS_REST_URL").not.toBe("3998");
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
      let pedido: { model?: string; state?: Record<string, unknown>; questions?: Record<string, unknown> };
      try {
        pedido = JSON.parse(corpo) as typeof pedido;
      } catch {
        foraDoContrato.push("POST /systemone com corpo que não é JSON");
        res.writeHead(400).end();
        return;
      }
      // Outra pergunta (o sentimento usa o mesmo Jev): não é desta spec. 400 e
      // não 5xx: falha TEMPORÁRIA faria o sentimento pedir `retry` para daqui a
      // um minuto, e o dreno reagenda o evento pelo PRIMEIRO `retry` da lista
      // (`lib/event-log/drain.ts`) — o sentimento vem antes da espera no
      // registro, e o adiamento dela (15 s) viraria o dele (60 s).
      if (!pedido.questions || !("pede_resposta" in pedido.questions)) {
        res.writeHead(400).end();
        return;
      }
      todosOsPedidos.push({
        autorizacao: String(req.headers.authorization ?? ""),
        modelo: String(pedido.model ?? ""),
        semResposta: JSON.stringify(pedido.state?.sem_resposta ?? null),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "typesafe/jev-1.13",
          answers: { pede_resposta: { type: "noul", noul: probabilidade } },
          usage: { input_tokens: 120 },
        }),
      );
    });
  });
}

const PAUSA_ENTRE_DRENOS_MS = 750;
/** O orçamento sai da constante do adiamento (ver `card-pelo-classificador.spec.ts`). */
const VOLTAS_DO_DRENO = Math.ceil((ESPERA_DO_ADIAMENTO_MS * 2) / PAUSA_ENTRE_DRENOS_MS);

async function drenarAte(page: Page, esperadas: number): Promise<void> {
  let resumo = "";
  for (let i = 0; i < VOLTAS_DO_DRENO && pedidos.lista.length < esperadas; i++) {
    const r = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${SEGREDO_DO_CRON}` },
    });
    expect(r.status(), "o dreno tem que responder 200 — 403 é segredo errado").toBe(200);
    resumo = JSON.stringify(((await r.json()) as { data?: unknown }).data ?? null);
    if (pedidos.lista.length < esperadas) await page.waitForTimeout(PAUSA_ENTRE_DRENOS_MS);
  }
  expect(
    pedidos.lista.length,
    `o Jev falso tinha de ter recebido ${esperadas} pergunta(s) da espera. Último dreno: ${resumo}. ` +
      `Fora do contrato: ${JSON.stringify(foraDoContrato)}`,
  ).toBe(esperadas);
}

test.describe("a Assistente de verdade, pelo webhook e pelo dreno", () => {
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
    const s = servidor;
    servidor = undefined;
    if (s?.listening) await new Promise<void>((ok) => s.close(() => ok()));
  });

  test("'ok obrigado' dispensa; 'e o horário de sábado?' volta a contar desta mensagem", async ({ browser }) => {
    test.setTimeout(240_000);
    mkdirSync(evidence, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: FUSO });
    const page = await context.newPage();

    const { org, user, email, password, webhookToken, sessionName } = await organizacaoComAtendente("espera-jev");
    // A chave da OpenRouter da organização, cifrada como `guardarCredencial` cifra.
    const CHAVE_FALSA = `sk-or-e2e-espera-${randomUUID().slice(0, 8)}`;
    chaveDaRodada = CHAVE_FALSA;
    const cifrada = encryptKey(CHAVE_FALSA);
    await insert("ai_provider_credentials", {
      organization_id: org,
      provider: "openrouter",
      label: "OpenRouter e2e (Jev falso)",
      api_key_encrypted: bufToBytea(cifrada.ciphertext),
      api_key_iv: bufToBytea(cifrada.iv),
      api_key_tag: bufToBytea(cifrada.tag),
      api_key_last4: cifrada.last4,
      validated_at: new Date().toISOString(),
      is_active: true,
    });

    const digitos = `55619${String(Date.now()).slice(-8)}`;
    const chatId = `${digitos}@c.us`;
    let n = 0;
    async function webhook(corpo: string, quando: Date, doAtendente = false): Promise<void> {
      n += 1;
      const r = await page.request.post(`/api/v1/webhooks/waha/${webhookToken}`, {
        data: {
          event: doAtendente ? "message.any" : "message",
          session: sessionName,
          payload: {
            id: `${doAtendente}_${chatId}_ESPERA${Date.now()}${n}`,
            ...(doAtendente ? { to: chatId } : { from: chatId }),
            fromMe: doAtendente,
            body: corpo,
            type: doAtendente ? "text" : "chat",
            timestamp: Math.floor(quando.getTime() / 1000),
            ...(doAtendente ? {} : { _data: { notifyName: "Cliente do Sábado" } }),
          },
        },
      });
      expect(r.status(), `o webhook tem de aceitar "${corpo}"`).toBe(200);
    }

    try {
      // O cliente reclama, a conversa nasce pela ingestão real; a Ana assume.
      await webhook("minha internet caiu", minutosAtras(20));
      await expect
        .poll(async () => (await sql(`select id from public.conversations where organization_id = $1`, [org])).length, {
          timeout: 20_000,
        })
        .toBe(1);
      const [linhaConversa] = await sql<{ id: string }>(`select id from public.conversations where organization_id = $1`, [org]);
      const conversa = linhaConversa!.id;
      await sql(
        `update public.conversations set assigned_to_user_id = $1, assignee_kind = 'user',
           status = 'claimed', bot_silenced_until = 'infinity' where id = $2`,
        [user, conversa],
      );
      // A Ana responde pelo celular (fromMe) e o cliente agradece. Tudo AGORA:
      // a ingestão marca a saída do celular com a hora de CHEGADA
      // (`lib/waha/ingest.ts`, ramo fromMe), e uma entrada com carimbo mais
      // velho que isso não abriria espera nenhuma.
      await webhook("assim que eu agendar te chamo", new Date(), true);
      await webhook("ok obrigado", new Date(Date.now() + 1_000));
      await expect
        .poll(async () => (await sql(`select espera_desde from public.conversations where id = $1`, [conversa]))[0]?.espera_desde, {
          timeout: 20_000,
        })
        .not.toBeNull();

      await login(page, email, password);
      await page.goto("/app/inbox?filter=all");
      const card = page.locator(`[data-conversation-id="${conversa}"]`);
      // Antes do dreno a espera conta (a Assistente ainda não foi perguntada).
      await expect(card.getByTestId("espera-da-conversa")).toBeVisible();
      await expect(card.getByTestId("espera-dispensada")).toHaveCount(0);
      const [doObrigado] = await sql<{ espera_desde: Date }>(
        `select espera_desde from public.conversations where id = $1`,
        [conversa],
      );
      await page.screenshot({ path: `${evidence}/04-jev-antes-do-dreno.png` });

      // ─── O dreno chama a Assistente; o Jev diz "não pede resposta" ─────────
      probabilidade = 0.05;
      await drenarAte(page, 1);
      // `pedidos.lista` só conta o que veio com `Bearer <chave desta org>`: chegar
      // aqui já prova que o worker decifrou a credencial da organização.
      expect(pedidos.lista[0]!.modelo).toBe("typesafe/jev-1.13");
      expect(pedidos.lista[0]!.semResposta).toContain("ok obrigado");
      await expect(card.getByTestId("espera-dispensada")).toHaveText("Não pede resposta", { timeout: 20_000 });
      await expect(card.getByTestId("espera-da-conversa")).toHaveCount(0);
      await page.screenshot({ path: `${evidence}/05-jev-dispensou.png` });

      // ─── O cliente pergunta: a espera volta, contando DESTA mensagem ───────
      probabilidade = 0.9;
      // Pelo menos um segundo depois do "ok obrigado": o carimbo do WhatsApp é em
      // segundos, e é por ele que se distingue de onde a espera conta.
      const sabado = new Date(Math.max(Date.now(), doObrigado!.espera_desde.getTime() + 2_000));
      await webhook("e o horário de sábado?", sabado);
      const termometro = card.getByTestId("espera-da-conversa");
      await expect(termometro).toBeVisible({ timeout: 20_000 });
      await drenarAte(page, 2);
      expect(pedidos.lista[1]!.semResposta).toContain("e o horário de sábado?");
      await expect(termometro).toHaveAttribute("data-nivel", "normal");
      await expect(card.getByTestId("espera-dispensada")).toHaveCount(0);
      const [agora] = await sql<{ espera_desde: Date; espera_dispensada_ate: Date | null }>(
        `select espera_desde, espera_dispensada_ate from public.conversations where id = $1`,
        [conversa],
      );
      // Conta DESTA mensagem — não do "ok obrigado" dispensado.
      expect(Math.floor(agora!.espera_desde.getTime() / 1000)).toBe(Math.floor(sabado.getTime() / 1000));
      expect(agora!.espera_desde.getTime()).toBeGreaterThan(doObrigado!.espera_desde.getTime());
      expect(agora!.espera_dispensada_ate).toBeNull();
      expect(await termometro.getAttribute("title")).toBe(
        `Cliente sem resposta desde ${horaMinuto(agora!.espera_desde.toISOString())}`,
      );
      await page.screenshot({ path: `${evidence}/06-jev-voltou-a-contar.png` });

      // O custo é visível: cada pergunta é uma linha em llm_calls.
      const chamadas = await sql<{ n: number }>(
        `select count(*)::int as n from public.llm_calls where organization_id = $1 and purpose = 'wait_classify'`,
        [org],
      );
      expect(chamadas[0]!.n).toBe(2);
    } finally {
      await context.close();
    }
  });
});
