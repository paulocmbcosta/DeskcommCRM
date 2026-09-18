"use client";
import type { ComponentType } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Archive, Inbox, Robot, User, UsersThree } from "@/lib/ui/icons";
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
};

/** Só estas pedem AÇÃO de quem olha; nas outras o número informa, não cobra. */
const ABAS_QUE_COBRAM: ReadonlySet<InboxTab> = new Set(["unassigned", "mine"]);

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
}

export function InboxAbas({ value, onChange }: Props) {
  const t = useT();
  const { activeOrg } = useAuth();
  const { data: counts } = useConversationCounts(activeOrg?.orgId ?? null, {
    unread: value.onlyUnread,
    tag: value.tag,
    channel_session_id: value.channel_session_id,
    team_id: value.team_id,
  });

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((tab) => tab.value);
  const countFor: Partial<Record<InboxTab, number>> = {
    // `fila` é o nome novo; `unassigned` é o alias que a rota versionada mantém.
    unassigned: counts?.fila ?? counts?.unassigned,
    ai: counts?.automatico,
    mine: counts?.mine,
    all: counts?.all,
    closed: counts?.closed,
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
