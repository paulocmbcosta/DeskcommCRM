/**
 * Reação com emoji — o schema central de `messages.metadata.reacoes` (migration 0276).
 *
 * A reação NÃO é mensagem: é estado da mensagem alvo. Antes da 0276 a reação do
 * cliente virava uma linha nova do tipo `reaction`, sem corpo — balão vazio na
 * conversa, prévia "[reaction]" na lista e o agente de IA acordando para
 * responder a um 👍.
 *
 * Como no WhatsApp, cada LADO tem uma reação por mensagem: a nova substitui a
 * anterior e a vazia remove. O lado da empresa é o NÚMERO — quando dois
 * atendentes reagem à mesma mensagem, o cliente vê só a última, e a tela
 * também. `user_id` diz quem reagiu por último pela empresa.
 *
 * Quem escreve é `fn_registrar_reacao` (um UPDATE só, sem ler-e-reescrever);
 * quem lê é `reacoesDe`, que nunca lança: `metadata` é jsonb aberto e uma chave
 * torta não pode derrubar a thread.
 */
import { z } from "zod";

export const LADOS_DA_REACAO = ["contato", "empresa"] as const;
export type LadoDaReacao = (typeof LADOS_DA_REACAO)[number];

const reacaoSchema = z.object({
  emoji: z.string().min(1),
  em: z.string().optional(),
  user_id: z.string().optional(),
  external_id: z.string().optional(),
});

export type Reacao = z.infer<typeof reacaoSchema>;
export type ReacoesDaMensagem = Partial<Record<LadoDaReacao, Reacao>>;

/** As reações gravadas numa mensagem. Chave torta é ignorada, nunca lança. */
export function reacoesDe(metadata: unknown): ReacoesDaMensagem {
  if (!metadata || typeof metadata !== "object") return {};
  const bruto = (metadata as Record<string, unknown>).reacoes;
  if (!bruto || typeof bruto !== "object") return {};
  const out: ReacoesDaMensagem = {};
  for (const lado of LADOS_DA_REACAO) {
    const r = reacaoSchema.safeParse((bruto as Record<string, unknown>)[lado]);
    if (r.success) out[lado] = r.data;
  }
  return out;
}

/** Os seis atalhos do WhatsApp, na mesma ordem. */
export const EMOJIS_RAPIDOS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

/** A grade do "+": os mais usados em atendimento, sem depender de biblioteca. */
export const EMOJIS_DA_GRADE = [
  "👍",
  "👎",
  "👏",
  "🙌",
  "🙏",
  "🤝",
  "👌",
  "✌️",
  "💪",
  "👋",
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🖤",
  "💯",
  "🔥",
  "✨",
  "😀",
  "😁",
  "😂",
  "🤣",
  "😊",
  "😍",
  "🥰",
  "😘",
  "😉",
  "😎",
  "🤔",
  "😮",
  "😯",
  "😢",
  "😭",
  "😅",
  "😬",
  "🙄",
  "😴",
  "🤗",
  "✅",
  "❌",
  "⚠️",
  "⏳",
  "📌",
  "📞",
  "📅",
  "💰",
  "🎉",
  "🎁",
] as const;

/**
 * Um emoji só — o que a Meta aceita no campo `reaction.emoji`.
 *
 * Aceita sequência (bandeira, tom de pele, família com ZWJ), recusa texto: a
 * Meta devolve erro para "ok" e o atendente só descobriria depois do envio.
 * Vazio NÃO passa aqui — remover é outro caminho explícito (`emoji: ""` na rota).
 */
export function ehEmojiValido(valor: string): boolean {
  if (valor.length === 0 || valor.length > 32) return false;
  if (/[\p{L}\p{N}\s<>]/u.test(valor.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ""))) {
    // Letra, dígito ou espaço solto = texto. (Regional indicators são "letras"
    // para algumas versões do ICU; bandeira é emoji legítimo.)
    return /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(valor);
  }
  return /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(valor);
}
