/**
 * [P1] O inbox de quem atende com PROTOCOLO — trilho de abas, filtros recolhidos,
 * card que diz time e canal, e o painel com histórico e linha do tempo.
 *
 * É a jornada de uma operação regulada (telecom): cada atendimento tem número
 * de protocolo; fechou, some da fila; o cliente voltou, nasce atendimento NOVO
 * com protocolo NOVO, e o anterior fica no histórico, navegável e achável pelo
 * número.
 *
 * Dirige o FRONTEND, logada, clicando (doutrina de QA Visual). O que entra por
 * baixo — a mensagem do cliente — entra pelo MESMO caminho da ingestão: INSERT
 * em `messages`, que é o que dispara `fn_service_inbound` e a reabertura. Um
 * `update conversations set status='open'` provaria o trigger de atendimento e
 * não provaria o produto.
 *
 * O que ela mede e teste de unidade não alcança:
 *   1. o trilho e os filtros recolhidos DEVOLVEM altura à lista (medido em px);
 *   2. o protocolo que o banco gerou CHEGA à tela, e muda quando o cliente volta;
 *   3. abrir um atendimento antigo recorta a conversa naquele episódio e trava
 *      o composer — e "voltar ao atual" desfaz os dois;
 *   4. a busca pelo protocolo ANTIGO acha o atendimento estando em outra aba;
 *   5. o atendimento novo começa do ZERO — sem o time nem o dono do anterior
 *      (migration 0269): quem falou com a Cobrança e volta por outro assunto
 *      passa pela triagem de novo, em vez de cair na fila da Cobrança;
 *   6. a aba Fechadas lista ATENDIMENTOS: o que foi encerrado continua lá depois
 *      que o cliente volta e a conversa reabre — contra o PostgREST de verdade,
 *      que é onde os filtros embutidos (`conversations.tags`) podem falhar;
 *   7. a NOTA INTERNA pertence ao atendimento em que foi escrita: a do primeiro
 *      não aparece no atendimento novo, e a do novo não aparece ao abrir o
 *      antigo — as duas escritas PELO COMPOSER, como o atendente faz.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/inbox-protocolo";

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Time e vínculo da conversa entram por SQL direto: `attendance_teams` só aceita
 * escrita pela RPC de gestor com MFA (GRANT só de SELECT até para o service
 * role), e o que esta spec mede é o inbox, não o cadastro de times — que tem
 * spec própria.
 */
async function sql(texto: string, valores: unknown[] = []): Promise<void> {
  const cliente = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await cliente.connect();
  try {
    await cliente.query(texto, valores);
  } finally {
    await cliente.end();
  }
}

const NOTA_DO_PRIMEIRO = "Nota do financeiro: enviada a segunda via por e-mail";
const NOTA_DO_SEGUNDO = "Nota do suporte: técnico agendado para quinta";

