import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlternanciasDaLista, ChipsDosTimes } from "./ChipsDosTimes";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const contagens = [
  { team_id: "time-a", name: "Cobrança", count: 60, na_fila: 0 },
  { team_id: "time-b", name: "Suporte", count: 25, na_fila: 3 },
  { team_id: "time-c", name: "Vendas", count: 0, na_fila: 0 },
  { team_id: null, name: null, count: 5, na_fila: 0 },
];

function pintar(props: Partial<Parameters<typeof ChipsDosTimes>[0]> = {}) {
  const handlers = { onEscolherTime: vi.fn() };
  render(<ChipsDosTimes contagens={contagens} {...handlers} {...props} />);
  return handlers;
}

afterEach(() => cleanup());

describe("Todas: os times viram chips com o total", () => {
  it("cada time mostra a contagem exata, e 'Todos' a soma", () => {
    pintar();
    expect(screen.getByRole("button", { name: "Filtrar por time: Cobrança" })).toHaveTextContent("60");
    expect(screen.getByRole("button", { name: /^Filtrar por time: Suporte/ })).toHaveTextContent("25");
    expect(screen.getByRole("button", { name: "Filtrar por time: Sem time" })).toHaveTextContent("5");
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveTextContent("90");
  });

  it("time zerado some — a não ser o escolhido, que precisa do chip para ser desligado", () => {
    pintar();
    expect(screen.queryByRole("button", { name: "Filtrar por time: Vendas" })).not.toBeInTheDocument();
    cleanup();
    pintar({ timeEscolhido: "time-c" });
    expect(screen.getByRole("button", { name: "Filtrar por time: Vendas" })).toHaveAttribute("aria-pressed", "true");
  });

  it("'Sem time' vem primeiro; depois o time com mais conversas", () => {
    pintar();
    const nomes = screen
      .getAllByRole("button", { name: /^Filtrar por time/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(nomes).toEqual([
      "Filtrar por time: Sem time",
      "Filtrar por time: Cobrança",
      "Filtrar por time: Suporte (3 na fila)",
    ]);
  });

  it("clicar escolhe o time; clicar de novo desliga; 'Sem time' é a fila geral", async () => {
    const { onEscolherTime } = pintar({ timeEscolhido: "time-b" });
    await userEvent.click(screen.getByRole("button", { name: /^Filtrar por time: Suporte/ }));
    expect(onEscolherTime).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Filtrar por time: Sem time" }));
    expect(onEscolherTime).toHaveBeenLastCalledWith("none");
  });

  it("o time com gente esperando ganha 'N na fila', e a dica diz por quê", () => {
    pintar({ motivos: [{ team_id: "time-b", motivo: "todos_ocupados" }] });
    // O número vai no nome acessível: o selo vermelho é só um ícone e um dígito.
    const suporte = screen.getByRole("button", { name: "Filtrar por time: Suporte (3 na fila)" });
    expect(suporte.querySelector('[data-testid="chip-na-fila"]')).toHaveTextContent("3");
    expect(suporte).toHaveAttribute("title", "Todos os atendentes disponíveis estão no limite de conversas.");
    expect(
      screen.getByRole("button", { name: "Filtrar por time: Cobrança" }).querySelector('[data-testid="chip-na-fila"]'),
    ).toBeNull();
  });

  it("avisa quando não pode confirmar a contagem, sem inventar número", () => {
    pintar({ erro: true });
    expect(screen.getByText("Não foi possível carregar o volume por time.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filtrar por time: Cobrança" })).not.toBeInTheDocument();
  });
});

describe("as alternâncias da lista, na linha do título", () => {
  it("avisam o pai, com o nome por extenso para quem usa leitor de tela", async () => {
    const onSoNaFila = vi.fn();
    const onPorEspera = vi.fn();
    render(
      <AlternanciasDaLista
        mostrarFila
        naFilaTotal={3}
        soNaFila={false}
        onSoNaFila={onSoNaFila}
        porEspera={false}
        onPorEspera={onPorEspera}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Só na fila" }));
    expect(onSoNaFila).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Só na fila" })).toHaveTextContent("3");
    await userEvent.click(screen.getByRole("button", { name: "Mais tempo esperando" }));
    expect(onPorEspera).toHaveBeenCalledWith(true);
  });

  it("em Minhas, só a ordem por espera", () => {
    render(
      <AlternanciasDaLista
        mostrarFila={false}
        soNaFila={false}
        onSoNaFila={vi.fn()}
        porEspera={false}
        onPorEspera={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Só na fila" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mais tempo esperando" })).toBeInTheDocument();
  });
});

describe("o botão Insatisfeitos", () => {
  it("aparece quando a tela o liga e avisa o pai", async () => {
    const onSoInsatisfeitos = vi.fn();
    render(
      <AlternanciasDaLista
        mostrarFila
        soNaFila={false}
        onSoNaFila={vi.fn()}
        porEspera={false}
        onPorEspera={vi.fn()}
        soInsatisfeitos={false}
        onSoInsatisfeitos={onSoInsatisfeitos}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Insatisfeitos" }));
    expect(onSoInsatisfeitos).toHaveBeenCalledWith(true);
  });
});

