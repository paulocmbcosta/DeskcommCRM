import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: vi.fn(() => "sk-or-da-organizacao"),
  byteaToBuffer: vi.fn((v: unknown) => v),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { chaveDaOpenRouter } = await import("@/lib/classificador-comercial/chave");
const { decryptKey } = await import("@/lib/crypto/aes_gcm");

/** Imita o builder do PostgREST e guarda os filtros aplicados. */
function adminQueDevolve(linha: unknown, lanca?: Error) {
  const filtros: Array<[string, unknown[]]> = [];
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "limit"]) {
    cadeia[m] = (...args: unknown[]) => {
      filtros.push([m, args]);
      return cadeia;
    };
  }
  cadeia.maybeSingle = async () => {
    if (lanca) throw lanca;
    return { data: linha, error: null };
  };
  return { admin: { from: () => cadeia } as never, filtros };
}

const CIFRADA = { api_key_encrypted: "c", api_key_iv: "i", api_key_tag: "t" };

describe("chaveDaOpenRouter", () => {
  it("prefere a credencial da ORGANIZAÇÃO, ativa, validada e do provedor openrouter", async () => {
    const { admin, filtros } = adminQueDevolve(CIFRADA);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-da-instalacao" })).toEqual({
      apiKey: "sk-or-da-organizacao",
      origem: "organizacao",
    });
    expect(filtros).toContainEqual(["eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["eq", ["provider", "openrouter"]]);
    expect(filtros).toContainEqual(["eq", ["is_active", true]]);
    expect(filtros).toContainEqual(["not", ["validated_at", "is", null]]);
  });

  it("sem credencial da organização, usa a da instalação", async () => {
    const { admin } = adminQueDevolve(null);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: " sk-or-da-instalacao " })).toEqual({
      apiKey: "sk-or-da-instalacao",
      origem: "instalacao",
    });
  });

  it("sem nenhuma das duas, null", async () => {
    const { admin } = adminQueDevolve(null);
    expect(await chaveDaOpenRouter(admin, "org-1", {})).toBeNull();
  });

  it("leitura que lança cai para a da instalação, e não derruba quem chamou", async () => {
    const { admin } = adminQueDevolve(null, new Error("tabela fora"));
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-x" })).toEqual({
      apiKey: "sk-or-x",
      origem: "instalacao",
    });
  });

  it("chave da organização vazia depois do trim cai para a da instalação", async () => {
    vi.mocked(decryptKey).mockReturnValueOnce("   \r\n  ");
    const { admin } = adminQueDevolve(CIFRADA);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-x" })).toEqual({
      apiKey: "sk-or-x",
      origem: "instalacao",
    });
  });

  it("chave da organização decifrada com \\r\\n/espaço no fim volta aparada", async () => {
    vi.mocked(decryptKey).mockReturnValueOnce("sk-or-da-organizacao\r\n ");
    const { admin } = adminQueDevolve(CIFRADA);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-da-instalacao" })).toEqual({
      apiKey: "sk-or-da-organizacao",
      origem: "organizacao",
    });
  });
});
