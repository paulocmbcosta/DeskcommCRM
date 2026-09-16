"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** O que o inbox sabe de um time — o recorte que `GET /conversations/teams` devolve. */
export interface TimeDoInbox {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** A MESMA régua que o roteador usa para decidir entrega. */
  aberto_agora: boolean;
  /** Agenda que o parser não lê ⇒ o time conta como fechado, e a tela diz por quê. */
  horario_invalido: boolean;
  /**
   * Arquivado continua na lista de propósito: arquivar não limpa
   * `conversations.team_id`, e sem ele o selo do cabeçalho não saberia nomear o
   * time de uma conversa antiga. Quem escolhe DESTINO filtra estes fora.
   */
  archived: boolean;
}

/**
 * Os times que podem receber conversa.
 *
 * Uma consulta só para as três bocas do inbox — o seletor de fila, o selo do
 * cabeçalho e o diálogo de encaminhar. O react-query dedupa pela chave, então
 * abrir o diálogo não custa uma segunda ida à rede.
 *
 * `staleTime` alto de propósito: time é cadastro, muda em escala de semanas.
 * O que muda em escala de minutos é `aberto_agora`, e é por isso que o
 * `refetchInterval` existe — sem ele, uma aba deixada aberta a noite toda
 * ofereceria "aberto" para um setor que fechou às 18h.
 */
export function useTimesDoInbox(enabled = true) {
  return useQuery({
    queryKey: ["inbox", "times"],
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: TimeDoInbox[] }>("/api/v1/conversations/teams");
      return res.data;
    },
  });
}
