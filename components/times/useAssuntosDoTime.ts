"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { CHAVE_DAS_OPCOES_DE_ENCERRAMENTO } from "@/hooks/inbox/useOpcoesDeEncerramento";
import { apiClient } from "@/lib/api/client";
import type { AssuntoCadastrado } from "@/lib/atendimento/assuntos";

const chave = (timeId: string) => ["settings", "teams", "assuntos", timeId] as const;

/** Os assuntos de encerramento de UM time, com os arquivados (migration 0293). */
export function useAssuntosDoTime(timeId: string) {
  return useQuery({
    queryKey: chave(timeId),
    queryFn: async () =>
      (await apiClient.get<{ data: AssuntoCadastrado[] }>(`/api/v1/settings/teams/${timeId}/assuntos`)).data,
    staleTime: 30_000,
  });
}

/** Depois de qualquer mudança: a lista do time e o que a janela de encerramento oferece. */
function useAtualizar(timeId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: chave(timeId) });
    void qc.invalidateQueries({ queryKey: CHAVE_DAS_OPCOES_DE_ENCERRAMENTO });
  };
}

export function useCriarAssunto(timeId: string) {
  const atualizar = useAtualizar(timeId);
  const t = useT();
  return useMutation({
    mutationFn: async (name: string) =>
      apiClient.post<{ data: AssuntoCadastrado }>(`/api/v1/settings/teams/${timeId}/assuntos`, { name }),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Assunto adicionado."));
      atualizar();
    },
  });
}

export function useAlterarAssunto(timeId: string) {
  const atualizar = useAtualizar(timeId);
  const t = useT();
  return useMutation({
    mutationFn: async ({ id, ...mudanca }: { id: string; name?: string; archived?: boolean }) =>
      apiClient.patch<{ data: unknown }>(`/api/v1/settings/teams/${timeId}/assuntos/${id}`, mudanca),
    onError: (err) => showApiError(err),
    onSuccess: (_dados, mudanca) => {
      toast.success(
        mudanca.archived === true
          ? t("Assunto arquivado — ele sai da janela de encerramento.")
          : mudanca.archived === false
            ? t("Assunto reativado.")
            : t("Assunto renomeado."),
      );
      atualizar();
    },
  });
}
