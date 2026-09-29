/**
 * A BARRA LATERAL GRUDA LOGO ABAIXO DAS FAIXAS DO TOPO, e mede a janela menos elas.
 *
 * Com uma faixa de estado no topo (aviso de instabilidade ligado por horas,
 * conexão caída, acompanhamento), a barra `sticky top-0 h-screen` nascia com o
 * rodapé cortado — onde fica o `VersionFooter` com o alerta de versão — e, ao
 * rolar, o topo dela ficava coberto pelo contêiner das faixas. Ela passa a grudar
 * em `--altura-das-faixas` e a medir `100vh` menos essa altura (0 sem faixa: o
 * mesmo `top-0 h-screen` de antes). A conta mora em lib/ui/faixas-do-topo.ts.
 *
 * Continua `sticky`, e nunca `fixed` — o porquê está no comentário da barra e na
 * cerca `tests/unit/barra-lateral-nao-perde-o-sticky.test.ts`.
 *
 * O jsdom não mede layout: prova-se que a barra USA a variável. O rodapé inteiro
 * na tela, com a faixa ligada, é da prova pela tela.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { JANELA_ABAIXO_DAS_FAIXAS, TOPO_ABAIXO_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({ ConnectionHealthDot: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "admin@exemplo.test", is_platform_admin: false, organizations: [] } as unknown as AuthUser,
    activeOrg: { orgId: "o1", name: "Loja", role: "admin" } as ActiveOrg,
  }),
}));

import { Sidebar } from "./Sidebar";

afterEach(() => cleanup());

describe("a barra lateral e as faixas do topo", () => {
  it.each([false, true])("recolhida=%s: gruda abaixo das faixas e mede a janela menos elas — e segue sticky", (recolhida) => {
    render(
      <MarcaDaInstalacaoProvider marca={{ name: "Sistema", logoUrl: null, initial: "S" }}>
        <Sidebar collapsed={recolhida} />
      </MarcaDaInstalacaoProvider>,
    );
    const barra = document.querySelector("aside") as HTMLElement;
    const classes = barra.className.split(/\s+/);
    expect(classes).toContain("sticky");
    expect(classes).not.toContain("fixed");
    expect(barra.style.top).toBe(TOPO_ABAIXO_DAS_FAIXAS);
    expect(barra.getAttribute("style") ?? "").toContain("height: calc(100vh - var(--altura-das-faixas, 0px))");
    expect(JANELA_ABAIXO_DAS_FAIXAS).toBe("calc(100vh - var(--altura-das-faixas, 0px))");
    // As classes antigas junto brigariam com a variável e dependeriam da ordem do CSS.
    expect(classes).not.toContain("top-0");
    expect(classes).not.toContain("h-screen");
  });
});
