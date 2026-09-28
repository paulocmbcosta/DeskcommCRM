// @vitest-environment node
/**
 * AS VOZES DA CONTA PELA ROTA: admin; sem chave, 422 com a orientação; a lista vem
 * ao vivo da ElevenLabs (falsa aqui); a falha dela volta 422/502 — nunca 429/503,
 * que o `apiClient` repetiria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloElevenLabs from "@/lib/telefonia/elevenlabs";

const estado = vi.hoisted(() => ({
  chave: "sk_ficticia" as string | null,
  falha: null as null | "chave_invalida" | "limite_de_uso" | "sem_resposta",
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/telefonia/chave-elevenlabs", () => ({ chaveDeVoz: vi.fn(async () => estado.chave) }));
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof ModuloElevenLabs>("@/lib/telefonia/elevenlabs");
  return {
    ...real,
    listarVozes: vi.fn(async () => {
      if (estado.falha) throw new real.ErroDaElevenLabs(estado.falha, null);
      return [{ voice_id: "v1", nome: "Ana", categoria: "premade", amostra_url: "https://exemplo.com/a.mp3" }];
    }),
  };
});

import { requireRole } from "@/lib/auth/require-role";
import { chaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";

import { GET } from "./route";

beforeEach(() => {
  estado.chave = "sk_ficticia";
  estado.falha = null;
  vi.mocked(requireRole).mockClear();
  vi.mocked(chaveDeVoz).mockClear();
});

describe("GET /api/v1/telefonia/voz/vozes", () => {
  it("admin, com a chave da organização da sessão: a lista da conta", async () => {
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(vi.mocked(chaveDeVoz).mock.calls[0]![1]).toBe("22222222-2222-4222-8222-222222222222");
    expect(await r.json()).toMatchObject({ data: { vozes: [{ voice_id: "v1", nome: "Ana" }] } });
  });

  it("sem chave: 422 sem_chave", async () => {
    estado.chave = null;
    const r = await GET();
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("sem_chave");
  });

  it("falha da ElevenLabs: 422 (inclusive o 429 dela, limite_de_uso) ou 502 — nunca 429", async () => {
    estado.falha = "chave_invalida";
    expect((await GET()).status).toBe(422);
    estado.falha = "limite_de_uso";
    expect((await GET()).status).toBe(422);
    estado.falha = "sem_resposta";
    expect((await GET()).status).toBe(502);
  });
});
