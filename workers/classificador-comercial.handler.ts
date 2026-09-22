/**
 * Adaptador de `workers/classificador-comercial.ts` para o dispatcher do
 * `event_log`. Registra em `message.received`, e o dispatcher roda os
 * consumidores de um evento EM SÉRIE: este fica DEPOIS dos outros
 * (lib/event-log/register-handlers.ts), para não atrasar push e automações
 * esperando o Jev.
 *
 * `retry` não conta tentativa no drain (lib/event-log/drain.ts): por isso o
 * worker tem teto pela IDADE do evento, e não pelo número de voltas.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { processarClassificacao } from "@/workers/classificador-comercial";

export const CLASSIFICADOR_COMERCIAL_HANDLER_KEY = "classificador-comercial.v1";

export const classificadorComercialHandler: EventHandler = {
  key: CLASSIFICADOR_COMERCIAL_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const consumer_key = CLASSIFICADOR_COMERCIAL_HANDLER_KEY;
    try {
      const r = await processarClassificacao(row);
      switch (r.status) {
        case "pulado":
          // Regra desligada é o caso de TODA mensagem de TODA organização que não
          // ligou o classificador: com detail, o drain o gravaria em
          // `event_log.last_error` e o campo deixaria de apontar problema.
          return r.motivo === "modo_toda_conversa"
            ? { consumer_key, status: "skipped" }
            : { consumer_key, status: "skipped", detail: r.motivo };
        case "tentar_de_novo":
          return { consumer_key, status: "retry", retry_at: r.em.toISOString(), detail: r.motivo };
        case "classificado":
          return {
            consumer_key,
            status: "ok",
            detail: `${r.criouCard ? "card" : "nao_comercial"}:${r.assunto}:${r.probabilidade.toFixed(2)}`,
          };
        case "comercial_sem_card":
          return { consumer_key, status: "ok", detail: `comercial_sem_card:${r.motivo}` };
        case "card_sem_classificar":
          return {
            consumer_key,
            status: "ok",
            detail: r.motivo ? `sem_classificar:${r.causa}:${r.motivo}` : `sem_classificar:${r.causa}`,
          };
      }
    } catch (err) {
      return { consumer_key, status: "error", detail: err instanceof Error ? err.message.slice(0, 160) : "erro" };
    }
  },
};
