/**
 * Unit do `scripts/sondar-jev.ts` — as peças puras (`scripts/lib/sonda-jev.ts`).
 * A chamada real à OpenRouter é o próprio Step 3 do plano (portão manual, não
 * um teste automatizado): aqui só o que roda sem rede.
 */
import { describe, expect, it } from "vitest";

import {
  analisarLimiar,
  ARQUIVO_SINTETICO_PADRAO,
  calcularMetricas,
  ehArquivoSinteticoPadrao,
  extrairContratoConhecido,
  nomeDoErro,
  validarCasos,
  type ResultadoDoCaso,
} from "./lib/sonda-jev";

describe("validarCasos", () => {
  it("aceita um caso no formato que a produção monta (MensagemParaEstado[])", () => {
    const r = validarCasos([
      { esperado: "sim", assunto: "contratacao", mensagens: [{ direcao: "inbound", texto: "oi, quero contratar" }] },
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejeita e aponta só os CAMINHOS — nunca o valor do campo inválido (ex.: telefone digitado no texto)", () => {
    const r = validarCasos([
      { esperado: "sim", assunto: "contratacao", mensagens: [{ direcao: "inbound", texto: "oi" }] },
      {
        esperado: "talvez",
        assunto: "contratacao",
        mensagens: [{ direcao: "inbound", texto: "meu telefone é 11987654321, me liga" }],
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erro).toContain("1.esperado");
      expect(r.erro).not.toContain("11987654321");
      expect(r.erro).not.toContain("me liga");
    }
  });

  it("rejeita direcao fora de inbound/outbound e aponta o caminho, não o valor", () => {
    const r = validarCasos([
      { esperado: "sim", assunto: "x", mensagens: [{ direcao: "cliente", texto: "CPF 123.456.789-09" }] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erro).toContain("0.mensagens.0.direcao");
      expect(r.erro).not.toContain("123.456.789-09");
    }
  });

  it("rejeita entrada que não é array", () => {
    expect(validarCasos({ esperado: "sim" }).ok).toBe(false);
    expect(validarCasos(null).ok).toBe(false);
  });

  it("rejeita caso sem nenhuma mensagem", () => {
    const r = validarCasos([{ esperado: "sim", assunto: "x", mensagens: [] }]);
    expect(r.ok).toBe(false);
  });
});

describe("analisarLimiar", () => {
  it.each(["0.6", "0.7", "0.8", "1"])("aceita %s", (bruto) => {
    expect(analisarLimiar(bruto)).toEqual({ ok: true, valor: Number(bruto) });
  });

  it.each(["0", "-0.1", "1.1", "abc", "", "  "])("rejeita %s", (bruto) => {
    const r = analisarLimiar(bruto);
    expect(r.ok).toBe(false);
  });

  it("rejeita vírgula decimal em vez de ponto — não converte às escondidas", () => {
    const r = analisarLimiar("0,7");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain("0,7");
  });
});

describe("nomeDoErro", () => {
  it("devolve o NOME do erro, nunca a mensagem (que pode citar um trecho do arquivo lido)", () => {
    const err = new SyntaxError("Unexpected token 'x' in JSON at position 42 — telefone 11999999999");
    expect(nomeDoErro(err)).toBe("SyntaxError");
    expect(nomeDoErro(err)).not.toContain("11999999999");
  });

  it("erro sem .name vira 'erro desconhecido'", () => {
    expect(nomeDoErro("string qualquer")).toBe("erro desconhecido");
    expect(nomeDoErro(null)).toBe("erro desconhecido");
    expect(nomeDoErro(undefined)).toBe("erro desconhecido");
  });
});

describe("extrairContratoConhecido", () => {
  it("mantém só os campos conhecidos — nunca id nem provider", () => {
    const bruto = {
      model: "typesafe/jev-1.13-20260917",
      answers: {
        comercial: { type: "noul", noul: 0.05 },
        assunto: { type: "choice", choice: "outro", probabilities: { outro: 1 }, confidence: 1 },
      },
      usage: { input_tokens: 645, output_tokens: 103, cost: 0.00002709 },
      id: "gen-dec-1790077063-gdDq9eJ5U5d9iqG0AzYy",
      provider: "TypeSafe",
    };
    const limpo = extrairContratoConhecido(bruto);
    expect(limpo).toEqual({
      model: "typesafe/jev-1.13-20260917",
      answers: {
        comercial: { type: "noul", noul: 0.05 },
        assunto: { type: "choice", choice: "outro", probabilities: { outro: 1 }, confidence: 1 },
      },
      usage: { input_tokens: 645, output_tokens: 103, cost: 0.00002709 },
    });
    expect(limpo).not.toHaveProperty("id");
    expect(limpo).not.toHaveProperty("provider");
  });

  it("campo desconhecido dentro de assunto/usage também não sobrevive (backstop contra PII futura do provedor)", () => {
    const bruto = {
      answers: {
        comercial: { noul: 0.5 },
        assunto: { choice: "outro", extra_pii: "CPF 123.456.789-09" },
      },
      usage: { input_tokens: 10, alguma_coisa_nova: "valor inesperado" },
    };
    const limpo = extrairContratoConhecido(bruto);
    expect(limpo?.answers.assunto).not.toHaveProperty("extra_pii");
    expect(limpo?.usage).not.toHaveProperty("alguma_coisa_nova");
  });

  it("corpo que não é objeto, ou sem answers.comercial, vira null — nada para gravar", () => {
    expect(extrairContratoConhecido("string")).toBeNull();
    expect(extrairContratoConhecido(null)).toBeNull();
    expect(extrairContratoConhecido({ model: "x" })).toBeNull();
    expect(extrairContratoConhecido({ answers: {} })).toBeNull();
  });

  it("sem answers.assunto nem usage, grava só o que existe", () => {
    const limpo = extrairContratoConhecido({ answers: { comercial: { noul: 0.1 } } });
    expect(limpo).toEqual({ answers: { comercial: { noul: 0.1 } } });
  });

  it("probabilities: só chaves CONHECIDAS de ASSUNTOS com valor NUMÉRICO — chave estranha e valor não numérico ficam de fora", () => {
    const bruto = {
      answers: {
        comercial: { noul: 0.3 },
        assunto: {
          choice: "suporte",
          probabilities: {
            suporte: 0.7,
            financeiro: 0.2,
            assunto_novo_do_provedor: 0.5, // não é chave de ASSUNTOS
            contratacao: "0.1", // string, não número
          },
        },
      },
    };
    const limpo = extrairContratoConhecido(bruto);
    expect(limpo?.answers.assunto?.probabilities).toEqual({ suporte: 0.7, financeiro: 0.2 });
  });

  it("probabilities ausente ou vazia depois do filtro não quebra — vira objeto vazio", () => {
    const bruto = {
      answers: {
        comercial: { noul: 0.3 },
        assunto: { choice: "outro", probabilities: { lixo_do_provedor: 1 } },
      },
    };
    const limpo = extrairContratoConhecido(bruto);
    expect(limpo?.answers.assunto?.probabilities).toEqual({});
  });
});

describe("ehArquivoSinteticoPadrao", () => {
  const CWD = "/Volumes/T9/Dyper/.claude/worktrees/crm-card-filter-conversation-type-4983d9";

  it("aceita o caminho relativo padrão", () => {
    expect(ehArquivoSinteticoPadrao(ARQUIVO_SINTETICO_PADRAO, CWD)).toBe(true);
  });

  it("aceita o mesmo arquivo por um caminho relativo EQUIVALENTE (./ na frente)", () => {
    expect(ehArquivoSinteticoPadrao(`./${ARQUIVO_SINTETICO_PADRAO}`, CWD)).toBe(true);
  });

  it("aceita o caminho ABSOLUTO equivalente", () => {
    expect(ehArquivoSinteticoPadrao(`${CWD}/${ARQUIVO_SINTETICO_PADRAO}`, CWD)).toBe(true);
  });

  it("rejeita qualquer outro arquivo — inclusive um de conversas reais fora do repo", () => {
    expect(ehArquivoSinteticoPadrao("/tmp/conversas-reais-do-cliente.json", CWD)).toBe(false);
    expect(ehArquivoSinteticoPadrao("tests/fixtures/jev/outra-coisa.json", CWD)).toBe(false);
    expect(ehArquivoSinteticoPadrao("../conversas-de-exemplo.json", CWD)).toBe(false);
  });
});

describe("calcularMetricas", () => {
  function respondida(over: Partial<Extract<ResultadoDoCaso, { tipo: "respondida" }>> = {}): ResultadoDoCaso {
    return {
      tipo: "respondida",
      esperado: "sim",
      obtido: "sim",
      latenciaMs: 100,
      tokensDeEntrada: 50,
      custoEmCentavos: 0.01,
      modelo: "typesafe/jev-1.13-x",
      ...over,
    };
  }

  it("matriz de confusão e acertos batem (esperado x obtido)", () => {
    const m = calcularMetricas([
      respondida({ esperado: "sim", obtido: "sim" }),
      respondida({ esperado: "sim", obtido: "nao" }),
      respondida({ esperado: "nao", obtido: "sim" }),
      respondida({ esperado: "nao", obtido: "nao" }),
    ]);
    expect(m.matriz).toEqual({ simSim: 1, simNao: 1, naoSim: 1, naoNao: 1 });
    expect(m.acertos).toBe(2);
    expect(m.respondidas).toBe(4);
  });

  it("mediana e máx contam SÓ as respondidas — falha e sem-fala-do-cliente ficam de fora", () => {
    const m = calcularMetricas([
      respondida({ latenciaMs: 100 }),
      respondida({ latenciaMs: 300 }),
      respondida({ latenciaMs: 200 }),
      { tipo: "falha" },
      { tipo: "sem_fala_do_cliente" },
    ]);
    expect(m.medianaMs).toBe(200);
    expect(m.maxMs).toBe(300);
    expect(m.total).toBe(5);
    expect(m.falhas).toBe(1);
    expect(m.semFalaDoCliente).toBe(1);
    expect(m.respondidas).toBe(3);
  });

  it("todasFalharam só quando NENHUMA respondeu e ao menos uma falhou", () => {
    expect(calcularMetricas([{ tipo: "falha" }, { tipo: "falha" }]).todasFalharam).toBe(true);
    expect(calcularMetricas([{ tipo: "falha" }, respondida()]).todasFalharam).toBe(false);
    expect(calcularMetricas([{ tipo: "sem_fala_do_cliente" }]).todasFalharam).toBe(false);
    expect(calcularMetricas([]).todasFalharam).toBe(false);
  });

  it("tokens e custo somam só quando TODAS as respondidas informam — senão null, nunca 0 por omissão", () => {
    const comTudo = calcularMetricas([
      respondida({ tokensDeEntrada: 10, custoEmCentavos: 0.1 }),
      respondida({ tokensDeEntrada: 20, custoEmCentavos: 0.2 }),
    ]);
    expect(comTudo.tokensDeEntradaTotal).toBe(30);
    expect(comTudo.custoTotalEmCentavos).toBeCloseTo(0.3, 10);

    const comUmDesconhecido = calcularMetricas([
      respondida({ tokensDeEntrada: 10, custoEmCentavos: 0.1 }),
      respondida({ tokensDeEntrada: null, custoEmCentavos: null }),
    ]);
    expect(comUmDesconhecido.tokensDeEntradaTotal).toBeNull();
    expect(comUmDesconhecido.custoTotalEmCentavos).toBeNull();
  });

  it("sem nenhuma resposta, tokens/custo/modelo são null — não zero", () => {
    const m = calcularMetricas([{ tipo: "falha" }]);
    expect(m.tokensDeEntradaTotal).toBeNull();
    expect(m.custoTotalEmCentavos).toBeNull();
    expect(m.modeloQueRespondeu).toBeNull();
  });

  it("modeloQueRespondeu é o da PRIMEIRA respondida", () => {
    const m = calcularMetricas([respondida({ modelo: "a" }), respondida({ modelo: "b" })]);
    expect(m.modeloQueRespondeu).toBe("a");
  });
});
