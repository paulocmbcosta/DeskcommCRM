"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { RecusaDoEncerramento } from "@/lib/atendimento/encerramento";
import type { Conversation } from "@/lib/types/messaging";

interface CloseArgs {
  conversation_id: string;
  expected_revision?: number;
  /** O registro do encerramento (migration 0293). `null`/ausente = não informado. */
  assunto_id?: string | null;
  resumo?: string | null;
}

/**
 * O servidor recusou o encerramento por causa do REGISTRO (assunto ou resumo)?
 *
 * É um 422 com `details.campo` — e esse erro tem lugar certo para aparecer: ao
 * lado do campo, na janela. Um toast diria "algo deu errado" sobre uma coisa que
 * a pessoa conserta em dois segundos, olhando para onde o toast não aponta.
 */
export function recusaDoServidor(err: unknown): RecusaDoEncerramento | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const campo = err.details?.campo;
  const motivo = err.details?.motivo;
  if ((campo !== "assunto" && campo !== "resumo") || typeof motivo !== "string") return null;
  if (motivo !== "obrigatorio" && motivo !== "invalido" && motivo !== "longo") return null;
  return { campo, motivo };
}

export function useCloseConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: CloseArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/close`,
        {
          expected_revision: args.expected_revision,
          assunto_id: args.assunto_id ?? null,
          resumo: args.resumo ?? null,
        },
      ),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      // A recusa do registro é mostrada pela janela, no campo. O resto é toast.
      if (!recusaDoServidor(err)) showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      // O histórico e a aba Fechadas leem `atendimentos`, que mudou agora.
      qc.invalidateQueries({ queryKey: ["atendimentos"] });
    },
  });
}

/** Reabertura explícita preserva as proteções de automação do contato. */
export function useReopenConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Pick<CloseArgs, "conversation_id" | "expected_revision">) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "open", expected_revision: args.expected_revision },
    ),
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
