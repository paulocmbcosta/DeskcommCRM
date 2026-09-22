// tests/unit/classificador-comercial-perguntas.test.ts
import { describe, expect, it } from "vitest";

import {
  ASSUNTOS,
  ASSUNTOS_COMERCIAIS,
  decidir,
  LIMITE_DE_CARACTERES_POR_MENSAGEM,
  LIMITE_DE_MENSAGENS,
  MODELO_DO_JEV,
  montarEstado,
  PERGUNTAS,
  ROTULO_DO_ASSUNTO,
} from "@/lib/classificador-comercial/perguntas";

describe("montarEstado", () => {
  it("rotula quem falou e mantém a ordem da conversa", () => {
    const estado = montarEstado([
      { direcao: "inbound", texto: "boa tarde" },
      { direcao: "outbound", texto: "Olá! Como posso ajudar?" },
      { direcao: "inbound", texto: "quero aumentar minha internet" },
    ]);
    expect(estado).toEqual({
      conversa: [
        { quem: "cliente", texto: "boa tarde" },
        { quem: "atendente", texto: "Olá! Como posso ajudar?" },
        { quem: "cliente", texto: "quero aumentar minha internet" },
      ],
    });
  });

  it("guarda só as últimas mensagens e corta as longas", () => {
    const muitas = Array.from({ length: 30 }, (_, i) => ({
      direcao: "inbound" as const,
      texto: `mensagem ${i} ${"x".repeat(900)}`,
    }));
    const estado = montarEstado(muitas)!;
    expect(estado.conversa).toHaveLength(LIMITE_DE_MENSAGENS);
    expect(estado.conversa[0]!.texto.startsWith("mensagem 18 ")).toBe(true);
    expect(estado.conversa.every((m) => m.texto.length <= LIMITE_DE_CARACTERES_POR_MENSAGEM)).toBe(true);
  });

  it("ignora mensagem sem texto (mídia ainda sem transcrição)", () => {
    const estado = montarEstado([
      { direcao: "inbound", texto: null },
      { direcao: "inbound", texto: "   " },
      { direcao: "inbound", texto: "tem plano de 1 giga?" },
    ]);
    expect(estado?.conversa).toEqual([{ quem: "cliente", texto: "tem plano de 1 giga?" }]);
  });

  it("sem nenhuma fala do cliente não há o que classificar", () => {
    expect(montarEstado([{ direcao: "outbound", texto: "Promoção de setembro!" }])).toBeNull();
    expect(montarEstado([])).toBeNull();
  });

  it("filtra as vazias ANTES de cortar para as últimas — 12 falas reais sobrevivem a 5 vazias no fim", () => {
    const reais = Array.from({ length: LIMITE_DE_MENSAGENS }, (_, i) => ({
      direcao: "inbound" as const,
      texto: `fala real ${i}`,
    }));
    const vazias = Array.from({ length: 5 }, () => ({ direcao: "inbound" as const, texto: null }));
    const estado = montarEstado([...reais, ...vazias])!;
    expect(estado.conversa).toHaveLength(LIMITE_DE_MENSAGENS);
    expect(estado.conversa.map((m) => m.texto)).toEqual(reais.map((m) => m.texto));
  });

  it("corta por code point — não parte um emoji ao meio num surrogate solto", () => {
    const estado = montarEstado([{ direcao: "inbound", texto: "a".repeat(499) + "😀" }])!;
    expect(estado.conversa[0]!.texto).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(estado.conversa[0]!.texto).toBe("a".repeat(499) + "😀");
  });
});

describe("PERGUNTAS", () => {
  it("uma noul para a decisão e uma choice para o motivo, e nada mais", () => {
    expect(PERGUNTAS.comercial.type).toBe("noul");
    expect(PERGUNTAS.assunto.type).toBe("choice");
    expect(Object.keys(PERGUNTAS.assunto.criteria)).toEqual(Object.keys(ASSUNTOS));
    expect(Object.keys(PERGUNTAS).sort()).toEqual(["assunto", "comercial"]);
  });

  it("o modelo é uma versão FIXA, nunca o alias que muda sozinho", () => {
    expect(MODELO_DO_JEV).toBe("typesafe/jev-1.13");
    expect(MODELO_DO_JEV).not.toContain("latest");
  });

  it("cancelamento, suporte e financeiro não são comerciais (decisão C)", () => {
    expect([...ASSUNTOS_COMERCIAIS].sort()).toEqual(["conhecer_planos", "contratacao", "mudanca_de_plano"]);
  });

  it("todo assunto tem rótulo legível para a linha do tempo", () => {
    for (const a of Object.keys(ASSUNTOS)) expect(ROTULO_DO_ASSUNTO[a as keyof typeof ASSUNTOS]).toBeTruthy();
  });
});

describe("decidir", () => {
  const base = { assunto: "mudanca_de_plano", confiancaDoAssunto: 0.8, modelo: "jev-1.13.0", tokensDeEntrada: 500 };

  it("cria quando a probabilidade alcança o limiar", () => {
    expect(decidir({ ...base, comercial: 0.7 }, 0.7)).toEqual({ criar: true, assunto: "mudanca_de_plano", probabilidade: 0.7 });
  });

  it("não cria abaixo do limiar", () => {
    expect(decidir({ ...base, comercial: 0.69 }, 0.7).criar).toBe(false);
  });

  it("assunto fora da lista vira 'outro' — nunca um rótulo inventado", () => {
    expect(decidir({ ...base, comercial: 0.9, assunto: "vendas" }, 0.7).assunto).toBe("outro");
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "assunto herdado de Object.prototype (%s) vira 'outro'",
    (assunto) => {
      expect(decidir({ ...base, comercial: 0.9, assunto }, 0.7).assunto).toBe("outro");
    },
  );
});
