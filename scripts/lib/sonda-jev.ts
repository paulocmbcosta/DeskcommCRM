/**
 * PEÇAS PURAS da sonda do Jev (`scripts/sondar-jev.ts`) — sem rede, sem
 * LER nem ESCREVER nada em disco. `ehArquivoSinteticoPadrao` usa
 * `node:path` (só resolve string, não toca o filesystem) e lê
 * `process.cwd()` como padrão — mas é parâmetro, então o teste fixa um
 * valor e a função continua determinística para quem chama. Só aqui porque
 * são testáveis isoladamente; a orquestração (env, fetch, stdout, exit
 * code, leitura/escrita de arquivo) fica no script.
 *
 *  - `validarCasos`/`casoParaSondaSchema`: a entrada de cada caso é o MESMO
 *    formato que a produção monta (`MensagemParaEstado[]`, via `montarEstado`
 *    em `lib/classificador-comercial/perguntas.ts`) — a sonda testa o caminho
 *    real, não uma forma abreviada. Erro de validação relata só os CAMINHOS,
 *    nunca os VALORES: um caso com telefone digitado por engano no `texto`
 *    não pode vazar no stderr.
 *  - `analisarLimiar`: valida sem converter — "0,7" (vírgula) é rejeitado,
 *    não silenciosamente virar 0.7.
 *  - `ehArquivoSinteticoPadrao`: só o arquivo sintético do repo pode virar
 *    `tests/fixtures/jev/resposta-real.json` — um arquivo de conversas REAIS
 *    (fora do repo, com dado de cliente) nunca pode.
 *  - `extrairContratoConhecido`: o que pode ir para
 *    `tests/fixtures/jev/resposta-real.json` — só os campos que o schema HTTP
 *    (`lib/classificador-comercial/jev.ts`) de fato lê, e dentro de
 *    `answers.assunto.probabilities`, só as chaves CONHECIDAS de `ASSUNTOS`
 *    com valor numérico. Nunca `id` de geração nem qualquer campo/chave novo
 *    do provedor (podem repetir texto da conversa).
 *  - `calcularMetricas`: respondidas/falhas/acertos, mediana e máx (só das
 *    respondidas), matriz de confusão, e totais de tokens/custo que só somam
 *    quando TODAS as respondidas informam o dado — nunca 0 por omissão.
 */
import * as path from "node:path";

import { z } from "zod";

import { ASSUNTOS } from "@/lib/classificador-comercial/perguntas";

export const casoParaSondaSchema = z.object({
  esperado: z.enum(["sim", "nao"]),
  assunto: z.string(),
  mensagens: z
    .array(z.object({ direcao: z.enum(["inbound", "outbound"]), texto: z.string().nullable() }))
    .min(1),
});

export type CasoParaSonda = z.infer<typeof casoParaSondaSchema>;

export type ResultadoDaValidacao<T> = { ok: true; casos: T } | { ok: false; erro: string };

/**
 * Só os CAMINHOS do Zod no erro — nunca `issue.message` nem o valor recebido:
 * a mensagem padrão do Zod para um enum errado cita o valor recebido, e o
 * valor pode ser o `texto` de uma mensagem real (telefone, CPF, nome).
 */
export function validarCasos(bruto: unknown): ResultadoDaValidacao<CasoParaSonda[]> {
  const lido = z.array(casoParaSondaSchema).safeParse(bruto);
  if (lido.success) return { ok: true, casos: lido.data };
  const caminhos = [...new Set(lido.error.issues.map((issue) => issue.path.join(".") || "(raiz)"))].join(", ");
  return { ok: false, erro: `entrada fora do formato esperado nos campos: ${caminhos}` };
}

export type ResultadoDoLimiar = { ok: true; valor: number } | { ok: false; erro: string };

/** Finito e em (0, 1] — sem converter vírgula decimal: "0,7" é rejeitado, não virado em 0.7 às escondidas. */
export function analisarLimiar(bruto: string): ResultadoDoLimiar {
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor <= 0 || valor > 1) {
    return { ok: false, erro: `limiar precisa ser um número finito em (0, 1] — recebido "${bruto}"` };
  }
  return { ok: true, valor };
}

