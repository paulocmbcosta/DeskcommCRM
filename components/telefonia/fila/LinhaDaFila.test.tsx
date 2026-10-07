/**
 * UMA LIGAÇÃO VIVA NA ABA TELEFONE — o que a linha diz em cada fase, quando a
 * área principal é um botão (abre a conversa) e o que fica AO LADO dela: os
 * botões de Atender e Mover (entrega 3), ou a frase de quem já está cuidando.
 *
 * O relógio entra por prop (`agoraMs`): a linha não lê hora nenhuma, então o
 * teste não espera nem simula tempo. Quem pode o quê também entra por prop
 * (`acoes`): quem decide pelo papel e pelo ramal é a coluna, e o teste dela mede.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LigacaoNaFila } from "@/lib/telefonia/fila";

import { LinhaDaFila, type AcoesDaLinha } from "./LinhaDaFila";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O menu de mover lê o diretório do telefone (quantos livres em cada time) — só quando abre.
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: api.get } }));

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
    ordem: null,
    ...over,
  };
}

const TIMES = [
  { id: "t-vendas", nome: "Vendas" },
  { id: "t-suporte", nome: "Suporte" },
  { id: "t-financeiro", nome: "Financeiro" },
];

/** Gerente com ramal: pode tudo. Cada caso tira o que não é dele. */
function acoes(over: Partial<AcoesDaLinha> = {}): AcoesDaLinha {
  return {
    podeAtender: true,
    podeMover: true,
    emCurso: null,
    puxando: false,
    times: TIMES,
    onAtender: vi.fn(),
    onMover: vi.fn(),
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

const botaoAtender = () => document.querySelector<HTMLButtonElement>("[data-fila-atender]");
const botaoMover = () => document.querySelector<HTMLButtonElement>("[data-fila-mover]");
const fraseDaOrdem = () => document.querySelector<HTMLElement>("[data-fila-ordem]");

// O jsdom não tem a captura de ponteiro que o menu do Radix usa para abrir.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async (url: string) => {
    if (url !== "/api/v1/telefonia/diretorio") throw new Error(`GET inesperado ${url}`);
    return {
      data: {
        meu_ramal: "201",
        pessoas: [],
        times: [
          { id: "t-vendas", nome: "Vendas", disponiveis: 3, situacao: "aberto" },
          { id: "t-suporte", nome: "Suporte", disponiveis: 2, situacao: "aberto" },
          { id: "t-financeiro", nome: "Financeiro", disponiveis: 0, situacao: "fora_do_horario" },
        ],
      },
    };
  });
});
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
  it("com `onAbrir`, a área principal é um botão e clicar abre", async () => {
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

  it("a selecionada é marcada, como a conversa selecionada na lista — a LINHA inteira, com as ações", () => {
    const { linha } = pintar({}, { selecionada: true, acoes: acoes() });
    expect(linha).toHaveAttribute("aria-current", "true");
    // O fundo é da linha toda (a área que abre a conversa E os botões ao lado):
    // marcado só na área principal, os botões ficariam num retalho de outra cor.
    const linhaInteira = linha.closest("[data-linha-da-fila]") as HTMLElement;
    expect(linhaInteira).toHaveAttribute("data-linha-da-fila", "lig-1");
    expect(linhaInteira.className).toContain("bg-accent-50");
    expect(linhaInteira.contains(botaoAtender())).toBe(true);
  });

  it("CONTROLE — a não selecionada não é marcada", () => {
    const { linha } = pintar({}, { acoes: acoes() });
    expect(linha).not.toHaveAttribute("aria-current");
    expect((linha.closest("[data-linha-da-fila]") as HTMLElement).className).not.toContain("bg-accent-50");
  });
});

