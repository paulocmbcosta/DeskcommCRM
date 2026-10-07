// @vitest-environment node
/**
 * A LEITURA DA ESPERA MÁXIMA DOS TIMES PELA ROTA (migration 0295): gerente ou
 * admin (a régua do seletor de Configurações › Times); a organização é a da
 * SESSÃO — a rota nem recebe o pedido; sem a telefonia oferecida na instalação, a
 * lista vem vazia sem tocar no banco.
 *
 * O SQL é provado no Postgres real (tests/invariants/telefonia-espera-do-time.test.ts);
 * aqui ele é uma porta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloEspera from "@/lib/telefonia/espera-do-time";

const ORG = "22222222-2222-4222-8222-222222222222";
const POOL = { pool: "da-rota" };
const TIMES = [
  { team_id: "44444444-4444-4444-8444-444444444444", espera_maxima_s: 600, em_vigor_s: 600 },
  { team_id: "55555555-5555-4555-8555-555555555555", espera_maxima_s: null, em_vigor_s: 120 },
];
const estado = vi.hoisted(() => ({ ari: { baseUrl: "http://asterisk:8088", senha: "x" } as unknown }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "manager" },
  })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => estado.ari) }));
vi.mock("@/lib/telefonia/espera-do-time", async () => {
  const real = await vi.importActual<typeof ModuloEspera>("@/lib/telefonia/espera-do-time");
  return { ...real, lerEsperaDosTimes: vi.fn(async () => []) };
});

import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { lerEsperaDosTimes } from "@/lib/telefonia/espera-do-time";

import { GET } from "./route";

const corpoDe = async (r: Response) => ((await r.json()) as { data: unknown }).data;

beforeEach(() => {
  estado.ari = { baseUrl: "http://asterisk:8088", senha: "x" };
  vi.mocked(requireRole).mockClear();
  vi.mocked(getRequestPool).mockClear();
  vi.mocked(lerEsperaDosTimes).mockReset().mockResolvedValue(TIMES);
});

describe("GET /api/v1/telefonia/fila/times", () => {
  it("gerente ou admin (a régua é manager), e a rota nem recebe o pedido", async () => {
    expect(GET.length).toBe(0);
    expect((await GET()).status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(vi.mocked(requireRole).mock.calls[0]![1]).toMatchObject({ resource: "telefonia_fila" });
  });

  it("papel abaixo de gerente (ou sem sessão): a recusa do `requireRole` volta intacta, sem ler nada", async () => {
    const recusa = Response.json({ error: { code: "forbidden_role", message: "x" } }, { status: 403 });
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: recusa } as never);
    expect(await GET()).toBe(recusa);
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(lerEsperaDosTimes).not.toHaveBeenCalled();
  });

  it("telefonia não oferecida nesta instalação: lista vazia, sem ler o banco", async () => {
    estado.ari = null;
    expect(await corpoDe(await GET())).toEqual({ oferecida: false, times: [] });
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(lerEsperaDosTimes).not.toHaveBeenCalled();
  });

  it("ligada: lê os times da organização DA SESSÃO, pela conexão do app", async () => {
    expect(await corpoDe(await GET())).toEqual({ oferecida: true, times: TIMES });
    expect(vi.mocked(lerEsperaDosTimes).mock.calls).toEqual([[POOL, ORG]]);
  });
});
