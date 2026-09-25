import { describe, expect, it } from "vitest";

import {
  AVISO_CLIENTE_INSATISFEITO,
  LIMITE_PADRAO_DE_SENTIMENTO,
  notaCriticaDoTurno,
} from "@/lib/agent-engine/agent/sentimento-do-turno";

/**
 * O aviso de cliente muito insatisfeito no turno do agente — o que substituiu a
 * transferência automática por sentimento (decisão do dono, 2026-09-25).
 */
function banco(nota: number | null, limite: number | null) {
  const consultas: unknown[][] = [];
  return {
    consultas,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        consultas.push(params);
        return { rows: [{ nota, limite }] };
      },
    } as never,
  };
}

const input = { tenantId: "org-1", conversationId: "conv-1", agentId: "agente-1" };

describe("notaCriticaDoTurno", () => {
  it("abaixo do limite do agente: devolve a nota (o turno avisa o modelo)", async () => {
    expect(await notaCriticaDoTurno(banco(0.05, 0.1).db, input)).toBe(0.05);
  });

  it("acima do limite do agente: sem aviso — 'Sem sinal' (0,25) com limite 0,10 é suporte, não crise", async () => {
    expect(await notaCriticaDoTurno(banco(0.25, 0.1).db, input)).toBeNull();
  });

  it("agente sem limite próprio usa o padrão do worker", async () => {
    expect(LIMITE_PADRAO_DE_SENTIMENTO).toBe(0.3);
    expect(await notaCriticaDoTurno(banco(0.25, null).db, input)).toBe(0.25);
  });

  it("nota ainda não calculada: sem aviso", async () => {
    expect(await notaCriticaDoTurno(banco(null, 0.3).db, input)).toBeNull();
  });

  it("a consulta é escopada pela organização (pool sem RLS)", async () => {
    const b = banco(0.2, 0.3);
    await notaCriticaDoTurno(b.db, input);
    expect(b.consultas[0]).toEqual(["org-1", "conv-1", "agente-1"]);
  });

  it("o aviso fala a língua do atendimento, sem jargão que o modelo possa repetir", () => {
    expect(AVISO_CLIENTE_INSATISFEITO).not.toMatch(/sentiment|score|handoff|lead|threshold/i);
    expect(AVISO_CLIENTE_INSATISFEITO).toMatch(/setor/);
  });
});
