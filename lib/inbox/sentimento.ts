/**
 * O SENTIMENTO DO CLIENTE NA TELA — uma régua, um lugar.
 *
 * A nota (0..1) vem do worker de sentimento: a cada mensagem do cliente (com a
 * IA ou com uma pessoa atendendo), o Jev avalia o ATENDIMENTO em aberto inteiro
 * — não a frase. A conversa guarda a leitura mais recente e a pior do
 * atendimento (`sentimento_atual`, `sentimento_minimo`, migration 0280).
 *
 * Faixas (pedido do dono, 2026-09-25 — a equipe precisa ACHAR a conversa
 * crítica, não ler números):
 *   · satisfeito   ≥ 0,6
 *   · neutro       0,3 ≤ nota < 0,6
 *   · insatisfeito 0,1 ≤ nota < 0,3
 *   · crítico      < 0,1
 *
 * O filtro "Insatisfeitos" pede `sentimento_atual < LIMITE_INSATISFEITO` — a
 * mesma constante daqui, no handler (`_handler.ts`). Nada de régua repetida.
 */
export const LIMITE_INSATISFEITO = 0.3;
export const LIMITE_CRITICO = 0.1;
export const LIMITE_SATISFEITO = 0.6;

export type FaixaDeSentimento = "satisfeito" | "neutro" | "insatisfeito" | "critico";

export function faixaDoSentimento(nota: number | null | undefined): FaixaDeSentimento | null {
  if (nota === null || nota === undefined || Number.isNaN(nota)) return null;
  if (nota < LIMITE_CRITICO) return "critico";
  if (nota < LIMITE_INSATISFEITO) return "insatisfeito";
  if (nota < LIMITE_SATISFEITO) return "neutro";
  return "satisfeito";
}

export const ROTULO_DA_FAIXA: Record<FaixaDeSentimento, string> = {
  satisfeito: "Satisfeito",
  neutro: "Neutro",
  insatisfeito: "Insatisfeito",
  critico: "Crítico",
};

/** A faixa que PEDE atenção — a que entra no card e no filtro. */
export function pedeAtencao(faixa: FaixaDeSentimento | null): boolean {
  return faixa === "insatisfeito" || faixa === "critico";
}

/** "0,12" — vírgula decimal, duas casas: é número para a equipe, não para o banco. */
export function formatarNota(nota: number): string {
  return nota.toFixed(2).replace(".", ",");
}

/**
 * O sentimento que a TELA mostra de uma conversa: o atual e o pior do
 * atendimento. Conversa encerrada não mostra (o banco já zera ao encerrar; isto
 * é a defesa para resposta em cache).
 */
export function sentimentoDaConversa(conversa: {
  status: string;
  sentimento_atual?: number | string | null;
  sentimento_minimo?: number | string | null;
}): { atual: number; minimo: number; faixa: FaixaDeSentimento; faixaDoPior: FaixaDeSentimento } | null {
  if (["closed", "resolved", "archived"].includes(conversa.status)) return null;
  // `numeric` chega do PostgREST como número ou texto, conforme a versão.
  const atual = conversa.sentimento_atual == null ? null : Number(conversa.sentimento_atual);
  if (atual === null || Number.isNaN(atual)) return null;
  const minimoLido = conversa.sentimento_minimo == null ? atual : Number(conversa.sentimento_minimo);
  const minimo = Number.isNaN(minimoLido) ? atual : Math.min(minimoLido, atual);
  return {
    atual,
    minimo,
    faixa: faixaDoSentimento(atual)!,
    faixaDoPior: faixaDoSentimento(minimo)!,
  };
}
