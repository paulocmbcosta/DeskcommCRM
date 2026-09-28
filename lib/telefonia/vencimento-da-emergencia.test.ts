import { describe, expect, it } from "vitest";

import { DURACAO_PADRAO, DURACOES_DA_EMERGENCIA, avisoVigente, expiraEm } from "./vencimento-da-emergencia";

const AGORA = new Date("2026-09-28T13:00:00Z");

describe("vencimento do aviso de instabilidade (D8)", () => {
  it("as durações da tela, com 2 h por padrão", () => {
    expect(DURACOES_DA_EMERGENCIA).toEqual(["1h", "2h", "4h", "indefinida"]);
    expect(DURACAO_PADRAO).toBe("2h");
  });

  it.each([
    ["1h", "2026-09-28T14:00:00.000Z"],
    ["2h", "2026-09-28T15:00:00.000Z"],
    ["4h", "2026-09-28T17:00:00.000Z"],
  ] as const)("%s → vence em %s", (duracao, iso) => {
    expect(expiraEm(duracao, AGORA)?.toISOString()).toBe(iso);
  });

  it("'até eu desligar' não vence", () => {
    expect(expiraEm("indefinida", AGORA)).toBeNull();
  });

  it("vigente: ligado e sem prazo, ou com prazo no futuro; não vigente: desligado ou vencido", () => {
    expect(avisoVigente({ desde: AGORA, expiraEm: null }, AGORA)).toBe(true);
    expect(avisoVigente({ desde: AGORA, expiraEm: "2026-09-28T13:00:01Z" }, AGORA)).toBe(true);
    expect(avisoVigente({ desde: AGORA, expiraEm: "2026-09-28T13:00:00Z" }, AGORA)).toBe(false);
    expect(avisoVigente({ desde: null, expiraEm: null }, AGORA)).toBe(false);
  });
});
