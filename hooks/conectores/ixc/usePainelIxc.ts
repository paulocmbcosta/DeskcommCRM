"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { EstadoDoPainelIxc } from "@/lib/conectores/ixc/painel";

/**
 * O prazo do painel é o do ERP, não o do produto: são duas ondas de chamadas ao
 * IXC com 12 s de prazo cada. Os 10 s padrão do `apiClient` cortariam uma
 * resposta que estava a caminho e mostrariam erro num ERP apenas lento.
 */
const PRAZO_DO_ERP_MS = 35_000;

const chave = (contactId: string | null, cadastro: string | null) => ["conector", "ixc", contactId, cadastro] as const;

export function usePainelIxc(contactId: string | null, cadastro: string | null) {
  return useQuery({
    queryKey: chave(contactId, cadastro),
    enabled: !!contactId,
    queryFn: async () => {
      const qs = cadastro ? `?cadastro=${encodeURIComponent(cadastro)}` : "";
      return (
        await apiClient.get<{ data: EstadoDoPainelIxc }>(`/api/v1/contacts/${contactId}/conectores/ixc${qs}`, {
          timeoutMs: PRAZO_DO_ERP_MS,
        })
      ).data;
    },
    // Um minuto: fechar e reabrir a aba não paga as ~3 s do ERP de novo, e o
    // botão "Atualizar" está à mão para quem acabou de ouvir "já paguei".
    staleTime: 60_000,
    retry: false,
  });
}

export function useVincularIxc(contactId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (corpo: { cadastro_id: string } | { documento: string }) =>
      apiClient.post<{ data: { cadastros: string[] } }>(`/api/v1/contacts/${contactId}/conectores/ixc/vinculo`, corpo, {
        timeoutMs: PRAZO_DO_ERP_MS,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conector", "ixc", contactId] }),
  });
}

export function useDesvincularIxc(contactId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cadastro: string) =>
      apiClient.delete<{ data: { removido: boolean } }>(
        `/api/v1/contacts/${contactId}/conectores/ixc/vinculo?cadastro=${encodeURIComponent(cadastro)}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conector", "ixc", contactId] }),
  });
}

export function useEnviarFaturaIxc(contactId: string | null) {
  return useMutation({
    mutationFn: ({ faturaId, conversationId }: { faturaId: string; conversationId: string }) =>
      apiClient.post<{ data: { mensagens_enviadas: number; mensagens_previstas: number } }>(
        `/api/v1/contacts/${contactId}/conectores/ixc/faturas/${encodeURIComponent(faturaId)}/enviar`,
        { conversation_id: conversationId },
        { timeoutMs: PRAZO_DO_ERP_MS },
      ),
  });
}
