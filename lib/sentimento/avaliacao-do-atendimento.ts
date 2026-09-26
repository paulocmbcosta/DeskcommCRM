/**
 * COMO O CLIENTE ESTÁ COM O ATENDIMENTO — a parte pura da avaliação (Jev).
 *
 * ## Por que o atendimento inteiro, e não a mensagem
 *
 * Até a 1.45 a nota era de UMA mensagem, classificada sozinha por um modelo de
 * conversa (Haiku/GPT, `generateObject`). Medido pelo dono em produção
 * (2026-09-25): dez mensagens de reclamação deixavam o atendimento
 * "insatisfeito", e um "ok, obrigado" na décima primeira o devolvia a "neutro"
 * ou "satisfeito" — a nota da conversa era a da última frase. Atendimento não
 * é frase: a equipe precisa saber como o cliente está com o ATENDIMENTO.
 *
 * Agora, a cada mensagem do cliente, o Jev lê o atendimento em aberto INTEIRO
 * (do início do atendimento vigente até agora — a mesma régua de
 * `janelaDoAtendimento`, migration 0269) e responde uma pergunta só, do tipo
 * `score`: em que nível de satisfação o cliente está. A pergunta manda pesar o
 * histórico — cordialidade no fim não apaga reclamação sem solução.
 *
 * ## Por que o Jev
 *
 * É um modelo de DECISÃO (TypeSafe, pela OpenRouter): devolve distribuição de
 * probabilidade sobre níveis que nós escrevemos, não texto. Mais barato (US$
 * 0,042 por milhão de tokens de entrada, saída grátis) e mais rápido (~300 ms
 * medidos no classificador comercial) que um modelo de conversa, e a mesma
 * chave que já paga o classificador comercial.
 *
 * ## A escala
 *
 * `score` recebe critérios ORDENADOS (índice 0 = o nível mais baixo) e devolve
 * `score` = média dos índices ponderada pela probabilidade — pode cair entre
 * dois níveis. Cinco níveis, normalizados para 0..1 (`score / 4`), casam com as
 * faixas da tela (`lib/inbox/sentimento.ts`: crítico < 0,1 · insatisfeito < 0,3
 * · neutro < 0,6 · satisfeito): o nível "insatisfeito" puro dá 0,25, o
 * "neutro" 0,5, o "satisfeito" 0,75.
 *
 * Critérios escritos com o que conta E o que não conta: o Jev lê ao pé da
 * letra. Em especial, DESCREVER um defeito ("estou sem internet") sem carga
 * emocional é neutro — foi a maior fonte de falso alarme do classificador
 * antigo (42 alertas em 48 h num provedor, a maioria só a descrição do
 * problema; ver `workers/ai-handoff-from-sentiment.handler.ts`).
 */
import { z } from "zod";

import type { EstadoDoJev, MensagemParaEstado } from "@/lib/classificador-comercial/perguntas";

export { MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

/**
 * Quantas falas do atendimento o Jev lê. Maior que as 12 do classificador
 * comercial de propósito: lá a pergunta é "sobre o que é", e o começo basta;
 * aqui é "como está, considerando tudo", e o que ficou para trás conta. Um
 * atendimento com mais falas que isto perde as MAIS ANTIGAS — e o pior momento
 * delas já ficou guardado em `conversations.sentimento_minimo`.
 */
export const LIMITE_DE_FALAS_DO_ATENDIMENTO = 50;
export const LIMITE_DE_CARACTERES_POR_FALA = 400;

/** Do nível mais baixo (índice 0) ao mais alto. A ordem É o contrato da pergunta `score`. */
export const NIVEIS_DE_SATISFACAO = [
  "Muito insatisfeito: o cliente está irritado ou revoltado com o atendimento ou com a empresa — reclama com raiva, ameaça cancelar, procurar a concorrência, o Procon ou a justiça, ou repete a mesma reclamação sem receber solução",
  "Insatisfeito: o cliente está frustrado ou decepcionado — reclama da demora, do serviço ou do atendimento, ou diz que o problema continua sem solução",
  "Neutro: o cliente pede informação, relata um problema ou responde perguntas sem demonstrar irritação nem satisfação; descrever um defeito ('estou sem sinal', 'a fatura veio errada') sem reclamar do atendimento é neutro",
  "Satisfeito: o cliente é cordial, agradece, concorda com a solução proposta ou diz que o problema foi resolvido",
  "Muito satisfeito: o cliente elogia o atendimento ou a empresa, agradece com entusiasmo ou diz que vai recomendar",
] as const;

export const PERGUNTAS_DE_SATISFACAO = {
  satisfacao: {
    type: "score",
    instructions:
      "Considerando a `conversa` INTEIRA deste atendimento, do começo até a última mensagem, como o cliente está se sentindo com o atendimento agora? " +
      "Pese o histórico: uma mensagem educada ou um 'ok' no final NÃO apaga reclamações anteriores que continuam sem solução. " +
      "Só considere que o cliente melhorou quando o problema dele foi resolvido ou quando ele mesmo disse que ficou satisfeito.",
    criteria: NIVEIS_DE_SATISFACAO,
  },
} as const;

/** Corta por CODE POINT (mesma razão de `perguntas.ts`): emoji partido quebra JSON estrito. */
function cortarPorCodePoint(texto: string, limite: number): string {
  return Array.from(texto).slice(0, limite).join("");
}

/**
 * O estado que o Jev lê: as falas do atendimento vigente, da mais velha para a
 * mais nova (a ordem vem de quem lê o banco — `dadosViaSupabase().ultimasMensagens`).
 * `null` quando o cliente ainda não disse nada com texto: não há o que avaliar.
 */
export function montarEstadoDoAtendimento(mensagens: MensagemParaEstado[]): EstadoDoJev | null {
  const conversa = mensagens
    .map((m) => ({
      quem: m.direcao === "inbound" ? ("cliente" as const) : ("atendente" as const),
      texto: (m.texto ?? "").trim(),
    }))
    .filter((m) => m.texto !== "")
    .slice(-LIMITE_DE_FALAS_DO_ATENDIMENTO)
    .map((m) => ({ ...m, texto: cortarPorCodePoint(m.texto, LIMITE_DE_CARACTERES_POR_FALA) }));
  if (!conversa.some((m) => m.quem === "cliente")) return null;
  return { conversa };
}

const ULTIMO_NIVEL = NIVEIS_DE_SATISFACAO.length - 1;

/** O `score` do Jev (0..4) na régua do produto (0..1), com 3 casas — o `numeric(4,3)` da conversa. */
export function notaDoScore(score: number): number {
  const nota = Math.min(1, Math.max(0, score / ULTIMO_NIVEL));
  return Math.round(nota * 1000) / 1000;
}

/**
 * Só `answers.satisfacao.score` é estrito — é a nota. `confidence` e `usage`
 * explicam ou custeiam: malformados, viram `undefined`, nunca reprovam a nota.
 */
const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    satisfacao: z.object({
      score: z.number().min(0).max(ULTIMO_NIVEL),
      confidence: z.number().min(0).max(1).optional().catch(undefined),
    }),
  }),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

export interface AvaliacaoDoAtendimento {
  /** 0..1, na régua da tela. */
  nota: number;
  confianca: number | null;
  modelo: string;
  tokensDeEntrada: number | null;
  /** Centavos: `usage.cost` real (dólares × 100) ou, sem ele, a estimativa por token. `null` = desconhecido. */
  custoEmCentavos: number | null;
}

/** US$ 0,042 por milhão de tokens de entrada — o mesmo preço de `lib/classificador-comercial/jev.ts`. */
const CENTAVOS_POR_MILHAO_DE_TOKENS = 4.2;

export type LeituraDaResposta =
  | { ok: true; avaliacao: AvaliacaoDoAtendimento }
  | { ok: false; detalhe: string };

export function lerRespostaDeSatisfacao(corpo: unknown, modeloPedido: string): LeituraDaResposta {
  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    const caminhos = lido.error.issues.map((i) => i.path.join(".") || "(raiz)").join(", ");
    return { ok: false, detalhe: `resposta fora do formato esperado: ${caminhos}` };
  }
  const a = lido.data;
  const tokens = a.usage?.input_tokens ?? null;
  const custo =
    a.usage?.cost !== undefined
      ? a.usage.cost * 100
      : tokens === null
        ? null
        : (tokens * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
  return {
    ok: true,
    avaliacao: {
      nota: notaDoScore(a.answers.satisfacao.score),
      confianca: a.answers.satisfacao.confidence ?? null,
      modelo: a.model ?? modeloPedido,
      tokensDeEntrada: tokens,
      custoEmCentavos: custo,
    },
  };
}

// ── Sem chave da OpenRouter: a MESMA pergunta, a um modelo de conversa ───────
//
// A chave da OpenRouter é opcional na instalação (`install.sh` deixa pular), e o
// Jev só existe lá. Quem não a tem continua com a avaliação — do atendimento
// inteiro, na mesma escala de cinco níveis —, só que pelo modelo de conversa da
// organização (o escolhido em IA › Provedores para "Medir o clima do
// atendimento"). Mais caro e mais lento; nenhuma instalação perde a feature ao
// atualizar (decisão do dono, 2026-09-25).

export const SISTEMA_DO_MODELO_DE_CONVERSA =
  "Você avalia a satisfação de um cliente com um atendimento. " +
  PERGUNTAS_DE_SATISFACAO.satisfacao.instructions +
  "\n\nResponda com o número do nível:\n" +
  NIVEIS_DE_SATISFACAO.map((nivel, i) => `${i} = ${nivel}`).join("\n");

/** A conversa como o modelo de conversa a lê: uma fala por linha, com quem falou. */
export function promptDoModeloDeConversa(estado: EstadoDoJev): string {
  return estado.conversa.map((m) => `${m.quem === "cliente" ? "Cliente" : "Atendente"}: ${m.texto}`).join("\n");
}
