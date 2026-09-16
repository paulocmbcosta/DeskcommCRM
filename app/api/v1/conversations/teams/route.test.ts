/**
 * A lista de times que o INBOX enxerga.
 *
 * Duas coisas aqui não são detalhe:
 *
 *  1. O papel é `viewer`. A lista não é só destino de transferência — é de onde
 *     sai o NOME do setor no selo do cabeçalho. Exigir `agent` faria quem só
 *     olha o inbox ver um selo sem nome, e o caminho mais curto dali é imprimir
 *     "Sem time" numa conversa que TEM time.
 *  2. Os arquivados vêm junto, marcados. Arquivar não limpa
 *     `conversations.team_id`, e omiti-los deixaria conversa antiga com um time
 *     que a tela não sabe nomear.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/times/catalogo", () => ({ carregarTimes: vi.fn() }));

const org = "60000000-0000-4000-8000-000000000001";
const time = "60000000-0000-4000-8000-00000000000a";
const arquivado = "60000000-0000-4000-8000-00000000000b";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: org, role: "agent" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({} as never);
  vi.mocked(carregarTimes).mockResolvedValue([
    {
      id: time,
      name: "Financeiro",
      slug: "financeiro",
      description: "boleto, fatura",
      schedule: {},
      archived_at: null,
      aberto_agora: true,
      horario_invalido: false,
      user_ids: ["u1", "u2"],
    },
    {
      id: arquivado,
      name: "Antigo",
      slug: "antigo",
      description: "",
      schedule: {},
      archived_at: "2026-09-01T00:00:00Z",
      aberto_agora: false,
      horario_invalido: false,
      user_ids: [],
    },
  ]);
});

describe("GET /api/v1/conversations/teams", () => {
  it("quem só olha o inbox também lê a lista — o portão é `viewer`", async () => {
    await GET();
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
  });

  it("preserva a negativa de autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await GET()).status).toBe(403);
    expect(carregarTimes).not.toHaveBeenCalled();
  });

  it("a org vem da sessão e os arquivados vêm junto, marcados", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(vi.mocked(carregarTimes).mock.calls[0]?.[1]).toBe(org);
    expect(vi.mocked(carregarTimes).mock.calls[0]?.[3]).toEqual({ incluirArquivados: true });
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: time,
        name: "Financeiro",
        slug: "financeiro",
        description: "boleto, fatura",
        aberto_agora: true,
        horario_invalido: false,
        archived: false,
      },
      {
        id: arquivado,
        name: "Antigo",
        slug: "antigo",
        description: "",
        aberto_agora: false,
        horario_invalido: false,
        archived: true,
      },
    ]);
  });

  it("não vaza quem está em cada time", async () => {
    // `carregarTimes` devolve `user_ids`, e o inbox não precisa deles. A lista de
    // quem trabalha onde é assunto da tela de configuração, que exige `manager`.
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toContain("user_ids");
    expect(JSON.stringify(body)).not.toContain("u1");
  });

  it("falha do catálogo não derruba o inbox: 500 com mensagem de gente", async () => {
    vi.mocked(carregarTimes).mockRejectedValue(new Error("column attendance_teams.x does not exist"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("does not exist");
  });
});
