import { describe, expect, it } from "vitest";

import {
  conferirRegistro,
  fraseDaRecusa,
  motivoDaRecusa,
  rotuloDoAssunto,
  type OpcoesDeEncerramento,
} from "./encerramento";

const comAssuntos: OpcoesDeEncerramento["times"] = [
  { id: "t1", name: "Suporte", assuntos: [{ id: "a1", name: "Wi-Fi" }] },
];

describe("motivoDaRecusa", () => {
  it("traduz as quatro mensagens do banco em campo e motivo", () => {
    expect(motivoDaRecusa("encerramento_assunto_obrigatorio")).toEqual({ campo: "assunto", motivo: "obrigatorio" });
    expect(motivoDaRecusa("encerramento_assunto_invalido")).toEqual({ campo: "assunto", motivo: "invalido" });
    expect(motivoDaRecusa("encerramento_resumo_obrigatorio")).toEqual({ campo: "resumo", motivo: "obrigatorio" });
    expect(motivoDaRecusa("encerramento_resumo_longo")).toEqual({ campo: "resumo", motivo: "longo" });
  });

  it("mensagem que não é recusa do encerramento devolve null", () => {
    expect(motivoDaRecusa("service_stale")).toBeNull();
    expect(motivoDaRecusa("invalid_status")).toBeNull();
    expect(motivoDaRecusa("")).toBeNull();
    expect(motivoDaRecusa(null)).toBeNull();
    // Nome de propriedade herdada não vira recusa.
    expect(motivoDaRecusa("toString")).toBeNull();
  });

  it("cada recusa tem uma frase própria", () => {
    const frases = [
      fraseDaRecusa({ campo: "assunto", motivo: "obrigatorio" }),
      fraseDaRecusa({ campo: "assunto", motivo: "invalido" }),
      fraseDaRecusa({ campo: "resumo", motivo: "obrigatorio" }),
      fraseDaRecusa({ campo: "resumo", motivo: "longo" }),
    ];
    expect(new Set(frases).size).toBe(4);
  });
});

describe("rotuloDoAssunto", () => {
  it("diz o setor antes do assunto, e só o assunto quando não há setor", () => {
    expect(rotuloDoAssunto({ nome: "Wi-Fi", time: "Suporte" })).toBe("Suporte › Wi-Fi");
    expect(rotuloDoAssunto({ nome: "Wi-Fi", time: null })).toBe("Wi-Fi");
  });
});

describe("conferirRegistro", () => {
  it("com os interruptores desligados, em branco passa", () => {
    expect(
      conferirRegistro({ assunto_id: null, resumo: null }, { exigir_assunto: false, exigir_resumo: false, times: comAssuntos }),
    ).toEqual([]);
  });

  it("exigir assunto cobra o assunto — mas só quando há assunto cadastrado", () => {
    const registro = { assunto_id: null, resumo: null };
    expect(conferirRegistro(registro, { exigir_assunto: true, exigir_resumo: false, times: comAssuntos })).toEqual([
      { campo: "assunto", motivo: "obrigatorio" },
    ]);
    expect(conferirRegistro(registro, { exigir_assunto: true, exigir_resumo: false, times: [] })).toEqual([]);
  });

  it("exigir resumo cobra 10 letras de verdade: espaço nas pontas não conta", () => {
    const opcoes = { exigir_assunto: false, exigir_resumo: true, times: comAssuntos };
    expect(conferirRegistro({ assunto_id: null, resumo: "   123456789   " }, opcoes)).toEqual([
      { campo: "resumo", motivo: "obrigatorio" },
    ]);
    expect(conferirRegistro({ assunto_id: null, resumo: " 1234567890 " }, opcoes)).toEqual([]);
  });

  it("resumo acima do teto é recusado mesmo sem exigência", () => {
    expect(
      conferirRegistro(
        { assunto_id: null, resumo: "a".repeat(2001) },
        { exigir_assunto: false, exigir_resumo: false, times: [] },
      ),
    ).toEqual([{ campo: "resumo", motivo: "longo" }]);
  });

  it("os dois faltando devolve as duas recusas, assunto primeiro", () => {
    expect(
      conferirRegistro({ assunto_id: null, resumo: "" }, { exigir_assunto: true, exigir_resumo: true, times: comAssuntos }),
    ).toEqual([
      { campo: "assunto", motivo: "obrigatorio" },
      { campo: "resumo", motivo: "obrigatorio" },
    ]);
  });
});
