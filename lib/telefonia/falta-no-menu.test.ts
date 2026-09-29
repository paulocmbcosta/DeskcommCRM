import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { MENSAGEM_DO_QUE_FALTA, estaArquivado, oQueFaltaNoMenu, type MenuParaConferir, type OQueFalta } from "./falta-no-menu";

const PRONTO: MenuParaConferir = {
  nome: "Principal",
  opcoes: [
    { tecla: "1", time_id: "t1" },
    { tecla: "2", time_id: "t2" },
  ],
  time_padrao_id: "t1",
  algumTimeArquivado: false,
  textoDoMenu: "Para Suporte, digite 1. Para Financeiro, digite 2.",
  faltaPrevia: false,
  audioSumiu: false,
};

describe("oQueFaltaNoMenu", () => {
  it("menu completo, com a prévia de cada fala: nada falta", () => {
    expect(oQueFaltaNoMenu(PRONTO)).toBeNull();
  });

  it.each<[string, Partial<MenuParaConferir>, OQueFalta]>([
    ["nome em branco", { nome: "   " }, "nome"],
    ["menu sem opção", { opcoes: [] }, "opcao"],
    ["opção sem time", { opcoes: [{ tecla: "1", time_id: "" }] }, "time_da_opcao"],
    ["duas opções na mesma tecla", { opcoes: [{ tecla: "1", time_id: "t1" }, { tecla: "1", time_id: "t2" }] }, "tecla_repetida"],
    ["sem time padrão", { time_padrao_id: "" }, "time_padrao"],
    ["time arquivado", { algumTimeArquivado: true }, "time_arquivado"],
    ["fala em branco", { textoDoMenu: "  " }, "texto"],
    ["falta a prévia", { faltaPrevia: true }, "previa"],
    ["o áudio salvo sumiu e falta a prévia nova", { faltaPrevia: true, audioSumiu: true }, "audio_sumiu"],
  ])("%s", (_caso, mudanca, esperado) => {
    expect(oQueFaltaNoMenu({ ...PRONTO, ...mudanca })).toBe(esperado);
  });

  it("o áudio que sumiu só importa enquanto falta a prévia (a nova conserta)", () => {
    expect(oQueFaltaNoMenu({ ...PRONTO, audioSumiu: true })).toBeNull();
  });

  it("diz a PRIMEIRA coisa que falta, na ordem em que a pessoa preenche o editor", () => {
    const tudoErrado: MenuParaConferir = {
      nome: "",
      opcoes: [{ tecla: "1", time_id: "" }],
      time_padrao_id: "",
      algumTimeArquivado: true,
      textoDoMenu: "",
      faltaPrevia: true,
      audioSumiu: true,
    };
    expect(oQueFaltaNoMenu(tudoErrado)).toBe("nome");
    expect(oQueFaltaNoMenu({ ...tudoErrado, nome: "X" })).toBe("time_da_opcao");
    expect(oQueFaltaNoMenu({ ...tudoErrado, nome: "X", opcoes: PRONTO.opcoes })).toBe("time_padrao");
    expect(oQueFaltaNoMenu({ ...tudoErrado, nome: "X", opcoes: PRONTO.opcoes, time_padrao_id: "t1" })).toBe("time_arquivado");
  });

  it("toda frase do que falta tem espanhol (a tela a passa por t() a partir da constante)", () => {
    for (const frase of Object.values(MENSAGEM_DO_QUE_FALTA)) expect(DICIONARIO[frase]?.es, frase).toBeTruthy();
  });
});

describe("estaArquivado", () => {
  const times = [
    { id: "ativo", archived: false },
    { id: "velho", archived: true },
  ];
  it("só o time que a lista conhece E marca como arquivado", () => {
    expect(estaArquivado(times, "velho")).toBe(true);
    expect(estaArquivado(times, "ativo")).toBe(false);
    // Um id que a lista não conhece fica com a rota (`time_invalido`), não com a tela.
    expect(estaArquivado(times, "desconhecido")).toBe(false);
  });
});
