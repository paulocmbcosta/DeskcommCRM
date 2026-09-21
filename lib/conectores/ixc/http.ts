/**
 * O CLIENTE HTTP DO IXC — uma função, e três coisas que ela sabe que o IXC faz
 * diferente do resto do mundo (medidas em 2026-09-19 contra uma instância real;
 * spec docs/superpowers/specs/2026-09-19-conector-ixc-design.md §3):
 *
 *  1. **A API é uma só rota por TABELA** (`/webservice/v1/{tabela}`), e a operação
 *     vai num header (`ixcsoft: listar`). O manual manda `GET` com corpo; o
 *     `fetch` do Node recusa GET com corpo, e a instância aceita POST igual.
 *  2. **Erro vem com HTTP 200.** Tabela que o token não alcança responde 200,
 *     `text/html`, e um JSON `{type, message}`. Sucesso responde `text/x-json`.
 *     Só o token errado devolve 401. Por isso o erro é lido NO CORPO — status e
 *     content-type mentem.
 *  3. **Não existe projeção de campos**, e as tabelas trazem SENHA EM CLARO
 *     (`cliente.senha`, `radusuarios.senha`, `senha_rede_sem_fio`,
 *     `senha_onu_cliente`). Esta função recebe a lista de campos permitidos e
 *     descarta o resto antes de devolver: o que não está na lista não chega a
 *     log, a resposta HTTP, nem — na fase seguinte — à IA.
 */
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

import { FalhaDoConector, type CredencialDeConector } from "../tipos";

const PRAZO_MS = 12_000;

export type OperadorIxc = "=" | "!=" | ">" | ">=" | "<" | "<=" | "L";

export interface FiltroIxc {
  /** `tabela.campo`. */
  campo: string;
  operador: OperadorIxc;
  valor: string;
}

export interface PedidoDeListagem {
  tabela: string;
  /** Filtro principal (`qtype`/`query`/`oper`). */
  filtro: FiltroIxc;
  /** Filtros adicionais, combinados com E (`grid_param`). */
  tambem?: FiltroIxc[];
  /** Lista BRANCA. Campo fora dela é descartado aqui, antes de qualquer uso. */
  campos: readonly string[];
  limite?: number;
  ordenarPor?: string;
  ordem?: "asc" | "desc";
}

export interface Listagem {
  total: number;
  registros: Record<string, string>[];
}

/** `https://host/` e `https://host/webservice/v1` viram o mesmo `https://host`. */
export function normalizarBaseUrl(bruta: string): string {
  const semEspaco = bruta.trim();
  const comEsquema = /^https?:\/\//i.test(semEspaco) ? semEspaco : `https://${semEspaco}`;
  return comEsquema.replace(/\/+$/, "").replace(/\/webservice\/v1$/i, "");
}

/**
 * A exceção que só o OPERADOR da instalação concede (`CONECTORES_HOSTS_PRIVADOS`):
 * ERP on-premise atrás de VPN. Comparação EXATA de hostname — sufixo ou prefixo
 * abririam `10.0.0.5.atacante.com`. Lido de `process.env` a cada chamada, como
 * `outbound-url.ts` faz com `NODE_ENV`: importar `lib/env` aqui obrigaria todo
 * teste deste arquivo a montar o ambiente inteiro.
 */
