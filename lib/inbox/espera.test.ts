import { describe, expect, it } from "vitest";

import { ESPERA_ATENCAO_MS, ESPERA_CRITICA_MS, esperaDaConversa, formatarEspera } from "./espera";

const agora = new Date("2026-09-18T15:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("há espera quando a última palavra foi do cliente", () => {
  it("cliente escreveu e ninguém respondeu: espera desde a mensagem dele", () => {
    const e = esperaDaConversa({ status: "open", last_inbound_at: ha(5 * 60_000), last_outbound_at: null }, agora);
    expect(e?.ms).toBe(5 * 60_000);
    expect(e?.nivel).toBe("normal");
  });

  it("a empresa respondeu DEPOIS: quem deve o próximo passo é o cliente — sem cobrança", () => {
    expect(
      esperaDaConversa({ status: "claimed", last_inbound_at: ha(60 * 60_000), last_outbound_at: ha(10 * 60_000) }, agora),
    ).toBeNull();
  });

  it("o cliente escreveu DEPOIS da última resposta: a espera volta a contar", () => {
    const e = esperaDaConversa(
      { status: "claimed", last_inbound_at: ha(10 * 60_000), last_outbound_at: ha(60 * 60_000) },
      agora,
    );
    expect(e?.ms).toBe(10 * 60_000);
  });

  it.each(["closed", "resolved", "archived"])("atendimento %s não espera ninguém", (status) => {
    expect(esperaDaConversa({ status, last_inbound_at: ha(60_000), last_outbound_at: null }, agora)).toBeNull();
  });

  it("sem entrada nenhuma (conversa iniciada pela empresa) não há o que esperar", () => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: null, last_outbound_at: ha(60_000) }, agora)).toBeNull();
  });

  it("carimbo ilegível não derruba o card", () => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: "ontem", last_outbound_at: null }, agora)).toBeNull();
  });
});

describe("a cor sobe em dois degraus", () => {
  it.each([
    [ESPERA_ATENCAO_MS - 1, "normal"],
    [ESPERA_ATENCAO_MS, "atencao"],
    [ESPERA_CRITICA_MS - 1, "atencao"],
    [ESPERA_CRITICA_MS, "critico"],
  ])("%d ms → %s", (ms, nivel) => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: ha(ms), last_outbound_at: null }, agora)?.nivel).toBe(nivel);
  });
});

describe("o tempo por extenso", () => {
  it.each([
    [20_000, "menos de 1 min"],
    [12 * 60_000, "12 min"],
    [60 * 60_000, "1h"],
    [(3 * 60 + 51) * 60_000, "3h 51min"],
    [24 * 60 * 60_000, "1d"],
    [(2 * 24 + 4) * 60 * 60_000, "2d 4h"],
  ])("%d ms → %s", (ms, esperado) => {
    expect(formatarEspera(ms)).toBe(esperado);
  });
});
