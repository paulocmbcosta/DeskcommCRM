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

/** O que o worker leu antes de perguntar ao Jev — a dispensa só vale se nada disso mudou. */
export interface LeituraDaEspera {
  espera_desde: string;
  last_inbound_at: string;
  /** A entrada que disparou a pergunta: qualquer entrada gravada DEPOIS dela recusa a dispensa. */
  mensagem_id: string;
}

export interface DadosDaEspera {
  conversa(org: string, conversationId: string): Promise<ConversaDaEspera | null>;
  /**
   * `fn_dispensar_espera` (migration 0285): UPDATE condicional + evento
   * `espera_dispensada`, na mesma transação. `true` = dispensou.
   */
  dispensar(org: string, conversationId: string, lida: LeituraDaEspera, payload: Record<string, unknown>): Promise<boolean>;
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
    async dispensar(org, conversationId, lida, payload) {
      const { data, error } = await admin.rpc("fn_dispensar_espera", {
        p_org: org,
        p_conversation: conversationId,
        p_espera_desde: lida.espera_desde,
        p_last_inbound_at: lida.last_inbound_at,
        p_mensagem: lida.mensagem_id,
        p_payload: payload,
      });
      if (error) throw new Error(`dispensar espera: ${error.message}`);
      return data === true;
    },
  };
}
