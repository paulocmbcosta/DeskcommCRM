import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { type Role } from "@/lib/auth/types";
import {
  ArrowRight,
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ChartPieSlice,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Handshake,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Sparkle,
  Storefront,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import {
  NAV_CATALOG,
  NAV_GROUPS,
  type NavMetadata,
  type NavGroup,
  type NavGroupId,
} from "./catalogo";
import { destinosDaInterface, type InterfaceSettings } from "./interface";
export { NAV_GROUPS, GRUPO_NO_RODAPE } from "./catalogo";
export type { NavGroup, NavGroupId } from "./catalogo";
const ICONS = {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};
export interface NavDestination extends Omit<NavMetadata, "icon"> {
  icon: PhosphorIcon;
}
export const NAV_DESTINATIONS: NavDestination[] = NAV_CATALOG.map((d) => ({
  ...d,
  icon: ICONS[d.icon],
}));
/**
 * O ícone do "Ver tudo em …" de cada grupo com hub.
 *
 * UM POR GRUPO. Os três links desenhavam a mesma seta, e o menu aberto mostrava
 * três linhas idênticas — que só se distinguiam lendo o texto. Recolhida a barra,
 * o texto some e sobram três setas iguais, distinguíveis apenas pelo `title`.
 *
 * Cada ícone diz de que assunto é o grupo, com silhueta diferente dos vizinhos
 * (aperto de mão ≠ funil/contatos, brilho ≠ robô, fatia de pizza ≠ barras).
 * `Configurações` (`organizacao`) não entra: seu hub vive no rodapé, com a engrenagem.
 *
 * Grupo com hub que não estiver aqui cai na seta — e o teste
 * `sidebar-icones-distintos` reprova, que é o que impede a volta do defeito.
 */
const ICONE_DO_HUB: Partial<Record<NavGroupId, PhosphorIcon>> = {
  crm: Handshake,
  ia: Sparkle,
  analise: ChartPieSlice,
};

/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export { canSee } from "./interface";

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ group: NavGroup; items: NavDestination[]; hubIcon: PhosphorIcon }> {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    hubIcon: ICONE_DO_HUB[group.id] ?? ArrowRight,
    items: NAV_DESTINATIONS.filter(
      (d) => d.group === group.id && (d.sidebar || (!group.hub && !!settings?.destinos)) && visible.has(d.href),
    ),
  })).filter(
    (g) =>
      g.items.length > 0 ||
      (g.group.hub && NAV_DESTINATIONS.some((d) => d.group === g.group.id && visible.has(d.href))),
  );
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !visible.has(d.href)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): NavDestination[] {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_DESTINATIONS.filter((d) => visible.has(d.href));
}
