"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AssuntosDoPeriodo } from "@/lib/metrics/assuntos";

export interface AssuntosMetrics extends AssuntosDoPeriodo {
  from: string;
  to: string;
}

/** Do que os atendimentos encerrados no período trataram (migration 0293). manager+. */
export function useAssuntosMetrics(periodo: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "assuntos", periodo.from, periodo.to],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const qs = new URLSearchParams({ from: periodo.from, to: periodo.to });
      return (await apiClient.get<{ data: AssuntosMetrics }>(`/api/v1/metrics/assuntos?${qs.toString()}`)).data;
    },
  });
}
