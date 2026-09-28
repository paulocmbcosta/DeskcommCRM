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
const estado = vi.hoisted(() => ({ resultado: null as unknown, arquivar: "ok" as string }));

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
vi.mock("@/lib/telefonia/servico-de-falas", async () => ({
  ...(await vi.importActual<typeof ModuloServico>("@/lib/telefonia/servico-de-falas")),
  armazemDaInstalacao: vi.fn(() => ({ marca: "armazem" })),
}));
vi.mock("@/lib/telefonia/menus", async () => ({
  ...(await vi.importActual<typeof ModuloMenus>("@/lib/telefonia/menus")),
  salvarMenuDaOrg: vi.fn(async () => estado.resultado),
  menusDaOrg: vi.fn(async () => [{ id: "55555555-5555-4555-8555-555555555555", nome: "Principal" }]),
  arquivarMenu: vi.fn(async () => estado.arquivar),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { arquivarMenu, salvarMenuDaOrg } from "@/lib/telefonia/menus";

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
const corpo = {
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME }],
  time_padrao_id: TIME,
  fala: { texto: "Para Suporte, digite 1.", hash: HASH },
};
const url = (id: string) => `https://crm.exemplo.com.br/api/v1/telefonia/menus/${id}`;
const patch = (id: string, c: unknown = corpo) =>
  PATCH(new NextRequest(url(id), { method: "PATCH", body: JSON.stringify(c) }), { params: Promise.resolve({ id }) });
const apagar = (id: string) => DELETE(new NextRequest(url(id), { method: "DELETE" }), { params: Promise.resolve({ id }) });
const codigo = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

const fetchContado = vi.fn(async () => new Response(null, { status: 599 }));

beforeEach(() => {
  estado.resultado = { ok: true, id: MENU, fala: { fala: FALA, mudou: false }, falaInvalida: null, falaInvalidaDescartada: null };
  estado.arquivar = "ok";
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
    });
  });

  it("menu que atende um número: 409 menu_em_uso, sem auditar", async () => {
    estado.arquivar = "menu_em_uso";
    const r = await apagar(MENU);
    expect(r.status).toBe(409);
    expect(await codigo(r)).toBe("menu_em_uso");
    expect(audit).not.toHaveBeenCalled();
  });

  it("inexistente ou id inválido: 404, sem auditar", async () => {
    estado.arquivar = "nao_encontrado";
    expect((await apagar(MENU)).status).toBe(404);
    expect((await apagar("nao-e-uuid")).status).toBe(404);
    expect(vi.mocked(arquivarMenu)).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });
});
