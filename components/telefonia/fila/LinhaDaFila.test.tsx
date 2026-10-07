/**
 * UMA LIGAÇÃO VIVA NA ABA TELEFONE — o que a linha diz em cada fase, e quando
 * ela é um botão.
 *
 * O relógio entra por prop (`agoraMs`): a linha não lê hora nenhuma, então o
 * teste não espera nem simula tempo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LigacaoNaFila } from "@/lib/telefonia/fila";

import { LinhaDaFila } from "./LinhaDaFila";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const AGORA = new Date("2026-10-06T12:10:00Z").getTime();
const ha = (s: number) => new Date(AGORA - s * 1000).toISOString();
const daqui = (s: number) => new Date(AGORA + s * 1000).toISOString();

function ligacao(over: Partial<LigacaoNaFila> = {}): LigacaoNaFila {
  return {
    id: "lig-1",
    fase: "aguardando",
    contato: { id: "c-1", nome: "Maria Souza" },
    numero: "+5511988887777",
    time_id: "t-vendas",
    numero_da_empresa_id: "n-1",
    conversa_id: "conv-1",
    entrou_em: ha(300),
    na_fila_desde: ha(222),
    posicao: 1,
    cai_em: daqui(378),
    tocando_para: null,
    com: null,
    atendida_em: null,
    ...over,
  };
}

function pintar(over: Partial<LigacaoNaFila> = {}, props: Partial<Parameters<typeof LinhaDaFila>[0]> = {}) {
  const onAbrir = vi.fn();
  render(
    <LinhaDaFila
      ligacao={ligacao(over)}
      nomeDoTime="Vendas"
      numeroDaEmpresa="+551130250000"
      tetoS={600}
      agoraMs={AGORA}
      selecionada={false}
      onAbrir={onAbrir}
      {...props}
    />,
  );
  const linha = document.querySelector("[data-ligacao-id]") as HTMLElement;
  return { linha, onAbrir, estado: () => screen.getByTestId("estado-da-ligacao") };
}

afterEach(() => cleanup());

describe("quem é e por onde entrou", () => {
  it("com nome: o nome em cima, e o número, o time e o número da empresa embaixo", () => {
    const { linha } = pintar();
    expect(linha).toHaveAttribute("data-ligacao-id", "lig-1");
    expect(linha).toHaveAttribute("data-fase", "aguardando");
    expect(screen.getByText("Maria Souza")).toBeInTheDocument();
    expect(screen.getByText("+5511988887777 · Vendas · pelo +551130250000")).toBeInTheDocument();
  });

  it("sem nome: o número sobe para o título e não se repete embaixo", () => {
    pintar({ contato: { id: "c-1", nome: null } });
    expect(screen.getByText("+5511988887777")).toBeInTheDocument();
    expect(screen.getByText("Vendas · pelo +551130250000")).toBeInTheDocument();
  });

  it("sem contato e sem número (oculto): diz que não foi identificado, em vez de uma linha vazia", () => {
    pintar({ contato: null, numero: "" });
    expect(screen.getByText("Número não identificado")).toBeInTheDocument();
  });

  it("sem time e sem número da empresa conhecidos, a linha não inventa separador", () => {
    pintar({}, { nomeDoTime: null, numeroDaEmpresa: null });
    expect(screen.getByText("+5511988887777")).toBeInTheDocument();
    expect(screen.queryByText(/pelo/)).toBeNull();
  });

  it("a posição na fila aparece só para quem tem uma", () => {
    pintar({ posicao: 3 });
    expect(screen.getByLabelText("Posição 3 na fila")).toHaveTextContent("3º");
    cleanup();
    pintar({ fase: "em_ligacao", posicao: null });
    expect(screen.queryByLabelText(/Posição/)).toBeNull();
  });
});

describe("o estado, por fase", () => {
  it("aguardando: há quanto espera e em quanto a espera esgota", () => {
    const { estado } = pintar();
    expect(estado()).toHaveTextContent("Aguardando há 3:42 · cai em 6:18");
    expect(estado()).toHaveAttribute("data-urgencia", "normal");
  });

  it("aguardando sem prazo (ainda não gravado): só a espera, sem peso", () => {
    const { estado } = pintar({ cai_em: null });
    expect(estado()).toHaveTextContent("Aguardando há 3:42");
    expect(estado()).not.toHaveTextContent("cai em");
    expect(estado()).toHaveAttribute("data-urgencia", "normal");
  });

  it("passou da metade do teto do time: atenção", () => {
    // Teto de 600 s: metade = 300 s. Faltam 299.
    const { estado } = pintar({ cai_em: daqui(299) });
    expect(estado()).toHaveAttribute("data-urgencia", "atencao");
    expect(estado().className).toContain("bg-warning-bg");
  });

  it("faltam menos de 20% do teto: crítico", () => {
    // Teto de 600 s: 20% = 120 s. Faltam 78.
    const { estado } = pintar({ cai_em: daqui(78) });
    expect(estado()).toHaveTextContent("cai em 1:18");
    expect(estado()).toHaveAttribute("data-urgencia", "critico");
    expect(estado().className).toContain("bg-error");
  });

  it("o peso segue o teto DO TIME: faltando os mesmos 78 s, num time de 2 minutos ainda é normal", () => {
    // Teto de 120 s: metade = 60 s, 20% = 24 s. Faltando 78, ainda é normal.
    const { estado } = pintar({ cai_em: daqui(78) }, { tetoS: 120 });
    expect(estado()).toHaveAttribute("data-urgencia", "normal");
  });

  it("o prazo já passou e a ligação ainda está na fila: crítico, sem contagem negativa", () => {
    const { estado } = pintar({ cai_em: ha(4) });
    expect(estado()).toHaveAttribute("data-urgencia", "critico");
    expect(estado()).not.toHaveTextContent("cai em");
  });

  it("tocando: para quem toca e há quanto está na fila", () => {
    const { estado } = pintar({ fase: "tocando", cai_em: null, tocando_para: { id: "u-1", nome: "Ana" } });
    expect(estado()).toHaveTextContent("Tocando para Ana · na fila há 3:42");
    expect(estado()).not.toHaveAttribute("data-urgencia");
  });

  it("tocando para alguém sem nome cadastrado", () => {
    const { estado } = pintar({ fase: "tocando", tocando_para: { id: "u-1", nome: null } });
    expect(estado()).toHaveTextContent("Tocando para alguém");
  });

  it("no menu: ouvindo as opções, desde o começo da ligação", () => {
    const { estado } = pintar({ fase: "menu", na_fila_desde: null, posicao: null, cai_em: null });
    expect(estado()).toHaveTextContent("Ouvindo as opções · 5:00");
  });

  it("nos avisos", () => {
    const { estado } = pintar({ fase: "avisos", na_fila_desde: null, posicao: null, cai_em: null });
    expect(estado()).toHaveTextContent("Ouvindo os avisos · 5:00");
  });

  it("em ligação: com quem e há quanto, contado do ATENDIMENTO", () => {
    const { estado } = pintar({
      fase: "em_ligacao",
      posicao: null,
      cai_em: null,
      com: { id: "u-2", nome: "Bruno" },
      atendida_em: ha(252),
    });
    expect(estado()).toHaveTextContent("Com Bruno há 4:12");
  });

  it("transferida para a fila de um time: quem transferiu e há quanto aguarda", () => {
    const { estado } = pintar({
      fase: "transferencia_na_fila",
      posicao: null,
      cai_em: null,
      com: { id: "u-2", nome: "Bruno" },
      na_fila_desde: ha(40),
    });
    expect(estado()).toHaveTextContent("Transferida por Bruno · aguardando há 0:40");
  });

  it("data ilegível não vira `NaN:NaN` na tela", () => {
    const { estado } = pintar({ na_fila_desde: "não é data", cai_em: null });
    expect(estado()).toHaveTextContent("Aguardando há 0:00");
  });
});

describe("abrir a conversa", () => {
  it("com `onAbrir`, a linha inteira é um botão e clicar abre", async () => {
    const { linha, onAbrir } = pintar();
    expect(linha.tagName).toBe("BUTTON");
    await userEvent.click(linha);
    expect(onAbrir).toHaveBeenCalledTimes(1);
  });

  it("sem `onAbrir` (ligação sem conversa), NÃO é botão — nada promete um clique", () => {
    const { linha } = pintar({ conversa_id: null }, { onAbrir: undefined });
    expect(linha.tagName).toBe("DIV");
    expect(screen.queryByRole("button")).toBeNull();
    expect(linha.className).not.toContain("hover:");
  });

  it("a selecionada é marcada, como a conversa selecionada na lista", () => {
    const { linha } = pintar({}, { selecionada: true });
    expect(linha).toHaveAttribute("aria-current", "true");
    expect(linha.className).toContain("bg-accent-50");
  });
});
