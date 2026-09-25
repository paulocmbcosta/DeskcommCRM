import { serviceFromMessage } from "@/lib/atendimento/origem-mensagem";
/**
 * Handler: ai-handoff-from-sentiment.v1 — o alerta de sentimento vira SINAL.
 *
 * Consome `ai.sentiment_alert` (emitido por `ai-sentiment-worker` quando a nota
 * da mensagem cai abaixo do limite do agente, `ai_agents.config.sentiment_threshold`).
 *
 * ─── Por que não transfere mais (decisão do dono, 2026-09-25) ────────────────
 * Até aqui ele chamava `triggerHandoff(reason='low_sentiment')`: calava a IA,
 * mandava a frase genérica "Esse caso é melhor resolvido por uma pessoa… ninguém
 * está disponível" e deixava a conversa SEM TIME — o atalho não sabe escolher
 * setor. Medido em produção num provedor: 42 alertas em 48 h, a maioria o
 * cliente DESCREVENDO o defeito ("Sem sinal" 0,25, "Estou sem internet" 0,20),
 * e a IA calada antes de tentar o suporte que o prompt manda.
 *
 * Agora:
 *   · quem transfere é a própria IA, no turno — `inbound-turn.ts` lê a nota da
 *     mensagem e, abaixo do limite, orienta o agente a acolher e passar para o
 *     setor que cuida do assunto (escolhendo o time);
 *   · este handler deixa o momento na LINHA DO TEMPO da conversa
 *     (`cliente_insatisfeito`), para a equipe ver — uma vez por atendimento a
 *     cada 30 min, para uma rajada de mensagens irritadas não virar dez linhas.
 *
 * Service-role bypassa RLS → toda query filtra `organization_id` programático.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { EVENTO_CLIENTE_INSATISFEITO } from "@/lib/inbox/eventos-da-conversa";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const AI_HANDOFF_FROM_SENTIMENT_KEY = "ai-handoff-from-sentiment.v1";

/** Uma linha na linha do tempo por atendimento a cada meia hora, no máximo. */
export const INTERVALO_ENTRE_REGISTROS_MS = 30 * 60_000;

export const aiHandoffFromSentimentHandler: EventHandler = {
  key: AI_HANDOFF_FROM_SENTIMENT_KEY,
  events: ["ai.sentiment_alert"],
  async handle(row): Promise<HandlerResult> {
    const messageId = (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
    const conversationIdHint = (row.payload?.["conversation_id"] as string | undefined) ?? null;
    const sentimentScore = (row.payload?.["sentiment_score"] as number | undefined) ?? null;

    if (!messageId && !conversationIdHint) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "missing_ids" };
    }

    const admin = createAdminClient();

    const boundary = messageId ? await serviceFromMessage(admin, row.organization_id, messageId) : null;
    if (!boundary || (conversationIdHint && boundary.conversation_id !== conversationIdHint)) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "service_boundary_stale" };
    }
    const conversationId = boundary.conversation_id;

    const desde = new Date(Date.now() - INTERVALO_ENTRE_REGISTROS_MS).toISOString();
    const { data: recente } = await admin
      .from("conversation_events")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("conversation_id", conversationId)
      .eq("type", EVENTO_CLIENTE_INSATISFEITO)
      .gte("created_at", desde)
      .limit(1)
      .maybeSingle();
    if (recente) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "ja_registrado_recentemente" };
    }

    // Quem responde a próxima mensagem? Se é a IA, a linha do tempo diz que ela
    // foi orientada a passar adiante — é o que a equipe precisa saber.
    const { data: conversa } = await admin
      .from("conversations")
      .select("comando_da_conversa")
      .eq("organization_id", row.organization_id)
      .eq("id", conversationId)
      .maybeSingle();
    const iaOrientada = (conversa as { comando_da_conversa?: string } | null)?.comando_da_conversa === "automatico";

    const { error } = await admin.rpc("fn_conversation_event_add", {
      p_org: row.organization_id,
      p_conversation: conversationId,
      p_type: EVENTO_CLIENTE_INSATISFEITO,
      p_payload: { sentiment_score: sentimentScore, message_id: messageId, ia_orientada: iaOrientada },
    });
    if (error) {
      logger.warn("[ai-handoff-from-sentiment] linha do tempo não gravada", {
        conversation_id: conversationId,
        detail: error.message.slice(0, 160),
      });
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "error", detail: "evento_nao_gravado" };
    }

    return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "ok", detail: "registrado_na_linha_do_tempo" };
  },
};
