"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * "Contar mesmo assim": religa a espera que a Assistente dispensou
 * (`POST /api/v1/conversations/[id]/manter-espera`, migration 0285).
 *
 * Invalida a lista (o termômetro volta ao card), a conversa aberta (a faixa) e
 * a linha do tempo do painel (o evento `espera_mantida` entra nela).
 */
export function useManterEspera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) =>
      apiClient.post<{ data: unknown }>(`/api/v1/conversations/${conversationId}/manter-espera`, {}),
    onError: (err) => showApiError(err),
    onSuccess: (_data, conversationId) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversa", "linha-do-tempo", conversationId] });
    },
  });
}
