// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn();
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => handler(...a) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({ requireCurrentServiceBoundary: async () => undefined }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (_s: unknown, _i: unknown, enviar: (k: string, m: string) => Promise<{ id: string }>) => {
    const m = await enviar("key-1", "msg-1");
    return { kind: "sent", idempotencyKey: "key-1", messageId: m.id };
  },
}));

import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";

const db = { query: vi.fn(async () => ({ rows: [{ kind: "inbound_turn", payload: {} }] })) };
const base = {
  tenantId: "org-1",
  leadId: "lead-1",
  jobId: "job-1",
  seq: 1,
  conversationId: "conv-1",
  body: "Segue o Pix da sua fatura.",
};

beforeEach(() => {
  handler.mockReset();
  handler.mockResolvedValue({ id: "m-1" });
});

describe("a saída do motor leva ARQUIVO", () => {
  it("media vira type document/image + os campos de storage do handler", async () => {
    await sendTurnMessage(db as never, { supabase: {} as never }, {
      ...base,
      media: { kind: "image", storagePath: "org-1/conv-1/cobranca-ab12cd34/pix-10-09-2026.png", mime: "image/png", sizeBytes: 1234 },
    });
    expect(handler.mock.calls[0]?.[2]).toMatchObject({
      conversation_id: "conv-1",
      type: "image",
      body: "Segue o Pix da sua fatura.",
      media_storage_path: "org-1/conv-1/cobranca-ab12cd34/pix-10-09-2026.png",
      media_mime: "image/png",
      media_size_bytes: 1234,
    });
  });

  it("controle: sem media continua texto", async () => {
    await sendTurnMessage(db as never, { supabase: {} as never }, base);
    expect(handler.mock.calls[0]?.[2]).toMatchObject({ type: "text", body: base.body });
    expect(handler.mock.calls[0]?.[2]).not.toHaveProperty("media_storage_path");
  });
});
