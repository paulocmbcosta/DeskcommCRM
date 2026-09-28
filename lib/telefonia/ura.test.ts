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

/** Aplica uma sequência de eventos e devolve o estado e TODAS as ações. */
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

  it("tecla válida DURANTE a fala: para a fala e encaminha ao time da opção", () => {
    const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "2" }]);
    expect(acoes).toEqual([{ tipo: "encaminhar", teamId: FINANCEIRO, desfecho: "chosen", digito: "2", pararAtual: true }]);
  });

  it("fim da fala → espera 5 s; tecla na espera não precisa parar fala nenhuma", () => {
    const { acoes } = rodar(menu, [{ tipo: "fim_da_fala" }, { tipo: "tecla", digito: "1" }]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS },
      { tipo: "encaminhar", teamId: SUPORTE, desfecho: "chosen", digito: "1", pararAtual: false },
    ]);
  });

  it("sem tecla: repete o menu duas vezes e na terceira vai ao padrão com default_no_input", () => {
    const passo = [{ tipo: "fim_da_fala" }, { tipo: "prazo" }] as EventoDaUra[];
    const { acoes } = rodar(menu, [...passo, ...passo, ...passo]);
    expect(acoes).toEqual([
      { tipo: "esperar", ms: 5_000 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000 },
      { tipo: "tocar", fala: "menu", pararAtual: false },
      { tipo: "esperar", ms: 5_000 },
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
      { tipo: "prazo" },
      { tipo: "fim_da_fala" },
      { tipo: "prazo" },
    ]);
    expect(acoes.at(-1)).toEqual({ tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_invalid", digito: null, pararAtual: false });
  });

  it("prazo fora da espera e fim de fala sem fala tocando são ignorados", () => {
    expect(passoDaUra(menu, ESTADO_INICIAL_DA_URA, { tipo: "prazo" }).acao).toEqual({ tipo: "ignorar" });
    const semFala: EstadoDaUra = { ...ESTADO_INICIAL_DA_URA, tocando: null };
    expect(passoDaUra(menu, semFala, { tipo: "fim_da_fala" }).acao).toEqual({ tipo: "ignorar" });
  });
});
