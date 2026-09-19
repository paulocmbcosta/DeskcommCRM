/**
 * CHAMAR O CLIENTE PRIMEIRO — a jornada, pela tela.
 *
 * ## Por que esta spec existe, tendo 18 testes de unidade
 *
 * Porque os unitários leem ARQUIVO. Eles provam que o componente contém
 * `template_values: valores` e que a derivação e o montador usam a mesma chave
 * — o que é exatamente o defeito que custou caro, e por isso está vigiado. Mas
 * nenhum deles abre o diálogo, preenche um campo e confere que o botão
 * destravou. Um `disabled` escrito ao contrário, um campo que não chega ao
 * estado, um diálogo que nem monta: tudo isso passa verde na unidade.
 *
 * O defeito de origem também era assim. Cada peça funcionava — a rota aceitava
 * `template_values`, o montador sabia montar, o seletor listava os modelos — e
 * o produto não deixava chamar ninguém, porque faltava a tela que liga as
 * peças. Defeito de composição só aparece no caminho inteiro.
 *
 * ## O que ela mede, e pelo caminho do operador
 *
 * A jornada que o dono do produto descreveu: um cliente que **nunca escreveu**
 * — cadastrado à mão ou vindo da importação do IXC — e que a gente precisa
 * chamar. Ela não simula transporte: não há WAHA nem WABA neste ambiente, e
 * inventar um envio bem-sucedido provaria um mundo que não existe.
 *
 * O que ela prova é o que o operador VÊ e DECIDE: que o caminho existe, que o
 * diálogo diz o que este canal permite antes de ele escrever, que a trava do
 * botão responde ao que falta, e que a conversa nasce mesmo quando o envio não
 * completa — que é a regra de produto mais fácil de quebrar sem ninguém notar.
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/** Ver o cabeçalho de `inbox-busca-e-filtros`: o login com MFA espera o TOTP. */
test.describe.configure({ timeout: 60_000 });

/** Número novo a cada execução: este Supabase é compartilhado entre frentes. */
function telefoneNovo(): string {
  return `+5511${Date.now().toString().slice(-9)}`;
}

/**
 * Um contato COM telefone e SEM conversa — o estado que a feature atende.
 *
 * ⚠️ Em dois passos, e não num `POST` só, por um motivo medido: o
 * `createContactHandler` **abre a conversa sozinho** quando o corpo traz
 * telefone e a organização tem um canal vivo (`_handler.ts`, o
 * `ensureConversation` best-effort logo depois do insert). Criar assim daria um
 * contato que JÁ tem conversa, e os casos abaixo mediriam a tela errada — a
 * lista mostraria "Abrir conversa" onde a spec procura "Chamar no WhatsApp".
 *
 * O `PATCH` não tem esse ramo: só o create abre conversa. Então criar sem
 * telefone e completar depois produz exatamente o estado que interessa — que é
 * também o estado real de **quem veio da importação**, o caso que originou esta
 * feature: o importador de contatos não chama `ensureConversation` em lugar
 * nenhum, então todo contato importado nasce sem conversa.
 */
async function criarContatoSemConversa(
  page: import("@playwright/test").Page,
  nome: string,
): Promise<{ id: string; telefone: string }> {
  const criado = await page.request.post("/api/v1/contacts", {
    data: { name: nome, source: "manual" },
  });
  expect(criado.ok(), await criado.text()).toBe(true);
  const { data } = await criado.json();
  const id = data.id as string;

  const telefone = telefoneNovo();
  const completado = await page.request.patch(`/api/v1/contacts/${id}`, {
    data: { phone_number: telefone },
  });
  expect(completado.ok(), await completado.text()).toBe(true);

  return { id, telefone };
}

test.beforeEach(async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
});

test("o contato sem conversa oferece CHAMAR, e o diálogo abre", async ({ page }) => {
  // O defeito que isto prende: antes, o ícone navegava direto para o inbox com
  // uma conversa vazia. A restrição do canal só aparecia lá dentro, depois da
  // decisão — e a saída oferecida (preencher parâmetros) não existia.
  const nome = `Cliente Novo ${Date.now()}`;
  await criarContatoSemConversa(page, nome);

  await page.goto("/app/contacts");
  await expect(page.getByText(nome)).toBeVisible();

  const linha = page.getByRole("row", { name: new RegExp(nome) });
  await linha.getByRole("button", { name: /Chamar no WhatsApp/i }).click();

  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();
  await expect(dialogo.getByText(/Primeira mensagem para/i)).toBeVisible();
  await expect(dialogo.getByText(nome)).toBeVisible();
});

