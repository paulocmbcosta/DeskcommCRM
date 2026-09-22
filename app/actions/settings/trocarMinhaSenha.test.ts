/**
 * TROCAR A PRÓPRIA SENHA, LOGADO — e só com a senha atual na mão.
 *
 * Por que existe: desde 2026-09-22 um admin pode cadastrar um membro já com
 * senha, e quem escolheu a senha a conhece. A pessoa precisa conseguir tomar
 * posse dela — e, numa instalação sem e-mail, "Esqueci a senha" não chega a
 * lugar nenhum. Até aqui não existia tela para trocar a senha logado.
 *
 * Mede:
 *  - sem a senha ATUAL certa, nada muda (uma sessão esquecida aberta não troca
 *    a senha de ninguém com um clique);
 *  - a verificação da senha atual não deixa sessão sobrando;
 *  - conta com segundo fator exige a sessão com o código;
 *  - trocar APAGA a marca "senha definida por admin" — daí em diante só a
 *    pessoa conhece a senha, e ela pode aceitar convite de outra organização;
 *  - nenhuma senha vai para a auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USUARIO = {
  id: "abcdef12-3456-4abc-8def-123456789abc",
  email: "maria@empresa.com",
  app_metadata: {} as Record<string, unknown>,
};
const ATUAL = "Senha-Do-Admin-1";
const NOVA = "Minha-Senha-Nova-2";

const entrarAvulso = vi.fn();
const sairAvulso = vi.fn(async () => ({ error: null }));
const trocarNaSessao = vi.fn(async () => ({ data: {}, error: null as null | { code?: string; message: string } }));
const nivelDaSessao = vi.fn(async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }));
const atualizarConta = vi.fn(async () => ({ data: {}, error: null }));
let limitado = false;

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithPassword: entrarAvulso, signOut: sairAvulso },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: USUARIO }, error: null }),
      updateUser: trocarNaSessao,
      mfa: { getAuthenticatorAssuranceLevel: nivelDaSessao },
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ auth: { admin: { updateUserById: atualizarConta } } })),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async () => limitado),
  AUTH_LIMITS: { login: { ip: 30, id: 5, windowSec: 300 } },
}));

async function trocar(entrada: { senha_atual: string; nova: string; confirmacao: string }) {
  const { trocarMinhaSenha } = await import("./trocarMinhaSenha");
  return trocarMinhaSenha(entrada);
}

beforeEach(() => {
  vi.clearAllMocks();
  limitado = false;
  USUARIO.app_metadata = {};
  entrarAvulso.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
});

describe("trocarMinhaSenha — o que é recusado", () => {
  it("senha atual ERRADA: nada muda", async () => {
    entrarAvulso.mockResolvedValue({ data: { session: null }, error: { message: "Invalid login credentials" } });
    const r = await trocar({ senha_atual: "errada-123", nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: false, error: "senha_atual_incorreta" });
    expect(trocarNaSessao).not.toHaveBeenCalled();
    expect(atualizarConta).not.toHaveBeenCalled();
  });

  it("confirmação diferente não chega a verificar nada", async () => {
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: "outra-coisa-9" });
    expect(r.ok).toBe(false);
    expect(entrarAvulso).not.toHaveBeenCalled();
  });

  it("nova igual à atual é recusada", async () => {
    const r = await trocar({ senha_atual: ATUAL, nova: ATUAL, confirmacao: ATUAL });
    expect(r.ok).toBe(false);
    expect(trocarNaSessao).not.toHaveBeenCalled();
  });

  it("muitas tentativas: limita antes de testar a senha", async () => {
    limitado = true;
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: false, error: "rate_limited" });
    expect(entrarAvulso).not.toHaveBeenCalled();
  });

  it("conta com segundo fator e sessão sem o código: pede o código, não troca", async () => {
    nivelDaSessao.mockResolvedValueOnce({ data: { currentLevel: "aal1", nextLevel: "aal2" } });
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(trocarNaSessao).not.toHaveBeenCalled();
  });
});

describe("trocarMinhaSenha — quando passa", () => {
  it("verifica a atual, não deixa sessão sobrando, troca e APAGA a marca do admin", async () => {
    USUARIO.app_metadata = {
      senha_definida_por_admin: { organization_id: "22222222-2222-4222-8222-222222222222" },
    };
    const { audit } = await import("@/lib/audit");
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: true });

    expect(entrarAvulso).toHaveBeenCalledWith({ email: USUARIO.email, password: ATUAL });
    expect(sairAvulso).toHaveBeenCalledWith({ scope: "local" });
    expect(trocarNaSessao).toHaveBeenCalledWith({ password: NOVA });
    expect(atualizarConta).toHaveBeenCalledWith(USUARIO.id, {
      app_metadata: { senha_definida_por_admin: null },
    });

    const auditorias = JSON.stringify(vi.mocked(audit).mock.calls);
    expect(auditorias).toContain("profile.password_changed");
    expect(auditorias).not.toContain(ATUAL);
    expect(auditorias).not.toContain(NOVA);
  });

  it("sem marca, não mexe na conta pela chave de serviço", async () => {
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: true });
    expect(atualizarConta).not.toHaveBeenCalled();
  });

  it("o provedor recusando a senha nova vira um motivo legível", async () => {
    trocarNaSessao.mockResolvedValueOnce({ data: {}, error: { code: "weak_password", message: "weak" } });
    const r = await trocar({ senha_atual: ATUAL, nova: NOVA, confirmacao: NOVA });
    expect(r).toEqual({ ok: false, error: "senha_recusada" });
  });
});
