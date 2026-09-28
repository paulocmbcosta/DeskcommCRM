/**
 * O adaptador da espera da Assistente para o dispatcher do `event_log`: cada
 * desfecho de `processarEspera` vira UM `HandlerResult`, e o registro o põe
 * DEPOIS de todos os outros consumidores de `message.received`, inclusive do
 * classificador comercial.
 *
 * O worker é trocado por um dublê: aqui só se prova a tradução, não a decisão
 * (essa está em `workers/espera-da-assistente.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workers/espera-da-assistente", () => ({
  processarEspera: vi.fn(),
  esperaPodeSerDispensada: vi.fn(),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";

const { processarEspera, esperaPodeSerDispensada } = await import("@/workers/espera-da-assistente");
const { esperaDaAssistenteHandler, ESPERA_DA_ASSISTENTE_HANDLER_KEY } = await import(
  "@/workers/espera-da-assistente.handler"
);

const processar = vi.mocked(processarEspera);

function evento(): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { message_id: "msg-1", conversation_id: "conv-1", contact_id: "contato-1", direction: "inbound" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-09-26T10:00:30.000Z",
  };
}

const consumer_key = ESPERA_DA_ASSISTENTE_HANDLER_KEY;

beforeEach(() => {
  processar.mockReset();
});

describe("esperaDaAssistenteHandler — a tradução de cada desfecho", () => {
  it("pulos silenciosos: skipped SEM detail", async () => {
    for (const motivo of ["nao_e_entrada", "sem_espera", "automatico", "mantida_por_humano", "sem_chave"]) {
      processar.mockResolvedValue({ status: "pulado", motivo });
      const r = await esperaDaAssistenteHandler.handle(evento());
      expect(r).toEqual({ consumer_key, status: "skipped" });
      expect(r).not.toHaveProperty("detail");
    }
  });

  it("outros pulos guardam o motivo no detail", async () => {
    processar.mockResolvedValue({ status: "pulado", motivo: "sem_texto_para_ler" });
    expect(await esperaDaAssistenteHandler.handle(evento())).toEqual({
      consumer_key,
      status: "skipped",
      detail: "sem_texto_para_ler",
    });
  });

  it("tentar de novo: retry com retry_at em ISO e o motivo", async () => {
    const em = new Date("2026-09-26T10:01:00.000Z");
    processar.mockResolvedValue({ status: "tentar_de_novo", em, motivo: "aguardando_transcricao" });
    expect(await esperaDaAssistenteHandler.handle(evento())).toEqual({
      consumer_key,
      status: "retry",
      retry_at: "2026-09-26T10:01:00.000Z",
      detail: "aguardando_transcricao",
    });
  });

  it("pede resposta: conta:<probabilidade>", async () => {
    processar.mockResolvedValue({ status: "pede_resposta", probabilidade: 0.9 });
    expect(await esperaDaAssistenteHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "conta:0.90",
    });
  });

  it("dispensada: dispensada:<probabilidade>", async () => {
    processar.mockResolvedValue({ status: "dispensada", probabilidade: 0.05 });
    expect(await esperaDaAssistenteHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "dispensada:0.05",
    });
  });

  it("exceção vira error", async () => {
    processar.mockRejectedValue(new Error("espera falhou: deadlock detected"));
    expect(await esperaDaAssistenteHandler.handle(evento())).toEqual({
      consumer_key,
      status: "error",
      detail: "espera falhou: deadlock detected",
    });
  });
});

describe("a espera não roda dentro de uma requisição — mas só de quem pode ser dispensada", () => {
  it("pode ser dispensada: o predicado diz para adiar", async () => {
    vi.mocked(esperaPodeSerDispensada).mockResolvedValue(true);
    await expect(esperaDaAssistenteHandler.foraDaRequisicao!(evento())).resolves.toBe(true);
    expect(esperaPodeSerDispensada).toHaveBeenCalledWith(expect.objectContaining({ organization_id: "org-1" }));
  });

  it("não pode ser dispensada: não adia — o evento termina na requisição", async () => {
    vi.mocked(esperaPodeSerDispensada).mockResolvedValue(false);
    await expect(esperaDaAssistenteHandler.foraDaRequisicao!(evento())).resolves.toBe(false);
  });
});
