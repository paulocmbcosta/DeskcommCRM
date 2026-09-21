/**
 * A BARRA LATERAL NASCE RECOLHIDA — provado pela regra e EXECUTANDO o layout.
 *
 * ─── A propriedade ──────────────────────────────────────────────────────────
 *
 * Quem nunca mexeu na barra (cookie ausente) a recebe recolhida; quem a expandiu
 * de propósito (`"0"`) a recebe aberta; quem a recolheu (`"1"`) a recebe fechada.
 * O que decide o padrão é o cookie AUSENTE — e é ele que a forma antiga
 * (`=== "1"`) deixava cair do lado errado sem que nenhum tipo reclamasse.
 *
 * ─── Por que o layout é EXECUTADO ───────────────────────────────────────────
 *
 * A regra pura (`barraLateralRecolhida`) pode estar certa com o layout lendo o
 * cookie por outro caminho — foi assim que o padrão antigo sobreviveu: a
 * comparação vivia INLINE na tela, onde nenhum teste a alcançava. Aqui o Server
 * Component `AppLayout` roda de verdade e mede o que chega ao `<AppShell>`,
 * mesmo método de `faixa-de-conexao-caida-vem-do-seam.test.tsx`.
 */
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { barraLateralRecolhida, COOKIE_BARRA_RECOLHIDA } from "@/lib/navigation/barra-lateral";

let cookieDaBarra: string | undefined;

const adminClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { onboarded_at: "2026-01-01", status: "active", settings: null },
        }),
      }),
    }),
  }),
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect inesperado para ${destino}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nome: string) =>
      nome === "sidebar_collapsed" && cookieDaBarra !== undefined
        ? { name: nome, value: cookieDaBarra }
        : undefined,
  }),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

function achar(no: ReactNode, alvo: unknown): ReactElement | null {
  if (!no || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const filho of no) {
      const achado = achar(filho as ReactNode, alvo);
      if (achado) return achado;
    }
    return null;
  }
  const elemento = no as ReactElement<{ children?: ReactNode }>;
  if (elemento.type === alvo) return elemento;
  return achar(elemento.props?.children, alvo);
}

async function barraNoLayout(): Promise<boolean> {
  const { AppShell } = await import("@/app/app/_components/AppShell");
  const { default: AppLayout } = await import("@/app/app/layout");
  const arvore = (await AppLayout({ children: null })) as ReactElement;
  const casca = achar(arvore, AppShell) as ReactElement<{ sidebarCollapsed: boolean }> | null;
  expect(casca, "o layout não renderizou o AppShell").not.toBeNull();
  return casca!.props.sidebarCollapsed;
}

beforeEach(() => {
  cookieDaBarra = undefined;
});

describe("barraLateralRecolhida (a regra)", () => {
  it("sem cookie, recolhida — o padrão", () => {
    expect(barraLateralRecolhida(undefined)).toBe(true);
  });

  it('"1" é recolhida e "0" é expandida — o que o botão grava', () => {
    expect(barraLateralRecolhida("1")).toBe(true);
    expect(barraLateralRecolhida("0")).toBe(false);
  });

  it("valor que ninguém escreveu cai no padrão, não na barra aberta", () => {
    expect(barraLateralRecolhida("")).toBe(true);
    expect(barraLateralRecolhida("false")).toBe(true);
  });

  it("o nome do cookie é o que o botão e o layout compartilham", () => {
    expect(COOKIE_BARRA_RECOLHIDA).toBe("sidebar_collapsed");
  });
});

// O primeiro `import()` do layout carrega o grafo inteiro da casca (branding,
// canais, auth) e, a frio, sob a suíte paralela, passa fácil dos 15s de
// `testTimeout` — medido: 20s num `pnpm test:unit` completo, 2,4s isolado. É o
// mesmo teto que `lib/ui/icons.test.ts` põe pelo mesmo motivo.
describe("o layout entrega a barra ao AppShell", { timeout: 60_000 }, () => {
  it("recolhida quando a pessoa nunca mexeu (sem cookie)", async () => {
    cookieDaBarra = undefined;
    expect(await barraNoLayout()).toBe(true);
  });

  it("aberta quando a pessoa a expandiu de propósito", async () => {
    cookieDaBarra = "0";
    expect(await barraNoLayout()).toBe(false);
  });

  it("recolhida quando a pessoa a recolheu", async () => {
    cookieDaBarra = "1";
    expect(await barraNoLayout()).toBe(true);
  });
});
