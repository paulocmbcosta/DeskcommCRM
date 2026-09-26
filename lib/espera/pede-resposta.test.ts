import { describe, expect, it } from "vitest";

import {
  decidirDispensa,
  LIMIAR_PARA_DISPENSAR,
  lerRespostaDaEspera,
  montarEstadoDaEspera,
  PERGUNTAS_DA_ESPERA,
} from "./pede-resposta";

const m = (direcao: "inbound" | "outbound", texto: string | null) => ({ direcao, texto });

describe("montarEstadoDaEspera", () => {
  it("separa as falas do cliente ainda sem resposta do histórico", () => {
    const e = montarEstadoDaEspera([
      m("inbound", "minha internet caiu"),
      m("outbound", "assim que eu agendar um horário eu te chamo"),
      m("inbound", "ok"),
      m("inbound", "obrigado"),
    ]);
    expect(e).toEqual({
      conversa: [
        { quem: "cliente", texto: "minha internet caiu" },
        { quem: "atendente", texto: "assim que eu agendar um horário eu te chamo" },
      ],
      sem_resposta: ["ok", "obrigado"],
    });
  });

  it("null quando a última fala não é do cliente", () => {
    expect(montarEstadoDaEspera([m("inbound", "oi"), m("outbound", "olá")])).toBeNull();
  });

  it("null quando alguma fala sem resposta não tem texto (mídia sem transcrição): conta", () => {
    expect(montarEstadoDaEspera([m("outbound", "te chamo"), m("inbound", null)])).toBeNull();
  });

  it("corta o histórico nas últimas 10 falas", () => {
    const hist = Array.from({ length: 30 }, (_, i) => m(i % 2 ? "outbound" : "inbound", `f${i}`));
    const e = montarEstadoDaEspera([...hist, m("outbound", "fim"), m("inbound", "ok")]);
    expect(e?.conversa).toHaveLength(10);
    expect(e?.conversa.at(-1)).toEqual({ quem: "atendente", texto: "fim" });
  });
});

describe("decidirDispensa", () => {
  it("só dispensa com probabilidade de pedir resposta ≤ limiar", () => {
    expect(LIMIAR_PARA_DISPENSAR).toBe(0.15);
    expect(decidirDispensa(0.1)).toBe(true);
    expect(decidirDispensa(0.15)).toBe(true);
    expect(decidirDispensa(0.16)).toBe(false);
    expect(decidirDispensa(0.5)).toBe(false);
  });
});

describe("lerRespostaDaEspera", () => {
  it("lê noul, modelo e custo", () => {
    const r = lerRespostaDaEspera(
      { model: "typesafe/jev-1.13-x", answers: { pede_resposta: { noul: 0.08 } }, usage: { input_tokens: 100, cost: 0.00001 } },
      "typesafe/jev-1.13",
    );
    expect(r).toEqual({ ok: true, leitura: { pedeResposta: 0.08, modelo: "typesafe/jev-1.13-x", tokensDeEntrada: 100, custoEmCentavos: 0.001 } });
  });

  it("formato errado vira falha de contrato, nunca lança", () => {
    const r = lerRespostaDaEspera({ answers: {} }, "typesafe/jev-1.13");
    expect(r.ok).toBe(false);
  });

  it("a pergunta é noul e cita as falas sem resposta", () => {
    expect(PERGUNTAS_DA_ESPERA.pede_resposta.type).toBe("noul");
    expect(PERGUNTAS_DA_ESPERA.pede_resposta.instructions).toContain("`sem_resposta`");
  });
});
