/**
 * POST /api/v1/contacts/[id]/unblock — a casca da rota.
 *
 * 1. **A régua é manager+.** `agent` edita a ficha, mas não desfaz o pedido de
 *    saída do titular. Se alguém baixar para "agent" por paridade com o PATCH,
 *    este teste reprova.
 * 2. **A org vem do `requireRole`, nunca do body** — mesmo que o body traga uma.
 * 3. **Sem motivo, nada acontece** (400, sem tocar no banco).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import type * as Desbloquear from "@/lib/contacts/desbloquear";

type DesbloquearModulo = typeof Desbloquear;

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  desbloquear: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/contacts/desbloquear", async (orig) => ({
  ...(await orig<DesbloquearModulo>()),
  desbloquearContato: deps.desbloquear,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const EU = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

function req(body: unknown) {
  return new NextRequest("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = (id = CONTATO) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.admin.mockReturnValue({ admin: true });
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: EU, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  deps.desbloquear.mockResolvedValue({
    contact_id: CONTATO,
    is_blocked: false,
    bloqueio_anterior: { reason: "stop_keyword", blocked_at: null },
  });
});

describe("POST /api/v1/contacts/[id]/unblock", () => {
  it("exige manager — e devolve a resposta do gate quando ele recusa", async () => {
    deps.role.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }),
    });
    const { POST } = await import("./route");
    const res = await POST(req({ motivo: "falso positivo do opt-out" }), params());

    expect(deps.role).toHaveBeenCalledWith("manager", expect.anything());
    expect(res.status).toBe(403);
    expect(deps.desbloquear).not.toHaveBeenCalled();
  });

  it("usa a org do gate, não a do body", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      req({ motivo: "falso positivo do opt-out", organization_id: OUTRA_ORG }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(deps.desbloquear).toHaveBeenCalledWith(
      { admin: true },
      { organizationId: ORG, actorUserId: EU, requestId: expect.any(String) },
      CONTATO,
      { motivo: "falso positivo do opt-out" },
    );
  });

  it("sem motivo (ou motivo curto) é 400 com frase de gente, e não toca no banco", async () => {
    const { POST } = await import("./route");

    const semCorpo = await POST(req(null), params());
    expect(semCorpo.status).toBe(400);
    expect((await semCorpo.json()).error.message).toBe("Explique o motivo do desbloqueio.");

    const curto = await POST(req({ motivo: "curto" }), params());
    expect(curto.status).toBe(400);
    expect((await curto.json()).error.message).toBe("Explique o motivo em pelo menos 10 caracteres.");

    expect(deps.desbloquear).not.toHaveBeenCalled();
  });

  it("id que não é uuid é 404, sem consultar nada", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ motivo: "falso positivo do opt-out" }), params("abc"));
    expect(res.status).toBe(404);
    expect(deps.desbloquear).not.toHaveBeenCalled();
  });
});