describe("atender e mover direto da fila (entrega 3)", () => {
  describe("em que fases os botões aparecem", () => {
    it.each(["aguardando", "tocando"] as const)("%s: Atender e Mover, para quem pode os dois", (fase) => {
      pintar({ fase, tocando_para: fase === "tocando" ? { id: "u-outro", nome: "Bruno" } : null }, { acoes: acoes() });
      expect(botaoAtender()).toHaveTextContent("Atender");
      expect(botaoAtender()).toHaveAttribute("data-fila-atender", "lig-1");
      expect(botaoMover()).toHaveAccessibleName("Mover para outro time");
      expect(botaoMover()).toHaveAttribute("data-fila-mover", "lig-1");
    });

    it.each(["menu", "avisos", "em_ligacao", "transferencia_na_fila"] as const)(
      "%s: nenhum botão, nem para quem pode tudo",
      (fase) => {
        pintar({ fase, posicao: null, cai_em: null }, { acoes: acoes() });
        expect(botaoAtender()).toBeNull();
        expect(botaoMover()).toBeNull();
        expect(document.querySelector("[data-fila-acoes]")).toBeNull();
      },
    );
  });

  describe("quem vê o quê", () => {
    it("quem só olha (sem `acoes`) não vê botão nenhum", () => {
      pintar();
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).toBeNull();
    });

    it("atendente com ramal vê Atender, e não vê Mover", () => {
      pintar({}, { acoes: acoes({ podeMover: false }) });
      expect(botaoAtender()).not.toBeNull();
      expect(botaoMover()).toBeNull();
    });

    it("atendente SEM ramal não vê Atender (nem a faixa das ações)", () => {
      pintar({}, { acoes: acoes({ podeAtender: false, podeMover: false }) });
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).toBeNull();
      expect(document.querySelector("[data-fila-acoes]")).toBeNull();
    });

    it("gerente sem ramal vê só Mover", () => {
      pintar({}, { acoes: acoes({ podeAtender: false }) });
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).not.toBeNull();
    });

    it("com um time só na organização não há para onde mover: sem o botão Mover", () => {
      pintar({}, { acoes: acoes({ times: [{ id: "t-vendas", nome: "Vendas" }] }) });
      expect(botaoMover()).toBeNull();
      expect(botaoAtender()).not.toBeNull();
    });
  });

  describe("a ligação que toca para MIM", () => {
    it("diz 'Tocando para você' e NÃO oferece Atender — atende-se pelo aviso de toque; Mover continua", () => {
      const { estado } = pintar(
        { fase: "tocando", cai_em: null, tocando_para: { id: "u-eu", nome: "Carla Gerente" } },
        { acoes: acoes(), euId: "u-eu" },
      );
      expect(estado()).toHaveTextContent("Tocando para você · na fila há 3:42");
      expect(estado()).not.toHaveTextContent("Carla Gerente");
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).not.toBeNull();
    });

    it("CONTROLE — tocando para OUTRA pessoa: o nome dela, e Atender aparece", () => {
      const { estado } = pintar(
        { fase: "tocando", cai_em: null, tocando_para: { id: "u-outro", nome: "Bruno" } },
        { acoes: acoes(), euId: "u-eu" },
      );
      expect(estado()).toHaveTextContent("Tocando para Bruno · na fila há 3:42");
      expect(botaoAtender()).not.toBeNull();
    });

    it("CONTROLE — aguardando: ninguém toca, Atender aparece para mim", () => {
      pintar({ fase: "aguardando" }, { acoes: acoes(), euId: "u-eu" });
      expect(botaoAtender()).not.toBeNull();
    });

    it("sem saber quem olha (`euId` ausente), ninguém é 'você'", () => {
      const { estado } = pintar(
        { fase: "tocando", cai_em: null, tocando_para: { id: "u-eu", nome: "Carla Gerente" } },
        { acoes: acoes() },
      );
      expect(estado()).toHaveTextContent("Tocando para Carla Gerente");
      expect(botaoAtender()).not.toBeNull();
    });
  });

  describe("Atender", () => {
    it("o clique chama a ação desta ligação — e não abre a conversa", async () => {
      const a = acoes();
      const { onAbrir } = pintar({}, { acoes: a });
      await userEvent.click(botaoAtender()!);
      expect(a.onAtender).toHaveBeenCalledTimes(1);
      expect(a.onMover).not.toHaveBeenCalled();
      expect(onAbrir).not.toHaveBeenCalled();
    });

    it.each(["aguardando", "tocando"] as const)(
      "%s: não fica desligado pelo estado da ligação — quem recusa, com o motivo, é a rota",
      (fase) => {
        pintar({ fase, tocando_para: fase === "tocando" ? { id: "u-outro", nome: "Bruno" } : null }, { acoes: acoes() });
        expect(botaoAtender()).toBeEnabled();
        expect(botaoAtender()).not.toHaveAttribute("aria-busy", "true");
        expect(botaoMover()).toBeEnabled();
      },
    );

    it("enquanto o MEU pedido de atender corre nesta ligação, o botão fica ocupado — e o Mover espera", async () => {
      const a = acoes({ emCurso: "atender", puxando: true });
      pintar({}, { acoes: a });
      expect(botaoAtender()).toHaveAttribute("aria-busy", "true");
      expect(botaoAtender()).toBeDisabled();
      expect(botaoMover()).toBeDisabled();
      expect(botaoMover()).not.toHaveAttribute("aria-busy", "true");
      await userEvent.click(botaoAtender()!);
      expect(a.onAtender).not.toHaveBeenCalled();
    });

    it("com um Atender meu em curso em OUTRA ligação, o desta espera (só se puxa uma por vez) — sem dizer que está ocupado", () => {
      pintar({}, { acoes: acoes({ puxando: true }) });
      expect(botaoAtender()).toBeDisabled();
      expect(botaoAtender()).not.toHaveAttribute("aria-busy", "true");
      // Mover é outro pedido, de outra ligação: segue livre.
      expect(botaoMover()).toBeEnabled();
    });
  });

  describe("Mover", () => {
    it("o menu lista os OUTROS times, com quantos estão livres em cada um; escolher chama a ação com o time", async () => {
      const a = acoes();
      const { onAbrir } = pintar({}, { acoes: a });
      // O diretório só é lido quando o menu abre.
      expect(api.get).not.toHaveBeenCalled();

      await userEvent.click(botaoMover()!);
      const menu = await screen.findByRole("menu");
      expect(api.get).toHaveBeenCalledWith("/api/v1/telefonia/diretorio");
      const itens = within(menu).getAllByRole("menuitem");
      // A ligação está em Vendas: Vendas não é destino.
      expect(itens.map((i) => i.getAttribute("data-fila-mover-para"))).toEqual(["t-suporte", "t-financeiro"]);
      expect(await within(menu).findByText("2 disponíveis")).toBeInTheDocument();
      expect(itens[0]).toHaveTextContent("Suporte");
      expect(itens[1]).toHaveTextContent("Financeiro");
      expect(itens[1]).toHaveTextContent("Fora do horário");

      await userEvent.click(itens[0]!);
      expect(a.onMover).toHaveBeenCalledTimes(1);
      expect(a.onMover).toHaveBeenCalledWith({ id: "t-suporte", nome: "Suporte" });
      expect(a.onAtender).not.toHaveBeenCalled();
      expect(onAbrir).not.toHaveBeenCalled();
    });

    it("um livre se escreve no singular; time que o diretório não trouxe aparece só pelo nome", async () => {
      api.get.mockResolvedValue({
        data: { meu_ramal: null, pessoas: [], times: [{ id: "t-suporte", nome: "Suporte", disponiveis: 1, situacao: "aberto" }] },
      });
      pintar({}, { acoes: acoes() });
      await userEvent.click(botaoMover()!);
      const menu = await screen.findByRole("menu");
      expect(await within(menu).findByText("1 disponível")).toBeInTheDocument();
      const financeiro = within(menu).getAllByRole("menuitem")[1]!;
      expect(financeiro).toHaveTextContent(/^Financeiro$/);
    });

    it("o diretório que não responde não segura o menu: os times aparecem pelo nome e dá para mover", async () => {
      api.get.mockRejectedValue(new Error("502"));
      const a = acoes();
      pintar({}, { acoes: a });
      await userEvent.click(botaoMover()!);
      const itens = within(await screen.findByRole("menu")).getAllByRole("menuitem");
      expect(itens.map((i) => i.textContent)).toEqual(["Suporte", "Financeiro"]);
      await userEvent.click(itens[1]!);
      expect(a.onMover).toHaveBeenCalledWith({ id: "t-financeiro", nome: "Financeiro" });
    });

    it("ligação sem time (ainda sem destino): todos os times são destino", async () => {
      pintar({ time_id: null }, { acoes: acoes(), nomeDoTime: null });
      await userEvent.click(botaoMover()!);
      const itens = within(await screen.findByRole("menu")).getAllByRole("menuitem");
      expect(itens.map((i) => i.getAttribute("data-fila-mover-para"))).toEqual(["t-vendas", "t-suporte", "t-financeiro"]);
    });

    it("enquanto o MEU pedido de mover corre, o botão fica ocupado e o menu não abre — e o Atender espera", async () => {
      pintar({}, { acoes: acoes({ emCurso: "mover" }) });
      expect(botaoMover()).toHaveAttribute("aria-busy", "true");
      expect(botaoMover()).toBeDisabled();
      expect(botaoAtender()).toBeDisabled();
      expect(botaoAtender()).not.toHaveAttribute("aria-busy", "true");
      await userEvent.click(botaoMover()!);
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("a ordem aberta troca os botões pela frase de quem está cuidando", () => {
    it("alguém pediu para atender: '{nome} está atendendo…', sem botão", () => {
      pintar(
        { ordem: { tipo: "pull", por: { id: "u-ana", nome: "Ana" }, para_time_id: null } },
        { acoes: acoes() },
      );
      expect(fraseDaOrdem()).toHaveTextContent(/^Ana está atendendo…$/);
      expect(fraseDaOrdem()).toHaveAttribute("data-fila-ordem", "pull");
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).toBeNull();
    });

    it("alguém está movendo: 'Movendo para {time}…', com o nome do time de destino", () => {
      pintar(
        { fase: "tocando", tocando_para: { id: "u-outro", nome: "Bruno" }, ordem: { tipo: "move", por: { id: "u-ana", nome: "Ana" }, para_time_id: "t-financeiro" } },
        { acoes: acoes(), nomeDoTimeDaOrdem: "Financeiro" },
      );
      expect(fraseDaOrdem()).toHaveTextContent(/^Movendo para Financeiro…$/);
      expect(fraseDaOrdem()).toHaveAttribute("data-fila-ordem", "move");
      expect(botaoAtender()).toBeNull();
      expect(botaoMover()).toBeNull();
    });

    it("sem o nome de quem pediu, ou do time: 'alguém' e 'outro time' — nunca um buraco na frase", () => {
      pintar({ ordem: { tipo: "pull", por: null, para_time_id: null } }, { acoes: acoes() });
      expect(fraseDaOrdem()).toHaveTextContent(/^alguém está atendendo…$/);
      cleanup();
      pintar({ ordem: { tipo: "pull", por: { id: "u-x", nome: "  " }, para_time_id: null } }, { acoes: acoes() });
      expect(fraseDaOrdem()).toHaveTextContent(/^alguém está atendendo…$/);
      cleanup();
      pintar({ ordem: { tipo: "move", por: null, para_time_id: "t-sumiu" } }, { acoes: acoes(), nomeDoTimeDaOrdem: null });
      expect(fraseDaOrdem()).toHaveTextContent(/^Movendo para outro time…$/);
    });

    it("o nome sai como está cadastrado: `$&` e marcador no nome não viram outra coisa", () => {
      pintar({ ordem: { tipo: "pull", por: { id: "u-x", nome: "Ana $& {nome}" }, para_time_id: null } }, { acoes: acoes() });
      expect(fraseDaOrdem()).toHaveTextContent("Ana $& {nome} está atendendo…");
    });

    it("quem só olha também lê quem está cuidando", () => {
      pintar({ ordem: { tipo: "pull", por: { id: "u-ana", nome: "Ana" }, para_time_id: null } });
      expect(fraseDaOrdem()).toHaveTextContent("Ana está atendendo…");
    });

    it("fora da fila a ordem não é assunto: a linha em ligação não ganha frase", () => {
      pintar(
        { fase: "em_ligacao", posicao: null, cai_em: null, com: { id: "u-ana", nome: "Ana" }, ordem: { tipo: "pull", por: { id: "u-ana", nome: "Ana" }, para_time_id: null } },
        { acoes: acoes() },
      );
      expect(fraseDaOrdem()).toBeNull();
      expect(botaoAtender()).toBeNull();
    });
  });

  describe("a área principal segue abrindo a conversa", () => {
    it("com os botões ao lado, clicar na área principal abre — e não há botão dentro de botão", async () => {
      const a = acoes();
      const { linha, onAbrir } = pintar({}, { acoes: a });
      expect(linha.tagName).toBe("BUTTON");
      // Botão dentro de botão é HTML inválido: as ações são IRMÃS da área principal.
      expect(document.querySelector("button button")).toBeNull();
      expect(linha.contains(botaoAtender())).toBe(false);
      expect(linha.contains(botaoMover())).toBe(false);

      await userEvent.click(linha);
      expect(onAbrir).toHaveBeenCalledTimes(1);
      expect(a.onAtender).not.toHaveBeenCalled();
    });

    it("a ligação sem conversa não abre nada, mas pode ser atendida e movida", async () => {
      const a = acoes();
      const { linha } = pintar({ conversa_id: null }, { onAbrir: undefined, acoes: a });
      expect(linha.tagName).toBe("DIV");
      await userEvent.click(botaoAtender()!);
      expect(a.onAtender).toHaveBeenCalledTimes(1);
    });

    it("o que a linha diz não muda com os botões: nome, detalhes e estado são os mesmos", () => {
      const { linha, estado } = pintar({}, { acoes: acoes() });
      expect(within(linha).getByText("Maria Souza")).toBeInTheDocument();
      expect(within(linha).getByText("+5511988887777 · Vendas · pelo +551130250000")).toBeInTheDocument();
      expect(estado()).toHaveTextContent("Aguardando há 3:42 · cai em 6:18");
      expect(linha).toHaveAttribute("data-fase", "aguardando");
    });
  });
});
