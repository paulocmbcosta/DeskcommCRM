"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FormaDeCobranca } from "@/lib/conectores/ixc/faturas";
import type { EstadoDoPainelIxc } from "@/lib/conectores/ixc/painel";

/**
 * O prazo do painel é o do ERP, não o do produto: são duas ondas de chamadas ao
 * IXC com 12 s de prazo cada. Os 10 s padrão do `apiClient` cortariam uma
 * resposta que estava a caminho e mostrariam erro num ERP apenas lento.
 */
const PRAZO_DO_ERP_MS = 35_000;

const chave = (contactId: string | null, cadastro: string | null) => ["conector", "ixc", contactId, cadastro] as const;

export function usePainelIxc(contactId: string | null, cadastro: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: [...chave(contactId, cadastro), conversationId] as const,
    enabled: !!contactId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (cadastro) qs.set("cadastro", cadastro);
      if (conversationId) qs.set("conversa", conversationId);
      // `URLSearchParams.prototype.size` não existe no Safari 16.x — `toString()`
      // vale em qualquer motor.
      const s = qs.toString();
      const sufixo = s ? `?${s}` : "";
      return (
        await apiClient.get<{ data: EstadoDoPainelIxc }>(`/api/v1/contacts/${contactId}/conectores/ixc${sufixo}`, {
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

/**
 * O prazo de ENVIAR é maior que o de ler: relê a fatura, baixa o PDF (ou o Pix)
 * do IXC, sobe o arquivo e manda duas mensagens pelo canal, uma depois da outra.
 */
const PRAZO_DE_ENVIAR_MS = 60_000;

export function useEnviarFaturaIxc(contactId: string | null) {
  return useMutation({
    mutationFn: ({ faturaId, conversationId, forma }: { faturaId: string; conversationId: string; forma: FormaDeCobranca }) =>
      apiClient.post<{ data: { forma: FormaDeCobranca; mensagens_enviadas: number; mensagens_previstas: number } }>(
        `/api/v1/contacts/${contactId}/conectores/ixc/faturas/${encodeURIComponent(faturaId)}/enviar`,
        { conversation_id: conversationId, forma },
        { timeoutMs: PRAZO_DE_ENVIAR_MS },
      ),
  });
}
