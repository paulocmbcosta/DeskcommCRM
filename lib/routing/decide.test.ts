import { describe, expect, it } from "vitest";

import { decideRouting, selectRoundRobin, type RoutingCandidate } from "./decide";
import { routingConfigSchema } from "@/lib/schemas/routing";

/**
 * Decisão PURA do worker de roteamento (G5-02 — AT-03). Cobre os 5 cenários do
 * acceptance na camada de lógica; a garantia transacional (trigger emite, fn
 * atribui atomicamente + idempotência DB) fica no invariante SQL
 * tests/invariants/gov-4b-routing-worker.test.ts. Clock SEMPRE injetado.
 */

const NOW = new Date("2026-07-13T17:00:00Z");
const config = routingConfigSchema.parse({ mode: "round_robin", max_retries: 5, backoff_seconds: 60 });

const cand = (userId: string, lastAssignedAt: number | null, currentLoad = 0): RoutingCandidate => ({
  userId,
  currentLoad,
  lastAssignedAt,
});

describe("selectRoundRobin (rodízio real)", () => {
  it("nenhum elegível ⇒ null", () => {
    expect(selectRoundRobin([])).toBeNull();
  });

  it("nunca-atribuído (null) tem prioridade sobre quem já recebeu", () => {
    const picked = selectRoundRobin([cand("b", 1000), cand("a", null)]);
    expect(picked).toBe("a");
  });

  it("entre atribuídos, o mais ANTIGO vem primeiro (rodízio)", () => {
    const picked = selectRoundRobin([cand("recent", 5000), cand("old", 1000)]);
    expect(picked).toBe("old");
  });

  it("empate determinístico por userId", () => {
    expect(selectRoundRobin([cand("z", null), cand("a", null)])).toBe("a");
  });
});

describe("quem tem MENOS atendimento recebe primeiro", () => {
  it("a carga vence o rodízio: quem recebeu agora mas está livre passa na frente de quem está cheio", () => {
    // `cheio` recebeu há mais tempo — pelo rodízio puro seria a vez dele — e está
    // com 4 conversas; `livre` acabou de receber e está com 1. A conversa nova
    // vai para quem tem folga, senão a fila anda no ritmo do mais lento.
    expect(selectRoundRobin([cand("cheio", 1000, 4), cand("livre", 9000, 1)])).toBe("livre");
  });

  it("na MESMA carga, o rodízio decide — comportamento idêntico ao de antes", () => {
    expect(selectRoundRobin([cand("recente", 5000, 2), cand("antigo", 1000, 2)])).toBe("antigo");
  });

  it("carga zero para todos (começo do dia): nunca-atribuído primeiro", () => {
    expect(selectRoundRobin([cand("b", 1000, 0), cand("a", null, 0)])).toBe("a");
  });
});

describe("decideRouting — os 5 cenários do acceptance", () => {
  it("round_robin com elegível ⇒ assign ao elegível (nunca ao inelegível — já filtrado)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("agent-eligible", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "assign", userId: "agent-eligible" });
  });

  it("idempotência: conversa que JÁ tem dono ⇒ skip, nunca reatribui (acceptance 3)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: true,
      eligibles: [cand("someone", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_assigned" });
  });

  it("sem elegível ⇒ requeue com backoff futuro + attempts++ (acceptance 4)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [],
      config,
      attempts: 2,
      now: NOW,
    });
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(action.attempts).toBe(3);
      // backoff_seconds=60 ⇒ next_attempt_at = now + 60s.
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 60_000);
      expect(new Date(action.nextAttemptAt).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("sem elegível após max_retries mantém retry lento e contador limitado", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [],
      config, // max_retries=5
      attempts: 5,
      now: NOW,
    });
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(action.attempts).toBe(5);
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 900_000);
    }
  });

  it("modo manual ⇒ skip, worker não atribui (acceptance 5)", () => {
    const action = decideRouting({
      mode: "manual",
      alreadyAssigned: false,
      eligibles: [cand("agent", null)],
      config: routingConfigSchema.parse({ mode: "manual" }),
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "manual_mode" });
  });

  it("modo 'load' (inalcançável no schema) ⇒ skip defensivo, no-op", () => {
    const action = decideRouting({
      mode: "load",
      alreadyAssigned: false,
      eligibles: [cand("agent", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "unsupported_mode:load" });
  });
});
