"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ResultadoDoDesbloqueio } from "@/lib/contacts/desbloquear";

interface UnblockArgs {
  contact_id: string;
  motivo: string;
}

/**
 * Desfaz o bloqueio de opt-out (`POST /api/v1/contacts/[id]/unblock`).
 *
 * Invalida contato E conversas: o selo "Cliente pediu para não receber
 * mensagens" do Inbox lê `contacts.is_blocked` pela lista de conversas, e
 * deixá-lo de pé depois do desbloqueio faria a tela afirmar o que já não vale.
 */
export function useUnblockContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contact_id, motivo }: UnblockArgs) =>
      apiClient.post<{ data: ResultadoDoDesbloqueio }>(`/api/v1/contacts/${contact_id}/unblock`, {
        motivo,
      }),
    onError: (err) => showApiError(err),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation"] });
    },
  });
}
