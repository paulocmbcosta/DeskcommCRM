import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ drained: 0 })),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({
  ensureHandlersRegistered: vi.fn(),
}));

import { acelerarPipelineDeEventos, kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import { drainEventLog } from "@/lib/event-log/drain";

describe("kickLocalPipeline", () => {
  it("não propaga erro do tick do contato (contrato: nunca 5xx no webhook)", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => {
              throw new Error("boom do mock");
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      kickLocalPipeline(admin, {
        organizationId: "org",
        contactId: "contact",
      }),
    ).resolves.toBeUndefined();
  });

  it("drena no contexto REQUISIÇÃO: handler lento é adiado para o worker, não segura o POST do webhook", async () => {
    const admin = {} as SupabaseClient;
    vi.mocked(drainEventLog).mockClear();
    await acelerarPipelineDeEventos(admin);
    expect(drainEventLog).toHaveBeenCalledWith(admin, { contexto: "requisicao" });
  });
});
