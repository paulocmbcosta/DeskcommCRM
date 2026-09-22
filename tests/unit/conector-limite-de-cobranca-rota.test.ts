import { beforeEach, describe, expect, it, vi } from "vitest";

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const salvarLimite = vi.fn();
const lerPublica = vi.fn();
vi.mock("@/lib/conectores/conexao", () => ({
  salvarLimiteDeCobranca: (...a: unknown[]) => salvarLimite(...a),
  lerConexaoPublica: (...a: unknown[]) => lerPublica(...a),
  lerCredencial: vi.fn(),
  removerConexao: vi.fn(),
  salvarConexao: vi.fn(),
}));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

import { PATCH } from "@/app/api/v1/conectores/[conector]/conexao/route";

const pedido = (corpo: unknown) =>
  new Request("http://x/api/v1/conectores/ixc/conexao", { method: "PATCH", body: JSON.stringify(corpo) }) as never;
const params = { params: Promise.resolve({ conector: "ixc" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-1", role: "admin" } });
  lerPublica.mockResolvedValue({ conector: "ixc", cobranca_encaminha_apos_dias: 45 });
  salvarLimite.mockResolvedValue(true);
});

describe("PATCH /api/v1/conectores/[conector]/conexao — o limite de dias", () => {
  it("é de admin", async () => {
    await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("grava, audita de quanto para quanto, e não pede o token", async () => {
    lerPublica.mockResolvedValueOnce({ conector: "ixc", cobranca_encaminha_apos_dias: 60 });
    const r = await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(r.status).toBe(200);
    expect(salvarLimite).toHaveBeenCalledWith(expect.anything(), "org-1", "ixc", 45);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.preferencias_alteradas", metadata: expect.objectContaining({ de: 60, para: 45 }) }));
  });

  it("recusa fora de 1..3650, fração e campo desconhecido", async () => {
    for (const corpo of [{ cobranca_encaminha_apos_dias: 0 }, { cobranca_encaminha_apos_dias: 3651 }, { cobranca_encaminha_apos_dias: 1.5 }, { cobranca_encaminha_apos_dias: 30, organization_id: "x" }]) {
      expect((await PATCH(pedido(corpo), params)).status).toBe(422);
    }
    expect(salvarLimite).not.toHaveBeenCalled();
  });

  it("conector desligado: 404", async () => {
    salvarLimite.mockResolvedValue(false);
    expect((await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params)).status).toBe(404);
  });
});
