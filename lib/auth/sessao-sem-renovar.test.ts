/**
 * AUTORIZAR SEM RENOVAR — a sessão é LIDA do cookie, nunca carregada num cliente.
 *
 * O porteiro do WebSocket do ramal responde ao proxy, que joga fora o
 * `Set-Cookie`. Uma renovação ali troca o refresh token no GoTrue e perde o
 * novo; o reúso do velho revoga a sessão do atendente. O que se mede:
 *
 *  - o cookie como o `@supabase/ssr` o grava (inteiro ou em pedaços, com o
 *    prefixo `base64-`) é lido sem cliente nenhum;
 *  - sessão vencida → 401 SEM criar cliente (nada pôde renovar porque nada
 *    existiu); sessão PERTO de vencer é aceita — nada renova, o GoTrue confere;
 *  - no caminho válido, o token é validado por `getUser(token)` e o dublê
 *    prova que `getSession`/`refreshSession` nunca foram chamados — e que o
 *    cliente de sessão do cookie (`lib/supabase/server`) nem foi criado;
 *  - a regra de papel é a de `requireRole`: organização ativa pelo cookie
 *    `active_org`, papel pela função do banco, dívida de MFA, suporte recusado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChunks, stringToBase64URL } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import type * as ServidorSupabase from "@/lib/supabase/server";

const sessaoDoCookieDoServidor = vi.hoisted(() => ({ criada: 0 }));
vi.mock("@/lib/supabase/server", async (original) => ({
  ...(await original<typeof ServidorSupabase>()),
  createClient: vi.fn(async () => {
    sessaoDoCookieDoServidor.criada += 1;
    throw new Error("o cliente de SESSÃO do cookie não pode ser usado aqui");
  }),
}));

import { NOME_DO_COOKIE_DE_SESSAO } from "@/lib/supabase/server";

import { autorizarSemRenovar, sessaoDoCookie } from "./sessao-sem-renovar";

const AGORA = Date.parse("2026-09-28T15:00:00Z");
const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";

const b64 = (o: unknown) => stringToBase64URL(JSON.stringify(o));
const token = (aal: "aal1" | "aal2" = "aal1") => `${b64({ alg: "HS256" })}.${b64({ sub: USER, aal })}.assinatura`;

/** O cookie exatamente como o `@supabase/ssr` o escreve. */
function cookieDaSessao(o: { expiraEmS: number; aal?: "aal1" | "aal2"; pedaco?: number }) {
  const sessao = {
    access_token: token(o.aal),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: o.expiraEmS,
    refresh_token: "refresh-que-nao-pode-ser-usado",
  };
  return createChunks(NOME_DO_COOKIE_DE_SESSAO, `base64-${b64(sessao)}`, o.pedaco);
}

const emSegundos = (msDepoisDeAgora: number) => Math.floor((AGORA + msDepoisDeAgora) / 1000);

interface Cenario {
  papeis: Record<string, string>;
  vinculos?: Array<{ organization_id: string; role: string; accepted_at: string }>;
  fatores?: Array<{ factor_type: string; status: string }>;
  suporte?: unknown;
}

