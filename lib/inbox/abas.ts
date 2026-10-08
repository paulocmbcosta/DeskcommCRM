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

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "ai" | "phone";

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
  // A única aba que NÃO lista conversas: lista LIGAÇÕES — quem está na fila do
  // telefone, no menu, em ligação, e as perdidas de há pouco (migration 0295).
  // Só existe onde há telefone (ver `visibleInboxTabs`): numa instalação sem
  // telefonia seria uma porta para uma sala vazia. Por último, para a ordem das
  // outras não mudar para quem já as conhece de cor.
  { value: "phone", label: "Telefone" },
];

/**
 * Quem enxerga conversa de COLEGA: todo papel acima de `agent`, e o `agent` nos
 * modos em que a organização o deixa ver além do que é dele (`all`) ou do time
 * (`own_and_team`, 0281).
 *
 * É a MESMA pergunta em dois lugares — a aba "Todas" (abaixo) e a lista de nomes
 * do filtro por atendente (`app/api/v1/conversations/filtros/_handler.ts`). Uma
 * função, para as duas respostas não divergirem: aba que mostra o colega com
 * filtro que não o nomeia, ou o contrário.
 *
 * Cosmético, como tudo aqui: quem garante o escopo é a RLS.
 */
export function podeVerColegas(role: Role, mode: VisibilityMode | undefined): boolean {
  return role !== "agent" || mode === "all" || mode === "own_and_team";
}

/**
 * Visões visíveis por papel + escopo (G4-02, acceptance 1). 'Todas' fica oculta
 * para `agent`, salvo nos modos em que ele enxerga conversa de colega: `all` e
 * `own_and_team` (0281) — sem a aba, a conversa do colega de time só existiria
 * na busca. viewer/manager/admin sempre veem.
 * É apenas cosmético — a RLS (G4-01) é quem garante o escopo mesmo via ?filter=all.
 *
 * 'Telefone' depende da ORGANIZAÇÃO, e não do papel nem do ramal de quem olha:
 * aparece quando a rota da fila diz que há telefonia e número (`telefone: true`).
 * `viewer` não tem ramal e vê a aba — a fila é para ser vista por quem cobra,
 * não só por quem atende. Quem não diz nada (`opcoes` ausente) não a recebe.
 */
export function visibleInboxTabs(
  role: Role,
  mode: VisibilityMode | undefined,
  opcoes: { telefone?: boolean } = {},
): InboxTab[] {
  const hideAll = !podeVerColegas(role, mode);
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll))
    .filter((t) => t.value !== "phone" || opcoes.telefone === true)
    .map((t) => t.value);
}

