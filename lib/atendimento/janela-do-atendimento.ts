/**
 * A JANELA DE UM ATENDIMENTO — a régua ÚNICA de "o que pertence a este episódio".
 *
 * A conversa é o fio do canal; o atendimento é o episódio dentro dela, com o
 * seu protocolo (migration 0266). A tela mostra UM episódio por vez, e tudo o
 * que ela desenha na linha do tempo da conversa — mensagens E notas internas —
 * tem de ser recortado pela MESMA janela.
 *
 * ─── Por que isto virou um arquivo ──────────────────────────────────────────
 *
 * A regra morava dentro do handler de mensagens. As notas internas entram no
 * mesmo `ChatThread`, intercaladas por horário, e a rota delas devolvia a
 * conversa INTEIRA: a nota escrita no atendimento do Financeiro aparecia no
 * atendimento novo do Suporte, e a nota de hoje aparecia dentro do atendimento
 * encerrado na semana passada (relatado pelo dono do produto em 2026-09-19).
 * Copiar a regra para a segunda rota criaria duas réguas, e a segunda régua
 * sempre diverge. As duas rotas chamam esta.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * A janela é `[início deste, início do próximo)`.
 *   · Fechamento NÃO é fronteira, de propósito: o que acontece DEPOIS de fechar
 *     (pesquisa de satisfação, despedida, a nota de quem registra o desfecho)
 *     pertence ao atendimento que acabou, não ao seguinte.
 *   · O PRIMEIRO episódio não tem piso: a mensagem que abre a conversa tem
 *     `sent_at` do WhatsApp, anterior ao instante em que a linha nasceu aqui.
 *   · Sem episódio nenhum (grupo, ou conversa anterior ao backfill) não há o que
 *     recortar: a conversa inteira é a resposta honesta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ATENDIMENTO_VIGENTE } from "@/lib/schemas/messaging";

export type JanelaDoAtendimento =
  /** `desde` inclusivo, `ate` exclusivo; `null` = sem limite daquele lado. */
  | { ok: true; desde: string | null; ate: string | null }
  | { ok: false; motivo: "atendimento_nao_encontrado" }
  | { ok: false; motivo: "erro_de_leitura"; detalhe: string };

/**
 * @param atendimento o literal `"vigente"` (o último episódio) ou o id de um.
 *
 * O `db` é o client de quem pergunta: com o client do USUÁRIO, a RLS de
 * `atendimentos` (herdada da conversa) decide o que ele alcança; com o admin, o
 * filtro de organização abaixo é o que isola — por isso ele é obrigatório aqui,
 * e não opcional em quem chama.
 */
export async function janelaDoAtendimento(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  atendimento: string,
): Promise<JanelaDoAtendimento> {
  const { data, error } = await db
    .from("atendimentos")
    .select("id, started_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("started_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return { ok: false, motivo: "erro_de_leitura", detalhe: error.message };

  const episodios = (data ?? []) as Array<{ id: string; started_at: string }>;
  const indice =
    atendimento === ATENDIMENTO_VIGENTE ? episodios.length - 1 : episodios.findIndex((a) => a.id === atendimento);
  if (atendimento !== ATENDIMENTO_VIGENTE && indice < 0) {
    return { ok: false, motivo: "atendimento_nao_encontrado" };
  }
  if (indice < 0) return { ok: true, desde: null, ate: null };

  return {
    ok: true,
    desde: indice > 0 ? (episodios[indice]?.started_at ?? null) : null,
    ate: episodios[indice + 1]?.started_at ?? null,
  };
}
