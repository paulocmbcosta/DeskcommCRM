"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface ConectorAtivo {
  id: string;
  rotulo: string;
}

/**
 * Quais conectores ESTA organização ligou — é o que decide se o trilho do painel
 * da conversa ganha aba. Organização sem conector recebe `[]`.
 *
 * Falha aqui vira "nenhuma aba", em silêncio, e é de propósito: esta pergunta é
 * feita por TODA tela de inbox de TODA instalação, e um aviso de erro sobre um
 * recurso que 9 em 10 organizações nem têm seria ruído na tela de quem nunca
 * ouviu falar de conector. Quem TEM conector e ficou sem a aba descobre o porquê
 * em Configurações › Conectores, que mostra o estado da conexão.
 */
export function useConectoresAtivos() {
  return useQuery({
    queryKey: ["conectores", "ativos"],
    queryFn: async () => {
      try {
        return (await apiClient.get<{ data: ConectorAtivo[] }>("/api/v1/conectores/ativos")).data;
      } catch {
        return [] as ConectorAtivo[];
      }
    },
    staleTime: 5 * 60_000,
  });
}
