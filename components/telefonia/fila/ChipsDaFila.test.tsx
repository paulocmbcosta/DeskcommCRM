/**
 * OS CHIPS DA FILA DO TELEFONE — quando existem, em que ordem, e o que cada um diz.
 * O uso deles dentro da coluna (filtrar as quatro seções) é de `FilaDoTelefone.test.tsx`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaseDaLigacao, LigacaoNaFila } from "@/lib/telefonia/fila";

import { ChipsDaFila } from "./ChipsDaFila";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const AGORA = new Date("2026-10-06T12:10:00Z").getTime();
const ha = (s: number) => new Date(AGORA - s * 1000).toISOString();

const TIMES = [
  { id: "t-vendas", nome: "Vendas", espera_maxima_s: 600 },
  { id: "t-suporte", nome: "Suporte", espera_maxima_s: 120 },
  { id: "t-cobranca", nome: "Cobrança", espera_maxima_s: 120 },
  { id: "t-financeiro", nome: "Financeiro", espera_maxima_s: 120 },
];

let seq = 0;
function ligacao(fase: FaseDaLigacao, time_id: string | null, esperaS: number | null): LigacaoNaFila {
  return {
    id: `l-${++seq}`,
    fase,
    contato: null,
    numero: "+5511900000000",
    time_id,
    numero_da_empresa_id: "n-1",
    conversa_id: null,
    entrou_em: ha(600),
    na_fila_desde: esperaS === null ? null : ha(esperaS),
    posicao: null,
    cai_em: null,
    tocando_para: null,
    com: null,
    atendida_em: null,
    ordem: null,
  };
}

const LIGACOES = [
  ligacao("aguardando", "t-vendas", 50),
  ligacao("aguardando", "t-suporte", 200),
  ligacao("tocando", "t-suporte", 90),
  ligacao("transferencia_na_fila", "t-suporte", 10),
  ligacao("aguardando", "t-cobranca", 75),
  // Não esperam por ninguém: fora da conta.
  ligacao("em_ligacao", "t-financeiro", 400),
  ligacao("menu", null, null),
];

function pintar(props: Partial<Parameters<typeof ChipsDaFila>[0]> = {}) {
  const onEscolherTime = vi.fn();
  render(<ChipsDaFila times={TIMES} ligacoes={LIGACOES} agoraMs={AGORA} onEscolherTime={onEscolherTime} {...props} />);
  return { onEscolherTime };
}

const nomesDosChips = () =>
  screen.getAllByRole("button", { name: /^Filtrar por time/ }).map((b) => b.getAttribute("aria-label"));

afterEach(() => cleanup());

describe("os chips da fila do telefone", () => {
  it("'Todos' soma quem espera; cada time diz quantas e há quanto a mais antiga espera", () => {
    pintar();
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveTextContent("5");
    const suporte = screen.getByRole("button", { name: "Filtrar por time: Suporte (3 na fila)" });
    expect(suporte).toHaveAttribute("data-team-id", "t-suporte");
    expect(suporte).toHaveTextContent("3:20");
    expect(screen.getByRole("button", { name: "Filtrar por time: Vendas (1 na fila)" })).toHaveTextContent("0:50");
  });

  it("vem primeiro o time com mais gente esperando; empate, pelo nome", () => {
    pintar();
    expect(nomesDosChips()).toEqual([
      "Filtrar por time: Suporte (3 na fila)",
      "Filtrar por time: Cobrança (1 na fila)",
      "Filtrar por time: Vendas (1 na fila)",
    ]);
  });

  it("time sem ninguém esperando some — a não ser o escolhido, que precisa do chip para ser desligado", () => {
    pintar();
    expect(screen.queryByRole("button", { name: /Financeiro/ })).toBeNull();
    cleanup();
    pintar({ timeEscolhido: "t-financeiro" });
    const financeiro = screen.getByRole("button", { name: "Filtrar por time: Financeiro" });
    expect(financeiro).toHaveAttribute("aria-pressed", "true");
    expect(financeiro).toHaveTextContent("0");
    // Sem ninguém esperando, não há relógio para mostrar.
    expect(financeiro).not.toHaveTextContent(":");
  });

  it("clicar escolhe o time; clicar de novo desliga; 'Todos' desliga", async () => {
    const { onEscolherTime } = pintar({ timeEscolhido: "t-suporte" });
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: /^Filtrar por time: Vendas/ }));
    expect(onEscolherTime).toHaveBeenLastCalledWith("t-vendas");
    await userEvent.click(screen.getByRole("button", { name: /^Filtrar por time: Suporte/ }));
    expect(onEscolherTime).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(onEscolherTime).toHaveBeenLastCalledWith(undefined);
  });

  it("ninguém esperando e nenhum time escolhido: a faixa não é desenhada", () => {
    pintar({ ligacoes: LIGACOES.filter((l) => l.fase === "em_ligacao" || l.fase === "menu") });
    expect(screen.queryByTestId("chips-da-fila")).toBeNull();
  });

  it("ninguém esperando, mas com um time escolhido: a faixa fica, para o filtro ter saída", () => {
    pintar({ ligacoes: [], timeEscolhido: "t-vendas" });
    expect(screen.getByTestId("chips-da-fila")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveTextContent("0");
  });
});
