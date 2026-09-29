/**
 * AS FAIXAS DO TOPO PUBLICAM A PRÓPRIA ALTURA — o contêiner sticky que empilha as
 * faixas de estado de /app (acompanhamento, conexão caída, aviso de instabilidade)
 * escreve `--altura-das-faixas` no `<html>`, e a TopBar e a Inbox descontam dela.
 *
 * O jsdom não mede layout: aqui o `ResizeObserver` é simulado e se prova o que
 * dá — que a medida que ele entrega vira a variável (0 sem faixa nenhuma), que a
 * variável sai com o contêiner, e que o contêiner gruda no topo. A MEDIÇÃO real
 * (a TopBar logo abaixo das faixas ao rolar, o composer da Inbox dentro da
 * dobra) é da prova pela tela.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VARIAVEL_DA_ALTURA_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

import { FaixasDoTopo } from "./FaixasDoTopo";

type Aviso = (entradas: Array<{ borderBoxSize?: Array<{ blockSize: number }>; contentRect: { height: number } }>) => void;
const observadores: Array<{ aviso: Aviso; observados: Element[]; desligado: boolean }> = [];

class ResizeObserverFalso {
  private readonly registro: { aviso: Aviso; observados: Element[]; desligado: boolean };
  constructor(aviso: Aviso) {
    this.registro = { aviso, observados: [], desligado: false };
    observadores.push(this.registro);
  }
  observe(el: Element) {
    this.registro.observados.push(el);
  }
  unobserve() {}
  disconnect() {
    this.registro.desligado = true;
  }
}

const variavel = () => document.documentElement.style.getPropertyValue(VARIAVEL_DA_ALTURA_DAS_FAIXAS);
const medir = (altura: number) =>
  act(() => {
    for (const o of observadores) o.aviso([{ borderBoxSize: [{ blockSize: altura }], contentRect: { height: altura } }]);
  });

beforeEach(() => {
  observadores.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(VARIAVEL_DA_ALTURA_DAS_FAIXAS);
});

describe("as faixas do topo", () => {
  it("empilha as faixas num contêiner que gruda no topo", () => {
    render(
      <FaixasDoTopo>
        <div>faixa 1</div>
        <div>faixa 2</div>
      </FaixasDoTopo>,
    );
    const topo = document.querySelector("[data-faixas-do-topo]") as HTMLElement;
    expect(topo).toContainElement(screen.getByText("faixa 1"));
    expect(topo).toContainElement(screen.getByText("faixa 2"));
    expect(topo.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "top-0"]));
    expect(observadores[0]?.observados).toEqual([topo]);
  });

  it("publica a altura medida em --altura-das-faixas, e 0 quando não há faixa", () => {
    render(<FaixasDoTopo>{null}</FaixasDoTopo>);
    // Sem faixa nenhuma, o jsdom mede 0 — e a variável existe, com 0.
    expect(variavel()).toBe("0px");
    medir(48);
    expect(variavel()).toBe("48px");
    medir(96.4);
    expect(variavel()).toBe("96px");
    medir(0);
    expect(variavel()).toBe("0px");
  });

  it("sem o `borderBoxSize` (navegador antigo), usa o `contentRect`", () => {
    render(<FaixasDoTopo>{null}</FaixasDoTopo>);
    act(() => observadores[0]!.aviso([{ contentRect: { height: 40 } }]));
    expect(variavel()).toBe("40px");
  });

  it("sai da tela: desliga o observador e apaga a variável", () => {
    const { unmount } = render(<FaixasDoTopo>{null}</FaixasDoTopo>);
    medir(48);
    unmount();
    expect(observadores[0]!.desligado).toBe(true);
    expect(variavel()).toBe("");
  });
});
