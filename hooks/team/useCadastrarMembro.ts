"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CadastrarMembroInput } from "@/lib/schemas/team";

export interface MembroCadastrado {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  /** true = quem cadastrou era o criador provisório e saiu na entrega. */
  entregue: boolean;
  login_url: string;
}

/**
 * Cadastro direto de membro, já com senha (`POST /api/v1/team/members`).
 *
 * Sem `onError` de propósito: as recusas desta rota explicam o que fazer em
 * vez de tentar de novo ("este e-mail já tem conta — use o convite"), e isso
 * cabe melhor ao lado do formulário do que num toast que some em 4 segundos.
 */
export function useCadastrarMembro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CadastrarMembroInput) =>
      apiClient.post<{ data: MembroCadastrado }>("/api/v1/team/members", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
