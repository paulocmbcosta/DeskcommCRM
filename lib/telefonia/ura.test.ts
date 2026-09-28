import { describe, expect, it } from "vitest";

import {
  ESPERA_APOS_O_MENU_MS,
  ESTADO_INICIAL_DA_URA,
  VEZES_DO_MENU,
  passoDaUra,
  type EstadoDaUra,
  type EventoDaUra,
  type MenuDaUra,
} from "./ura";

const SUPORTE = "time-suporte";
const FINANCEIRO = "time-financeiro";
const menu: MenuDaUra = {
  opcoes: [
    { digito: "1", teamId: SUPORTE },
    { digito: "2", teamId: FINANCEIRO },
  ],
  defaultTeamId: SUPORTE,
  temFalaInvalida: false,
};

/** Aplica uma sequência de eventos e devolve o estado final e TODAS as ações. */
function rodar(m: MenuDaUra, eventos: EventoDaUra[]) {
  let estado: EstadoDaUra = ESTADO_INICIAL_DA_URA;
  const acoes = eventos.map((ev) => {
    const r = passoDaUra(m, estado, ev);
    estado = r.estado;
    return r.acao;
  });
  return { estado, acoes };
}

describe("URA — a regra pura (D5)", () => {
  it("são 3 vezes do menu (a primeira + 2 repetições) e 5 s de espera", () => {
    expect(VEZES_DO_MENU).toBe(3);
    expect(ESPERA_APOS_O_MENU_MS).toBe(5_000);
  });

  it("tecla válida DURANTE a fala: para a fala, decide e encaminha ao time da opção", () => {
    const { acoes, estado } = rodar(menu, [{ tipo: "tecla", digito: "2" }]);
    expect(acoes).toEqual([{ tipo: "encaminhar", teamId: FINANCEIRO, desfecho: "chosen", digito: "2", pararAtual: true }]);
    expect(estado).toEqual({ fase: "decidida" });
  });

  it("fim da fala → espera 5 s (com a vez); tecla na espera não precisa parar fala nenhuma", () => {
    const { acoes } = rodar(menu, [{ tipo: "fim_da_fala" }, { tipo: "tecla", digito: "1" }]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS, vez: 1 },
      { tipo: "encaminhar", teamId: SUPORTE, desfecho: "chosen", digito: "1", pararAtual: false },
    ]);
  });

  it("sem tecla: repete o menu duas vezes (prazo com a vez certa) e na terceira vai ao padrão com default_no_input", () => {
    const { acoes } = rodar(menu, [
      { tipo: "fim_da_fala" },
      { tipo: "prazo", vez: 1 },
      { tipo: "fim_da_fala" },
      { tipo: "prazo", vez: 2 },
      { tipo: "fim_da_fala" },
      { tipo: "prazo", vez: 3 },
    ]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: 5_000, vez: 1 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000, vez: 2 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000, vez: 3 },
      { tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_no_input", digito: null, pararAtual: false },
    ]);
  });

  it("tecla inválida sem fala de inválida: repete o menu na hora", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "9" }]);
    expect(acoes).toEqual([{ tipo: "tocar", fala: "menu", pararAtual: true }]);
  });

  it("tecla inválida COM fala de inválida: toca a inválida, e o fim dela volta ao menu", () => {
    const { acoes } = rodar({ ...menu, temFalaInvalida: true }, [{ tipo: "tecla", digito: "7" }, { tipo: "fim_da_fala" }]);
    expect(acoes).toEqual([
      { tipo: "tocar", fala: "invalida", pararAtual: true },
      { tipo: "tocar", fala: "menu", pararAtual: false },
    ]);
  });

  it("* e # são reservadas: contam como inválidas", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "*" }, { tipo: "tecla", digito: "#" }]);
    expect(acoes.map((a) => a.tipo)).toEqual(["tocar", "tocar"]);
  });

  it("três teclas erradas → padrão com default_invalid", () => {
    const { acoes } = rodar(menu, [
      { tipo: "tecla", digito: "9" },
      { tipo: "tecla", digito: "8" },
      { tipo: "tecla", digito: "#" },
    ]);
    expect(acoes.at(-1)).toEqual({ tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_invalid", digito: null, pararAtual: true });
  });

  it("uma tecla errada e depois silêncio → padrão com default_invalid (houve tecla errada)", () => {
    const { acoes } = rodar(menu, [
      { tipo: "tecla", digito: "9" },
      { tipo: "fim_da_fala" },
      { tipo: "prazo", vez: 2 },
      { tipo: "fim_da_fala" },
      { tipo: "prazo", vez: 3 },
    ]);
    expect(acoes.at(-1)).toEqual({ tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_invalid", digito: null, pararAtual: false });
  });

  it("prazo fora da espera e fim de fala sem fala tocando são ignorados", () => {
    expect(passoDaUra(menu, ESTADO_INICIAL_DA_URA, { tipo: "prazo", vez: 1 }).acao).toEqual({ tipo: "ignorar" });
    const semFala: EstadoDaUra = { fase: "esperando", vez: 1, houveInvalida: false };
    expect(passoDaUra(menu, semFala, { tipo: "fim_da_fala" }).acao).toEqual({ tipo: "ignorar" });
  });

  describe("estado final 'decidida': todo evento depois dele é ignorado, sem mudar nada", () => {
    const decidida: EstadoDaUra = { fase: "decidida" };

    it("tecla depois da decisão", () => {
      const r = passoDaUra(menu, decidida, { tipo: "tecla", digito: "1" });
      expect(r.acao).toEqual({ tipo: "ignorar" });
      expect(r.estado).toEqual(decidida);
    });

    it("prazo depois de ir para o time padrão", () => {
      const r = passoDaUra(menu, decidida, { tipo: "prazo", vez: 3 });
      expect(r.acao).toEqual({ tipo: "ignorar" });
      expect(r.estado).toEqual(decidida);
    });

    it("fim_da_fala depois da decisão", () => {
      const r = passoDaUra(menu, decidida, { tipo: "fim_da_fala" });
      expect(r.acao).toEqual({ tipo: "ignorar" });
      expect(r.estado).toEqual(decidida);
    });
  });

  it("prazo antigo (de uma vez anterior) numa espera nova: ignora e NÃO gasta repetição", () => {
    let estado: EstadoDaUra = ESTADO_INICIAL_DA_URA;
    estado = passoDaUra(menu, estado, { tipo: "fim_da_fala" }).estado; // esperando, vez 1
    estado = passoDaUra(menu, estado, { tipo: "prazo", vez: 1 }).estado; // tocando, vez 2
    estado = passoDaUra(menu, estado, { tipo: "fim_da_fala" }).estado; // esperando, vez 2
    const antesDoPrazoAntigo = estado;

    const velho = passoDaUra(menu, estado, { tipo: "prazo", vez: 1 }); // timer da 1ª espera, já vencido
    expect(velho.acao).toEqual({ tipo: "ignorar" });
    expect(velho.estado).toEqual(antesDoPrazoAntigo);

    const certo = passoDaUra(menu, velho.estado, { tipo: "prazo", vez: 2 }); // o prazo certo continua valendo
    expect(certo.acao).toEqual({ tipo: "tocar", fala: "menu", pararAtual: false });
  });

  it("prazo duplicado (o mesmo timer disparou 2x): a segunda vez ignora", () => {
    let estado: EstadoDaUra = ESTADO_INICIAL_DA_URA;
    estado = passoDaUra(menu, estado, { tipo: "fim_da_fala" }).estado; // esperando, vez 1
    const primeiro = passoDaUra(menu, estado, { tipo: "prazo", vez: 1 });
    expect(primeiro.acao.tipo).toBe("tocar");
    const segundo = passoDaUra(menu, primeiro.estado, { tipo: "prazo", vez: 1 });
    expect(segundo.acao).toEqual({ tipo: "ignorar" });
  });

  it("o estado de entrada nunca é mutado — congelado, sobrevive intacto a qualquer passo", () => {
    const casos: Array<{ estado: EstadoDaUra; evento: EventoDaUra }> = [
      { estado: { fase: "tocando", vez: 1, fala: "menu", houveInvalida: false }, evento: { tipo: "tecla", digito: "9" } },
      { estado: { fase: "tocando", vez: 1, fala: "menu", houveInvalida: false }, evento: { tipo: "fim_da_fala" } },
      { estado: { fase: "esperando", vez: 1, houveInvalida: false }, evento: { tipo: "prazo", vez: 1 } },
      { estado: { fase: "decidida" }, evento: { tipo: "tecla", digito: "1" } },
    ];
    for (const { estado, evento } of casos) {
      const congelado: EstadoDaUra = Object.freeze({ ...estado });
      const antes = { ...congelado };
      expect(() => passoDaUra(menu, congelado, evento)).not.toThrow();
      expect(congelado).toEqual(antes);
    }
  });
});
