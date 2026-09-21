import { describe, expect, it } from "vitest";

import { hojeEmSaoPaulo, lerFatura, reaisParaCents, recortarFaturas } from "./faturas";

const HOJE = "2026-09-19";

function fatura(id: string, vencimento: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    id,
    id_contrato: "1",
    status: "A",
    data_vencimento: vencimento,
    valor: "99.90",
    valor_aberto: "99.90",
    linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000009990",
    pix_txid: "txid0271",
    ...extra,
  };
}

describe("recortarFaturas — a regra do dono: TODAS as vencidas + a próxima + mais uma", () => {
  it("doze parcelas futuras viram duas na tela e dez na contagem", () => {
    const futuras = Array.from({ length: 12 }, (_, i) => fatura(String(100 + i), `2026-${String(10 + (i % 3)).padStart(2, "0")}-${String(10 + i).padStart(2, "0")}`));
    const r = recortarFaturas(futuras, HOJE);

    expect(r.vencidas).toEqual([]);
    expect(r.proximas).toHaveLength(2);
    expect(r.outrasAVencer).toBe(10);
    // As duas mostradas são as de vencimento MAIS PRÓXIMO, não as duas primeiras da lista.
    const ordenadas = futuras.map((f) => f.data_vencimento!).sort();
    expect(r.proximas.map((f) => f.vencimento)).toEqual(ordenadas.slice(0, 2));
  });

  it("vencida nunca é cortada: cinco vencidas aparecem as cinco, mais as duas próximas", () => {
    const registros = [
      ...["2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10"].map((d, i) => fatura(String(i), d)),
      fatura("p1", "2026-10-10"),
      fatura("p2", "2026-11-10"),
      fatura("p3", "2026-12-10"),
    ];
    const r = recortarFaturas(registros, HOJE);

    expect(r.vencidas).toHaveLength(5);
    expect(r.proximas.map((f) => f.id)).toEqual(["p1", "p2"]);
    expect(r.outrasAVencer).toBe(1);
    expect(r.totalVencidoCents).toBe(5 * 9990);
  });

  it("a que vence HOJE não é vencida — o cliente ainda tem o dia para pagar", () => {
    const r = recortarFaturas([fatura("1", HOJE)], HOJE);
    expect(r.vencidas).toEqual([]);
    expect(r.proximas[0]?.situacao).toBe("a_vencer");
  });

  it("conta os dias de atraso", () => {
    const r = recortarFaturas([fatura("1", "2026-09-10")], HOJE);
    expect(r.vencidas[0]?.diasDeAtraso).toBe(9);
  });

  it("linha sem data de vencimento legível é descartada, não vira 'vencida há NaN dias'", () => {
    // `0000-00-00` é o "nunca" do IXC: tem FORMA de data e ordenaria como a mais vencida de todas.
    expect(recortarFaturas([fatura("1", "0000-00-00"), fatura("2", "")], HOJE)).toMatchObject({
      vencidas: [],
      proximas: [],
    });
  });
});

describe("lerFatura", () => {
  it("cobra o que FALTA pagar (valor_aberto), não a fatura cheia", () => {
    expect(lerFatura(fatura("1", "2026-09-01", { valor: "100.00", valor_aberto: "40.00" }), HOJE)?.valorCents).toBe(4000);
  });

  it("sem valor_aberto, vale o valor", () => {
    expect(lerFatura(fatura("1", "2026-09-01", { valor: "100.00", valor_aberto: "" }), HOJE)?.valorCents).toBe(10000);
  });

  it("as formas disponíveis saem do que o IXC JÁ registrou: linha digitável = boleto, pix_txid = Pix", () => {
    const soBoleto = lerFatura(fatura("1", "2026-09-01", { pix_txid: "" }), HOJE);
    expect([soBoleto?.temBoleto, soBoleto?.temPix, soBoleto?.enviavel]).toEqual([true, false, true]);

    const soPix = lerFatura(fatura("1", "2026-09-01", { linha_digitavel: "", pix_txid: "abc123" }), HOJE);
    expect([soPix?.temBoleto, soPix?.temPix, soPix?.enviavel]).toEqual([false, true, true]);
  });

  it("parcela futura sem registro no gateway existe, mas não é enviável — pedir a cobrança faria o IXC registrá-la", () => {
    const f = lerFatura(fatura("1", "2026-12-01", { linha_digitavel: "", pix_txid: "  " }), HOJE);
    expect([f?.temBoleto, f?.temPix, f?.enviavel]).toEqual([false, false, false]);
  });

  it("o link do boleto no site do banco NÃO faz mais parte da fatura — o que se envia é o PDF do IXC", () => {
    const f = lerFatura(fatura("1", "2026-09-01", { gateway_link: "https://banco.exemplo/boleto/1" }), HOJE);
    expect(JSON.stringify(f)).not.toContain("banco.exemplo");
  });
});

describe("reaisParaCents — dinheiro é inteiro", () => {
  it.each([
    ["129.90", 12990],
    ["129.9", 12990],
    ["129", 12900],
    ["0.07", 7],
    ["1234,56", 123456],
    ["", 0],
    ["abc", 0],
  ])("%s → %i", (bruto, cents) => expect(reaisParaCents(bruto)).toBe(cents));

  it("não herda o erro de float de 0.1 + 0.2", () => {
    expect(reaisParaCents("0.1") + reaisParaCents("0.2")).toBe(30);
  });
});

describe("hojeEmSaoPaulo", () => {
  it("às 22h de São Paulo ainda é o MESMO dia, embora em UTC já seja o seguinte", () => {
    // 2026-09-11T01:00Z = 2026-09-10 22:00 em São Paulo (UTC-3).
    expect(hojeEmSaoPaulo(new Date("2026-09-11T01:00:00Z"))).toBe("2026-09-10");
  });
});
