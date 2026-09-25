import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ALERTA DE SENTIMENTO VIRA SINAL, NÃO TRANSFERÊNCIA (decisão do dono, 2026-09-25).
 *
 * Medido em produção: o atalho `triggerHandoff(low_sentiment)` calava a IA com
 * a frase genérica e deixava a conversa SEM TIME, disparado por clientes que só
 * descreviam o defeito ("Sem sinal", 0,25). Agora o handler registra o momento
 * na linha do tempo e quem transfere é o agente, no turno, escolhendo o setor.
 */
const rpc = vi.fn();
let eventoRecente: { id: string } | null = null;
let comando = "automatico";

vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: async () => ({ conversation_id: "conv-1", contact_id: "ct-1" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => {
      rpc(...args);
      return Promise.resolve({ error: null });
    },
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({
        data: tabela === "conversation_events" ? eventoRecente : { comando_da_conversa: comando },
        error: null,
      });
      return q;
    },
  }),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: vi.fn(() => {
    throw new Error("o alerta de sentimento não pode mais transferir sozinho");
  }),
}));

const { aiHandoffFromSentimentHandler } = await import("@/workers/ai-handoff-from-sentiment.handler");

const linha = {
  id: "ev-1",
  organization_id: "org-1",
  entity_id: "msg-1",
  payload: { message_id: "msg-1", conversation_id: "conv-1", sentiment_score: 0.05 },
} as never;

beforeEach(() => {
  rpc.mockReset();
  eventoRecente = null;
  comando = "automatico";
});

describe("ai.sentiment_alert → linha do tempo", () => {
  it("registra 'cliente_insatisfeito' com a nota e sem transferir", async () => {
    const r = await aiHandoffFromSentimentHandler.handle(linha);
    expect(r.status).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("fn_conversation_event_add", {
      p_org: "org-1",
      p_conversation: "conv-1",
      p_type: "cliente_insatisfeito",
      p_payload: { sentiment_score: 0.05, message_id: "msg-1", ia_orientada: true },
    });
  });

  it("com uma pessoa atendendo, a linha do tempo não diz que a IA foi orientada", async () => {
    comando = "humano";
    await aiHandoffFromSentimentHandler.handle(linha);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_payload: { ia_orientada: false } });
  });

  it("uma rajada de mensagens irritadas não vira dez linhas (30 min por conversa)", async () => {
    eventoRecente = { id: "ja" };
    const r = await aiHandoffFromSentimentHandler.handle(linha);
    expect(r.status).toBe("skipped");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("o turno do agente recebe o aviso", () => {
  it("inbound-turn põe o bloco de sentimento nos sufixos do turno", () => {
    const fonte = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    const sufixos = fonte.slice(fonte.indexOf("const openingSuffixes = ["), fonte.indexOf("].filter((b) => b !== '')"));
    expect(sufixos).toContain("sentimentoBlock");
    expect(fonte).toContain("AVISO_CLIENTE_INSATISFEITO");
  });
});
