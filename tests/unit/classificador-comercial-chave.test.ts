import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: vi.fn(() => "sk-or-da-organizacao"),
  byteaToBuffer: vi.fn((v: unknown) => v),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { chaveDaOpenRouter } = await import("@/lib/classificador-comercial/chave");
const { decryptKey } = await import("@/lib/crypto/aes_gcm");
const { logger } = await import("@/lib/logger");

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

/**
 * Imita o builder do PostgREST devolvendo um erro ESTRUTURADO — o caminho
 * real do postgrest-js instalado, que NÃO lança em erro HTTP/rede, e sim
 * devolve `{ data: null, error }`. Diferente de `adminQueDevolve(null, erro)`,
 * que simula uma exceção (ex.: falha de transporte antes de chegar à resposta).
 */
function adminComErroEstruturado(erro: { code: string; message: string }) {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "limit"]) {
    cadeia[m] = () => cadeia;
  }
  cadeia.maybeSingle = async () => ({ data: null, error: erro });
  return { admin: { from: () => cadeia } as never };
}

const CIFRADA = { api_key_encrypted: "c", api_key_iv: "i", api_key_tag: "t" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chaveDaOpenRouter", () => {
  it("prefere a credencial da ORGANIZAÇÃO, ativa, validada, do provedor openrouter e a MAIS RECENTE", async () => {
    const { admin, filtros } = adminQueDevolve(CIFRADA);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-da-instalacao" })).toEqual({
      apiKey: "sk-or-da-organizacao",
      origem: "organizacao",
    });
    expect(filtros).toContainEqual(["eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["eq", ["provider", "openrouter"]]);
    expect(filtros).toContainEqual(["eq", ["is_active", true]]);
    expect(filtros).toContainEqual(["not", ["validated_at", "is", null]]);
    // Sem o `order`+`limit`, duas credenciais openrouter ativas na mesma
    // organização derrubam o `maybeSingle` real com PGRST116 ("multiple rows
    // returned").
    expect(filtros).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(filtros).toContainEqual(["limit", [1]]);
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

  it("erro ESTRUTURADO do PostgREST (sem lançar) cai para a da instalação, com o CÓDIGO — nunca a mensagem — no log", async () => {
    const { admin } = adminComErroEstruturado({ code: "PGRST205", message: "tabela não encontrada no cache do schema" });
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-x" })).toEqual({
      apiKey: "sk-or-x",
      origem: "instalacao",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ codigo: "PGRST205" }));
    // A mensagem do Postgres não vaza pro log — só o código.
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("tabela não encontrada");
  });

  it("leitura que LANÇA (falha de transporte, não erro estruturado) cai para a da instalação, e o log leva só a CLASSE do erro — nunca a mensagem", async () => {
    const { admin } = adminQueDevolve(null, new Error("sk-or-segredo"));
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-x" })).toEqual({
      apiKey: "sk-or-x",
      origem: "instalacao",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ erro: "Error" }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("sk-or-segredo");
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
