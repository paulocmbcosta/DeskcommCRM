"use client";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { AtendimentoFechado } from "@/app/api/v1/atendimentos/_handler";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { MeioDeCanal } from "@/lib/channels/capabilities";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

export interface FiltrosDosFechados {
  search?: string;
  channel_session_id?: string;
  /** O meio da conversa (`conversations.channel`). */
  channel?: MeioDeCanal;
  tag?: string;
  team_id?: string;
  unread?: boolean;
  /** Quem estava com a conversa NO ENCERRAMENTO: `me`, `unassigned` ou um id. */
  assigned_to?: string;
  /** Encerrados a partir deste instante (inclusivo) e antes deste (exclusivo). */
  closed_from?: string;
  closed_to?: string;
  assunto_id?: string;
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
      // Os filtros que a aba ganhou (desenho de 2026-10-08). Cada linha é a
      // metade do trabalho que o typecheck não pega: sem ela a requisição sai
      // sem o filtro e a lista volta inteira, parecendo funcionar.
      if (filtros.channel) qs.set("channel", filtros.channel);
      if (filtros.assigned_to) qs.set("assigned_to", filtros.assigned_to);
      if (filtros.closed_from) qs.set("closed_from", filtros.closed_from);
      if (filtros.closed_to) qs.set("closed_to", filtros.closed_to);
      if (filtros.assunto_id) qs.set("assunto_id", filtros.assunto_id);
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
