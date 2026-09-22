/**
 * POST /api/v1/team/[user_id]/password — o admin define uma senha nova para um membro.
 *
 * É o laço de retorno do cadastro com senha: numa instalação sem e-mail,
 * "esqueci a senha" não chega a lugar nenhum, e sem esta rota quem esquece fica
 * preso para sempre (nem recadastrar resolve — a conta já existe).
 *
 * O que se mede é sobretudo o que ela RECUSA, porque trocar a senha de alguém é
 * tomar a conta dele:
 *  - a própria senha (a API de admin pula a sessão forte e o segundo fator);
 *  - quem não é desta organização, ou foi revogado;
 *  - quem TAMBÉM responde a outra organização — o admin daqui entraria lá;
 *  - admin de plataforma.
 * E que, quando passa, a senha não vai para a auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";
import { BancoEmMemoria } from "./helpers/banco-em-memoria";

let serviceRole = true;

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => serviceRole,
  hashEmail: (e: string) => e,
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const MEMBRO = "33333333-3333-4333-8333-333333333333";
const SENHA = "Nova-Senha-456";

let banco: BancoEmMemoria;
let senhasTrocadas: Array<{ id: string; attrs: Record<string, unknown> }>;
let erroAoTrocar: { code?: string; status?: number; message: string } | null;

function sessao(papel: "admin" | "manager" = "admin") {
  const user: AuthUser = {
    id: ADMIN_ID,
    email: "admin@example.com",
    full_name: "Admin",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: papel }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: papel });
  vi.mocked(createClient).mockResolvedValue({
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: papel, error: null } : { data: null, error: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createAdminClient).mockReturnValue({
    ...banco.cliente,
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          if (erroAoTrocar) return { data: { user: null }, error: erroAoTrocar };
          senhasTrocadas.push({ id, attrs });
          return { data: { user: { id } }, error: null };
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function definir(alvo: string, body: Record<string, unknown> = { password: SENHA }) {
  const { POST } = await import("@/app/api/v1/team/[user_id]/password/route");
  const res = await POST(
    new NextRequest(`http://localhost/api/v1/team/${alvo}/password`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ user_id: alvo }) },
  );
  const texto = await res.text();
  return { res, texto, json: JSON.parse(texto) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceRole = true;
  erroAoTrocar = null;
  senhasTrocadas = [];
  banco = new BancoEmMemoria().semear(
    "user_organizations",
    { id: "v-admin", organization_id: ORG_ID, user_id: ADMIN_ID, role: "admin", revoked_at: null },
    { id: "v-membro", organization_id: ORG_ID, user_id: MEMBRO, role: "agent", revoked_at: null },
  );
});

describe("POST /api/v1/team/[user_id]/password — o que ela recusa", () => {
  it("quem não é admin leva 403", async () => {
    sessao("manager");
    const { res } = await definir(MEMBRO);
    expect(res.status).toBe(403);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("a própria senha não se troca por aqui", async () => {
    sessao();
    const { res } = await definir(ADMIN_ID);
    expect(res.status).toBe(400);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("quem não é desta organização → 404", async () => {
    banco.semear("user_organizations", {
      id: "v-fora",
      organization_id: OUTRA_ORG,
      user_id: "44444444-4444-4444-8444-444444444444",
      role: "agent",
      revoked_at: null,
    });
    sessao();
    const { res } = await definir("44444444-4444-4444-8444-444444444444");
    expect(res.status).toBe(404);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("membro revogado → 409 (devolver o acesso vem antes)", async () => {
    banco.linhas("user_organizations")[1].revoked_at = "2026-09-01T00:00:00Z";
    sessao();
    const { res } = await definir(MEMBRO);
    expect(res.status).toBe(409);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("membro que TAMBÉM tem vínculo ativo em outra organização → 409, senha intocada", async () => {
    banco.semear("user_organizations", {
      id: "v-membro-fora",
      organization_id: OUTRA_ORG,
      user_id: MEMBRO,
      role: "admin",
      revoked_at: null,
    });
    sessao();
    const { res, json } = await definir(MEMBRO);
    expect(res.status).toBe(409);
    expect(json.error.details.motivo).toBe("outra_organizacao");
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("vínculo REVOGADO em outra organização não bloqueia", async () => {
    banco.semear("user_organizations", {
      id: "v-membro-fora-revogado",
      organization_id: OUTRA_ORG,
      user_id: MEMBRO,
      role: "admin",
      revoked_at: "2026-09-01T00:00:00Z",
    });
    sessao();
    const { res } = await definir(MEMBRO);
    expect(res.status).toBe(200);
    expect(senhasTrocadas).toHaveLength(1);
  });

  it("admin de plataforma → 403, senha intocada", async () => {
    banco.semear("platform_admins", { user_id: MEMBRO, revoked_at: null });
    sessao();
    const { res } = await definir(MEMBRO);
    expect(res.status).toBe(403);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("senha curta é recusada na validação", async () => {
    sessao();
    const { res } = await definir(MEMBRO, { password: "curta" });
    expect(res.status).toBe(422);
    expect(senhasTrocadas).toHaveLength(0);
  });

  it("senha recusada pela política do provedor → 422 legível", async () => {
    erroAoTrocar = { code: "weak_password", status: 422, message: "Password is known to be weak" };
    sessao();
    const { res, json } = await definir(MEMBRO);
    expect(res.status).toBe(422);
    expect(json.error.message).toMatch(/senha/i);
  });
});

describe("POST /api/v1/team/[user_id]/password — quando passa", () => {
  it("troca a senha do membro e audita sem a senha", async () => {
    sessao();
    const { res, texto } = await definir(MEMBRO);
    expect(res.status).toBe(200);
    expect(senhasTrocadas).toEqual([{ id: MEMBRO, attrs: { password: SENHA } }]);
    expect(texto).not.toContain(SENHA);

    const auditorias = vi.mocked(audit).mock.calls.map(([e]) => e);
    expect(auditorias.find((e) => e.action === "member.password_set")).toMatchObject({
      actorUserId: ADMIN_ID,
      organizationId: ORG_ID,
      resourceType: "membership",
      resourceId: "v-membro",
      metadata: { target_user_id: MEMBRO },
    });
    expect(JSON.stringify(auditorias)).not.toContain(SENHA);
  });
});
