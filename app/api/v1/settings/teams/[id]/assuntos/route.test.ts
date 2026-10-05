/**
 * O cadastro de assuntos de encerramento (migration 0293) é mutação de
 * configuração como a dos times: mesmos portões, organização da SESSÃO, time do
 * PATH — e o corpo carrega só o nome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";
import { PATCH } from "./[assuntoId]/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "60000000-0000-4000-8000-000000000001";
const outraOrg = "60000000-0000-4000-8000-0000000000ff";
const ator = "60000000-0000-4000-8000-000000000002";
const time = "60000000-0000-4000-8000-000000000003";
const assunto = "60000000-0000-4000-8000-000000000004";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const filtros: Array<[string, unknown]> = [];

const post = (body: unknown) =>
  new Request(`http://localhost/api/v1/settings/teams/${time}/assuntos`, { method: "POST", body: JSON.stringify(body) }) as never;
const patch = (body: unknown) =>
  new Request(`http://localhost/api/v1/settings/teams/${time}/assuntos/${assunto}`, { method: "PATCH", body: JSON.stringify(body) }) as never;
const ctxDoTime = (id = time) => ({ params: Promise.resolve({ id }) });
const ctxDoAssunto = (id = time, assuntoId = assunto) => ({ params: Promise.resolve({ id, assuntoId }) });

beforeEach(() => {
  vi.clearAllMocks();
  filtros.length = 0;
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: ator, idioma: "pt-BR" }, org: { orgId: org } } as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return consulta;
    },
    maybeSingle,
  };
  vi.mocked(createClient).mockResolvedValue({ rpc, from: () => consulta } as never);
  maybeSingle.mockResolvedValue({ data: { id: assunto }, error: null });
  rpc.mockResolvedValue({ data: { id: assunto, team_id: time, name: "Wi-Fi" }, error: null });
});

describe("POST /api/v1/settings/teams/[id]/assuntos", () => {
  it("cria com a organização da sessão e o time do caminho", async () => {
    const res = await POST(post({ name: "  Wi-Fi  " }), ctxDoTime());
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_save_atendimento_assunto", {
      p_org: org,
      p_team: time,
      p_assunto: null,
      p_name: "Wi-Fi",
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "atendimento.assunto_salvo", organizationId: org }));
  });

  it.each([{ name: "Wi-Fi", organization_id: outraOrg }, { name: "Wi-Fi", team_id: time }, { name: "   " }, { name: "a".repeat(61) }, {}])(
    "corpo %j é 422 e não chega ao banco",
    async (body) => {
      expect((await POST(post(body), ctxDoTime())).status).toBe(422);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("time fora de forma é 400, não 500 do Postgres", async () => {
    expect((await POST(post({ name: "Wi-Fi" }), ctxDoTime("nao-e-uuid"))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("os portões vêm antes da RPC: papel, suporte e MFA", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await POST(post({ name: "Wi-Fi" }), ctxDoTime())).status).toBe(403);
    vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: ator, idioma: "pt-BR" }, org: { orgId: org } } as never);
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await POST(post({ name: "Wi-Fi" }), ctxDoTime())).status).toBe(403);
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await POST(post({ name: "Wi-Fi" }), ctxDoTime())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "23505", message: "assunto_duplicado" }, 409, "conflict"],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "atendimento_assuntos_nome_unico_por_time"' }, 409, "conflict"],
    [{ code: "P0002", message: "assunto_team_not_found" }, 404, "not_found"],
    [{ code: "42501", message: "assunto_forbidden" }, 403, "forbidden"],
    [{ code: "42501", message: "assunto_mfa_required" }, 403, "mfa_required"],
    [{ code: "22023", message: "assunto_invalid_name" }, 422, "validation_failed"],
    [{ code: "XX000", message: "qualquer outra coisa" }, 500, "internal_error"],
  ])("recusa do banco %j vira %i %s, sem auditar", async (error, status, code) => {
    rpc.mockResolvedValue({ data: null, error });
    const res = await POST(post({ name: "Wi-Fi" }), ctxDoTime());
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/settings/teams/[id]/assuntos/[assuntoId]", () => {
  it("renomear passa o time do caminho no predicado da RPC", async () => {
    expect((await PATCH(patch({ name: "Wi-Fi e senha" }), ctxDoAssunto())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_save_atendimento_assunto", {
      p_org: org,
      p_team: time,
      p_assunto: assunto,
      p_name: "Wi-Fi e senha",
    });
  });

  it("arquivar confere ANTES que o assunto é deste time e desta organização", async () => {
    expect((await PATCH(patch({ archived: true }), ctxDoAssunto())).status).toBe(200);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", org],
        ["team_id", time],
        ["id", assunto],
      ]),
    );
    expect(rpc).toHaveBeenCalledWith("fn_archive_atendimento_assunto", { p_org: org, p_assunto: assunto, p_arquivar: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "atendimento.assunto_arquivado" }));
  });

  it("assunto de OUTRO time é 404 e a RPC de arquivar não roda", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await PATCH(patch({ archived: true }), ctxDoAssunto())).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([{}, { archived: "sim" }, { name: "" }, { name: "Wi-Fi", organization_id: outraOrg }])(
    "corpo %j é 422",
    async (body) => {
      expect((await PATCH(patch(body), ctxDoAssunto())).status).toBe(422);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("ids fora de forma são 400", async () => {
    expect((await PATCH(patch({ archived: true }), ctxDoAssunto(time, "x"))).status).toBe(400);
    expect((await PATCH(patch({ archived: true }), ctxDoAssunto("x", assunto))).status).toBe(400);
  });
});
