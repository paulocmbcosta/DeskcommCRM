"use client";
/**
 * O acesso da tela de Times ao `/api/v1/settings/teams`.
 *
 * A tela NÃO lê `attendance_teams` pelo Server Component. A rota já monta o par
 * `{ times, membros }` com a mesma cláusula que `fn_save_attendance_team` exige
 * — se a tela fizesse a sua própria leitura, ela ofereceria para alocar gente
 * que a RPC recusa, e o gestor levaria um 422 sem saber qual nome estava errado.
 * Uma pergunta, uma resposta, um lugar onde ela é respondida.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { TimeDeAtendimento } from "@/lib/schemas/routing";
import type { TimeDoCatalogo } from "@/lib/times/catalogo";

export interface MembroAlocavel {
  id: string;
  name: string;
}

export interface CatalogoDeTimes {
  times: TimeDoCatalogo[];
  membros: MembroAlocavel[];
}

const CHAVE = ["settings", "teams"] as const;

/** Times da org — INCLUSIVE os arquivados; é a tela que desarquiva. */
export function useTimes() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => apiClient.get<{ data: CatalogoDeTimes }>("/api/v1/settings/teams"),
    // Curto de propósito: `aberto_agora` é calculado no servidor contra o
    // relógio da requisição. Um cache longo faria a tela afirmar "aberto agora"
    // sobre um agora que já passou.
    staleTime: 15_000,
  });
}

/** Cria (`id: null`) ou atualiza um time, com os membros dele no mesmo ato. */
export function useSalvarTime() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (time: TimeDeAtendimento) =>
      apiClient.post<{ data: { id: string } }>("/api/v1/settings/teams", time),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Time salvo."));
      qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}

/** Arquiva ou desarquiva — a mesma rota nos dois sentidos. */
export function useArquivarTime() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ id, arquivar }: { id: string; arquivar: boolean }) =>
      apiClient.post<{ data: unknown }>(`/api/v1/settings/teams/${id}/archive`, { arquivar }),
    onError: (err) => showApiError(err),
    onSuccess: (_dados, { arquivar }) => {
      toast.success(
        arquivar
          ? t("Time arquivado — ele deixa de receber conversa nova.")
          : t("Time reativado — ele volta a receber conversa."),
      );
      qc.invalidateQueries({ queryKey: CHAVE });
    },
  });
}
