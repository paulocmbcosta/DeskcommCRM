/**
 * "Chamar no WhatsApp" exige o time da conversa e deixa quem chamou como dono
 * (migration 0284).
 *
 * O que estes casos prendem é a ORDEM: o time é checado antes de abrir a
 * conversa (pedido inválido não cria conversa órfã), e time e dono são gravados
 * antes do envio (a resposta do cliente já encontra dono). Se a etapa de time
 * recusar, nada é enviado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { iniciarConversaEEnviar } from "@/lib/messaging/iniciar-conversa";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/times/catalogo", () => ({ carregarTimes: vi.fn() }));
vi.mock("@/lib/messaging/iniciar-conversa", () => ({ iniciarConversaEEnviar: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({ registrarTrocaDeComando: vi.fn(async () => undefined) }));

const org = "70000000-0000-4000-8000-000000000001";
const sessao = "70000000-0000-4000-8000-000000000002";
const contato = "70000000-0000-4000-8000-000000000003";
const conversa = "70000000-0000-4000-8000-000000000004";
const suporte = "70000000-0000-4000-8000-00000000000a";
const financeiro = "70000000-0000-4000-8000-00000000000b";

const rpc = vi.fn();
const enviou = vi.fn();

function time(id: string, user_ids: string[]) {
  return {
    id, name: id, slug: id, description: "", schedule: {}, archived_at: null,
    max_concurrent: null, aberto_agora: true, horario_invalido: false, user_ids,
  };
}

function pedido(extra: Record<string, unknown> = {}) {
  return new Request("http://x/api/v1/conversations/iniciar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel_session_id: sessao,
      contact_id: contato,
      mensagem: { type: "text", body: "Olá!" },
      ...extra,
    }),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "ana", idioma: "pt-BR" },
    org: { orgId: org, role: "agent" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
  vi.mocked(carregarTimes).mockResolvedValue([time(suporte, ["ana"]), time(financeiro, ["bia"])] as never);
  rpc.mockResolvedValue({ data: { assigned_to_user_id: "ana" }, error: null });
  // O mock segue o contrato do helper: abre, roda `antesDeEnviar`, e só então envia.
  vi.mocked(iniciarConversaEEnviar).mockImplementation(async (_db, _ctx, _input, opts) => {
    await opts?.antesDeEnviar?.({ conversation_id: conversa, contact_id: contato });
    enviou();
    return { conversation_id: conversa, contact_id: contato, envio: { ok: true, message: {} as never } };
  });
});

describe("POST /api/v1/conversations/iniciar — o time da conversa", () => {
  it("sem time escolhido, recusa com 422 e NÃO abre conversa", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("team_required");
    expect(iniciarConversaEEnviar).not.toHaveBeenCalled();
  });

  it("atendente não abre conversa num time de que não faz parte", async () => {
    const res = await POST(pedido({ team_id: financeiro }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("team_not_allowed");
    expect(iniciarConversaEEnviar).not.toHaveBeenCalled();
  });

  it("grava time e dono ANTES de enviar, pelo client de quem chamou", async () => {
    const ordem: string[] = [];
    rpc.mockImplementation(async () => {
      ordem.push("time");
      return { data: { assigned_to_user_id: "ana" }, error: null };
    });
    enviou.mockImplementation(() => ordem.push("envio"));

    const res = await POST(pedido({ team_id: suporte }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_conversation_iniciar_no_time", {
      p_org: org,
      p_conversation: conversa,
      p_team: suporte,
    });
    expect(ordem).toEqual(["time", "envio"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.started_in_team",
        metadata: { team_id: suporte, assigned_to_user_id: "ana" },
      }),
    );
  });

  it("cliente já em atendimento com outra pessoa: 409 com o nome, e nada é enviado", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "conversation_owned", details: "Bia Souza" } });
    const res = await POST(pedido({ team_id: suporte }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("conversation_owned");
    expect(body.error.message).toContain("Bia Souza");
    expect(enviou).not.toHaveBeenCalled();
  });

  it("empresa sem time cadastrado: não há o que escolher, e a conversa segue só com o dono", async () => {
    vi.mocked(carregarTimes).mockResolvedValue([]);
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_conversation_iniciar_no_time", expect.objectContaining({ p_team: null }));
  });

  it("gestor escolhe qualquer time ativo, mesmo sem ser membro", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "ana", idioma: "pt-BR" },
      org: { orgId: org, role: "manager" },
    } as never);
    const res = await POST(pedido({ team_id: financeiro }));
    expect(res.status).toBe(200);
  });
});
