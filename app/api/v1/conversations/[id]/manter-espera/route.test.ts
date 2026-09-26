/**
 * "Contar mesmo assim" — o único gesto humano sobre a espera que a Assistente
 * dispensou. O que este arquivo guarda de específico: sem dispensa ativa é
 * conflito (não há o que religar); a corrida (a conversa mudou entre a leitura
 * e o UPDATE condicional) também é conflito, não erro de servidor; e o evento
 * na linha do tempo é best-effort — sua falha não desfaz a auditoria nem o 200.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "50000000-0000-4000-8000-000000000001";
const ator = "50000000-0000-4000-8000-000000000002";
const conversa = "50000000-0000-4000-8000-000000000003";

const DISPENSADA_ATE = "2026-09-26T12:00:00.000Z";
const DISPENSADA_DESDE = "2026-09-26T11:50:00.000Z";
const LAST_INBOUND_AT = "2026-09-26T12:05:00.000Z";

const req = () => new Request(`http://localhost/api/v1/conversations/${conversa}/manter-espera`, { method: "POST" }) as never;
const ctx = (id = conversa) => ({ params: Promise.resolve({ id }) });

interface QueryStub {
  maybeSingle: ReturnType<typeof vi.fn>;
}

function buildSelectStub(row: unknown, error: unknown = null): QueryStub & Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  return chain as QueryStub & Record<string, unknown>;
}

function buildUpdateStub(row: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  const updatePayload: Record<string, unknown>[] = [];
  chain.update = vi.fn((payload: Record<string, unknown>) => {
    updatePayload.push(payload);
    return chain;
  });
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  return { chain, updatePayload };
}

const rpc = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ator, idioma: "pt-BR" },
    org: { orgId: org, role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  rpc.mockResolvedValue({ data: null, error: null });
});

function mockSupabase(selectRow: unknown, updateRow: unknown, opts: { selectErr?: unknown; updateErr?: unknown } = {}) {
  const selectStub = buildSelectStub(selectRow, opts.selectErr ?? null);
  const { chain: updateStub, updatePayload } = buildUpdateStub(updateRow, opts.updateErr ?? null);
  let call = 0;
  const from = vi.fn(() => {
    call += 1;
    return call === 1 ? selectStub : updateStub;
  });
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return { updatePayload };
}

describe("POST /api/v1/conversations/[id]/manter-espera", () => {
  it.each([401, 403])("preserva negativa de autorização %s", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(status);
    expect(audit).not.toHaveBeenCalled();
  });

  it("support somente-leitura não chega à conversa", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    mockSupabase(null, null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
  });

  it("id que não é uuid é 400 antes de tocar o banco (não vira 500 do Postgres)", async () => {
    mockSupabase(null, null);
    const res = await POST(req(), ctx("nao-e-uuid"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("conversa inexistente/fora do escopo é 404", async () => {
    mockSupabase(null, null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem dispensa ativa (`espera_dispensada_ate` nulo) é 409, sem update", async () => {
    mockSupabase(
      {
        last_inbound_at: LAST_INBOUND_AT,
        espera_dispensada_ate: null,
        espera_dispensada_desde: null,
      },
      null,
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(audit).not.toHaveBeenCalled();
  });

  it("update condicional sem linha (corrida) é 409", async () => {
    mockSupabase(
      {
        last_inbound_at: LAST_INBOUND_AT,
        espera_dispensada_ate: DISPENSADA_ATE,
        espera_dispensada_desde: DISPENSADA_DESDE,
      },
      null,
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(audit).not.toHaveBeenCalled();
  });

  it("religa a espera: devolve `espera_desde` original, audita e emite o evento", async () => {
    const { updatePayload } = mockSupabase(
      {
        last_inbound_at: LAST_INBOUND_AT,
        espera_dispensada_ate: DISPENSADA_ATE,
        espera_dispensada_desde: DISPENSADA_DESDE,
      },
      { id: conversa, espera_desde: DISPENSADA_DESDE, espera_mantida_em: "2026-09-26T12:10:00.000Z" },
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);

    expect(updatePayload[0]).toMatchObject({
      espera_desde: DISPENSADA_DESDE,
      espera_dispensada_ate: null,
      espera_dispensada_desde: null,
    });
    expect(typeof updatePayload[0]!.espera_mantida_em).toBe("string");

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.espera_mantida",
        actorUserId: ator,
        organizationId: org,
        resourceType: "conversation",
        resourceId: conversa,
        metadata: { espera_desde: DISPENSADA_DESDE, dispensada_ate: DISPENSADA_ATE },
      }),
    );

    expect(rpc).toHaveBeenCalledWith(
      "fn_conversation_event_add",
      expect.objectContaining({
        p_org: org,
        p_conversation: conversa,
        p_type: "espera_mantida",
        p_actor: ator,
      }),
    );
  });

  it("sem `espera_dispensada_desde` guardado, usa `last_inbound_at` como origem da espera", async () => {
    const { updatePayload } = mockSupabase(
      {
        last_inbound_at: LAST_INBOUND_AT,
        espera_dispensada_ate: DISPENSADA_ATE,
        espera_dispensada_desde: null,
      },
      { id: conversa, espera_desde: LAST_INBOUND_AT, espera_mantida_em: "2026-09-26T12:10:00.000Z" },
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(updatePayload[0]!.espera_desde).toBe(LAST_INBOUND_AT);
  });

  it("evento não gravar não desfaz a religada (best-effort)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    mockSupabase(
      {
        last_inbound_at: LAST_INBOUND_AT,
        espera_dispensada_ate: DISPENSADA_ATE,
        espera_dispensada_desde: DISPENSADA_DESDE,
      },
      { id: conversa, espera_desde: DISPENSADA_DESDE, espera_mantida_em: "2026-09-26T12:10:00.000Z" },
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalled();
  });
});