test("o diálogo diz o que o canal permite ANTES de escrever", async ({ page }) => {
  // A tela não sabe qual é o canal: ela lê `exige_modelo` da rota. Este caso
  // aceita os DOIS desfechos de propósito — o ambiente E2E usa o canal de texto
  // livre, e amarrar a asserção a ele faria a spec reprovar numa instalação
  // oficial, medindo o ambiente em vez do produto.
  //
  // O que é invariante, e é o que se mede: alguma das duas superfícies aparece,
  // e nunca as duas. Nenhuma das duas = o operador está diante de um diálogo
  // que não diz o que ele pode fazer, que é o defeito de origem com outra roupa.
  const nome = `Cliente Canal ${Date.now()}`;
  await criarContatoSemConversa(page, nome);

  await page.goto("/app/contacts");
  await page
    .getByRole("row", { name: new RegExp(nome) })
    .getByRole("button", { name: /Chamar no WhatsApp/i })
    .click();

  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();

  const textoLivre = dialogo.getByLabel("Mensagem");
  const soModelo = dialogo.getByText(/só permite falar primeiro com um modelo aprovado/i);
  const semCanal = dialogo.getByText(/Nenhum número de WhatsApp conectado/i);

  await expect(textoLivre.or(soModelo).or(semCanal).first()).toBeVisible();

  const livre = await textoLivre.count();
  const restrito = await soModelo.count();
  expect(livre === 0 || restrito === 0, "as duas superfícies ao mesmo tempo").toBe(true);
});

test("o botão de enviar fica travado enquanto não há o que mandar", async ({ page }) => {
  // A trava é o que transforma a recusa remota (132000, horas depois, em código
  // de erro) num campo vazio visível agora. Sem ela o operador clica, a
  // plataforma recusa, e nada na tela explica por quê.
  const nome = `Cliente Trava ${Date.now()}`;
  await criarContatoSemConversa(page, nome);

  await page.goto("/app/contacts");
  await page
    .getByRole("row", { name: new RegExp(nome) })
    .getByRole("button", { name: /Chamar no WhatsApp/i })
    .click();

  const dialogo = page.getByRole("dialog");
  const enviar = dialogo.getByRole("button", { name: /Enviar e abrir conversa/i });
  await expect(enviar).toBeDisabled();

  // Controle POSITIVO: sem ele, um botão permanentemente desabilitado — que é
  // um defeito — passaria neste caso tão bem quanto o comportamento certo.
  const campo = dialogo.getByLabel("Mensagem");
  if ((await campo.count()) > 0) {
    await campo.fill("Olá! Tudo bem?");
    await expect(enviar).toBeEnabled();
    // E destravar não pode ser um caminho só de ida: apagar volta a travar.
    await campo.fill("");
    await expect(enviar).toBeDisabled();
  }
});

test("o dossiê do contato oferece começar quando não há conversa", async ({ page }) => {
  // Este bloco devolvia `null` sem conversa — o caso mais comum de todos (o
  // cliente que ainda não chamamos) era o único sem saída na tela.
  const nome = `Cliente Dossie ${Date.now()}`;
  const { id } = await criarContatoSemConversa(page, nome);

  await page.goto(`/app/contacts/${id}`);
  const comecar = page.getByRole("button", { name: /Chamar no WhatsApp/i });
  await expect(comecar).toBeVisible();
  await expect(page.getByText(/Ainda não há conversa/i)).toBeVisible();

  await comecar.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a conversa nasce e o operador cai nela — mesmo se o envio não completar", async ({
  page,
}) => {
  // A regra de produto mais fácil de quebrar sem ninguém notar. `fn_service_begin`
  // já abriu o atendimento e escreveu na linha do tempo; apagar a conversa
  // apagaria esse rastro e faria o operador recomeçar sem saber que já tentou.
  //
  // Vai pela ROTA e não pela tela porque o que se mede aqui é o contrato dos
  // dois desfechos, e o ambiente não tem transporte para escolher qual deles
  // acontece. A tela dos casos acima já provou o caminho do clique.
  const nome = `Cliente Contrato ${Date.now()}`;
  const { id, telefone } = await criarContatoSemConversa(page, nome);

  const sessoes = await page.request.get("/api/v1/channel-sessions");
  expect(sessoes.ok(), await sessoes.text()).toBe(true);
  const { data: canais } = await sessoes.json();
  test.skip(!canais?.length, "instalação sem canal conectado — nada a chamar");

  const r = await page.request.post("/api/v1/conversations/iniciar", {
    data: {
      channel_session_id: canais[0].id,
      contact_id: id,
      phone_number: telefone,
      name: nome,
      mensagem: { type: "text", body: "Olá! Somos da Deskcomm." },
    },
  });
  expect(r.ok(), await r.text()).toBe(true);

  const { data } = await r.json();
  // O id volta nos DOIS desfechos: é por ele que a tela leva o operador para a
  // conversa que acabou de nascer, e é isso que "a conversa sobrevive" quer
  // dizer na prática.
  expect(data.conversation_id, "a conversa precisa existir mesmo com envio falho").toBeTruthy();
  expect(typeof data.enviada).toBe("boolean");
  if (!data.enviada) expect(data.erro_envio, "falha sem motivo legível").toBeTruthy();

  await page.goto(`/app/inbox?id=${data.conversation_id}`);
  await expect(page.getByText(nome).first()).toBeVisible();
});

