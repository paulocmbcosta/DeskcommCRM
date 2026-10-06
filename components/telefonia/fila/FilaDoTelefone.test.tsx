/**
 * A COLUNA DA ABA TELEFONE — as quatro seções, os filtros, o relógio que anda
 * sozinho e os estados em que não há fila para mostrar.
 *
 * O hook que lê a fila é de quem monta a coluna (`InboxLayout`); aqui a leitura
 * entra por prop, com um dado fixo. O relógio é simulado SÓ no que a coluna usa
 * (`setInterval` e `Date`): o `setTimeout` segue de verdade, que é com ele que o
 * `userEvent` e o `Select` do Radix trabalham.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilaComRelogio } from "@/hooks/telefonia/useFilaDoTelefone";
import type { LigacaoNaFila, PerdidaRecente } from "@/lib/telefonia/fila";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O botão de ligar lê o contexto do telefone (ramal, ligação em curso), que não
// é desta coluna. Vira sonda: diz para QUEM ele ligaria.
vi.mock("@/components/telefonia/BotaoLigar", () => ({
  BotaoLigar: (p: { contatoId: string; variante?: string; temTelefone: boolean }) => (
    <span data-testid="botao-ligar" data-contato={p.contatoId} data-variante={p.variante} data-tem-telefone={String(p.temTelefone)} />
  ),
}));

import { FilaDoTelefone } from "./FilaDoTelefone";

const AGORA = new Date("2026-10-06T12:10:00Z").getTime();
const ha = (s: number) => new Date(AGORA - s * 1000).toISOString();
const daqui = (s: number) => new Date(AGORA + s * 1000).toISOString();

function ligacao(id: string, over: Partial<LigacaoNaFila>): LigacaoNaFila {
  return {
    id,
    fase: "aguardando",
    contato: null,
    numero: "+5511900000000",
    time_id: "t-vendas",
    numero_da_empresa_id: "n-1",
    conversa_id: null,
    entrou_em: ha(300),
    na_fila_desde: null,
    posicao: null,
    cai_em: null,
    tocando_para: null,
    com: null,
    atendida_em: null,
    ...over,
  };
}

function perdida(id: string, over: Partial<PerdidaRecente>): PerdidaRecente {
  return {
    id,
    contato: null,
    numero: "+5511911111111",
    time_id: "t-vendas",
    numero_da_empresa_id: "n-1",
    conversa_id: null,
    motivo: "desistiu_na_fila",
    esperou_s: 75,
    encerrada_em: ha(300),
    ...over,
  };
}

/** Fora de ordem de propósito: quem põe a mais antiga em cima é a coluna. */
const LIGACOES: LigacaoNaFila[] = [
  ligacao("tocando-suporte", {
    fase: "tocando",
    time_id: "t-suporte",
    numero_da_empresa_id: "n-2",
    na_fila_desde: ha(30),
    posicao: 1,
    tocando_para: { id: "u-ana", nome: "Ana" },
    conversa_id: "conv-tocando",
  }),
  ligacao("em-ligacao", {
    fase: "em_ligacao",
    contato: { id: "c-3", nome: "Carla" },
    com: { id: "u-bruno", nome: "Bruno" },
    atendida_em: ha(252),
    conversa_id: "conv-em-ligacao",
  }),
  ligacao("segunda-de-vendas", { na_fila_desde: ha(60), posicao: 2, cai_em: daqui(540), numero: "" }),
  ligacao("no-menu", { fase: "menu", time_id: null, entrou_em: ha(10) }),
  ligacao("transferida", {
    fase: "transferencia_na_fila",
    time_id: "t-suporte",
    numero_da_empresa_id: "n-2",
    na_fila_desde: ha(40),
    com: { id: "u-bruno", nome: "Bruno" },
  }),
  ligacao("primeira-de-vendas", {
    contato: { id: "c-1", nome: "Maria Souza" },
    numero: "+5511988887777",
    na_fila_desde: ha(222),
    posicao: 1,
    cai_em: daqui(378),
    conversa_id: "conv-primeira",
  }),
  ligacao("nos-avisos", { fase: "avisos", numero_da_empresa_id: "n-2", entrou_em: ha(5) }),
];

