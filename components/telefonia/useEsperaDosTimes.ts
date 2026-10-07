"use client";
/**
 * A espera máxima na fila do telefone de cada time — o que o seletor de
 * Configurações › Times lê e grava (migration 0295), pelas rotas
 * `GET /api/v1/telefonia/fila/times` (`{ oferecida, times }`) e
 * `PUT /api/v1/telefonia/fila/times/[teamId]` (`{ espera_maxima_s }`).
 *
 * As duas são de gerente e admin — a mesma régua da tela de Times. Uma leitura
 * serve a todos os cartões da página (a chave não leva o time). Sem polling: a
 * espera muda quando alguém a muda aqui, e a gravação relê a lista.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { EsperaDoTime, EsperaDosTimesNaResposta } from "@/lib/telefonia/espera-do-time";

export const CHAVE_DA_ESPERA_DOS_TIMES = ["telefonia", "espera-dos-times"] as const;

const URL_DA_ESPERA = "/api/v1/telefonia/fila/times";

export function useEsperaDosTimes() {
  const { activeOrg } = useAuth();
  return useQuery({
    queryKey: CHAVE_DA_ESPERA_DOS_TIMES,
    enabled: activeOrg !== null,
    staleTime: 30_000,
    queryFn: async () => (await apiClient.get<{ data: EsperaDosTimesNaResposta }>(URL_DA_ESPERA)).data,
  });
}

/** Grava a espera do time; `null` volta ao padrão. A recusa vira toast com a frase da rota. */
export function useGravarEspera() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (p: { teamId: string; esperaMaximaS: number | null }) =>
      (
        await apiClient.put<{ data: { time: EsperaDoTime } }>(`${URL_DA_ESPERA}/${encodeURIComponent(p.teamId)}`, {
          espera_maxima_s: p.esperaMaximaS,
        })
      ).data,
    onSuccess: (r) => {
      // O que a rota gravou entra na lista na hora: o seletor não volta ao valor
      // de antes enquanto a releitura não chega.
      qc.setQueryData<EsperaDosTimesNaResposta>(CHAVE_DA_ESPERA_DOS_TIMES, (antes) =>
        antes ? { ...antes, times: antes.times.map((x) => (x.team_id === r.time.team_id ? r.time : x)) } : antes,
      );
      toast.success(t("Espera máxima do telefone salva."));
    },
    onError: (e) => showApiError(e),
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE_DA_ESPERA_DOS_TIMES }),
  });
}
