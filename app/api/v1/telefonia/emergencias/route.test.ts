// @vitest-environment node
/**
 * A LEITURA DOS AVISOS (o que a faixa em todo o CRM e o cartão dos times leem):
 * qualquer membro da organização lê (a régua é viewer); a organização é a da
 * SESSÃO; o relógio é o da requisição; sem a telefonia oferecida na instalação, a
 * lista vem vazia sem tocar no banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const POOL = { pool: "da-rota" };
const estado = vi.hoisted(() => ({ ari: { baseUrl: "http://asterisk:8088", senha: "x" } as unknown }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "bia@exemplo.com", full_name: "Bia", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "viewer" },
  })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => estado.ari) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDeExibicao: vi.fn(async () => new Map()) }));
vi.mock("@/lib/telefonia/emergencias", () => ({
  avisosDaOrg: vi.fn(async () => [
    {
      team_id: "44444444-4444-4444-8444-444444444444",
      time_nome: "Suporte",
      ativa: true,
      desde: "2026-09-28T13:00:00.000Z",
      expira_em: null,
      ligada_por: "Ana",
      fala: null,
    },
  ]),
}));

import { requireRole } from "@/lib/auth/require-role";
import { avisosDaOrg } from "@/lib/telefonia/emergencias";
import { nomesDeExibicao } from "@/lib/users/nome-do-atendente";

import { GET } from "./route";

beforeEach(() => {
  estado.ari = { baseUrl: "http://asterisk:8088", senha: "x" };
  vi.mocked(requireRole).mockClear();
  vi.mocked(avisosDaOrg).mockClear();
});

describe("GET /api/v1/telefonia/emergencias", () => {
  it("qualquer membro lê (viewer), com a organização da sessão, o relógio da requisição e a régua de nome de exibição", async () => {
    const antes = Date.now();
    const r = await GET();
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
    const [pool, org, agora, nomes] = vi.mocked(avisosDaOrg).mock.calls[0]!;
    expect(pool).toEqual(POOL);
    expect(org).toBe(ORG);
    expect(agora.getTime()).toBeGreaterThanOrEqual(antes);
    expect(nomes).toBe(nomesDeExibicao);
    const corpo = (await r.json()) as { data: { oferecida: boolean; times: Array<{ ativa: boolean }> } };
    expect(corpo.data.oferecida).toBe(true);
    expect(corpo.data.times).toHaveLength(1);
  });

  it("telefonia não oferecida nesta instalação: lista vazia, sem ler o banco", async () => {
    estado.ari = null;
    const corpo = (await (await GET()).json()) as { data: unknown };
    expect(corpo.data).toEqual({ oferecida: false, times: [] });
    expect(avisosDaOrg).not.toHaveBeenCalled();
  });
});
