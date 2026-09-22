/**
 * O CLIENTE DO JEV — a API System One da TypeSafe, pela OpenRouter.
 *
 * Não é chat: é `POST {base}/systemone` com `{ model, state, questions }`, e a
 * resposta são probabilidades (`answers.<id>.noul`, `answers.<id>.choice`).
 * Por isso não passa pelo AI SDK nem pelo `runModelCall`: os dois falam
 * `chat/completions`.
 *
 * NUNCA LANÇA. Toda falha volta classificada, porque quem chama decide coisas
 * diferentes para cada uma:
 *  - `conta` (401/402/403): chave recusada ou sem saldo. Tentar de novo não resolve.
 *  - `temporaria` (408/429/5xx/rede/tempo): tentar de novo resolve.
 *  - `contrato` (outro 4xx, ou 200 fora do formato): o pedido ou a resposta
 *    mudou. É defeito nosso ou do provedor, e precisa aparecer.
 *
 * O `detalhe` nunca carrega a chave: vem do corpo de erro do provedor ou do
 * NOME do erro de rede.
 */
import { z } from "zod";

import { PERGUNTAS, type EstadoDoJev, type RespostaDoJev } from "./perguntas";

export const OPENROUTER_BASE_PADRAO = "https://openrouter.ai/api/v1";
export const TEMPO_LIMITE_MS = 8_000;

/** US$ 0,042 por milhão de tokens de entrada; saída não é cobrada (catálogo da OpenRouter, 22/09/2026). */
export const CENTAVOS_POR_MILHAO_DE_TOKENS = 4.2;

export type FalhaDoJev =
  | { tipo: "temporaria"; status: number | null; detalhe: string }
  | { tipo: "conta"; status: number; detalhe: string }
  | { tipo: "contrato"; status: number | null; detalhe: string };

export type ResultadoDoJev =
  | { ok: true; resposta: RespostaDoJev; latenciaMs: number }
  | { ok: false; falha: FalhaDoJev; latenciaMs: number };

/** Só o que o produto usa. `passthrough` implícito: campo novo do provedor não quebra. */
const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    comercial: z.object({ noul: z.number().min(0).max(1) }),
    assunto: z.object({
      choice: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  }),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional(),
});

/**
 * Custo EXATO, fracionário. `computeCost` (lib/ai/cost.ts) arredonda para
 * cima em centavo inteiro — uma chamada de US$ 0,0001 viraria 1 centavo, cem
 * vezes o real, e o teto de orçamento da organização estouraria de mentira.
 */
export function custoEmCentavos(tokensDeEntrada: number): number {
  return (tokensDeEntrada * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
}

export async function perguntarAoJev(entrada: {
  apiKey: string;
  estado: EstadoDoJev;
  modelo: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  tempoLimiteMs?: number;
  cabecalhosExtras?: Record<string, string>;
}): Promise<ResultadoDoJev> {
  const inicio = Date.now();
  const base = (entrada.baseUrl?.trim() || OPENROUTER_BASE_PADRAO).replace(/\/+$/, "");
  const f = entrada.fetchImpl ?? fetch;

  let resp: Response;
  try {
    resp = await f(`${base}/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${entrada.apiKey}`,
        "Content-Type": "application/json",
        ...(entrada.cabecalhosExtras ?? {}),
      },
      body: JSON.stringify({ model: entrada.modelo, state: entrada.estado, questions: PERGUNTAS }),
      signal: AbortSignal.timeout(entrada.tempoLimiteMs ?? TEMPO_LIMITE_MS),
    });
  } catch (err) {
    // Não usar `instanceof Error`: sob jsdom (ambiente de teste) o
    // `DOMException` do timeout NÃO é instância de `Error` — checagem
    // estrutural do `.name` cobre `Error`, `DOMException` e qualquer erro de
    // rede do `fetch`, nos dois ambientes.
    const nome =
      typeof err === "object" && err !== null && "name" in err && typeof (err as { name: unknown }).name === "string"
        ? (err as { name: string }).name
        : "rede";
    return {
      ok: false,
      latenciaMs: Date.now() - inicio,
      falha: { tipo: "temporaria", status: null, detalhe: nome },
    };
  }

  const latenciaMs = Date.now() - inicio;
  if (!resp.ok) {
    const detalhe = (await resp.text().catch(() => "")).slice(0, 200);
    const s = resp.status;
    if (s === 401 || s === 402 || s === 403) return { ok: false, latenciaMs, falha: { tipo: "conta", status: s, detalhe } };
    if (s === 408 || s === 429 || s >= 500) return { ok: false, latenciaMs, falha: { tipo: "temporaria", status: s, detalhe } };
    return { ok: false, latenciaMs, falha: { tipo: "contrato", status: s, detalhe } };
  }

  const corpo: unknown = await resp.json().catch(() => null);
  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    return {
      ok: false,
      latenciaMs,
      falha: { tipo: "contrato", status: resp.status, detalhe: "resposta fora do formato esperado" },
    };
  }

  const a = lido.data;
  return {
    ok: true,
    latenciaMs,
    resposta: {
      comercial: a.answers.comercial.noul,
      assunto: a.answers.assunto.choice,
      confiancaDoAssunto: a.answers.assunto.confidence ?? null,
      modelo: a.model ?? entrada.modelo,
      tokensDeEntrada: a.usage?.input_tokens ?? 0,
    },
  };
}
