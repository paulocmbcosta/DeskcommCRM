/**
 * CHAT DO SITE — a jornada inteira, pelos DOIS lados, pela tela.
 *
 * ## Por que esta spec existe, tendo ~90 testes de unidade
 *
 * Porque este é o único canal em que o "cliente" do outro lado é um NAVEGADOR
 * num site que não é nosso. Os unitários provam cada peça (o que a ingestão
 * grava, o que a leitura recorta, o que a casca recusa); nenhum deles prova que
 * um `<script>` colado numa página de OUTRA ORIGEM carrega, atravessa o proxy
 * sem cookie, passa pelo preflight de CORS de verdade, abre a conversa, e que a
 * resposta digitada no Inbox aparece no balão do visitante. Cada uma dessas
 * ligações falha em silêncio: sem CORS o widget vê "falha de rede", sem a
 * entrada em `public-paths` o proxy responde 401 antes de a rota existir, e o
 * dono só descobre porque "ninguém escreve".
 *
 * ## O site do cliente é uma origem DIFERENTE de verdade
 *
 * `http://site-do-cliente.test` é servido por `page.route` (nenhum servidor
 * extra), mas o navegador o trata como origem própria: o `fetch` do widget para
 * o CRM é cross-origin real, com preflight real contra o servidor real. Servir
 * a página de teste do MESMO host do CRM passaria verde sem CORS nenhum — e
 * mediria um mundo que nenhum cliente tem.
 *
 * ## Dois navegadores, porque são duas pessoas
 *
 * O visitante roda num contexto SEM os cookies do admin. Com o mesmo contexto, o
 * cookie de sessão acompanharia o pedido e uma rota pública quebrada (que
 * exigisse login) passaria despercebida.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ mode: "serial", timeout: 120_000 });

/**
 * O Chromium barra pedido de uma origem "pública" para `localhost` (Local Network
 * Access) — e o ambiente E2E é exatamente isso: um site de mentira chamando um CRM
 * que mora em `localhost:3001`. Medido antes de desligar, pelo console da página:
 *
 *   Access to script at 'http://localhost:3001/site-chat/widget.js' from origin
 *   'http://site-do-cliente.test' has been blocked by CORS policy: The request
 *   client is not a secure context and the resource is in more-private address
 *   space `local`.
 *
 * É restrição do LABORATÓRIO, não do produto: em produção o CRM está num domínio
 * público com https, e de público para público a regra não se aplica. Desligar a
 * checagem aqui NÃO desliga o CORS — o preflight do POST continua acontecendo
 * contra o servidor real, e é ele que esta spec mede.
 */
test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"] },
});

const SITE = "http://site-do-cliente.test";
const COR = "#e11d48";
const COR_RGB = "rgb(225, 29, 72)";

let nomeDoChat: string;
let snippet: string;
let admin: Page;
let contextoDoAdmin: BrowserContext;
let contextoDoVisitante: BrowserContext;
let visitante: Page;
const nomeDoVisitante = `Marina do Site ${Date.now().toString().slice(-6)}`;

