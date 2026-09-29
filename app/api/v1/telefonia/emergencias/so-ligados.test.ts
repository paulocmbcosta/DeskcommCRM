// @vitest-environment node
/**
 * `GET /api/v1/telefonia/emergencias?so=ligados` NÃO PERGUNTA NOME À AUTH — medido
 * com a leitura e o nome DE VERDADE (`avisosDaOrg`, `avisosLigados`,
 * `nomesDosAtendentes`), e só as bordas simuladas: o pool, a sessão e o cliente de
 * serviço, cujo `auth.admin.getUserById` é o que se conta.
 *
 * Por que importa: a faixa roda em toda tela e relê a cada minuto em cada aba
 * aberta. Sem o parâmetro, a leitura de gerente e admin monta a lista completa e,
 * com um aviso ligado, pede à Auth o nome de quem ligou — uma chamada por aba por
 * minuto, justamente durante uma instabilidade. O controle (sem o parâmetro) prova
 * que o arnês enxerga essa chamada; o caso medido prova que a faixa não a faz.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const QUEM_LIGOU = "33333333-3333-4333-8333-333333333333";
const estado = vi.hoisted(() => ({ papel: "manager" }));
const auth = vi.hoisted(() => ({
  getUserById: vi.fn(async () => ({ data: { user: { user_metadata: { full_name: "Ana" } } }, error: null })),
}));
const pool = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (!sql.includes("from attendance_teams")) throw new Error(`consulta inesperada: ${sql}`);
    return {
      rows: [
        {
          team_id: "44444444-4444-4444-8444-444444444444",
          time_nome: "Suporte",
          desde: new Date(Date.now() - 60_000),
          expira_em: new Date(Date.now() + 3_600_000),
          ligada_por_id: "33333333-3333-4333-8333-333333333333",
          fala_id: null,
          arquivado: false,
        },
      ],
    };
  }),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "bia@exemplo.com", full_name: "Bia", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: estado.papel },
  })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => pool }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: () => ({ baseUrl: "http://asterisk:8088", senha: "x" }) }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true, audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { getUserById: auth.getUserById } } }) }));

import { GET } from "./route";

const pedido = (busca = "") => new NextRequest(`http://crm.teste/api/v1/telefonia/emergencias${busca}`);

beforeEach(() => {
  estado.papel = "manager";
  auth.getUserById.mockClear();
  pool.query.mockClear();
});

describe("a leitura da faixa não pergunta nome à Auth", () => {
  it("controle: SEM o parâmetro, o gerente com aviso ligado pede o nome de quem ligou", async () => {
    const r = await GET(pedido());
    expect(r.status).toBe(200);
    expect(auth.getUserById).toHaveBeenCalledWith(QUEM_LIGOU);
  });

  it.each(["viewer", "agent", "manager", "admin"])(
    "%s com ?so=ligados: uma consulta ao banco, nenhuma chamada à Auth",
    async (papel) => {
      estado.papel = papel;
      const r = await GET(pedido("?so=ligados"));
      expect(r.status).toBe(200);
      const { data } = (await r.json()) as { data: { ligados: unknown[]; times: unknown } };
      expect(data.ligados).toHaveLength(1);
      expect(data.times).toBeNull();
      expect(auth.getUserById).not.toHaveBeenCalled();
      expect(pool.query).toHaveBeenCalledTimes(1);
    },
  );
});
