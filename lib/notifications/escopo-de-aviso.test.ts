import { describe, expect, it } from "vitest";

import { escopoEfetivo, mensagemMereceAviso } from "./escopo-de-aviso";

describe("escopo do aviso de mensagem", () => {
  it("sem escolha gravada, atendente recebe só as suas; os demais, tudo que veem", () => {
    expect(escopoEfetivo("agent", null)).toBe("mine");
    expect(escopoEfetivo("manager", null)).toBe("all_visible");
    expect(escopoEfetivo("admin", undefined)).toBe("all_visible");
    expect(escopoEfetivo("viewer", null)).toBe("all_visible");
  });

  it("a escolha gravada vale acima do papel, nos dois sentidos", () => {
    expect(escopoEfetivo("agent", "all_visible")).toBe("all_visible");
    expect(escopoEfetivo("admin", "mine")).toBe("mine");
  });

  it("valor desconhecido cai no padrão do papel, e não em 'tudo'", () => {
    expect(escopoEfetivo("agent", "tudo")).toBe("mine");
  });

  it("'só as minhas' não avisa da fila nem da conversa do colega", () => {
    expect(mensagemMereceAviso("mine", { assignedTo: "eu", userId: "eu" })).toBe(true);
    expect(mensagemMereceAviso("mine", { assignedTo: null, userId: "eu" })).toBe(false);
    expect(mensagemMereceAviso("mine", { assignedTo: "colega", userId: "eu" })).toBe(false);
  });

  it("'todas que vejo' avisa de tudo que chegou (a RLS já filtrou)", () => {
    expect(mensagemMereceAviso("all_visible", { assignedTo: null, userId: "eu" })).toBe(true);
    expect(mensagemMereceAviso("all_visible", { assignedTo: "colega", userId: "eu" })).toBe(true);
  });
});
