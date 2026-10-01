import { describe, expect, it } from "vitest";

import {
  ESPERA_APOS_O_MENU_MS,
  ESPERA_ENTRE_DIGITOS_MS,
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

  describe("a fala que não tocou (fala_falhou): a decisão é da regra, não do controlador", () => {
    it("o menu não tocou na primeira vez: time padrão com default_no_input, sem fala para parar", () => {
      const { acoes, estado } = rodar(menu, [{ tipo: "fala_falhou" }]);
      expect(acoes).toEqual([
        { tipo: "encaminhar", teamId: SUPORTE, desfecho: "default_no_input", digito: null, pararAtual: false },
      ]);
      expect(estado).toEqual({ fase: "decidida" });
    });

    it("o menu não tocou na repetição depois de uma tecla errada: time padrão com default_invalid", () => {
      const { acoes } = rodar(menu, [{ tipo: "tecla", digito: "9" }, { tipo: "fala_falhou" }]);
      expect(acoes.at(-1)).toEqual({
        tipo: "encaminhar",
        teamId: SUPORTE,
        desfecho: "default_invalid",
        digito: null,
        pararAtual: false,
      });
    });

    it("a fala de tecla inválida não tocou: pula para o menu, como se ela tivesse acabado", () => {
      const { acoes, estado } = rodar({ ...menu, temFalaInvalida: true }, [{ tipo: "tecla", digito: "7" }, { tipo: "fala_falhou" }]);
      expect(acoes).toEqual([
        { tipo: "tocar", fala: "invalida", pararAtual: true },
        { tipo: "tocar", fala: "menu", pararAtual: false },
      ]);
      expect(estado).toEqual({ fase: "tocando", vez: 2, fala: "menu", houveInvalida: true });
    });

    it("na espera (nada no ar) e depois de decidida: ignorado", () => {
      const esperando: EstadoDaUra = { fase: "esperando", vez: 1, houveInvalida: false };
      expect(passoDaUra(menu, esperando, { tipo: "fala_falhou" })).toEqual({ estado: esperando, acao: { tipo: "ignorar" } });
      const decidida: EstadoDaUra = { fase: "decidida" };
      expect(passoDaUra(menu, decidida, { tipo: "fala_falhou" })).toEqual({ estado: decidida, acao: { tipo: "ignorar" } });
    });
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

describe("menu que aceita ramal (v3)", () => {
  const menuComRamal = {
    opcoes: [
      { digito: "1", teamId: "suporte" },
      { digito: "2", teamId: "financeiro" },
    ],
    defaultTeamId: "padrao",
    temFalaInvalida: true,
    aceitaRamal: true,
  };
  const passo = (e: Parameters<typeof passoDaUra>[1], ev: Parameters<typeof passoDaUra>[2]) => passoDaUra(menuComRamal, e, ev);

  it("a primeira tecla para a fala e espera 2 s pela próxima; um dígito só vira a opção", () => {
    const a = passo(ESTADO_INICIAL_DA_URA, { tipo: "tecla", digito: "1" });
    expect(a.acao).toEqual({ tipo: "esperar_digitos", ms: ESPERA_ENTRE_DIGITOS_MS, seq: 1, pararAtual: true });
    const b = passo(a.estado, { tipo: "prazo_dos_digitos", seq: 1 });
    expect(b.acao).toEqual({ tipo: "encaminhar", teamId: "suporte", desfecho: "chosen", digito: "1", pararAtual: false });
  });

  it("2 a 4 dígitos são um ramal; o quarto decide sem esperar", () => {
    let e = passo(ESTADO_INICIAL_DA_URA, { tipo: "tecla", digito: "2" }).estado;
    e = passo(e, { tipo: "tecla", digito: "0" }).estado;
    const tres = passo(e, { tipo: "tecla", digito: "1" });
    expect(tres.acao).toMatchObject({ tipo: "esperar_digitos", seq: 3 });
    expect(passo(tres.estado, { tipo: "prazo_dos_digitos", seq: 3 }).acao).toEqual({ tipo: "ramal", numero: "201" });
    const quatro = passo(tres.estado, { tipo: "tecla", digito: "5" });
    expect(quatro.acao).toEqual({ tipo: "ramal", numero: "2015" });
  });

  it("# encerra a digitação; o prazo velho é ignorado", () => {
    let e = passo(ESTADO_INICIAL_DA_URA, { tipo: "tecla", digito: "2" }).estado;
    e = passo(e, { tipo: "tecla", digito: "0" }).estado;
    expect(passo(e, { tipo: "prazo_dos_digitos", seq: 1 }).acao).toEqual({ tipo: "ignorar" });
    expect(passo(e, { tipo: "tecla", digito: "#" }).acao).toEqual({ tipo: "ramal", numero: "20" });
  });

  it("ramal que não serve é tecla errada: a fala de inválida e o menu; na terceira, o time padrão", () => {
    let e = passo(ESTADO_INICIAL_DA_URA, { tipo: "tecla", digito: "9" }).estado;
    e = passo(e, { tipo: "tecla", digito: "9" }).estado;
    e = passo(e, { tipo: "prazo_dos_digitos", seq: 2 }).estado;
    expect(e.fase).toBe("ramal");
    // Enquanto confere, nada muda o rumo.
    expect(passo(e, { tipo: "tecla", digito: "1" }).acao).toEqual({ tipo: "ignorar" });
    const invalido = passo(e, { tipo: "ramal_invalido" });
    expect(invalido.acao).toEqual({ tipo: "tocar", fala: "invalida", pararAtual: false });
    expect(invalido.estado).toMatchObject({ fase: "tocando", vez: 2, houveInvalida: true });
    const naTerceira = passo({ fase: "ramal", vez: 3, houveInvalida: true }, { tipo: "ramal_invalido" });
    expect(naTerceira.acao).toMatchObject({ tipo: "encaminhar", teamId: "padrao", desfecho: "default_invalid" });
  });

  it("sem aceitar ramal, a tecla decide na hora, como antes", () => {
    const semRamal = { ...menuComRamal, aceitaRamal: false };
    expect(passoDaUra(semRamal, ESTADO_INICIAL_DA_URA, { tipo: "tecla", digito: "2" }).acao).toMatchObject({
      tipo: "encaminhar",
      teamId: "financeiro",
    });
  });
});