const PERDIDAS: PerdidaRecente[] = [
  perdida("perdida-vendas", {
    contato: { id: "c-9", nome: "João Lima" },
    numero: "+5511977776666",
    conversa_id: "conv-perdida",
  }),
  perdida("perdida-suporte", {
    time_id: "t-suporte",
    numero_da_empresa_id: "n-2",
    motivo: "fila_esgotada",
    esperou_s: 120,
    encerrada_em: ha(20),
  }),
];

function fila(over: Partial<FilaComRelogio> = {}): FilaComRelogio {
  return {
    ativa: true,
    agora: new Date(AGORA).toISOString(),
    defasagemMs: 0,
    times: [
      { id: "t-vendas", nome: "Vendas", espera_maxima_s: 600 },
      { id: "t-suporte", nome: "Suporte", espera_maxima_s: 120 },
      { id: "t-financeiro", nome: "Financeiro", espera_maxima_s: 120 },
    ],
    numeros: [
      { id: "n-1", nome: "Matriz", numero: "+551130250000" },
      { id: "n-2", nome: null, numero: "+551140637232" },
    ],
    ligacoes: LIGACOES,
    perdidas: PERDIDAS,
    ...over,
  };
}

type Consulta = Parameters<typeof FilaDoTelefone>[0]["consulta"];

function pintar(data: FilaComRelogio | undefined, over: Partial<Record<keyof Consulta, unknown>> = {}, selectedId: string | null = null) {
  const onSelect = vi.fn();
  const refetch = vi.fn();
  const consulta = { data, isPending: data === undefined, isError: false, refetch, ...over } as unknown as Consulta;
  const tela = render(<FilaDoTelefone consulta={consulta} selectedId={selectedId} onSelect={onSelect} />);
  return { onSelect, refetch, ...tela };
}

const secao = (id: string) => document.querySelector(`[data-secao="${id}"]`) as HTMLElement | null;
/** Os ids das linhas de uma seção, na ordem em que estão na tela. */
const linhasDa = (id: string) =>
  [...(secao(id)?.querySelectorAll("[data-ligacao-id], [data-perdida-id]") ?? [])].map(
    (l) => l.getAttribute("data-ligacao-id") ?? l.getAttribute("data-perdida-id"),
  );
const linha = (id: string) => document.querySelector(`[data-ligacao-id="${id}"]`) as HTMLElement;
const estadoDa = (id: string) => within(linha(id)).getByTestId("estado-da-ligacao");

// O jsdom não tem a captura de ponteiro que o `Select` do Radix usa para abrir.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("as quatro seções", () => {
  it("cada ligação cai na sua seção, e a fila vem por ordem de chegada", () => {
    pintar(fila());

    expect(screen.getByTestId("fila-do-telefone")).toBeInTheDocument();
    // A mais antiga em cima, de qualquer time — e a transferida para a fila de
    // um time espera junto com as outras.
    expect(linhasDa("na-fila")).toEqual(["primeira-de-vendas", "segunda-de-vendas", "transferida", "tocando-suporte"]);
    expect(linhasDa("no-menu")).toEqual(["no-menu", "nos-avisos"]);
    expect(linhasDa("em-ligacao")).toEqual(["em-ligacao"]);
    expect(linhasDa("perdidas")).toEqual(["perdida-vendas", "perdida-suporte"]);

    expect(within(secao("na-fila")!).getByText("Na fila, por ordem de chegada")).toBeInTheDocument();
    expect(within(secao("no-menu")!).getByText("No menu")).toBeInTheDocument();
    expect(within(secao("em-ligacao")!).getByText("Em ligação")).toBeInTheDocument();
    expect(within(secao("perdidas")!).getByText("Perdidas nos últimos 30 minutos")).toBeInTheDocument();
  });

  it("a linha diz o time e o número da empresa pelos NOMES que a resposta traz", () => {
    pintar(fila());
    expect(within(linha("primeira-de-vendas")).getByText("+5511988887777 · Vendas · pelo +551130250000")).toBeInTheDocument();
    expect(within(linha("tocando-suporte")).getByText("Suporte · pelo +551140637232")).toBeInTheDocument();
    expect(estadoDa("tocando-suporte")).toHaveTextContent("Tocando para Ana · na fila há 0:30");
    expect(estadoDa("em-ligacao")).toHaveTextContent("Com Bruno há 4:12");
    expect(estadoDa("transferida")).toHaveTextContent("Transferida por Bruno · aguardando há 0:40");
  });

  it("seção sem linha não é desenhada — nem o título", () => {
    pintar(fila({ ligacoes: LIGACOES.filter((l) => l.fase === "em_ligacao"), perdidas: [] }));
    expect(secao("em-ligacao")).not.toBeNull();
    expect(secao("na-fila")).toBeNull();
    expect(secao("no-menu")).toBeNull();
    expect(secao("perdidas")).toBeNull();
    expect(screen.queryByText("Nenhuma ligação agora.")).toBeNull();
  });

  it("nenhuma ligação e nenhuma perdida: diz que está vazio, em vez de uma coluna em branco", () => {
    pintar(fila({ ligacoes: [], perdidas: [] }));
    expect(screen.getByText("Nenhuma ligação agora.")).toBeInTheDocument();
    expect(document.querySelector("[data-secao]")).toBeNull();
    expect(screen.queryByTestId("chips-da-fila")).toBeNull();
  });
});

