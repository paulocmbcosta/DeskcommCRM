// @vitest-environment node
/**
 * A ESPERA MÁXIMA DO TIME PELA ROTA (migration 0295): gerente ou admin, com a
 * guarda de suporte ANTES de tudo; só com a telefonia oferecida na instalação; a
 * organização é a da SESSÃO — um `organization_id` no corpo é 422, e nada chega
 * ao banco; cada recusa tem o seu status; a auditoria sai só quando gravou, com o
 * antes e o depois.
 *
 * O SQL (a catraca da organização, o time arquivado) é provado no Postgres real
 * (tests/invariants/telefonia-espera-do-time.test.ts). Aqui ele é uma porta, e o
 * Zod da rota é o DE VERDADE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloEspera from "@/lib/telefonia/espera-do-time";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const TIME = "44444444-4444-4444-8444-444444444444";
const POOL = { pool: "da-rota" };
const estado = vi.hoisted(() => ({
  gravar: null as unknown,
  ari: { baseUrl: "http://asterisk:8088", senha: "x" } as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => estado.ari) }));
vi.mock("@/lib/telefonia/espera-do-time", async () => {
  const real = await vi.importActual<typeof ModuloEspera>("@/lib/telefonia/espera-do-time");
  return { ...real, gravarEsperaDoTime: vi.fn(async () => estado.gravar) };
});

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { gravarEsperaDoTime } from "@/lib/telefonia/espera-do-time";

import { PUT } from "./route";

const params = (teamId = TIME) => ({ params: Promise.resolve({ teamId }) });
const url = (teamId = TIME) => `https://crm.exemplo.com.br/api/v1/telefonia/fila/times/${teamId}`;
const gravar = (corpo: unknown, teamId = TIME) =>
  PUT(new NextRequest(url(teamId), { method: "PUT", body: typeof corpo === "string" ? corpo : JSON.stringify(corpo) }), params(teamId));
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const gravado = (espera: number | null, anterior: number | null) => ({
  ok: true,
  time: { team_id: TIME, espera_maxima_s: espera, em_vigor_s: espera ?? 120 },
  anterior,
});

beforeEach(() => {
  estado.gravar = gravado(600, null);
  estado.ari = { baseUrl: "http://asterisk:8088", senha: "x" };
  vi.mocked(audit).mockClear();
  vi.mocked(gravarEsperaDoTime).mockClear();
  vi.mocked(getRequestPool).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

describe("PUT /api/v1/telefonia/fila/times/[teamId]", () => {
  it("gerente ou admin (a régua é manager), com a guarda de suporte", async () => {
    expect((await gravar({ espera_maxima_s: 600 })).status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(vi.mocked(requireRole).mock.calls[0]![1]).toMatchObject({ resource: "telefonia_fila" });
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);
  });

  it("suporte somente-leitura: barrado ANTES de qualquer coisa — nem o papel é resolvido", async () => {
    const recusa = Response.json({ error: { code: "support_read_only", message: "x" } }, { status: 403 });
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(recusa as never);
    expect(await gravar({ espera_maxima_s: 600 })).toBe(recusa);
    expect(requireRole).not.toHaveBeenCalled();
    expect(gravarEsperaDoTime).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("papel abaixo de gerente: a recusa do `requireRole` volta intacta, sem gravar nem auditar", async () => {
    const recusa = Response.json({ error: { code: "forbidden_role", message: "x" } }, { status: 403 });
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: recusa } as never);
    expect(await gravar({ espera_maxima_s: 600 })).toBe(recusa);
    expect(gravarEsperaDoTime).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("telefonia não oferecida nesta instalação → 409, sem chegar ao banco", async () => {
    estado.ari = null;
    const r = await gravar({ espera_maxima_s: 600 });
    expect(r.status).toBe(409);
    expect(await erroDe(r)).toEqual({ code: "telefonia_nao_oferecida", message: "O telefone não está ligado nesta instalação." });
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(gravarEsperaDoTime).not.toHaveBeenCalled();
  });

  it("id do time fora do formato → 404, sem chegar ao banco", async () => {
    const r = await gravar({ espera_maxima_s: 600 }, "nao-e-uuid");
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual({ code: "not_found", message: "Time não encontrado." });
    expect(gravarEsperaDoTime).not.toHaveBeenCalled();
  });

  it.each([
    ["sem o campo", {}],
    ["abaixo de 30 s", { espera_maxima_s: 29 }],
    ["acima de 30 min", { espera_maxima_s: 1801 }],
    ["segundo quebrado", { espera_maxima_s: 60.5 }],
    ["texto no lugar do número", { espera_maxima_s: "600" }],
    ["a organização no corpo (o corpo não troca a organização)", { espera_maxima_s: 600, organization_id: OUTRA_ORG }],
    ["o time no corpo", { espera_maxima_s: 600, team_id: OUTRA_ORG }],
    ["corpo que não é JSON", "<html>"],
  ])("corpo inválido — %s → 422, sem chegar ao banco nem auditar", async (_nome, corpo) => {
    const r = await gravar(corpo);
    expect(r.status).toBe(422);
    expect(await erroDe(r)).toEqual({ code: "validation_failed", message: "Escolha uma espera entre 30 segundos e 30 minutos." });
    expect(gravarEsperaDoTime).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("time de outra organização (ou que não existe) → 404, e nada auditado", async () => {
    estado.gravar = { ok: false, motivo: "nao_encontrado" };
    const r = await gravar({ espera_maxima_s: 600 });
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual({ code: "not_found", message: "Time não encontrado." });
    expect(audit).not.toHaveBeenCalled();
  });

  it("time ARQUIVADO → 409 com mensagem própria, e nada auditado", async () => {
    estado.gravar = { ok: false, motivo: "time_arquivado" };
    const r = await gravar({ espera_maxima_s: 600 });
    expect(r.status).toBe(409);
    expect(await erroDe(r)).toEqual({ code: "time_arquivado", message: "Este time está arquivado." });
    expect(audit).not.toHaveBeenCalled();
  });

  it("grava com a organização DA SESSÃO, e audita o antes e o depois", async () => {
    estado.gravar = gravado(600, 120);
    const r = await gravar({ espera_maxima_s: 600 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ time: { team_id: TIME, espera_maxima_s: 600, em_vigor_s: 600 } });
    expect(vi.mocked(gravarEsperaDoTime).mock.calls).toEqual([[POOL, ORG, TIME, 600]]);

    expect(audit).toHaveBeenCalledTimes(1);
    const linha = vi.mocked(audit).mock.calls[0]![0];
    expect(linha).toMatchObject({
      action: "phone.queue_wait_changed",
      actorUserId: USUARIO,
      organizationId: ORG,
      resourceType: "attendance_team",
      resourceId: TIME,
      metadata: { de: 120, para: 600 },
    });
    expect(linha.requestId).toBe(r.headers.get("X-Request-Id"));
  });

  it("`null` volta ao padrão: chega `null` ao banco, e a auditoria diz de quanto para o padrão", async () => {
    estado.gravar = gravado(null, 600);
    const r = await gravar({ espera_maxima_s: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ time: { team_id: TIME, espera_maxima_s: null, em_vigor_s: 120 } });
    expect(vi.mocked(gravarEsperaDoTime).mock.calls[0]).toEqual([POOL, ORG, TIME, null]);
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toEqual({ de: 600, para: null });
  });

  it.each([30, 1800])("os limites valem: %i s é aceito", async (segundos) => {
    estado.gravar = gravado(segundos, null);
    expect((await gravar({ espera_maxima_s: segundos })).status).toBe(200);
    expect(vi.mocked(gravarEsperaDoTime).mock.calls[0]![3]).toBe(segundos);
  });
});
