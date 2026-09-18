"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AtendimentoResumo, LinhaDoTempoDaConversa } from "@/lib/inbox/eventos-da-conversa";

/** Mesmo piso da rota: menos que isso casa metade da base. */
export const PISO_DE_DIGITOS_DO_PROTOCOLO = 4;

/**
 * O histórico de atendimentos do CONTATO — um por protocolo, todos os canais.
 *
 * `sinal` entra na chave porque este dado muda por um caminho que o
 * react-query não vê: fechar, reabrir e o cliente voltar mexem em
 * `atendimentos` no banco, por trigger. O que a tela JÁ recebe em tempo real é
 * a conversa — então o status e o protocolo dela são o gatilho honesto do
 * refetch, em vez de um intervalo cego.
 */
export function useAtendimentosDoContato(contactId: string | null, sinal: string) {
  return useQuery({
    queryKey: ["atendimentos", "contato", contactId, sinal],
    enabled: !!contactId,
    queryFn: async () =>
      (await apiClient.get<{ data: AtendimentoResumo[] }>(`/api/v1/contacts/${contactId}/atendimentos`)).data,
    staleTime: 15_000,
  });
}

/** A linha do tempo da conversa, opcionalmente recortada num atendimento. */
export function useLinhaDoTempoDaConversa(
  conversationId: string | null,
  atendimentoId: string | null,
  sinal: string,
) {
  return useQuery({
    queryKey: ["conversa", "linha-do-tempo", conversationId, atendimentoId, sinal],
    enabled: !!conversationId,
    queryFn: async () => {
      const qs = atendimentoId ? `?atendimento_id=${atendimentoId}` : "";
      return (
        await apiClient.get<{ data: LinhaDoTempoDaConversa }>(`/api/v1/conversations/${conversationId}/timeline${qs}`)
      ).data;
    },
    staleTime: 5_000,
  });
}

/**
 * Busca pelo NÚMERO do protocolo, fora do filtro de aba.
 *
 * Só dispara com dígitos suficientes: "12" não é protocolo de ninguém, e a rota
 * recusaria com 422 — que o `apiClient` transformaria num toast de erro na cara
 * de quem só está digitando.
 */
export function useBuscaPorProtocolo(termo: string) {
  const digitos = termo.replace(/\D/g, "");
  const vale = digitos.length >= PISO_DE_DIGITOS_DO_PROTOCOLO && digitos.length === termo.trim().replace(/[\s.-]/g, "").length;
  return useQuery({
    queryKey: ["atendimentos", "protocolo", digitos],
    enabled: vale,
    queryFn: async () =>
      (await apiClient.get<{ data: AtendimentoResumo[] }>(`/api/v1/atendimentos?protocol=${digitos}`)).data,
    staleTime: 10_000,
  });
}