describe("o relógio da tela", () => {
  it("anda sozinho, a cada segundo, sem leitura nova", () => {
    const { refetch } = pintar(fila());
    expect(estadoDa("primeira-de-vendas")).toHaveTextContent("Aguardando há 3:42 · cai em 6:18");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(estadoDa("primeira-de-vendas")).toHaveTextContent("Aguardando há 3:43 · cai em 6:17");
    expect(estadoDa("em-ligacao")).toHaveTextContent("Com Bruno há 4:13");

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(estadoDa("primeira-de-vendas")).toHaveTextContent("Aguardando há 4:42 · cai em 5:18");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("mede pelo relógio do BANCO: a defasagem deste navegador entra na conta", () => {
    // O navegador está 60 s atrasado em relação ao banco.
    pintar(fila({ defasagemMs: 60_000 }));
    expect(estadoDa("primeira-de-vendas")).toHaveTextContent("Aguardando há 4:42 · cai em 5:18");
  });

  it("a espera pesa contra o teto DO TIME da ligação: crítico quando faltam menos de 20%", () => {
    const quase = ligacao("quase-caindo", { time_id: "t-suporte", na_fila_desde: ha(100), posicao: 1, cai_em: daqui(20) });
    pintar(fila({ ligacoes: [...LIGACOES, quase] }));

    // Suporte: teto de 120 s, 20% = 24 s. Faltam 20.
    expect(estadoDa("quase-caindo")).toHaveAttribute("data-urgencia", "critico");
    // Vendas: teto de 600 s; faltando 378 (mais da metade), a espera não pesa.
    expect(estadoDa("primeira-de-vendas")).toHaveAttribute("data-urgencia", "normal");

    // E o peso muda com o relógio, sem leitura: de 540 s restantes para 299.
    expect(estadoDa("segunda-de-vendas")).toHaveAttribute("data-urgencia", "normal");
    act(() => {
      vi.advanceTimersByTime(241_000);
    });
    expect(estadoDa("segunda-de-vendas")).toHaveAttribute("data-urgencia", "atencao");
  });

  it("é UM relógio para a coluna inteira, e ele para quando a coluna sai da tela", () => {
    // Um `setInterval` por linha seriam dezenas de redesenhos por segundo com a fila cheia.
    const { unmount } = pintar(fila());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("os filtros valem para as quatro seções", () => {
  it("os chips mostram quantas esperam por time e há quanto a mais antiga espera", () => {
    pintar(fila());
    const chips = screen.getByTestId("chips-da-fila");
    expect(within(chips).getByRole("button", { name: /^Todos/ })).toHaveTextContent("4");
    const vendas = within(chips).getByRole("button", { name: "Filtrar por time: Vendas (2 na fila)" });
    expect(vendas).toHaveTextContent("2");
    expect(vendas).toHaveTextContent("3:42");
    expect(within(chips).getByRole("button", { name: "Filtrar por time: Suporte (2 na fila)" })).toHaveTextContent("0:40");
    // Time sem ninguém esperando não ganha chip.
    expect(within(chips).queryByRole("button", { name: /Financeiro/ })).toBeNull();
  });

  it("escolher um time filtra a fila, o menu, as ligações e as perdidas; 'Todos' desfaz", async () => {
    pintar(fila());
    await userEvent.click(screen.getByRole("button", { name: /^Filtrar por time: Suporte/ }));

    expect(linhasDa("na-fila")).toEqual(["transferida", "tocando-suporte"]);
    expect(secao("no-menu")).toBeNull();
    expect(secao("em-ligacao")).toBeNull();
    expect(linhasDa("perdidas")).toEqual(["perdida-suporte"]);
    // Os chips NÃO encolhem com o filtro de time: senão escolher um zeraria os outros.
    expect(screen.getByRole("button", { name: /^Filtrar por time: Vendas/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Filtrar por time: Suporte/ })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(linhasDa("na-fila")).toHaveLength(4);
    expect(linhasDa("perdidas")).toHaveLength(2);
  });

  it("escolher um número da empresa filtra as quatro seções E as contagens dos chips", async () => {
    pintar(fila());
    const seletor = screen.getByTestId("fila-numero");
    expect(seletor).toHaveTextContent("Todos os números");

    await userEvent.click(seletor);
    await userEvent.click(screen.getByRole("option", { name: "+551140637232" }));

    expect(linhasDa("na-fila")).toEqual(["transferida", "tocando-suporte"]);
    expect(linhasDa("no-menu")).toEqual(["nos-avisos"]);
    expect(secao("em-ligacao")).toBeNull();
    expect(linhasDa("perdidas")).toEqual(["perdida-suporte"]);
    // O selo de cada chip conta o que a lista mostra: por este número, ninguém espera em Vendas.
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveTextContent("2");
    expect(screen.queryByRole("button", { name: /^Filtrar por time: Vendas/ })).toBeNull();
  });

  it("o número com apelido aparece pelo apelido e pelo número", async () => {
    pintar(fila());
    await userEvent.click(screen.getByTestId("fila-numero"));
    expect(screen.getByRole("option", { name: "Matriz · +551130250000" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Todos os números" })).toBeInTheDocument();
  });

  it("com um número só, não há o que escolher: o seletor não aparece", () => {
    pintar(fila({ numeros: [{ id: "n-1", nome: "Matriz", numero: "+551130250000" }] }));
    expect(screen.queryByTestId("fila-numero")).toBeNull();
  });

  it("filtro que esvazia tudo diz que está vazio e mantém o chip para desfazê-lo", async () => {
    // Só Vendas tem ligação; escolhe-se Vendas e a ligação acaba.
    const soVendas = fila({ ligacoes: LIGACOES.filter((l) => l.id === "primeira-de-vendas"), perdidas: [] });
    const { rerender, onSelect } = pintar(soVendas);
    await userEvent.click(screen.getByRole("button", { name: /^Filtrar por time: Vendas/ }));

    const consulta = { data: { ...soVendas, ligacoes: [] }, isPending: false, isError: false, refetch: vi.fn() } as unknown as Consulta;
    rerender(<FilaDoTelefone consulta={consulta} selectedId={null} onSelect={onSelect} />);

    expect(screen.getByText("Nenhuma ligação agora.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filtrar por time: Vendas/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Todos/ })).toBeInTheDocument();
  });
});

describe("abrir a conversa", () => {
  it("clicar numa linha com conversa pede para abri-la", async () => {
    const { onSelect } = pintar(fila());
    await userEvent.click(linha("primeira-de-vendas"));
    expect(onSelect).toHaveBeenCalledWith("conv-primeira");
  });

  it("linha sem conversa não é botão", () => {
    pintar(fila());
    expect(linha("primeira-de-vendas").tagName).toBe("BUTTON");
    expect(linha("segunda-de-vendas").tagName).toBe("DIV");
  });

  it("a linha da conversa aberta fica marcada", () => {
    pintar(fila(), {}, "conv-tocando");
    expect(linha("tocando-suporte")).toHaveAttribute("aria-current", "true");
    expect(linha("primeira-de-vendas")).not.toHaveAttribute("aria-current");
  });
});

describe("as perdidas dos últimos 30 minutos", () => {
  const perdidaNaTela = (id: string) => document.querySelector(`[data-perdida-id="${id}"]`) as HTMLElement;

  it("dizem quem, de qual time, por quê, quanto esperou e há quanto tempo", () => {
    pintar(fila());
    const vendas = perdidaNaTela("perdida-vendas");
    expect(vendas).toHaveAttribute("data-motivo", "desistiu_na_fila");
    expect(within(vendas).getByText("João Lima")).toBeInTheDocument();
    expect(within(vendas).getByText("+5511977776666 · Vendas")).toBeInTheDocument();
    expect(vendas).toHaveTextContent("Desistiu na fila · esperou 1:15 · há 5 min");

    const suporte = perdidaNaTela("perdida-suporte");
    expect(within(suporte).getByText("+5511911111111")).toBeInTheDocument();
    expect(suporte).toHaveTextContent("A fila esgotou · esperou 2:00 · agora há pouco");
  });

  it.each([
    ["desligou_no_menu", "Desligou no menu"],
    ["desistiu_na_fila", "Desistiu na fila"],
    ["fila_esgotada", "A fila esgotou"],
    ["ninguem_atendeu", "Ninguém atendeu"],
    ["fora_do_horario", "Fora do horário"],
    ["interrompida", "Interrompida"],
    ["outro", "Não atendida"],
  ] as const)("o motivo %s aparece como '%s'", (motivo, texto) => {
    pintar(fila({ ligacoes: [], perdidas: [perdida("p", { motivo })] }));
    expect(perdidaNaTela("p")).toHaveTextContent(texto);
  });

  it("ligar de volta só existe onde há contato — e liga para ELE", () => {
    pintar(fila());
    const botao = within(perdidaNaTela("perdida-vendas")).getByTestId("botao-ligar");
    expect(botao).toHaveAttribute("data-contato", "c-9");
    expect(botao).toHaveAttribute("data-variante", "icone");
    expect(within(perdidaNaTela("perdida-suporte")).queryByTestId("botao-ligar")).toBeNull();
  });

  it("clicar na perdida com conversa a abre; a sem conversa não tem o que clicar", async () => {
    const { onSelect } = pintar(fila());
    await userEvent.click(within(perdidaNaTela("perdida-vendas")).getByRole("button", { name: /João Lima/ }));
    expect(onSelect).toHaveBeenCalledWith("conv-perdida");
    expect(within(perdidaNaTela("perdida-suporte")).queryByRole("button")).toBeNull();
  });
});

describe("quando não há fila para mostrar", () => {
  it("carregando, sem dado: um esqueleto", () => {
    pintar(undefined);
    expect(screen.getByTestId("fila-do-telefone-carregando")).toBeInTheDocument();
    expect(screen.queryByTestId("fila-do-telefone")).toBeNull();
  });

  it("a leitura falhou e não há dado: o erro, com o botão que tenta de novo", async () => {
    const { refetch } = pintar(undefined, { isPending: false, isError: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível ler a fila do telefone.");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a releitura falhou mas há dado: a fila que se tinha continua na tela", () => {
    pintar(fila(), { isError: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(linhasDa("na-fila")).toHaveLength(4);
  });

  it("organização sem telefone: diz isso, e não desenha fila nem chip", () => {
    pintar(fila({ ativa: false, times: [], numeros: [], ligacoes: [], perdidas: [] }));
    expect(screen.getByText("O telefone não está ligado nesta organização.")).toBeInTheDocument();
    expect(screen.queryByTestId("fila-do-telefone")).toBeNull();
    expect(screen.queryByTestId("chips-da-fila")).toBeNull();
  });
});
