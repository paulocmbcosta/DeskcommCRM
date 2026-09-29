import { describe, expect, it } from "vitest";

import {
  PRAZO_DO_ARQUIVO_MS,
  PRAZO_TOTAL_DA_GRAVACAO_MS,
  RETENCAO_PADRAO_DIAS,
  RETENCOES_DA_GRAVACAO_DIAS,
  destinoSemArquivo,
  duracaoDoWavMs,
  gravacaoDaLigacao,
  nomeNoAsterisk,
  retencaoValida,
  vcIdDoNome,
} from "./gravacao";

const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";

describe("gravacaoDaLigacao — o leitor da projeção do cartão", () => {
  it.each([
    [{ situacao: "processando", duracao_ms: null }, { situacao: "processando", duracao_ms: null }],
    [{ situacao: "pronta", duracao_ms: 61_000 }, { situacao: "pronta", duracao_ms: 61_000 }],
    [{ situacao: "falhou" }, { situacao: "falhou", duracao_ms: null }],
    [{ situacao: "expirada", duracao_ms: 5_000 }, { situacao: "expirada", duracao_ms: 5_000 }],
  ])("%j", (bruto, esperado) => {
    expect(gravacaoDaLigacao(bruto)).toEqual(esperado);
  });

  it.each([
    ["nulo", null],
    ["texto", "pronta"],
    ["lista", ["pronta"]],
    ["sem situação", { duracao_ms: 1_000 }],
    ["situação fora do vocabulário", { situacao: "gravando" }],
  ])("%s → null (o cartão cala em vez de inventar)", (_nome, bruto) => {
    expect(gravacaoDaLigacao(bruto)).toBeNull();
  });

  it("duração que não é número positivo vira nula", () => {
    expect(gravacaoDaLigacao({ situacao: "pronta", duracao_ms: "61000" })).toEqual({ situacao: "pronta", duracao_ms: null });
    expect(gravacaoDaLigacao({ situacao: "pronta", duracao_ms: -3 })).toEqual({ situacao: "pronta", duracao_ms: null });
  });
});

describe("o nome da gravação no Asterisk", () => {
  it("é g-<id da ligação>, e volta ao id", () => {
    expect(nomeNoAsterisk(VC)).toBe(`g-${VC}`);
    expect(vcIdDoNome(`g-${VC}`)).toBe(VC);
  });

  it.each(["sonda-g-1", `g-${VC}.wav`, "g-", `x-${VC}`, `g-${VC}/../etc`, "g-não-é-uuid"])("%s não é gravação de ligação", (nome) => {
    expect(vcIdDoNome(nome)).toBeNull();
  });
});

describe("duracaoDoWavMs — WAV do Asterisk: 8 kHz, 16 bits, mono, cabeçalho de 44 bytes", () => {
  it.each([
    [44, 0],
    [44 + 16_000, 1_000],
    [44 + 16_000 * 61, 61_000],
    [10, 0],
  ])("%i bytes → %i ms", (bytes, ms) => {
    expect(duracaoDoWavMs(bytes)).toBe(ms);
  });
});

describe("destinoSemArquivo — o Asterisk ainda não entregou o arquivo", () => {
  const fim = new Date("2026-09-29T22:00:00Z");
  it("logo depois do fim, espera", () => {
    expect(destinoSemArquivo({ fimEm: fim, agora: new Date(fim.getTime() + 30_000) })).toBe("esperar");
  });
  it("passado o prazo do arquivo, falha", () => {
    expect(destinoSemArquivo({ fimEm: fim, agora: new Date(fim.getTime() + PRAZO_DO_ARQUIVO_MS) })).toBe("falhar");
  });
  it("o prazo total é maior que o do arquivo", () => {
    expect(PRAZO_TOTAL_DA_GRAVACAO_MS).toBeGreaterThan(PRAZO_DO_ARQUIVO_MS);
  });
});

describe("retenção", () => {
  it("o padrão é 90 dias e está entre as opções da tela", () => {
    expect(RETENCAO_PADRAO_DIAS).toBe(90);
    expect(RETENCOES_DA_GRAVACAO_DIAS).toContain(RETENCAO_PADRAO_DIAS);
  });
  it.each([
    [90, true],
    [30, true],
    [1825, true],
    [45, false],
    [0, false],
    [90.5, false],
  ])("%s → %s", (dias, valida) => {
    expect(retencaoValida(dias)).toBe(valida);
  });
});
