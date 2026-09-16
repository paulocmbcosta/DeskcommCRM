import { describe, expect, it } from "vitest";
import { lerAgenda } from "./agenda";

describe("ler agenda sem lançar", () => {
  it("agenda boa volta íntegra e válida", () => {
    const r = lerAgenda({ timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] });
    expect(r.valida).toBe(true);
    expect(r.agenda.windows).toHaveLength(1);
  });
  it("vazio é válido e sem restrição — janela existe para RESTRINGIR", () => {
    expect(lerAgenda({})).toMatchObject({ valida: true });
    expect(lerAgenda(null)).toMatchObject({ valida: true });
  });
  it("fuso que não existe NÃO lança, e vem marcado inválido", () => {
    expect(() => lerAgenda({ timezone: "America/Asunción", windows: [] })).not.toThrow();
    expect(lerAgenda({ timezone: "America/Asunción", windows: [] }).valida).toBe(false);
  });
  it("janela malformada também vem marcada, sem lançar", () => {
    expect(lerAgenda({ timezone: "America/Sao_Paulo", windows: [{ dow: 9, start: "25:00", end: "x" }] }).valida).toBe(false);
  });
});
