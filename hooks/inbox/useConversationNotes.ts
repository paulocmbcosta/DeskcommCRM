"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ATENDIMENTO_VIGENTE } from "@/lib/schemas/messaging";
import type { Note } from "@/lib/types/messaging";

/** Onda 5.2: notas internas da conversa (poucas por conversa — query simples, sem paginação). */
/**
 * As notas internas do atendimento QUE ESTÁ NA TELA.
 *
 * `atendimentoId` é o mesmo argumento de `useMessagesRealtime`, com o mesmo
 * significado: `null` é o atendimento VIGENTE, um id é um episódio antigo. As
 * duas listas entram intercaladas no `ChatThread`, então têm de ser recortadas
 * juntas — recortar só as mensagens deixava a nota do atendimento anterior
 * dentro do atendimento novo.
 *
 * A chave começa por `["notes", conversationId]` nos dois casos: criar e apagar
 * nota invalidam por esse prefixo, e o canal de tempo real também.
 */
export function useConversationNotes(conversationId: string | null, atendimentoId: string | null = null) {
  const podeConsultar = usePermission("inbox.notes.view");
  const qc = useQueryClient();
  const queryKey = ["notes", conversationId, atendimentoId ?? ATENDIMENTO_VIGENTE] as const;

  const query = useQuery({
    queryKey,
    enabled: !!conversationId && podeConsultar,
    queryFn: async () => {
      try {
        return await apiClient.get<{ data: Note[] }>(
          `/api/v1/conversations/${conversationId}/notes?atendimento_id=${atendimentoId ?? ATENDIMENTO_VIGENTE}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    select: (res) => res.data,
  });

  const onChange = useCallback(() => {
    if (conversationId) qc.invalidateQueries({ queryKey: ["notes", conversationId] });
  }, [qc, conversationId]);

  useRealtimeChannel({
    name: conversationId ? `conversation-notes-${conversationId}` : "conversation-notes-disabled",
    postgresChanges: conversationId
      ? {
          event: "*",
          schema: "public",
          table: "conversation_notes",
          filter: `conversation_id=eq.${conversationId}`,
        }
      : undefined,
    onChange,
    enabled: !!conversationId && podeConsultar,
  });

  return query.data ?? [];
}
