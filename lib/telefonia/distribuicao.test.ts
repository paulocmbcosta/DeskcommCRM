import { describe, expect, it } from "vitest";

import { ESTADO_INICIAL, ordemDeToque, proximoToque, type CandidatoAoToque } from "./distribuicao";

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
