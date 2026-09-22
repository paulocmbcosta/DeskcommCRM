/**
 * HANDLER LENTO NÃO SEGURA A RESPOSTA DE UM WEBHOOK — E SÓ ELE É ADIADO.
 *
 * `acelerarPipelineDeEventos` (lib/dev/kick-local-pipeline.ts) roda o dreno do
 * `event_log` DENTRO do POST de todo canal. Um handler que chama serviço externo
 * lento (ex.: o classificador comercial, que espera o Jev até 8 s) fazia cada
 * webhook esperar por ele — e o dreno pega até 50 eventos, então o webhook de
 * uma organização podia pagar a espera de eventos de OUTRAS.
 *
 * ⚠️ MAS O ADIAMENTO NÃO PODE SER INCONDICIONAL, e esta é a lição da primeira
 * versão deste arquivo: marcado como `foraDaRequisicao: true` fixo, TODO
 * `message.received` de TODA organização — inclusive as que nunca ligaram a
 * regra, ou seja, a base instalada inteira — deixava de terminar na requisição
 * e voltava para `pending`. Onde o dreno de contexto worker é raro (Vercel
 * Hobby; VPS com o worker caído), 50 eventos adiados ficam na frente da fila,
 * são reivindicados e regravados a cada webhook sem efeito nenhum, e o que
 * está atrás deles (mídia, `lead.*`) para de rodar na requisição. Por isso
 * `foraDaRequisicao` é um PREDICADO: adia só quando aquele evento realmente
 * vai pagar a espera.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

const { dispatchEvent, registerHandler, ADIADO_PARA_O_WORKER, ESPERA_DO_ADIAMENTO_MS } = await import(
  "@/lib/event-log/dispatcher"
);
const { drainEventLog } = await import("@/lib/event-log/drain");
const { logger } = await import("@/lib/logger");

const rapido = vi.fn(async (): Promise<HandlerResult> => ({ consumer_key: "rapido.v1", status: "ok" }));
const lento = vi.fn(async (): Promise<HandlerResult> => ({ consumer_key: "lento.v1", status: "ok" }));
const midia = vi.fn(async (): Promise<HandlerResult> => ({ consumer_key: "midia.v1", status: "ok" }));
/** O predicado do handler lento: quem responde é cada teste. */
const precisaDoWorker = vi.fn(async (_row: EventRow): Promise<boolean> => true);

registerHandler({ key: "rapido.v1", events: ["teste.adiamento"], handle: rapido });
registerHandler({
  key: "lento.v1",
  events: ["teste.adiamento"],
  foraDaRequisicao: (row) => precisaDoWorker(row),
  handle: lento,
});
registerHandler({ key: "midia.v1", events: ["teste.midia"], handle: midia });

function linha(over: Partial<EventRow> = {}): EventRow {
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
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  precisaDoWorker.mockResolvedValue(true);
});

describe("dispatchEvent — o predicado decide o adiamento", () => {
  it("predicado true: o handler NÃO roda e vira retry daqui a 15 s", async () => {
    const antes = Date.now();
    const r = await dispatchEvent(linha(), { contexto: "requisicao" });

    expect(rapido).toHaveBeenCalledOnce();
    expect(lento).not.toHaveBeenCalled();
    expect(precisaDoWorker).toHaveBeenCalledWith(expect.objectContaining({ id: "e1", organization_id: "org-1" }));
    const adiado = r.find((x) => x.consumer_key === "lento.v1");
    expect(adiado).toMatchObject({ status: "retry", detail: ADIADO_PARA_O_WORKER });
    const quando = new Date(adiado!.retry_at!).getTime();
    // A espera dá ao drain-loop do worker (2–10 s) a chance de pegar primeiro,
    // e impede que o próximo webhook reivindique o mesmo evento na hora.
    expect(quando - antes).toBeGreaterThanOrEqual(ESPERA_DO_ADIAMENTO_MS - 50);
    expect(quando - Date.now()).toBeLessThanOrEqual(ESPERA_DO_ADIAMENTO_MS + 1_000);
    expect(r.find((x) => x.consumer_key === "rapido.v1")).toMatchObject({ status: "ok" });
  });

  it("predicado false: roda na requisição, como antes — a organização que não ligou a regra não entope a fila", async () => {
    precisaDoWorker.mockResolvedValue(false);
    const r = await dispatchEvent(linha(), { contexto: "requisicao" });
    expect(lento).toHaveBeenCalledOnce();
    expect(r.every((x) => x.status === "ok")).toBe(true);
  });

  it("predicado que LANÇA: roda na requisição (não adia) e o erro vai para o log", async () => {
    precisaDoWorker.mockRejectedValue(new Error("supabase fora"));
    const r = await dispatchEvent(linha(), { contexto: "requisicao" });
    expect(lento).toHaveBeenCalledOnce();
    expect(r.every((x) => x.status === "ok")).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    ["explícito", { contexto: "worker" as const }],
    ["padrão", undefined],
  ])("no worker (%s): todos rodam, e o predicado nem é consultado", async (_rotulo, opts) => {
    const r = await dispatchEvent(linha(), opts);
    expect(rapido).toHaveBeenCalledOnce();
    expect(lento).toHaveBeenCalledOnce();
    expect(precisaDoWorker).not.toHaveBeenCalled();
    expect(r.every((x) => x.status === "ok")).toBe(true);
  });
});

