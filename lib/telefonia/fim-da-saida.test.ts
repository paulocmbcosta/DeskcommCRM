/**
 * O FIM DA SAÍDA NÃO ATENDIDA: a regra que o worker grava e o aviso que a tela
 * lê saem do MESMO vocabulário. As causas e a ordem dos eventos vêm da medida
 * num Asterisk 20.11.1 local (cabeçalho de `fim-da-saida.ts`).
 */
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { avisoDoFimDaSaida, fimDaSaidaNaoAtendida } from "./fim-da-saida";

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

describe("todo aviso tem tradução", () => {
  // A tela faz `t(aviso)` com uma VARIÁVEL: o guarda de i18n, que lê literais
  // no AST, não enxerga estas frases. Este caso é quem as cobra.
  it.each(["nao_completada_16", "ocupado_17", "sem_resposta_19", "tronco_configuracao_invalida", "tronco_indisponivel"])(
    "%s → frase com espanhol no dicionário",
    (motivo) => {
      const aviso = avisoDoFimDaSaida({ end_reason: motivo, answered_at: null })!;
      expect(DICIONARIO[aviso]?.es, aviso).toBeTruthy();
    },
  );
});
