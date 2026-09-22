/**
 * POST /api/v1/team/members — o administrador cadastra o membro JÁ COM SENHA.
 *
 * Por que existe: a única porta de entrada na equipe era o convite por e-mail,
 * e numa instalação sem e-mail configurado (toda VPS recém-instalada, e a
 * produção do dono em 2026-09-22) o convite vira um link copiado de uma tela
 * marcada "(DEV)". O pedido foi literal: "eu já cadastrasse a senha dele aqui
 * dentro e já ficasse tudo resolvido".
 *
 * Mede, contra o Route Handler REAL (sessão, papel e provedor de auth
 * simulados; tabelas num banco em memória que APLICA os filtros):
 *
 *  - quem não é admin não cadastra, e o provedor de auth nem é chamado;
 *  - e-mail que já é membro ativo é recusado ANTES de criar conta;
 *  - e-mail que já tem conta NÃO tem a senha trocada — a conta pode ser de
 *    outra organização da instalação, e trocar a senha seria entrar no lugar
 *    de alguém de fora;
 *  - a organização vem do cookie, nunca do body;
 *  - o vínculo nasce pela mesma função do aceite de convite;
 *  - o convite pendente do mesmo e-mail é fechado;
 *  - se o vínculo falha, a conta recém-criada é apagada (sem órfã);
 *  - a senha não aparece em auditoria nem na resposta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";
import { BancoEmMemoria } from "./helpers/banco-em-memoria";

let serviceRole = true;

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => serviceRole,
  hashEmail: (e: string) => e,
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const MEMBRO_ANTIGO = "33333333-3333-4333-8333-333333333333";
const NOVO_ID = "55555555-5555-4555-8555-555555555555";
const SENHA = "Senha-Forte-123";

interface ErroDeAuth {
  code?: string;
  status?: number;
  message: string;
}

interface Provedor {
  contas: Map<string, { id: string; email: string }>;
  criadas: Array<Record<string, unknown>>;
  apagadas: string[];
  senhasTrocadas: string[];
  erroAoCriar: ErroDeAuth | null;
}

let banco: BancoEmMemoria;
let provedor: Provedor;
let erroNoVinculo: { code: string; message: string } | null;
/** Tabela cuja LEITURA responde erro — o banco sob swap, que não é hipotético. */
let leituraFalhaEm: string | null;

function cadeiaQueFalha() {
  const resposta = { data: null, error: { message: "canceling statement due to statement timeout" } };
  const c: Record<string, unknown> = {};
  for (const m of ["eq", "is", "in", "select"]) c[m] = () => c;
  c.maybeSingle = async () => resposta;
  c.then = (r: (v: unknown) => unknown) => Promise.resolve(resposta).then(r);
  return c;
}

function montarAdmin() {
  const cliente = banco.cliente;
  return {
    ...cliente,
    from: (tabela: string) =>
      tabela === leituraFalhaEm
        ? { ...cliente.from(tabela), select: () => cadeiaQueFalha() }
        : cliente.from(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      banco.rpcs.push({ nome, args });
      if (nome !== "fn_accept_team_invite") throw new Error(`rpc inesperada ${nome}`);
      if (erroNoVinculo) return { data: null, error: erroNoVinculo };
      // O efeito da função real que importa aqui: grava o vínculo e, quando o
      // papel é admin, tira o criador PROVISÓRIO (migration 0237).
      const id = banco.proximoId("vinculo");
      banco.semear("user_organizations", {
        id,
        organization_id: args.p_org,
        user_id: args.p_user,
        role: args.p_role,
        revoked_at: null,
        accepted_at: new Date().toISOString(),
        provisional_until_handover: false,
      });
      if (args.p_role === "admin") {
        const linhas = banco.linhas("user_organizations");
        for (let i = linhas.length - 1; i >= 0; i--) {
          const l = linhas[i]!;
          if (l.organization_id === args.p_org && l.provisional_until_handover && l.user_id !== args.p_user)
            linhas.splice(i, 1);
        }
      }
      return { data: { id, changed: true }, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const conta = [...provedor.contas.values()].find((c) => c.id === id);
          return { data: { user: conta ?? null }, error: null };
        },
        createUser: async (attrs: Record<string, unknown>) => {
          provedor.criadas.push(attrs);
          if (provedor.erroAoCriar) return { data: { user: null }, error: provedor.erroAoCriar };
          const email = String(attrs.email);
          if (provedor.contas.has(email))
            return {
              data: { user: null },
              error: { code: "email_exists", status: 422, message: "A user with this email address has already been registered" },
            };
          const conta = { id: NOVO_ID, email };
          provedor.contas.set(email, conta);
          return { data: { user: conta }, error: null };
        },
        deleteUser: async (id: string) => {
          provedor.apagadas.push(id);
          return { data: { user: null }, error: null };
        },
        updateUserById: async (id: string) => {
          provedor.senhasTrocadas.push(id);
          return { data: { user: null }, error: null };
        },
      },
    },
  };
}

