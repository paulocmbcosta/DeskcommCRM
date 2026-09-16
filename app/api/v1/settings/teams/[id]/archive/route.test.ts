/**
 * Arquivar é mutação de configuração como qualquer outra: mesmos portões, mesma
 * org da sessão, mesmo mapeamento de recusa do banco. O que este arquivo guarda
 * de específico é que o TIME vem do PATH e a ORG da sessão — nunca o contrário,
 * e nunca nenhum dos dois do corpo, que carrega só a direção do gesto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "40000000-0000-4000-8000-000000000001";
const outraOrg = "40000000-0000-4000-8000-0000000000ff";
const ator = "40000000-0000-4000-8000-000000000002";
const time = "40000000-0000-4000-8000-000000000003";

const rpc = vi.fn();
const req = (body: unknown = { arquivar: true }) =>
  new Request(`http://localhost/api/v1/settings/teams/${time}/archive`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
const ctx = (id = time) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: ator }, org: { orgId: org } } as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  rpc.mockResolvedValue({ data: { id: time, archived: true }, error: null });
});

describe("POST /api/v1/settings/teams/[id]/archive", () => {
  it.each([401, 403])("preserva negativa de autorização %s", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status }) } as never);
    expect((await POST(req(), ctx())).status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sem papel de manager não arquiva", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "x" } }), { status: 403 }),
    } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("support readonly não chega à RPC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("platform admin também prova MFA", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("id fora de forma é 400, não 500 vindo do Postgres", async () => {
    const res = await POST(req(), ctx("nao-e-uuid"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("corpo sem `arquivar` é 422 — a rota não adivinha a direção", async () => {
    expect((await POST(req({}), ctx())).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("o time vem do PATH e a org da SESSÃO", async () => {
    expect((await POST(req(), ctx())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_archive_attendance_team", {
      p_org: org,
      p_team: time,
      p_arquivar: true,
    });
  });

  it("organization_id no corpo é recusado e não vira p_org", async () => {
    const res = await POST(req({ arquivar: true, organization_id: outraOrg }), ctx());
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("desarquivar é a mesma rota com `arquivar: false`", async () => {
    await POST(req({ arquivar: false }), ctx());
    expect(rpc.mock.calls[0]?.[1].p_arquivar).toBe(false);
  });

  it.each([
    ["P0002", 404, "not_found"],
    ["42501", 403, "forbidden"],
    ["XX000", 500, "internal_error"],
  ])("erro %s do Postgres vira %i", async (code, status, apiCode) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "erro cru do postgres" } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(apiCode);
    expect(body.error.message).not.toContain("erro cru do postgres");
    expect(audit).not.toHaveBeenCalled();
  });

  it("sucesso audita com o time do path", async () => {
    await POST(req(), ctx());
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "routing.team_archived",
      actorUserId: ator,
      organizationId: org,
      resourceType: "attendance_team",
      resourceId: time,
      metadata: { arquivar: true },
    }));
  });
});
