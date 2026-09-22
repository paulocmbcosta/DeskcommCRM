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
 *  - `conta` (401/402/403, ou chave malformada detectada ANTES do fetch):
 *    chave recusada, sem saldo ou nem sequer válida. Tentar de novo não resolve.
 *  - `temporaria` (408/429/5xx/rede/tempo, incluindo falha ao LER o corpo
 *    depois dos headers): tentar de novo resolve.
 *  - `contrato` (outro 4xx, corpo que não é JSON, ou 200 fora do formato): o
 *    pedido ou a resposta mudou. É defeito nosso ou do provedor, e precisa
 *    aparecer.
 *
 * O `detalhe` nunca carrega a chave: se o corpo de erro é JSON com
 * `error.message`, só ESSE campo (mais `error.code`, se vier) sobrevive — o
 * resto é descartado ANTES de qualquer redação, porque provedor de erro pode
 * anexar dado que nenhum regex reconhece (ex.: a OpenRouter ecoa
 * `error.metadata.flagged_input`, um TRECHO DA CONVERSA DO CLIENTE, em erro
 * de moderação). O que sobra passa por `redigirMensagemDoProvedor` (padrões
 * conhecidos de chave e PII) MAIS um `replaceAll` da chave USADA nesta
 * chamada — já aparada — como backstop para um formato que os padrões não
 * cobrem. O que sobra de erro de rede é só o NOME do erro (`TimeoutError`,
 * `TypeError`...), nunca a mensagem crua.
 */
import { z } from "zod";

import { redigirMensagemDoProvedor } from "@/lib/ai/redigir-mensagem-do-provedor";

import { PERGUNTAS, type EstadoDoJev, type RespostaDoJev } from "./perguntas";

export const OPENROUTER_BASE_PADRAO = "https://openrouter.ai/api/v1";
export const TEMPO_LIMITE_MS = 8_000;

/** US$ 0,042 por milhão de tokens de entrada; saída não é cobrada (catálogo da OpenRouter, 22/09/2026). */
export const CENTAVOS_POR_MILHAO_DE_TOKENS = 4.2;

/**
 * Só ASCII imprimível, sem espaço: chave com quebra de linha, espaço ou
 * caractere invisível (ex.: zero-width space colado sem querer ao copiar) é
 * malformada — falhar ANTES do fetch evita ~10 tentativas inúteis contra um
 * provedor que teria recusado de qualquer jeito.
 */
const CHAVE_VALIDA = /^[\x21-\x7e]+$/;

export type FalhaDoJev =
  | { tipo: "temporaria"; status: number | null; detalhe: string }
  | { tipo: "conta"; status: number | null; detalhe: string }
  | { tipo: "contrato"; status: number | null; detalhe: string };

export type ResultadoDoJev =
  | { ok: true; resposta: RespostaDoJev; latenciaMs: number }
  | { ok: false; falha: FalhaDoJev; latenciaMs: number };

/**
 * Só `answers.comercial.noul` é estrito — é a DECISÃO, e uma probabilidade
 * fora de [0,1] não pode virar card (nem deixar de virar) por engano.
 *
 * `answers.assunto` e `usage` só EXPLICAM ou CUSTEIAM: `.optional().catch()`
 * faz um campo ausente OU malformado (confidence fora da faixa, choice
 * faltando) cair pra `undefined` em vez de reprovar a resposta inteira — os
 * dois viram `null` na tradução, nunca vetam a decisão.
 *
 * Chave desconhecida do provedor é descartada em silêncio: é o padrão do
 * `z.object` no Zod 4 (não é `passthrough` — passthrough PRESERVARIA a
 * chave extra na saída). O efeito que importa: campo novo do provedor não
 * quebra o parse.
 */