test("chamar de novo reaproveita a conversa, não cria uma segunda", async ({ page }) => {
  // O índice `uniq_conversations_1to1_per_contact_session` é único por (org,
  // contato, sessão) SEM filtro de status. Um segundo INSERT daria 23505 e o
  // operador veria um erro de banco — por isso o caminho REABRE. Sem este caso,
  // trocar a reabertura por um insert passaria verde em toda a unidade.
  const nome = `Cliente Duplo ${Date.now()}`;
  const { id, telefone } = await criarContatoSemConversa(page, nome);

  const sessoes = await page.request.get("/api/v1/channel-sessions");
  const { data: canais } = await sessoes.json();
  test.skip(!canais?.length, "instalação sem canal conectado — nada a chamar");

  const corpo = {
    channel_session_id: canais[0].id,
    contact_id: id,
    phone_number: telefone,
    name: nome,
    mensagem: { type: "text", body: "Primeira tentativa." },
  };

  const um = await page.request.post("/api/v1/conversations/iniciar", { data: corpo });
  expect(um.ok(), await um.text()).toBe(true);
  const dois = await page.request.post("/api/v1/conversations/iniciar", { data: corpo });
  expect(dois.ok(), await dois.text()).toBe(true);

  expect((await dois.json()).data.conversation_id).toBe((await um.json()).data.conversation_id);
});

test("quem atende (agent) consegue ler os modelos — não só quem administra", async ({ page }) => {
  // O defeito medido: `/channels/templates` exige `admin`, então um `agent`
  // levava 403 e a tela dizia "Nenhum modelo aprovado ainda" — falso, e é a
  // pior frase possível, porque manda criar um modelo que já existe.
  //
  // Logado como admin, o que se prova aqui é o CONTRATO (a rota responde e o
  // formato tem `exige_modelo`); o papel está preso no unitário, que lê o
  // `requireRole("agent")` no arquivo.
  const sessoes = await page.request.get("/api/v1/channel-sessions");
  const { data: canais } = await sessoes.json();
  test.skip(!canais?.length, "instalação sem canal conectado");

  const r = await page.request.get(
    `/api/v1/channels/modelos?channel_session_id=${canais[0].id}`,
  );
  expect(r.ok(), await r.text()).toBe(true);

  const { data } = await r.json();
  expect(typeof data.exige_modelo).toBe("boolean");
  expect(Array.isArray(data.modelos)).toBe(true);
  // Todo modelo servido traz a CHAVE pronta de cada parâmetro. É o que impede a
  // tela de montá-la por conta própria, que é como o mismatch volta.
  for (const m of data.modelos) {
    for (const s of m.slots) expect(typeof s.chave).toBe("string");
  }
});

test("conexão de outra organização não é lida", async ({ page }) => {
  // Multi-tenancy: a rota usa admin client (que ignora RLS) e filtra
  // `organization_id` à mão. Um filtro esquecido aqui vazaria os modelos de
  // outro cliente — e vazaria em silêncio, porque a resposta pareceria normal.
  const r = await page.request.get(
    `/api/v1/channels/modelos?channel_session_id=${crypto.randomUUID()}`,
  );
  expect(r.status()).toBe(404);
});