function sessao(papel: "admin" | "agent" = "admin", opcoes: { suporte?: boolean } = {}) {
  const user: AuthUser = {
    id: ADMIN_ID,
    email: "admin@example.com",
    full_name: "Admin",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: papel }],
    ...(opcoes.suporte
      ? {
          support: {
            organization_id: ORG_ID,
            status: "active",
            access_mode: "full",
            name: "Org",
          } as unknown as AuthUser["support"],
        }
      : {}),
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: papel });
  vi.mocked(createClient).mockResolvedValue({
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: papel, error: null } : { data: null, error: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(montarAdmin() as any);
}

function pedido(body: Record<string, unknown>, contentType = "application/json") {
  return new NextRequest("http://localhost/api/v1/team/members", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

const corpoValido = {
  full_name: "Maria Souza",
  email: "Maria@Empresa.com",
  password: SENHA,
  role: "agent",
};

async function cadastrar(body: Record<string, unknown> = corpoValido, contentType?: string) {
  const { POST } = await import("@/app/api/v1/team/members/route");
  const res = await POST(pedido(body, contentType));
  const texto = await res.text();
  return { res, texto, json: JSON.parse(texto) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceRole = true;
  erroNoVinculo = null;
  leituraFalhaEm = null;
  banco = new BancoEmMemoria();
  banco.semear("user_organizations", {
    id: "vinculo-admin",
    organization_id: ORG_ID,
    user_id: ADMIN_ID,
    role: "admin",
    revoked_at: null,
    provisional_until_handover: false,
  });
  provedor = {
    contas: new Map([["admin@example.com", { id: ADMIN_ID, email: "admin@example.com" }]]),
    criadas: [],
    apagadas: [],
    senhasTrocadas: [],
    erroAoCriar: null,
  };
});

describe("POST /api/v1/team/members — quem pode", () => {
  it("quem não é admin leva 403 e o provedor de auth nem é chamado", async () => {
    sessao("agent");
    const { res } = await cadastrar();
    expect(res.status).toBe(403);
    expect(provedor.criadas).toHaveLength(0);
  });

  it("sem service role responde 503 dizendo o que falta, sem tentar criar conta", async () => {
    serviceRole = false;
    sessao();
    const { res, json } = await cadastrar();
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("unavailable");
    expect(provedor.criadas).toHaveLength(0);
  });

  it("corpo que não é JSON leva 415 — um formulário de outro site não chega aqui", async () => {
    // `request.json()` aceita `text/plain`, que um <form> de outro site manda
    // sem preflight. Exigir JSON obriga o preflight de CORS, que o servidor não
    // concede. Esta é a primeira rota em que um CSRF às cegas entregaria uma
    // credencial que o atacante conhece.
    sessao();
    const { res } = await cadastrar(corpoValido, "text/plain");
    expect(res.status).toBe(415);
    expect(provedor.criadas).toHaveLength(0);
  });

  it("acompanhamento (suporte) não cria credencial — nem em acesso total", async () => {
    // Uma sessão de acompanhamento tem prazo; uma conta com senha conhecida
    // não. Criar uma daqui transformaria acesso temporário em permanente.
    sessao("admin", { suporte: true });
    const { res } = await cadastrar();
    expect(res.status).toBe(403);
    expect(provedor.criadas).toHaveLength(0);
  });

  it("senha com menos de 8 caracteres é recusada na validação", async () => {
    sessao();
    const { res, json } = await cadastrar({ ...corpoValido, password: "1234567" });
    expect(res.status).toBe(422);
    expect(json.error.code).toBe("validation_error");
    expect(provedor.criadas).toHaveLength(0);
  });
});

describe("POST /api/v1/team/members — contas que já existem", () => {
  it("e-mail de membro ATIVO é recusado antes de criar conta (sem diferenciar maiúsculas)", async () => {
    provedor.contas.set("maria@empresa.com", { id: MEMBRO_ANTIGO, email: "maria@empresa.com" });
    banco.semear("user_organizations", {
      id: "vinculo-maria",
      organization_id: ORG_ID,
      user_id: MEMBRO_ANTIGO,
      role: "agent",
      revoked_at: null,
    });
    sessao();
    const { res, json } = await cadastrar();
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("state_conflict");
    expect(json.error.details.motivo).toBe("ja_membro");
    expect(provedor.criadas).toHaveLength(0);
  });

  it("e-mail que já tem conta NÃO tem a senha trocada — recusa e aponta os caminhos", async () => {
    // Conta de outra organização da mesma instalação: trocar a senha dela
    // daria a este admin a conta de alguém de fora.
    provedor.contas.set("maria@empresa.com", { id: MEMBRO_ANTIGO, email: "maria@empresa.com" });
    banco.semear("user_organizations", {
      id: "vinculo-fora",
      organization_id: OUTRA_ORG,
      user_id: MEMBRO_ANTIGO,
      role: "admin",
      revoked_at: null,
    });
    sessao();
    const { res, json } = await cadastrar();
    expect(res.status).toBe(409);
    expect(json.error.details.motivo).toBe("conta_existente");
    expect(json.error.message).toMatch(/convite/i);
    expect(provedor.senhasTrocadas).toHaveLength(0);
    expect(banco.rpcs).toHaveLength(0);
  });

  it("senha recusada pelo provedor vira 422 com mensagem legível, sem vínculo", async () => {
    provedor.erroAoCriar = { code: "weak_password", status: 422, message: "Password is known to be weak" };
    sessao();
    const { res, json } = await cadastrar();
    expect(res.status).toBe(422);
    expect(json.error.message).toMatch(/senha/i);
    expect(banco.rpcs).toHaveLength(0);
  });
});

describe("POST /api/v1/team/members — o banco falhando fecha a porta", () => {
  it("se a leitura dos membros falha, NÃO cria conta (a checagem não pode passar por omissão)", async () => {
    leituraFalhaEm = "user_organizations";
    sessao();
    const { res } = await cadastrar();
    expect(res.status).toBe(500);
    expect(provedor.criadas).toHaveLength(0);
  });

  it("e-mail recusado pelo provedor vira 422 legível, não 500", async () => {
    provedor.erroAoCriar = { code: "email_address_invalid", status: 400, message: "Email address is invalid" };
    sessao();
    const { res, json } = await cadastrar();
    expect(res.status).toBe(422);
    expect(json.error.message).toMatch(/e-mail/i);
  });
});

describe("POST /api/v1/team/members — o cadastro", () => {
  it("cria a conta confirmada, vincula pela função do aceite com a org do COOKIE e audita sem a senha", async () => {
    sessao();
    const { res, json, texto } = await cadastrar({ ...corpoValido, organization_id: OUTRA_ORG });
    expect(res.status).toBe(201);

    expect(provedor.criadas).toHaveLength(1);
    expect(provedor.criadas[0]).toMatchObject({
      email: "maria@empresa.com",
      password: SENHA,
      email_confirm: true,
      user_metadata: { full_name: "Maria Souza" },
      // A MARCA: esta senha foi escolhida por quem administra esta org. É o
      // que impede o admin de entrar em OUTRA organização como esta pessoa
      // (ver `lib/auth/aplicar-convite.ts`). `app_metadata`, e não
      // `user_metadata`, porque só a chave de serviço escreve ali.
      app_metadata: { senha_definida_por_admin: { organization_id: ORG_ID } },
    });

    expect(banco.rpcs).toHaveLength(1);
    expect(banco.rpcs[0]!.nome).toBe("fn_accept_team_invite");
    expect(banco.rpcs[0]!.args).toMatchObject({
      p_user: NOVO_ID,
      p_org: ORG_ID,
      p_role: "agent",
      p_invited_by: ADMIN_ID,
    });

    expect(json.data).toMatchObject({
      user_id: NOVO_ID,
      email: "maria@empresa.com",
      full_name: "Maria Souza",
      role: "agent",
    });
    expect(String(json.data.login_url)).toMatch(/\/login$/);
    expect(texto).not.toContain(SENHA);

    const auditorias = vi.mocked(audit).mock.calls.map(([e]) => e);
    const criado = auditorias.find((e) => e.action === "member.created");
    expect(criado).toMatchObject({
      actorUserId: ADMIN_ID,
      organizationId: ORG_ID,
      resourceType: "membership",
      metadata: { target_user_id: NOVO_ID, role: "agent" },
    });
    expect(JSON.stringify(auditorias)).not.toContain(SENHA);
  });

  it("fecha o convite PENDENTE do mesmo e-mail nesta org — e só ele", async () => {
    banco.semear(
      "team_invites",
      { id: "conv-pendente", organization_id: ORG_ID, email: "maria@empresa.com", accepted_at: null, revoked_at: null },
      { id: "conv-outra-org", organization_id: OUTRA_ORG, email: "maria@empresa.com", accepted_at: null, revoked_at: null },
      { id: "conv-outro-email", organization_id: ORG_ID, email: "joao@empresa.com", accepted_at: null, revoked_at: null },
    );
    sessao();
    const { res } = await cadastrar();
    expect(res.status).toBe(201);
    const convites = new Map(banco.linhas("team_invites").map((l) => [l.id, l]));
    expect(convites.get("conv-pendente")).toMatchObject({ accepted_by: NOVO_ID });
    expect(convites.get("conv-pendente")?.accepted_at).toBeTruthy();
    expect(convites.get("conv-outra-org")?.accepted_at).toBeNull();
    expect(convites.get("conv-outro-email")?.accepted_at).toBeNull();
  });

  it("se o vínculo falha, apaga a conta recém-criada — sem órfã que travaria o recadastro", async () => {
    erroNoVinculo = { code: "XX000", message: "boom" };
    sessao();
    const { res } = await cadastrar();
    expect(res.status).toBe(500);
    expect(provedor.apagadas).toEqual([NOVO_ID]);
  });

  it("criador PROVISÓRIO não cadastra ADMIN com senha — a entrega ao dono é por convite", async () => {
    // Quem abriu a organização para outra pessoa sai dela quando o dono entra
    // (migration 0237). Se o provisório escolhesse a senha do dono, sairia
    // sabendo como entrar como ele — a entrega seria de fachada.
    banco.linhas("user_organizations")[0]!.provisional_until_handover = true;
    sessao();
    const { res, json } = await cadastrar({ ...corpoValido, role: "admin" });
    expect(res.status).toBe(409);
    expect(json.error.details.motivo).toBe("entrega_por_convite");
    expect(json.error.message).toMatch(/convite/i);
    expect(provedor.criadas).toHaveLength(0);
  });

  it("o mesmo provisório cadastra um AGENTE normalmente — o par de controle", async () => {
    banco.linhas("user_organizations")[0]!.provisional_until_handover = true;
    sessao();
    const { res } = await cadastrar();
    expect(res.status).toBe(201);
  });
});
