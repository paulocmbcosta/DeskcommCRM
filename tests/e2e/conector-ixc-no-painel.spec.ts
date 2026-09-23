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
 * PROVAR o que saiu quando o atendente escolhe Boleto ou Pix — mock não
 * estressaria a saída de verdade. O boleto é o PDF que o IXC devolve em
 * `get_boleto`; o Pix é o copia-e-cola de `get_pix`, com o QR code gerado aqui.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { bufToBytea, encryptKey } from "../../lib/crypto/aes_gcm";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/conector-ixc";

const TOKEN_CERTO = "53:token-de-teste-do-rig-0271";
const SENHAS = ["senha-da-central-0271", "pppoe-0271-secreta", "wifi-da-maria-0271", "onu-0271-secreta"];

/** Um PDF mínimo, mas PDF: é o que `get_boleto` devolve (em base64, como texto puro). */
const PDF_DO_BOLETO = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1",
);
/** O BR Code do manual do Banco Central — CRC 1D3D. É o "copia e cola" que `get_pix` devolve. */
const COPIA_E_COLA =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";
const DEVEDOR_QUE_NAO_SAI = "Devedor Que Nao Sai 0271";
const RECUSA_DO_IXC = "Fatura sem cobrança registrada na carteira 0271";

type Linha = Record<string, string>;
const HOJE = new Date();
const dia = (delta: number) => new Date(HOJE.getTime() + delta * 86_400_000).toISOString().slice(0, 10);

