"use client";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { StatusDoAtendente, StatusDoAtendenteInput } from "@/lib/atendimento/pausa";

export interface EstadoDoAtendente {
  status: StatusDoAtendente;
  paused_at: string | null;
  pause_reason: string | null;
  pause_note: string | null;
  capacity: number | null;
  current_load: number | null;
}

const CHAVE = ["atendente", "meu-status"] as const;

/** De quanto em quanto tempo o navegador avisa que a pessoa continua ali. */
export const INTERVALO_DO_SINAL_DE_VIDA_MS = 60_000;

/**
 * O status de atendimento de quem está logado + o SINAL DE VIDA.
 *
 * O sinal de vida mora AQUI, junto do status, e não na tela do inbox: quem
 * atende passa o dia entre Inbox, Funis e Contatos, e o cron derruba para
 * offline quem fica 15 minutos sem pingar. Preso ao inbox, abrir um negócio no
 * funil por vinte minutos tiraria a pessoa do rodízio sem ela saber.
 *
 * Só pinga quem está ONLINE: pausa e offline não têm o que renovar, e a rota
 * recusaria de qualquer jeito.
 */
export function useStatusDoAtendente(habilitado: boolean) {
  const qc = useQueryClient();
  const consulta = useQuery({
    queryKey: CHAVE,
    enabled: habilitado,
    queryFn: async () => (await apiClient.get<{ data: EstadoDoAtendente }>("/api/v1/attendants/me/status")).data,
    // O cron pode derrubar a pessoa para offline sem ela clicar em nada; o
    // refetch é o que faz a tela admitir isso em vez de seguir dizendo "online".
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  const online = consulta.data?.status === "online";
  useEffect(() => {
    if (!habilitado || !online) return;
    const pingar = () => {
      // Falha de rede aqui não vira toast: é tráfego de fundo, e o próximo ping
      // (ou o refetch do status) conta a verdade.
      void apiClient.post("/api/v1/attendants/me/heartbeat", {}).catch(() => undefined);
    };
    pingar();
    const id = setInterval(pingar, INTERVALO_DO_SINAL_DE_VIDA_MS);
    return () => clearInterval(id);
  }, [habilitado, online]);

  const mudar = useMutation({
    mutationFn: async (input: StatusDoAtendenteInput) =>
      apiClient.post<{ data: unknown }>("/api/v1/attendants/me/status", input),
    onError: (err) => showApiError(err),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      // O painel de Equipe lê a mesma linha do banco.
      void qc.invalidateQueries({ queryKey: ["team", "attendants"] });
    },
  });

  return { ...consulta, mudar };
}
