import { describe, expect, it } from "vitest";

import { custoEmCentavos, perguntarAoJev } from "@/lib/classificador-comercial/jev";
import { MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

const ESTADO = { conversa: [{ quem: "cliente" as const, texto: "quero mudar meu plano" }] };

/** O formato da doc da TypeSafe. A Task 3 troca isto pela resposta REAL medida. */
const RESPOSTA_DOCUMENTADA = {
  model: "jev-1.13.0",
  answers: {
    comercial: { type: "noul", noul: 0.93 },
    assunto: {
      type: "choice",
      choice: "mudanca_de_plano",
      confidence: 0.81,
      probabilities: { mudanca_de_plano: 0.88, suporte: 0.05 },
    },
  },
  usage: { input_tokens: 812, output_tokens: 40 },
};

function fetchQueDevolve(status: number, corpo: unknown) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

describe("perguntarAoJev", () => {
  it("manda state + questions para /systemone da OpenRouter, com a chave no header", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({ apiKey: "sk-or-teste", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-teste");
    const corpo = JSON.parse(String(chamadas[0]!.init.body)) as Record<string, unknown>;
    expect(corpo.model).toBe("typesafe/jev-1.13");
    expect(corpo.state).toEqual(ESTADO);
    expect(Object.keys(corpo.questions as object).sort()).toEqual(["assunto", "comercial"]);
  });

  it("traduz a resposta para o que o produto usa", async () => {
    const { f } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok && r.resposta).toEqual({
      comercial: 0.93,
      assunto: "mudanca_de_plano",
      confiancaDoAssunto: 0.81,
      modelo: "jev-1.13.0",
      tokensDeEntrada: 812,
    });
  });

  it.each([401, 402, 403])("%i é problema de conta — tentar de novo não resolve", async (status) => {
    const { f } = fetchQueDevolve(status, { error: { message: "Insufficient credits" } });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "conta", status });
  });

  it.each([408, 429, 500, 502, 529])("%i é temporário", async (status) => {
    const { f } = fetchQueDevolve(status, "sobrecarregado");
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status });
  });

  it("400 é contrato — o pedido está errado, não o serviço", async () => {
    const { f } = fetchQueDevolve(400, { error: "questions inválidas" });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
  });

  it("rede caída ou tempo esgotado é temporário, e nunca lança", async () => {
    const f = (async () => {
      throw new DOMException("tempo esgotado", "TimeoutError");
    }) as unknown as typeof fetch;
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status: null, detalhe: "TimeoutError" });
  });

  it("200 com corpo fora do formato é contrato, e nunca lança", async () => {
    const { f } = fetchQueDevolve(200, { answers: {} });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
  });

  it("base configurável, sem barra dupla", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f, baseUrl: "http://127.0.0.1:3998/" });
    expect(chamadas[0]!.url).toBe("http://127.0.0.1:3998/systemone");
  });
});

describe("custoEmCentavos", () => {
  it("US$ 0,042 por milhão de tokens de entrada = 4,2 centavos por milhão", () => {
    expect(custoEmCentavos(1_000_000)).toBeCloseTo(4.2, 10);
    expect(custoEmCentavos(2_000)).toBeCloseTo(0.0084, 10);
    expect(custoEmCentavos(0)).toBe(0);
  });
});