/** Uma página de um site qualquer, com o código colado antes de `</body>`. */
async function abrirSiteDoCliente(browser: Browser, codigo: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  await ctx.route(`${SITE}/**`, (rota) =>
    rota.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Loja do Cliente</title></head>
<body><h1>Loja do Cliente</h1><p>Uma página qualquer, de outro domínio.</p>${codigo}</body></html>`,
    }),
  );
  const page = await ctx.newPage();
  await page.goto(`${SITE}/planos?utm_source=e2e`);
  return { ctx, page };
}

test.beforeAll(async ({ browser }) => {
  contextoDoAdmin = await browser.newContext();
  admin = await contextoDoAdmin.newPage();
  await loginComoAdmin(admin, lerCreds());
  nomeDoChat = `Site E2E ${Date.now().toString().slice(-6)}`;
});

test.afterAll(async () => {
  await contextoDoVisitante?.close();
  await contextoDoAdmin?.close();
});

test("o dono cria o chat, escolhe a cor e VÊ a cor na prévia antes de publicar", async () => {
  await admin.goto("/app/connections?aba=site");
  await admin.getByLabel("Nome do chat (só você vê)").last().fill(nomeDoChat);
  await admin.getByTestId("site-chat-criar").click();

  const editor = admin.getByTestId("site-chat-editor").filter({ hasText: nomeDoChat });
  await expect(editor).toBeVisible();
  // Recém-criado: o código existe, e a tela NÃO finge que já está no ar.
  await expect(editor.getByTestId("site-chat-sinal")).toHaveText(/Ainda não instalado/);

  await editor.getByLabel("Título do chat").fill("Fale com a Loja");
  await editor.getByLabel("Cor principal", { exact: true }).fill(COR);

  // Medido por ferramenta, não a olho: a prévia pinta com a cor ESCOLHIDA antes
  // de salvar — é para isso que ela existe.
  const topo = editor.getByTestId("site-chat-previa-topo");
  await expect(topo).toHaveCSS("background-color", COR_RGB);
  await expect(topo).toContainText("Fale com a Loja");

  await editor.getByTestId("site-chat-salvar").click();
  await expect(admin.getByText(/Chat do site salvo/)).toBeVisible();

  snippet = (await editor.getByTestId("site-chat-snippet").innerText()).trim();
  expect(snippet).toMatch(/^<script async src="http[^"]+\/site-chat\/widget\.js" data-widget-key="wc_[a-zA-Z0-9]{24}"><\/script>$/);
  // O endereço é o do servidor que está servindo a tela — nunca o placeholder do build.
  expect(snippet).not.toContain("placeholder.invalid");
});

test("num site de OUTRA origem, o balão aparece com a cor configurada", async ({ browser }) => {
  const aberto = await abrirSiteDoCliente(browser, snippet);
  contextoDoVisitante = aberto.ctx;
  visitante = aberto.page;

  const lancador = visitante.getByTestId("site-chat-lancador");
  await expect(lancador).toBeVisible({ timeout: 20_000 });
  await expect(lancador).toHaveCSS("background-color", COR_RGB);

  // Geometria medida: balão de 56px, encostado no canto inferior direito.
  const caixa = await lancador.boundingBox();
  const janela = visitante.viewportSize();
  expect(caixa?.width).toBe(56);
  expect(caixa?.height).toBe(56);
  expect((janela?.width ?? 0) - ((caixa?.x ?? 0) + (caixa?.width ?? 0))).toBe(20);
});

test("o visitante preenche o formulário e a mensagem dele aparece no balão", async () => {
  await visitante.getByTestId("site-chat-lancador").click();
  const painel = visitante.getByTestId("site-chat-painel");
  await expect(painel).toBeVisible();
  await expect(painel).toContainText("Fale com a Loja");

  // O formulário INTEIRO cabe no painel, sem rolar. Medido, e não conferido a
  // olho, por causa de um defeito real: a área de conversa "escondida" seguia
  // ocupando metade do painel (`display:flex` vencia o atributo `hidden`) e o
  // botão de iniciar ficava fora da vista. Os casos abaixo passavam mesmo assim
  // — o Playwright rola até o elemento antes de clicar; uma pessoa não sabe que
  // há o que rolar.
  const caixaDoPainel = await painel.boundingBox();
  const caixaDoBotao = await visitante.getByTestId("site-chat-comecar").boundingBox();
  expect(caixaDoPainel && caixaDoBotao).toBeTruthy();
  expect((caixaDoBotao?.y ?? 0) + (caixaDoBotao?.height ?? 0)).toBeLessThanOrEqual(
    (caixaDoPainel?.y ?? 0) + (caixaDoPainel?.height ?? 0),
  );
  await expect(visitante.getByTestId("site-chat-mensagens")).toBeHidden();
  // `toBeInViewport` leva em conta o recorte dos ancestrais com rolagem: botão
  // que existe mas está cortado pelo `overflow` do formulário reprova aqui.
  await expect(visitante.getByTestId("site-chat-comecar")).toBeInViewport({ ratio: 1 });

  // Nome é obrigatório no padrão: enviar sem ele NÃO abre conversa.
  // Por test id, e não por rótulo: o campo do formulário e o do rodapé da
  // conversa têm o mesmo nome acessível, e os dois moram no DOM ao mesmo tempo.
  await visitante.getByTestId("site-chat-campo-mensagem").fill("Oi! Vocês entregam em Recife?");
  await visitante.getByTestId("site-chat-comecar").click();
  await expect(painel.getByText("Preencha este campo.")).toBeVisible();

  await visitante.getByTestId("site-chat-campo-nome").fill(nomeDoVisitante);
  await visitante.getByTestId("site-chat-campo-telefone").fill(`11 9${Date.now().toString().slice(-8)}`);
  await visitante.getByTestId("site-chat-comecar").click();

  const minha = visitante.getByTestId("site-chat-msg-visitante").filter({ hasText: "entregam em Recife" });
  await expect(minha).toBeVisible();
  // "Enviando…" tem de virar hora: é a prova de que o POST cross-origin deu 201.
  await expect(minha).not.toContainText(/Enviando|Não enviada/, { timeout: 20_000 });

  // O token ficou no localStorage do SITE (primeira parte) — é o que faz a
  // conversa sobreviver à troca de página.
  const guardado = await visitante.evaluate(() =>
    Object.keys(window.localStorage).filter((k) => k.startsWith("site-chat:")).map((k) => window.localStorage.getItem(k)),
  );
  expect(guardado).toHaveLength(1);
  expect(guardado[0]).toMatch(/"t":"wv_[A-Za-z0-9_-]{43}"/);
});

/**
 * A conversa do visitante, achada pela BUSCA da API — que alcança o nome do
 * contato e não depende de aba.
 *
 * ⚠️ A primeira versão procurava o card na lista do Inbox, e reprovou no CI com o
 * produto certo (run 35528903796): lá o banco é compartilhado com ~38 specs que
 * rodam antes e deixam rodízio e times configurados, então a conversa nova é
 * ATRIBUÍDA a alguém e sai da aba "Fila" — o screenshot da falha mostra a Fila
 * com 2 conversas e as outras abas com 7, 1 e 4. Presumir a aba era medir o
 * ambiente. Em qual aba a conversa cai é regra de roteamento, que tem spec
 * própria; o que ESTA jornada afirma é que ela existe, é do site, e responde.
 */
async function conversaDoVisitanteNoCrm(): Promise<{ id: string; channel: string }> {
  let achada: { id: string; channel: string } | undefined;
  await expect
    .poll(
      async () => {
        const r = await admin.request.get(
          `/api/v1/conversations?limit=20&search=${encodeURIComponent(nomeDoVisitante)}`,
        );
        if (!r.ok()) return `http ${r.status()}`;
        const { data } = (await r.json()) as {
          data: Array<{ id: string; channel: string; contacts?: { display_name?: string | null } }>;
        };
        achada = data.find((c) => c.contacts?.display_name === nomeDoVisitante);
        return achada ? "achada" : `sem a conversa entre ${data.length}`;
      },
      { timeout: 30_000, message: "a conversa do visitante não apareceu na busca do Inbox" },
    )
    .toBe("achada");
  return achada as { id: string; channel: string };
}

test("a conversa nasce no Inbox, marcada como vinda do SITE, e o atendente responde", async () => {
  const conversa = await conversaDoVisitanteNoCrm();
  // O MEIO chega ao navegador do atendente no mesmo payload que o card lê — é por
  // ele que o ícone vira globo (o desenho em si está preso em
  // `tests/unit/inbox-por-onde-entrou.test.tsx`, que não depende do banco do CI).
  expect(conversa.channel).toBe("site_chat");

  await admin.goto(`/app/inbox/${conversa.id}`);
  await expect(admin.getByText("Oi! Vocês entregam em Recife?").first()).toBeVisible({ timeout: 30_000 });

  const campo = admin.getByRole("textbox", { name: "Mensagem", exact: true });
  await campo.fill("Entregamos sim! Em Recife chega em 3 dias úteis.");
  await campo.press("Enter");
  await expect(admin.getByText("Entregamos sim! Em Recife chega em 3 dias úteis.").first()).toBeVisible();
});

test("a resposta do atendente chega ao balão do visitante — e vira `delivered` no CRM", async () => {
  const resposta = visitante.getByTestId("site-chat-msg-atendente").filter({ hasText: "Entregamos sim!" });
  await expect(resposta).toBeVisible({ timeout: 30_000 });

  // O laço de retorno: entregar ao navegador é o que promove a mensagem. Lido
  // pela API do próprio atendente (o mesmo dado que pinta o tique na tela).
  const conversa = await conversaDoVisitanteNoCrm();
  await expect
    .poll(
      async () => {
        const msgs = await admin.request.get(`/api/v1/conversations/${conversa.id}/messages?limit=20`);
        const corpo = (await msgs.json()) as { data: Array<{ body: string | null; status: string }> };
        return corpo.data.find((m) => m.body?.startsWith("Entregamos sim!"))?.status ?? "sem-mensagem";
      },
      { timeout: 30_000 },
    )
    .toBe("delivered");
});

test("recarregar o site NÃO perde a conversa", async () => {
  await visitante.reload();
  // Quem volta não tem nada de NOVO para ler: o histórico que a página releu já
  // foi visto. Sem guardar "até onde viu", o selo contava todas as respostas
  // antigas a cada troca de página.
  await expect(visitante.getByTestId("site-chat-lancador")).toBeVisible({ timeout: 20_000 });
  await visitante.waitForTimeout(1_500);
  await expect(visitante.getByTestId("site-chat-lancador")).toHaveAttribute("aria-label", "Abrir chat");
  await visitante.getByTestId("site-chat-lancador").click();
  const painel = visitante.getByTestId("site-chat-painel");
  await expect(painel.getByTestId("site-chat-msg-visitante").filter({ hasText: "entregam em Recife" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(painel.getByTestId("site-chat-msg-atendente").filter({ hasText: "Entregamos sim!" })).toBeVisible();
  // Quem já conversou não vê o formulário de novo.
  await expect(visitante.getByTestId("site-chat-comecar")).toBeHidden();
});

test("a tela de Conexões passa a dizer ONDE o chat está instalado", async () => {
  await admin.goto("/app/connections?aba=site");
  const editor = admin.getByTestId("site-chat-editor").filter({ hasText: nomeDoChat });
  await expect(editor.getByTestId("site-chat-sinal")).toHaveText(/Instalado · site-do-cliente\.test/, {
    timeout: 30_000,
  });
});

test("site fora da lista do dono: o balão NÃO aparece (e o site do cliente segue intacto)", async ({ browser }) => {
  const editor = admin.getByTestId("site-chat-editor").filter({ hasText: nomeDoChat });
  await editor.getByLabel("Sites autorizados (opcional)").fill("outro-site.com.br");
  await editor.getByTestId("site-chat-salvar").click();
  await expect(admin.getByText(/Chat do site salvo/).first()).toBeVisible();

  const { ctx, page } = await abrirSiteDoCliente(browser, snippet);
  await expect(page.getByRole("heading", { name: "Loja do Cliente" })).toBeVisible();
  // Controle positivo do caso: o script CARREGOU (senão "não apareceu" não prova nada).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __siteChatCarregado?: boolean }).__siteChatCarregado)).toBe(true);
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId("site-chat-lancador")).toHaveCount(0);
  await ctx.close();

  // Devolve a lista ao estado aberto para o caso seguinte medir a EXCLUSÃO, e não a lista.
  await editor.getByLabel("Sites autorizados (opcional)").fill("");
  await editor.getByTestId("site-chat-salvar").click();
  await expect(admin.getByText(/Chat do site salvo/).first()).toBeVisible();
});

test("excluir pede confirmação nomeando o alvo — e tira o balão do ar na hora", async ({ browser }) => {
  const editor = admin.getByTestId("site-chat-editor").filter({ hasText: nomeDoChat });
  await editor.getByTestId("site-chat-excluir").click();

  const dialogo = admin.getByRole("alertdialog");
  await expect(dialogo).toContainText(nomeDoChat);
  await expect(dialogo).toContainText(/Não há desfazer/);
  // Cancelar NÃO exclui (doutrina da ação destrutiva: o primeiro clique só pergunta).
  await dialogo.getByRole("button", { name: "Cancelar" }).click();
  await expect(editor).toBeVisible();

  await editor.getByTestId("site-chat-excluir").click();
  await admin.getByTestId("site-chat-confirmar-exclusao").click();
  await expect(admin.getByText(/Chat do site excluído/)).toBeVisible();
  await expect(admin.getByTestId("site-chat-editor").filter({ hasText: nomeDoChat })).toHaveCount(0);

  // O código continua colado no site do cliente — e o balão some mesmo assim.
  const { ctx, page } = await abrirSiteDoCliente(browser, snippet);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __siteChatCarregado?: boolean }).__siteChatCarregado)).toBe(true);
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId("site-chat-lancador")).toHaveCount(0);
  await ctx.close();

  // E a conversa que já tinha entrado continua no Inbox, com o histórico inteiro.
  const conversa = await conversaDoVisitanteNoCrm();
  await admin.goto(`/app/inbox/${conversa.id}`);
  await expect(admin.getByText("Oi! Vocês entregam em Recife?").first()).toBeVisible({ timeout: 30_000 });
});
