/**
 * ENTREGAR A CREDENCIAL DO RAMAL DEIXA RASTRO — E O RASTRO NÃO LEVA A SENHA.
 *
 * `POST /api/v1/telefonia/ramal` grava objetos na memória do Asterisk (auth,
 * AOR, endpoint) e devolve ao navegador a senha de um ramal que recebe
 * ligações de clientes. Era a única mutação da telefonia sem entrada em
 * `api_audit_log` (revisão de segurança, 2026-09-28). O que se mede: uma
 * entrada por credencial entregue, com quem, qual ramal e se foi criado agora;
 * nenhuma quando não há credencial (instalação sem telefonia, organização sem
 * número); e a senha em lugar nenhum da entrada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const estado = vi.hoisted(() => ({
  cfg: { url: "http://asterisk:8088", senha: "ari" } as unknown,
  numeros: [{ id: "n1", nome: "Totus", numero: "+556136861503" }] as unknown[],
  cred: { usuario: "ramal-u1", senha: "SENHA-DO-RAMAL-NAO-PODE-VAZAR", nova: true },
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({
  ClienteAri: vi.fn(),
  configAriDoAmbiente: vi.fn(() => estado.cfg),
}));
vi.mock("@/lib/channels/telefonia/saida", () => ({ numerosParaLigar: vi.fn(async () => estado.numeros) }));
vi.mock("@/lib/channels/telefonia/ramal", () => ({ credencialDoRamal: vi.fn(async () => estado.cred) }));

import { audit } from "@/lib/audit";

import { POST } from "./route";

const pedido = () =>
  new NextRequest("https://crm.cliente.com.br/api/v1/telefonia/ramal", { method: "POST", body: "{}" });

beforeEach(() => {
  vi.mocked(audit).mockClear();
  estado.cfg = { url: "http://asterisk:8088", senha: "ari" };
  estado.numeros = [{ id: "n1", nome: "Totus", numero: "+556136861503" }];
  estado.cred = { usuario: "ramal-u1", senha: "SENHA-DO-RAMAL-NAO-PODE-VAZAR", nova: true };
});

describe("POST /api/v1/telefonia/ramal — auditoria", () => {
  it("credencial entregue ⇒ uma entrada, com quem, qual ramal e se foi criado — sem a senha", async () => {
    const r = await POST(pedido());

    expect(r.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "phone_extension.credential_issued",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      metadata: { ramal: "ramal-u1", nova: true },
    });
    expect(JSON.stringify(entrada)).not.toContain("SENHA-DO-RAMAL-NAO-PODE-VAZAR");
  });

  it("ramal que já existia também audita (a senha saiu para um navegador), marcado como reaproveitado", async () => {
    estado.cred = { ...estado.cred, nova: false };

    await POST(pedido());

    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ metadata: { nova: false } });
  });

  it.each([
    ["instalação sem telefonia", () => (estado.cfg = null)],
    ["organização sem número", () => (estado.numeros = [])],
  ])("%s ⇒ nenhuma credencial, nenhuma entrada", async (_caso, preparar) => {
    preparar();

    const r = await POST(pedido());

    expect(r.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
});
