/**
 * Adapter that exposes `ai-sentiment-worker` to the event_log dispatcher.
 *
 * Registra em `message.received`. A cada mensagem do cliente, o Jev avalia o
 * atendimento em aberto inteiro (ver o worker). `retry` só em dois casos, os
 * dois com teto pela IDADE do evento (o drain não conta tentativa de `retry`):
 * áudio ainda virando texto e falha temporária do Jev.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { processSentiment } from "@/workers/ai-sentiment-worker";

export const AI_SENTIMENT_HANDLER_KEY = "ai-sentiment-worker.v1";

/** Pulos de quase toda mensagem: com `detail`, o drain os gravaria em `last_error`. */
const PULOS_DE_ROTINA: ReadonlySet<string> = new Set(["not_inbound", "coberta_por_mensagem_mais_nova"]);

export const aiSentimentHandler: EventHandler = {
  key: AI_SENTIMENT_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const consumer_key = AI_SENTIMENT_HANDLER_KEY;
    const result = await processSentiment(row);
    if (result.retryAt) {
      return { consumer_key, status: "retry", retry_at: result.retryAt.toISOString(), detail: result.reason };
    }
    if (!result.skipped) {
      return { consumer_key, status: "ok", detail: String(result.sentiment_score ?? "") };
    }
    return PULOS_DE_ROTINA.has(result.reason ?? "")
      ? { consumer_key, status: "skipped" }
      : { consumer_key, status: "skipped", detail: result.reason };
  },
};
