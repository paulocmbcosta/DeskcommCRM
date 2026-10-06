/**
 * O FIM DA SAÍDA NÃO ATENDIDA: a regra que o worker grava e o aviso que a tela
 * lê saem do MESMO vocabulário. As causas e a ordem dos eventos vêm da medida
 * num Asterisk 20.11.1 local (cabeçalho de `fim-da-saida.ts`).
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import {
  ATENDENTE_DESLIGOU,
  avisoDoFimDaSaida,
  comoAcabouASaidaSemResposta,
  fimDaSaidaNaoAtendida,
  tempoDeToque,
} from "./fim-da-saida";

describe("fimDaSaidaNaoAtendida", () => {
  it.each([
    // [causa, tocou, desfecho, motivo]
    [16, false, "recusada_pela_rede", "nao_completada_16"], // 404 + Reason cause=16 da Totus
    [1, false, "recusada_pela_rede", "nao_completada_1"], // 404 sem Reason
    [19, false, "recusada_pela_rede", "nao_completada_19"], // 480 sem tocar (o `55…` da medida)
    [34, true, "recusada_pela_rede", "nao_completada_34"], // anúncio (183) e recusa
    [17, false, "sem_resposta", "ocupado_17"], // 486
    [17, true, "sem_resposta", "ocupado_17"],
    [19, true, "sem_resposta", "sem_resposta_19"], // tocou e ninguém atendeu
    [16, true, "sem_resposta", "sem_resposta_16"],
  ] as const)("causa %i, tocou=%s → %s (%s)", (causa, tocou, desfecho, motivo) => {
    expect(fimDaSaidaNaoAtendida({ causa, tocou })).toEqual({ desfecho, motivo });
  });
});

describe("avisoDoFimDaSaida", () => {
  const sem = (end_reason: string | null) => avisoDoFimDaSaida({ end_reason, answered_at: null });

  it("recusa da rede pede para conferir o número e o prefixo", () => {
    expect(sem("nao_completada_16")).toBe(
      "A operadora não completou a ligação. Confira o número e o prefixo de discagem do número SIP.",
    );
  });

  it("ocupado e sem resposta têm frase própria", () => {
    expect(sem("ocupado_17")).toBe("O número chamado está ocupado.");
    expect(sem("sem_resposta_19")).toBe("Ninguém atendeu.");
  });

  it("prefixo inválido e número da empresa indisponível também chegam ao atendente", () => {
    expect(sem("tronco_configuracao_invalida")).toMatch(/prefixo de discagem/);
    expect(sem("tronco_indisponivel")).toMatch(/não está disponível/);
  });

  it("a ligação que o sistema não chegou a discar avisa que a falha não foi de quem ligou", () => {
    expect(sem("saida_nao_discada")).toBe("Não foi possível fazer a ligação agora. Tente de novo.");
  });

  it("nada a avisar quando o próprio atendente desligou, ou quando a ligação foi atendida", () => {
    expect(sem("atendente_desligou")).toBeNull();
    expect(sem(null)).toBeNull();
    expect(avisoDoFimDaSaida({ end_reason: "nao_completada_16", answered_at: "2026-09-28T12:00:00Z" })).toBeNull();
  });

  it("o motivo que o worker grava é o que a tela traduz — as duas pontas no mesmo vocabulário", () => {
    for (const [causa, tocou] of [
      [16, false],
      [17, false],
      [19, true],
    ] as const) {
      expect(sem(fimDaSaidaNaoAtendida({ causa, tocou }).motivo)).not.toBeNull();
    }
  });
});

/**
 * O que o cartão conta embaixo do selo "Ligação sem resposta" (0294): quem
 * encerrou, e por quanto tempo o telefone do cliente chamou. É a diferença entre
 * "deixou chamar até a rede desistir" e "deu um toque e desligou".
 */
