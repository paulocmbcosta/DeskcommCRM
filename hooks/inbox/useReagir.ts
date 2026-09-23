"use client";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Message } from "@/lib/types/messaging";

type Paginas = InfiniteData<{ data: Message[] }>;

/** Troca (ou tira, com `""`) a reação do nosso lado numa mensagem do cache. */
function comReacao(m: Message, emoji: string, userId: string | null): Message {
  const meta = { ...(m.metadata ?? {}) } as Record<string, unknown>;
  const reacoes = { ...((meta.reacoes as Record<string, unknown> | undefined) ?? {}) };
  if (emoji)
    reacoes.empresa = {
      emoji,
      em: new Date().toISOString(),
      ...(userId ? { user_id: userId } : {}),
    };
  else delete reacoes.empresa;
  meta.reacoes = reacoes;
  return { ...m, metadata: meta };
}

/**
 * O atendente reage com emoji a uma mensagem (DYD-16).
 *
 * OTIMISTA: a reação aparece no balão no clique, como no celular. Se o canal
 * recusar (janela fechada, erro da plataforma), o cache volta ao que era e o
 * motivo aparece no toast — nunca fica na tela uma reação que não saiu.
 */
export function useReagir(conversationId: string | null, userId: string | null) {
  const qc = useQueryClient();
  const chave = ["messages", conversationId] as const;
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      apiClient.post(`/api/v1/messages/${messageId}/reaction`, { emoji }),
    onMutate: async ({ messageId, emoji }) => {
      await qc.cancelQueries({ queryKey: chave });
      const antes = qc.getQueryData<Paginas>(chave);
      if (antes) {
        qc.setQueryData<Paginas>(chave, {
          ...antes,
          pages: antes.pages.map((p) => ({
            ...p,
            data: p.data.map((m) => (m.id === messageId ? comReacao(m, emoji, userId) : m)),
          })),
        });
      }
      return { antes };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.antes) qc.setQueryData(chave, ctx.antes);
      showApiError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["messages", conversationId] }),
  });
}
