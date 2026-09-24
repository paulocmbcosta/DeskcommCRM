"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FilaDoTime } from "@/lib/inbox/fila-do-time";

/**
 * POR QUE a fila de cada time não anda — a dica do chip de Todas.
 *
 * Só pergunta quando há fila (`enabled`): a rota calcula elegibilidade por time,
 * a mesma conta do roteador, e não há motivo para pagá-la com a fila vazia. Um
 * minuto de validade é o ritmo do próprio roteador (cron de 1 em 1 minuto).
 */
export function useFilaDosTimes(enabled: boolean) {
  return useQuery({
    queryKey: ["inbox", "times", "fila"],
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
    queryFn: async () => {
      const res = await apiClient.get<{ data: FilaDoTime[] }>("/api/v1/conversations/teams/fila");
      return res.data;
    },
  });
}