describe("comoAcabouASaidaSemResposta", () => {
  it("o atendente desistiu: diz isso, com o tempo que o telefone chamou", () => {
    expect(comoAcabouASaidaSemResposta({ motivo: ATENDENTE_DESLIGOU, toque_ms: 4_200, tentativa_ms: 6_000 })).toEqual({
      fim: "atendente_desligou",
      toqueMs: 4_200,
      tentativaMs: 6_000,
    });
  });

  // A rede que não avisa que o telefone chama (nenhum 180/183): quem esperou 40 s
  // e desligou não pode ficar igual a quem desligou em 1 s — vale a tentativa.
  it("desistiu sem sinal de toque: sem tempo de toque, com o tempo da tentativa", () => {
    expect(comoAcabouASaidaSemResposta({ motivo: ATENDENTE_DESLIGOU, toque_ms: null, tentativa_ms: 40_000 })).toEqual({
      fim: "atendente_desligou",
      toqueMs: null,
      tentativaMs: 40_000,
    });
  });

  it("a rede desistiu (ninguém atendeu): o motivo que o worker grava é o que o cartão lê", () => {
    const { motivo } = fimDaSaidaNaoAtendida({ causa: 19, tocou: true });
    expect(comoAcabouASaidaSemResposta({ motivo, toque_ms: 38_000 })).toEqual({ fim: "ninguem_atendeu", toqueMs: 38_000 });
  });

  // Ocupado antes de tocar, ou o cliente recusou depois de tocar (486 após o 180):
  // nos dois quem encerrou foi a rede, e o cartão não conta tempo.
  it.each([false, true])("ocupado (tocou=%s): o cartão diz só isso, sem tempo", (tocou) => {
    const { motivo } = fimDaSaidaNaoAtendida({ causa: 17, tocou });
    expect(comoAcabouASaidaSemResposta({ motivo, toque_ms: 9_000 })).toEqual({ fim: "ocupado" });
  });

  // O registro de antes da 0294 não traz o tempo, e o da ligação que acabou antes
  // de o telefone chamar também não: o cartão diz quem encerrou, sem inventar tempo.
  it.each([undefined, null, 0, -5, Number.NaN, "4000"])("tempo ausente ou estranho (%s) vira 'sem tempo', nunca um número", (toque) => {
    expect(
      comoAcabouASaidaSemResposta({ motivo: ATENDENTE_DESLIGOU, toque_ms: toque as number, tentativa_ms: toque as number }),
    ).toEqual({ fim: "atendente_desligou", toqueMs: null, tentativaMs: null });
  });

  it.each([null, undefined, "", "encerrada_apos_reinicio", "interrompida_no_reinicio", "pedido_expirado", "nao_completada_16", "cliente_desligou", "saida_nao_discada"])(
    "motivo que não diz como acabou (%s): nulo, e o cartão cala",
    (motivo) => {
      expect(comoAcabouASaidaSemResposta({ motivo, toque_ms: 4_000 })).toBeNull();
    },
  );
});

describe("tempoDeToque", () => {
  it.each([
    [400, "1 s"], // chamou, por pouco que seja: nunca "0 s"
    [1_499, "1 s"],
    [4_200, "4 s"],
    [38_000, "38 s"],
    [59_400, "59 s"],
    [59_600, "1 min 00 s"],
    [65_000, "1 min 05 s"],
  ])("%i ms → %s", (ms, texto) => {
    expect(tempoDeToque(ms)).toBe(texto);
  });
});

describe("todo aviso tem tradução", () => {
  // A tela faz `t(aviso)` com uma VARIÁVEL: o guarda de i18n, que lê literais
  // no AST, não enxerga estas frases. Este caso é quem as cobra.
  it.each(["nao_completada_16", "ocupado_17", "sem_resposta_19", "tronco_configuracao_invalida", "tronco_indisponivel", "saida_nao_discada"])(
    "%s → frase com espanhol no dicionário",
    (motivo) => {
      const aviso = avisoDoFimDaSaida({ end_reason: motivo, answered_at: null })!;
      expect(DICIONARIO[aviso]?.es, aviso).toBeTruthy();
    },
  );
});
