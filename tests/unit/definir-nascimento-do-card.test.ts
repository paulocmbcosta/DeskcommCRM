import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
let suporte: Record<string, unknown> | null = null;
let settingsAtuais: Record<string, unknown> = {};
let chaveDisponivel: { apiKey: string; origem: string } | null = { apiKey: "k", origem: "organizacao" };
const gravados: Array<Record<string, unknown>> = [];
const auditadas: Array<Record<string, unknown>> = [];
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: suporte })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Provedor", role: papel })),
}));
vi.mock("@/lib/classificador-comercial/chave", () => ({
  chaveDaOpenRouter: vi.fn(async () => chaveDisponivel),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: settingsAtuais }, error: null }) }) }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          gravados.push(payload);
          return { error: null };
        },
      }),
    }),
  }),
}));

const { definirNascimentoDoCard } = await import("@/app/actions/settings/definirNascimentoDoCard");

beforeEach(() => {
  papel = "admin";
  suporte = null;
  settingsAtuais = { llm: { provider: "anthropic" }, crm: { cliente_pela_agenda: true } };
  chaveDisponivel = { apiKey: "k", origem: "organizacao" };
  gravados.length = 0;
  auditadas.length = 0;
  revalidatePath.mockClear();
});

describe("definirNascimentoDoCard", () => {
  it.each(["manager", "agent", "viewer"])("%s → sem_permissao, e nada é gravado", async (p) => {
    papel = p;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
    expect(gravados).toEqual([]);
  });

  it("entrada inválida → invalido", async () => {
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.75 })).toEqual({ ok: false, erro: "invalido" });
    expect(await definirNascimentoDoCard("lixo")).toEqual({ ok: false, erro: "invalido" });
  });

  it("não liga o classificador sem chave da OpenRouter", async () => {
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({
      ok: false,
      erro: "sem_chave_openrouter",
    });
    expect(gravados).toEqual([]);
  });

  it("desligar não exige chave", async () => {
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "toda_conversa", limiar: 0.7 })).toEqual({
      ok: true,
      modo: "toda_conversa",
      limiar: 0.7,
    });
  });

  it("grava mesclando: preserva o provedor de IA e a vizinha cliente_pela_agenda", async () => {
    await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(gravados).toEqual([
      {
        settings: {
          llm: { provider: "anthropic" },
          crm: { cliente_pela_agenda: true, nascimento_do_card: { modo: "classificador", limiar: 0.8 } },
        },
      },
    ]);
  });

  it("audita antes e depois, e revalida a tela", async () => {
    await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm.nascimento_do_card_alterado",
        organizationId: ORG,
        metadata: { antes: { modo: "toda_conversa", limiar: 0.7 }, depois: { modo: "classificador", limiar: 0.8 } },
      }),
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings/tenant/pipelines");
  });

  it("suporte somente leitura → somente_leitura", async () => {
    // Formato de `SupportContext` lido por `supportWriteError` (lib/impersonate/support.ts).
    suporte = { id: "s", organization_id: ORG, status: "active", access_mode: "read_only" };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 });
    expect(r).toEqual({ ok: false, erro: "somente_leitura" });
  });
});
