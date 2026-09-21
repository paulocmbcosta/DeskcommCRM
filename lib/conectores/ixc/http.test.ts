import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FalhaDoConector } from "../tipos";

const resolvido = vi.fn(async (_host: string) => {});
vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: (host: string) => resolvido(host),
}));

import { baixarBoletoDoIxc, buscarPixNoIxc, hostLiberadoPeloOperador, listarNoIxc, normalizarBaseUrl } from "./http";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "53:abc" };
const PEDIDO = {
  tabela: "cliente",
  filtro: { campo: "cliente.id", operador: "=" as const, valor: "7" },
  campos: ["id", "razao"] as const,
};

function responder(corpo: string, init: { status?: number; tipo?: string } = {}) {
  return new Response(corpo, { status: init.status ?? 200, headers: { "content-type": init.tipo ?? "text/x-json" } });
}

const fetchFalso = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchFalso.mockReset();
  resolvido.mockReset();
  resolvido.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchFalso);
  delete process.env.CONECTORES_HOSTS_PRIVADOS;
});
afterEach(() => vi.unstubAllGlobals());

async function motivoDe(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (err) {
    if (err instanceof FalhaDoConector) return err.motivo;
    throw err;
  }
  return "NAO_FALHOU";
}

describe("listarNoIxc — o pedido", () => {
  it("é POST na rota da tabela, com a operação no header e o token em Basic base64", async () => {
    fetchFalso.mockResolvedValue(responder(JSON.stringify({ total: "0", registros: [] })));
    await listarNoIxc(CRED, PEDIDO);

    const [url, init] = fetchFalso.mock.calls[0]!;
    expect(url).toBe("https://erp.exemplo.com.br/webservice/v1/cliente");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.ixcsoft).toBe("listar");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("53:abc").toString("base64")}`);
    // Redirect seguido seria SSRF pela porta dos fundos: o host validado não é o host alcançado.
    expect(init.redirect).toBe("error");
  });

  it("serializa os filtros adicionais como STRING dentro do JSON (grid_param)", async () => {
    fetchFalso.mockResolvedValue(responder(JSON.stringify({ total: "0", registros: [] })));
    await listarNoIxc(CRED, { ...PEDIDO, tambem: [{ campo: "fn_areceber.status", operador: "=", valor: "A" }] });

    const corpo = JSON.parse(String(fetchFalso.mock.calls[0]![1].body));
    expect(typeof corpo.grid_param).toBe("string");
    expect(JSON.parse(corpo.grid_param)).toEqual([{ TB: "fn_areceber.status", OP: "=", P: "A" }]);
  });
});

describe("listarNoIxc — a lista branca", () => {
  it("descarta TODO campo fora da lista — a senha em claro que o IXC devolve não sai daqui", async () => {
    fetchFalso.mockResolvedValue(
      responder(
        JSON.stringify({
          total: "1",
          registros: [{ id: "7", razao: "Maria", senha: "segredo123", senha_rede_sem_fio: "wifi-da-casa", hotsite_email: "m@x.com" }],
        }),
      ),
    );
    const { registros, total } = await listarNoIxc(CRED, PEDIDO);

    expect(total).toBe(1);
    expect(registros).toEqual([{ id: "7", razao: "Maria" }]);
    expect(JSON.stringify(registros)).not.toContain("segredo123");
    expect(JSON.stringify(registros)).not.toContain("wifi-da-casa");
  });

  it("campo pedido e ausente vira string vazia — um jeito só de dizer 'vazio'", async () => {
    fetchFalso.mockResolvedValue(responder(JSON.stringify({ total: "1", registros: [{ id: "7", razao: null }] })));
    const { registros } = await listarNoIxc(CRED, PEDIDO);
    expect(registros).toEqual([{ id: "7", razao: "" }]);
  });
});

describe("listarNoIxc — o erro é lido NO CORPO", () => {
  it("HTTP 200 + text/html + {type,message} é recurso indisponível, não sucesso vazio", async () => {
    fetchFalso.mockResolvedValue(
      responder(JSON.stringify({ type: "error", message: "Recurso os não está disponível!" }), { tipo: "text/html" }),
    );
    expect(await motivoDe(listarNoIxc(CRED, PEDIDO))).toBe("recurso_indisponivel");
  });

  it("401 é credencial recusada", async () => {
    fetchFalso.mockResolvedValue(responder("<html>401 Authorization Required</html>", { status: 401, tipo: "text/html" }));
    expect(await motivoDe(listarNoIxc(CRED, PEDIDO))).toBe("credencial_recusada");
  });

  it("corpo que não é JSON (página de login, host que nem é IXC) é resposta inesperada", async () => {
    fetchFalso.mockResolvedValue(responder("<html>bem-vindo</html>", { tipo: "text/html" }));
    expect(await motivoDe(listarNoIxc(CRED, PEDIDO))).toBe("resposta_inesperada");
  });

  it("rede fora é sem resposta — e a mensagem NÃO carrega a URL do cliente", async () => {
    fetchFalso.mockRejectedValue(new TypeError("fetch failed: https://erp.exemplo.com.br/webservice/v1/cliente"));
    try {
      await listarNoIxc(CRED, PEDIDO);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FalhaDoConector);
      expect((err as FalhaDoConector).motivo).toBe("sem_resposta");
      expect((err as FalhaDoConector).message).not.toContain("exemplo.com.br");
    }
  });
});

describe("listarNoIxc — anti-SSRF: o admin do tenant escolhe o host, o SERVIDOR chama", () => {
  it.each(["http://localhost:8080", "https://127.0.0.1", "https://10.0.0.5", "https://192.168.1.1", "https://169.254.169.254"])(
    "recusa %s sem nem tentar a chamada",
    async (baseUrl) => {
      expect(await motivoDe(listarNoIxc({ ...CRED, baseUrl }, PEDIDO))).toBe("url_insegura");
      expect(fetchFalso).not.toHaveBeenCalled();
    },
  );

  it("recusa host público cujo DNS resolve para rede interna", async () => {
    resolvido.mockRejectedValue(new Error("unsafe_url:private_ip"));
    expect(await motivoDe(listarNoIxc(CRED, PEDIDO))).toBe("url_insegura");
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("o OPERADOR da instalação libera um host privado por nome EXATO — sufixo não vale", async () => {
    process.env.CONECTORES_HOSTS_PRIVADOS = "10.0.0.5, erp.interno";
    expect(hostLiberadoPeloOperador("10.0.0.5")).toBe(true);
    expect(hostLiberadoPeloOperador("ERP.interno")).toBe(true);
    expect(hostLiberadoPeloOperador("10.0.0.5.atacante.com")).toBe(false);
    expect(hostLiberadoPeloOperador("10.0.0.50")).toBe(false);

    fetchFalso.mockResolvedValue(responder(JSON.stringify({ total: "0", registros: [] })));
    await listarNoIxc({ ...CRED, baseUrl: "http://10.0.0.5" }, PEDIDO);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });
});

describe("normalizarBaseUrl", () => {
  it.each([
    ["totussistema.com.br", "https://totussistema.com.br"],
    ["https://erp.exemplo.com.br/", "https://erp.exemplo.com.br"],
    ["https://erp.exemplo.com.br/webservice/v1", "https://erp.exemplo.com.br"],
    ["  https://erp.exemplo.com.br/webservice/v1/  ", "https://erp.exemplo.com.br"],
  ])("%s → %s", (entrada, esperado) => {
    expect(normalizarBaseUrl(entrada)).toBe(esperado);
  });
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

describe("baixarBoletoDoIxc — o PDF vem em base64 como TEXTO PURO, e só sai daqui se for PDF", () => {
  it("pede o arquivo SEM atualizar, sem juro e sem multa — este conector só lê", async () => {
    fetchFalso.mockResolvedValue(responder(PDF.toString("base64"), { tipo: "text/html; charset=ISO-8859-1" }));
    const pdf = await baixarBoletoDoIxc(CRED, "900");

    expect(pdf?.equals(PDF)).toBe(true);
    const [url, init] = fetchFalso.mock.calls[0]!;
    expect(url).toBe("https://erp.exemplo.com.br/webservice/v1/get_boleto");
    expect(JSON.parse(String(init.body))).toEqual({
      boletos: "900",
      juro: "N",
      multa: "N",
      atualiza_boleto: "N",
      tipo_boleto: "arquivo",
      base64: "S",
    });
  });

  it.each([
    ["corpo vazio (fatura que não existe — medido)", ""],
    ["JSON de erro", JSON.stringify({ type: "error", message: "Boleto não encontrado" })],
    ["página HTML", "<html>login</html>"],
    ["base64 válido que NÃO é PDF", Buffer.from("isto nao e um pdf").toString("base64")],
  ])("%s → null, nunca um arquivo qualquer para o WhatsApp do cliente", async (_caso, corpo) => {
    fetchFalso.mockResolvedValue(responder(corpo, { tipo: "text/html" }));
    expect(await baixarBoletoDoIxc(CRED, "900")).toBeNull();
  });

  it("token recusado continua sendo credencial recusada, não 'sem boleto'", async () => {
    fetchFalso.mockResolvedValue(responder("<html>401</html>", { status: 401, tipo: "text/html" }));
    expect(await motivoDe(baixarBoletoDoIxc(CRED, "900"))).toBe("credencial_recusada");
  });
});

describe("buscarPixNoIxc — da resposta inteira saem TRÊS campos", () => {
  const RESPOSTA = {
    type: "success",
    gateway: "gerencianet",
    pix: {
      dadosPix: {
        status: "ATIVA",
        txid: "txid-que-nao-sai",
        chave: "chave-que-nao-sai",
        devedor: { cpf: "52998224725", nome: "Maria Que Nao Sai" },
        valor: { original: "114.00" },
        pixCopiaECola: "000201-COPIA-E-COLA",
      },
      qrCode: { qrcode: "000201-COPIA-E-COLA", imagemQrcode: "iVBORw0-imagem-que-nao-sai", imagemSrc: "https://x/y.png" },
    },
  };

  it("devolve copia-e-cola, status e valor — e NADA do devedor, da chave ou do txid", async () => {
    fetchFalso.mockResolvedValue(responder(JSON.stringify(RESPOSTA)));
    const pix = await buscarPixNoIxc(CRED, "900");

    expect(pix).toEqual({ copiaECola: "000201-COPIA-E-COLA", status: "ATIVA", valorOriginal: "114.00" });
    expect(JSON.stringify(pix)).not.toMatch(/52998224725|Maria|txid|chave|iVBORw0/);
    expect(JSON.parse(String(fetchFalso.mock.calls[0]![1].body))).toEqual({ id_areceber: "900" });
  });

  it("fatura sem Pix responde HTTP 500 (medido) → null", async () => {
    fetchFalso.mockResolvedValue(responder("", { status: 500, tipo: "text/html" }));
    expect(await buscarPixNoIxc(CRED, "999999999")).toBeNull();
  });

  it.each([
    ["JSON sem `pix`", JSON.stringify({ type: "error", message: "x" })],
    ["copia-e-cola vazio", JSON.stringify({ pix: { qrCode: { qrcode: "  " }, dadosPix: {} } })],
    ["não-JSON", "<html>erro</html>"],
  ])("%s → null", async (_caso, corpo) => {
    fetchFalso.mockResolvedValue(responder(corpo));
    expect(await buscarPixNoIxc(CRED, "900")).toBeNull();
  });

  it("as duas ações passam pela MESMA guarda anti-SSRF da listagem", async () => {
    expect(await motivoDe(baixarBoletoDoIxc({ ...CRED, baseUrl: "https://10.0.0.5" }, "900"))).toBe("url_insegura");
    expect(await motivoDe(buscarPixNoIxc({ ...CRED, baseUrl: "https://169.254.169.254" }, "900"))).toBe("url_insegura");
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

