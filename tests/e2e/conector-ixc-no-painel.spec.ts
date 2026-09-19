/**
 * O CONECTOR IXC, PELA TELA — como o admin liga e como o atendente usa.
 *
 * Jornada (docs/testing/user-journey-map.md): o provedor liga o IXC em
 * Configurações › Conectores, e a aba "IXC" passa a existir no painel da conversa
 * com o que o atendente abriria o ERP para ver.
 *
 * O "IXC" aqui é um servidor HTTP de verdade, na mesma máquina, que fala o
 * dialeto medido na instância real (2026-09-19): rota por tabela, operação no
 * header `ixcsoft`, filtros em `qtype`/`grid_param`, tudo string, **401 em HTML
 * para token errado** — e que devolve a LINHA INTEIRA, com `senha` em claro, como
 * o IXC devolve. É isso que deixa a asserção mais importante ser feita na TELA:
 * nenhuma senha chega ao navegador.
 *
 * O rig libera `127.0.0.1` em `CONECTORES_HOSTS_PRIVADOS` (scripts/gerar-env-e2e.sh);
 * em instalação normal a lista é vazia e a guarda anti-SSRF recusaria este host.
 *
 * O WAHA do rig aponta para 127.0.0.1:3999. Esta spec sobe um receiver lá para
 * PROVAR o que saiu quando o atendente clica em "Enviar" — mock não estressaria
 * a saída de verdade.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/conector-ixc";

const PORTA_DO_IXC = 39271;
const TOKEN_CERTO = "53:token-de-teste-do-rig-0271";
const SENHAS = ["senha-da-central-0271", "pppoe-0271-secreta", "wifi-da-maria-0271", "onu-0271-secreta"];

type Linha = Record<string, string>;
const HOJE = new Date();
const dia = (delta: number) => new Date(HOJE.getTime() + delta * 86_400_000).toISOString().slice(0, 10);

const TABELAS: Record<string, Linha[]> = {
  cliente: [
    { id: "10", razao: "Maria Aparecida Conector", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", whatsapp: "", telefone_comercial: "", fone: "", senha: SENHAS[0]! },
    { id: "20", razao: "José Outro Número", cnpj_cpf: "111.444.777-35", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 98888-0000", whatsapp: "", telefone_comercial: "", fone: "", senha: "x" },
    // Mesmo final, OUTRO DDD: o `L` do IXC casa, e o conector tem de descartar.
    { id: "30", razao: "Homônimo do Rio", cnpj_cpf: "390.533.447-05", tipo_pessoa: "F", ativo: "S", telefone_celular: "(21) 99304-0271", whatsapp: "", telefone_comercial: "", fone: "", senha: "x" },
    { id: "41", razao: "Ana Divide Celular", cnpj_cpf: "168.995.350-09", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0272", whatsapp: "", telefone_comercial: "", fone: "", senha: "x" },
    { id: "42", razao: "Beto Divide Celular", cnpj_cpf: "862.883.667-57", tipo_pessoa: "F", ativo: "N", telefone_celular: "", whatsapp: "(61) 9304-0272", telefone_comercial: "", fone: "", senha: "x" },
  ],
  cliente_contrato: [
    { id: "700", id_cliente: "10", contrato: "Fibra 500 Mega", status: "A", status_internet: "FA", data_ativacao: "2024-03-10", num_parcelas_atraso: "3", endereco: "Rua das Flores", numero: "120", bairro: "Centro", desbloqueio_confianca_ativo: "N" },
    { id: "701", id_cliente: "20", contrato: "Fibra 300 Mega", status: "A", status_internet: "A", data_ativacao: "2025-01-05", num_parcelas_atraso: "0", endereco: "", numero: "", bairro: "", desbloqueio_confianca_ativo: "N" },
  ],
  fn_areceber: [
    ...[-70, -40, -9].map((d, i) => ({ id: String(900 + i), id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: dia(d), valor: "129.90", valor_aberto: "129.90", linha_digitavel: `00190.00009 01234.567890 12345.678901 2 9999000001299${i}`, gateway_link: `https://download.exemplo.com.br/boleto/${900 + i}`, gerencianet_token: "tok-secreto" })),
    ...[20, 50, 80, 110, 140].map((d, i) => ({ id: String(950 + i), id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: dia(d), valor: "129.90", valor_aberto: "129.90", linha_digitavel: i === 0 ? "00190.00009 01234.567890 12345.678901 2 99990000012999" : "", gateway_link: "" })),
    { id: "990", id_cliente: "10", id_contrato: "700", status: "R", data_vencimento: dia(-100), valor: "129.90", valor_aberto: "0.00", linha_digitavel: "", gateway_link: "" },
  ],
  radusuarios: [
    { id: "5", id_cliente: "10", id_contrato: "700", login: "maria.conector", ativo: "S", online: "S", ip: "100.64.10.27", mac: "AA:BB:CC:DD:EE:FF", ultima_conexao_inicial: "2026-09-18 07:12:00", ultima_conexao_final: "2026-09-18 07:10:00", motivo_desconexao: "Lost-Carrier", senha: SENHAS[1]!, senha_rede_sem_fio: SENHAS[2]! },
  ],
  radpop_radio_cliente_fibra: [
    { id: "9", id_login: "5", id_contrato: "700", sinal_rx: "-26.10", sinal_tx: "2.31", data_sinal: "2026-09-19 06:00:00", temperatura: "48.00", distancia_onu: "1250", causa_ultima_queda: "dying-gasp", senha_onu_cliente: SENHAS[3]! },
  ],
  su_oss_chamado: [
    { id: "3001", id_cliente: "10", protocolo: "20260918000123", status: "AG", prioridade: "A", data_abertura: "2026-09-18 09:00:00", data_agenda: "2026-09-20 14:00:00", mensagem: "Cliente relata lentidão à noite. Verificar sinal da ONU." },
    { id: "3000", id_cliente: "10", protocolo: "20260801000001", status: "F", prioridade: "N", data_abertura: "2026-08-01 09:00:00", data_agenda: "", mensagem: "Instalação concluída." },
  ],
  su_ticket: [
    { id: "8001", id_cliente: "10", protocolo: "20260918000777", titulo: "Lentidão no período da noite", su_status: "EP", prioridade: "M", data_criacao: "2026-09-18 08:55:00" },
    { id: "8000", id_cliente: "10", protocolo: "20260701000001", titulo: "Troca de vencimento", su_status: "S", prioridade: "M", data_criacao: "2026-07-01 10:00:00" },
  ],
};

interface Filtro {
  campo: string;
  oper: string;
  valor: string;
}

function casa(linha: Linha, f: Filtro): boolean {
  const atual = linha[f.campo.split(".").pop() ?? ""] ?? "";
  if (f.oper === "=") return atual === f.valor;
  if (f.oper === "!=") return atual !== f.valor;
  if (f.oper === "L") return atual.includes(f.valor);
  if (f.oper === ">=") return Number(atual) >= Number(f.valor);
  return false;
}

async function corpoDe(req: IncomingMessage): Promise<string> {
  const pedacos: Buffer[] = [];
  for await (const p of req) pedacos.push(p as Buffer);
  return Buffer.concat(pedacos).toString("utf8");
}

function subirIxcFalso(): Promise<Server> {
  const servidor = createServer(async (req, res) => {
    const esperado = `Basic ${Buffer.from(TOKEN_CERTO).toString("base64")}`;
    if (req.headers.authorization !== esperado) {
      res.writeHead(401, { "content-type": "text/html" });
      res.end("<html><head><title>401 Authorization Required</title></head><body>nginx</body></html>");
      return;
    }
    const tabela = (req.url ?? "").replace("/webservice/v1/", "");
    const linhas = TABELAS[tabela];
    if (req.headers.ixcsoft !== "listar" || !linhas) {
      // O dialeto real: HTTP 200, text/html, JSON de erro.
      res.writeHead(200, { "content-type": "text/html; charset=ISO-8859-1" });
      res.end(JSON.stringify({ type: "error", message: `Recurso ${tabela} não está disponível!` }));
      return;
    }
    const pedido = JSON.parse(await corpoDe(req)) as Record<string, string>;
    const filtros: Filtro[] = [{ campo: pedido.qtype ?? "", oper: pedido.oper ?? "=", valor: pedido.query ?? "" }];
    for (const g of JSON.parse(pedido.grid_param ?? "[]") as Array<{ TB: string; OP: string; P: string }>) {
      filtros.push({ campo: g.TB, oper: g.OP, valor: g.P });
    }
    let achadas = linhas.filter((l) => filtros.every((f) => casa(l, f)));
    const ordem = (pedido.sortname ?? "").split(".").pop() ?? "id";
    achadas = achadas.sort((a, b) => (a[ordem] ?? "").localeCompare(b[ordem] ?? "", undefined, { numeric: true }));
    if (pedido.sortorder === "desc") achadas.reverse();
    res.writeHead(200, { "content-type": "text/x-json; charset=utf-8" });
    res.end(JSON.stringify({ total: String(achadas.length), registros: achadas.slice(0, Number(pedido.rp ?? "20")) }));
  });
  return new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(PORTA_DO_IXC, "127.0.0.1", () => resolve(servidor));
  });
}

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("conector IXC: o admin liga pela tela e o atendente vê contrato, bloqueio, faturas, conexão, sinal e OS — sem senha nenhuma", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const password = `Local-${randomUUID()}!`;
  const email = `conector-${randomUUID()}@invariant.test`;
  let org = "";
  let user = "";
  const enviadasAoWaha: string[] = [];

  const ixc = await subirIxcFalso();
  const wahaUrl = new URL(process.env.WAHA_API_BASE_URL ?? "http://127.0.0.1:3999");
  const waha = createServer(async (req, res) => {
    enviadasAoWaha.push(`${req.method} ${req.url} ${await corpoDe(req)}`);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `true_556193040271@c.us_${randomUUID()}` }));
  });
  await new Promise<void>((resolve, reject) => {
    waha.once("error", reject);
    waha.listen(Number(wahaUrl.port), wahaUrl.hostname, resolve);
  });

  try {
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Paula Atendente" },
    });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", {
      display_name: "Provedor local",
      legal_name: "Provedor local",
      slug: `conector-${randomUUID()}`,
      onboarded_at: new Date().toISOString(),
    });
    const membership = await db.from("user_organizations").insert({
      organization_id: org,
      user_id: user,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    if (membership.error) throw membership.error;

    const session = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: `conector-${randomUUID()}`,
      display_name: "Whats Suporte",
      phone_number: "+556130004063",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });

    async function conversaDe(nome: string, telefone: string, texto: string): Promise<{ contato: string; conversa: string }> {
      const contato = await insert("contacts", { organization_id: org, display_name: nome, phone_number: telefone });
      const conversa = await insert("conversations", {
        organization_id: org,
        contact_id: contato,
        channel_session_id: session,
        status: "open",
      });
      const sentAt = new Date().toISOString();
      await insert("messages", {
        organization_id: org,
        contact_id: contato,
        conversation_id: conversa,
        channel_session_id: session,
        direction: "inbound",
        type: "text",
        status: "received",
        sent_via: "ai",
        body: texto,
        sent_at: sentAt,
      });
      const marked = await db.rpc("fn_mark_conversation_message", {
        p_conv: conversa,
        p_direction: "inbound",
        p_preview: texto,
        p_at: sentAt,
      });
      if (marked.error) throw marked.error;
      return { contato, conversa };
    }

    const maria = await conversaDe("Maria Whats", "+5561993040271", "Minha internet caiu e quero o boleto");
    const desconhecido = await conversaDe("Número Novo", "+5561977770000", "Oi, sou o José, estou de outro celular");
    const dividido = await conversaDe("Celular da Família", "+5561993040272", "Boa tarde");

    await login(page, email, password);

    // ── 0. SEM conector ligado, o inbox não ganha aba nenhuma ──────────────────
    await page.goto("/app/inbox?filter=all");
    await page.locator(`[data-conversation-id="${maria.conversa}"]`).click();
    await expect(page.getByTestId("painel-aba-detalhes").first()).toBeVisible();
    await expect(page.getByTestId("painel-aba-conector:ixc")).toHaveCount(0);

    // ── 1. O admin liga o conector — token errado é recusado ANTES de gravar ───
    await page.goto("/app/settings/conectores");
    const ficha = page.getByTestId("conector-ixc");
    await expect(ficha).toHaveAttribute("data-estado", "desligado");
    await ficha.getByLabel("Endereço do sistema").fill(`http://127.0.0.1:${PORTA_DO_IXC}`);
    await ficha.getByLabel("Token de acesso").fill("53:token-errado-de-proposito");
    await ficha.getByRole("button", { name: "Testar e salvar" }).click();
    await expect(page.getByText("O sistema recusou o token.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(ficha).toHaveAttribute("data-estado", "desligado");
    await page.screenshot({ path: `${evidence}/01-token-errado-recusado.png` });

    await ficha.getByLabel("Token de acesso").fill(TOKEN_CERTO);
    await ficha.getByRole("button", { name: "Testar e salvar" }).click();
    await expect(ficha).toHaveAttribute("data-estado", "ligado", { timeout: 30_000 });
    // O token NUNCA volta: só os 4 últimos caracteres.
    await expect(ficha).toContainText(`••••${TOKEN_CERTO.slice(-4)}`);
    expect(await page.locator("body").innerText()).not.toContain(TOKEN_CERTO);
    await page.screenshot({ path: `${evidence}/02-conector-ligado.png` });

    // No banco: cifrado, e só os 4 finais em claro.
    const { data: gravada } = await db.from("conector_conexoes").select("token_last4, token_encrypted, status").eq("organization_id", org).single();
    expect(gravada?.token_last4).toBe(TOKEN_CERTO.slice(-4));
    expect(String(gravada?.token_encrypted)).not.toContain(Buffer.from(TOKEN_CERTO).toString("hex"));

    // ── 2. O atendente abre a conversa: a aba existe e o telefone identifica ───
    await page.goto("/app/inbox?filter=all");
    await page.locator(`[data-conversation-id="${maria.conversa}"]`).click();
    const aba = page.getByTestId("painel-aba-conector:ixc").first();
    await expect(aba).toBeVisible({ timeout: 20_000 });
    await aba.click();

    const painel = page.getByTestId("painel-ixc").first();
    await expect(painel).toHaveAttribute("data-estado", "vinculado", { timeout: 40_000 });
    await expect(painel.getByTestId("ixc-cliente")).toContainText("Maria Aparecida Conector");
    await expect(painel.getByTestId("ixc-cliente")).toContainText("529.982.247-25");
    await expect(painel.getByTestId("ixc-situacao")).toHaveText("Bloqueado");
    await expect(painel.getByTestId("ixc-motivo-do-bloqueio")).toContainText("financeiro em atraso");
    // Medido: o selo cabe numa linha só (antes, "Bloqueado — financeiro em atraso" quebrava em duas).
    expect((await painel.getByTestId("ixc-situacao").boundingBox())?.height ?? 99).toBeLessThanOrEqual(24);
    await expect(painel.getByTestId("ixc-contrato")).toContainText("Fibra 500 Mega");
    await expect(painel.getByTestId("ixc-contrato")).toContainText("Rua das Flores, 120 — Centro");

    // A regra do dono: TODAS as vencidas + a próxima + mais uma; o resto é contagem.
    await expect(painel.getByTestId("ixc-fatura-vencida")).toHaveCount(3);
    await expect(painel.getByTestId("ixc-fatura-a-vencer")).toHaveCount(2);
    await expect(painel.getByTestId("ixc-outras-a-vencer")).toContainText("3");
    await expect(painel.getByTestId("ixc-total-vencido")).toContainText("389,70");

    await expect(painel.getByTestId("ixc-conexao")).toContainText("Online");
    await expect(painel.getByTestId("ixc-conexao")).toContainText("100.64.10.27");
    await expect(painel.getByTestId("ixc-sinal")).toContainText("No limite");
    await expect(painel.getByTestId("ixc-sinal")).toContainText("-26.10 dBm");
    await expect(painel.getByTestId("ixc-os-item")).toHaveCount(1);
    await expect(painel.getByTestId("ixc-os-item")).toContainText("Agendada");
    await expect(painel.getByTestId("ixc-atendimento-item")).toHaveCount(1);
    await expect(painel.getByTestId("ixc-atendimento-item")).toContainText("Lentidão no período da noite");

    // A ASSERÇÃO QUE IMPORTA: o IXC devolveu quatro senhas; nenhuma está na tela
    // nem no HTML.
    const html = await page.content();
    for (const segredo of [...SENHAS, "tok-secreto"]) expect(html, `a tela recebeu "${segredo}"`).not.toContain(segredo);

    // Medida, não olho: numa coluna de 264–320px nada pode estourar para o lado.
    const estouro = await painel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(estouro, "o painel do IXC rola para o lado").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/03-painel-vinculado.png` });
    await painel.getByTestId("ixc-conexoes").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/04-painel-conexao-e-os.png` });

    // O vínculo foi gravado pelo TELEFONE, e o homônimo de outro DDD ficou de fora.
    const { data: vinculos } = await db.from("contato_vinculos_externos").select("external_id, verificado_por").eq("contact_id", maria.contato);
    expect(vinculos).toEqual([{ external_id: "10", verificado_por: "telefone" }]);

    // ── 3. Enviar fatura: dois toques, e o que SAI é composto no servidor ──────
    await painel.getByTestId("ixc-financeiro").scrollIntoViewIfNeeded();
    const enviar = painel.getByTestId("ixc-fatura-vencida").first().getByTestId("ixc-enviar-fatura");
    await enviar.click();
    await expect(enviar).toContainText("Confirmar envio");
    expect(await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", maria.conversa).eq("direction", "outbound").then((r) => r.count)).toBe(0);
    await enviar.click();
    await expect(page.getByText("Fatura enviada na conversa.")).toBeVisible({ timeout: 40_000 });

    const { data: saidas } = await db
      .from("messages")
      .select("body")
      .eq("conversation_id", maria.conversa)
      .eq("direction", "outbound")
      .order("created_at", { ascending: true });
    expect(saidas?.length).toBe(2);
    expect(saidas?.[0]?.body).toContain("R$ 129,90");
    expect(saidas?.[0]?.body).toContain("https://download.exemplo.com.br/boleto/900");
    expect(saidas?.[1]?.body).toBe("00190.00009 01234.567890 12345.678901 2 99990000012990");
    await expect(page.getByTestId("chat-thread")).toContainText("Segue a sua fatura");
    await page.screenshot({ path: `${evidence}/05-fatura-enviada.png` });

    // ── 4. Telefone que não está no IXC → CPF ─────────────────────────────────
    await page.locator(`[data-conversation-id="${desconhecido.conversa}"]`).click();
    await expect(painel).toHaveAttribute("data-estado", "nao_encontrado", { timeout: 40_000 });
    await painel.getByLabel("Buscar pelo CPF ou CNPJ do cliente").fill("111.444.777-35");
    await page.screenshot({ path: `${evidence}/06-nao-encontrado-busca-cpf.png` });
    await painel.getByRole("button", { name: "Buscar" }).click();
    await expect(painel).toHaveAttribute("data-estado", "vinculado", { timeout: 40_000 });
    await expect(painel.getByTestId("ixc-cliente")).toContainText("José Outro Número");
    await expect(painel.getByTestId("ixc-situacao")).toContainText("Liberado");
    await expect(painel.getByTestId("ixc-em-dia")).toBeVisible();

    // ── 5. Celular de DOIS cadastros → ninguém escolhe sozinho ────────────────
    await page.locator(`[data-conversation-id="${dividido.conversa}"]`).click();
    await expect(painel).toHaveAttribute("data-estado", "escolher", { timeout: 40_000 });
    await expect(painel.getByTestId("ixc-candidato")).toHaveCount(2);
    // Documento PARCIAL: o candidato ainda não é o cliente da conversa.
    await expect(painel).not.toContainText("168.995.350-09");
    await expect(painel).toContainText("***.995.350-**");
    await page.screenshot({ path: `${evidence}/07-escolher-entre-dois.png` });
    await painel.getByTestId("ixc-candidato").filter({ hasText: "Ana Divide Celular" }).getByRole("button", { name: "É este" }).click();
    await expect(painel).toHaveAttribute("data-estado", "vinculado", { timeout: 40_000 });
    await expect(painel.getByTestId("ixc-cliente")).toContainText("Ana Divide Celular");

    // ── 6. O ERP recusa o token no meio do dia: o atendente vê, e o ADMIN também ─
    await new Promise<void>((r) => ixc.close(() => r()));
    await page.locator(`[data-conversation-id="${maria.conversa}"]`).click();
    await painel.getByTestId("ixc-atualizar").click();
    await expect(painel).toHaveAttribute("data-estado", "erro", { timeout: 40_000 });
    await page.screenshot({ path: `${evidence}/08-erp-fora-do-ar.png` });
    await page.goto("/app/settings/conectores");
    await expect(page.getByTestId("conector-ixc")).toHaveAttribute("data-estado", "erro", { timeout: 20_000 });
    await expect(page.getByTestId("conector-erro")).toBeVisible();
    await page.screenshot({ path: `${evidence}/09-admin-ve-o-erro.png` });

    // A auditoria registrou conexão, vínculos e fatura — sem linha digitável.
    await expect
      .poll(async () => {
        const { data } = await db.from("api_audit_log").select("action, metadata").eq("organization_id", org).like("action", "conector.%");
        return (data ?? []).map((l) => l.action).sort();
      }, { timeout: 20_000 })
      .toEqual(expect.arrayContaining(["conector.conexao_salva", "conector.fatura_enviada", "conector.vinculo_criado"]));
    const { data: trilha } = await db.from("api_audit_log").select("metadata").eq("organization_id", org).eq("action", "conector.fatura_enviada");
    expect(JSON.stringify(trilha)).not.toContain("00190.00009");
  } finally {
    await new Promise<void>((r) => (ixc.listening ? ixc.close(() => r()) : r()));
    await new Promise<void>((r) => waha.close(() => r()));
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
