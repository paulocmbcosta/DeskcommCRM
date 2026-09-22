import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
// Formato REAL do PostgREST (microssegundos + offset), não `Date.toISOString()`
// (milissegundos + "Z"). Uma regressão que passe o valor lido por
// `new Date(x).toISOString()` antes do `.eq("updated_at", ...)` perde os
// microssegundos — em Postgres real isso é sempre "tente_de_novo" (o filtro
// nunca casa) — e com um fixture já no formato de `Date` essa regressão
// passaria verde. Provado por sabotagem (ver o relatório da tarefa).
const UPDATED_AT = "2026-09-22T15:15:57.510777+00:00";

let semSessao = false;
let semOrgAtiva = false;
let platformAdmin = false;
let papel = "admin";
let mfaPendente = false;
let suporte: Record<string, unknown> | null = null;
let chaveDisponivel: { apiKey: string; origem: string } | null = { apiKey: "k", origem: "organizacao" };

/** O que o SELECT devolve. `null` simula organização sumida (row ausente). */
let leituraAtual: { settings: Record<string, unknown>; updated_at: string } | null = null;
let erroLeitura: { code: string; message: string } | null = null;

/** O que o UPDATE devolve pelo `.select("id")`. `[]` simula corrida perdida. */
let resultadoGravacao: Array<{ id: string }> | null = [{ id: ORG }];
let erroGravacao: { code: string; message: string } | null = null;

const gravados: Array<Record<string, unknown>> = [];
const auditadas: Array<Record<string, unknown>> = [];
const chamadasEqSelect: Array<[string, unknown]> = [];
const chamadasEqUpdate: Array<[string, unknown]> = [];
const revalidatePath = vi.fn();
const chaveDaOpenRouterMock = vi.fn(async (..._args: unknown[]) => chaveDisponivel);

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () =>
    semSessao ? null : { id: USER, is_platform_admin: platformAdmin, support: suporte },
  ),
  resolveActiveOrg: vi.fn(async () => (semOrgAtiva ? null : { orgId: ORG, name: "Provedor", role: papel })),
  mfaEmDivida: vi.fn(async () => mfaPendente),
}));
vi.mock("@/lib/classificador-comercial/chave", () => ({
  chaveDaOpenRouter: (...args: unknown[]) => chaveDaOpenRouterMock(...args),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (coluna: string, valor: unknown) => {
          chamadasEqSelect.push([coluna, valor]);
          return { maybeSingle: async () => ({ data: leituraAtual, error: erroLeitura }) };
        },
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (coluna1: string, valor1: unknown) => {
          chamadasEqUpdate.push([coluna1, valor1]);
          return {
            eq: (coluna2: string, valor2: unknown) => {
              chamadasEqUpdate.push([coluna2, valor2]);
              return {
                select: async (_colunas: string) => {
                  gravados.push(payload);
                  return { data: resultadoGravacao, error: erroGravacao };
                },
              };
            },
          };
        },
      }),
    }),
  }),
}));

const { definirNascimentoDoCard } = await import("@/app/actions/settings/definirNascimentoDoCard");

beforeEach(() => {
  semSessao = false;
  semOrgAtiva = false;
  platformAdmin = false;
  papel = "admin";
  mfaPendente = false;
  suporte = null;
  chaveDisponivel = { apiKey: "k", origem: "organizacao" };
  leituraAtual = {
    settings: { llm: { provider: "anthropic" }, crm: { cliente_pela_agenda: true } },
    updated_at: UPDATED_AT,
  };
  erroLeitura = null;
  resultadoGravacao = [{ id: ORG }];
  erroGravacao = null;
  gravados.length = 0;
  auditadas.length = 0;
  chamadasEqSelect.length = 0;
  chamadasEqUpdate.length = 0;
  revalidatePath.mockClear();
  chaveDaOpenRouterMock.mockClear();
  vi.mocked(logger.error).mockClear();
});

