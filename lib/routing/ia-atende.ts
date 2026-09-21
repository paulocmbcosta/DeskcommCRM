/**
 * A IA vai atender esta conversa? — a pergunta que o rodízio faz ANTES de distribuir.
 *
 * Medido em produção em 2026-09-21 (v1.34.1, organização em `round_robin`): o cron
 * de roteamento entregava ao atendente online a conversa que a IA ia atender, e o
 * motor pulava o turno por `conversa_de_humano`. Com alguém online, a IA não
 * respondia ninguém.
 *
 * O fluxo definido pelo dono do produto: a IA atende primeiro; a conversa só entra
 * no rodízio quando sai da IA. As duas metades da resposta são as MESMAS que o
 * motor usa para decidir se responde — é isso que impede o rodízio e o motor de
 * discordarem sobre quem atende:
 *
 *   1. há IA AUTOMÁTICA no ar no canal da conversa? — `fn_ia_automatica_no_canal`
 *      (migration 0273), a régua de `no-ar.ts` mais a ligação versão/roteador ↔
 *      canal que o portão de capacidade do drain já exige;
 *   2. a conversa passa na trava de elegibilidade? — `decidirElegibilidade`, a
 *      regra pura de `gate.ts`, via o transporte supabase-js. Ela diz NÃO para a
 *      conversa que já passou para humano (silêncio `infinity`, `force_human`), e é
 *      por isso que a conversa transferida para um time É distribuída.
 *
 * Erro em qualquer metade LANÇA: o worker trata como falha do evento (volta para a
 * fila). Atribuir às cegas tiraria a conversa da IA por causa de uma consulta
 * que caiu — o defeito que isto conserta, entrando pela porta do erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";

export async function iaAtendeAConversa(
  admin: SupabaseClient,
  input: { organizationId: string; conversationId: string; channelSessionId: string | null; agora: Date },
): Promise<boolean> {
  // Sem canal não há agente ligado a ele; o carregador de elegíveis já trata o
  // canal inválido do jeito dele (aviso na Central).
  if (!input.channelSessionId) return false;

  const { data: iaNoCanal, error } = await admin.rpc("fn_ia_automatica_no_canal", {
    p_org: input.organizationId,
    p_channel: input.channelSessionId,
  });
  if (error) throw new Error(`fn_ia_automatica_no_canal: ${error.message}`);
  if (iaNoCanal !== true) return false;

  const decisao = await decidirElegibilidadeDaConversaViaSupabase(admin, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    agora: input.agora,
    ttlMs: ttlDaAutorizacaoMs(process.env),
  });
  return decisao?.permite === true;
}
