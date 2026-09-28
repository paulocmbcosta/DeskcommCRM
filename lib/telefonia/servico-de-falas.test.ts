// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ contagem: 1 }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (_bucket: string, limit: number, windowSec: number) => ({
    allowed: estado.contagem <= limit,
    count: estado.contagem,
    limit,
    window_sec: windowSec,
  })),
}));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

import { LIMITE_DE_PREVIAS_POR_HORA, STATUS_DA_FALHA, consumirCotaDePrevia } from "./servico-de-falas";

beforeEach(() => {
  estado.contagem = 1;
  vi.mocked(checkRateLimit).mockClear();
});

describe("a cota de prévias da organização (desenho §4: 30 por hora)", () => {
  it("conta por organização, no limitador do CRM, com teto de 30 numa janela de uma hora", async () => {
    const c = await consumirCotaDePrevia("org-1", new Date("2026-09-28T13:40:00Z"));
    expect(checkRateLimit).toHaveBeenCalledWith("telefonia-previa:org-1", 30, 3600);
    expect(LIMITE_DE_PREVIAS_POR_HORA).toBe(30);
    expect(c).toEqual({ permitida: true, limite: 30, restantes: 29, reabreEmS: 1200 });
  });

  it("a 30ª ainda passa, sem nenhuma restante", async () => {
    estado.contagem = 30;
    expect(await consumirCotaDePrevia("org-1", new Date("2026-09-28T13:40:00Z"))).toMatchObject({
      permitida: true,
      restantes: 0,
    });
  });

  it("a 31ª da hora é recusada, com o tempo até a janela virar", async () => {
    estado.contagem = 31;
    expect(await consumirCotaDePrevia("org-1", new Date("2026-09-28T13:59:30Z"))).toEqual({
      permitida: false,
      limite: 30,
      restantes: 0,
      reabreEmS: 30,
    });
  });

  it("na virada exata da hora, a espera é a janela inteira — nunca zero (Retry-After: 0 não diz nada)", async () => {
    estado.contagem = 31;
    expect((await consumirCotaDePrevia("org-1", new Date("2026-09-28T14:00:00Z"))).reabreEmS).toBe(3600);
  });

  it("a cota estourada é limite NOSSO: 429 (doutrina da API), e não os 422/502 das falhas da ElevenLabs", () => {
    expect(STATUS_DA_FALHA.limite_de_previas).toBe(429);
    expect(STATUS_DA_FALHA.limite_de_uso).toBe(422);
  });
});
