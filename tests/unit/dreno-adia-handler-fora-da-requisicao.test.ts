/**
 * HANDLER LENTO NÃO SEGURA A RESPOSTA DE UM WEBHOOK.
 *
 * `acelerarPipelineDeEventos` (lib/dev/kick-local-pipeline.ts) roda o dreno do
 * `event_log` DENTRO do POST de todo canal. Um handler que chama serviço externo
 * lento (ex.: o classificador comercial, que espera o Jev até 8 s) fazia cada
 * webhook esperar por ele — e o dreno pega até 50 eventos, então o webhook de
 * uma organização podia pagar a espera de eventos de OUTRAS.
 *
 * O conserto é genérico, e este arquivo o prova sem nomear handler nenhum:
 * `foraDaRequisicao: true` + `contexto: "requisicao"` ⇒ o dispatcher NÃO chama
 * o handler e devolve `retry` para agora; o dreno devolve o evento a `pending`
 * (sem contar tentativa, com os outros consumidores já em `consumed_by`) e o
 * dreno do serviço `worker` o pega no próximo tick.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

const { dispatchEvent, registerHandler, ADIADO_PARA_O_WORKER } = await import("@/lib/event-log/dispatcher");
const { drainEventLog } = await import("@/lib/event-log/drain");

const rapido = vi.fn(async (): Promise<HandlerResult> => ({ consumer_key: "rapido.v1", status: "ok" }));
const lento = vi.fn(async (): Promise<HandlerResult> => ({ consumer_key: "lento.v1", status: "ok" }));

registerHandler({ key: "rapido.v1", events: ["teste.adiamento"], handle: rapido });
registerHandler({ key: "lento.v1", events: ["teste.adiamento"], foraDaRequisicao: true, handle: lento });

function linha(): EventRow {
  return {
    id: "e1",
    organization_id: "org-1",
    event_type: "teste.adiamento",
    entity_kind: "message",
    entity_id: "m1",
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 2,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  rapido.mockClear();
  lento.mockClear();
});

describe("dispatchEvent — contexto da chamada", () => {
  it("dentro de uma requisição: o handler marcado NÃO roda, vira retry para agora; os outros rodam", async () => {
    const antes = Date.now();
    const r = await dispatchEvent(linha(), { contexto: "requisicao" });
    expect(rapido).toHaveBeenCalledOnce();
    expect(lento).not.toHaveBeenCalled();
    const adiado = r.find((x) => x.consumer_key === "lento.v1");
    expect(adiado).toMatchObject({ status: "retry", detail: ADIADO_PARA_O_WORKER });
    const quando = new Date(adiado!.retry_at!).getTime();
    expect(quando).toBeGreaterThanOrEqual(antes);
    expect(quando - Date.now()).toBeLessThan(2_000);
    expect(r.find((x) => x.consumer_key === "rapido.v1")).toMatchObject({ status: "ok" });
  });

  it.each([
    ["explícito", { contexto: "worker" as const }],
    ["padrão", undefined],
  ])("no worker (%s): todos rodam, o marcado inclusive", async (_rotulo, opts) => {
    const r = await dispatchEvent(linha(), opts);
    expect(rapido).toHaveBeenCalledOnce();
    expect(lento).toHaveBeenCalledOnce();
    expect(r.every((x) => x.status === "ok")).toBe(true);
  });
});

/** Dublê mínimo do admin: registra os `update` em `event_log` e devolve a linha no `select`. */
function dublarAdmin(linhas: EventRow[]) {
  const updates: Array<Record<string, unknown>> = [];
  function cadeia() {
    let payload: Record<string, unknown> | null = null;
    const self: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => {
        payload = p;
        updates.push(p);
        return self;
      },
      select: () => self,
      eq: () => self,
      lt: () => self,
      or: () => self,
      in: () => self,
      order: () => self,
      limit: () => self,
      then: (resolve: (v: unknown) => void) => {
        if (payload?.status === "processing") return resolve({ data: [{ id: "e1" }], error: null });
        if (payload) return resolve({ data: [], error: null });
        return resolve({ data: linhas, error: null });
      },
    };
    return self;
  }
  return { admin: { from: () => cadeia() } as never, updates };
}

describe("drainEventLog — o evento adiado volta à fila para o worker", () => {
  it("contexto requisição: fica pending, next_attempt_at ≈ agora, os outros em consumed_by, sem contar tentativa", async () => {
    const { admin, updates } = dublarAdmin([linha()]);
    const antes = Date.now();
    const resumo = await drainEventLog(admin, { contexto: "requisicao" });

    expect(lento).not.toHaveBeenCalled();
    expect(resumo.retried).toBe(1);
    const final = updates.at(-1)!;
    expect(final.status).toBe("pending");
    expect(final.consumed_by).toEqual(["rapido.v1"]);
    expect(final).not.toHaveProperty("attempts");
    const quando = new Date(String(final.next_attempt_at)).getTime();
    expect(quando).toBeGreaterThanOrEqual(antes);
    expect(quando - Date.now()).toBeLessThan(2_000);
  });

  it("sem contexto (cron, drain-loop do worker, relógio): roda todos e conclui", async () => {
    const { admin, updates } = dublarAdmin([linha()]);
    const resumo = await drainEventLog(admin);
    expect(lento).toHaveBeenCalledOnce();
    expect(resumo.done).toBe(1);
    expect(updates.at(-1)!.status).toBe("done");
  });
});
