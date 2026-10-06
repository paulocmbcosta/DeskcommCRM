"use client";
/**
 * A FILA DO TELEFONE NA TELA (aba Telefone; migration 0295). Chamado UMA vez,
 * no `InboxLayout`; o resultado desce por props para o trilho (o selo) e para
 * a coluna da aba — duas chamadas seriam duas assinaturas do Realtime.
 *
 * Quem entrega a mudança é o Realtime de `voice_calls` (a tabela já está na
 * publicação), passando por um juntador: cada toque do worker escreve na
 * tabela, e uma rajada vira UMA releitura. A releitura a cada 15 s é a rede de
 * segurança do canal que assina e não entrega; sem telefonia na organização
 * (`ativa: false`) nada é relido nem assinado.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { criarJuntador } from "@/lib/realtime/juntar-avisos";
import type { FilaDoTelefone } from "@/lib/telefonia/fila";

export const CHAVE_DA_FILA_DO_TELEFONE = ["telefonia", "fila"] as const;
export const RELEITURA_DE_SEGURANCA_MS = 15_000;
const ESPERA_DO_JUNTADOR_MS = 400;
const INTERVALO_MINIMO_MS = 2_000;

/** A fila, mais a defasagem entre o relógio do banco e o deste navegador (ms; somar a `Date.now()`). */
export type FilaComRelogio = FilaDoTelefone & { defasagemMs: number };

/** A rota recusou QUEM lê (401 sessão, 403 acesso): reler às cegas não muda a resposta. */
const recusada = (erro: unknown) => erro instanceof ApiError && (erro.status === 401 || erro.status === 403);

export function useFilaDoTelefone() {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  const qc = useQueryClient();

  const consulta = useQuery({
    queryKey: [...CHAVE_DA_FILA_DO_TELEFONE, orgId],
    enabled: orgId !== null,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (recusada(q.state.error) || q.state.data?.ativa === false ? false : RELEITURA_DE_SEGURANCA_MS),
    queryFn: async (): Promise<FilaComRelogio> => {
      const r = await apiClient.get<{ data: FilaDoTelefone }>("/api/v1/telefonia/fila");
      // Um `agora` ilegível viraria `NaN` em TODO relógio da aba ("NaN:NaN"):
      // sem ele, vale o relógio do navegador — errado por alguns segundos, legível.
      const defasagemMs = new Date(r.data.agora).getTime() - Date.now();
      return { ...r.data, defasagemMs: Number.isFinite(defasagemMs) ? defasagemMs : 0 };
    },
  });

  const juntador = useMemo(
    () =>
      criarJuntador({
        esperaMs: ESPERA_DO_JUNTADOR_MS,
        intervaloMinimoMs: INTERVALO_MINIMO_MS,
        agir: () => void qc.invalidateQueries({ queryKey: CHAVE_DA_FILA_DO_TELEFONE }),
      }),
    [qc],
  );
  useEffect(() => () => juntador.cancelar(), [juntador]);

  const ativa = consulta.data?.ativa === true;
  useRealtimeChannel({
    name: orgId && ativa ? `telefonia-fila-${orgId}` : "telefonia-fila-desligada",
    postgresChanges:
      orgId && ativa ? { event: "*", schema: "public", table: "voice_calls", filter: `organization_id=eq.${orgId}` } : undefined,
    onChange: () => juntador.avisar(),
    enabled: Boolean(orgId) && ativa,
  });

  return consulta;
}
