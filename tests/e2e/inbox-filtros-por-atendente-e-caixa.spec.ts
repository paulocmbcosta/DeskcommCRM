/**
 * OS FILTROS DO INBOX POR ATENDENTE, CAIXA DE ENTRADA, PERÍODO E ASSUNTO —
 * pela tela, como quem atende e como quem coordena.
 *
 * O pedido veio de quem atende: "as conversas finalizadas aqui são todas
 * misturadas de todos os atendentes". O que esta jornada prova, com gente
 * logada e dados no banco:
 *
 *   1. "Só as minhas", em Fechadas, deixa só o que estava COMIGO no
 *      encerramento — e o selo da aba acompanha;
 *   2. o filtro sobrevive a recarregar a página e a abrir o endereço copiado em
 *      outra janela (é a única prova de que o `history.replaceState` do
 *      `InboxLayout` conversa com o roteador do Next de verdade — o teste de
 *      unidade usa um roteador de mentira);
 *   3. quem coordena escolhe um atendente pelo nome;
 *   4. período e assunto recortam as Fechadas;
 *   5. um filtro sem resultado diz QUAL filtro está ligado, e "Limpar filtros"
 *      devolve a lista inteira;
 *   6. a caixa de entrada "Telefone" deixa só a conversa de telefone.
 *
 * Desenho: docs/superpowers/specs/2026-10-08-inbox-filtros-por-atendente-e-caixa-design.md
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Locator, type Page } from "@playwright/test";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/inbox-filtros";

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function sql(texto: string, valores: unknown[] = []): Promise<void> {
  const cliente = new Client({ connectionString: credentials.dbUrl });
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

/** Escolhe uma opção num seletor do funil (Radix: o gatilho abre uma lista de `option`). */
async function escolher(page: Page, seletor: string, opcao: string | RegExp): Promise<void> {
  await page.getByTestId(seletor).click();
  await page.getByRole("option", { name: opcao }).click();
}

async function abrirFunil(page: Page): Promise<void> {
  const funil = page.getByTestId("inbox-abrir-filtros");
  if ((await funil.getAttribute("aria-expanded")) !== "true") await funil.click();
  await expect(page.getByTestId("inbox-filtros-auxiliares")).toBeVisible();
}

const fechados = (page: Page): Locator =>
  page.getByTestId("lista-de-atendimentos-fechados").getByTestId("atendimento-fechado");
const parametros = (page: Page) => new URL(page.url()).searchParams;

