/**
 * A CONVERSA DO CONTATO, vista de FORA do Inbox — e a porta que ela oferece.
 *
 * ─── Ter conversa não é estar em atendimento ────────────────────────────────
 *
 * A conversa é uma só por contato × número, e é permanente: o que abre e fecha
 * é o ATENDIMENTO, um episódio dentro dela (migration 0266). As telas de fora do
 * Inbox — lista de contatos, ficha do contato, ficha do negócio — decidiam o que
 * oferecer pela EXISTÊNCIA da conversa: tem conversa → "abrir no Inbox"; não tem
 * → "Chamar no WhatsApp". Antes de o atendimento virar episódio, as duas
 * perguntas tinham a mesma resposta. Deixaram de ter, e a tela não acompanhou.
 *
 * Medido em produção em 2026-10-05: de 741 contatos com conversa, em 692 a mais
 * recente estava encerrada. Para todos eles o ícone levava ao atendimento que
 * acabou — onde os gestos disponíveis ("Reabrir" e o seletor de modelo) escrevem
 * no atendimento encerrado, com o protocolo antigo. O caminho que abre
 * atendimento novo, com protocolo novo e dono (`POST /conversations/iniciar`),
 * existia e nenhuma tela chegava nele.
 *
 * ─── Por que o anexador mora aqui, e não em cada rota ───────────────────────
 *
 * Eram duas cópias da mesma função (`withConversas`), uma na rota de contatos e
 * outra na do quadro, e a decisão da tela depende de um campo que as duas
 * precisam trazer. Uma cópia que esquecesse o `status` deixaria aquela tela com
 * o defeito e todas as outras verdes.
 */

/** O que as duas rotas pedem ao banco. Sem `status`, a tela não distingue os estados. */
export const COLUNAS_DA_CONVERSA_DO_CONTATO =
  "id, contact_id, status, channel_session_id, last_message_preview, last_message_at, unread_count_for_assignee";

export interface LinhaDaConversaDoContato {
  id: string;
  contact_id: string;
  status: string;
  channel_session_id: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  unread_count_for_assignee: number | null;
}

/** Derivado (não é coluna): a conversa mais recente do contato. */
export interface ConversaDoContato {
  id: string;
  /** O que a lista do inbox mostra: última mensagem, já truncada na origem. */
  preview: string | null;
  last_message_at: string | null;
  unread: number;
  /** Estado da conversa. Encerrado = o atendimento acabou; ver `portaDaConversa`. */
  status: string;
  /** O número por onde essa conversa acontece — o padrão ao chamar de novo. */
  channel_session_id: string | null;
}

/**
 * A conversa mais recente de cada contato.
 *
 * Espera as linhas JÁ ordenadas da mais recente para a mais antiga (as duas
 * rotas ordenam por `last_message_at desc`): a primeira de cada contato vence.
 */
export function conversaMaisRecentePorContato(
  linhas: readonly LinhaDaConversaDoContato[],
): Map<string, ConversaDoContato> {
  const porContato = new Map<string, ConversaDoContato>();
  for (const linha of linhas) {
    if (porContato.has(linha.contact_id)) continue;
    porContato.set(linha.contact_id, {
      id: linha.id,
      preview: linha.last_message_preview,
      last_message_at: linha.last_message_at,
      unread: linha.unread_count_for_assignee ?? 0,
      status: linha.status,
      channel_session_id: linha.channel_session_id,
    });
  }
  return porContato;
}

const ENCERRADOS: ReadonlySet<string> = new Set(["closed", "resolved", "archived"]);

/**
 * O atendimento desta conversa acabou?
 *
 * Estado ausente ou desconhecido NÃO conta como encerrado: oferecer "chamar"
 * para quem está em atendimento é o erro caro — a pessoa escreveria por fora de
 * quem está atendendo. Na dúvida, a tela leva para a conversa.
 */
export function conversaEncerrada(status: string | null | undefined): boolean {
  return typeof status === "string" && ENCERRADOS.has(status);
}

/**
 * O que a tela oferece para falar com o contato:
 *
 *   - `abrir`          — há atendimento em andamento; responde-se lá;
 *   - `chamar`         — nunca houve conversa;
 *   - `chamar_de_novo` — o último atendimento foi encerrado: começa outro, com
 *                        protocolo próprio, e o anterior fica no histórico.
 */
export type PortaDaConversa = "abrir" | "chamar" | "chamar_de_novo";

export function portaDaConversa(
  conversa: { status?: string | null } | null | undefined,
): PortaDaConversa {
  if (!conversa) return "chamar";
  return conversaEncerrada(conversa.status) ? "chamar_de_novo" : "abrir";
}
