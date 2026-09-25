/**
 * EM QUAIS TIMES uma pessoa pode abrir a conversa que ela mesma inicia.
 *
 * "Chamar no WhatsApp" exige time (migration 0284): conversa começada do nosso
 * lado sem time ficava fora da vista do próprio time e sem ninguém responsável
 * por ela. A regra, pedida pelo dono do produto:
 *
 *   * `agent` que é membro de algum time → só os SEUS times;
 *   * `agent` sem time nenhum → qualquer time ativo (senão ele não conseguiria
 *     chamar cliente nenhum, e a trava viraria bloqueio);
 *   * `manager` e `admin` → qualquer time ativo.
 *
 * A mesma regra está escrita em SQL em `fn_conversation_iniciar_no_time`, que é
 * a barreira que vale; esta cópia existe para a tela oferecer só o que o banco
 * vai aceitar, e para a rota recusar ANTES de abrir a conversa. As frases de
 * `lib/times/iniciar-conversa.test.ts` medem esta; o invariante mede a do banco.
 */
import type { Role } from "@/lib/auth/types";

export interface TimeParaEscolher {
  id: string;
  archived_at: string | null;
  user_ids: string[];
}

export function timesParaIniciarConversa<T extends TimeParaEscolher>(
  times: readonly T[],
  userId: string,
  papel: Role,
): T[] {
  const ativos = times.filter((t) => t.archived_at === null);
  if (papel !== "agent") return ativos;
  const meus = ativos.filter((t) => t.user_ids.includes(userId));
  return meus.length > 0 ? meus : ativos;
}
