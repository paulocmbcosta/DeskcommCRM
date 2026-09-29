// @vitest-environment node
/**
 * O PATCH DO NÚMERO E A TROCA DE DESTINO (fase 2): admin; a organização da
 * gravação é a da SESSÃO (o corpo não tem onde levar outra — `.strict()`); a
 * troca de destino (time ↔ menu) ganha auditoria própria,
 * `phone.number_destination_changed`, com o antes e o depois QUE A TRANSAÇÃO
 * LEU — e só quando o destino mudou; nenhuma auditoria leva a senha SIP; cada
 * recusa volta com o status e a mensagem certos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloNumeros from "@/lib/channels/telefonia/numeros";

const ORG = "22222222-2222-4222-8222-222222222222";
const NUMERO = "33333333-3333-4333-8333-333333333333";
const MENU = "55555555-5555-4555-8555-555555555555";
const TIME = "44444444-4444-4444-8444-444444444444";
const SENHA = "senha-sip-de-teste-nao-real";
const POOL = vi.hoisted(() => ({ marca: "pool-da-rota" }));
const estado = vi.hoisted(() => ({ resultado: null as unknown }));

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
vi.mock("@/lib/channels/telefonia/empurrar", () => ({
  empurrarTroncoAgora: vi.fn(async () => undefined),
  retirarTroncoAgora: vi.fn(async () => undefined),
}));
// As mensagens e o status são os DE VERDADE: o teste mede o código, não uma cópia dele.
vi.mock("@/lib/channels/telefonia/numeros", async () => ({
  ...(await vi.importActual<typeof ModuloNumeros>("@/lib/channels/telefonia/numeros")),
  atualizarNumero: vi.fn(async () => estado.resultado),
  numerosDaOrg: vi.fn(async () => [{ id: "33333333-3333-4333-8333-333333333333", nome: "Recepção" }]),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarNumero } from "@/lib/channels/telefonia/numeros";

import { PATCH } from "./route";

const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Recepção",
  numero: "(61) 3686-1503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  time_id: null,
  ...extra,
});
const patch = (c: unknown) =>
  PATCH(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/numeros/${NUMERO}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c),
    }),
    { params: Promise.resolve({ id: NUMERO }) },
  );
const destino = (time_id: string | null, menu_id: string | null) => ({ time_id, menu_id });
const acoes = () => vi.mocked(audit).mock.calls.map(([a]) => a.action);
const auditoriaDe = (acao: string) => vi.mocked(audit).mock.calls.find(([a]) => a.action === acao)?.[0];

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(atualizarNumero).mockClear();
  estado.resultado = { ok: true, destino: { de: destino(TIME, null), para: destino(TIME, null) } };
});

describe("PATCH /api/v1/telefonia/numeros/[id] — a troca de destino", () => {
  it("é de admin", async () => {
    await patch(corpo());
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
  });

  it("time → menu: a gravação recebe a organização da SESSÃO e o menu do corpo; audita a troca com o antes e o depois", async () => {
    estado.resultado = { ok: true, destino: { de: destino(TIME, null), para: destino(null, MENU) } };

    const r = await patch(corpo({ menu_id: MENU }));

    expect(r.status).toBe(200);
    const [pool, org, id, entrada] = vi.mocked(atualizarNumero).mock.calls[0]!;
    expect([pool, org, id]).toEqual([POOL, ORG, NUMERO]);
    expect(entrada.menu_id).toBe(MENU);
    expect(acoes()).toEqual(["channel.phone_trunk_updated", "phone.number_destination_changed"]);
    expect(auditoriaDe("phone.number_destination_changed")).toMatchObject({
      organizationId: ORG,
      resourceType: "channel_session",
      resourceId: NUMERO,
      metadata: { de: destino(TIME, null), para: destino(null, MENU) },
    });
  });

  it("menu → time também é troca", async () => {
    estado.resultado = { ok: true, destino: { de: destino(null, MENU), para: destino(TIME, null) } };
    await patch(corpo({ time_id: TIME }));
    expect(auditoriaDe("phone.number_destination_changed")?.metadata).toEqual({ de: destino(null, MENU), para: destino(TIME, null) });
  });

  it("editar sem mudar o destino não audita troca nenhuma (só a edição do número)", async () => {
    await patch(corpo({ nome: "Outro nome" }));
    expect(acoes()).toEqual(["channel.phone_trunk_updated"]);
  });

  it("a edição audita o menu mandado; sem o campo (aba antiga), não diz nada sobre ele", async () => {
    await patch(corpo({ menu_id: MENU }));
    expect(auditoriaDe("channel.phone_trunk_updated")?.metadata).toMatchObject({ menu_id: MENU });
    vi.mocked(audit).mockClear();
    await patch(corpo());
    expect(auditoriaDe("channel.phone_trunk_updated")?.metadata).not.toHaveProperty("menu_id");
  });

  it("nenhuma auditoria leva a senha SIP", async () => {
    estado.resultado = { ok: true, destino: { de: destino(TIME, null), para: destino(null, MENU) } };
    await patch(corpo({ menu_id: MENU, senha: SENHA }));
    expect(vi.mocked(audit).mock.calls).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(SENHA);
  });

  it("organização no corpo é recusada pelo Zod (422), sem gravar", async () => {
    const r = await patch(corpo({ organization_id: "99999999-9999-4999-8999-999999999999" }));
    expect(r.status).toBe(422);
    expect(atualizarNumero).not.toHaveBeenCalled();
  });

  it.each([
    ["destino_duplo", 422, /um time ou um menu/],
    ["menu_invalido", 422, /arquivado/],
    ["menu_com_fala_pendente", 422, /ainda não está pronta/],
    ["gravacao_em_andamento", 409, /Tente de novo/],
    ["nao_encontrado", 404, /não encontrado/],
  ] as const)("recusa %s → %i com a mensagem, sem auditoria", async (motivo, status, mensagem) => {
    estado.resultado = { ok: false, motivo };
    const r = await patch(corpo({ menu_id: MENU }));
    expect(r.status).toBe(status);
    const j = (await r.json()) as { error: { code: string; message: string } };
    expect(j.error.code).toBe(motivo);
    expect(j.error.message).toMatch(mensagem);
    expect(audit).not.toHaveBeenCalled();
  });
});
