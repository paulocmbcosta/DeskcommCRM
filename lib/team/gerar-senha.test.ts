import { describe, expect, it } from "vitest";

import { ALFABETO_DA_SENHA, gerarSenha } from "./gerar-senha";

describe("gerarSenha", () => {
  it("passa na régua do cadastro (8 a 72) e usa só o alfabeto sem caracteres ambíguos", () => {
    for (let i = 0; i < 200; i++) {
      const senha = gerarSenha();
      expect(senha.length).toBeGreaterThanOrEqual(8);
      expect(senha.length).toBeLessThanOrEqual(72);
      for (const c of senha.replaceAll("-", "")) expect(ALFABETO_DA_SENHA).toContain(c);
    }
    // Quem dita a senha por telefone não pode confundir 0/O nem 1/l/I.
    expect(ALFABETO_DA_SENHA).not.toMatch(/[0O1lI]/);
  });

  it("não se repete — é aleatória de verdade, não um padrão", () => {
    const vistas = new Set(Array.from({ length: 500 }, () => gerarSenha()));
    expect(vistas.size).toBe(500);
  });
});
