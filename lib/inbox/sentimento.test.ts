import { describe, expect, it } from "vitest";

import { faixaDoSentimento, formatarNota, pedeAtencao, sentimentoDaConversa } from "./sentimento";

describe("a régua de faixas do tom do cliente", () => {
  it.each([
    [0.05, "critico"],
    [0.0999, "critico"],
    [0.1, "insatisfeito"],
    [0.25, "insatisfeito"],
    [0.3, "neutro"],
    [0.59, "neutro"],
    [0.6, "satisfeito"],
    [1, "satisfeito"],
  ])("%d → %s", (nota, faixa) => {
    expect(faixaDoSentimento(nota)).toBe(faixa);
  });

  it("sem nota não inventa faixa", () => {
    expect(faixaDoSentimento(null)).toBeNull();
    expect(faixaDoSentimento(undefined)).toBeNull();
  });

  it("só insatisfeito e crítico pedem atenção (o card fica mudo nos outros)", () => {
    expect(pedeAtencao("critico")).toBe(true);
    expect(pedeAtencao("insatisfeito")).toBe(true);
    expect(pedeAtencao("neutro")).toBe(false);
    expect(pedeAtencao("satisfeito")).toBe(false);
  });

  it("nota com vírgula e duas casas", () => {
    expect(formatarNota(0.123)).toBe("0,12");
  });
});

describe("o sentimento que a tela mostra de uma conversa", () => {
  it("atual e pior do atendimento; numeric pode chegar como texto", () => {
    expect(sentimentoDaConversa({ status: "open", sentimento_atual: "0.7", sentimento_minimo: "0.05" })).toMatchObject({
      atual: 0.7,
      minimo: 0.05,
      faixa: "satisfeito",
      faixaDoPior: "critico",
    });
  });

  it("encerrada não mostra (defesa para resposta em cache)", () => {
    expect(sentimentoDaConversa({ status: "closed", sentimento_atual: 0.05 })).toBeNull();
  });

  it("sem nota, nada", () => {
    expect(sentimentoDaConversa({ status: "open", sentimento_atual: null })).toBeNull();
  });
});
