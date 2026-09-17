"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

interface Args {
  conversation_id: string;
  /** `null` devolve a conversa à fila geral — é destino, não ausência de destino. */
  team_id: string | null;
}

/**
 * Encaminha a conversa para um TIME (migration 0263).
 *
 * A rota solta o dono atual e pede o roteamento, então TUDO na tela muda: o
 * dono no cabeçalho, a posição na fila e a aba em que a conversa aparece. Por
 * isso a invalidação alcança a lista e a conversa, como a transferência para
 * pessoa já faz — sem ela, a tela seguiria mostrando o dono que não existe mais.
 */
export function useTransferirParaTime() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: async (args: Args) =>
      apiClient.post<{ data: unknown }>(
        `/api/v1/conversations/${args.conversation_id}/team`,
        { team_id: args.team_id },
      ),
    onError: (err) => showApiError(err),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
      toast.success(
        args.team_id ? t("Conversa encaminhada ao time.") : t("Conversa devolvida à fila geral."),
      );
    },
  });
}
