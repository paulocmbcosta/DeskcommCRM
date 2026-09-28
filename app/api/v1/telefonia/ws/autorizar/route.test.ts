/**
 * O PORTEIRO DO WEBSOCKET DO RAMAL — que autoriza sem nunca renovar a sessão.
 *
 * Até a revisão de segurança de 2026-09-28, o Caddy e o Traefik entregavam
 * `/telefonia/ws` direto ao Asterisk: qualquer anônimo da internet abria um
 * WebSocket SIP com o PABX. Agora o proxy pergunta a esta rota antes, e só um
 * 2xx abre o socket. Os desfechos que importam:
 *
 *   sem cookie → 401 · sessão vencida → 401 (sem renovar)
 *   viewer → 403 · agent → 204 · outro site → 403
 *
 * A resposta desta rota volta para o PROXY, que descarta `Set-Cookie`. Uma
 * renovação aqui trocaria o refresh token no GoTrue e perderia o novo — o
 * reúso do velho revogaria a sessão do atendente. Por isso os casos espiam o
 * dublê do cliente (nenhum `getSession`/`refreshSession`) e os dois caminhos
 * que carregam a sessão do cookie (`requireRole` e o cliente de
 * `lib/supabase/server`), que não podem nem ser chamados.
 *
 * A autorização roda DE VERDADE (`lib/auth/sessao-sem-renovar.ts`); o único
 * dublê é o cliente do Supabase, que devolve o papel do cenário pela mesma
 * função do banco que `requireRole` consulta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createChunks, stringToBase64URL } from "@supabase/ssr";

import type * as SupabaseJs from "@supabase/supabase-js";

import type * as ServidorSupabase from "@/lib/supabase/server";

const cenario = vi.hoisted(() => ({
  papel: "agent" as string | null,
  getUser: [] as Array<string | undefined>,
  getSession: 0,
  refreshSession: 0,
  requireRole: 0,
  clienteDeSessao: 0,
}));

vi.mock("@supabase/supabase-js", async (original) => ({
  ...(await original<typeof SupabaseJs>()),
  createClient: vi.fn(() => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
    q.then = (ok: (x: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: [{ organization_id: "22222222-2222-4222-8222-222222222222", role: "agent", accepted_at: null, organizations: null }],
        error: null,
      }).then(ok, erro);
    return {
      auth: {
        getUser: async (jwt?: string) => {
          cenario.getUser.push(jwt);
          return { data: { user: { id: "11111111-1111-4111-8111-111111111111", factors: [] } }, error: null };
        },
        getSession: async () => {
          cenario.getSession += 1;
          return { data: { session: null }, error: null };
        },
        refreshSession: async () => {
          cenario.refreshSession += 1;
          return { data: { session: null }, error: null };
        },
      },
      from: () => q,
      rpc: async (nome: string) =>
        nome === "fn_user_role_in_org" ? { data: cenario.papel, error: null } : { data: null, error: null },
    };
  }),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => {
    cenario.requireRole += 1;
    throw new Error("requireRole carrega a sessão do cookie — e a renovaria");
  }),
}));

vi.mock("@/lib/supabase/server", async (original) => ({
  ...(await original<typeof ServidorSupabase>()),
  createClient: vi.fn(async () => {
    cenario.clienteDeSessao += 1;
    throw new Error("o cliente de SESSÃO do cookie não pode ser usado aqui");
  }),
}));

import { NOME_DO_COOKIE_DE_SESSAO } from "@/lib/supabase/server";

import { GET } from "./route";

const HOST = "crm.cliente.com.br";
const b64 = (o: unknown) => stringToBase64URL(JSON.stringify(o));
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ sub: "u", aal: "aal1" })}.assinatura`;

/** O cookie de sessão como o `@supabase/ssr` o grava, vencendo em `ms`. */
function cookieDeSessao(ms: number): string {
  const sessao = { access_token: TOKEN, expires_at: Math.floor((Date.now() + ms) / 1000), refresh_token: "r" };
  return createChunks(NOME_DO_COOKIE_DE_SESSAO, `base64-${b64(sessao)}`)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function pedido(headers: Record<string, string> = {}) {
  return new NextRequest(`https://${HOST}/api/v1/telefonia/ws/autorizar`, { headers: { host: HOST, ...headers } });
}

const comSessao = (ms = 3_000_000, extra: Record<string, string> = {}) =>
  pedido({ origin: `https://${HOST}`, cookie: cookieDeSessao(ms), ...extra });

beforeEach(() => {
  cenario.papel = "agent";
  cenario.getUser = [];
  cenario.getSession = 0;
  cenario.refreshSession = 0;
  cenario.requireRole = 0;
  cenario.clienteDeSessao = 0;
});

/** Nada que carregue a sessão do cookie — e portanto nada que a renove — rodou. */
function nadaRenovou() {
  expect(cenario.getSession).toBe(0);
  expect(cenario.refreshSession).toBe(0);
  expect(cenario.requireRole).toBe(0);
  expect(cenario.clienteDeSessao).toBe(0);
}

describe("GET /api/v1/telefonia/ws/autorizar", () => {
  it("sem cookie → 401", async () => {
    const r = await GET(pedido({ origin: `https://${HOST}` }));
    expect(r.status).toBe(401);
    nadaRenovou();
  });

  it("sessão vencida → 401, sem renovar — nem o GoTrue foi consultado", async () => {
    const r = await GET(comSessao(-5_000));
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("session_expired");
    expect(cenario.getUser).toEqual([]);
    nadaRenovou();
  });

  it("agent com sessão folgada → 204 sem corpo; o token foi validado por getUser(token)", async () => {
    const r = await GET(comSessao());
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(cenario.getUser).toEqual([TOKEN]);
    nadaRenovou();
  });

  it.each(["manager", "admin"])("%s → 204", async (papel) => {
    cenario.papel = papel;
    expect((await GET(comSessao())).status).toBe(204);
  });

  it("viewer → 403 (o piso é agent, o mesmo de quem recebe a credencial do ramal)", async () => {
    cenario.papel = "viewer";
    const r = await GET(comSessao());
    expect(r.status).toBe(403);
    nadaRenovou();
  });

  it("agent sem Origin (cliente que não é navegador) → 204", async () => {
    const r = await GET(pedido({ cookie: cookieDeSessao(3_000_000) }));
    expect(r.status).toBe(204);
  });

  it("atrás do proxy vale o host encaminhado", async () => {
    const r = await GET(comSessao(3_000_000, { host: "app:3000", "x-forwarded-host": HOST }));
    expect(r.status).toBe(204);
  });

  it.each([
    ["outro site", "https://evil.example"],
    ["subdomínio parecido", `https://${HOST}.evil.example`],
    ["mesmo host, outra porta", `https://${HOST}:8443`],
    ["origem opaca", "null"],
  ])("agent com Origin de %s → 403, sem nem consultar a sessão", async (_caso, origin) => {
    const r = await GET(comSessao(3_000_000, { origin }));
    expect(r.status).toBe(403);
    // A sessão do atendente é VÁLIDA neste caso — é justamente o WebSocket
    // cross-site: a página de fora abre o socket e o navegador manda o cookie.
    expect(cenario.getUser).toEqual([]);
  });
});
