import { describe, expect, it } from "vitest";

import { slugDoTime } from "./slug";

describe("slug do time", () => {
  it("tira acento, espaço e caixa", () => {
    expect(slugDoTime("Financeiro / Cobrança")).toBe("financeiro-cobranca");
  });
  it("não começa nem termina com hífen", () => {
    expect(slugDoTime("  -- Suporte Técnico -- ")).toBe("suporte-tecnico");
  });
  it("corta em 40 caracteres sem deixar hífen na ponta", () => {
    expect(slugDoTime("a".repeat(60)).length).toBeLessThanOrEqual(40);
  });
  it("nome sem nenhum caractere aproveitável vira vazio, e quem chama decide", () => {
    expect(slugDoTime("!!!")).toBe("");
  });
});
