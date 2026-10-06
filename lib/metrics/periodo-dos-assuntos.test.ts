import { describe, expect, it } from "vitest";

import { intervaloDoPeriodo } from "./periodo-dos-assuntos";

describe("intervaloDoPeriodo", () => {
  // Meio-dia local: longe da meia-noite, para o caso não depender do fuso de quem roda.
  const agora = new Date(2026, 9, 15, 12, 30, 0);

  it("hoje começa à meia-noite local e termina agora", () => {
    const { from, to } = intervaloDoPeriodo("hoje", agora);
    expect(new Date(from).getTime()).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime());
    expect(to).toBe(agora.toISOString());
  });

  it("este mês começa no dia 1, à meia-noite local", () => {
    expect(new Date(intervaloDoPeriodo("mes", agora).from).getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime());
  });

  it("7 e 30 dias são janelas corridas a partir de agora", () => {
    const dia = 24 * 60 * 60 * 1000;
    expect(agora.getTime() - new Date(intervaloDoPeriodo("7d", agora).from).getTime()).toBe(7 * dia);
    expect(agora.getTime() - new Date(intervaloDoPeriodo("30d", agora).from).getTime()).toBe(30 * dia);
  });

  it("não altera a data recebida", () => {
    const copia = agora.getTime();
    intervaloDoPeriodo("mes", agora);
    expect(agora.getTime()).toBe(copia);
  });
});
