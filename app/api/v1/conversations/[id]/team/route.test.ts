/**
 * Encaminhar para um time é mutação como qualquer outra: mesmos portões, mesma
 * org da sessão, mesmo mapeamento de recusa do banco.
 *
 * O que este arquivo guarda de específico é a fronteira que NÃO pode mover: a
 * conversa vem do PATH e a organização da SESSÃO. Um `organization_id` no corpo
 * não é obedecido nem ignorado — é recusado, que é a única resposta que o
 * cliente consegue depurar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "50000000-0000-4000-8000-000000000001";
const outraOrg = "50000000-0000-4000-8000-0000000000ff";
const ator = "50000000-0000-4000-8000-000000000002";
const conversa = "50000000-0000-4000-8000-000000000003";
const time = "50000000-0000-4000-8000-000000000004";

const rpc = vi.fn();
const req = (body: unknown = { team_id: time }) =>
  new Request(`http://localhost/api/v1/conversations/${conversa}/team`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
const ctx = (id = conversa) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ator, idioma: "pt-BR" },
    org: { orgId: org, role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  rpc.mockResolvedValue({
    data: { conversation_id: conversa, team_id: time, released_from: null },
    error: null,
  });
});

describe("POST /api/v1/conversations/[id]/team", () => {
  it.each([401, 403])("preserva negativa de autorização %s", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    } as never);
    expect((await POST(req(), ctx())).status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("viewer não encaminha — o portão é `agent`", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "x" } }), {
        status: 403,
      }),
    } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("support somente-leitura não chega à RPC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("conversa fora de forma é 400, não 500 vindo do Postgres", async () => {
    const res = await POST(req(), ctx("nao-e-uuid"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([{}, { team_id: "nao-e-uuid" }, { team_id: 7 }])(
    "corpo inválido (%j) é 422 e não chega ao banco",
    async (corpo) => {
      expect((await POST(req(corpo), ctx())).status).toBe(422);
      expect(rpc).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it("A ORG VEM DA SESSÃO: `organization_id` no corpo é recusado, não obedecido", async () => {
    const res = await POST(req({ team_id: time, organization_id: outraOrg }), ctx());
    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("A ORG VEM DA SESSÃO: nem sob outro nome o corpo a alcança", async () => {
    // Segunda metade da mesma prova. A de cima mede que o corpo é RECUSADO; esta
    // mede que, num corpo aceito, `p_org` é o da sessão — é o que sobraria de
    // buraco se um dia o schema deixasse de ser `.strict()`.
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: ator, idioma: "pt-BR" },
      org: { orgId: outraOrg, role: "agent" },
    } as never);
    await POST(req({ team_id: time }), ctx());
    expect(rpc.mock.calls[0]?.[1].p_org).toBe(outraOrg);
  });

  it("a conversa vem do PATH e o time do corpo", async () => {
    expect((await POST(req(), ctx())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_conversation_set_team", {
      p_org: org,
      p_conversation: conversa,
      p_team: time,
    });
  });

  it("`team_id: null` devolve a conversa à fila geral", async () => {
    // `null` é DESTINO, não ausência de destino: é como se tira do setor uma
    // conversa encaminhada por engano. Um schema que exigisse uuid tiraria essa
    // saída da tela sem nada dizer.
    const res = await POST(req({ team_id: null }), ctx());
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0]?.[1].p_team).toBeNull();
  });

  it.each([
    ["P0002", 404, "not_found"],
    ["42501", 403, "forbidden"],
    ["XX000", 500, "internal_error"],
  ])("erro %s do Postgres vira %i", async (code, status, apiCode) => {
    rpc.mockResolvedValue({
      data: null,
      error: { code, message: "erro cru do postgres: fn_conversation_set_team" },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(apiCode);
    // A mensagem crua nomeia função e constraint para quem só perguntou por uma
    // conversa.
    expect(body.error.message).not.toContain("erro cru do postgres");
    expect(audit).not.toHaveBeenCalled();
  });

  it("sucesso audita com a conversa do path e o time escolhido", async () => {
    await POST(req(), ctx());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "routing.team_changed",
        actorUserId: ator,
        organizationId: org,
        resourceType: "conversation",
        resourceId: conversa,
        metadata: { team_id: time },
      }),
    );
  });

  it("devolver à fila geral também deixa rastro, com `null` escrito", async () => {
    // Sem isto, tirar uma conversa de um time seria indistinguível de ela nunca
    // ter tido um — e a pergunta "quem a tirou do financeiro?" não teria fonte.
    await POST(req({ team_id: null }), ctx());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "routing.team_changed", metadata: { team_id: null } }),
    );
  });
});
