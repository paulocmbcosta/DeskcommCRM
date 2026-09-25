/**
 * QUEM DEVOLVEU A CONVERSA À FILA NÃO A RECEBE DE VOLTA PELO RODÍZIO.
 *
 * Pedido do dono (2026-09-25), para a troca de turno: o atendente que vai
 * embora com um atendimento aberto encaminha a conversa para a fila do PRÓPRIO
 * time (`fn_conversation_set_team`, que solta o dono e cala a IA), e o rodízio
 * entrega ao próximo atendente do turno que entra. Sem esta regra, se ele
 * continuasse "Disponível", o rodízio podia devolver a conversa a ele mesmo no
 * minuto seguinte — ele seria o menos carregado do time, justamente porque
 * acabou de soltar a conversa.
 *
 * A regra lê o RASTRO que já existe, sem coluna nova: o último evento de
 * atribuição da conversa. Se ele é um encaminhamento para time
 * (`team_transfer`) que soltou alguém, esse alguém fica fora dos elegíveis
 * DESTA conversa. Assim que outra pessoa a recebe, o último evento passa a ser
 * outro e a exclusão acaba sozinha — não há estado para limpar. E ela vale só
 * dentro do ATENDIMENTO em curso: evento anterior a `service_started_at` é de
 * um atendimento que já fechou, e o cliente que volta dias depois não deixa de
 * poder cair com quem o atendeu da outra vez.
 *
 * Se ele for o único elegível, a conversa ESPERA na fila do time (e aparece no
 * termômetro) até alguém do turno ficar disponível. É o que ele pediu ao
 * devolver: nada impede que ele mesmo a assuma de novo pelo botão "Assumir".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface UltimoEventoDeAtribuicao {
  reason: string;
  from_user_id: string | null;
  to_user_id: string | null;
}

/** Pura: quem fica fora do rodízio desta conversa, ou `null`. */
export function quemDevolveuAFila(ultimo: UltimoEventoDeAtribuicao | null): string | null {
  if (!ultimo) return null;
  if (ultimo.reason !== "team_transfer") return null;
  if (ultimo.to_user_id !== null) return null;
  return ultimo.from_user_id;
}

/** Lê o último evento de atribuição da conversa (service role; org filtrada à mão). */
export async function carregarQuemDevolveu(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  /** Início do atendimento em curso (`conversations.service_started_at`). */
  desde: string | null,
): Promise<string | null> {
  let consulta = admin
    .from("conversation_assignment_events")
    .select("reason, from_user_id, to_user_id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId);
  if (desde) consulta = consulta.gte("created_at", desde);
  const { data, error } = await consulta
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`conversation_assignment_events: ${error.message}`);
  return quemDevolveuAFila((data as UltimoEventoDeAtribuicao | null) ?? null);
}