const TABELAS: Record<string, Linha[]> = {
  cliente: [
    { id: "10", razao: "Maria Aparecida Conector", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", whatsapp: "", telefone_comercial: "", fone: "", senha: SENHAS[0]!, data_nascimento: "1985-03-12" },
    { id: "20", razao: "José Outro Número", cnpj_cpf: "111.444.777-35", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 98888-0000", whatsapp: "", telefone_comercial: "", fone: "", senha: "x", data_nascimento: "0000-00-00" },
    // Mesmo final, OUTRO DDD: o `L` do IXC casa, e o conector tem de descartar.
    { id: "30", razao: "Homônimo do Rio", cnpj_cpf: "390.533.447-05", tipo_pessoa: "F", ativo: "S", telefone_celular: "(21) 99304-0271", whatsapp: "", telefone_comercial: "", fone: "", senha: "x", data_nascimento: "0000-00-00" },
    { id: "41", razao: "Ana Divide Celular", cnpj_cpf: "168.995.350-09", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0272", whatsapp: "", telefone_comercial: "", fone: "", senha: "x", data_nascimento: "0000-00-00" },
    { id: "42", razao: "Beto Divide Celular", cnpj_cpf: "862.883.667-57", tipo_pessoa: "F", ativo: "N", telefone_celular: "", whatsapp: "(61) 9304-0272", telefone_comercial: "", fone: "", senha: "x", data_nascimento: "0000-00-00" },
    // Os dois de baixo são só do turno da IA (segundo teste): novos de propósito
    // para não interferir na Maria/José/Ana/Beto do primeiro teste.
    { id: "60", razao: "Bruna Paga Em Dia", cnpj_cpf: "153.509.460-56", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0600", whatsapp: "", telefone_comercial: "", fone: "", data_nascimento: "1990-05-20", senha: "x" },
    { id: "70", razao: "Caio Muito Atrasado", cnpj_cpf: "746.971.314-01", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0700", whatsapp: "", telefone_comercial: "", fone: "", data_nascimento: "1975-11-02", senha: "x" },
  ],
  cliente_contrato: [
    { id: "700", id_cliente: "10", contrato: "Fibra 500 Mega", status: "A", status_internet: "FA", data_ativacao: "2024-03-10", num_parcelas_atraso: "3", endereco: "Rua das Flores", numero: "120", bairro: "Centro", desbloqueio_confianca_ativo: "N" },
    { id: "701", id_cliente: "20", contrato: "Fibra 300 Mega", status: "A", status_internet: "A", data_ativacao: "2025-01-05", num_parcelas_atraso: "0", endereco: "", numero: "", bairro: "", desbloqueio_confianca_ativo: "N" },
    { id: "760", id_cliente: "60", contrato: "Fibra 300 Mega", status: "A", status_internet: "A", data_ativacao: "2025-02-01", num_parcelas_atraso: "0", endereco: "", numero: "", bairro: "", desbloqueio_confianca_ativo: "N" },
    { id: "770", id_cliente: "70", contrato: "Fibra 300 Mega", status: "A", status_internet: "FA", data_ativacao: "2025-02-01", num_parcelas_atraso: "0", endereco: "", numero: "", bairro: "", desbloqueio_confianca_ativo: "N" },
  ],
  fn_areceber: [
    // As vencidas têm boleto E Pix registrados — menos a terceira, que só tem boleto:
    // é o caso MEDIDO EM PRODUÇÃO (2026-09-22), em que o IXC ainda não gerou o Pix e
    // o gera quando `get_pix` é chamado. `gateway_link` continua vindo do IXC, como
    // na instância real: o conector é que não o pede mais.
    ...[-70, -40, -9].map((d, i) => ({ id: String(900 + i), id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: dia(d), valor: "129.90", valor_aberto: "129.90", linha_digitavel: `00190.00009 01234.567890 12345.678901 2 9999000001299${i}`, pix_txid: i === 2 ? "" : `txid0271${i}`, gateway_link: `https://download.exemplo.com.br/boleto/${900 + i}`, gerencianet_token: "tok-secreto" })),
    ...[20, 50, 80, 110, 140].map((d, i) => ({ id: String(950 + i), id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: dia(d), valor: "129.90", valor_aberto: "129.90", linha_digitavel: i === 0 ? "00190.00009 01234.567890 12345.678901 2 99990000012999" : "", pix_txid: i === 0 ? "txid0271a" : "", gateway_link: "" })),
    { id: "990", id_cliente: "10", id_contrato: "700", status: "R", data_vencimento: dia(-100), valor: "129.90", valor_aberto: "0.00", linha_digitavel: "", pix_txid: "", gateway_link: "" },
    // A Bruna (60): uma vencida há 12 dias — dentro do limite de 70 —, sem Pix
    // gerado ainda (o fake gera sob demanda) e com boleto registrado; e uma a
    // vencer, que a fatura da vez nunca deveria escolher.
    { id: "960", id_cliente: "60", id_contrato: "760", status: "A", data_vencimento: dia(-12), valor: "129.90", valor_aberto: "129.90", linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012996", pix_txid: "", gateway_link: "" },
    { id: "961", id_cliente: "60", id_contrato: "760", status: "A", data_vencimento: dia(18), valor: "129.90", valor_aberto: "129.90", linha_digitavel: "", pix_txid: "", gateway_link: "" },
    // O Caio (70): vencida há 75 dias — ACIMA do limite de 70 que a tela vai
    // gravar — então a IA nunca deveria sequer pedir boleto/Pix desta fatura.
    { id: "970", id_cliente: "70", id_contrato: "770", status: "A", data_vencimento: dia(-75), valor: "129.90", valor_aberto: "129.90", linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012997", pix_txid: "", gateway_link: "" },
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

/** O que o conector PEDIU às ações de cobrança — para provar que ele não pede o que não foi escolhido. */
const acoesPedidas: string[] = [];

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

/**
 * Porta EFÊMERA (`listen(0)`), nunca fixa: os dois testes deste arquivo sobem o
 * próprio IXC falso, e uma porta fixa colide quando os dois workers do
 * Playwright rodam sequencialmente no MESMO processo — medido: o segundo
 * `listen` ainda encontrava a porta do primeiro ocupada (`EADDRINUSE`), porque
 * `close()` não espera conexão keep-alive nenhuma se ninguém pedir
 * (`fecharServidor`, abaixo, cobre isso). Quem lê a porta é o PRÓPRIO teste, na
 * hora de preencher "Endereço do sistema" — nada externo depende do número.
 */
function subirIxcFalso(): Promise<{ servidor: Server; porta: number }> {
  const servidor = createServer(async (req, res) => {
    const esperado = `Basic ${Buffer.from(TOKEN_CERTO).toString("base64")}`;
    if (req.headers.authorization !== esperado) {
      res.writeHead(401, { "content-type": "text/html" });
      res.end("<html><head><title>401 Authorization Required</title></head><body>nginx</body></html>");
      return;
    }
    const tabela = (req.url ?? "").replace("/webservice/v1/", "");

    // As duas AÇÕES de cobrança, no dialeto medido em 2026-09-21: `get_boleto`
    // devolve o PDF em base64 como TEXTO PURO (corpo vazio se a fatura não
    // existe); `get_pix` devolve JSON — com o CPF e o nome do devedor junto, que o
    // conector tem de descartar — e HTTP 500 se a fatura não tem Pix.
    if (tabela === "get_boleto" || tabela === "get_pix") {
      const pedidoDaAcao = JSON.parse(await corpoDe(req)) as Record<string, string>;
      const id = tabela === "get_boleto" ? pedidoDaAcao.boletos : pedidoDaAcao.id_areceber;
      const fatura = TABELAS.fn_areceber!.find((f) => f.id === id);
      acoesPedidas.push(`${tabela}:${id}`);
      if (tabela === "get_boleto") {
        res.writeHead(200, { "content-type": "text/html; charset=ISO-8859-1" });
        res.end(fatura?.linha_digitavel ? PDF_DO_BOLETO.toString("base64") : "");
        return;
      }
      if (!fatura) {
        res.writeHead(500, { "content-type": "text/html" });
        res.end("");
        return;
      }
      // Parcela SEM boleto registrado: aqui o IXC recusa, e diz por quê — a frase
      // dele tem de chegar ao atendente.
      if (!fatura.linha_digitavel) {
        res.writeHead(200, { "content-type": "text/x-json; charset=utf-8" });
        res.end(JSON.stringify({ type: "error", message: RECUSA_DO_IXC }));
        return;
      }
      // O Pix é gerado SOB DEMANDA: a fatura que não tinha `pix_txid` passa a ter.
      if (!fatura.pix_txid) fatura.pix_txid = `gerado-agora-${id}`;
      res.writeHead(200, { "content-type": "text/x-json; charset=utf-8" });
      res.end(
        JSON.stringify({
          type: "success",
          gateway: "gerencianet",
          pix: {
            dadosPix: { status: "ATIVA", txid: fatura.pix_txid, devedor: { cpf: "52998224725", nome: DEVEDOR_QUE_NAO_SAI }, valor: { original: fatura.valor_aberto }, pixCopiaECola: COPIA_E_COLA },
            qrCode: { qrcode: COPIA_E_COLA, imagemQrcode: "iVBORw0KGgo-imagem-do-ixc-que-nao-usamos", imagemSrc: "https://pix.exemplo/qr.png" },
          },
        }),
      );
      return;
    }

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
    servidor.listen(0, "127.0.0.1", () => resolve({ servidor, porta: (servidor.address() as AddressInfo).port }));
  });
}

/**
 * O WAHA falso do rig — um servidor HTTP na porta que `WAHA_API_BASE_URL`
 * aponta, que só REGISTRA o que chegou (`enviadas`). Extraído para os dois
 * testes deste arquivo: o segundo precisa do MESMO receiver para provar o que
 * a IA — e não o botão — mandou pelo canal.
 *
 * Esta porta é FIXA por env (`WAHA_API_BASE_URL`, injetado no `webServer` do
 * Playwright) — o servidor de produção (`WahaChannelAdapter`) lê o endereço do
 * ambiente, não da tela, então não pode ser efêmera como a do IXC. Os dois
 * testes deste arquivo rodam em SÉRIE (`fullyParallel: false`, 1 worker) e cada
 * um fecha o seu (`fecharServidor`) antes do próximo subir o dele.
 */
function subirWahaFalso(enviadas: string[]): Promise<Server> {
  const wahaUrl = new URL(process.env.WAHA_API_BASE_URL ?? "http://127.0.0.1:3999");
  const servidor = createServer(async (req, res) => {
    enviadas.push(`${req.method} ${req.url} ${await corpoDe(req)}`);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `true_556193040271@c.us_${randomUUID()}` }));
  });
  return new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(Number(wahaUrl.port), wahaUrl.hostname, () => resolve(servidor));
  });
}

/**
 * Fecha de verdade — `close()` sozinho espera qualquer conexão keep-alive
 * ainda aberta, e o cliente HTTP do conector (`undici`/fetch) mantém a dele
 * viva por padrão. Sem `closeAllConnections()`, o `close()` do teste anterior
 * podia não terminar antes de o próximo `listen()` tentar a mesma porta —
 * medido como `EADDRINUSE` entre os dois testes deste arquivo, mesmo os dois
 * rodando em série.
 */
async function fecharServidor(servidor: Server | undefined): Promise<void> {
  if (!servidor?.listening) return;
  servidor.closeAllConnections?.();
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
}

/**
 * Roda `scripts/e2e-turno-da-ia-cobranca.ts` num processo filho — ASSÍNCRONO,
 * nunca `execFileSync`.
 *
 * O IXC e o WAHA falsos deste arquivo (`subirIxcFalso`, `subirWahaFalso`) são
 * servidores HTTP hospedados NO PRÓPRIO processo do Playwright. `execFileSync`
 * bloqueia o event loop desse processo até o filho terminar — e o filho (o
 * turno) fica esperando resposta desses MESMOS servidores, que só rodam
 * quando o event loop do pai está livre. Era um impasse (deadlock) por
 * construção: medido, o `fetch` do conector IXC morria com "sem_resposta"
 * bem no instante do teto de 12s (`AbortSignal.timeout`) do cliente HTTP do
 * IXC — o pedido nunca chegava a ser atendido, não porque o IXC falso não
 * respondesse, mas porque o processo que o hospeda estava congelado.
 */
function rodarTurnoDaIA(org: string, conversa: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const filho = spawn("npx", ["tsx", "scripts/e2e-turno-da-ia-cobranca.ts", org, conversa], { stdio: "inherit" });
    filho.once("error", reject);
    filho.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`e2e-turno-da-ia-cobranca.ts saiu com código ${code}`))));
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

  // Dentro do try: um `subir*Falso` que falhe (porta do WAHA ocupada, por
  // exemplo) não pode deixar o OUTRO servidor, já de pé, sem fechar.
  let ixc: Server | undefined;
  let portaDoIxc = 0;
  let waha: Server | undefined;

  try {
    ({ servidor: ixc, porta: portaDoIxc } = await subirIxcFalso());
    waha = await subirWahaFalso(enviadasAoWaha);

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
    await ficha.getByLabel("Endereço do sistema").fill(`http://127.0.0.1:${portaDoIxc}`);
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

    // ── Chat do site: o telefone foi DIGITADO — o painel não vincula sozinho ──
    const sessaoDoSite = await insert("channel_sessions", {
      organization_id: org,
      provider: "site_widget",
      site_widget_key: `wc_${randomUUID()}`,
      display_name: "Chat do site",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    // O NÚMERO É O DO JOSÉ NO IXC ("(61) 98888-0000"), não o da Maria: a Maria já
    // é dona de "+5561993040271" NESTA org (`uniq_contacts_org_phone`), e um
    // visitante do site é SEMPRE contato novo (`lib/channels/chat-do-site/entrada.ts`)
    // — dois contatos locais não podem dividir telefone. O que importa aqui é achar
    // EXATAMENTE 1 candidato no IXC por telefone (como o José) com um canal que não
    // confia no número — é o motivo `telefone_digitado`, o conserto de 22/09.
    const visitante = await insert("contacts", { organization_id: org, display_name: "Visitante do site", phone_number: "+5561988880000" });
    const conversaDoSite = await insert("conversations", { organization_id: org, contact_id: visitante, channel_session_id: sessaoDoSite, status: "open", channel: "site_chat" });
    // Deep-link direto (padrão de `tests/e2e/chat-do-site.spec.ts`) — não depende
    // da lista do Inbox já ter recebido a conversa recém-inserida por fora da tela.
    await page.goto(`/app/inbox/${conversaDoSite}`);
    await page.getByTestId("painel-aba-conector:ixc").click();
    await expect(page.getByTestId("painel-ixc")).toHaveAttribute("data-estado", "escolher", { timeout: 30_000 });
    await page.screenshot({ path: `${evidence}/site-nao-vincula-pelo-telefone-digitado.png` });
    const { data: doVisitante } = await db.from("contato_vinculos_externos").select("external_id").eq("contact_id", visitante);
    expect(doVisitante).toEqual([]);

    // De volta para a Maria (deep-link — o filtro padrão da lista pode não
    // incluí-la) — o resto do teste continua nela.
    await page.goto(`/app/inbox/${maria.conversa}`);
    await page.getByTestId("painel-aba-conector:ixc").click();
    await expect(painel).toHaveAttribute("data-estado", "vinculado", { timeout: 40_000 });

    // ── 3. Enviar a cobrança: escolher a FORMA é o segundo toque ───────────────
    await painel.getByTestId("ixc-financeiro").scrollIntoViewIfNeeded();
    const vencidas = painel.getByTestId("ixc-fatura-vencida");
    const saidas = async () =>
      (
        await db
          .from("messages")
          .select("type, body, media_storage_path, media_mime")
          .eq("conversation_id", maria.conversa)
          .eq("direction", "outbound")
          .order("created_at", { ascending: true })
      ).data ?? [];

    // 3a. BOLETO — o PDF baixado do IXC, como documento; a linha digitável sozinha.
    await vencidas.nth(0).getByTestId("ixc-enviar-fatura").click();
    const escolha = vencidas.nth(0).getByTestId("ixc-escolher-forma");
    await expect(escolha).toBeVisible();
    await expect(escolha.getByTestId("ixc-enviar-boleto")).toBeEnabled();
    await expect(escolha.getByTestId("ixc-enviar-pix")).toBeEnabled();
    // O primeiro toque só ABRE a escolha: nada saiu, e nada foi pedido ao IXC.
    expect(await saidas()).toHaveLength(0);
    expect(acoesPedidas).toEqual([]);
    // Medido: a escolha cabe na coluna, sem empurrar nada para o lado.
    expect(await painel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${evidence}/05-escolher-boleto-ou-pix.png` });

    await escolha.getByTestId("ixc-enviar-boleto").click();
    await expect(page.getByText("Boleto enviado na conversa.")).toBeVisible({ timeout: 60_000 });

    let mensagens = await saidas();
    expect(mensagens).toHaveLength(2);
    expect(mensagens[0]).toMatchObject({ type: "document", media_mime: "application/pdf" });
    // O último segmento é o nome que o cliente vê no WhatsApp: limpo, sem sufixo aleatório.
    expect(mensagens[0]?.media_storage_path).toMatch(new RegExp(`^${org}/${maria.conversa}/cobranca-[0-9a-f]{8}/boleto-\\d{2}-\\d{2}-\\d{4}\\.pdf$`));
    expect(mensagens[0]?.body).toContain("R$ 129,90");
    // O link do boleto no site do banco NÃO sai mais — nem link nenhum.
    expect(JSON.stringify(mensagens)).not.toMatch(/https?:\/\//);
    expect(mensagens[1]).toMatchObject({ type: "text", body: "00190.00009 01234.567890 12345.678901 2 99990000012990" });
    // O que ficou guardado É o PDF que o IXC devolveu, byte a byte.
    const pdfGuardado = await db.storage.from("whatsapp-media").download(String(mensagens[0]?.media_storage_path));
    expect(pdfGuardado.error).toBeNull();
    expect(Buffer.from(await pdfGuardado.data!.arrayBuffer()).equals(PDF_DO_BOLETO)).toBe(true);
    // Escolheu boleto: o conector pediu o boleto, e NÃO o Pix.
    expect(acoesPedidas).toEqual(["get_boleto:900"]);
    await expect(page.getByTestId("chat-thread")).toContainText("Segue o boleto da sua fatura");
    await page.screenshot({ path: `${evidence}/06-boleto-em-pdf-enviado.png` });

    // 3b. PIX — o QR code como imagem; o copia-e-cola sozinho.
    await vencidas.nth(1).getByTestId("ixc-enviar-fatura").click();
    await vencidas.nth(1).getByTestId("ixc-enviar-pix").click();
    await expect(page.getByText("Pix enviado na conversa.")).toBeVisible({ timeout: 60_000 });

    mensagens = await saidas();
    expect(mensagens).toHaveLength(4);
    expect(mensagens[2]).toMatchObject({ type: "image", media_mime: "image/png" });
    expect(mensagens[2]?.media_storage_path).toMatch(/\/cobranca-[0-9a-f]{8}\/pix-\d{2}-\d{2}-\d{4}\.png$/);
    expect(mensagens[3]).toMatchObject({ type: "text", body: COPIA_E_COLA });
    const qrGuardado = await db.storage.from("whatsapp-media").download(String(mensagens[2]?.media_storage_path));
    const qrPng = Buffer.from(await qrGuardado.data!.arrayBuffer());
    expect(qrPng.subarray(1, 4).toString("latin1")).toBe("PNG");
    // O QR code que foi para o cliente, como arquivo — para quem valida apontar a câmera.
    writeFileSync(`${evidence}/07b-qr-code-que-foi-para-o-cliente.png`, qrPng);
    expect(acoesPedidas).toEqual(["get_boleto:900", "get_pix:901"]);
    await expect(page.getByTestId("chat-thread")).toContainText("Segue o Pix da sua fatura");
    // A evidência é o QR NA TELA, não a bolha ainda carregando.
    const imagemDoQr = page.getByTestId("chat-thread").locator("img").last();
    await expect(imagemDoQr).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => imagemDoQr.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await imagemDoQr.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/07-pix-com-qr-code-enviado.png` });

    // 3c. O CASO DE PRODUÇÃO: boleto registrado e Pix AINDA NÃO gerado. O botão de
    // Pix está LIGADO, avisa que o Pix será gerado, e o envio sai inteiro.
    await vencidas.nth(2).getByTestId("ixc-enviar-fatura").click();
    const pixSobDemanda = vencidas.nth(2).getByTestId("ixc-enviar-pix");
    await expect(pixSobDemanda).toBeEnabled();
    await expect(pixSobDemanda).toHaveAttribute("title", "O IXC vai gerar o Pix desta fatura agora.");
    await page.screenshot({ path: `${evidence}/07c-pix-ainda-nao-gerado-botao-ligado.png` });
    await pixSobDemanda.click();
    // Pelo BANCO, e não pelo aviso: o "Pix enviado" do envio anterior ainda pode
    // estar na tela, e esperar por ele deixaria a conferência correr antes do envio.
    await expect.poll(async () => (await saidas()).length, { timeout: 60_000 }).toBe(6);
    mensagens = await saidas();
    expect(mensagens[4]).toMatchObject({ type: "image", media_mime: "image/png" });
    expect(mensagens[5]).toMatchObject({ type: "text", body: COPIA_E_COLA });
    expect(acoesPedidas).toEqual(["get_boleto:900", "get_pix:901", "get_pix:902"]);

    // 3d. Parcela futura SEM boleto registrado: Enviar aparece, o Boleto fica
    // desligado, e o Pix é tentado — o IXC recusa, e a FRASE DELE chega ao atendente.
    const semBoleto = painel.getByTestId("ixc-fatura-a-vencer").nth(1);
    await expect(semBoleto).toContainText("boleto ainda não gerado");
    await semBoleto.getByTestId("ixc-enviar-fatura").click();
    await expect(semBoleto.getByTestId("ixc-enviar-boleto")).toBeDisabled();
    await semBoleto.getByTestId("ixc-enviar-pix").click();
    await expect(page.getByText(RECUSA_DO_IXC, { exact: false })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${evidence}/07d-o-ixc-recusou-e-disse-por-que.png` });
    expect(await saidas()).toHaveLength(6);

    // O canal recebeu os dois ARQUIVOS (receiver real na porta do WAHA), e o
    // nome/CPF do devedor que `get_pix` devolve não chegou a lugar nenhum.
    expect(enviadasAoWaha.filter((r) => /sendFile|sendImage/i.test(r)).length).toBeGreaterThanOrEqual(3);
    expect(await page.content()).not.toContain(DEVEDOR_QUE_NAO_SAI);

    // ── 4. Telefone que não está no IXC → CPF ─────────────────────────────────
    await page.locator(`[data-conversation-id="${desconhecido.conversa}"]`).click();
    await expect(painel).toHaveAttribute("data-estado", "nao_encontrado", { timeout: 40_000 });
    await painel.getByLabel("Buscar pelo CPF ou CNPJ do cliente").fill("111.444.777-35");
    await page.screenshot({ path: `${evidence}/08-nao-encontrado-busca-cpf.png` });
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
    await page.screenshot({ path: `${evidence}/09-escolher-entre-dois.png` });
    await painel.getByTestId("ixc-candidato").filter({ hasText: "Ana Divide Celular" }).getByRole("button", { name: "É este" }).click();
    await expect(painel).toHaveAttribute("data-estado", "vinculado", { timeout: 40_000 });
    await expect(painel.getByTestId("ixc-cliente")).toContainText("Ana Divide Celular");

    // ── 6. O ERP recusa o token no meio do dia: o atendente vê, e o ADMIN também ─
    await fecharServidor(ixc);
    await page.locator(`[data-conversation-id="${maria.conversa}"]`).click();
    await painel.getByTestId("ixc-atualizar").click();
    await expect(painel).toHaveAttribute("data-estado", "erro", { timeout: 40_000 });
    await page.screenshot({ path: `${evidence}/10-erp-fora-do-ar.png` });
    await page.goto("/app/settings/conectores");
    await expect(page.getByTestId("conector-ixc")).toHaveAttribute("data-estado", "erro", { timeout: 20_000 });
    await expect(page.getByTestId("conector-erro")).toBeVisible();
    await page.screenshot({ path: `${evidence}/11-admin-ve-o-erro.png` });

    // A auditoria registrou conexão, vínculos e fatura — sem linha digitável.
    await expect
      .poll(async () => {
        const { data } = await db.from("api_audit_log").select("action, metadata").eq("organization_id", org).like("action", "conector.%");
        return (data ?? []).map((l) => l.action).sort();
      }, { timeout: 20_000 })
      .toEqual(expect.arrayContaining(["conector.conexao_salva", "conector.fatura_enviada", "conector.vinculo_criado"]));
    const { data: trilha } = await db.from("api_audit_log").select("metadata").eq("organization_id", org).eq("action", "conector.fatura_enviada");
    expect(trilha).toHaveLength(3);
    expect(JSON.stringify(trilha)).not.toContain("00190.00009");
    expect(JSON.stringify(trilha)).not.toContain("br.gov.bcb.pix");
    expect((trilha ?? []).map((l) => (l.metadata as { forma?: string }).forma).sort()).toEqual(["boleto", "pix", "pix"]);
    // Só UM dos dois Pix foi gerado por causa do pedido — e a trilha sabe qual.
    expect((trilha ?? []).filter((l) => (l.metadata as { pix_gerado_agora?: boolean }).pix_gerado_agora === true)).toHaveLength(1);
  } finally {
    await fecharServidor(ixc);
    await fecharServidor(waha);
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});

/**
 * A IA IDENTIFICA O CLIENTE NO IXC E ENVIA A COBRANÇA — pela tela, motor real.
 *
 * Fase 4 do conector (docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md):
 * duas ferramentas nativas do motor (`crm_consultar_cliente_erp`,
 * `crm_enviar_cobranca_erp`), o limite de dias configurável na tela, e a IA
 * mandando Pix/boleto pela MESMA cadeia de envio (before-send → ledger →
 * `sendMessageHandler` → WAHA) que o botão do atendente usa no teste acima.
 *
 * O turno roda com `scripts/e2e-turno-da-ia-cobranca.ts`: o motor inteiro é
 * real (ferramentas, gates, Storage, canal); só o MODELO é um roteiro —
 * consulta o cliente, pede a cobrança se identificado, escreve uma frase
 * conforme a resposta da ferramenta. Não é curl nem mock do produto: é o
 * motor de produção lendo o IXC falso e escrevendo no WAHA falso, os dois
 * deste arquivo.
 */
test("a IA identifica o cliente e envia a cobrança — pela tela, com o IXC falso", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(`${evidence}/ia`, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const password = `Local-${randomUUID()}!`;
  const email = `conector-ia-${randomUUID()}@invariant.test`;
  let org = "";
  let user = "";
  const enviadasAoWaha: string[] = [];
  let ixc: Server | undefined;
  let portaDoIxc = 0;
  let waha: Server | undefined;

  try {
    ({ servidor: ixc, porta: portaDoIxc } = await subirIxcFalso());
    waha = await subirWahaFalso(enviadasAoWaha);

    // Organização, admin, canal WAHA — o mesmo cenário do primeiro teste.
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Paula Admin" } });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", { display_name: "Provedor da IA", legal_name: "Provedor da IA", slug: `conector-ia-${randomUUID()}`, onboarded_at: new Date().toISOString() });
    const vinculo = await db.from("user_organizations").insert({ organization_id: org, user_id: user, role: "admin", accepted_at: new Date().toISOString() });
    if (vinculo.error) throw vinculo.error;
    const session = await insert("channel_sessions", { organization_id: org, waha_session_name: `conector-ia-${randomUUID()}`, display_name: "Whats Cobrança", phone_number: "+556130004064", status: "WORKING", webhook_secret_encrypted: "\\x00" });
    // Janela anti-ban aberta o dia todo: o CI roda de madrugada (UTC) e o ritmo
    // vetaria por horário — o teste mediria o relógio, não a cobrança.
    // `channel_knobs` tem chave primária composta (organization_id, channel_session_id) —
    // sem coluna "id", então não passa pelo helper `insert()` genérico (que sempre lê "id").
    const knobsInseridos = await db.from("channel_knobs").insert({ organization_id: org, channel_session_id: session, window_start_hour: 0, window_end_hour: 24, allow_sunday: true, throttle_ms: 0, jitter_max_ms: 0 });
    if (knobsInseridos.error) throw knobsInseridos.error;

    // Credencial de IA — SEM ela o editor recusa salvar rascunho nenhum
    // ("Escolha a chave de acesso...", validação client-side de AgentForm.tsx):
    // a instalação deste rig não tem chave nenhuma configurada (de propósito, o
    // e2e não fala com IA de verdade), então a "chave da instalação" também
    // seria recusada. O valor cifrado nunca é usado de verdade — o turno roda
    // com `createFakeRegistry`, que nunca chama a Anthropic.
    const chaveCifrada = encryptKey("sk-ant-e2e-fake-0000000000000000");
    const credencial = await insert("ai_provider_credentials", {
      organization_id: org,
      provider: "anthropic",
      label: "Credencial de teste (e2e)",
      api_key_encrypted: bufToBytea(chaveCifrada.ciphertext),
      api_key_iv: bufToBytea(chaveCifrada.iv),
      api_key_tag: bufToBytea(chaveCifrada.tag),
      api_key_last4: chaveCifrada.last4,
      validated_at: new Date().toISOString(),
    });

    // Agente MCP em RASCUNHO no canal; as capacidades são ligadas PELA TELA.
    const agente = await insert("ai_agents", { organization_id: org, name: "Bia de Teste", system_prompt: "Você é a Bia.", kind: "mcp_agent" });
    const versao = await insert("ai_agent_versions", { organization_id: org, agent_id: agente, version_number: 1, system_prompt: "Você é a Bia.", provider: "anthropic", model: "claude-sonnet-4-6", credential_id: credencial, channel_session_id: session, status: "draft" });

    async function conversaDe(nome: string, telefone: string, texto: string) {
      const contato = await insert("contacts", { organization_id: org, display_name: nome, phone_number: telefone });
      const conversa = await insert("conversations", { organization_id: org, contact_id: contato, channel_session_id: session, status: "ai_handling" });
      const sentAt = new Date().toISOString();
      await insert("messages", { organization_id: org, contact_id: contato, conversation_id: conversa, channel_session_id: session, direction: "inbound", type: "text", status: "received", sent_via: "external_device", body: texto, sent_at: sentAt });
      const marked = await db.rpc("fn_mark_conversation_message", { p_conv: conversa, p_direction: "inbound", p_preview: texto, p_at: sentAt });
      if (marked.error) throw marked.error;
      return { contato, conversa };
    }
    const bruna = await conversaDe("Bruna Whats", "+5561993040600", "Oi, quero pagar minha fatura");
    const caio = await conversaDe("Caio Whats", "+5561993040700", "Me manda o boleto");

    await login(page, email, password);

    // ── 1. SEM conector, o editor do agente NÃO oferece as capacidades ────────
    await page.goto(`/app/ai/agents/${agente}`);
    await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("toggle-avancado").click();
    await expect(page.getByTestId("capacidade-crm_enviar_cobranca_erp")).toHaveCount(0);
    await expect(page.getByTestId("capacidade-crm_consultar_cliente_erp")).toHaveCount(0);

    // ── 2. O admin liga o IXC e ajusta o limite para 70 dias ──────────────────
    await page.goto("/app/settings/conectores");
    const ficha = page.getByTestId("conector-ixc");
    await ficha.getByLabel("Endereço do sistema").fill(`http://127.0.0.1:${portaDoIxc}`);
    await ficha.getByLabel("Token de acesso").fill(TOKEN_CERTO);
    await ficha.getByRole("button", { name: "Testar e salvar" }).click();
    await expect(ficha).toHaveAttribute("data-estado", "ligado", { timeout: 30_000 });
    const limite = page.getByTestId("limite-cobranca-ixc");
    await expect(limite.getByLabel("Dias de atraso")).toHaveValue("60");
    await limite.getByLabel("Dias de atraso").fill("70");
    await limite.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Limite salvo.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/ia/01-limite-de-dias.png` });
    const { data: conexao } = await db.from("conector_conexoes").select("cobranca_encaminha_apos_dias").eq("organization_id", org).single();
    expect(conexao?.cobranca_encaminha_apos_dias).toBe(70);

    // ── 3. Agora o editor oferece as duas; a cobrança é CRÍTICA (marcação individual) ──
    await page.goto(`/app/ai/agents/${agente}`);
    await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("toggle-avancado").click();
    for (const id of ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) {
      const caixa = page.getByTestId(`capacidade-${id}`).first();
      await expect(caixa).toBeVisible();
      await caixa.click();
    }
    await page.screenshot({ path: `${evidence}/ia/02-capacidades-ligadas.png` });
    await page.getByRole("button", { name: /salvar rascunho/i }).click();
    await expect
      .poll(async () => (await db.from("ai_agent_versions").select("tool_ids").eq("id", versao).single()).data?.tool_ids ?? [])
      .toEqual(expect.arrayContaining(["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]));
    // Publicar NÃO é o que este teste mede (exige chave de IA): o rascunho salvo pela tela vira a versão no ar.
    await db.from("ai_agent_versions").update({ status: "published" }).eq("id", versao);
    await db.from("ai_agents").update({ published_version_id: versao }).eq("id", agente);

    // ── 4. A IA atende a Bruna: identifica pelo telefone e manda o Pix da vencida ──
    await rodarTurnoDaIA(org, bruna.conversa);
    await page.goto(`/app/inbox/${bruna.conversa}`);
    await expect(page.getByText("Segue o Pix da sua fatura.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(COPIA_E_COLA)).toBeVisible();
    await expect(page.getByText("Prontinho! Te mandei o Pix da fatura.")).toBeVisible();
    // MEDIDO, não a olho (doutrina do repo): a bolha é um `<img>` de verdade, e
    // "está no DOM" não prova "carregou" — uma URL assinada que não resolve
    // deixa a MESMA tag visível e vazia. `naturalWidth`/`naturalHeight` só ficam
    // > 0 depois de o navegador ter de fato decodificado os bytes da imagem.
    const imagemDoPix = page.getByTestId("chat-thread").locator("img").last();
    await expect(imagemDoPix).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => imagemDoPix.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => imagemDoPix.evaluate((el: HTMLImageElement) => el.naturalHeight), { timeout: 30_000 }).toBeGreaterThan(0);
    await imagemDoPix.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/ia/03-ia-enviou-o-pix.png`, fullPage: true });

    const { data: saidas } = await db.from("messages").select("type, body, media_storage_path, sent_via").eq("conversation_id", bruna.conversa).eq("direction", "outbound").order("created_at");
    expect(saidas?.map((m) => m.type)).toEqual(["image", "text", "text"]);
    expect(String(saidas?.[0]?.media_storage_path)).toMatch(new RegExp(`^${org}/${bruna.conversa}/cobranca-[0-9a-f]{8}/pix-`));
    expect(acoesPedidas.filter((a) => a.startsWith("get_pix"))).toContain("get_pix:960");
    expect(acoesPedidas).not.toContain("get_pix:961"); // nunca duas
    expect(enviadasAoWaha.some((e) => e.includes(COPIA_E_COLA))).toBe(true);
    const { data: trilha } = await db.from("api_audit_log").select("action, metadata").eq("organization_id", org).in("action", ["conector.vinculo_criado", "conector.fatura_enviada"]);
    expect(trilha?.find((t) => t.action === "conector.fatura_enviada")?.metadata).toMatchObject({ fatura: "960", forma: "pix", ator: "ai_agent" });
    expect(trilha?.find((t) => t.action === "conector.vinculo_criado")?.metadata).toMatchObject({ verificado_por: "telefone", ator: "ai_agent" });

    // ── 5. O Caio passa do limite (75 > 70): NADA de cobrança sai ─────────────
    const antes = acoesPedidas.length;
    await rodarTurnoDaIA(org, caio.conversa);
    await page.goto(`/app/inbox/${caio.conversa}`);
    await expect(page.getByText("Sua fatura foi encaminhada ao nosso setor de cobrança", { exact: false })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${evidence}/ia/04-acima-do-limite-nao-envia.png`, fullPage: true });
    const { data: doCaio } = await db.from("messages").select("type").eq("conversation_id", caio.conversa).eq("direction", "outbound");
    expect(doCaio?.map((m) => m.type)).toEqual(["text"]);
    expect(acoesPedidas.slice(antes).some((a) => a.startsWith("get_"))).toBe(false);
    const { data: encaminhada } = await db.from("api_audit_log").select("metadata").eq("organization_id", org).eq("action", "conector.cobranca_encaminhada");
    // O NÚMERO exato de dias depende do fuso (São Paulo) em que o conector conta
    // — medido: `dia(-75)` neste fixture já rendeu 74 num horário e 75 noutro,
    // por causa do corte de meia-noite local. O invariante que importa é "acima
    // do limite", não o dígito exato.
    expect(encaminhada?.[0]?.metadata).toMatchObject({ fatura: "970", limite_de_dias: 70 });
    expect((encaminhada?.[0]?.metadata as { dias_de_atraso?: number } | undefined)?.dias_de_atraso).toBeGreaterThan(70);
  } finally {
    await fecharServidor(ixc);
    await fecharServidor(waha);
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
