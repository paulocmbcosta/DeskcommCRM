// @vitest-environment node
/**
 * O POST DO NÚMERO COM DESTINO (fase 2): a gravação recebe a organização da
 * SESSÃO; o número pode nascer apontando para um menu; a auditoria da criação
 * leva o destino (time e menu) e nunca a senha SIP; a trava ocupada é 409.
 *
 * E o `Idempotency-Key` (CLAUDE.md, spec 01 §7.3): a mesma chave com o mesmo
 * corpo cria UM número; com outro corpo, 409; recusa não vira recibo. A SENHA
 * SIP NÃO ENTRA NO RECIBO — nem na resposta guardada, nem no hash do corpo: o
 * hash é um sha256 SEM sal de um JSON cujos outros campos a tela mostra
 * (servidor, usuário, número), e o recibo é legível pela organização; com a
 * senha dentro, ela sairia dali por força bruta offline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloNumeros from "@/lib/channels/telefonia/numeros";

const ORG = "22222222-2222-4222-8222-222222222222";
const NUMERO = "33333333-3333-4333-8333-333333333333";
const MENU = "55555555-5555-4555-8555-555555555555";
const SENHA = "senha-sip-de-teste-nao-real";
const POOL = vi.hoisted(() => ({ marca: "pool-da-rota" }));
const estado = vi.hoisted(() => ({ resultado: null as unknown }));
const h = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => POOL) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => null) }));
vi.mock("@/lib/channels/telefonia/empurrar", () => ({ empurrarTroncoAgora: vi.fn(async () => undefined) }));
// O cliente com sessão só serve ao recibo de idempotência (a policy `idempotency_tenant` cobre a org).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: h.from })) }));
vi.mock("@/lib/channels/telefonia/numeros", async () => ({
  ...(await vi.importActual<typeof ModuloNumeros>("@/lib/channels/telefonia/numeros")),
  criarNumero: vi.fn(async () => estado.resultado),
  numerosDaOrg: vi.fn(async () => [{ id: "33333333-3333-4333-8333-333333333333", nome: "Recepção" }]),
}));

import { hashDoCorpo } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { criarNumero, numeroSchema } from "@/lib/channels/telefonia/numeros";
import { empurrarTroncoAgora } from "@/lib/channels/telefonia/empurrar";

import { POST } from "./route";

const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Recepção",
  numero: "(61) 3686-1503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  senha: SENHA,
  time_id: null,
  ...extra,
});
const post = (c: unknown, chave?: string) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/numeros", {
      method: "POST",
      headers: { "content-type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
      body: JSON.stringify(c),
    }),
  );

/** Os recibos de `idempotency_keys`, na mesma cadeia que o helper usa (como no POST de menus). */
function recibos() {
  const gravados: Array<Record<string, unknown>> = [];
  h.from.mockImplementation(() => {
    let filtros: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      gt: () => builder,
      maybeSingle: async () => {
        const achado = gravados.find((r) => filtros.every(([c, v]) => r[c] === v)) ?? null;
        filtros = [];
        return { data: achado, error: null };
      },
      insert: async (linha: Record<string, unknown>) => {
        gravados.push(linha);
        return { error: null };
      },
    };
    return builder;
  });
  return gravados;
}
const CHAVE = "88888888-8888-4888-8888-888888888888";

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(criarNumero).mockClear();
  vi.mocked(empurrarTroncoAgora).mockClear();
  h.from.mockReset();
  estado.resultado = { ok: true, id: NUMERO };
});

