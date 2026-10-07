import { describe, expect, it } from "vitest";

import {
  ESPERA_NA_FILA_MAX_S,
  ESPERA_NA_FILA_MIN_S,
  ESPERA_NA_FILA_MS,
  ESTADO_INICIAL,
  OPCOES_DE_ESPERA_NA_FILA_S,
  eAVezDela,
  esperaMaximaMs,
  ordemDeToque,
  proximoToque,
  type CandidatoAoToque,
} from "./distribuicao";

const c = (userId: string, atendidasHoje: number, ultima: string | null = null): CandidatoAoToque => ({
  userId,
  atendidasHoje,
  ultimaAtendidaEm: ultima ? new Date(ultima) : null,
});

describe("ordemDeToque — menos atendidas hoje primeiro", () => {
  it("quem atendeu menos vem antes", () => {
    expect(ordemDeToque([c("ana", 3), c("bia", 1), c("caio", 2)])).toEqual(["bia", "caio", "ana"]);
  });

  it("empate: quem nunca atendeu, depois quem atendeu há mais tempo", () => {
    expect(
      ordemDeToque([
        c("ana", 1, "2026-09-28T12:00:00Z"),
        c("bia", 1, "2026-09-28T09:00:00Z"),
        c("caio", 1, null),
      ]),
    ).toEqual(["caio", "bia", "ana"]);
  });

  it("não altera a lista de entrada", () => {
    const lista = [c("b", 2), c("a", 1)];
    ordemDeToque(lista);
    expect(lista.map((x) => x.userId)).toEqual(["b", "a"]);
  });
});

describe("proximoToque — um por vez, duas voltas", () => {
  it("toca a lista inteira na primeira volta, depois reabre, depois desiste", () => {
    const todos = [c("ana", 0), c("bia", 1)];
    const tocados: string[] = [];
    let estado = ESTADO_INICIAL;
    for (;;) {
      const p = proximoToque(todos, estado);
      if (p.tipo !== "tocar") {
        expect(p.tipo).toBe("desistir");
        break;
      }
      tocados.push(p.userId);
      estado = p.estado;
    }
    expect(tocados).toEqual(["ana", "bia", "ana", "bia"]);
  });

  it("ninguém disponível é esperar, não desistir", () => {
    expect(proximoToque([], ESTADO_INICIAL)).toEqual({ tipo: "esperar" });
  });

  it("quem ficou indisponível no meio sai; quem chegou entra na volta atual", () => {
    let p = proximoToque([c("ana", 0), c("bia", 1)], ESTADO_INICIAL);
    expect(p.tipo === "tocar" && p.userId).toBe("ana");
    if (p.tipo !== "tocar") throw new Error();
    // bia entrou em pausa; caio voltou da pausa.
    p = proximoToque([c("ana", 0), c("caio", 5)], p.estado);
    expect(p.tipo === "tocar" && p.userId).toBe("caio");
  });

  it("a recontagem entre toques reordena: quem atendeu outra ligação vai para o fim", () => {
    let p = proximoToque([c("ana", 0), c("bia", 0, "2026-09-28T08:00:00Z")], ESTADO_INICIAL);
    expect(p.tipo === "tocar" && p.userId).toBe("ana");
    if (p.tipo !== "tocar") throw new Error();
    p = proximoToque([c("ana", 0), c("bia", 1, "2026-09-28T10:00:00Z")], p.estado);
    expect(p.tipo === "tocar" && p.userId).toBe("bia");
  });
});

describe("a espera máxima na fila, por time (0295)", () => {
  it("sem configuração vale o padrão de sempre", () => {
    expect(esperaMaximaMs(null)).toBe(ESPERA_NA_FILA_MS);
    expect(esperaMaximaMs(undefined)).toBe(ESPERA_NA_FILA_MS);
    expect(esperaMaximaMs(Number.NaN)).toBe(ESPERA_NA_FILA_MS);
  });
  it("o configurado vale em milissegundos, preso aos limites", () => {
    expect(esperaMaximaMs(600)).toBe(600_000);
    expect(esperaMaximaMs(5)).toBe(ESPERA_NA_FILA_MIN_S * 1000);
    expect(esperaMaximaMs(99_999)).toBe(ESPERA_NA_FILA_MAX_S * 1000);
  });
  it("as opções da tela cabem nos limites e começam pelo padrão", () => {
    expect(OPCOES_DE_ESPERA_NA_FILA_S[0] * 1000).toBe(ESPERA_NA_FILA_MS);
    for (const s of OPCOES_DE_ESPERA_NA_FILA_S) {
      expect(s).toBeGreaterThanOrEqual(ESPERA_NA_FILA_MIN_S);
      expect(s).toBeLessThanOrEqual(ESPERA_NA_FILA_MAX_S);
    }
  });
});

describe("a vez na fila: ordem de chegada", () => {
  it("com um atendente livre, só a primeira da fila toca", () => {
    expect(eAVezDela(0, 1)).toBe(true);
    expect(eAVezDela(1, 1)).toBe(false);
  });
  it("com dois livres, as duas primeiras tocam; a terceira espera", () => {
    expect(eAVezDela(0, 2)).toBe(true);
    expect(eAVezDela(1, 2)).toBe(true);
    expect(eAVezDela(2, 2)).toBe(false);
  });
  it("sem ninguém livre, ninguém toca", () => {
    expect(eAVezDela(0, 0)).toBe(false);
  });
});
