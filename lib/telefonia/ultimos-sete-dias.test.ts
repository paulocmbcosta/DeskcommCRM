import { describe, expect, it } from "vitest";

import { menuConfunde, somarUltimosSeteDias } from "./ultimos-sete-dias";

describe("últimos 7 dias do menu — o laço de retorno", () => {
  it("soma por tecla, sem escolha, tecla errada e quem desligou no menu", () => {
    expect(
      somarUltimosSeteDias([
        { menu_outcome: "chosen", menu_digit: "1", n: 4 },
        { menu_outcome: "chosen", menu_digit: "2", n: 1 },
        { menu_outcome: "default_no_input", menu_digit: null, n: 3 },
        { menu_outcome: "default_invalid", menu_digit: null, n: 2 },
        { menu_outcome: null, menu_digit: null, n: 5 },
      ]),
    ).toEqual({ total: 15, por_tecla: { "1": 4, "2": 1 }, sem_escolha: 3, tecla_errada: 2, desligou_no_menu: 5 });
  });

  it("nada → zeros", () => {
    expect(somarUltimosSeteDias([])).toEqual({ total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 });
  });

  it("confunde: 5+ ligações e 30%+ caindo no padrão", () => {
    const base = { por_tecla: {}, desligou_no_menu: 0 };
    expect(menuConfunde({ ...base, total: 10, sem_escolha: 2, tecla_errada: 1 })).toBe(true);
    expect(menuConfunde({ ...base, total: 10, sem_escolha: 2, tecla_errada: 0 })).toBe(false);
    expect(menuConfunde({ ...base, total: 4, sem_escolha: 4, tecla_errada: 0 })).toBe(false);
  });
});
