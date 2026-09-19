import { describe, expect, it } from "vitest";

import type { Fatura } from "./faturas";
import { mensagensDaFatura } from "./mensagem-fatura";

const FATURA: Fatura = {
  id: "900",
  idContrato: "1",
  vencimento: "2026-09-10",
  valorCents: 12990,
  situacao: "vencida",
  diasDeAtraso: 9,
  linhaDigitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990",
  link: "https://download.exemplo.com.br/boleto/900",
  enviavel: true,
};

describe("mensagensDaFatura", () => {
  it("a linha digitável vai SOZINHA na segunda mensagem — no WhatsApp copia-se a mensagem inteira", () => {
    const [resumo, linha, ...resto] = mensagensDaFatura(FATURA);
    expect(resto).toEqual([]);
    expect(linha).toBe(FATURA.linhaDigitavel);
    expect(resumo).not.toContain(FATURA.linhaDigitavel);
  });

  it("o resumo traz valor em reais, vencimento em dd/mm/aaaa, o atraso e o link", () => {
    const [resumo] = mensagensDaFatura(FATURA);
    expect(resumo).toContain("R$ 129,90");
    expect(resumo).toContain("10/09/2026");
    expect(resumo).toContain("vencida há 9 dias");
    expect(resumo).toContain(FATURA.link);
  });

  it("fatura a vencer não fala em atraso; 1 dia é singular", () => {
    expect(mensagensDaFatura({ ...FATURA, situacao: "a_vencer", diasDeAtraso: 0 })[0]).not.toContain("vencida");
    expect(mensagensDaFatura({ ...FATURA, diasDeAtraso: 1 })[0]).toContain("vencida há 1 dia)");
  });

  it("sem linha digitável é UMA mensagem, e ela não promete a segunda", () => {
    const mensagens = mensagensDaFatura({ ...FATURA, linhaDigitavel: "" });
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).not.toContain("próxima mensagem");
  });
});
