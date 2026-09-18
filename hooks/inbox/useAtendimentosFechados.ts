"use client";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { AtendimentoFechado } from "@/app/api/v1/atendimentos/_handler";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

export interface FiltrosDosFechados {
  search?: string;
  channel_session_id?: string;
  tag?: string;
  team_id?: string;
  unread?: boolean;
}

interface Pagina {
  data: AtendimentoFechado[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

/**
 * Os atendimentos ENCERRADOS — a lista da aba "Fechadas".
 *
 * A chave começa por `"conversations"` de propósito: fechar, reabrir e a chegada
 * de mensagem já invalidam `["conversations"]` (os hooks de comando e o canal de
 * tempo real da lista), e o atendimento encerrado muda exatamente nesses
 * momentos. Pegar carona no prefixo evita um segundo canal só para esta aba.
 */
export function useAtendimentosFechados(filtros: FiltrosDosFechados, habilitado: boolean) {
  return useInfiniteQuery({
    queryKey: ["conversations", "atendimentos-fechados", filtros] as const,
    enabled: habilitado,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ status: "closed", limit: "50" });
      if (pageParam) qs.set("cursor", pageParam);
      // A tela não pede o que a rota descarta: uma letra só não é busca.
      if (filtros.search && buscaValeConsulta(filtros.search)) qs.set("search", filtros.search);
      if (filtros.channel_session_id) qs.set("channel_session_id", filtros.channel_session_id);
      if (filtros.tag) qs.set("tag", filtros.tag);
      if (filtros.team_id) qs.set("team_id", filtros.team_id);
      if (filtros.unread) qs.set("unread", "true");
      try {
        return await apiClient.get<Pagina>(`/api/v1/atendimentos?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (ultima) => (ultima.meta?.has_more && ultima.meta.cursor ? ultima.meta.cursor : undefined),
    refetchOnWindowFocus: true,
  });
}
