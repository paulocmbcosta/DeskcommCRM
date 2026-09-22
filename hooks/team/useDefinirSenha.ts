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
    mutationFn: async ({ userId, password }: { userId: string; password: string }) =>
      apiClient.post<{ data: { user_id: string; password_set: true } }>(
        `/api/v1/team/${userId}/password`,
        { password },
      ),
  });
}
