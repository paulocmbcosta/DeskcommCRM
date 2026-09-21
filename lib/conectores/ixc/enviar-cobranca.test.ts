import { beforeEach, describe, expect, it, vi } from "vitest";

const listar = vi.fn();
const baixarBoleto = vi.fn();
const buscarPix = vi.fn();
vi.mock("./http", () => ({
  listarNoIxc: (...a: unknown[]) => listar(...a),
  baixarBoletoDoIxc: (...a: unknown[]) => baixarBoleto(...a),
  buscarPixNoIxc: (...a: unknown[]) => buscarPix(...a),
}));

import { enviarCobrancaIxc, type ArquivoDaCobranca, type MensagemDaCobranca } from "./enviar-cobranca";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };
const AGORA = new Date("2026-09-19T15:00:00Z");
const PDF = Buffer.from("%PDF-1.4 boleto de teste %%EOF", "latin1");
/** O exemplo do manual do Banco Central — CRC 1D3D. */
const BR_CODE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

const FATURA = {
  id: "900",
  id_cliente: "10",
  id_contrato: "1",
  status: "A",
  data_vencimento: "2026-09-10",
  valor: "129.90",
  valor_aberto: "129.90",
  linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990",
  pix_txid: "txid0271",
  documento: "",
};

let guardados: ArquivoDaCobranca[];
let enviadas: MensagemDaCobranca[];
const portas = {
  guardarArquivo: vi.fn(async (a: ArquivoDaCobranca) => {
    guardados.push(a);
    return `org/conversa/${a.nome}-abc12345.${a.extensao}`;
  }),
  enviar: vi.fn(async (m: MensagemDaCobranca) => {
    enviadas.push(m);
  }),
};

const pedido = (forma: "boleto" | "pix", extra: Partial<Parameters<typeof enviarCobrancaIxc>[0]> = {}) =>
  enviarCobrancaIxc({ credencial: CRED, cadastrosVinculados: new Set(["10"]), faturaId: "900", forma, portas, agora: AGORA, ...extra });

beforeEach(() => {
  guardados = [];
  enviadas = [];
  for (const m of [listar, baixarBoleto, buscarPix, portas.guardarArquivo, portas.enviar]) m.mockClear();
  listar.mockResolvedValue({ total: 1, registros: [FATURA] });
  baixarBoleto.mockResolvedValue(PDF);
  buscarPix.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "ATIVA", valorOriginal: "114.00" } });
  portas.enviar.mockImplementation(async (m: MensagemDaCobranca) => {
    enviadas.push(m);
  });
});

describe("enviarCobrancaIxc — boleto", () => {
  it("manda o PDF baixado do IXC como DOCUMENTO, com legenda, e a linha digitável SOZINHA depois", async () => {
    const r = await pedido("boleto");

    expect(r).toMatchObject({ ok: true, forma: "boleto", enviadas: 2, previstas: 2 });
    expect(guardados[0]).toMatchObject({ nome: "boleto-10-09-2026", extensao: "pdf", mime: "application/pdf" });
    expect(guardados[0]?.conteudo.equals(PDF)).toBe(true);

    expect(enviadas[0]).toMatchObject({
      type: "document",
      media_storage_path: "org/conversa/boleto-10-09-2026-abc12345.pdf",
      media_mime: "application/pdf",
      media_size_bytes: PDF.length,
    });
    expect(enviadas[0]?.body).toContain("R$ 129,90");
    // O link do boleto no site do banco NÃO sai mais — nem link nenhum.
    expect(JSON.stringify(enviadas)).not.toMatch(/https?:\/\//);
    expect(enviadas[1]).toEqual({ type: "text", body: FATURA.linha_digitavel });
    expect(buscarPix).not.toHaveBeenCalled();
  });
});

describe("enviarCobrancaIxc — Pix", () => {
  it("manda o QR code como IMAGEM e o copia-e-cola SOZINHO; o valor da legenda é o do Pix", async () => {
    const r = await pedido("pix");

    expect(r).toMatchObject({ ok: true, forma: "pix", enviadas: 2, previstas: 2 });
    expect(guardados[0]).toMatchObject({ nome: "pix-10-09-2026", extensao: "png", mime: "image/png" });
    expect(guardados[0]?.conteudo.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(enviadas[0]).toMatchObject({ type: "image", media_mime: "image/png" });
    expect(enviadas[0]?.body).toContain("R$ 114,00");
    expect(enviadas[1]).toEqual({ type: "text", body: BR_CODE });
    expect(baixarBoleto).not.toHaveBeenCalled();
  });

  it("Pix que não está ATIVO (pago, expirado) NÃO é enviado — o banco do cliente recusaria", async () => {
    buscarPix.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "CONCLUIDA", valorOriginal: "114.00" } });
    expect(await pedido("pix")).toEqual({ ok: false, motivo: "pix_inativo" });
    expect(portas.guardarArquivo).not.toHaveBeenCalled();
    expect(portas.enviar).not.toHaveBeenCalled();
  });

  it("copia-e-cola que não fecha o CRC NÃO é enviado — é dinheiro, e ninguém conferiria depois", async () => {
    buscarPix.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE.replace("Fulano", "Fulana"), status: "ATIVA", valorOriginal: "114.00" } });
    expect(await pedido("pix")).toEqual({ ok: false, motivo: "pix_corrompido" });
    expect(portas.enviar).not.toHaveBeenCalled();
  });
});

