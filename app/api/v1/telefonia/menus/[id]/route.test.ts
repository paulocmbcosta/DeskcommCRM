// @vitest-environment node
/**
 * EDITAR E ARQUIVAR UM MENU DE VOZ PELA ROTA: admin; o id do caminho é conferido
 * DEPOIS do papel; o PATCH usa o mesmo miolo do POST, com o id do menu; arquivar
 * um menu que atende um número é 409 e não audita; arquivar audita
 * `phone.menu_archived`. Nenhuma das duas vai à rede.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloMenus from "@/lib/telefonia/menus";
import type * as ModuloServico from "@/lib/telefonia/servico-de-falas";

const ORG = "22222222-2222-4222-8222-222222222222";
const TIME = "44444444-4444-4444-8444-444444444444";
const MENU = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const POOL = vi.hoisted(() => ({ marca: "pool-da-rota" }));
const estado = vi.hoisted(() => ({ resultado: null as unknown, arquivar: { ok: true } as unknown, semana: null as unknown }));

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
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("o PATCH não grava recibo de idempotência");
  }),
}));
vi.mock("@/lib/telefonia/servico-de-falas", async () => ({
  ...(await vi.importActual<typeof ModuloServico>("@/lib/telefonia/servico-de-falas")),
  armazemDaInstalacao: vi.fn(() => ({ marca: "armazem" })),
}));
vi.mock("@/lib/telefonia/menus", async () => ({
  ...(await vi.importActual<typeof ModuloMenus>("@/lib/telefonia/menus")),
  salvarMenuDaOrg: vi.fn(async () => estado.resultado),
  menusDaOrg: vi.fn(async () => [{ id: "55555555-5555-4555-8555-555555555555", nome: "Principal" }]),
  arquivarMenu: vi.fn(async () => estado.arquivar),
  semanaDoMenu: vi.fn(async () => {
    if (estado.semana instanceof Error) throw estado.semana;
    return estado.semana;
  }),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { arquivarMenu, salvarMenuDaOrg, semanaDoMenu } from "@/lib/telefonia/menus";

import { DELETE, PATCH } from "./route";

const FALA = {
  id: "66666666-6666-4666-8666-666666666666",
  tipo: "menu",
  texto: "Para Suporte, digite 1.",
  voice_id: "v1",
  hash: HASH,
  status: "ready",
  erro: null,
  duracao_ms: 1500,
  atualizada_em: "2026-09-28T13:00:00.000Z",
};
const MENU_SALVO = {
  id: MENU,
  nome: "Principal",
  time_padrao_id: TIME,
  time_padrao_nome: "Suporte",
  opcoes: [{ tecla: "1", time_id: TIME, time_nome: "Suporte" }],
  fala: FALA,
  fala_invalida: null,
  pronto: true,
  numeros: ["Recepção"],
};
const SEMANA = { total: 3, por_tecla: { "1": 2 }, sem_escolha: 1, tecla_errada: 0, desligou_no_menu: 0 };
const corpo = {
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME }],
  time_padrao_id: TIME,
  fala: { texto: "Para Suporte, digite 1.", hash: HASH },
};
const url = (id: string) => `https://crm.exemplo.com.br/api/v1/telefonia/menus/${id}`;
const patch = (id: string, c: unknown = corpo, headers: Record<string, string> = {}) =>
  PATCH(new NextRequest(url(id), { method: "PATCH", body: JSON.stringify(c), headers }), { params: Promise.resolve({ id }) });
const apagar = (id: string) => DELETE(new NextRequest(url(id), { method: "DELETE" }), { params: Promise.resolve({ id }) });
const codigo = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

const fetchContado = vi.fn(async () => new Response(null, { status: 599 }));

beforeEach(() => {
  estado.resultado = {
    ok: true,
    id: MENU,
    menu: MENU_SALVO,
    fala: { fala: FALA, mudou: false },
    falaInvalida: null,
    falaInvalidaDescartada: null,
  };
  estado.arquivar = { ok: true, falasDescartadas: [FALA.id] };
  estado.semana = SEMANA;
  vi.mocked(semanaDoMenu).mockClear();
  vi.mocked(logger.warn).mockClear();
  fetchContado.mockClear();
  vi.stubGlobal("fetch", fetchContado);
  vi.mocked(audit).mockClear();
  vi.mocked(salvarMenuDaOrg).mockClear();
  vi.mocked(arquivarMenu).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

afterEach(() => {
  expect(fetchContado).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("PATCH /api/v1/telefonia/menus/[id]", () => {
  it("edita o menu do caminho, com a organização da SESSÃO: 200 e audita (novo: false)", async () => {
    const r = await patch(MENU);
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(requireSupportWrite).toHaveBeenCalled();
    expect(vi.mocked(salvarMenuDaOrg).mock.calls[0]![0]).toMatchObject({ id: MENU, organizationId: ORG, pool: POOL });
    expect(vi.mocked(audit).mock.calls.map((c) => [c[0].action, c[0].resourceId, (c[0].metadata as { novo?: boolean } | undefined)?.novo])).toEqual([
      ["phone.menu_saved", MENU, false],
    ]);
  });

  it("suporte só acompanhando: a guarda barra PATCH e DELETE no handler, sem gravar nem arquivar", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await patch(MENU)).status).toBe(403);
    expect((await apagar(MENU)).status).toBe(403);
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
    expect(arquivarMenu).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a resposta é o menu da TRANSAÇÃO com a semana SÓ dele; a chave de idempotência não vale para editar", async () => {
    const r = await patch(MENU, corpo, { "Idempotency-Key": "88888888-8888-4888-8888-888888888888" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { menu: { ...MENU_SALVO, ultimos_7_dias: SEMANA } } });
    expect(vi.mocked(semanaDoMenu).mock.calls[0]).toEqual([POOL, ORG, MENU]);
  });

  it("a semana não pôde ser lida DEPOIS de gravar: 200 com menu null (a tela relê), nunca 500, e o aviso no log", async () => {
    estado.semana = new Error("conexão caiu");
    const r = await patch(MENU);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { menu: null } });
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).toEqual(["phone.menu_saved"]);
    expect(vi.mocked(logger.warn).mock.calls[0]![1]).toMatchObject({ organization_id: ORG, menu_id: MENU });
  });

  it("id que não é UUID: 404 depois de conferir o papel, sem gravar", async () => {
    const r = await patch("../outro");
    expect(r.status).toBe(404);
    expect(requireRole).toHaveBeenCalled();
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
  });

  it("menu de outra organização ou arquivado: 404", async () => {
    estado.resultado = { ok: false, motivo: "nao_encontrado" };
    const r = await patch(MENU);
    expect(r.status).toBe(404);
    expect(await codigo(r)).toBe("not_found");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/telefonia/menus/[id]", () => {
  it("arquiva e audita phone.menu_archived, com a organização da SESSÃO", async () => {
    const r = await apagar(MENU);
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(requireSupportWrite).toHaveBeenCalled();
    expect(vi.mocked(arquivarMenu).mock.calls[0]).toEqual([POOL, ORG, MENU]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.menu_archived",
      organizationId: ORG,
      resourceType: "phone_menu",
      resourceId: MENU,
      metadata: { falas_descartadas: [FALA.id] },
    });
  });

  it("menu que atende um número: 409 menu_em_uso NOMEANDO o número, com a lista em details, sem auditar", async () => {
    const numeros = [{ nome: "Recepção", numero: "+556136861503" }];
    estado.arquivar = { ok: false, motivo: "menu_em_uso", numeros };
    const r = await apagar(MENU);
    expect(r.status).toBe(409);
    const { error } = (await r.json()) as { error: { code: string; message: string; details: unknown } };
    expect(error).toEqual({
      code: "menu_em_uso",
      message: "Este menu está em uso por: Recepção · (61) 3686-1503. Troque o destino do número antes de arquivar.",
      details: { numeros },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("em espanhol, a mesma recusa traduzida, com os números no lugar", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "es" },
      org: { orgId: ORG, name: "Org", role: "admin" },
    } as never);
    estado.arquivar = {
      ok: false,
      motivo: "menu_em_uso",
      numeros: [
        { nome: "Recepción", numero: "+556136861503" },
        { nome: "Ventas", numero: null },
      ],
    };
    const { error } = (await (await apagar(MENU)).json()) as { error: { message: string } };
    expect(error.message).toBe(
      "Este menú está en uso por: Recepción · (61) 3686-1503, Ventas. Cambia el destino de los números antes de archivar.",
    );
  });

  it("a trava do menu está com outra gravação além do prazo: 409 gravacao_em_andamento, sem auditar", async () => {
    estado.arquivar = { ok: false, motivo: "gravacao_em_andamento" };
    const r = await apagar(MENU);
    expect(r.status).toBe(409);
    expect(await codigo(r)).toBe("gravacao_em_andamento");
    expect(audit).not.toHaveBeenCalled();
  });

  it("inexistente ou id inválido: 404, sem auditar", async () => {
    estado.arquivar = { ok: false, motivo: "nao_encontrado" };
    expect((await apagar(MENU)).status).toBe(404);
    expect((await apagar("nao-e-uuid")).status).toBe(404);
    expect(vi.mocked(arquivarMenu)).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });
});
