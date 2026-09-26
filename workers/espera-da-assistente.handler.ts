/**
 * Adaptador de `workers/espera-da-assistente.ts` para o dispatcher.
 * `foraDaRequisicao`: só a conversa que ESPERA gente e pode ser dispensada
 * paga o Jev fora do webhook; as outras terminam na requisição num `skipped`.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { esperaPodeSerDispensada, processarEspera } from "@/workers/espera-da-assistente";

export const ESPERA_DA_ASSISTENTE_HANDLER_KEY = "espera-da-assistente.v1";

/** Pulos de quase toda mensagem: com `detail`, o drain os gravaria em `last_error`. */
const PULOS_SILENCIOSOS: ReadonlySet<string> = new Set(["nao_e_entrada", "sem_espera", "automatico", "mantida_por_humano", "sem_chave"]);

export const esperaDaAssistenteHandler: EventHandler = {
  key: ESPERA_DA_ASSISTENTE_HANDLER_KEY,
  events: ["message.received"],
  foraDaRequisicao: (row) => esperaPodeSerDispensada(row),
  async handle(row): Promise<HandlerResult> {
    const consumer_key = ESPERA_DA_ASSISTENTE_HANDLER_KEY;
    try {
      const r = await processarEspera(row);
      switch (r.status) {
        case "pulado":
          return PULOS_SILENCIOSOS.has(r.motivo) ? { consumer_key, status: "skipped" } : { consumer_key, status: "skipped", detail: r.motivo };
        case "tentar_de_novo":
          return { consumer_key, status: "retry", retry_at: r.em.toISOString(), detail: r.motivo };
        case "pede_resposta":
          return { consumer_key, status: "ok", detail: `conta:${r.probabilidade.toFixed(2)}` };
        case "dispensada":
          return { consumer_key, status: "ok", detail: `dispensada:${r.probabilidade.toFixed(2)}` };
      }
    } catch (err) {
      return { consumer_key, status: "error", detail: err instanceof Error ? err.message.slice(0, 160) : "erro" };
    }
  },
};
