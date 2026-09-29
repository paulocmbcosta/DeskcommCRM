/**
 * O ATENDENTE GANHA RAMAL — quem recebe ligação pelo navegador é decidido pelo
 * papel de verdade, dentro do `AuthProvider` de verdade.
 *
 * Medido em produção (2026-09-29): o provider perguntava `usePermission("agent")`.
 * Só que `usePermission` recebe o nome de uma AÇÃO de `ACTION_MIN_ROLE`, e
 * `"agent"` é nome de papel — a busca devolvia `undefined`, e `undefined` é
 * `false` para todo mundo, menos para o administrador da plataforma (que passa
 * pela primeira linha da função sem olhar a tabela). Em 48 h só o dono recebeu
 * ramal: o navegador do atendente nunca pedia `POST /api/v1/telefonia/ramal`, o
 * telefone não aparecia no topo, o Asterisk não tinha o ramal dele, e a URA
 * dizia ao cliente que não havia ninguém disponível.
 *
 * Os testes vizinhos (`TelefoniaContext.aviso.test.tsx`) trocam o
 * `usePermission` por `() => true` — e por isso nunca viram o defeito. Este
 * monta o `AuthProvider` real e mede o EFEITO: o pedido do ramal aconteceu, e o
 * botão do telefone apareceu na tela.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// O AuthProvider real renderiza `<Providers>` (react-query, tema…) e instancia o
// client do browser. Nada disso participa da decisão que está sob teste.
vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));

vi.mock("jssip", () => {
  type Ouvinte = (ev?: unknown) => void;
  class UA {
    private ouvintes = new Map<string, Ouvinte[]>();
    on(nome: string, fn: Ouvinte) {
      this.ouvintes.set(nome, [...(this.ouvintes.get(nome) ?? []), fn]);
    }
    start() {
      queueMicrotask(() => {
        for (const fn of this.ouvintes.get("registered") ?? []) fn();
      });
    }
    stop() {}
    register() {}
  }
  class WebSocketInterface {}
  return { default: { UA, WebSocketInterface }, UA, WebSocketInterface };
});

const espiao = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: espiao.post, get: espiao.get } }));

import { AuthProvider, type usePermission } from "@/hooks/auth/AuthProvider";
import type { ActiveOrg, AuthUser, Role } from "@/lib/auth/types";

import { BotaoDoTelefone } from "./BotaoDoTelefone";
import { TelefoniaProvider } from "./TelefoniaContext";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";

function usuario(extra: Partial<AuthUser> = {}): AuthUser {
  return {
    id: EU,
    email: "atendente@exemplo.com",
    full_name: "Atendente de Teste",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
    ...extra,
  } as AuthUser;
}

function suporte(access_mode: "full" | "support_readonly"): NonNullable<AuthUser["support"]> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    actor_user_id: EU,
    auth_session_id: "44444444-4444-4444-8444-444444444444",
    previous_organization_id: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    name: "Org observada",
    locale: null,
    access_mode,
    status: "active",
  };
}

function org(role: Role): ActiveOrg {
  return { orgId: ORG, name: "Org de teste", role };
}

function montar(user: AuthUser, activeOrg: ActiveOrg | null) {
  return render(
    <AuthProvider user={user} activeOrg={activeOrg}>
      <TelefoniaProvider>
        <BotaoDoTelefone />
      </TelefoniaProvider>
    </AuthProvider>,
  );
}

function pedidosDeRamal(): number {
  return espiao.post.mock.calls.filter((c) => c[0] === "/api/v1/telefonia/ramal").length;
}

/** O efeito de boot roda no primeiro commit: se fosse pedir, já teria pedido. */
async function naoPediuRamal() {
  await new Promise((r) => setTimeout(r, 50));
  expect(pedidosDeRamal()).toBe(0);
  expect(screen.queryByRole("button", { name: /Telefone/ })).toBeNull();
}

async function pediuRamalEMostrouOTelefone() {
  await waitFor(() => expect(pedidosDeRamal()).toBe(1));
  expect(espiao.post).toHaveBeenCalledWith("/api/v1/telefonia/ramal", {});
  // O ramal registrou (JsSIP de mentira) e o telefone do topo ficou verde.
  expect(await screen.findByRole("button", { name: "Telefone pronto" })).toHaveAttribute(
    "data-telefonia-botao",
    "pronto",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  espiao.post.mockImplementation(async (url: string) => {
    if (url === "/api/v1/telefonia/ramal") {
      return {
        data: {
          ativo: true,
          usuario: `ramal-${EU}`,
          senha: "s",
          ws_url: "wss://x/telefonia/ws",
          numeros: [{ id: "n1", nome: "Recepção", numero: "556136861503", conectado: true }],
        },
      };
    }
    throw new Error(`POST inesperado ${url}`);
  });
});
afterEach(() => cleanup());

describe("quem recebe ramal no navegador", () => {
  it("atendente (papel agent, sem ser administrador da plataforma) pede o ramal e vê o telefone", async () => {
    montar(usuario(), org("agent"));
    await pediuRamalEMostrouOTelefone();
  });

  it.each<Role>(["manager", "admin"])("%s também pede o ramal", async (papel) => {
    montar(usuario(), org(papel));
    await pediuRamalEMostrouOTelefone();
  });

  it("somente-leitura da organização (viewer) não pede ramal nem vê telefone", async () => {
    montar(usuario(), org("viewer"));
    await naoPediuRamal();
  });

  it("administrador da plataforma fora de acompanhamento pede o ramal", async () => {
    montar(usuario({ is_platform_admin: true }), org("admin"));
    await pediuRamalEMostrouOTelefone();
  });

  it("administrador da plataforma em acompanhamento somente-leitura não pede ramal", async () => {
    // `resolveActiveOrg` rebaixa o acompanhamento somente-leitura a `viewer`, e o
    // bypass do platform admin exige `!user.support` — as duas coisas juntas.
    montar(usuario({ is_platform_admin: true, support: suporte("support_readonly") }), org("viewer"));
    await naoPediuRamal();
  });

  it("acompanhamento com acesso total segue o servidor: vira admin e pede o ramal", async () => {
    // Espelho da rota: `requireSupportWrite` só barra o somente-leitura, e
    // `fn_user_role_in_org` resolve `full` como `admin`. O navegador não inventa
    // uma regra que o servidor não tem — se um dia o servidor negar, o 403 cai
    // no `.catch` do provider e o telefone simplesmente não aparece.
    montar(usuario({ is_platform_admin: true, support: suporte("full") }), org("admin"));
    await pediuRamalEMostrouOTelefone();
  });

  it("sem organização ativa, o atendente não pede ramal", async () => {
    montar(usuario(), null);
    await naoPediuRamal();
  });
});

describe("o gate de permissão só aceita AÇÃO", () => {
  it("nenhum nome de papel é aceito como ação pelo tipo de usePermission", () => {
    // Guarda de TIPO, medida pelo `pnpm typecheck` (que inclui os testes): se o
    // parâmetro voltar a ser `string`, `Extract<Role, string>` deixa de ser
    // `never`, o tipo abaixo vira `false` e a atribuição de `true` não compila.
    type ParametroDoGate = Parameters<typeof usePermission>[0];
    const nenhumPapelEAcao: [Extract<Role, ParametroDoGate>] extends [never] ? true : false = true;
    expect(nenhumPapelEAcao).toBe(true);
  });
});
