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
 *
 * ─── A carga, e por que a folga é a que é ──────────────────────────────────
 *
 * Os números são da revisão independente da entrega (estimados, não medidos em
 * produção): cada pedido à rota da fila custa cerca de cinco chamadas ao
 * Supabase só para autenticar (`requireRole`), e isso NÃO se divide entre
 * navegadores — a leitura compartilhada da rota (1,5 s por organização) vem
 * DEPOIS da autenticação e poupa só o banco da fila. Com o worker escrevendo em
 * `voice_calls` a cada toque, cada navegador relia até uma vez a cada 2 s:
 * 20 navegadores ≈ 10 pedidos/s ≈ 50 chamadas/s ao Supabase, justamente no
 * pico. É a forma do incidente de 2026-09-24 (cabeçalho de
 * `lib/realtime/juntar-avisos.ts`): cada aviso virando N × releitura.
 *
 * Por isso:
 *  - a folga é larga — 800 ms de espera, e no máximo UMA releitura a cada 4 s
 *    por navegador. O que atrasa com isso é só a ESTRUTURA da fila (quem entrou,
 *    quem saiu, quem toca); os relógios da tela andam sozinhos, sem leitura;
 *  - a aba ESCONDIDA não relê. O aviso que chega com a aba fora da tela marca o
 *    dado como velho, sem pedido nenhum, e quem relê é a volta do foco
 *    (`refetchOnWindowFocus`). O atendente com o CRM numa aba de fundo deixa de
 *    custar um pedido a cada 4 s por uma fila que ele não está olhando. A rede
 *    de segurança de 15 s também não roda em aba escondida.
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
/** Quanto o primeiro aviso espera pelos seguintes antes de reler. */
const ESPERA_DO_JUNTADOR_MS = 800;
/** O mínimo entre duas releituras pedidas pelo tempo real, por navegador. */
const INTERVALO_MINIMO_MS = 4_000;

/** A fila, mais a defasagem entre o relógio do banco e o deste navegador (ms; somar a `Date.now()`). */
export type FilaComRelogio = FilaDoTelefone & { defasagemMs: number };

/**
 * A aba deste navegador está fora da tela? Só se pergunta DENTRO de um aviso ou
 * de um relógio — nunca no desenho: no servidor não há `document`, e a resposta
 * muda sem o React saber.
 */
const abaEscondida = () => typeof document !== "undefined" && document.visibilityState === "hidden";

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
    // Dito com todas as letras, e não herdado do padrão: a rede de segurança de
    // 15 s NÃO roda com a aba escondida — a volta do foco é quem relê.
    refetchIntervalInBackground: false,
    refetchInterval: (q) => (recusada(q.state.error) || q.state.data?.ativa === false ? false : RELEITURA_DE_SEGURANCA_MS),
    queryFn: async (): Promise<FilaComRelogio> => {
      const r = await apiClient.get<{ data: FilaDoTelefone }>("/api/v1/telefonia/fila");
      // Um `agora` ilegível viraria `NaN` em TODO relógio da aba ("NaN:NaN"):
      // sem ele, vale o relógio do navegador — errado por alguns segundos, legível.
      const defasagemMs = new Date(r.data.agora).getTime() - Date.now();
      return { ...r.data, defasagemMs: Number.isFinite(defasagemMs) ? defasagemMs : 0 };
    },
  });

  const avisos = useMemo(() => {
    const reler = () => void qc.invalidateQueries({ queryKey: CHAVE_DA_FILA_DO_TELEFONE });
    // Velho, SEM pedido: `refetchType: "none"` só marca. Com a marca, a volta do
    // foco relê mesmo que a última leitura ainda esteja dentro do `staleTime`.
    const marcarComoVelha = () =>
      void qc.invalidateQueries({ queryKey: CHAVE_DA_FILA_DO_TELEFONE, refetchType: "none" });
    const juntador = criarJuntador({
      esperaMs: ESPERA_DO_JUNTADOR_MS,
      intervaloMinimoMs: INTERVALO_MINIMO_MS,
      // A pergunta se repete na HORA do pedido: a aba pode ter saído da tela
      // entre o aviso e a vez dele (até 4 s depois).
      agir: () => (abaEscondida() ? marcarComoVelha() : reler()),
    });
    return {
      /** O Realtime avisou de mudança em `voice_calls`. */
      chegou: () => (abaEscondida() ? marcarComoVelha() : juntador.avisar()),
      cancelar: () => juntador.cancelar(),
    };
  }, [qc]);
  useEffect(() => () => avisos.cancelar(), [avisos]);

  const ativa = consulta.data?.ativa === true;
  useRealtimeChannel({
    name: orgId && ativa ? `telefonia-fila-${orgId}` : "telefonia-fila-desligada",
    postgresChanges:
      orgId && ativa ? { event: "*", schema: "public", table: "voice_calls", filter: `organization_id=eq.${orgId}` } : undefined,
    onChange: () => avisos.chegou(),
    enabled: Boolean(orgId) && ativa,
  });

  return consulta;
}