describe("POST /api/v1/telefonia/numeros — nascer apontando para um menu", () => {
  it("a gravação recebe a organização da SESSÃO e o menu do corpo; a auditoria leva o destino e não a senha", async () => {
    const r = await post(corpo({ menu_id: MENU }));

    expect(r.status).toBe(201);
    const [pool, org, entrada] = vi.mocked(criarNumero).mock.calls[0]!;
    expect([pool, org, entrada.menu_id]).toEqual([POOL, ORG, MENU]);
    const [a] = vi.mocked(audit).mock.calls[0]!;
    expect(a.action).toBe("channel.phone_trunk_created");
    expect(a.metadata).toMatchObject({ time_id: null, menu_id: MENU });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(SENHA);
  });

  it("sem menu no corpo, a auditoria registra menu nulo", async () => {
    await post(corpo());
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ menu_id: null });
  });

  it.each([
    ["menu_com_fala_pendente", 422],
    ["gravacao_em_andamento", 409],
  ] as const)("recusa %s → %i, sem auditoria", async (motivo, status) => {
    estado.resultado = { ok: false, motivo };
    const r = await post(corpo({ menu_id: MENU }));
    expect(r.status).toBe(status);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/telefonia/numeros — Idempotency-Key", () => {
  it("sem a chave, nenhum recibo (o comportamento de antes)", async () => {
    const gravados = recibos();
    expect((await post(corpo())).status).toBe(201);
    expect(gravados).toHaveLength(0);
  });

  it("a mesma chave e o mesmo corpo duas vezes: UM número criado, a mesma resposta, uma auditoria, um empurrão", async () => {
    const gravados = recibos();
    const primeira = await post(corpo(), CHAVE);
    const segunda = await post(corpo(), CHAVE);

    expect([primeira.status, segunda.status]).toEqual([201, 201]);
    expect(criarNumero).toHaveBeenCalledTimes(1);
    expect(await segunda.json()).toEqual(await primeira.json());
    expect(vi.mocked(audit).mock.calls.map(([a]) => a.action)).toEqual(["channel.phone_trunk_created"]);
    expect(empurrarTroncoAgora).toHaveBeenCalledTimes(1);
    expect(gravados).toHaveLength(1);
    expect(gravados[0]).toMatchObject({ organization_id: ORG, key: CHAVE, endpoint: "/api/v1/telefonia/numeros", status_code: 201 });
  });

  it("a mesma chave com OUTRO corpo: 409 idempotency_conflict, sem criar de novo", async () => {
    recibos();
    await post(corpo(), CHAVE);
    const conflito = await post(corpo({ nome: "Outro nome" }), CHAVE);
    expect(conflito.status).toBe(409);
    expect(((await conflito.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
    expect(criarNumero).toHaveBeenCalledTimes(1);
  });

  it("recusa não vira recibo: a mesma chave tenta de novo depois, e cria", async () => {
    const gravados = recibos();
    estado.resultado = { ok: false, motivo: "menu_com_fala_pendente" };
    expect((await post(corpo({ menu_id: MENU }), CHAVE)).status).toBe(422);
    expect(gravados).toHaveLength(0);

    estado.resultado = { ok: true, id: NUMERO };
    expect((await post(corpo({ menu_id: MENU }), CHAVE)).status).toBe(201);
    expect(criarNumero).toHaveBeenCalledTimes(2);
    expect(gravados).toHaveLength(1);
  });

  it("chave que não é UUID: 400 antes de qualquer efeito, e sem recibo", async () => {
    const gravados = recibos();
    expect((await post(corpo(), "nao-e-uuid")).status).toBe(400);
    expect(criarNumero).not.toHaveBeenCalled();
    expect(gravados).toHaveLength(0);
  });

  it("a senha SIP não entra no recibo: nem na resposta guardada, nem no hash — o hash é o do corpo SEM ela", async () => {
    const gravados = recibos();
    await post(corpo({ menu_id: MENU }), CHAVE);

    expect(JSON.stringify(gravados)).not.toContain(SENHA);
    const { senha: _senha, ...semSenha } = numeroSchema.parse(corpo({ menu_id: MENU }));
    expect(gravados[0]!.request_hash).toBe(hashDoCorpo(semSenha));
    expect(gravados[0]!.request_hash).not.toBe(hashDoCorpo(numeroSchema.parse(corpo({ menu_id: MENU }))));
  });

  it("o preço de a senha ficar fora: a mesma chave com a mesma conta e OUTRA senha é replay, sem criar de novo", async () => {
    recibos();
    await post(corpo(), CHAVE);
    const replay = await post(corpo({ senha: "outra-senha-de-teste" }), CHAVE);
    expect(replay.status).toBe(201);
    expect(criarNumero).toHaveBeenCalledTimes(1);
  });
});
