/**
 * AS ABAS DO INBOX — o vocabulário, fora de qualquer componente.
 *
 * Morava em `components/inbox/InboxFilters.tsx`, junto da faixa que as
 * desenhava. As abas saíram daquela faixa para o trilho (`InboxAbas`), e três
 * peças passaram a precisar da mesma lista: o trilho, o título da lista e o
 * próprio `InboxFilters`. Lista compartilhada não mora dentro de um dos que a
 * consomem — senão quem simula (mocka) aquele componente num teste leva o
 * vocabulário embora junto.
 */
import type { Role, VisibilityMode } from "@/lib/auth/types";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "ai";

export const INBOX_TABS: { value: InboxTab; label: string }[] = [
  { value: "unassigned", label: "Fila" },
  { value: "mine", label: "Minhas" },
  { value: "all", label: "Todas" },
  { value: "closed", label: "Fechadas" },
  // "Automático", não "IA": a palavra deste ator já é contrato em quatro arquivos
  // e no dicionário, e `handoff-por-orcamento.test.ts` usa literalmente "Voltar
  // para a IA" como a sabotagem que deve reprovar. A aba era a última fora do
  // padrão — e ela mudou de significado junto (deixou de filtrar `ai_handling` e
  // passou a perguntar a régua do motor), então o rótulo velho descreveria outra
  // coisa.
  { value: "ai", label: "Automático" },
];

/**
 * Visões visíveis por papel + escopo (G4-02, acceptance 1). 'Todas' fica oculta
 * para `agent`, salvo nos modos em que ele enxerga conversa de colega: `all` e
 * `own_and_team` (0281) — sem a aba, a conversa do colega de time só existiria
 * na busca. viewer/manager/admin sempre veem.
 * É apenas cosmético — a RLS (G4-01) é quem garante o escopo mesmo via ?filter=all.
 */
export function visibleInboxTabs(role: Role, mode: VisibilityMode | undefined): InboxTab[] {
  const hideAll = role === "agent" && mode !== "all" && mode !== "own_and_team";
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll)).map((t) => t.value);
}

