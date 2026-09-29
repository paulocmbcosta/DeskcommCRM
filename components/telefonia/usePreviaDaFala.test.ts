/**
 * A PRÉVIA NA TELA — a mesma nas falas gerais, no editor de menu e na janela do
 * aviso de instabilidade.
 *
 * As regras puras:
 *  - `falaParaSalvar`: o que o "Salvar" manda. A prévia vale só para o texto EXATO
 *    que a gerou; sem ela, só a fala em uso (pronta) com o mesmo texto;
 *  - `mensagemDaFalhaDaPrevia`: a frase que veio do CORPO da resposta, ou a do
 *    vocabulário pelo código, ou a genérica — nunca o código cru, nem a
 *    "mensagem" que o `apiClient` inventa para uma resposta sem corpo (HTML de
 *    proxy, `HTTP 504`).
 *
 * O hook, pelo `apiClient` de verdade sobre um `fetch` simulado:
 *  - `limpar()` no meio da geração: a prévia que chega DEPOIS não aparece (o
 *    efeito mora no `mutate`, não nas opções da mutação, que rodam mesmo depois
 *    do `reset()`);
 *  - a prévia é amarrada à VOZ com que foi pedida: trocada a voz, some (o hash
 *    dela é da voz anterior, e o servidor recusaria);
 *  - a falha vale para o texto que a gerou: `erroPara` de outro texto é `null`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, ApiErrorSemCorpo } from "@/lib/api/types";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalaPublica } from "@/lib/telefonia/vocabulario";

import { falaParaSalvar, mensagemDaFalhaDaPrevia, usePreviaDaFala, type PreviaDaFala } from "./usePreviaDaFala";

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
const GENERICA = "[Não foi possível gerar a prévia. Tente de novo em instantes.]";

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

  it("a frase do corpo da resposta vence", () => {
    const e = new ApiError(429, "limite_de_previas", undefined, "r", "Frase da rota.");
    expect(mensagemDaFalhaDaPrevia(e, t)).toBe("[Frase da rota.]");
  });

  it("sem frase, um código conhecido vira a frase do vocabulário, nunca o código", () => {
    const e = new ApiError(422, "chave_invalida", undefined, "r");
    expect(mensagemDaFalhaDaPrevia(e, t)).toBe(`[${MENSAGEM_DA_FALHA_DA_FALA.chave_invalida}]`);
  });

  it("resposta SEM corpo (o cliente inventou a mensagem): a genérica, nunca 'HTTP 504' nem HTML", () => {
    expect(mensagemDaFalhaDaPrevia(new ApiErrorSemCorpo(504, "internal_error", undefined, "r", "HTTP 504"), t)).toBe(
      GENERICA,
    );
    expect(
      mensagemDaFalhaDaPrevia(new ApiErrorSemCorpo(502, "internal_error", undefined, "r", "<html>Bad Gateway</html>"), t),
    ).toBe(GENERICA);
  });

  it("código desconhecido, ou erro que não é da API: a genérica", () => {
    expect(mensagemDaFalhaDaPrevia(new ApiError(500, "internal_error", undefined, "r"), t)).toBe(GENERICA);
    expect(mensagemDaFalhaDaPrevia(new Error("rede"), t)).toBe(GENERICA);
  });
});

// ─── O hook ──────────────────────────────────────────────────────────────────

const HASH = "c".repeat(64);
const fetchFalso = vi.fn();
const respostaDaPrevia = () =>
  new Response(JSON.stringify({ data: { hash: HASH, duracao_ms: 700, reaproveitada: false, audio_base64: "//8=" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function envoltorio() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  fetchFalso.mockReset();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => vi.unstubAllGlobals());

describe("usePreviaDaFala", () => {
  it("gera a prévia do texto aparado e a devolve com o áudio", async () => {
    fetchFalso.mockResolvedValue(respostaDaPrevia());
    const { result } = renderHook(() => usePreviaDaFala("v1"), { wrapper: envoltorio() });
    act(() => result.current.gerar("  Olá.  "));
    await waitFor(() => expect(result.current.previa).not.toBeNull());
    expect(result.current.previa).toMatchObject({ texto: "Olá.", hash: HASH });
    expect(result.current.previa?.audio).toEqual(new Uint8Array([0xff, 0xff]));
    expect(result.current.valePara("Olá.")).toBe(true);
    expect(result.current.valePara("Olá!")).toBe(false);
  });

  it("limpar() no meio da geração: a prévia que chega depois NÃO aparece", async () => {
    let soltar: (r: Response) => void = () => undefined;
    fetchFalso.mockImplementation(
      () =>
        new Promise<Response>((res) => {
          soltar = res;
        }),
    );
    const { result } = renderHook(() => usePreviaDaFala("v1"), { wrapper: envoltorio() });
    act(() => result.current.gerar("Olá."));
    await waitFor(() => expect(result.current.gerando).toBe(true));

    act(() => result.current.limpar());
    expect(result.current.gerando).toBe(false);
    await act(async () => {
      soltar(respostaDaPrevia());
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.previa).toBeNull();
    expect(result.current.valePara("Olá.")).toBe(false);
  });

  it("a resposta de um pedido ABANDONADO, chegando depois da do pedido novo, não a sobrescreve", async () => {
    const soltar: Array<(r: Response) => void> = [];
    fetchFalso.mockImplementation(
      () =>
        new Promise<Response>((res) => {
          soltar.push(res);
        }),
    );
    const resposta = (hash: string) =>
      new Response(JSON.stringify({ data: { hash, duracao_ms: 700, reaproveitada: false, audio_base64: "//8=" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { result } = renderHook(() => usePreviaDaFala("v1"), { wrapper: envoltorio() });
    act(() => result.current.gerar("Texto A."));
    await waitFor(() => expect(soltar).toHaveLength(1));
    act(() => result.current.limpar());
    act(() => result.current.gerar("Texto B."));
    await waitFor(() => expect(soltar).toHaveLength(2));

    await act(async () => {
      soltar[1]?.(resposta("b".repeat(64)));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.previa?.texto).toBe("Texto B.");
    await act(async () => {
      soltar[0]?.(resposta("a".repeat(64)));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.previa).toMatchObject({ texto: "Texto B.", hash: "b".repeat(64) });
  });

  it("a prévia é da VOZ com que foi pedida: trocada a voz, some — e a marca de ouvida junto", async () => {
    fetchFalso.mockResolvedValue(respostaDaPrevia());
    const { result, rerender } = renderHook(({ voz }) => usePreviaDaFala(voz), {
      wrapper: envoltorio(),
      initialProps: { voz: "v1" as string | null },
    });
    act(() => result.current.gerar("Olá."));
    await waitFor(() => expect(result.current.previa).not.toBeNull());
    act(() => result.current.marcarOuvida());
    expect(result.current.ouvida).toBe(true);

    rerender({ voz: "v2" });
    expect(result.current.previa).toBeNull();
    expect(result.current.valePara("Olá.")).toBe(false);
    expect(result.current.ouvida).toBe(false);
  });

  it("a falha vale para o texto (e a voz) que a pediu: editar o texto, ou trocar a voz, apaga a falha", async () => {
    fetchFalso.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "sem_credito", message: "Sem crédito." } }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { result, rerender } = renderHook(({ voz }) => usePreviaDaFala(voz), {
      wrapper: envoltorio(),
      initialProps: { voz: "v1" as string | null },
    });
    act(() => result.current.gerar("Olá."));
    await waitFor(() => expect(result.current.erroPara("Olá.")).not.toBeNull());
    expect(result.current.erroPara(" Olá. ")).toBeInstanceOf(ApiError);
    expect(result.current.erroPara("Olá, tudo bem?")).toBeNull();

    rerender({ voz: "v2" });
    expect(result.current.erroPara("Olá.")).toBeNull();
  });
});