/** Escreve uma nota interna PELO COMPOSER — o caminho de quem atende, não o da API. */
async function escreverNotaInterna(page: Page, texto: string): Promise<void> {
  await page.getByRole("button", { name: "Nota interna", exact: true }).click();
  const campo = page.getByLabel("Mensagem", { exact: true });
  await campo.fill(texto);
  await campo.press("Enter");
  await expect(page.getByTestId("chat-thread")).toContainText(texto);
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("protocolo por atendimento: fechar, o cliente voltar, histórico e busca pelo número", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const password = `Local-${randomUUID()}!`;
  const email = `protocolo-${randomUUID()}@invariant.test`;
  let org = "";
  let user = "";

  try {
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Juliana Teste" },
    });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", {
      display_name: "Telecom local",
      legal_name: "Telecom local",
      slug: `protocolo-${randomUUID()}`,
      onboarded_at: new Date().toISOString(),
    });
    const membership = await db.from("user_organizations").insert({
      organization_id: org,
      user_id: user,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    if (membership.error) throw membership.error;

    const contact = await insert("contacts", {
      organization_id: org,
      display_name: "Fernando Protocolo",
      phone_number: "+5561993040001",
    });
    const session = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `protocolo-${randomUUID()}`,
      display_name: "Whats Suporte",
      phone_number: "+556130004063",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const conversation = await insert("conversations", {
      organization_id: org,
      contact_id: contact,
      channel_session_id: session,
      status: "open",
    });

    async function inbound(body: string): Promise<void> {
      const sentAt = new Date().toISOString();
      await insert("messages", {
        organization_id: org,
        contact_id: contact,
        conversation_id: conversation,
        channel_session_id: session,
        direction: "inbound",
        type: "text",
        status: "received",
        sent_via: "ai",
        body,
        sent_at: sentAt,
      });
      const marked = await db.rpc("fn_mark_conversation_message", {
        p_conv: conversation,
        p_direction: "inbound",
        p_preview: body,
        p_at: sentAt,
      });
      if (marked.error) throw marked.error;
    }

    await inbound("Quero a segunda via do boleto");

    const time = randomUUID();
    await sql(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, 'Cobrança', 'cobranca')`, [time, org]);
    await sql(`update public.conversations set team_id = $1 where id = $2`, [time, conversation]);

    const protocoloDe = async (): Promise<string> => {
      const { data, error } = await db.from("conversations").select("protocol").eq("id", conversation).single();
      if (error) throw error;
      return String(data.protocol);
    };
    const primeiro = await protocoloDe();
    expect(primeiro, "a conversa nasce com protocolo de 14 dígitos").toMatch(/^\d{14}$/);

    // ─── 1. A lista: trilho, filtros recolhidos, card ───────────────────────
    await login(page, email, password);
    await page.goto("/app/inbox?filter=all");

    const trilho = page.getByTestId("inbox-abas");
    await expect(trilho).toBeVisible();
    await expect(page.getByRole("tab", { name: "Fila" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Todas" })).toHaveAttribute("aria-selected", "true");
    // O nome da aba está ESCRITO — no trilho só cabe o ícone.
    await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Todas");

    // Medido, não estimado: o trilho é estreito e fica À ESQUERDA da lista.
    const caixaDoTrilho = await trilho.boundingBox();
    expect(caixaDoTrilho?.width ?? 0).toBeLessThanOrEqual(48);

    const card = page.locator(`[data-conversation-id="${conversation}"]`);
    await expect(card).toBeVisible();
    // Em 1440px a lista tem os 300px cheios. Já ficou presa em 248px com a regra
    // de 1400px escrita e sem valer — a do `xl` vinha depois no CSS e vencia.
    expect((await card.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(296);
    // A primeira conversa começa ALTO na coluna: busca + título, sem faixa de
    // abas nem seletores abertos por cima. 140px é o teto com folga.
    const caixaDoCard = await card.boundingBox();
    const caixaDaColuna = await page.getByTestId("inbox-aba-atual").boundingBox();
    expect((caixaDoCard?.y ?? 999) - (caixaDaColuna?.y ?? 0)).toBeLessThan(140);

    // Filtros recolhidos: abrem no funil, fecham no funil.
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toHaveCount(0);
    await page.getByTestId("inbox-abrir-filtros").click();
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toBeVisible();
    await expect(page.getByLabel("Filtrar por time")).toBeVisible();
    await page.screenshot({ path: `${evidence}/01-filtros-abertos.png` });
    await page.getByTestId("inbox-abrir-filtros").click();
    await expect(page.getByTestId("inbox-filtros-auxiliares")).toHaveCount(0);

    // O card diz DE QUEM é e POR ONDE entrou, antes de abrir — e há quanto tempo espera.
    const rodape = card.getByTestId("rodape-da-conversa");
    await expect(rodape).toContainText("Cobrança");
    await expect(rodape).toContainText("Whats Suporte · 4063");
    // Nada cortado: o rodapé existe para dizer o nome INTEIRO do time e do canal.
    const cortado = await rodape.evaluate((el) =>
      [...el.querySelectorAll("span.truncate")].some((s) => s.scrollWidth > s.clientWidth + 1),
    );
    expect(cortado, "time ou canal com reticências no card").toBe(false);
    await expect(card.getByTestId("espera-da-conversa")).toContainText("Aguardando há");
    await page.screenshot({ path: `${evidence}/02-lista-com-time-e-canal.png` });

    // ─── 2. O painel: protocolo e ficha da conversa ─────────────────────────
    await card.click();
    const painel = page.getByTestId("painel-da-conversa").first();
    await expect(painel.getByTestId("protocolo-do-atendimento")).toContainText(primeiro);
    const ficha = painel.getByTestId("ficha-da-conversa");
    await expect(ficha).toContainText(primeiro);
    await expect(ficha).toContainText("Whats Suporte");
    await expect(ficha).toContainText("Cobrança");
    await page.screenshot({ path: `${evidence}/03-painel-detalhes.png` });

    // Fechar o painel devolve a largura à conversa (clicar na aba aberta fecha).
    const larguraAntes = (await page.getByTestId("chat-thread").boundingBox())?.width ?? 0;
    await page.getByTestId("painel-aba-detalhes").click();
    await expect(painel).toHaveAttribute("data-aba", "fechado");
    const larguraDepois = (await page.getByTestId("chat-thread").boundingBox())?.width ?? 0;
    expect(larguraDepois).toBeGreaterThan(larguraAntes + 200);
    await page.getByTestId("painel-aba-detalhes").click();

    // ─── 3. Assumir e fechar; a linha do tempo conta, com autor ─────────────
    await page.getByRole("button", { name: "Assumir", exact: true }).click();
    await expect(page.getByTestId("comando-da-conversa")).toContainText("Juliana Teste");
    await escreverNotaInterna(page, NOTA_DO_PRIMEIRO);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();

    await page.getByTestId("painel-aba-linha").click();
    const linha = page.getByTestId("linha-do-tempo-da-conversa");
    await expect(linha).toContainText("Conversa aberta");
    await expect(linha).toContainText("Transferida para a fila do time");
    await expect(linha).toContainText("Cobrança. Aguardando operador disponível.");
    await expect(linha).toContainText("Atendimento assumido");
    await expect(linha).toContainText("Juliana Teste assumiu a conversa.");
    await expect(linha).toContainText("Conversa encerrada");
    await expect(linha).toContainText("Por Juliana Teste.");
    await page.screenshot({ path: `${evidence}/04-linha-do-tempo.png` });

    // Fechada, ela SOME da fila de quem atende.
    await page.goto("/app/inbox?filter=mine");
    await expect(page.locator(`[data-conversation-id="${conversation}"]`)).toHaveCount(0);

    // ─── 4. O cliente volta: atendimento NOVO, protocolo NOVO ───────────────
    await inbound("Voltei, agora é sobre a instalação");
    const segundo = await protocoloDe();
    expect(segundo).toMatch(/^\d{14}$/);
    expect(segundo, "o retorno do cliente abre protocolo novo").not.toBe(primeiro);

    // O atendimento novo começa do ZERO: nem o time nem o dono do anterior.
    // Quem falou com a Cobrança e voltou por causa da instalação não pode cair
    // na fila da Cobrança — passa pela triagem de novo.
    const { data: depoisDoRetorno, error: erroDoRetorno } = await db
      .from("conversations")
      .select("status, team_id, assigned_to_user_id, bot_silenced_until, last_handoff_at")
      .eq("id", conversation)
      .single();
    if (erroDoRetorno) throw erroDoRetorno;
    expect(depoisDoRetorno).toEqual({
      status: "open",
      team_id: null,
      assigned_to_user_id: null,
      bot_silenced_until: null,
      last_handoff_at: null,
    });

    await page.goto(`/app/inbox?filter=all&id=${conversation}`);
    await expect(page.getByTestId("painel-da-conversa").first().getByTestId("protocolo-do-atendimento")).toContainText(segundo);
    // …e a TELA diz a mesma coisa: o card saiu da Cobrança.
    const rodapeDepois = page.locator(`[data-conversation-id="${conversation}"]`).getByTestId("rodape-da-conversa");
    await expect(rodapeDepois).toContainText("Sem time");
    await expect(rodapeDepois).not.toContainText("Cobrança");
    // A linha do tempo do atendimento novo conta UMA coisa — que ele abriu. O
    // reset não é gesto de ninguém: não vira "saiu do time" nem "IA retomou".
    await page.getByTestId("painel-aba-linha").click();
    const linhaDoNovo = page.getByTestId("linha-do-tempo-da-conversa");
    await expect(linhaDoNovo).toContainText("Novo atendimento aberto");
    await expect(linhaDoNovo).not.toContainText("Cobrança");
    await page.screenshot({ path: `${evidence}/04b-atendimento-novo-do-zero.png` });
    // A conversa mostra SÓ o atendimento de agora: a mensagem antiga não está.
    const thread = page.getByTestId("chat-thread");
    await expect(thread).toContainText("Voltei, agora é sobre a instalação");
    await expect(thread).not.toContainText("Quero a segunda via do boleto");
    // A NOTA INTERNA segue a mesma janela das mensagens: a que o Financeiro
    // escreveu no atendimento anterior não entra no atendimento novo. Era o
    // defeito: as mensagens sumiam e a nota ficava, contando a história velha.
    await expect(thread).not.toContainText(NOTA_DO_PRIMEIRO);
    await escreverNotaInterna(page, NOTA_DO_SEGUNDO);
    await page.screenshot({ path: `${evidence}/04c-nota-so-do-atendimento-novo.png` });

    // ─── 5. O histórico: abrir o atendimento anterior ───────────────────────
    await page.getByTestId("painel-aba-historico").click();
    const historico = page.getByTestId("historico-de-atendimentos");
    await expect(historico.getByTestId("atendimento-do-historico")).toHaveCount(2);
    await expect(historico).toContainText(primeiro);
    await expect(historico).toContainText("Fechada");
    // O trilho diz qual aba está aberta — e só ela.
    await expect(page.getByTestId("painel-aba-historico")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("painel-aba-detalhes")).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(700, 500);
    await page.screenshot({ path: `${evidence}/05-historico.png` });
    await page.getByTestId("painel-trilho").first().screenshot({ path: `${evidence}/05b-trilho.png` });

    await historico.getByTestId("atendimento-do-historico").filter({ hasText: primeiro }).click();
    const aviso = page.getByTestId("aviso-atendimento-antigo");
    await expect(aviso).toContainText(primeiro);
    await expect(thread).toContainText("Quero a segunda via do boleto");
    await expect(thread).not.toContainText("Voltei, agora é sobre a instalação");
    // …e as notas viram junto: a do atendimento antigo aparece, a de hoje não.
    await expect(thread).toContainText(NOTA_DO_PRIMEIRO);
    await expect(thread).not.toContainText(NOTA_DO_SEGUNDO);
    // As ações agem sobre a conversa de HOJE: em cima de um atendimento antigo
    // elas somem, para ninguém fechar o atual achando que mexia no anterior.
    await expect(page.getByTestId("acoes-da-conversa")).toBeHidden();
    // Não se responde num atendimento que acabou.
    await expect(page.getByText("Este atendimento já foi encerrado. Volte ao atendimento atual para responder.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/06-atendimento-antigo.png` });

    await aviso.getByRole("button", { name: "Voltar ao atendimento atual" }).click();
    await expect(aviso).toHaveCount(0);
    await expect(thread).toContainText("Voltei, agora é sobre a instalação");
    await expect(thread).toContainText(NOTA_DO_SEGUNDO);
    await expect(thread).not.toContainText(NOTA_DO_PRIMEIRO);

    // ─── 6. A busca pelo protocolo ANTIGO, de outra aba ─────────────────────
    await page.goto("/app/inbox?filter=mine");
    await page.getByLabel("Buscar conversas").fill(primeiro);
    const achado = page.getByTestId("resultado-por-protocolo").filter({ hasText: primeiro });
    await expect(achado).toBeVisible();
    await expect(achado).toContainText("Fernando Protocolo");
    await page.screenshot({ path: `${evidence}/07-busca-por-protocolo.png` });
    await achado.click();
    await expect(page.getByTestId("aviso-atendimento-antigo")).toContainText(primeiro);

    // ─── 7. Fechadas lista o ATENDIMENTO — a conversa está ABERTA de novo ───
    // É a linha que a lista antiga (conversas em status fechado) perdia: o
    // cliente voltou, a conversa reabriu, e o que a Cobrança encerrou sumia.
    await page.goto("/app/inbox?filter=closed");
    const fechados = page.getByTestId("lista-de-atendimentos-fechados");
    const encerrado = fechados.getByTestId("atendimento-fechado").filter({ hasText: primeiro });
    await expect(encerrado).toBeVisible();
    await expect(fechados.getByTestId("atendimento-fechado")).toHaveCount(1);
    await expect(encerrado).toContainText("Fernando Protocolo");
    await expect(encerrado).toContainText("Juliana Teste");
    // Quem encerrou cabe INTEIRO: é o dado que o gestor procura nesta aba.
    const cortou = await encerrado
      .getByTestId("quem-encerrou")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cortou, "o nome de quem encerrou saiu com reticências").toBe(false);
    // O time é o do FECHAMENTO — a conversa, hoje, não tem time nenhum.
    await expect(encerrado).toContainText("Cobrança");
    await expect(encerrado).toContainText("Whats Suporte · 4063");
    await expect(encerrado.getByTestId("cliente-voltou")).toBeVisible();
    // O badge conta a mesma unidade que a lista mostra.
    await expect(page.getByRole("tab", { name: "Fechadas" })).toContainText("1");
    await page.screenshot({ path: `${evidence}/08-fechadas-lista-atendimentos.png` });

    // A busca dentro da aba acha pelo número e pelo nome — e o bloco de cima não
    // repete o mesmo atendimento.
    await page.getByLabel("Buscar conversas").fill(primeiro);
    await expect(encerrado).toBeVisible();
    await expect(page.getByTestId("resultado-por-protocolo").filter({ hasText: primeiro })).toHaveCount(0);
    await page.getByLabel("Buscar conversas").fill("Fernando");
    await expect(encerrado).toBeVisible();
    await page.getByLabel("Buscar conversas").fill("Zuleica Inexistente");
    await expect(fechados.getByTestId("atendimento-fechado")).toHaveCount(0);
    await page.getByLabel("Buscar conversas").fill("");

    // Os filtros, contra o PostgREST de verdade (dublê não prova filtro embutido).
    const ler = async (qs: string) => {
      const r = await page.request.get(`/api/v1/atendimentos?status=closed${qs}`);
      expect(r.status(), `atendimentos?status=closed${qs}`).toBe(200);
      return ((await r.json()) as { data: Array<{ protocol: string }> }).data.map((a) => a.protocol);
    };
    expect(await ler(`&team_id=${time}`), "o time do FECHAMENTO acha o atendimento").toEqual([primeiro]);
    expect(await ler("&team_id=none"), "a conversa hoje está sem time, mas o atendimento foi da Cobrança").toEqual([]);
    expect(await ler(`&channel_session_id=${session}`)).toEqual([primeiro]);
    expect(await ler("&tag=urgente")).toEqual([]);
    await sql(`update public.conversations set tags = array['urgente'] where id = $1`, [conversation]);
    expect(await ler("&tag=urgente")).toEqual([primeiro]);
    // A contagem com etiqueta respondia ERRO (`.eq("tag")`, coluna que não existe)
    // e os números sumiam de todas as abas. Agora responde, e conta igual à lista.
    const contagem = await page.request.get("/api/v1/conversations/counts?tag=urgente");
    expect(contagem.status()).toBe(200);
    expect(((await contagem.json()) as { data: { closed: number; all: number } }).data).toMatchObject({
      closed: 1,
      all: 1,
    });

    // Clicar abre AQUELE atendimento — recortado e travado —, não o atual.
    await encerrado.click();
    await expect(page.getByTestId("aviso-atendimento-antigo")).toContainText(primeiro);
    await expect(page.getByTestId("chat-thread")).toContainText("Quero a segunda via do boleto");
    await expect(page.getByTestId("chat-thread")).not.toContainText("Voltei, agora é sobre a instalação");
    await expect(page.getByTestId("chat-thread")).toContainText(NOTA_DO_PRIMEIRO);
    await expect(page.getByTestId("chat-thread")).not.toContainText(NOTA_DO_SEGUNDO);
    await expect(encerrado).toHaveAttribute("aria-current", "true");
    // A ficha é a do atendimento que está na tela: o time é o da Cobrança, que o
    // encerrou — a conversa, hoje, está sem time, e não é dela que a ficha fala.
    const fichaDoAntigo = page.getByTestId("painel-da-conversa").first().getByTestId("ficha-da-conversa");
    await expect(fichaDoAntigo).toContainText(primeiro);
    await expect(fichaDoAntigo).toContainText("Cobrança");
    await expect(fichaDoAntigo).not.toContainText("Sem time");
    await page.screenshot({ path: `${evidence}/09-fechadas-abre-o-atendimento.png` });
  } finally {
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