export function hostLiberadoPeloOperador(hostname: string): boolean {
  const lista = (process.env.CONECTORES_HOSTS_PRIVADOS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return lista.includes(hostname.toLowerCase());
}

function projetar(registro: unknown, campos: readonly string[]): Record<string, string> {
  const saida: Record<string, string> = {};
  if (!registro || typeof registro !== "object") return saida;
  const origem = registro as Record<string, unknown>;
  for (const campo of campos) {
    const valor = origem[campo];
    // O IXC devolve tudo como string; `null` e ausente viram "" para o chamador
    // não ter três jeitos de dizer "vazio".
    saida[campo] = valor === null || valor === undefined ? "" : String(valor);
  }
  return saida;
}

/**
 * A CHAMADA, comum a toda rota do IXC: as duas guardas anti-SSRF, o POST com o
 * token em Basic, o prazo, `redirect: "error"` e o 401/403. Quem chama decide o
 * que fazer com o corpo — `listar` devolve JSON, `get_boleto` devolve o PDF em
 * base64 como TEXTO PURO, e `get_pix` devolve JSON com HTTP 500 quando a fatura
 * não existe (medido em 2026-09-21).
 */
async function postarNoIxc(
  credencial: CredencialDeConector,
  rota: string,
  corpo: Record<string, string>,
  prazoMs: number = PRAZO_MS,
): Promise<{ status: number; texto: string }> {
  const base = normalizarBaseUrl(credencial.baseUrl);
  const url = `${base}/webservice/v1/${encodeURIComponent(rota)}`;
  try {
    // Quem escolhe este host é o admin do tenant, e quem o CHAMA é o servidor:
    // sem as duas guardas, o campo de endereço vira um proxy para a rede interna.
    if (!hostLiberadoPeloOperador(new URL(url).hostname)) {
      assertSafeOutboundUrl(url);
      await assertDestinoResolvidoSeguro(new URL(url).hostname);
    }
  } catch (err) {
    throw new FalhaDoConector("url_insegura", err instanceof Error ? err.message : "unsafe_url");
  }

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        ixcsoft: "listar",
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(credencial.token, "utf8").toString("base64")}`,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(prazoMs),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    // Sem repassar a mensagem do fetch: ela carrega a URL, e a URL é do cliente.
    throw new FalhaDoConector("sem_resposta", "ixc_sem_resposta");
  }

  if (resposta.status === 401 || resposta.status === 403) {
    throw new FalhaDoConector("credencial_recusada", `ixc_http_${resposta.status}`);
  }
  return { status: resposta.status, texto: await resposta.text().catch(() => "") };
}

export async function listarNoIxc(
  credencial: CredencialDeConector,
  pedido: PedidoDeListagem,
): Promise<Listagem> {
  const corpo: Record<string, string> = {
    qtype: pedido.filtro.campo,
    query: pedido.filtro.valor,
    oper: pedido.filtro.operador,
    page: "1",
    rp: String(pedido.limite ?? 20),
    sortname: pedido.ordenarPor ?? `${pedido.tabela}.id`,
    sortorder: pedido.ordem ?? "desc",
  };
  if (pedido.tambem?.length) {
    // `grid_param` é um array JSON serializado COMO STRING dentro do corpo JSON.
    corpo.grid_param = JSON.stringify(
      pedido.tambem.map((f) => ({ TB: f.campo, OP: f.operador, P: f.valor })),
    );
  }

  const { status, texto } = await postarNoIxc(credencial, pedido.tabela, corpo);
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    // Página de login, erro de proxy, host que nem é IXC.
    throw new FalhaDoConector("resposta_inesperada", `ixc_nao_json_http_${status}`);
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new FalhaDoConector("resposta_inesperada", "ixc_json_sem_forma");
  }
  const obj = json as Record<string, unknown>;
  if (!("total" in obj) && !("registros" in obj)) {
    // `{type: "error", message: "Recurso x não está disponível!"}` — com HTTP 200.
    throw new FalhaDoConector("recurso_indisponivel", `ixc_${pedido.tabela}_indisponivel`);
  }

  const registros = Array.isArray(obj.registros) ? obj.registros : [];
  const total = Number.parseInt(String(obj.total ?? registros.length), 10);
  return {
    total: Number.isFinite(total) ? total : registros.length,
    registros: registros.map((r) => projetar(r, pedido.campos)),
  };
}

/** O PDF de um boleto já é pequeno (~45 KB medido); 10 MB é o teto de sanidade, não a expectativa. */
const TETO_DO_PDF_BYTES = 10 * 1024 * 1024;
/** `get_boleto` monta um PDF do lado de lá: medido em ~2 s, contra ~1,4 s de uma listagem. */
const PRAZO_DA_COBRANCA_MS = 25_000;

/**
 * O PDF do boleto, baixado DO IXC — é o boleto que o provedor emite, com a cara
 * dele. (A primeira versão mandava o `gateway_link`, que é o boleto no site do
 * banco: funciona, mas não é o documento que o cliente reconhece.)
 *
 * Medido: o corpo é o PDF em base64 como TEXTO PURO — sem JSON em volta, com
 * `text/html` no content-type. Fatura que não existe devolve corpo VAZIO com
 * HTTP 200. `atualiza_boleto`, `juro` e `multa` vão `N` de propósito: `S`
 * recalcula e regrava a cobrança, e este conector só lê.
 *
 * `null` = o IXC não tem boleto para esta fatura. Nunca devolve algo que não
 * comece com `%PDF` — o que sai daqui vai para o WhatsApp de um cliente.
 */
export async function baixarBoletoDoIxc(credencial: CredencialDeConector, idDaFatura: string): Promise<Buffer | null> {
  const { texto } = await postarNoIxc(
    credencial,
    "get_boleto",
    { boletos: idDaFatura, juro: "N", multa: "N", atualiza_boleto: "N", tipo_boleto: "arquivo", base64: "S" },
    PRAZO_DA_COBRANCA_MS,
  );
  const base64 = texto.trim().replace(/^"|"$/g, "");
  if (base64 === "" || base64.startsWith("{") || base64.startsWith("<")) return null;
  if (base64.length > TETO_DO_PDF_BYTES * 1.4) return null;
  const pdf = Buffer.from(base64, "base64");
  if (pdf.length === 0 || pdf.length > TETO_DO_PDF_BYTES) return null;
  return pdf.subarray(0, 5).toString("latin1") === "%PDF-" ? pdf : null;
}

export interface PixDoIxc {
  /** O BR Code — o "copia e cola". É o que vira QR code e o que o cliente cola no banco. */
  copiaECola: string;
  /** `ATIVA` é o único estado em que o Pix ainda pode ser pago. */
  status: string;
  /** `valor.original` da cobrança, como o PSP o tem. Vazio se o IXC não mandar. */
  valorOriginal: string;
}

/**
 * O Pix da fatura. Da resposta inteira (que traz CPF e nome do devedor, chave,
 * txid, location…) saem TRÊS campos — a mesma regra da lista branca das tabelas.
 *
 * Medido: `{type, gateway, pix: {dadosPix, qrCode}}`; `qrCode.qrcode` e
 * `dadosPix.pixCopiaECola` são a mesma string; fatura inexistente responde
 * HTTP 500. `null` = o IXC não tem Pix para esta fatura.
 */
export async function buscarPixNoIxc(credencial: CredencialDeConector, idDaFatura: string): Promise<PixDoIxc | null> {
  const { status, texto } = await postarNoIxc(credencial, "get_pix", { id_areceber: idDaFatura }, PRAZO_DA_COBRANCA_MS);
  if (status >= 500) return null;
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    return null;
  }
  const pix = (json as { pix?: { qrCode?: { qrcode?: unknown }; dadosPix?: Record<string, unknown> } } | null)?.pix;
  const dados = pix?.dadosPix;
  const copiaECola = pix?.qrCode?.qrcode ?? dados?.pixCopiaECola;
  if (typeof copiaECola !== "string" || copiaECola.trim() === "") return null;
  const valor = dados?.valor as { original?: unknown } | undefined;
  return {
    copiaECola: copiaECola.trim(),
    status: typeof dados?.status === "string" ? dados.status : "",
    valorOriginal: typeof valor?.original === "string" ? valor.original : "",
  };
}

