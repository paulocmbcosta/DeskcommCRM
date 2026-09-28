// @vitest-environment node
/**
 * REVALIDAR A CHAVE DE VOZ DO TELEFONE PELA MESMA RÉGUA DO CADASTRO.
 *
 * A chave da ElevenLabs mora em `ai_provider_credentials` ao lado das de modelo,
 * e o botão "Testar" de uma credencial chama esta rota. `validateProviderKey`
 * só conhece provedor de modelo de linguagem: para `elevenlabs` ela devolveria
 * `unknown_provider` e marcaria como inválida uma chave boa. A régua certa é a do
 * cadastro (`PUT /api/v1/telefonia/voz/chave`): listar as vozes da conta.
 *
 * A resposta segue a do ramo de modelo — 200 com `validation_error` —, para a
 * tela tratar os dois iguais. E só a RECUSA da chave a desvalida: a ElevenLabs
 * fora do ar (ou a conta sem crédito) registra o erro e mantém `validated_at`,
 * porque a chave continua sendo a certa.
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
  decifragemFalha: false,
  patch: null as null | Record<string, unknown>,
  /** Os `.eq` de cada UPDATE — é o que prova o filtro de organização na escrita. */
  eqsDoUpdate: [] as Array<[string, unknown]>,
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
  decryptKey: () => {
    if (estado.decifragemFalha) throw new Error("Unsupported state or unable to authenticate data sk_resto_de_segredo");
    return "sk_chave_ficticia_de_voz_1234";
  },
  byteaToBuffer: (v: unknown) => v,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
      let ehUpdate = false;
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (coluna: string, valor: unknown) => {
        if (ehUpdate) estado.eqsDoUpdate.push([coluna, valor]);
        return cadeia;
      };
      cadeia.update = (p: Record<string, unknown>) => {
        ehUpdate = true;
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
import { logger } from "@/lib/logger";
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
  estado.decifragemFalha = false;
  estado.patch = null;
  estado.eqsDoUpdate = [];
});

describe("POST /api/v1/ai/credentials/:id/revalidate — chave de voz", () => {
  it("elevenlabs válida: valida listando as vozes (não pelo validador de modelo) e responde ok", async () => {
    const r = await revalidar();

    expect(r.status).toBe(200);
    expect(listarVozes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listarVozes).mock.calls[0]![0]).toBe(CHAVE);
    expect(validateProviderKey).not.toHaveBeenCalled();
    expect(estado.patch).toEqual({ validated_at: expect.any(String), validation_error: null });
    const texto = await r.text();
    expect(texto).not.toContain(CHAVE);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "ai.credential_revalidated",
      organizationId: ORG,
      metadata: { provider: "elevenlabs", ok: true, error: null },
    });
  });

  it("a escrita filtra o id E a organização da sessão", async () => {
    await revalidar();
    expect(estado.eqsDoUpdate).toEqual(
      expect.arrayContaining([
        ["id", ID],
        ["organization_id", ORG],
      ]),
    );
  });

  it("elevenlabs RECUSADA: 200 com validation_error (como o ramo de modelo), e a chave é desvalidada", async () => {
    estado.falhaDaElevenLabs = "chave_invalida";
    const r = await revalidar();

    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { validation_error: string | null } };
    expect(corpo.data.validation_error).toBe("chave_invalida");
    expect(JSON.stringify(corpo)).not.toContain(CHAVE);
    expect(estado.patch).toEqual({ validated_at: null, validation_error: "chave_invalida" });
    expect(estado.eqsDoUpdate).toEqual(expect.arrayContaining([["organization_id", ORG]]));
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "ai.credential_revalidated",
      metadata: { provider: "elevenlabs", ok: false, error: "chave_invalida" },
    });
    expect(validateProviderKey).not.toHaveBeenCalled();
  });

  it.each(["sem_resposta", "erro_do_provedor", "sem_credito"])(
    "%s: 200, o erro fica registrado e a chave boa NÃO é desvalidada",
    async (motivo) => {
      estado.falhaDaElevenLabs = motivo;
      const r = await revalidar();

      expect(r.status).toBe(200);
      // Sem `validated_at` no patch: a validação anterior continua valendo.
      expect(estado.patch).toEqual({ validation_error: motivo });
      expect(((await r.json()) as { data: { validation_error: string } }).data.validation_error).toBe(motivo);
      expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ metadata: { ok: false, error: motivo } });
    },
  );

  it("controle: credencial de modelo segue pelo validador de modelo", async () => {
    estado.provider = "openai";
    const r = await revalidar();
    expect(r.status).toBe(200);
    expect(validateProviderKey).toHaveBeenCalledWith("openai", CHAVE);
    expect(listarVozes).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/ai/credentials/:id/revalidate — decifragem que falha", () => {
  it("500 decrypt_failed, e o log leva só a classe — nunca a mensagem nem o objeto", async () => {
    estado.decifragemFalha = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await revalidar();

    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("decrypt_failed");
    expect(consoleError).not.toHaveBeenCalled();
    expect(vi.mocked(logger).error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger).error.mock.calls[0]![1]).toMatchObject({ classe: "Error", organization_id: ORG });
    expect(JSON.stringify(vi.mocked(logger).error.mock.calls)).not.toContain("sk_resto_de_segredo");
    consoleError.mockRestore();
  });
});