test("filtros do Inbox: só as minhas, por atendente, por caixa, por período e por assunto", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(evidence, { recursive: true });

  const marca = randomUUID().slice(0, 8);
  const password = `Local-${randomUUID()}!`;
  const pessoas = {
    gestora: { email: `filtros-gestora-${marca}@invariant.test`, nome: "Carla Gestora", role: "manager", id: "" },
    ana: { email: `filtros-ana-${marca}@invariant.test`, nome: "Ana Atendente", role: "agent", id: "" },
    bruno: { email: `filtros-bruno-${marca}@invariant.test`, nome: "Bruno Atendente", role: "agent", id: "" },
  };
  let org = "";

  const contextoDaAna = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const contextoDaGestora = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  try {
    // ─── A organização e as três pessoas ────────────────────────────────────
    org = await insert("organizations", {
      display_name: "Provedor dos filtros",
      legal_name: "Provedor dos filtros",
      slug: `filtros-${marca}`,
      onboarded_at: new Date().toISOString(),
      // `all`: a Ana enxerga as conversas do Bruno. É o cenário do pedido —
      // "todas misturadas de todos os atendentes" — e o que dá sentido a filtrar.
      settings: { visibility_mode: "all" },
    });
    for (const pessoa of Object.values(pessoas)) {
      const criada = await db.auth.admin.createUser({
        email: pessoa.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: pessoa.nome },
      });
      if (criada.error || !criada.data.user) throw criada.error;
      pessoa.id = criada.data.user.id;
      const vinculo = await db.from("user_organizations").insert({
        organization_id: org,
        user_id: pessoa.id,
        role: pessoa.role,
        accepted_at: new Date().toISOString(),
      });
      if (vinculo.error) throw vinculo.error;
    }

    // ─── Um time com um assunto, um número de WhatsApp e um de telefone ─────
    const time = randomUUID();
    const assunto = randomUUID();
    await sql(
      `insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, 'Suporte', $3)`,
      [time, org, `suporte-${marca}`],
    );
    await sql(
      `insert into public.atendimento_assuntos (id, organization_id, team_id, name) values ($1, $2, $3, 'Sem internet')`,
      [assunto, org, time],
    );
    const whatsapp = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `filtros-${marca}`,
      display_name: "Whats Suporte",
      phone_number: "+556130004242",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const telefone = randomUUID();
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', 'Central', '+556130004343',
               'voip.e2e-filtros.com.br', 5060, 'udp', $4, decode('00', 'hex'), $5)`,
      [telefone, org, CHANNEL_PROVIDER_SIP_TRUNK, `filtros${marca}`, time],
    );

    // ─── As conversas: uma por cliente ──────────────────────────────────────
    const conversa = async (
      cliente: string,
      opcoes: { dono?: string; canal?: string; meio?: "phone" } = {},
    ): Promise<string> => {
      const contato = await insert("contacts", {
        organization_id: org,
        display_name: cliente,
        phone_number: `+55619${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      });
      return insert("conversations", {
        organization_id: org,
        contact_id: contato,
        channel_session_id: opcoes.canal ?? whatsapp,
        ...(opcoes.meio ? { channel: opcoes.meio } : {}),
        status: "open",
        ...(opcoes.dono ? { assigned_to_user_id: opcoes.dono } : {}),
        last_message_at: new Date().toISOString(),
        // Sem o nome do cliente: a busca por texto na tela (`getByText`) casaria o
        // nome E a prévia, e o Playwright recusa localizador com dois alvos.
        last_message_preview: "Olá, preciso de ajuda",
      });
    };
    const daAnaHoje = await conversa("Cliente Um Filtros", { dono: pessoas.ana.id });
    const daAnaOntem = await conversa("Cliente Dois Filtros", { dono: pessoas.ana.id });
    const doBruno = await conversa("Cliente Tres Filtros", { dono: pessoas.bruno.id });
    await conversa("Cliente Quatro Filtros", { dono: pessoas.ana.id });
    await conversa("Cliente Cinco Filtros", { canal: telefone, meio: "phone" });

    // Encerrar as três primeiras: o gatilho carimba no atendimento quem estava
    // com a conversa (`assigned_to_user_id`) — é esse o dono que o filtro lê.
    const encerradas = await db
      .from("conversations")
      .update({ status: "closed" })
      .in("id", [daAnaHoje, daAnaOntem, doBruno])
      .eq("organization_id", org);
    if (encerradas.error) throw encerradas.error;
    // Um dos da Ana foi encerrado ONTEM, e o de hoje tem assunto.
    await sql(
      `update public.atendimentos set closed_at = now() - interval '1 day'
        where organization_id = $1 and conversation_id = $2 and closed_at is not null`,
      [org, daAnaOntem],
    );
    await sql(
      `update public.atendimentos set assunto_id = $3, team_id = $4
        where organization_id = $1 and conversation_id = $2 and closed_at is not null`,
      [org, daAnaHoje, assunto, time],
    );

    // ═══ 1. A ANA: "Só as minhas" ════════════════════════════════════════════
    const ana = await contextoDaAna.newPage();
    await login(ana, pessoas.ana.email, password);
    await ana.goto("/app/inbox?filter=closed");
    await expect(fechados(ana)).toHaveCount(3);
    await ana.screenshot({ path: `${evidence}/01-fechadas-misturadas.png` });

    const soAsMinhas = ana.getByTestId("so-as-minhas");
    await expect(soAsMinhas).toHaveAttribute("aria-pressed", "false");
    await soAsMinhas.click();
    await expect(soAsMinhas).toHaveAttribute("aria-pressed", "true");
    await expect(fechados(ana)).toHaveCount(2);
    await expect(fechados(ana).filter({ hasText: "Cliente Tres Filtros" })).toHaveCount(0);
    // O selo da aba conta o mesmo que a lista mostra.
    await expect(ana.getByRole("tab", { name: /Fechadas/i })).toContainText("2");
    expect(parametros(ana).get("assigned_to")).toBe("me");
    await ana.screenshot({ path: `${evidence}/02-so-as-minhas.png` });

    // ═══ 2. Recarregar, e abrir o endereço copiado em outra janela ═══════════
    const enderecoFiltrado = ana.url();
    await ana.reload();
    await expect(ana.getByTestId("so-as-minhas")).toHaveAttribute("aria-pressed", "true");
    await expect(fechados(ana)).toHaveCount(2);

    const outraJanela = await contextoDaAna.newPage();
    await outraJanela.goto(enderecoFiltrado);
    await expect(outraJanela.getByTestId("so-as-minhas")).toHaveAttribute("aria-pressed", "true");
    await expect(fechados(outraJanela)).toHaveCount(2);
    await outraJanela.close();

    // Trocar de aba mantém o filtro no endereço; em Minhas ele não é aplicado.
    await ana.getByRole("tab", { name: /Minhas/i }).click();
    await expect(ana.getByText("Cliente Quatro Filtros")).toBeVisible();
    expect(parametros(ana).get("assigned_to")).toBe("me");
    expect(parametros(ana).get("filter")).toBe("mine");

    // ═══ 3. A GESTORA: um atendente pelo nome ════════════════════════════════
    const gestora = await contextoDaGestora.newPage();
    await login(gestora, pessoas.gestora.email, password);
    await gestora.goto("/app/inbox?filter=closed");
    await expect(fechados(gestora)).toHaveCount(3);
    await abrirFunil(gestora);

    // O FUNIL CABE NA COLUNA. Em Fechadas ele tem o maior número de seletores
    // (atendente, caixa, período, assunto), numa coluna de 300 px. Medido, e não
    // a olho: nada passa da largura do painel, e nenhum seletor some para fora.
    const painel = gestora.getByTestId("inbox-filtros-auxiliares");
    const medidas = await painel.evaluate((el) => {
      const caixa = el.getBoundingClientRect();
      const seletores = [...el.querySelectorAll<HTMLElement>("[data-testid^='filtro-de-']")].map((s) => {
        const r = s.getBoundingClientRect();
        return { id: s.dataset.testid ?? "", esquerda: r.left, direita: r.right, largura: r.width };
      });
      return { transborda: el.scrollWidth > el.clientWidth + 1, esquerda: caixa.left, direita: caixa.right, seletores };
    });
    expect(medidas.transborda, "o painel de filtros ganhou rolagem horizontal").toBe(false);
    expect(medidas.seletores.map((s) => s.id).sort()).toEqual([
      "filtro-de-assunto",
      "filtro-de-atendente",
      "filtro-de-caixa",
      "filtro-de-periodo",
    ]);
    for (const seletor of medidas.seletores) {
      expect(seletor.esquerda, `${seletor.id} sai pela esquerda`).toBeGreaterThanOrEqual(medidas.esquerda - 1);
      expect(seletor.direita, `${seletor.id} sai pela direita`).toBeLessThanOrEqual(medidas.direita + 1);
      // Abaixo disso o rótulo vira só reticências.
      expect(seletor.largura, `${seletor.id} ficou estreito demais para ler`).toBeGreaterThanOrEqual(110);
    }
    await gestora.screenshot({ path: `${evidence}/03a-funil-em-fechadas.png` });

    await escolher(gestora, "filtro-de-atendente", "Bruno Atendente");
    await expect(fechados(gestora)).toHaveCount(1);
    await expect(fechados(gestora)).toContainText("Cliente Tres Filtros");
    expect(parametros(gestora).get("assigned_to")).toBe(pessoas.bruno.id);
    // O funil diz que há um filtro dele valendo.
    await expect(gestora.getByTestId("inbox-abrir-filtros")).toContainText("1");
    await gestora.screenshot({ path: `${evidence}/03-fechadas-do-bruno.png` });

    // ═══ 4. Período e assunto ════════════════════════════════════════════════
    await escolher(gestora, "filtro-de-atendente", "Ana Atendente");
    await expect(fechados(gestora)).toHaveCount(2);
    await escolher(gestora, "filtro-de-periodo", "Hoje");
    await expect(fechados(gestora)).toHaveCount(1);
    await expect(fechados(gestora)).toContainText("Cliente Um Filtros");
    expect(parametros(gestora).get("periodo")).toBe("hoje");
    await gestora.screenshot({ path: `${evidence}/04-da-ana-hoje.png` });

    await escolher(gestora, "filtro-de-periodo", "Ontem");
    await expect(fechados(gestora)).toHaveCount(1);
    await expect(fechados(gestora)).toContainText("Cliente Dois Filtros");

    await escolher(gestora, "filtro-de-periodo", "Qualquer data");
    await escolher(gestora, "filtro-de-atendente", "Todos os atendentes");
    await expect(fechados(gestora)).toHaveCount(3);
    await escolher(gestora, "filtro-de-assunto", /Sem internet/);
    await expect(fechados(gestora)).toHaveCount(1);
    await expect(fechados(gestora)).toContainText("Cliente Um Filtros");
    expect(parametros(gestora).get("assunto_id")).toBe(assunto);
    await gestora.screenshot({ path: `${evidence}/05-por-assunto.png` });

    // ═══ 5. Sem resultado: a tela diz QUAL filtro, e "Limpar" devolve tudo ═══
    await escolher(gestora, "filtro-de-atendente", "Bruno Atendente");
    await expect(fechados(gestora)).toHaveCount(0);
    const vazio = gestora.getByTestId("lista-de-atendimentos-fechados");
    await expect(vazio).toContainText("Nenhuma conversa com esses filtros");
    await expect(vazio).toContainText("Atendente");
    await expect(vazio).toContainText("Assunto");
    await gestora.screenshot({ path: `${evidence}/06-vazio-por-filtro.png` });
    await gestora.getByRole("button", { name: /Limpar filtros/i }).click();
    await expect(fechados(gestora)).toHaveCount(3);
    expect([...parametros(gestora).keys()]).toEqual(["filter"]);

    // ═══ 6. A caixa de entrada: só o telefone ════════════════════════════════
    await gestora.getByRole("tab", { name: /Todas/i }).click();
    await expect(gestora.getByText("Cliente Quatro Filtros")).toBeVisible();
    await expect(gestora.getByText("Cliente Cinco Filtros")).toBeVisible();
    await abrirFunil(gestora);
    await escolher(gestora, "filtro-de-caixa", "Telefone");
    await expect(gestora.getByText("Cliente Cinco Filtros")).toBeVisible();
    await expect(gestora.getByText("Cliente Quatro Filtros")).toHaveCount(0);
    expect(parametros(gestora).get("channel")).toBe("phone");
    await expect(gestora.getByRole("tab", { name: /Todas/i })).toContainText("1");
    await gestora.screenshot({ path: `${evidence}/07-so-telefone.png` });

    // E o contrário: o WhatsApp não traz a conversa de telefone.
    await escolher(gestora, "filtro-de-caixa", "WhatsApp");
    await expect(gestora.getByText("Cliente Quatro Filtros")).toBeVisible();
    await expect(gestora.getByText("Cliente Cinco Filtros")).toHaveCount(0);
  } finally {
    await contextoDaAna.close();
    await contextoDaGestora.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    for (const pessoa of Object.values(pessoas)) {
      if (pessoa.id) await db.auth.admin.deleteUser(pessoa.id);
    }
  }
});
