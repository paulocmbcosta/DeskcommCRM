/**
 * As duas perguntas que esta rota tem de responder sempre igual:
 *
 *  1. **De onde vem a organização.** Da sessão, e SÓ dela. O corpo pode chegar
 *     com `organization_id` — de um cliente antigo, de um script, de alguém
 *     tentando — e não pode haver caminho em que esse valor influencie a
 *     escrita. Aqui isso é provado nos dois sentidos: o corpo com
 *     `organization_id` é RECUSADO (o schema é `.strict()`) e, no corpo válido,
 *     o `p_org` que chega à RPC é o da sessão.
 *  2. **Recusa do banco é recusa com significado.** Os quatro códigos que
 *     `fn_save_attendance_team` (migration 0263) levanta viram quatro respostas
 *     distintas. Se qualquer um virasse 500, o gestor leria "erro do sistema"
 *     para um slug repetido que ele mesmo consegue consertar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { GET, POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/times/catalogo", () => ({ carregarTimes: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));

const org = "30000000-0000-4000-8000-000000000001";
const outraOrg = "30000000-0000-4000-8000-0000000000ff";
const ator = "30000000-0000-4000-8000-000000000002";
const time = "30000000-0000-4000-8000-000000000003";
const atendente = "30000000-0000-4000-8000-000000000004";

const rpc = vi.fn();
const membros = vi.fn();
const from = vi.fn(() => {
  const encadeado = {
    select: () => encadeado,
    eq: () => encadeado,
    is: () => encadeado,
    in: () => membros(),
  };
  return encadeado;
});

const corpoValido = { name: "Financeiro", slug: "financeiro", user_ids: [atendente] };
const req = (body: unknown = corpoValido) =>
  new Request("http://localhost/api/v1/settings/teams", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: ator }, org: { orgId: org } } as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({ rpc, from } as never);
  vi.mocked(carregarTimes).mockResolvedValue([]);
  vi.mocked(nomesDosAtendentes).mockResolvedValue(new Map([[atendente, "Ana"]]));
  membros.mockResolvedValue({ data: [{ user_id: atendente }], error: null });
  rpc.mockResolvedValue({ data: { id: time, slug: "financeiro", user_ids: [atendente] }, error: null });
});

describe("GET /api/v1/settings/teams", () => {
  it.each([401, 403])("preserva negativa de autorização %s", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status }) } as never);
    expect((await GET()).status).toBe(status);
    expect(carregarTimes).not.toHaveBeenCalled();
  });

  it("platform admin também prova MFA antes de ler", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await GET()).status).toBe(403);
    expect(carregarTimes).not.toHaveBeenCalled();
  });

  it("lê a org da sessão, inclui arquivados e nomeia quem pode ser alocado", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(vi.mocked(carregarTimes).mock.calls[0]?.[1]).toBe(org);
    expect(vi.mocked(carregarTimes).mock.calls[0]?.[3]).toEqual({ incluirArquivados: true });
    expect(await res.json()).toEqual({ data: { times: [], membros: [{ id: atendente, name: "Ana" }] } });
  });

  it("sem service role o nome degrada para rótulo, não para UUID cru", async () => {
    vi.mocked(nomesDosAtendentes).mockResolvedValue(new Map());
    const body = await (await GET()).json();
    expect(body.data.membros).toEqual([{ id: atendente, name: "Atendente sem nome" }]);
  });

  it("falha de leitura é 500 declarado, não exceção vazando", async () => {
    vi.mocked(carregarTimes).mockRejectedValue(new Error("db fora do ar"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal_error");
  });
});

describe("POST /api/v1/settings/teams", () => {
  it.each([401, 403])("preserva negativa de autorização %s", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status }) } as never);
    expect((await POST(req())).status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sem papel de manager a escrita não acontece", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "x" } }), { status: 403 }),
    } as never);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("o gate pedido é manager, e não um papel mais fraco", async () => {
    await POST(req());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
    expect(vi.mocked(requireRole).mock.calls[0]?.[1]).toMatchObject({ resource: "settings_teams", allowPlatformAdmin: true });
  });

  it("support readonly não chega à RPC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await POST(req())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("platform admin também prova MFA", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await POST(req())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a org vai para a RPC vinda da SESSÃO", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_save_attendance_team", {
      p_org: org,
      p_team: null,
      p_name: "Financeiro",
      p_slug: "financeiro",
      p_description: "",
      p_schedule: { timezone: "America/Sao_Paulo", windows: [] },
      p_users: [atendente],
    });
  });

  it("organization_id no corpo é RECUSADO — nunca chega à escrita", async () => {
    const res = await POST(req({ ...corpoValido, organization_id: outraOrg }));
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("nenhuma tentativa de contrabando de org chega à RPC com outra org", async () => {
    // Este caso já nasceu vacuamente verde uma vez: ele só varria
    // `rpc.mock.calls`, e como o corpo contrabandeado é RECUSADO antes da RPC,
    // o laço rodava sobre zero chamadas e passava mesmo com a rota sabotada.
    // Agora ele exige que exista chamada, e que TODA chamada use a org da
    // sessão — inclusive a do corpo legítimo, que é a única que passa.
    await POST(req({ ...corpoValido, p_org: outraOrg }));
    await POST(req({ ...corpoValido, organization_id: outraOrg }));
    await POST(req());
    expect(rpc.mock.calls.length).toBe(1);
    for (const chamada of rpc.mock.calls) expect(chamada[1].p_org).toBe(org);
  });

  it("corpo inválido não vira erro de sistema", async () => {
    const res = await POST(req({ name: "", slug: "Financeiro MAIÚSCULO" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("id existente vira UPDATE (p_team preenchido)", async () => {
    await POST(req({ ...corpoValido, id: time }));
    expect(rpc.mock.calls[0]?.[1].p_team).toBe(time);
  });

  it.each([
    ["23505", 409, "conflict"],
    ["P0002", 404, "not_found"],
    ["22023", 422, "validation_failed"],
    ["42501", 403, "forbidden"],
    ["XX000", 500, "internal_error"],
  ])("erro %s do Postgres vira %i", async (code, status, apiCode) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "erro cru do postgres" } });
    const res = await POST(req());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(apiCode);
    expect(body.error.message).not.toContain("erro cru do postgres");
    expect(audit).not.toHaveBeenCalled();
  });

  it("sucesso audita o time salvo com a org da sessão", async () => {
    await POST(req());
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "routing.team_saved",
      actorUserId: ator,
      organizationId: org,
      resourceType: "attendance_team",
      resourceId: time,
      metadata: { slug: "financeiro", user_ids: [atendente] },
    }));
  });
});
