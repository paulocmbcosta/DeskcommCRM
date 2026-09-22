/**
 * O adaptador do classificador comercial para o dispatcher do `event_log`:
 * cada desfecho de `processarClassificacao` vira UM `HandlerResult`, e o
 * registro o põe DEPOIS de todos os outros consumidores de `message.received`.
 *
 * O worker é trocado por um dublê: aqui só se prova a tradução, não a decisão
 * (essa está em `classificador-comercial-worker.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workers/classificador-comercial", () => ({
  processarClassificacao: vi.fn(),
  ehOrganizacaoComClassificador: vi.fn(),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";

const { processarClassificacao, ehOrganizacaoComClassificador } = await import(
  "@/workers/classificador-comercial"
);
const { classificadorComercialHandler, CLASSIFICADOR_COMERCIAL_HANDLER_KEY } = await import(
  "@/workers/classificador-comercial.handler"
);

const processar = vi.mocked(processarClassificacao);

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
    created_at: "2026-09-22T15:00:00.000Z",
  };
}

const consumer_key = CLASSIFICADOR_COMERCIAL_HANDLER_KEY;

beforeEach(() => {
  processar.mockReset();
});

describe("classificadorComercialHandler — a tradução de cada desfecho", () => {
  it("regra desligada: skipped SEM detail (senão polui o last_error de toda mensagem de toda organização)", async () => {
    processar.mockResolvedValue({ status: "pulado", motivo: "modo_toda_conversa" });
    const r = await classificadorComercialHandler.handle(evento());
    expect(r).toEqual({ consumer_key, status: "skipped" });
    expect(r).not.toHaveProperty("detail");
  });

  it("contato que já tem card: skipped SEM detail — é quase toda mensagem de uma organização com a regra ligada", async () => {
    processar.mockResolvedValue({ status: "pulado", motivo: "ja_tem_card" });
    const r = await classificadorComercialHandler.handle(evento());
    expect(r).toEqual({ consumer_key, status: "skipped" });
    expect(r).not.toHaveProperty("detail");
  });

  it("os outros pulos guardam o motivo no detail", async () => {
    processar.mockResolvedValue({ status: "pulado", motivo: "contato_bloqueado" });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "skipped",
      detail: "contato_bloqueado",
    });
  });

  it("tentar de novo: retry com retry_at em ISO e o motivo", async () => {
    const em = new Date("2026-09-22T15:01:00.000Z");
    processar.mockResolvedValue({ status: "tentar_de_novo", em, motivo: "jev_529" });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "retry",
      retry_at: "2026-09-22T15:01:00.000Z",
      detail: "jev_529",
    });
  });

  it("comercial e o card nasceu: card:<assunto>:<probabilidade>", async () => {
    processar.mockResolvedValue({ status: "classificado", criouCard: true, assunto: "mudanca_de_plano", probabilidade: 0.93 });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "card:mudanca_de_plano:0.93",
    });
  });

  it("não comercial: nao_comercial:<assunto>:<probabilidade>", async () => {
    processar.mockResolvedValue({ status: "classificado", criouCard: false, assunto: "suporte", probabilidade: 0.08 });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "nao_comercial:suporte:0.08",
    });
  });

  it("comercial e o card NÃO nasceu: comercial_sem_card:<motivo>", async () => {
    processar.mockResolvedValue({
      status: "comercial_sem_card",
      motivo: "sem_funil_de_entrada",
      assunto: "contratacao",
      probabilidade: 0.88,
    });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "comercial_sem_card:sem_funil_de_entrada",
    });
  });

  it("card sem classificar: sem_classificar:<causa>, e o motivo quando não nasceu", async () => {
    processar.mockResolvedValue({ status: "card_sem_classificar", causa: "sem_chave", criouCard: true });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "sem_classificar:sem_chave",
    });
    processar.mockResolvedValue({
      status: "card_sem_classificar",
      causa: "conta",
      criouCard: false,
      motivo: "sem_etapa",
    });
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "ok",
      detail: "sem_classificar:conta:sem_etapa",
    });
  });

  it("exceção vira error — o drain aplica backoff e, depois das tentativas, avisa do evento morto", async () => {
    processar.mockRejectedValue(new Error("nascimento do card falhou: deadlock detected"));
    expect(await classificadorComercialHandler.handle(evento())).toEqual({
      consumer_key,
      status: "error",
      detail: "nascimento do card falhou: deadlock detected",
    });
  });
});

describe("o classificador não roda dentro de uma requisição — mas só de quem ligou a regra", () => {
  it("organização com a regra ligada: o predicado diz para adiar", async () => {
    vi.mocked(ehOrganizacaoComClassificador).mockResolvedValue(true);
    await expect(classificadorComercialHandler.foraDaRequisicao!(evento())).resolves.toBe(true);
    expect(ehOrganizacaoComClassificador).toHaveBeenCalledWith(expect.objectContaining({ organization_id: "org-1" }));
  });

  it("organização com a regra DESLIGADA: não adia — o evento termina na requisição, como antes", async () => {
    vi.mocked(ehOrganizacaoComClassificador).mockResolvedValue(false);
    await expect(classificadorComercialHandler.foraDaRequisicao!(evento())).resolves.toBe(false);
  });
});

describe("registro — o classificador roda DEPOIS dos outros consumidores de message.received", () => {
  it("é o último handler de message.received: a push e as automações não esperam o Jev", async () => {
    const { ensureHandlersRegistered } = await import("@/lib/event-log/register-handlers");
    const { getRegisteredHandlers } = await import("@/lib/event-log/dispatcher");
    ensureHandlersRegistered();
    const deMensagem = getRegisteredHandlers()
      .filter((h) => h.events.includes("message.received"))
      .map((h) => h.key);
    expect(deMensagem.length, "há outros consumidores de message.received").toBeGreaterThan(1);
    expect(deMensagem.at(-1)).toBe(CLASSIFICADOR_COMERCIAL_HANDLER_KEY);
  });
});
