import { describe, expect, it } from "vitest";

import { alvoDoDiscador } from "./discador";

describe("o que o discador entende", () => {
  it.each([
    ["", { tipo: "vazio" }],
    ["201", { tipo: "ramal", ramal: "201" }],
    [" 20 ", { tipo: "ramal", ramal: "20" }],
    ["9999", { tipo: "ramal", ramal: "9999" }],
    ["0201", { tipo: "numero" }],
    ["12345", { tipo: "numero" }],
    ["7", { tipo: "numero" }],
    ["(61) 99999-9999", { tipo: "numero" }],
    ["João", { tipo: "nome", busca: "João" }],
    ["bia 2", { tipo: "nome", busca: "bia 2" }],
  ])("%j → %j", (entrada, esperado) => {
    expect(alvoDoDiscador(entrada)).toEqual(esperado);
  });
});