const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    comercial: z.object({ noul: z.number().min(0).max(1) }),
    assunto: z
      .object({
        choice: z.string(),
        confidence: z.number().min(0).max(1).optional(),
      })
      .optional()
      .catch(undefined),
  }),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      /** Custo REAL em DÓLARES, quando o provedor informa (ex.: `0.00002709`). */
      cost: z.number().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * Custo EXATO, fracionário, ou `null` se os tokens são desconhecidos — mesma
 * régua de `llm_calls.cost_cents` ("null = preço desconhecido — nunca
 * inventar 0"; `supabase/baseline.sql`, coluna `cost_cents`). `0` significa
 * "grátis"; ausência de dado não é isso.
 *
 * `computeCost` (lib/ai/cost.ts) arredonda para cima em centavo inteiro — uma
 * chamada de US$ 0,0001 viraria 1 centavo, cem vezes o real, e o teto de
 * orçamento da organização estouraria de mentira.
 */
export function custoEmCentavos(tokensDeEntrada: number | null): number | null {
  if (tokensDeEntrada === null) return null;
  return (tokensDeEntrada * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
}

/**
 * Nome do erro (`TimeoutError`, `AbortError`, `TypeError`...), nunca a
 * mensagem. Checagem ESTRUTURAL do `.name`, não `instanceof Error`: sob
 * jsdom (ambiente de teste) o `DOMException` do timeout NÃO é instância de
 * `Error` — a checagem estrutural cobre `Error`, `DOMException` e qualquer
 * erro de rede do `fetch`, nos dois ambientes.
 */
function nomeDoErro(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err && typeof (err as { name: unknown }).name === "string"
    ? (err as { name: string }).name
    : "rede";
}

/**
 * Corpo de erro em JSON pode trazer mais que o motivo: a OpenRouter anexa
 * `error.metadata.flagged_input` — um TRECHO DA CONVERSA DO CLIENTE — em erro
 * de moderação, e isso não é chave nem CPF/telefone/e-mail, então nenhum
 * regex de `redigirMensagemDoProvedor` o reconhece. Guardar só
 * `error.message` (e `error.code`, se vier) descarta esse resto ANTES da
 * redação rodar. Corpo que não é JSON, ou que é JSON sem `error.message`
 * string, devolve o texto cru — mesmo comportamento de antes desta função
 * existir.
 */
function extrairMensagemDeErro(texto: string): string {
  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return texto;
  }
  if (!corpo || typeof corpo !== "object" || !("error" in corpo)) return texto;
  const erro = (corpo as { error: unknown }).error;
  if (!erro || typeof erro !== "object" || !("message" in erro)) return texto;
  const mensagem = (erro as { message: unknown }).message;
  if (typeof mensagem !== "string") return texto;
  const codigo = "code" in erro ? (erro as { code: unknown }).code : undefined;
  return codigo === undefined || codigo === null ? mensagem : `[${String(codigo)}] ${mensagem}`;
}

/**
 * O corpo do provedor pode ecoar a própria chave (ex.: "Incorrect API key
 * provided: Bearer sk-or-..."). `redigirMensagemDoProvedor` cobre os padrões
 * conhecidos (`sk-…`, `AIza…`, `Bearer …`) e PII; o `replaceAll` da CHAVE
 * USADA nesta chamada (já APARADA — mesma chave que foi ao header) é o
 * backstop para um provedor que ecoa a chave num formato que nenhum padrão
 * cobre. Corte por CODE POINT (mesma razão de
 * `perguntas.ts:cortarPorCodePoint`, deliberadamente não compartilhada — não
 * vale acoplar o módulo HTTP ao módulo puro por uma função de 3 linhas):
 * `slice`/`substring` por unidade UTF-16 pode partir um emoji ao meio.
 */
function redigirDetalhe(bruto: string, chave: string): string {
  let texto = redigirMensagemDoProvedor(extrairMensagemDeErro(bruto));
  if (chave.length >= 8) texto = texto.replaceAll(chave, "[CHAVE]");
  return Array.from(texto).slice(0, 200).join("");
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
  // Aparada UMA vez, e usada em TUDO que segue (validação, header, redação):
  // `\n`/`\r\n`/espaço no fim (ex.: `.env` CRLF, ou um `OPENROUTER_API_KEY`
  // colado com quebra de linha) não deveria travar a chamada pra sempre em
  // "chave malformada" — o `fetch` real aparava sozinho, o mock de teste não.
  const chave = entrada.apiKey.trim();

  if (!CHAVE_VALIDA.test(chave)) {
    return {
      ok: false,
      latenciaMs: Date.now() - inicio,
      falha: { tipo: "conta", status: null, detalhe: "chave malformada" },
    };
  }

  // Filtra ANTES de espalhar: mesmo em outra CAIXA (`authorization`,
  // `content-type`), extra não pode sobrescrever autenticação nem o tipo de
  // conteúdo — chave de objeto JS é case-sensitive, então sem o filtro as
  // duas grafias convivem no mesmo objeto de headers.
  const extrasSemAutenticacao = Object.fromEntries(
    Object.entries(entrada.cabecalhosExtras ?? {}).filter(
      ([nome]) => !["authorization", "content-type"].includes(nome.toLowerCase()),
    ),
  );

  let resp: Response;
  try {
    resp = await f(`${base}/systemone`, {
      method: "POST",
      headers: {
        ...extrasSemAutenticacao,
        Authorization: `Bearer ${chave}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: entrada.modelo, state: entrada.estado, questions: PERGUNTAS }),
      signal: AbortSignal.timeout(entrada.tempoLimiteMs ?? TEMPO_LIMITE_MS),
    });
  } catch (err) {
    return {
      ok: false,
      latenciaMs: Date.now() - inicio,
      falha: { tipo: "temporaria", status: null, detalhe: nomeDoErro(err) },
    };
  }

  // Ler o corpo é parte da requisição, não da interpretação: um stream que
  // aborta no meio (o MESMO AbortSignal do timeout) é falha TEMPORÁRIA — não
  // "resposta que não bate com o formato". Ler ANTES de checar `resp.ok`
  // trata sucesso e erro HTTP pelo mesmo caminho.
  let texto: string;
  try {
    texto = await resp.text();
  } catch (err) {
    return {
      ok: false,
      latenciaMs: Date.now() - inicio,
      falha: { tipo: "temporaria", status: resp.status, detalhe: nomeDoErro(err) },
    };
  }

  // Medida DEPOIS de ler o corpo: medir antes subestimaria a latência real —
  // os headers podem chegar bem antes do corpo de uma resposta grande.
  const latenciaMs = Date.now() - inicio;

  if (!resp.ok) {
    const detalhe = redigirDetalhe(texto, chave);
    const s = resp.status;
    if (s === 401 || s === 402 || s === 403) return { ok: false, latenciaMs, falha: { tipo: "conta", status: s, detalhe } };
    if (s === 408 || s === 429 || s >= 500) return { ok: false, latenciaMs, falha: { tipo: "temporaria", status: s, detalhe } };
    return { ok: false, latenciaMs, falha: { tipo: "contrato", status: s, detalhe } };
  }

  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return {
      ok: false,
      latenciaMs,
      falha: { tipo: "contrato", status: resp.status, detalhe: "corpo não é JSON" },
    };
  }

  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    // `|| "(raiz)"` por ISSUE: um problema no corpo INTEIRO (ex.: `corpo` é
    // `null` ou array — não bate nem o tipo `object`) vem com `path: []`, e
    // `[].join(".")` é `""` — sem o fallback o detalhe terminava em `": "`.
    const caminhos = lido.error.issues.map((issue) => issue.path.join(".") || "(raiz)").join(", ");
    return {
      ok: false,
      latenciaMs,
      falha: { tipo: "contrato", status: resp.status, detalhe: `resposta fora do formato esperado: ${caminhos}` },
    };
  }

  const a = lido.data;
  // `usage.cost` é o valor REAL do provedor, em DÓLARES — mais exato que
  // estimar por token. Plano B (`custoEmCentavos`, definida acima) só quando
  // o provedor não informa `cost` (ele é opcional no schema).
  const custo = a.usage?.cost !== undefined ? a.usage.cost * 100 : custoEmCentavos(a.usage?.input_tokens ?? null);
  return {
    ok: true,
    latenciaMs,
    resposta: {
      comercial: a.answers.comercial.noul,
      assunto: a.answers.assunto?.choice ?? null,
      confiancaDoAssunto: a.answers.assunto?.confidence ?? null,
      modelo: a.model ?? entrada.modelo,
      tokensDeEntrada: a.usage?.input_tokens ?? null,
      custoEmCentavos: custo,
    },
  };
}
