import { describe, expect, it } from "vitest";

import {
  FRASE_DA_OPCAO,
  TEXTO_SUGERIDO,
  montarTextoDoMenu,
  naOrdemFalada,
  numeroParaFalar,
  textoSugeridoForaDoHorario,
  trocarMarcador,
} from "./texto-do-menu";
import { TECLAS_DO_MENU } from "./vocabulario";

describe("naOrdemFalada", () => {
  it("põe as opções na ordem em que a fala as diz — 1 a 9, e o 0 por último — sem mexer na lista original", () => {
    const opcoes = [{ tecla: "0" }, { tecla: "3" }, { tecla: "1" }];
    expect(naOrdemFalada(opcoes).map((o) => o.tecla)).toEqual(["1", "3", "0"]);
    expect(opcoes.map((o) => o.tecla)).toEqual(["0", "3", "1"]);
  });

  it("a lista de teclas que a tela oferece já está nessa ordem (uma regra só)", () => {
    const teclas = TECLAS_DO_MENU.map((tecla) => ({ tecla }));
    expect(naOrdemFalada([...teclas].reverse()).map((o) => o.tecla)).toEqual([...TECLAS_DO_MENU]);
  });
});

describe("trocarMarcador", () => {
  it("troca todas as ocorrências pelo valor LITERAL — `$&` e `$$` num nome de time não viram padrão", () => {
    expect(trocarMarcador("Time arquivado ({times}).", "{times}", "A$&B")).toBe("Time arquivado (A$&B).");
    expect(trocarMarcador("{n} e {n}", "{n}", "Cobrança $$")).toBe("Cobrança $$ e Cobrança $$");
    expect(trocarMarcador("sem marcador", "{n}", "x")).toBe("sem marcador");
    // `$\`` (o que vem ANTES do marcador) e `$'` (o que vem depois) também são literais.
    expect(trocarMarcador("Ligado às 11:30 por {nome}.", "{nome}", "Ana $` X")).toBe("Ligado às 11:30 por Ana $` X.");
    expect(trocarMarcador("{n} fim", "{n}", "A$'B")).toBe("A$'B fim");
  });
});

describe("montarTextoDoMenu", () => {
  it("monta a fala a partir das opções, na ordem das teclas", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "2", nomeDoTime: "Financeiro" },
        { tecla: "1", nomeDoTime: "Suporte Técnico" },
      ]),
    ).toBe("Para Suporte Técnico, digite 1. Para Financeiro, digite 2.");
  });

  it("o 0 vem por último — é a tecla de 'falar com alguém' por costume", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "0", nomeDoTime: "Recepção" },
        { tecla: "1", nomeDoTime: "Vendas" },
      ]),
    ).toBe("Para Vendas, digite 1. Para Recepção, digite 0.");
  });

  it("ignora opção sem time escolhido e tecla fora de 0–9", () => {
    expect(
      montarTextoDoMenu([
        { tecla: "1", nomeDoTime: "  " },
        { tecla: "*", nomeDoTime: "Suporte" },
        { tecla: "3", nomeDoTime: " Cobrança " },
      ]),
    ).toBe("Para Cobrança, digite 3.");
  });

  it("aceita a frase traduzida pela tela", () => {
    expect(montarTextoDoMenu([{ tecla: "1", nomeDoTime: "Ventas" }], "Para {time}, marque {tecla}.")).toBe(
      "Para Ventas, marque 1.",
    );
  });

  it("a frase padrão e os textos sugeridos existem", () => {
    expect(FRASE_DA_OPCAO).toContain("{time}");
    expect(FRASE_DA_OPCAO).toContain("{tecla}");
    for (const texto of Object.values(TEXTO_SUGERIDO)) expect(texto.trim().length).toBeGreaterThan(5);
  });

  it("o nome do time entra literal: sem interpretar padrão de substituição ($$, $&) e sem repetir a troca de {tecla} quando o nome do time contém o próprio marcador", () => {
    expect(montarTextoDoMenu([{ tecla: "1", nomeDoTime: "Cobrança $$" }])).toBe("Para Cobrança $$, digite 1.");
    expect(montarTextoDoMenu([{ tecla: "1", nomeDoTime: "Vendas $&" }])).toBe("Para Vendas $&, digite 1.");
    expect(montarTextoDoMenu([{ tecla: "3", nomeDoTime: "Suporte {tecla}" }])).toBe(
      "Para Suporte {tecla}, digite 3.",
    );
  });
});

describe("o 'fora do horário' sugerido com o WhatsApp da organização (desenho §4)", () => {
  it("numeroParaFalar: do Brasil do jeito que se fala; de outro país com +; o que não é telefone vira null", () => {
    expect(numeroParaFalar("+5561999990000")).toBe("(61) 99999-0000");
    expect(numeroParaFalar("556136861503")).toBe("(61) 3686-1503");
    expect(numeroParaFalar("+14155550100")).toBe("+14155550100");
    expect(numeroParaFalar(null)).toBeNull();
    expect(numeroParaFalar("abc")).toBeNull();
  });

  it("com número, o texto sugerido o cita; sem número, é o texto de sempre; a frase passa pela tradução antes do número", () => {
    expect(textoSugeridoForaDoHorario("+5561999990000")).toBe(
      "Nosso atendimento está fechado agora. Se preferir, mande uma mensagem no nosso WhatsApp, (61) 99999-0000. Obrigado pela ligação.",
    );
    expect(textoSugeridoForaDoHorario(null)).toBe(TEXTO_SUGERIDO.after_hours);
    expect(textoSugeridoForaDoHorario("+5561999990000", (s) => s.replace("Nosso", "O nosso"))).toMatch(/^O nosso atendimento/);
  });
});
