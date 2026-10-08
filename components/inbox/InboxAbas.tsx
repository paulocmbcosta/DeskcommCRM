"use client";
import type { ComponentType } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import type { ConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Archive, Inbox, Phone, Robot, User, UsersThree } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { INBOX_TABS, visibleInboxTabs, type InboxTab } from "@/lib/inbox/abas";
import type { InboxFiltersValue } from "./InboxFilters";

/**
 * AS ABAS DO INBOX, EM PÉ.
 *
 * Elas eram uma faixa horizontal no topo da coluna da lista — cinco rótulos
 * disputando 280px, em cima de busca e três seletores. Somadas, as quatro
 * fileiras tomavam ~170px da altura ANTES da primeira conversa aparecer, e é
 * de conversa que essa coluna vive.
 *
 * Em pé, num trilho de 44px, a aba custa largura (que sobra) e devolve altura
 * (que falta). O preço é o rótulo: no trilho só cabe o ícone. Ele é pago em
 * três lugares, para o ícone nunca ser a única pista —
 *   · o `aria-label`, que é o nome da aba para leitor de tela e para os testes;
 *   · a dica ao passar o mouse;
 *   · o NOME da aba escolhida escrito no topo da lista (`InboxLayout`), porque
 *     dica não existe em tela de toque.
 *
 * Os contadores vêm da MESMA pergunta que a lista faz, com os mesmos filtros
 * auxiliares: badge que conta o que a aba não mostra manda o atendente procurar
 * trabalho que não existe.
 */
const ICONE_DA_ABA: Record<InboxTab, ComponentType<{ size?: number; weight?: "regular" | "fill" | "duotone" }>> = {
  unassigned: Inbox,
  mine: User,
  all: UsersThree,
  closed: Archive,
  ai: Robot,
  phone: Phone,
};

/**
 * Só estas pedem AÇÃO de quem olha; nas outras o número informa, não cobra.
 * A do telefone cobra: o selo dela é gente NA LINHA, esperando alguém atender.
 */
const ABAS_QUE_COBRAM: ReadonlySet<InboxTab> = new Set(["unassigned", "mine", "phone"]);

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /**
   * A fila do TELEFONE, já lida por quem monta o trilho (`useFilaDoTelefone`,
   * uma vez, no `InboxLayout`). Vem por prop e não por hook: a coluna da aba lê
   * a mesma resposta, e duas leituras seriam duas assinaturas do tempo real — e
   * um selo capaz de discordar da lista ao lado.
   *
   * `ativa` decide se a aba existe (a organização tem telefone); `esperando` é
   * o selo. Ausente = sem telefone: o trilho fica como sempre foi.
   */
  telefone?: { ativa: boolean; esperando: number };
  /**
   * As contagens das abas, já lidas por quem monta o trilho (`useConversationCounts`,
   * uma vez, no `InboxLayout`). Vêm por prop pela mesma razão da fila do telefone,
   * logo acima: este componente chamava o hook com os PRÓPRIOS parâmetros — sem
   * `na_fila` nem `insatisfeitos` —, e o selo de "Todas" discordava da lista que
   * o `InboxLayout` montava com eles. Com os filtros novos (atendente, caixa,
   * período, assunto) seriam mais cinco para manter iguais em dois lugares.
   */
  contagens?: ConversationCounts;
}

export function InboxAbas({ value, onChange, telefone, contagens: counts }: Props) {
  const t = useT();
  const { activeOrg } = useAuth();

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode, { telefone: telefone?.ativa })
    : // Sem organização não há fila de telefone para ler: a aba não entra.
      INBOX_TABS.map((tab) => tab.value).filter((tab) => tab !== "phone");
  const countFor: Partial<Record<InboxTab, number>> = {
    // `fila` é o nome novo; `unassigned` é o alias que a rota versionada mantém.
    unassigned: counts?.fila ?? counts?.unassigned,
    ai: counts?.automatico,
    mine: counts?.mine,
    all: counts?.all,
    closed: counts?.closed,
    // Não vem das contagens de conversa: é quem espera na fila do telefone.
    phone: telefone?.esperando,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tabs
        orientation="vertical"
        value={value.tab}
        onValueChange={(v) => onChange({ ...value, tab: v as InboxTab })}
        className="h-full shrink-0 border-r border-border bg-surface"
        data-testid="inbox-abas"
      >
        <TabsList
          aria-label={t("Visões do inbox")}
          className="flex h-auto w-11 flex-col items-center justify-start gap-1 rounded-none bg-transparent px-0 py-2"
        >
          {tabs.map((tab) => {
            const meta = INBOX_TABS.find((m) => m.value === tab)!;
            const Icone = ICONE_DA_ABA[tab];
            const count = countFor[tab];
            const temNumero = typeof count === "number" && count > 0;
            const ativa = value.tab === tab;
            return (
              <Tooltip key={tab}>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value={tab}
                    aria-label={t(meta.label)}
                    className={cn(
                      "relative h-9 w-9 rounded-lg p-0 text-text-muted shadow-none",
                      "hover:bg-surface-elevated hover:text-text",
                      "data-[state=active]:bg-accent-soft data-[state=active]:text-accent data-[state=active]:shadow-none",
                    )}
                  >
                    <Icone size={18} weight={ativa ? "fill" : "regular"} />
                    {temNumero && (
                      <span
                        className={cn(
                          "absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums leading-none",
                          ABAS_QUE_COBRAM.has(tab)
                            ? "bg-accent text-accent-foreground"
                            : "bg-surface-elevated text-text-muted ring-1 ring-border",
                        )}
                      >
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">{t(meta.label)}</TooltipContent>
              </Tooltip>
            );
          })}
        </TabsList>
      </Tabs>
    </TooltipProvider>
  );
}
