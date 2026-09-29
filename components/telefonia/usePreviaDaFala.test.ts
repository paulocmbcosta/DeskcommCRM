/**
 * As duas regras puras da prévia na tela — as mesmas nas falas gerais, no editor
 * de menu e na janela do aviso de instabilidade:
 *  - `falaParaSalvar`: o que o "Salvar" manda. A prévia vale só para o texto EXATO
 *    que a gerou; sem ela, só a fala em uso (pronta) com o mesmo texto;
 *  - `mensagemDaFalhaDaPrevia`: a frase da rota (já traduzida), ou a do
 *    vocabulário pelo código, e nunca o código cru.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalaPublica } from "@/lib/telefonia/vocabulario";

import { falaParaSalvar, mensagemDaFalhaDaPrevia, type PreviaDaFala } from "./usePreviaDaFala";

const previa: PreviaDaFala = {
  texto: "Olá.",
  hash: "a".repeat(64),
  duracao_ms: 900,
  reaproveitada: false,
  audio: new Uint8Array([0xff]),
};

const emUso: FalaPublica = {
  id: "f1",
  tipo: "waiting",
  texto: "Aguarde.",
  voice_id: "v1",
  hash: "b".repeat(64),
  status: "ready",
  erro: null,
  duracao_ms: 800,
  atualizada_em: "2026-09-29T10:00:00.000Z",
};

const t = (texto: string) => `[${texto}]`;

describe("falaParaSalvar", () => {
  it("a prévia do texto do campo (com as pontas aparadas) vai com o hash dela", () => {
    expect(falaParaSalvar("  Olá.  ", emUso, previa)).toEqual({ texto: "Olá.", hash: previa.hash });
  });

  it("texto diferente do da prévia: nada a salvar", () => {
    expect(falaParaSalvar("Olá!", null, previa)).toBeNull();
  });

  it("sem prévia, o texto da fala em uso manda o hash dela; a fala que falhou não conta", () => {
    expect(falaParaSalvar("Aguarde.", emUso, null)).toEqual({ texto: "Aguarde.", hash: emUso.hash });
    expect(falaParaSalvar("Aguarde.", { ...emUso, status: "failed" }, null)).toBeNull();
  });

  it("campo vazio: nada a salvar", () => {
    expect(falaParaSalvar("   ", emUso, previa)).toBeNull();
  });
});

describe("mensagemDaFalhaDaPrevia", () => {
  it("sem erro, sem mensagem", () => {
    expect(mensagemDaFalhaDaPrevia(null, t)).toBeNull();
  });

  it("a frase da rota vence", () => {
    const e = new ApiError(429, "limite_de_previas", undefined, "r", "Frase da rota.");
    expect(mensagemDaFalhaDaPrevia(e, t)).toBe("[Frase da rota.]");
  });

  it("sem frase, um código conhecido vira a frase do vocabulário, nunca o código", () => {
    const e = new ApiError(422, "chave_invalida", undefined, "r");
    expect(mensagemDaFalhaDaPrevia(e, t)).toBe(`[${MENSAGEM_DA_FALHA_DA_FALA.chave_invalida}]`);
  });

  it("código desconhecido, ou erro que não é da API: a frase genérica", () => {
    expect(mensagemDaFalhaDaPrevia(new ApiError(500, "internal_error", undefined, "r"), t)).toBe(
      "[Não foi possível gerar a prévia. Tente de novo em instantes.]",
    );
    expect(mensagemDaFalhaDaPrevia(new Error("rede"), t)).toBe(
      "[Não foi possível gerar a prévia. Tente de novo em instantes.]",
    );
  });
});
