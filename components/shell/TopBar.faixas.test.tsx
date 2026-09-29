/**
 * A TOPBAR GRUDA LOGO ABAIXO DAS FAIXAS DO TOPO, e não debaixo delas.
 *
 * As faixas de estado de /app (acompanhamento, conexão caída, aviso de
 * instabilidade) grudam no topo num contêiner `z-50`; a TopBar é `z-20`. Com os
 * dois em `top: 0`, ao rolar as faixas cobriam a TopBar inteira. Ela passa a
 * grudar em `--altura-das-faixas` — a altura que o contêiner publica
 * (`FaixasDoTopo`), 0 sem faixa nenhuma.
 *
 * O jsdom não mede: prova-se que a TopBar USA a variável. Onde ela fica de fato ao
 * rolar é da prova pela tela.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOPO_ABAIXO_DAS_FAIXAS, VARIAVEL_DA_ALTURA_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

vi.mock("./AlertsBell", () => ({ AlertsBell: () => null }));
vi.mock("./MobileSidebar", () => ({ MobileSidebar: () => null }));
vi.mock("./TenantSwitcher", () => ({ TenantSwitcher: () => null }));
vi.mock("./UserMenu", () => ({ UserMenu: () => null }));
vi.mock("./SearchTrigger", () => ({ SearchTrigger: () => null }));
vi.mock("./StatusDoAtendente", () => ({ StatusDoAtendente: () => null }));
vi.mock("@/components/telefonia/BotaoDoTelefone", () => ({ BotaoDoTelefone: () => null }));

import { TopBar } from "./TopBar";

afterEach(() => cleanup());

describe("a TopBar e as faixas do topo", () => {
  it("gruda em --altura-das-faixas (0 sem faixa), não no topo da janela", () => {
    render(<TopBar />);
    const barra = document.querySelector("header") as HTMLElement;
    expect(barra.className.split(/\s+/)).toContain("sticky");
    expect(barra.style.top).toBe(TOPO_ABAIXO_DAS_FAIXAS);
    expect(TOPO_ABAIXO_DAS_FAIXAS).toBe(`var(${VARIAVEL_DA_ALTURA_DAS_FAIXAS}, 0px)`);
    // Um `top-0` junto brigaria com a variável e dependeria da ordem do CSS.
    expect(barra.className.split(/\s+/)).not.toContain("top-0");
  });
});
