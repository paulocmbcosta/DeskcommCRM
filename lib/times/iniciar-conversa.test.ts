import { describe, expect, it } from "vitest";

import { timesParaIniciarConversa } from "./iniciar-conversa";

const suporte = { id: "suporte", archived_at: null, user_ids: ["ana"] };
const financeiro = { id: "financeiro", archived_at: null, user_ids: ["bia"] };
const antigo = { id: "antigo", archived_at: "2026-09-01T00:00:00Z", user_ids: ["ana"] };
const times = [suporte, financeiro, antigo];

const ids = (lista: Array<{ id: string }>) => lista.map((t) => t.id);

describe("timesParaIniciarConversa", () => {
  it("atendente que é de um time só escolhe os times dele", () => {
    expect(ids(timesParaIniciarConversa(times, "ana", "agent"))).toEqual(["suporte"]);
  });

  it("atendente sem time nenhum escolhe entre todos os ativos, para não ficar travado", () => {
    expect(ids(timesParaIniciarConversa(times, "caio", "agent"))).toEqual(["suporte", "financeiro"]);
  });

  it("gestor e admin escolhem qualquer time ativo", () => {
    expect(ids(timesParaIniciarConversa(times, "ana", "manager"))).toEqual(["suporte", "financeiro"]);
    expect(ids(timesParaIniciarConversa(times, "ana", "admin"))).toEqual(["suporte", "financeiro"]);
  });

  it("time arquivado nunca é oferecido, nem ao membro dele", () => {
    const soArquivado = [antigo];
    expect(timesParaIniciarConversa(soArquivado, "ana", "agent")).toEqual([]);
  });

  it("organização sem time nenhum devolve lista vazia (não há o que escolher)", () => {
    expect(timesParaIniciarConversa([], "ana", "agent")).toEqual([]);
  });
});
