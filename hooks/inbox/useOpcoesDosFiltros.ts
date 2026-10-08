"use client";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { apiClient } from "@/lib/api/client";
import type { OpcoesDosFiltros } from "@/lib/inbox/opcoes-dos-filtros";

/**
 * As opções dos seletores do funil do Inbox — atendentes, caixas de entrada e
 * assuntos (`GET /api/v1/conversations/filtros`).
 *
 * `habilitado` existe porque são quatro leituras no servidor (membros, nomes,
 * caixas e assuntos) que só servem a quem abriu o funil: com ele fechado
 * ninguém vê os seletores, e o Inbox é a tela que mais abre no produto.
 *
 * É dado de referência — quem entra e sai da organização, número novo, assunto
 * novo —, então fica cinco minutos sem reler. A organização entra na chave: quem
 * troca de organização não pode ver os atendentes da anterior.
 */
export function useOpcoesDosFiltros(habilitado: boolean) {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  return useQuery({
    queryKey: ["inbox-opcoes-dos-filtros", orgId],
    enabled: habilitado && !!orgId,
    staleTime: 5 * 60_000,
    queryFn: () =>
      apiClient
        .get<{ data: OpcoesDosFiltros }>("/api/v1/conversations/filtros")
        .then((r) => r.data),
  });
}
