/**
 * A FAIXA DO AVISO DE INSTABILIDADE ESTÁ NO LAYOUT DE /app — provado EXECUTANDO
 * o layout, como a faixa irmã (`faixa-de-conexao-caida-vem-do-seam.test.tsx`).
 *
 * O que se mede, e por quê:
 *  - a faixa é montada para TODO papel (o atendente que atende o telefone
 *    precisa saber o que o cliente acabou de ouvir — desenho da fase 2, §6.4), e
 *    no topo: logo depois da faixa de conexão caída, fora da casca da página;
 *  - `oferecida` vem do AMBIENTE (`configAriDoAmbiente`), lido no servidor: é o
 *    que impede a instalação sem telefonia de pagar uma leitura por minuto em
 *    cada aba aberta. Um `true` fixo passaria no teste do componente e custaria
 *    caro em toda instalação que nunca ligou o telefone.
 *
 * Mede o elemento que o layout devolve, e não o texto-fonte: a cerca irmã conta
 * por que uma regex no arquivo cimenta a implementação sem vigiar o efeito.
 */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessao = vi.hoisted(() => ({ papel: "agent" }));
const adminClient = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { onboarded_at: "2026-01-01", status: "active", settings: null } }) }),
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
  resolveActiveOrg: async () => ({ orgId: "org-1", role: sessao.papel, interface_settings: null }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect inesperado para ${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Marca",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

/** O elemento `alvo` na árvore, e os irmãos dele (o array de filhos do pai). */
function achar(no: ReactNode, alvo: unknown, irmaos: ReactNode[] = []): { elemento: ReactElement; irmaos: ReactNode[] } | null {
  if (!no || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const filho of no) {
      const achado = achar(filho as ReactNode, alvo, no as ReactNode[]);
      if (achado) return achado;
    }
    return null;
  }
  const elemento = no as ReactElement<{ children?: ReactNode }>;
  if (elemento.type === alvo) return { elemento, irmaos };
  return achar(elemento.props?.children, alvo);
}

async function montar() {
  const { FaixaDoAvisoDeInstabilidade } = await import("@/components/telefonia/FaixaDoAvisoDeInstabilidade");
  const { ConexaoCaidaBanner } = await import("@/components/app/ConexaoCaidaBanner");
  const { default: AppLayout } = await import("@/app/app/layout");
  const arvore = (await AppLayout({ children: null })) as ReactElement;
  return { faixa: achar(arvore, FaixaDoAvisoDeInstabilidade), conexao: achar(arvore, ConexaoCaidaBanner) };
}

beforeEach(() => {
  sessao.papel = "agent";
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a faixa do aviso de instabilidade no layout de /app", () => {
  it("com a telefonia no ambiente: montada para o atendente, com `oferecida`, logo abaixo da faixa de conexão", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "http://asterisk.teste:8088");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "senha-de-teste");
    const { faixa, conexao } = await montar();

    expect(faixa, "o layout não montou a faixa do aviso").not.toBeNull();
    expect((faixa!.elemento.props as { oferecida: boolean }).oferecida).toBe(true);
    // No topo: irmã da faixa de conexão caída, logo depois dela — fora da casca da página.
    const irmaos = faixa!.irmaos;
    expect(irmaos).toBe(conexao!.irmaos);
    expect(irmaos.indexOf(faixa!.elemento)).toBe(irmaos.indexOf(conexao!.elemento) + 1);
  });

  it("sem a telefonia no ambiente: `oferecida` falso — a faixa não fará leitura nenhuma", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "");
    const { faixa } = await montar();
    expect((faixa!.elemento.props as { oferecida: boolean }).oferecida).toBe(false);
  });

  it("o papel não decide se a faixa existe: viewer, agent, manager e admin a recebem", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "http://asterisk.teste:8088");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "senha-de-teste");
    for (const papel of ["viewer", "agent", "manager", "admin"]) {
      sessao.papel = papel;
      const { faixa } = await montar();
      expect(faixa, `faltou a faixa para ${papel}`).not.toBeNull();
    }
  });
});
