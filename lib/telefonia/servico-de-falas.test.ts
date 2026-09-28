// @vitest-environment node
/**
 * A COTA DE PRÉVIAS (desenho §4: 30 por hora por organização) medida no contador
 * DE VERDADE — o `checkRateLimit` do CRM no caminho sem Upstash, que é o contador
 * em memória dele. Nada de limitador falso: um mock que só conferisse a chave
 * passaria com o limite errado, com a janela errada ou com a cota compartilhada
 * entre organizações.
 *
 * Isolamento: `vi.resetModules()` antes de cada caso recarrega o limitador, e o
 * mapa em memória dele nasce vazio. O relógio é fixo (`Date` falso): a janela é
 * fixa e alinhada à hora, e um caso que atravessasse a virada mediria outra coisa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloEnv from "@/lib/env";

import type * as ModuloPrevia from "./previa";
import type * as ModuloServico from "./servico-de-falas";

// O caminho SEM Upstash: sem as duas variáveis, `checkRateLimit` conta em memória.
vi.mock("@/lib/env", async () => {
  const real = await vi.importActual<typeof ModuloEnv>("@/lib/env");
  return { ...real, env: { ...real.env, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined } };
});
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA = "00000000-0000-4000-8000-0000000000b2";
const VOZ = { voiceId: "v1", modelId: "eleven_multilingual_v2" };

let servico: typeof ModuloServico;
let previa: typeof ModuloPrevia;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T13:40:00Z"));
  vi.resetModules();
  servico = await import("./servico-de-falas");
  previa = await import("./previa");
});

afterEach(() => {
  vi.useRealTimers();
});

/** Um Storage em memória por organização — `enviar` grava, então a mesma fala depois é reaproveitada. */
function armazemEmMemoria() {
  const objetos = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    baixar: async (c: string) => objetos.get(c) ?? null,
    enviar: async (c: string, b: Uint8Array) => {
      objetos.set(c, new Uint8Array(b));
      return "gravado" as const;
    },
  };
}

/** A prévia de verdade (`gerarPrevia`), com a cota de verdade e uma síntese falsa que conta. */
function gerador(organizationId: string) {
  const armazem = armazemEmMemoria();
  const sintetizadas: string[] = [];
  const gerar = (texto: string) =>
    previa.gerarPrevia({
      armazem,
      sintetizar: async (p) => {
        sintetizadas.push(p.texto);
        return new Uint8Array(800);
      },
      consumirCota: async () => (await servico.consumirCotaDePrevia(organizationId)).permitida,
      organizationId,
      texto,
      chave: "sk_ficticia",
      voz: VOZ,
    });
  return { gerar, sintetizadas };
}

describe("a cota de prévias da organização, no contador de verdade", () => {
  it("a 30ª prévia passa; a 31ª é recusada com limite_de_previas SEM ir à ElevenLabs; outra organização continua livre", async () => {
    const a = gerador(ORG);
    for (let n = 1; n <= 30; n++) {
      expect(await a.gerar(`Fala número ${n}.`), `prévia ${n}`).toMatchObject({ ok: true, reaproveitada: false });
    }
    expect(a.sintetizadas).toHaveLength(30);

    expect(await a.gerar("Fala número 31.")).toEqual({ ok: false, motivo: "limite_de_previas" });
    expect(a.sintetizadas).toHaveLength(30);

    // Reaproveitar não gasta cota: a fala já guardada sai mesmo com a cota esgotada.
    expect(await a.gerar("Fala número 1.")).toMatchObject({ ok: true, reaproveitada: true });

    const b = gerador(OUTRA);
    expect(await b.gerar("Fala número 1.")).toMatchObject({ ok: true, reaproveitada: false });
    expect(b.sintetizadas).toHaveLength(1);
  });

  it("isolado entre casos: o contador recomeça do zero (restam 29 depois da primeira)", async () => {
    expect(await servico.consumirCotaDePrevia(ORG)).toEqual({ permitida: true, limite: 30, restantes: 29, reabreEmS: 1200 });
  });

  it("a 30ª não deixa nenhuma restante e a 31ª é recusada, com o tempo até a janela virar", async () => {
    for (let n = 1; n < 30; n++) await servico.consumirCotaDePrevia(ORG);
    expect(await servico.consumirCotaDePrevia(ORG)).toMatchObject({ permitida: true, restantes: 0 });
    vi.setSystemTime(new Date("2026-09-28T13:59:30Z"));
    expect(await servico.consumirCotaDePrevia(ORG)).toEqual({ permitida: false, limite: 30, restantes: 0, reabreEmS: 30 });
    expect(await servico.consumirCotaDePrevia(OUTRA)).toMatchObject({ permitida: true, restantes: 29 });
  });

  it("a janela é FIXA e alinhada à hora: na virada, a cota volta inteira — e a espera nunca é zero", async () => {
    for (let n = 1; n <= 31; n++) await servico.consumirCotaDePrevia(ORG);
    vi.setSystemTime(new Date("2026-09-28T14:00:00Z"));
    expect(await servico.consumirCotaDePrevia(ORG)).toEqual({ permitida: true, limite: 30, restantes: 29, reabreEmS: 3600 });
  });

  it("a cota estourada é limite NOSSO: 429 (doutrina da API), e não os 422/502 das falhas da ElevenLabs", () => {
    expect(servico.LIMITE_DE_PREVIAS_POR_HORA).toBe(30);
    expect(servico.STATUS_DA_FALHA.limite_de_previas).toBe(429);
    expect(servico.STATUS_DA_FALHA.limite_de_uso).toBe(422);
  });
});
