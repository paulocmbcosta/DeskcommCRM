"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { OpcoesDeEncerramento } from "@/lib/atendimento/encerramento";

export const CHAVE_DAS_OPCOES_DE_ENCERRAMENTO = ["encerramento", "opcoes"] as const;

/**
 * O que a janela de encerramento precisa para abrir: os dois interruptores da
 * organização e os assuntos por time (migration 0293).
 *
 * Só busca quando a janela abre — o inbox inteiro não paga a consulta por uma
 * porta que se abre uma vez por atendimento. Um minuto de validade: o cadastro
 * muda raramente, e quem aplica a regra é o banco de qualquer forma.
 */
export function useOpcoesDeEncerramento(enabled: boolean) {
  return useQuery({
    queryKey: CHAVE_DAS_OPCOES_DE_ENCERRAMENTO,
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      (await apiClient.get<{ data: OpcoesDeEncerramento }>("/api/v1/atendimentos/assuntos")).data,
  });
}
