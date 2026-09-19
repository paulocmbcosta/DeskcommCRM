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

export async function listarNoIxc(
  credencial: CredencialDeConector,
  pedido: PedidoDeListagem,
): Promise<Listagem> {
  const base = normalizarBaseUrl(credencial.baseUrl);
  const url = `${base}/webservice/v1/${encodeURIComponent(pedido.tabela)}`;
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
      signal: AbortSignal.timeout(PRAZO_MS),
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

  const texto = await resposta.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    // Página de login, erro de proxy, host que nem é IXC.
    throw new FalhaDoConector("resposta_inesperada", `ixc_nao_json_http_${resposta.status}`);
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
