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
  it("manda state + questions para /systemone da OpenRouter, com a chave no header, por POST e JSON", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({ apiKey: "sk-or-teste", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(chamadas[0]!.init.method).toBe("POST");
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-teste");
    expect(headers["Content-Type"]).toBe("application/json");
    const corpo = JSON.parse(String(chamadas[0]!.init.body)) as Record<string, unknown>;
    expect(corpo.model).toBe("typesafe/jev-1.13");
    expect(corpo.state).toEqual(ESTADO);
    expect(Object.keys(corpo.questions as object).sort()).toEqual(["assunto", "comercial"]);
  });

  it("cabeçalhos extras não sobrescrevem Authorization nem Content-Type", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({
      apiKey: "sk-or-teste",
      estado: ESTADO,
      modelo: MODELO_DO_JEV,
      fetchImpl: f,
      cabecalhosExtras: { Authorization: "Bearer lixo", "Content-Type": "text/plain", "X-Extra": "1" },
    });
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-teste");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Extra"]).toBe("1");
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

  it("resposta sem usage, model ou assunto ainda é OK — só a decisão (`comercial`) é obrigatória", async () => {
    const { f } = fetchQueDevolve(200, { answers: { comercial: { type: "noul", noul: 0.5 } } });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok && r.resposta).toEqual({
      comercial: 0.5,
      assunto: null,
      confiancaDoAssunto: null,
      modelo: MODELO_DO_JEV,
      tokensDeEntrada: null,
    });
  });

  it("assunto com choice ausente (campo que só EXPLICA, malformado) não veta a decisão", async () => {
    const { f } = fetchQueDevolve(200, {
      answers: { comercial: { type: "noul", noul: 0.8 }, assunto: { type: "choice", confidence: 0.5 } },
    });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok && r.resposta.comercial).toBe(0.8);
    expect(r.ok && r.resposta.assunto).toBeNull();
  });

  it("confidence do assunto fora de [0,1] (campo que só EXPLICA) não veta a decisão", async () => {
    const { f } = fetchQueDevolve(200, {
      answers: {
        comercial: { type: "noul", noul: 0.8 },
        assunto: { type: "choice", choice: "suporte", confidence: 5 },
      },
    });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok && r.resposta.comercial).toBe(0.8);
    expect(r.ok && r.resposta.assunto).toBeNull();
  });

  it("noul fora de [0,1] é contrato — a decisão em si não pode ser inválida", async () => {
    const { f } = fetchQueDevolve(200, { answers: { comercial: { type: "noul", noul: 1.5 } } });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
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

  it("corpo que falha ao LER depois de um 200 é temporário, não contrato — o parse nunca chega a rodar", async () => {
    const f = (async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new DOMException("t", "TimeoutError");
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status: 200, detalhe: "TimeoutError" });
  });

  it("corpo que não é JSON depois de um 200 é contrato", async () => {
    const { f } = fetchQueDevolve(200, "isto não é json {{{");
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "contrato", status: 200 });
  });

  it("200 com corpo fora do formato é contrato, e o detalhe cita os CAMINHOS do Zod — nunca os valores", async () => {
    const { f } = fetchQueDevolve(200, { answers: {} });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
    expect(!r.ok && r.falha.detalhe).toContain("answers.comercial");
  });

  it("detalhe nunca carrega a chave, mesmo se o provedor ecoar ela de volta no corpo do erro", async () => {
    const chave = "sk-or-v1-abcdef0123456789";
    const { f } = fetchQueDevolve(401, `Incorrect API key provided: Bearer ${chave}`);
    const r = await perguntarAoJev({ apiKey: chave, estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.detalhe).not.toContain(chave);
  });

  it("detalhe nunca carrega a chave mesmo quando o provedor a ecoa num formato que os padrões conhecidos não cobrem", async () => {
    const chave = "minhachave12345";
    const { f } = fetchQueDevolve(401, `chave usada: ${chave}`);
    const r = await perguntarAoJev({ apiKey: chave, estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.detalhe).not.toContain(chave);
  });

  it("chave malformada (espaço, caractere invisível) é problema de conta ANTES do fetch — sem retentativa inútil", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    const r = await perguntarAoJev({ apiKey: "sk-or-​x", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("conta");
    expect(chamadas).toHaveLength(0);
  });

  it("o tempo-limite está de fato ligado ao fetch: o sinal abortando é a única forma de rejeitar", async () => {
    const f = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error));
      })) as unknown as typeof fetch;
    const r = await perguntarAoJev({
      apiKey: "k",
      estado: ESTADO,
      modelo: MODELO_DO_JEV,
      fetchImpl: f,
      tempoLimiteMs: 20,
    });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status: null, detalhe: "TimeoutError" });
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

  it("tokens desconhecidos é null, nunca 0 — 0 é 'grátis', null é 'não sei' (mesma régua de llm_calls.cost_cents)", () => {
    expect(custoEmCentavos(null)).toBeNull();
  });
});
