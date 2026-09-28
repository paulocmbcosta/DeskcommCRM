/**
 * O FIM DA LIGAÇÃO DE SAÍDA QUE NINGUÉM ATENDEU — por que acabou, e o que o
 * atendente lê na tela (spec 20 §4.2 e §7).
 *
 * Puro e sem dependência: o worker (`controle.ts`) usa para decidir o desfecho
 * e gravar o motivo em `voice_calls.end_reason`; o navegador
 * (`TelefoniaContext`) usa para transformar esse motivo em aviso. O vocabulário
 * mora aqui para as duas pontas não divergirem.
 *
 * ─── O que foi medido ──────────────────────────────────────────────────────
 *
 * Produção, 2026-09-28, operadora Totus (FreeSWITCH): discar `61995140098` sem
 * o 0 que a operadora pede voltou `404 Not Found` com
 * `Reason: Q.850;cause=16` em 0,2 s — e a ligação virou `sem_resposta`, motivo
 * `rede_undefined`, sem nada na tela do atendente. Reproduzido num Asterisk
 * 20.11.1 local (a mesma imagem, `deskcomm-asterisk`) com uma operadora falsa
 * que responde exatamente isso. A ARI entrega, nesta ordem e no mesmo
 * milissegundo:
 *
 *   ChannelHangupRequest  — SEM `cause`
 *   StasisEnd             — sem causa (o evento não tem o campo)
 *   ChannelDestroyed      — cause 16, "Normal Clearing"
 *
 * e nenhum `Dial` com status final: só o `dialstatus: ""` do início. Nenhum
 * `tech_cause` (o código SIP) no Asterisk 20.11. Duas conclusões:
 *
 *   1. A causa, sozinha, não separa "a operadora recusou" de "acabou normal":
 *      a operadora mandou 16 junto com o 404, e o Asterisk honra o `Reason`.
 *      O que separa é a perna NUNCA ter tocado (nenhum `Dial` RINGING ou
 *      PROGRESS). Na mesma medida, `180` + `480` depois de 4 s chegou como
 *      RINGING e cause 19; `486` chegou sem toque, cause 17.
 *   2. O `rede_undefined` era o `StasisEnd` (que chega antes e não tem causa)
 *      lido como se tivesse.
 */

/** Causa Q.850 de linha ocupada. */
const CAUSA_OCUPADO = 17;

/** Causas Q.850 que querem dizer "a rede recusou", não "ninguém atendeu". */
const CAUSAS_DE_RECUSA = new Set([1, 3, 20, 21, 22, 27, 28, 34, 38, 41, 42, 47, 58, 88, 102, 111, 127]);

/**
 * O começo de `voice_calls.end_reason` da saída que acabou pelo lado da rede
 * antes de alguém atender. O número Q.850 vem depois, para diagnóstico
 * (`nao_completada_16`).
 */
export const FIM_DA_SAIDA = {
  naoCompletada: "nao_completada",
  ocupado: "ocupado",
  semResposta: "sem_resposta",
} as const;

/** Recusas do próprio worker antes de discar que o atendente precisa saber. */
export const RECUSA_DA_SAIDA = {
  troncoIndisponivel: "tronco_indisponivel",
  troncoConfiguracaoInvalida: "tronco_configuracao_invalida",
} as const;

export type DesfechoDaSaidaNaoAtendida = "recusada_pela_rede" | "sem_resposta";

/**
 * A perna da operadora acabou sem ninguém atender: desfecho (o que a conversa
 * registra) e motivo (o que `end_reason` guarda e a tela traduz).
 *
 * `tocou` = chegou `Dial` RINGING (180) ou PROGRESS (183) antes do fim.
 */
export function fimDaSaidaNaoAtendida(p: { causa: number; tocou: boolean }): {
  desfecho: DesfechoDaSaidaNaoAtendida;
  motivo: string;
} {
  if (p.causa === CAUSA_OCUPADO) return { desfecho: "sem_resposta", motivo: `${FIM_DA_SAIDA.ocupado}_${p.causa}` };
  // Nunca tocou: a rede não completou, qualquer que seja a causa — inclusive a
  // 16 "normal" que a operadora mandou junto com o 404 da medida acima.
  if (!p.tocou || CAUSAS_DE_RECUSA.has(p.causa)) {
    return { desfecho: "recusada_pela_rede", motivo: `${FIM_DA_SAIDA.naoCompletada}_${p.causa}` };
  }
  return { desfecho: "sem_resposta", motivo: `${FIM_DA_SAIDA.semResposta}_${p.causa}` };
}

/**
 * O aviso que o atendente lê quando a ligação que ELE fez acaba sem ninguém
 * atender. Texto em português — é a chave do dicionário (`t()` na tela).
 * `null`: nada a avisar (atendida, ou ele mesmo desligou).
 */
export function avisoDoFimDaSaida(l: { end_reason: string | null; answered_at: string | null }): string | null {
  if (l.answered_at) return null;
  const motivo = l.end_reason ?? "";
  if (motivo.startsWith(`${FIM_DA_SAIDA.naoCompletada}_`)) {
    return "A operadora não completou a ligação. Confira o número e o prefixo de discagem do número SIP.";
  }
  if (motivo.startsWith(`${FIM_DA_SAIDA.ocupado}_`)) return "O número chamado está ocupado.";
  if (motivo.startsWith(`${FIM_DA_SAIDA.semResposta}_`)) return "Ninguém atendeu.";
  if (motivo === RECUSA_DA_SAIDA.troncoConfiguracaoInvalida) {
    return "O prefixo de discagem do número da empresa é inválido. Revise em Conexões › Telefone.";
  }
  if (motivo === RECUSA_DA_SAIDA.troncoIndisponivel) return "O número da empresa usado nesta ligação não está disponível agora.";
  return null;
}
