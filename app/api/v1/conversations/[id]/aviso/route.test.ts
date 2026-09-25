/**
 * O contexto do aviso de mensagem: lido com a SESSÃO (sob a RLS), nunca como
 * anônimo — que era o defeito: o supabase-js do navegador não enxerga o cookie
 * httpOnly, a RLS devolvia vazio, e o aviso chegava sem dizer de quem era.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const org = "60000000-0000-4000-8000-000000000001";
const conversa = "60000000-0000-4000-8000-0000000000c1";

function leitura(linha: unknown) {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn((col: string, v: unknown) => {
      filtros.push([col, v]);
      return q;
    }),
    maybeSingle: vi.fn(async () => ({ data: linha, error: null })),
  };
  vi.mocked(createClient).mockResolvedValue({ from: vi.fn(() => q) } as never);
  return filtros;
}

const assinar = vi.fn(async () => ({ data: { signedUrl: "https://storage/foto?token=x" } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: org, role: "agent" },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    storage: { from: () => ({ createSignedUrl: assinar }) },
  } as never);
});

const chamar = (id: string) => GET({} as never, { params: Promise.resolve({ id }) });

const linhaCompleta = {
  contact_id: "c1",
  assigned_to_user_id: "u2",
  assigned_to_user_name: "Ana Lima",
  assignee_kind: "user",
  contacts: {
    display_name: "Maria Souza",
    name: null,
    phone_number: "+5532984790001",
    avatar_storage_path: "org/c1.jpg",
    is_anonymized: false,
  },
  attendance_teams: { name: "Financeiro" },
};

describe("GET /api/v1/conversations/{id}/aviso", () => {
  it("devolve quem, de qual time e com quem — lido pela sessão, na org da sessão", async () => {
    const filtros = leitura(linhaCompleta);
    const res = await chamar(conversa);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      contato: { display_name: "Maria Souza" },
      time: "Financeiro",
      atendente: "Ana Lima",
      assigned_to: "u2",
      com_ia: false,
      foto: "https://storage/foto?token=x",
    });
    // O caminho do arquivo no bucket não sai da rota — só a URL assinada.
    expect(JSON.stringify(data)).not.toContain("org/c1.jpg");
    expect(filtros).toContainEqual(["organization_id", org]);
    expect(filtros).toContainEqual(["id", conversa]);
  });

  it("conversa que a RLS esconde é 404 — não se descobre de quem ela é", async () => {
    leitura(null);
    expect((await chamar(conversa)).status).toBe(404);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("contato anonimizado nunca devolve foto", async () => {
    leitura({ ...linhaCompleta, contacts: { ...linhaCompleta.contacts, is_anonymized: true } });
    const { data } = (await (await chamar(conversa)).json()) as { data: { foto: unknown } };
    expect(data.foto).toBeNull();
    expect(assinar).not.toHaveBeenCalled();
  });

  it("sem foto, não assina nada — a maioria dos contatos", async () => {
    leitura({ ...linhaCompleta, contacts: { ...linhaCompleta.contacts, avatar_storage_path: null } });
    await chamar(conversa);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("id que não é uuid é 400, sem tocar no banco", async () => {
    expect((await chamar("nao-e-uuid")).status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("preserva a negativa de autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    expect((await chamar(conversa)).status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });
});
