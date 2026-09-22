import { describe, expect, it } from "vitest";

import type { Fatura } from "./faturas";
import { legendaDoBoleto, legendaDoPix, nomeDoArquivo } from "./mensagem-fatura";

const FATURA: Fatura = {
  id: "900",
  idContrato: "1",
  vencimento: "2026-09-10",
  valorCents: 12990,
  situacao: "vencida",
  diasDeAtraso: 9,
  linhaDigitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990",
  temBoleto: true,
  pixJaGerado: true,
};

describe("legendaDoBoleto", () => {
  it("traz valor em reais, vencimento em dd/mm/aaaa e o atraso — e NÃO traz a linha digitável (ela vai sozinha)", () => {
    const legenda = legendaDoBoleto(FATURA);
    expect(legenda).toContain("R$ 129,90");
    expect(legenda).toContain("10/09/2026");
    expect(legenda).toContain("vencida há 9 dias");
    expect(legenda).not.toContain(FATURA.linhaDigitavel);
    expect(legenda).not.toMatch(/https?:\/\//);
  });

  it("só promete a próxima mensagem quando ela vai existir", () => {
    expect(legendaDoBoleto(FATURA)).toContain("próxima mensagem");
    expect(legendaDoBoleto({ ...FATURA, linhaDigitavel: "" })).not.toContain("próxima mensagem");
  });

  it("fatura a vencer não fala em atraso; 1 dia é singular", () => {
    expect(legendaDoBoleto({ ...FATURA, situacao: "a_vencer", diasDeAtraso: 0 })).not.toContain("vencida");
    expect(legendaDoBoleto({ ...FATURA, diasDeAtraso: 1 })).toContain("vencida há 1 dia)");
  });
});

describe("legendaDoPix", () => {
  it("mostra o valor que o QR de fato cobra (o do Pix), e cai no da fatura quando ele não vem", () => {
    expect(legendaDoPix(FATURA, 11400)).toContain("R$ 114,00");
    expect(legendaDoPix(FATURA)).toContain("R$ 129,90");
  });

  it("explica os dois jeitos de pagar: a câmera e o copia e cola", () => {
    const legenda = legendaDoPix(FATURA);
    expect(legenda).toContain("QR code");
    expect(legenda).toContain("copia e cola");
  });
});

describe("nomeDoArquivo — é o nome que o cliente vê no WhatsApp", () => {
  it("diz o que é e de quando é, sem barra (barra viraria pasta no Storage)", () => {
    expect(nomeDoArquivo("boleto", FATURA)).toBe("boleto-10-09-2026");
    expect(nomeDoArquivo("pix", FATURA)).toBe("pix-10-09-2026");
  });
});
