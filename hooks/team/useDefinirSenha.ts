"use client";
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/**
 * Quem administra define uma senha nova para um membro
 * (`POST /api/v1/team/[user_id]/password`). As recusas aparecem no próprio
 * diálogo, pelo mesmo motivo de `useCadastrarMembro`.
 */
export function useDefinirSenha() {
  return useMutation({
    // As variáveis da mutação carregam a senha; o cache do React Query as
    // guardaria por minutos depois de a tela terminar com elas.
    gcTime: 0,
    mutationFn: async ({ userId, password }: { userId: string; password: string }) =>
      apiClient.post<{ data: { user_id: string; password_set: true } }>(
        `/api/v1/team/${userId}/password`,
        { password },
      ),
  });
}
