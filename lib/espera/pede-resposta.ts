/**
 * A FALA DO CLIENTE PEDE RESPOSTA? — a parte pura da espera da Assistente.
 *
 * O termômetro do card (migration 0279) conta desde a primeira fala do cliente
 * sem resposta. Mas "ok, obrigado" depois de "assim que eu agendar te chamo"
 * não espera nada, e o card ficava vermelho à toa. A Assistente (o Jev, por
 * baixo — para o operador o nome é sempre "Assistente") responde UMA pergunta
 * `noul`: as falas em `sem_resposta` pedem resposta? A decisão é assimétrica
 * (`LIMIAR_PARA_DISPENSAR`): na dúvida, conta. Cliente marcado atrasado à toa
 * é incômodo; cliente esquecido é grave.
 */
import { z } from "zod";

import { CENTAVOS_POR_MILHAO_DE_TOKENS } from "@/lib/classificador-comercial/jev";
import type { MensagemParaEstado } from "@/lib/classificador-comercial/perguntas";

export { MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

/** Histórico que vai junto: o bastante para saber o que o atendente prometeu. */
export const LIMITE_DO_HISTORICO = 10;
export const LIMITE_DE_CARACTERES = 400;
/** Dispensa só quando P(pede resposta) ≤ este valor (decisão B do plano). */
export const LIMIAR_PARA_DISPENSAR = 0.15;

export interface EstadoDaEspera {
  conversa: Array<{ quem: "cliente" | "atendente"; texto: string }>;
  sem_resposta: string[];
}

export const PERGUNTAS_DA_ESPERA = {
  pede_resposta: {
    type: "noul",
    instructions:
      "As mensagens do cliente em `sem_resposta` (as últimas, ainda sem resposta; o histórico está em `conversa`) pedem uma resposta ou uma ação do atendente?",
    criteria: {
      true:
        "O cliente pergunta algo, pede algo, reclama, traz informação nova que o atendente precisa tratar, discorda, ou cobra algo que ficou pendente",
      false:
        "O cliente só confirma, concorda, agradece, se despede ou manda um emoji, por exemplo 'ok', 'tudo bem', 'obrigado', 'combinado', depois de o atendente já ter dado a informação ou dito que retorna",
    },
  },
} as const;

function cortar(texto: string): string {
  return Array.from(texto).slice(0, LIMITE_DE_CARACTERES).join("");
}

/**
 * `mensagens` em ordem cronológica (quem garante é `ultimasMensagens`).
 * `null` = não há o que perguntar e a espera CONTA: a última fala não é do
 * cliente, ou alguma fala sem resposta não tem texto (áudio sem transcrição).
 */
export function montarEstadoDaEspera(mensagens: MensagemParaEstado[]): EstadoDaEspera | null {
  let i = mensagens.length;
  while (i > 0 && mensagens[i - 1]!.direcao === "inbound") i--;
  const pendentes = mensagens.slice(i);
  if (pendentes.length === 0) return null;
  if (pendentes.some((p) => !(p.texto ?? "").trim())) return null;

  const conversa = mensagens
    .slice(0, i)
    .map((p) => ({ quem: p.direcao === "inbound" ? ("cliente" as const) : ("atendente" as const), texto: (p.texto ?? "").trim() }))
    .filter((p) => p.texto !== "")
    .slice(-LIMITE_DO_HISTORICO)
    .map((p) => ({ ...p, texto: cortar(p.texto) }));
  return { conversa, sem_resposta: pendentes.map((p) => cortar((p.texto ?? "").trim())) };
}

export function decidirDispensa(pedeResposta: number): boolean {
  return pedeResposta <= LIMIAR_PARA_DISPENSAR;
}

const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({ pede_resposta: z.object({ noul: z.number().min(0).max(1) }) }),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), cost: z.number().nonnegative().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export interface LeituraDaEspera {
  pedeResposta: number;
  modelo: string;
  tokensDeEntrada: number | null;
  custoEmCentavos: number | null;
}

export type ResultadoDaLeitura = { ok: true; leitura: LeituraDaEspera } | { ok: false; detalhe: string };

export function lerRespostaDaEspera(corpo: unknown, modeloPedido: string): ResultadoDaLeitura {
  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    return { ok: false, detalhe: `resposta fora do formato esperado: ${lido.error.issues.map((i) => i.path.join(".") || "(raiz)").join(", ")}` };
  }
  const a = lido.data;
  const tokens = a.usage?.input_tokens ?? null;
  const custo =
    a.usage?.cost !== undefined ? a.usage.cost * 100 : tokens === null ? null : (tokens * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
  return {
    ok: true,
    leitura: { pedeResposta: a.answers.pede_resposta.noul, modelo: a.model ?? modeloPedido, tokensDeEntrada: tokens, custoEmCentavos: custo },
  };
}