describe("definirNascimentoDoCard", () => {
  it.each(["manager", "agent", "viewer"])("%s → sem_permissao, e nada é gravado", async (p) => {
    papel = p;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
    expect(gravados).toEqual([]);
  });

  it("manager sem chave → sem_permissao, não sem_chave_openrouter (o papel vem antes)", async () => {
    papel = "manager";
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
    expect(chaveDaOpenRouterMock).not.toHaveBeenCalled();
  });

  it("platform admin com papel manager no tenant → sem_permissao (ação restrita ao admin do tenant)", async () => {
    platformAdmin = true;
    papel = "manager";
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
  });

  it("entrada inválida → invalido", async () => {
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.75 })).toEqual({ ok: false, erro: "invalido" });
    expect(await definirNascimentoDoCard("lixo")).toEqual({ ok: false, erro: "invalido" });
  });

  it("sem sessão → sessao", async () => {
    semSessao = true;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sessao" });
  });

  it("sem empresa ativa → sem_empresa", async () => {
    semOrgAtiva = true;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_empresa" });
  });

  it("organização sumiu entre a sessão e a leitura (row ausente) → sem_empresa", async () => {
    leituraAtual = null;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_empresa" });
  });

  it("admin com MFA pendente → mfa, e nada é gravado nem auditado", async () => {
    mfaPendente = true;
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 });
    expect(r).toEqual({ ok: false, erro: "mfa" });
    expect(gravados).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("manager com MFA pendente → sem_permissao (o papel vem antes do MFA)", async () => {
    papel = "manager";
    mfaPendente = true;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
  });

  it("não liga o classificador sem chave da OpenRouter", async () => {
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({
      ok: false,
      erro: "sem_chave_openrouter",
    });
    expect(gravados).toEqual([]);
  });

  it("desliga de verdade: estava classificador/0.8 sem chave disponível, grava toda_conversa e audita; chaveDaOpenRouter não é chamada", async () => {
    leituraAtual = {
      settings: { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.8 } } },
      updated_at: UPDATED_AT,
    };
    chaveDisponivel = null;
    const r = await definirNascimentoDoCard({ modo: "toda_conversa", limiar: 0.7 });
    expect(r).toEqual({ ok: true, modo: "toda_conversa", limiar: 0.7 });
    expect(gravados).toEqual([
      { settings: { crm: { nascimento_do_card: { modo: "toda_conversa", limiar: 0.7 } } } },
    ]);
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm.nascimento_do_card_alterado",
        metadata: { antes: { modo: "classificador", limiar: 0.8 }, depois: { modo: "toda_conversa", limiar: 0.7 } },
      }),
    ]);
    expect(chaveDaOpenRouterMock).not.toHaveBeenCalled();
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

  it("mesma regra: sem gravação, sem auditoria, mas revalida (aba velha não fica com o botão habilitado à toa)", async () => {
    leituraAtual = {
      settings: { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.8 } } },
      updated_at: UPDATED_AT,
    };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(r).toEqual({ ok: true, modo: "classificador", limiar: 0.8 });
    expect(gravados).toEqual([]);
    expect(auditadas).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings/tenant/pipelines");
  });

  it("filtra pela organização: select e update levam eq('id', ORG); a chave é pedida para ORG", async () => {
    await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(chamadasEqSelect).toContainEqual(["id", ORG]);
    expect(chamadasEqUpdate).toContainEqual(["id", ORG]);
    expect(chaveDaOpenRouterMock).toHaveBeenCalledWith(expect.anything(), ORG);
  });

  it("update casa zero linhas (a RPC irmã venceu a corrida) → tente_de_novo, sem auditoria; o eq('updated_at', …) leva o valor lido", async () => {
    resultadoGravacao = [];
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(r).toEqual({ ok: false, erro: "tente_de_novo" });
    expect(auditadas).toEqual([]);
    expect(chamadasEqUpdate).toContainEqual(["updated_at", UPDATED_AT]);
  });

  it("erro de leitura → falha, e o log leva o code, nunca a mensagem crua", async () => {
    erroLeitura = { code: "57014", message: "não pode vazar" };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(r).toEqual({ ok: false, erro: "falha" });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { organization_id: ORG, code: "57014" });
  });

  it("erro de gravação → falha, e o log leva o code, nunca a mensagem crua; sem auditoria", async () => {
    erroGravacao = { code: "23505", message: "não pode vazar" };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(r).toEqual({ ok: false, erro: "falha" });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { organization_id: ORG, code: "23505" });
    expect(auditadas).toEqual([]);
  });

  it.each([
    { status: "active", access_mode: "support_readonly" },
    { status: "expired", access_mode: "full" },
  ])("suporte $status/$access_mode → somente_leitura", async ({ status, access_mode }) => {
    suporte = { id: "s", organization_id: ORG, status, access_mode };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 });
    expect(r).toEqual({ ok: false, erro: "somente_leitura" });
  });
});