export const ARQUIVO_SINTETICO_PADRAO = "tests/fixtures/jev/conversas-de-exemplo.json";

/**
 * `--gravar-contrato` só pode sobrescrever a fixture do conjunto SINTÉTICO —
 * nunca um arquivo de conversas REAIS (fora do repo, com dado de cliente).
 * Compara pelo CAMINHO RESOLVIDO (`path.resolve`), não pela string crua:
 * `./tests/fixtures/jev/conversas-de-exemplo.json` e o caminho absoluto
 * equivalente têm que contar como o MESMO arquivo. `cwd` é parâmetro (não
 * `process.cwd()` direto) só para o teste poder fixar um diretório sem tocar
 * o processo real.
 */
export function ehArquivoSinteticoPadrao(arquivo: string, cwd: string = process.cwd()): boolean {
  return path.resolve(cwd, arquivo) === path.resolve(cwd, ARQUIVO_SINTETICO_PADRAO);
}

/**
 * Nome do erro (`SyntaxError`, `TypeError`...), nunca a mensagem: o
 * `SyntaxError` do `JSON.parse` em Node cita um TRECHO do texto que falhou —
 * que pode ser a linha inteira de um arquivo com dado de cliente.
 */
export function nomeDoErro(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err && typeof (err as { name: unknown }).name === "string"
    ? (err as { name: string }).name
    : "erro desconhecido";
}

