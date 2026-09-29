/**
 * A CASCA DE /app MEDE A JANELA MENOS AS FAIXAS DO TOPO.
 *
 * As duas colunas da casca eram `min-h-screen` (100vh). Com uma faixa de estado
 * no topo (aviso de instabilidade ligado por horas, conexão caída,
 * acompanhamento), a página somava faixa + 100vh e rolava pela altura da faixa em
 * toda tela — na Inbox, a rolagem que passava da lista para a página deslocava a
 * grade. O `min-height` passa a ser `100vh` menos `--altura-das-faixas` (0 sem
 * faixa: o mesmo `min-h-screen` de antes). A conta mora em lib/ui/faixas-do-topo.ts.
 *
 * O jsdom não mede layout: prova-se que a casca USA a variável. A página sem
 * rolagem extra, com a faixa ligada, é da prova pela tela.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JANELA_ABAIXO_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => <aside data-barra-lateral="" /> }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <header /> }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({ BarraDeProgressoNavegacao: () => null }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({ useInboundMessageAlerts: () => undefined }));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => undefined }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: () => undefined }));

import { AppShell } from "./AppShell";

afterEach(() => cleanup());

describe("a casca de /app e as faixas do topo", () => {
  it("a linha da casca e a coluna do conteúdo medem, no mínimo, a janela menos as faixas", () => {
    render(
      <AppShell sidebarCollapsed={false}>
        <p>conteúdo</p>
      </AppShell>,
    );
    const coluna = screen.getByText("conteúdo").closest("main")!.parentElement as HTMLElement;
    const linha = coluna.parentElement as HTMLElement;
    expect(JANELA_ABAIXO_DAS_FAIXAS).toBe("calc(100vh - var(--altura-das-faixas, 0px))");
    for (const caixa of [linha, coluna]) {
      expect(caixa.getAttribute("style") ?? "").toContain("min-height: calc(100vh - var(--altura-das-faixas, 0px))");
      // O `min-h-screen` junto brigaria com a variável e dependeria da ordem do CSS.
      expect(caixa.className.split(/\s+/)).not.toContain("min-h-screen");
    }
  });
});
