// @vitest-environment node
/**
 * O POST DO NÚMERO COM DESTINO (fase 2): a gravação recebe a organização da
 * SESSÃO; o número pode nascer apontando para um menu; a auditoria da criação
 * leva o destino (time e menu) e nunca a senha SIP; a trava ocupada é 409.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloNumeros from "@/lib/channels/telefonia/numeros";

const ORG = "22222222-2222-4222-8222-222222222222";
const NUMERO = "33333333-3333-4333-8333-333333333333";
const MENU = "55555555-5555-4555-8555-555555555555";
const SENHA = "senha-sip-de-teste-nao-real";
const POOL = vi.hoisted(() => ({ marca: "pool-da-rota" }));
const estado = vi.hoisted(() => ({ resultado: null as unknown }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => POOL) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => null) }));
vi.mock("@/lib/channels/telefonia/empurrar", () => ({ empurrarTroncoAgora: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/telefonia/numeros", async () => ({
  ...(await vi.importActual<typeof ModuloNumeros>("@/lib/channels/telefonia/numeros")),
  criarNumero: vi.fn(async () => estado.resultado),
  numerosDaOrg: vi.fn(async () => [{ id: "33333333-3333-4333-8333-333333333333", nome: "Recepção" }]),
}));

import { audit } from "@/lib/audit";
import { criarNumero } from "@/lib/channels/telefonia/numeros";

import { POST } from "./route";

const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Recepção",
  numero: "(61) 3686-1503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  senha: SENHA,
  time_id: null,
  ...extra,
});
const post = (c: unknown) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/numeros", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c),
    }),
  );

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(criarNumero).mockClear();
  estado.resultado = { ok: true, id: NUMERO };
});

describe("POST /api/v1/telefonia/numeros — nascer apontando para um menu", () => {
  it("a gravação recebe a organização da SESSÃO e o menu do corpo; a auditoria leva o destino e não a senha", async () => {
    const r = await post(corpo({ menu_id: MENU }));

    expect(r.status).toBe(201);
    const [pool, org, entrada] = vi.mocked(criarNumero).mock.calls[0]!;
    expect([pool, org, entrada.menu_id]).toEqual([POOL, ORG, MENU]);
    const [a] = vi.mocked(audit).mock.calls[0]!;
    expect(a.action).toBe("channel.phone_trunk_created");
    expect(a.metadata).toMatchObject({ time_id: null, menu_id: MENU });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(SENHA);
  });

  it("sem menu no corpo, a auditoria registra menu nulo", async () => {
    await post(corpo());
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ menu_id: null });
  });

  it.each([
    ["menu_com_fala_pendente", 422],
    ["gravacao_em_andamento", 409],
  ] as const)("recusa %s → %i, sem auditoria", async (motivo, status) => {
    estado.resultado = { ok: false, motivo };
    const r = await post(corpo({ menu_id: MENU }));
    expect(r.status).toBe(status);
    expect(audit).not.toHaveBeenCalled();
  });
});
