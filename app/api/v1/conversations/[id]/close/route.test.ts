/**
 * POST /close é uma das DUAS portas que encerram (a outra é o PATCH com status
 * terminal), e as duas passam por `fn_atendimento_encerrar` (migration 0293).
 *
 * O que este arquivo guarda: a organização e o ator vêm da SESSÃO, a recusa do
 * banco vira 422 dizendo QUAL campo faltou — e o resumo, que é texto livre
 * sobre o cliente, nunca vai para a auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "50000000-0000-4000-8000-000000000001";
const outraOrg = "50000000-0000-4000-8000-0000000000ff";
const ator = "50000000-0000-4000-8000-000000000002";
const conversa = "50000000-0000-4000-8000-000000000003";
const assunto = "50000000-0000-4000-8000-000000000004";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const filtros: Array<[string, unknown]> = [];

const req = (body?: unknown) =>
  new Request(`http://localhost/api/v1/conversations/${conversa}/close`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
const ctx = { params: Promise.resolve({ id: conversa }) };

beforeEach(() => {
  vi.clearAllMocks();
  filtros.length = 0;
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ator, idioma: "pt-BR" },
    org: { orgId: org },
  } as never);
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return consulta;
    },
    maybeSingle,
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => consulta } as never);
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  maybeSingle.mockResolvedValue({
    data: { id: conversa, organization_id: org, service_revision: 7, status: "open", is_group: false },
    error: null,
  });
  rpc.mockResolvedValue({ data: { id: conversa, organization_id: org, status: "closed" }, error: null });
});

describe("POST /api/v1/conversations/[id]/close", () => {
  it("fecha pela porta única, com organização e ator da sessão", async () => {
    const res = await POST(req({ assunto_id: assunto, resumo: "Trocou a senha do Wi-Fi." }), ctx);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_atendimento_encerrar", {
      p_org: org,
      p_conversation: conversa,
      p_expected: 7,
      p_actor: ator,
      p_assunto: assunto,
      p_resumo: "Trocou a senha do Wi-Fi.",
      p_status: "closed",
    });
    expect(filtros).toContainEqual(["organization_id", org]);
  });

  it("corpo vazio continua valendo: os campos vão nulos e o banco decide", async () => {
    expect((await POST(req(), ctx)).status).toBe(200);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_assunto: null, p_resumo: null });
  });

  it("organization_id no corpo não muda a organização", async () => {
    await POST(req({ organization_id: outraOrg, resumo: "tentativa" }), ctx);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_org: org });
  });

  it("expected_revision do cliente tem precedência sobre a lida", async () => {
    await POST(req({ expected_revision: 3 }), ctx);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_expected: 3 });
  });

  it.each([
    ["encerramento_assunto_obrigatorio", { campo: "assunto", motivo: "obrigatorio" }],
    ["encerramento_assunto_invalido", { campo: "assunto", motivo: "invalido" }],
    ["encerramento_resumo_obrigatorio", { campo: "resumo", motivo: "obrigatorio" }],
    ["encerramento_resumo_longo", { campo: "resumo", motivo: "longo" }],
  ])("recusa %s vira 422 com o campo, e não audita", async (message, details) => {
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message } });
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.details).toEqual(details);
    expect(audit).not.toHaveBeenCalled();
  });

  it("22023 que NÃO é recusa do registro não vira 422 de campo", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "invalid_status" } });
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error.details).toBeUndefined();
  });

  it("atendimento que mudou no meio do caminho é 409", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "service_stale" } });
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("conflict");
  });

  it("assunto que não é uuid e resumo acima do teto param antes do banco", async () => {
    expect((await POST(req({ assunto_id: "nao-e-uuid" }), ctx)).status).toBe(422);
    expect((await POST(req({ resumo: "a".repeat(2001) }), ctx)).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("conversa que a sessão não enxerga é 404 e não chega à função", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await POST(req({}), ctx)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("suporte somente leitura e viewer não encerram", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await POST(req({}), ctx)).status).toBe(403);
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await POST(req({}), ctx)).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("audita o encerramento SEM o texto do resumo", async () => {
    await POST(req({ assunto_id: assunto, resumo: "Maria reclamou do sinal no quarto." }), ctx);
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "conversation.closed",
      actorUserId: ator,
      organizationId: org,
      metadata: { assunto_id: assunto, com_resumo: true },
    });
    expect(JSON.stringify(entrada)).not.toContain("Maria");
  });

  it.each([
    ["já encerrada", { status: "closed", is_group: false }],
    ["de grupo", { status: "open", is_group: true }],
  ])("conversa %s: a auditoria não afirma um registro que não foi gravado", async (_nome, estado) => {
    maybeSingle.mockResolvedValue({
      data: { id: conversa, organization_id: org, service_revision: 7, ...estado },
      error: null,
    });
    await POST(req({ assunto_id: assunto, resumo: "Texto que o banco vai descartar." }), ctx);
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toEqual({ sem_registro: true });
  });
});
