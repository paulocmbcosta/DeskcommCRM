/**
 * O banco da espera da Assistente. Service role: TODA consulta filtra
 * `organization_id` (vem do evento, fonte confiável — nunca de payload externo).
 * Erro de banco LANÇA: o drain aplica backoff.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversaDaEspera {
  espera_desde: string | null;
  last_inbound_at: string | null;
  espera_mantida_em: string | null;
  comando_da_conversa: string | null;
  status: string;
}

export interface DadosDaEspera {
  conversa(org: string, conversationId: string): Promise<ConversaDaEspera | null>;
  /** UPDATE condicional: só dispensa se a espera e a última entrada ainda são as lidas. `true` = dispensou. */
  dispensar(org: string, conversationId: string, lida: { espera_desde: string; last_inbound_at: string }): Promise<boolean>;
  registrarEvento(org: string, conversationId: string, payload: Record<string, unknown>): Promise<void>;
}

export function dadosDaEsperaViaSupabase(admin: SupabaseClient): DadosDaEspera {
  return {
    async conversa(org, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("espera_desde, last_inbound_at, espera_mantida_em, comando_da_conversa, status")
        .eq("organization_id", org)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(`conversa da espera: ${error.message}`);
      return (data as ConversaDaEspera | null) ?? null;
    },
    async dispensar(org, conversationId, lida) {
      const { data, error } = await admin
        .from("conversations")
        .update({
          espera_dispensada_desde: lida.espera_desde,
          espera_dispensada_ate: lida.last_inbound_at,
          espera_desde: null,
        })
        .eq("organization_id", org)
        .eq("id", conversationId)
        .eq("espera_desde", lida.espera_desde)
        .eq("last_inbound_at", lida.last_inbound_at)
        .is("espera_mantida_em", null)
        .select("id");
      if (error) throw new Error(`dispensar espera: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async registrarEvento(org, conversationId, payload) {
      const { error } = await admin.rpc("fn_conversation_event_add", {
        p_org: org,
        p_conversation: conversationId,
        p_type: "espera_dispensada",
        p_payload: payload,
      });
      if (error) throw new Error(`evento espera_dispensada: ${error.message}`);
    },
  };
}
