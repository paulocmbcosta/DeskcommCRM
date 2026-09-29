// @vitest-environment node
/**
 * A rota genérica de mídia NÃO serve a gravação de uma ligação (F3): ela só sai
 * pela escuta auditada. A mídia comum segue como sempre (302 para a URL assinada).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const estado = vi.hoisted(() => ({
  mensagem: null as null | Record<string, unknown>,
  assinados: [] as string[],
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1", idioma: "pt-BR" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "22222222-2222-4222-8222-222222222222" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: estado.mensagem, error: null }) };
    return { auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) }, from: () => q };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: () => ({
        createSignedUrl: async (caminho: string) => {
          estado.assinados.push(caminho);
          return { data: { signedUrl: `https://storage.exemplo/${caminho}` }, error: null };
        },
      }),
    },
  })),
}));

import { GET } from "./route";

const pedir = () =>
  GET(new NextRequest("https://crm.exemplo.com.br/api/v1/messages/m1/media"), { params: Promise.resolve({ id: "m1" }) });

beforeEach(() => {
  estado.assinados = [];
});

describe("GET /api/v1/messages/[id]/media", () => {
  it("mídia comum: 302 para a URL assinada", async () => {
    estado.mensagem = { id: "m1", media_url: null, media_mime: "image/jpeg", media_storage_path: `${ORG}/c/m1.jpg`, external_id: "wamid.1" };
    const r = await pedir();
    expect(r.status).toBe(302);
    expect(estado.assinados).toEqual([`${ORG}/c/m1.jpg`]);
  });

  it("a gravação de uma ligação: 404, nada assinado — ela só sai pela escuta auditada", async () => {
    estado.mensagem = {
      id: "m1",
      media_url: null,
      media_mime: "audio/mpeg",
      media_storage_path: `${ORG}/c/m1.mp3`,
      external_id: "ligacao:3f1c2b8e-9a4d-4c6e-8f00-1234567890ab",
    };
    const r = await pedir();
    expect(r.status).toBe(404);
    expect(estado.assinados).toEqual([]);
  });
});
