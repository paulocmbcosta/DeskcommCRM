// @vitest-environment node
/**
 * REVALIDAR A CHAVE DE VOZ DO TELEFONE PELA MESMA RÉGUA DO CADASTRO.
 *
 * A chave da ElevenLabs mora em `ai_provider_credentials` ao lado das de modelo,
 * e o botão "Testar" de uma credencial chama esta rota. `validateProviderKey`
 * só conhece provedor de modelo de linguagem: para `elevenlabs` ela devolveria
 * `unknown_provider` e marcaria como inválida uma chave boa. A régua certa é a do
 * cadastro (`PUT /api/v1/telefonia/voz/chave`): listar as vozes da conta. A
 * falha volta traduzida, com o status que o cadastro usaria — nunca 500.
 *
 * Chave fictícia e ElevenLabs falsa: nenhuma chamada sai da máquina.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloElevenLabs from "@/lib/telefonia/elevenlabs";

const CHAVE = "sk_chave_ficticia_de_voz_1234";
const ORG = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

const estado = vi.hoisted(() => ({
  provider: "elevenlabs",
  falhaDaElevenLabs: null as null | string,
  patch: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "sk_chave_ficticia_de_voz_1234",
  byteaToBuffer: (v: unknown) => v,
}));
vi.mock("@/lib/ai/provider-validators", () => ({
  validateProviderKey: vi.fn(async () => ({ ok: true, models: ["modelo-x"] })),
}));
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof ModuloElevenLabs>("@/lib/telefonia/elevenlabs");
  return {
    ...real,
    listarVozes: vi.fn(async () => {
      if (estado.falhaDaElevenLabs) {
        throw new real.ErroDaElevenLabs(estado.falhaDaElevenLabs as "chave_invalida", null);
      }
      return [{ voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null }];
    }),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from() {
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = () => cadeia;
      cadeia.update = (p: Record<string, unknown>) => {
        estado.patch = p;
        return cadeia;
      };
      cadeia.maybeSingle = () =>
        Promise.resolve({
          data: {
            id: "33333333-3333-4333-8333-333333333333",
            organization_id: "22222222-2222-4222-8222-222222222222",
            provider: estado.provider,
            label: "ElevenLabs",
            api_key_encrypted: "c",
            api_key_iv: "i",
            api_key_tag: "t",
            is_active: true,
          },
          error: null,
        });
      cadeia.single = () =>
        Promise.resolve({
          data: { id: "33333333-3333-4333-8333-333333333333", provider: estado.provider, api_key_last4: "1234", ...estado.patch },
          error: null,
        });
      return cadeia;
    },
  })),
}));

import { audit } from "@/lib/audit";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { listarVozes } from "@/lib/telefonia/elevenlabs";

import { POST } from "./route";

const revalidar = () =>
  POST(new NextRequest(`https://crm.exemplo.com.br/api/v1/ai/credentials/${ID}/revalidate`, { method: "POST" }), {
    params: Promise.resolve({ id: ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  estado.provider = "elevenlabs";
  estado.falhaDaElevenLabs = null;
  estado.patch = null;
});

describe("POST /api/v1/ai/credentials/:id/revalidate — chave de voz", () => {
  it("elevenlabs válida: valida listando as vozes (não pelo validador de modelo) e responde ok", async () => {
    const r = await revalidar();

    expect(r.status).toBe(200);
    expect(listarVozes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listarVozes).mock.calls[0]![0]).toBe(CHAVE);
    expect(validateProviderKey).not.toHaveBeenCalled();
    expect(estado.patch).toMatchObject({ validation_error: null });
    expect(estado.patch!.validated_at).toEqual(expect.any(String));
    const texto = await r.text();
    expect(texto).not.toContain(CHAVE);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "ai.credential_revalidated",
      organizationId: ORG,
      metadata: { provider: "elevenlabs", ok: true, error: null },
    });
  });

  it("elevenlabs recusada: responde a falha traduzida (422), marca a chave e audita — sem 500", async () => {
    estado.falhaDaElevenLabs = "chave_invalida";
    const r = await revalidar();

    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("chave_invalida");
    expect(corpo.error.message).toMatch(/recusou a chave/);
    expect(JSON.stringify(corpo)).not.toContain(CHAVE);
    expect(estado.patch).toEqual({ validated_at: null, validation_error: "chave_invalida" });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "ai.credential_revalidated",
      metadata: { provider: "elevenlabs", ok: false, error: "chave_invalida" },
    });
    expect(validateProviderKey).not.toHaveBeenCalled();
  });

  it("ElevenLabs fora do ar: 502 traduzido, nunca 500", async () => {
    estado.falhaDaElevenLabs = "sem_resposta";
    const r = await revalidar();
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("sem_resposta");
  });

  it("controle: credencial de modelo segue pelo validador de modelo", async () => {
    estado.provider = "openai";
    const r = await revalidar();
    expect(r.status).toBe(200);
    expect(validateProviderKey).toHaveBeenCalledWith("openai", CHAVE);
    expect(listarVozes).not.toHaveBeenCalled();
  });
});