describe("enviarCobrancaIxc — o que vale para as duas formas, venha o pedido de quem vier", () => {
  it("fatura de um cadastro NÃO vinculado ao contato → mesma resposta de 'não existe', e o IXC nem é consultado de novo", async () => {
    listar.mockResolvedValue({ total: 1, registros: [{ ...FATURA, id_cliente: "999" }] });
    expect(await pedido("boleto")).toEqual({ ok: false, motivo: "fatura_nao_encontrada" });
    listar.mockResolvedValue({ total: 0, registros: [] });
    expect(await pedido("pix")).toEqual({ ok: false, motivo: "fatura_nao_encontrada" });
    expect(baixarBoleto).not.toHaveBeenCalled();
    expect(buscarPix).not.toHaveBeenCalled();
    expect(portas.enviar).not.toHaveBeenCalled();
  });

  it("fatura paga entre o painel abrir e o clique → fatura_fechada, nada sai", async () => {
    listar.mockResolvedValue({ total: 1, registros: [{ ...FATURA, status: "R" }] });
    expect(await pedido("boleto")).toEqual({ ok: false, motivo: "fatura_fechada" });
    expect(portas.enviar).not.toHaveBeenCalled();
  });

  it("Pix AINDA NÃO gerado (o caso de produção): escolher Pix É pedir que o IXC o gere — e o resultado diz que foi gerado agora", async () => {
    listar.mockResolvedValue({ total: 1, registros: [{ ...FATURA, pix_txid: "" }] });
    const r = await pedido("pix");

    expect(buscarPix).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, forma: "pix", enviadas: 2, pixGeradoAgora: true });
    expect(enviadas[1]).toEqual({ type: "text", body: BR_CODE });
  });

  it("Pix que já existia não é 'gerado agora'; boleto nunca é", async () => {
    expect(await pedido("pix")).toMatchObject({ ok: true, pixGeradoAgora: false });
    expect(await pedido("boleto")).toMatchObject({ ok: true, pixGeradoAgora: false });
  });

  it("BOLETO que o IXC ainda não registrou NÃO é pedido a ele — pedir faria o IXC registrar um boleto que ninguém pediu", async () => {
    listar.mockResolvedValue({ total: 1, registros: [{ ...FATURA, linha_digitavel: "" }] });
    expect(await pedido("boleto")).toEqual({ ok: false, motivo: "forma_indisponivel" });
    expect(baixarBoleto).not.toHaveBeenCalled();
    // …mas a MESMA fatura vai por Pix.
    expect(await pedido("pix")).toMatchObject({ ok: true, forma: "pix" });
  });

  it("o IXC não devolveu a cobrança → cobranca_indisponivel, nada é guardado nem enviado", async () => {
    baixarBoleto.mockResolvedValue(null);
    expect(await pedido("boleto")).toEqual({ ok: false, motivo: "cobranca_indisponivel" });
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "" });
    expect(await pedido("pix")).toEqual({ ok: false, motivo: "cobranca_indisponivel" });
    // Quando o IXC disse o porquê, a frase dele sobe junto.
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "Carteira sem integração PIX" });
    expect(await pedido("pix")).toEqual({ ok: false, motivo: "cobranca_indisponivel", detalheDoErp: "Carteira sem integração PIX" });
    expect(portas.guardarArquivo).not.toHaveBeenCalled();
  });

  it("o arquivo saiu e o código não → devolve a contagem (a tela avisa); nada saiu → o erro sobe", async () => {
    portas.enviar.mockImplementationOnce(async (m: MensagemDaCobranca) => {
      enviadas.push(m);
    });
    portas.enviar.mockImplementationOnce(async () => {
      throw new Error("canal fora");
    });
    expect(await pedido("boleto")).toMatchObject({ ok: true, enviadas: 1, previstas: 2 });

    portas.enviar.mockImplementationOnce(async () => {
      throw new Error("canal fora");
    });
    await expect(pedido("boleto")).rejects.toThrow("canal fora");
  });
});