export interface ContratoConhecido {
  model?: string;
  answers: {
    comercial: { type?: string; noul?: number };
    assunto?: { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

/**
 * Copia campo a campo do corpo bruto — nunca `{ ...bruto }` nem spread de
 * sub-objetos — porque a lista de campos conhecidos é a mesma lista que
 * `respostaSchema` em `lib/classificador-comercial/jev.ts` lê. Um campo novo
 * do provedor (ex.: `id` de geração, ou algo que ecoe a conversa) fica de
 * fora até alguém decidir explicitamente trazê-lo para os dois lugares.
 * `null` quando não há nem `answers.comercial` — não há contrato para gravar.
 */
export function extrairContratoConhecido(bruto: unknown): ContratoConhecido | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const b = bruto as Record<string, unknown>;

  const answersBruto = b.answers;
  if (typeof answersBruto !== "object" || answersBruto === null) return null;
  const answers = answersBruto as Record<string, unknown>;

  const comercialBruto = answers.comercial;
  if (typeof comercialBruto !== "object" || comercialBruto === null) return null;
  const comercial = comercialBruto as Record<string, unknown>;

  const resultado: ContratoConhecido = {
    answers: {
      comercial: {
        ...(typeof comercial.type === "string" ? { type: comercial.type } : {}),
        ...(typeof comercial.noul === "number" ? { noul: comercial.noul } : {}),
      },
    },
  };
  if (typeof b.model === "string") resultado.model = b.model;

  const assuntoBruto = answers.assunto;
  if (typeof assuntoBruto === "object" && assuntoBruto !== null) {
    const assunto = assuntoBruto as Record<string, unknown>;
    const assuntoConhecido: NonNullable<ContratoConhecido["answers"]["assunto"]> = {};
    if (typeof assunto.type === "string") assuntoConhecido.type = assunto.type;
    if (typeof assunto.choice === "string") assuntoConhecido.choice = assunto.choice;
    if (typeof assunto.probabilities === "object" && assunto.probabilities !== null) {
      // Filtra para chaves CONHECIDAS (as de `ASSUNTOS`) com valor numérico —
      // `Object.hasOwn`, não `in` (herdaria "toString"/"constructor" etc.).
      // Sem o filtro, um assunto novo do provedor (ou lixo com valor não
      // numérico) ia direto para a fixture versionada.
      const probsBrutas = assunto.probabilities as Record<string, unknown>;
      const probsConhecidas: Record<string, number> = {};
      for (const chave of Object.keys(probsBrutas)) {
        const valor = probsBrutas[chave];
        if (Object.hasOwn(ASSUNTOS, chave) && typeof valor === "number") probsConhecidas[chave] = valor;
      }
      assuntoConhecido.probabilities = probsConhecidas;
    }
    if (typeof assunto.confidence === "number") assuntoConhecido.confidence = assunto.confidence;
    resultado.answers.assunto = assuntoConhecido;
  }

  const usageBruto = b.usage;
  if (typeof usageBruto === "object" && usageBruto !== null) {
    const usage = usageBruto as Record<string, unknown>;
    const usageConhecido: NonNullable<ContratoConhecido["usage"]> = {};
    if (typeof usage.input_tokens === "number") usageConhecido.input_tokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") usageConhecido.output_tokens = usage.output_tokens;
    if (typeof usage.cost === "number") usageConhecido.cost = usage.cost;
    resultado.usage = usageConhecido;
  }

  return resultado;
}

export type ResultadoDoCaso =
  | { tipo: "sem_fala_do_cliente" }
  | { tipo: "falha" }
  | {
      tipo: "respondida";
      esperado: "sim" | "nao";
      obtido: "sim" | "nao";
      latenciaMs: number;
      tokensDeEntrada: number | null;
      custoEmCentavos: number | null;
      modelo: string;
    };

export interface Metricas {
  total: number;
  semFalaDoCliente: number;
  falhas: number;
  respondidas: number;
  acertos: number;
  medianaMs: number;
  maxMs: number;
  matriz: { simSim: number; simNao: number; naoSim: number; naoNao: number };
  tokensDeEntradaTotal: number | null;
  custoTotalEmCentavos: number | null;
  modeloQueRespondeu: string | null;
  /** Sonda inteira sem NENHUMA resposta e com pelo menos uma falha — sinal de conta/rede, não de acurácia. */
  todasFalharam: boolean;
}

export function calcularMetricas(resultados: ResultadoDoCaso[]): Metricas {
  const semFalaDoCliente = resultados.filter((r) => r.tipo === "sem_fala_do_cliente").length;
  const falhas = resultados.filter((r) => r.tipo === "falha").length;
  const respondidasArr = resultados.filter(
    (r): r is Extract<ResultadoDoCaso, { tipo: "respondida" }> => r.tipo === "respondida",
  );
  const respondidas = respondidasArr.length;

  const matriz = { simSim: 0, simNao: 0, naoSim: 0, naoNao: 0 };
  for (const r of respondidasArr) {
    if (r.esperado === "sim" && r.obtido === "sim") matriz.simSim++;
    else if (r.esperado === "sim" && r.obtido === "nao") matriz.simNao++;
    else if (r.esperado === "nao" && r.obtido === "sim") matriz.naoSim++;
    else matriz.naoNao++;
  }
  const acertos = matriz.simSim + matriz.naoNao;

  const latencias = respondidasArr.map((r) => r.latenciaMs).sort((a, b) => a - b);
  const medianaMs = latencias.length ? latencias[Math.floor(latencias.length / 2)]! : 0;
  const maxMs = latencias.length ? (latencias.at(-1) ?? 0) : 0;

  const tokensConhecidos = respondidasArr.length > 0 && respondidasArr.every((r) => r.tokensDeEntrada !== null);
  const tokensDeEntradaTotal = tokensConhecidos
    ? respondidasArr.reduce((soma, r) => soma + (r.tokensDeEntrada ?? 0), 0)
    : null;

  const custoConhecido = respondidasArr.length > 0 && respondidasArr.every((r) => r.custoEmCentavos !== null);
  const custoTotalEmCentavos = custoConhecido
    ? respondidasArr.reduce((soma, r) => soma + (r.custoEmCentavos ?? 0), 0)
    : null;

  return {
    total: resultados.length,
    semFalaDoCliente,
    falhas,
    respondidas,
    acertos,
    medianaMs,
    maxMs,
    matriz,
    tokensDeEntradaTotal,
    custoTotalEmCentavos,
    modeloQueRespondeu: respondidasArr[0]?.modelo ?? null,
    todasFalharam: respondidas === 0 && falhas > 0,
  };
}