function clienteFalso(c: Cenario) {
  const espiao = {
    tokens: [] as string[],
    getUser: vi.fn(async (jwt?: string) => {
      if (!jwt) throw new Error("getUser SEM token carregaria a sessão guardada");
      espiao.tokens.push(jwt);
      return { data: { user: { id: USER, factors: c.fatores ?? [] } }, error: null };
    }),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    rpc: vi.fn(async (nome: string, args?: { p_org?: string }) => {
      if (nome === "fn_support_context") return { data: c.suporte ?? null, error: null };
      if (nome === "fn_user_role_in_org") return { data: c.papeis[args?.p_org ?? ""] ?? null, error: null };
      return { data: null, error: null };
    }),
  };
  const vinculos = c.vinculos ?? [{ organization_id: ORG_A, role: "agent", accepted_at: "2026-01-01T00:00:00Z" }];
  const cliente = {
    auth: { getUser: espiao.getUser, getSession: espiao.getSession, refreshSession: espiao.refreshSession },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
      q.then = (ok: (x: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve({ data: vinculos.map((v) => ({ ...v, organizations: null })), error: null }).then(ok, erro);
      return q;
    },
    rpc: espiao.rpc,
  };
  return { cliente: cliente as unknown as SupabaseClient, espiao };
}

function autorizar(cookies: Array<{ name: string; value: string }>, c: Cenario) {
  const { cliente, espiao } = clienteFalso(c);
  const criarCliente = vi.fn(() => cliente);
  const r = autorizarSemRenovar({ cookies, min: "agent", agora: AGORA, criarCliente });
  return { r, espiao, criarCliente };
}

beforeEach(() => {
  sessaoDoCookieDoServidor.criada = 0;
});

describe("sessaoDoCookie — lê o que o @supabase/ssr grava, sem cliente", () => {
  it("cookie inteiro com o prefixo base64-", async () => {
    const s = await sessaoDoCookie(cookieDaSessao({ expiraEmS: 1_900_000_000 }));
    expect(s).toEqual({ accessToken: token(), expiraEmMs: 1_900_000_000_000 });
  });

  it("cookie em pedaços (.0, .1, …) é juntado pela própria lib", async () => {
    const pedacos = cookieDaSessao({ expiraEmS: 1_900_000_000, pedaco: 60 });
    expect(pedacos.length).toBeGreaterThan(2);
    expect(pedacos[0]!.name).toBe(`${NOME_DO_COOKIE_DE_SESSAO}.0`);
    expect(await sessaoDoCookie(pedacos)).toEqual({ accessToken: token(), expiraEmMs: 1_900_000_000_000 });
  });

  it.each([
    ["sem cookie", []],
    ["lixo", [{ name: NOME_DO_COOKIE_DE_SESSAO, value: "base64-@@@" }]],
    ["JSON sem token", [{ name: NOME_DO_COOKIE_DE_SESSAO, value: `base64-${b64({ expires_at: 1 })}` }]],
  ])("%s → null, sem lançar", async (_caso, cookies) => {
    expect(await sessaoDoCookie(cookies)).toBeNull();
  });
});

describe("autorizarSemRenovar", () => {
  it("sem cookie → 401, e nenhum cliente foi criado", async () => {
    const { r, criarCliente } = autorizar([], { papeis: { [ORG_A]: "agent" } });
    expect(await r).toMatchObject({ ok: false, status: 401 });
    expect(criarCliente).not.toHaveBeenCalled();
  });

  it.each([
    ["vencida há 5 s", -5_000],
    ["vencida há 1 h", -3_600_000],
  ])("sessão %s → 401, sem renovar: nem cliente, nem getSession, nem refresh", async (_caso, ms) => {
    const { r, espiao, criarCliente } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(ms) }), {
      papeis: { [ORG_A]: "agent" },
    });

    expect(await r).toMatchObject({ ok: false, status: 401, code: "session_expired" });
    expect(criarCliente).not.toHaveBeenCalled();
    expect(espiao.getUser).not.toHaveBeenCalled();
    expect(espiao.getSession).not.toHaveBeenCalled();
    expect(espiao.refreshSession).not.toHaveBeenCalled();
    expect(sessaoDoCookieDoServidor.criada).toBe(0);
  });

  it("sessão a 60 s de vencer → ok: nada renova, e o GoTrue é quem confere o exp", async () => {
    const { r, espiao } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(60_000) }), {
      papeis: { [ORG_A]: "agent" },
    });

    expect(await r).toMatchObject({ ok: true, role: "agent" });
    expect(espiao.tokens).toEqual([token()]);
    expect(espiao.getSession).not.toHaveBeenCalled();
    expect(espiao.refreshSession).not.toHaveBeenCalled();
    expect(sessaoDoCookieDoServidor.criada).toBe(0);
  });

  it("token válido + agent → ok; o token é validado no GoTrue por getUser(token), e nada renova", async () => {
    const { r, espiao, criarCliente } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000) }), {
      papeis: { [ORG_A]: "agent" },
    });

    expect(await r).toEqual({ ok: true, userId: USER, orgId: ORG_A, role: "agent" });
    expect(criarCliente).toHaveBeenCalledWith(token());
    expect(espiao.tokens).toEqual([token()]);
    expect(espiao.getSession).not.toHaveBeenCalled();
    expect(espiao.refreshSession).not.toHaveBeenCalled();
    expect(sessaoDoCookieDoServidor.criada).toBe(0);
  });

  it("viewer → 403 forbidden_role", async () => {
    const { r } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000) }), { papeis: { [ORG_A]: "viewer" } });
    expect(await r).toMatchObject({ ok: false, status: 403, code: "forbidden_role" });
  });

  it("vínculo revogado entre a leitura e o papel (função devolve null) → 403", async () => {
    const { r } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000) }), { papeis: {} });
    expect(await r).toMatchObject({ ok: false, status: 403, code: "forbidden_role" });
  });

  it("a organização ativa vem do cookie active_org, como em requireRole", async () => {
    const vinculos = [
      { organization_id: ORG_A, role: "viewer", accepted_at: "2026-01-01T00:00:00Z" },
      { organization_id: ORG_B, role: "agent", accepted_at: "2026-02-01T00:00:00Z" },
    ];
    const papeis = { [ORG_A]: "viewer", [ORG_B]: "agent" };
    const sessao = cookieDaSessao({ expiraEmS: emSegundos(3_000_000) });

    const semCookie = autorizar(sessao, { papeis, vinculos });
    expect(await semCookie.r).toMatchObject({ ok: false, status: 403 });

    const comCookie = autorizar([...sessao, { name: "active_org", value: ORG_B }], { papeis, vinculos });
    expect(await comCookie.r).toMatchObject({ ok: true, orgId: ORG_B });
  });

  it("com fator TOTP verificado, sessão aal1 → 403 mfa_required; aal2 → ok", async () => {
    const fatores = [{ factor_type: "totp", status: "verified" }];
    const aal1 = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000) }), { papeis: { [ORG_A]: "agent" }, fatores });
    expect(await aal1.r).toMatchObject({ ok: false, status: 403, code: "mfa_required" });

    const aal2 = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000), aal: "aal2" }), {
      papeis: { [ORG_A]: "agent" },
      fatores,
    });
    expect(await aal2.r).toMatchObject({ ok: true });
  });

  it("acompanhamento de suporte → 403 (a credencial do ramal nunca é entregue a ele)", async () => {
    const suporte = {
      id: "44444444-4444-4444-8444-444444444444",
      organization_id: ORG_A,
      actor_user_id: USER,
      auth_session_id: "55555555-5555-4555-8555-555555555555",
      previous_organization_id: null,
      expires_at: "2026-09-28T16:00:00Z",
      name: "Org",
      locale: null,
      access_mode: "full",
      status: "active",
    };
    const { r } = autorizar(cookieDaSessao({ expiraEmS: emSegundos(3_000_000) }), { papeis: { [ORG_A]: "admin" }, suporte });
    expect(await r).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });
});