/** Dublê mínimo do admin: registra os `update` em `event_log` e devolve as linhas no `select`. */
function dublarAdmin(linhas: EventRow[]) {
  const updates: Array<Record<string, unknown>> = [];
  const consultas: Array<[string, unknown]> = [];
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
      or: (v: unknown) => {
        consultas.push(["or", v]);
        return self;
      },
      in: () => self,
      order: () => self,
      limit: (v: unknown) => {
        consultas.push(["limit", v]);
        return self;
      },
      then: (resolve: (v: unknown) => void) => {
        if (payload?.status === "processing") return resolve({ data: [{ id: "e1" }], error: null });
        if (payload) return resolve({ data: [], error: null });
        return resolve({ data: linhas, error: null });
      },
    };
    return self;
  }
  return { admin: { from: () => cadeia() } as never, updates, consultas };
}

describe("drainEventLog — o evento adiado volta à fila para o worker", () => {
  it("contexto requisição: fica pending, next_attempt_at ≈ agora + 15 s, os outros em consumed_by, sem contar tentativa", async () => {
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
    expect(quando - antes).toBeGreaterThanOrEqual(ESPERA_DO_ADIAMENTO_MS - 50);
  });

  it("sem contexto (cron, drain-loop do worker, relógio): roda todos e conclui", async () => {
    const { admin, updates } = dublarAdmin([linha()]);
    const resumo = await drainEventLog(admin);
    expect(lento).toHaveBeenCalledOnce();
    expect(resumo.done).toBe(1);
    expect(updates.at(-1)!.status).toBe("done");
  });

  /**
   * O ENTUPIMENTO que o adiamento incondicional causava: eventos adiados de
   * organizações que nem usam o handler lento ficavam na frente da fila (o
   * dreno pega os mais antigos por `created_at`) e empurravam para fora do
   * lote o que roda barato na requisição — mídia, `lead.*`.
   */
  it("organização SEM a regra: os message.received terminam na requisição e o evento de mídia roda", async () => {
    precisaDoWorker.mockResolvedValue(false);
    const velhos = [1, 2, 3].map((n) =>
      linha({ id: `e${n}`, organization_id: "org-sem-regra", created_at: new Date(Date.now() - n * 60_000).toISOString() }),
    );
    const { admin, updates } = dublarAdmin([
      ...velhos,
      linha({ id: "e-midia", event_type: "teste.midia", created_at: new Date().toISOString() }),
    ]);

    const resumo = await drainEventLog(admin, { contexto: "requisicao" });

    expect(midia, "o evento de mídia não pode ficar atrás de adiamento nenhum").toHaveBeenCalledOnce();
    expect(lento).toHaveBeenCalledTimes(3);
    expect(resumo.done).toBe(4);
    expect(resumo.retried).toBe(0);
    expect(updates.some((u) => u.status === "pending" && u.next_attempt_at !== undefined)).toBe(false);
  });

  /**
   * O caso acima prova que o handler não adiado roda no MESMO lote. O que
   * segura o adiado fora do lote seguinte é a janela do próprio dreno — e ela
   * é do SELECT, não do dublê: por isso este caso mede a consulta.
   */
  it("a janela do dreno respeita next_attempt_at e o teto do lote", async () => {
    const { admin, consultas } = dublarAdmin([linha()]);
    await drainEventLog(admin, { contexto: "requisicao", limit: 50 });

    const janela = consultas.find(([m]) => m === "or")?.[1];
    expect(String(janela), "o evento adiado só volta quando next_attempt_at vence").toContain("next_attempt_at");
    expect(String(janela)).toContain("next_attempt_at.lte.");
    expect(consultas).toContainEqual(["limit", 50]);
  });
});
