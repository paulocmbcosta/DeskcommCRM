import { describe, expect, it } from "vitest";

import { CAMPOS_DA_FATURA } from "./campos";
import { faturaDaVez, hojeEmSaoPaulo, lerFatura, pedidoDeFaturasAbertas, reaisParaCents, recortarFaturas } from "./faturas";

const HOJE = "2026-09-19";

function fatura(id: string, vencimento: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    id,
    id_contrato: "1",
    status: "A",
    liberado: "S",
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

  it("boleto só existe quando o IXC já o registrou (linha digitável); o Pix já gerado é só INFORMAÇÃO", () => {
    const comOsDois = lerFatura(fatura("1", "2026-09-01"), HOJE);
    expect([comOsDois?.temBoleto, comOsDois?.pixJaGerado]).toEqual([true, true]);

    // O caso medido em produção (2026-09-22): boleto registrado e NENHUM `pix_txid`.
    // A fatura continua podendo ir por Pix — o IXC o gera quando `get_pix` é chamado.
    const soBoleto = lerFatura(fatura("1", "2026-09-25", { pix_txid: "" }), HOJE);
    expect([soBoleto?.temBoleto, soBoleto?.pixJaGerado]).toEqual([true, false]);
  });

  it("parcela futura sem registro no gateway não tem boleto para baixar — e não há campo nenhum que a declare 'não enviável'", () => {
    const f = lerFatura(fatura("1", "2026-12-01", { linha_digitavel: "", pix_txid: "  " }), HOJE);
    expect([f?.temBoleto, f?.pixJaGerado]).toEqual([false, false]);
    expect(f).not.toHaveProperty("enviavel");
  });

  it("o link do boleto no site do banco NÃO faz mais parte da fatura — o que se envia é o PDF do IXC", () => {
    const f = lerFatura(fatura("1", "2026-09-01", { gateway_link: "https://banco.exemplo/boleto/1" }), HOJE);
    expect(JSON.stringify(f)).not.toContain("banco.exemplo");
  });
});

describe("título NÃO LIBERADO não é cobrança (medido em produção em 2026-10-07)", () => {
  // O caso real: em 14/03/2024 abriram uma venda de R$ 159,80 e não a finalizaram —
  // refizeram outra, de R$ 79,90, paga no mesmo dia. A primeira ficou no IXC com um
  // título `status = A` e `liberado = N`. As telas do IXC não o mostram; o painel o
  // mostrava como "vencida há 906 dias", na frente da fatura que a cliente devia.
  const HOJE = "2026-10-07";
  const FANTASMA = fatura("7001", "2024-04-13", { valor: "159.80", valor_aberto: "159.80", linha_digitavel: "", pix_txid: "", liberado: "N" });
  const CARNE = [fatura("9102", "2026-10-20"), fatura("9103", "2026-11-20"), fatura("9104", "2026-12-21")];

  it("não entra nas vencidas, no total, nem na contagem das que vão vencer", () => {
    const r = recortarFaturas([FANTASMA, ...CARNE], HOJE);
    expect(r.vencidas).toEqual([]);
    expect(r.totalVencidoCents).toBe(0);
    expect(r.proximas.map((f) => f.id)).toEqual(["9102", "9103"]);
    expect(r.outrasAVencer).toBe(1);
  });

  it("não vira a fatura da vez na frente da que o cliente deve de verdade", () => {
    const r = recortarFaturas([FANTASMA, fatura("9101", "2026-09-21"), ...CARNE], HOJE);
    expect(faturaDaVez([...r.vencidas, ...r.proximas])).toMatchObject({ id: "9101", diasDeAtraso: 16 });
  });

  it("só `S` libera: campo vazio ou código que este conector nunca viu também não é cobrança", () => {
    expect(lerFatura(fatura("1", "2026-09-01", { liberado: "" }), HOJE)).toBeNull();
    expect(lerFatura(fatura("1", "2026-09-01", { liberado: "X" }), HOJE)).toBeNull();
  });

  it("controle: a mesma linha, liberada, é lida", () => {
    expect(lerFatura({ ...FANTASMA, liberado: "S" }, HOJE)).toMatchObject({ id: "7001", valorCents: 15980, situacao: "vencida" });
  });
});

describe("pedidoDeFaturasAbertas — a pergunta que o painel e a IA fazem ao IXC", () => {
  it("pede as abertas E liberadas do cadastro, pela lista branca, da mais antiga para a mais nova", () => {
    expect(pedidoDeFaturasAbertas("10")).toEqual({
      tabela: "fn_areceber",
      filtro: { campo: "fn_areceber.id_cliente", operador: "=", valor: "10" },
      tambem: [
        { campo: "fn_areceber.status", operador: "=", valor: "A" },
        { campo: "fn_areceber.liberado", operador: "=", valor: "S" },
      ],
      campos: CAMPOS_DA_FATURA,
      limite: 50,
      ordenarPor: "fn_areceber.data_vencimento",
      ordem: "asc",
    });
  });

  it("o campo que decide a liberação vem na resposta — sem ele a releitura do envio não teria como conferir", () => {
    expect(CAMPOS_DA_FATURA).toContain("liberado");
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

describe("faturaDaVez — UMA fatura por vez (regra do dono, 22/09)", () => {
  const HOJE = "2026-09-22";
  const f = (id: string, venc: string) =>
    lerFatura({ id, id_cliente: "10", status: "A", liberado: "S", data_vencimento: venc, valor: "100.00", valor_aberto: "100.00" }, HOJE)!;

  it("a vencida MAIS ANTIGA vence qualquer outra", () => {
    const escolhida = faturaDaVez([f("3", "2026-09-10"), f("1", "2026-07-14"), f("9", "2026-10-12"), f("2", "2026-08-13")]);
    expect(escolhida?.id).toBe("1");
    expect(escolhida?.situacao).toBe("vencida");
  });

  it("sem vencida, a que vence primeiro", () => {
    expect(faturaDaVez([f("9", "2026-11-12"), f("8", "2026-10-12")])?.id).toBe("8");
  });

  it("empate no vencimento: decide o id, não a ordem de chegada", () => {
    expect(faturaDaVez([f("20", "2026-07-14"), f("7", "2026-07-14")])?.id).toBe("7");
    expect(faturaDaVez([f("7", "2026-07-14"), f("20", "2026-07-14")])?.id).toBe("7");
  });

  it("nenhuma fatura: null", () => {
    expect(faturaDaVez([])).toBeNull();
  });
});
