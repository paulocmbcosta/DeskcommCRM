// @vitest-environment node
/**
 * A ESCUTA AUDITADA (F3, D6): atendente ou acima; a mensagem da ligação vem pelo
 * cliente de SESSÃO (a RLS decide quem enxerga a conversa); o caminho tem de
 * morar em `<org>/<conversa>/`; cada URL entregue é uma linha na auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
const CONVERSA = "6a0f5d1e-2222-4c6e-8f00-000000000002";
const MSG = "6a0f5d1e-1111-4c6e-8f00-000000000001";

const estado = vi.hoisted(() => ({
  /** O que a RLS devolveria para a sessão: `null` = a conversa não é visível. */
  mensagem: null as null | { id: string; conversation_id: string; media_storage_path: string | null },
  /** A ligação como a sessão a lê (voice_calls é da organização inteira). */
  ligacao: null as null | { id: string; conversation_id: string | null; recording_status: string | null },
  filtros: [] as Array<[string, unknown]>,
  assinados: [] as Array<[string, string, number]>,
  papelOk: true,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    estado.papelOk
      ? {
          ok: true,
          user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
          org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
        }
      : { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) },
  ),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const consulta = (dado: () => unknown, tabela: string) => {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          estado.filtros.push([`${tabela}.${coluna}`, valor]);
          return q;
        },
        maybeSingle: async () => ({ data: dado(), error: null }),
      };
      return q;
    };
    return {
      from: (tabela: string) =>
        tabela === "messages"
          ? consulta(() => estado.mensagem, "messages")
          : tabela === "voice_calls"
            ? consulta(() => estado.ligacao, "voice_calls")
            : null,
    };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (caminho: string, s: number) => {
          estado.assinados.push([bucket, caminho, s]);
          return { data: { signedUrl: `https://storage.exemplo/${caminho}?token=x` }, error: null };
        },
      }),
    },
  })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";

import { GET } from "./route";

const ouvir = (id = VC) =>
  GET(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/chamadas/${id}/gravacao`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  estado.mensagem = { id: MSG, conversation_id: CONVERSA, media_storage_path: `${ORG}/${CONVERSA}/${MSG}.mp3` };
  estado.ligacao = { id: VC, conversation_id: CONVERSA, recording_status: "stored" };
  estado.filtros = [];
  estado.assinados = [];
  estado.papelOk = true;
  vi.mocked(audit).mockClear();
  vi.mocked(requireRole).mockClear();
});

describe("GET /api/v1/telefonia/chamadas/[id]/gravacao", () => {
  it("atendente que enxerga a conversa: URL assinada de 10 min do bucket da mídia, e UMA linha na auditoria", async () => {
    const r = await ouvir();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(corpo.data.url).toBe(`https://storage.exemplo/${ORG}/${CONVERSA}/${MSG}.mp3?token=x`);
    expect(estado.assinados).toEqual([["whatsapp-media", `${ORG}/${CONVERSA}/${MSG}.mp3`, 600]]);
    expect(estado.filtros).toEqual([
      ["messages.organization_id", ORG],
      ["messages.external_id", `ligacao:${VC}`],
      ["voice_calls.organization_id", ORG],
      ["voice_calls.id", VC],
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.recording_listened",
      organizationId: ORG,
      resourceType: "voice_call",
      resourceId: VC,
      metadata: { conversation_id: CONVERSA },
    });
    // Nunca o caminho do arquivo na auditoria.
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toContain(".mp3");
  });

  it("abaixo de atendente: a recusa do requireRole, sem ler nada nem auditar", async () => {
    estado.papelOk = false;
    const r = await ouvir();
    expect(r.status).toBe(403);
    expect(estado.filtros).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("conversa que a RLS não mostra (outro time): 404, sem assinar nem auditar", async () => {
    estado.mensagem = null;
    const r = await ouvir();
    expect(r.status).toBe(404);
    expect(estado.assinados).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ligação ainda sem arquivo: 404", async () => {
    estado.mensagem = { id: MSG, conversation_id: CONVERSA, media_storage_path: null };
    expect((await ouvir()).status).toBe(404);
  });

  it("caminho fora de <org>/<conversa>/ (gravado por fora): 404, nada assinado", async () => {
    estado.mensagem = { id: MSG, conversation_id: CONVERSA, media_storage_path: `outra-org/${CONVERSA}/${MSG}.mp3` };
    expect((await ouvir()).status).toBe(404);
    expect(estado.assinados).toEqual([]);
  });

  it.each([
    ["a ligação é de OUTRA conversa (mensagem plantada)", () => (estado.ligacao = { id: VC, conversation_id: "outra-conversa", recording_status: "stored" })],
    ["a ligação ainda não foi guardada", () => (estado.ligacao = { id: VC, conversation_id: CONVERSA, recording_status: "recording" })],
    ["a ligação expirou", () => (estado.ligacao = { id: VC, conversation_id: CONVERSA, recording_status: "expired" })],
    ["a ligação não existe", () => (estado.ligacao = null)],
    [
      "o caminho não é o da gravação (outro arquivo da mesma conversa)",
      () => (estado.mensagem = { id: MSG, conversation_id: CONVERSA, media_storage_path: `${ORG}/${CONVERSA}/outra-midia.jpg` }),
    ],
    [
      "o caminho tem `..`",
      () => (estado.mensagem = { id: MSG, conversation_id: CONVERSA, media_storage_path: `${ORG}/${CONVERSA}/../x/${MSG}.mp3` }),
    ],
  ])("%s: 404, nada assinado nem auditado", async (_nome, preparar) => {
    preparar();
    expect((await ouvir()).status).toBe(404);
    expect(estado.assinados).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("id que não é UUID: 404 sem consultar", async () => {
    expect((await ouvir("../x")).status).toBe(404);
    expect(estado.filtros).toEqual([]);
  });
});
