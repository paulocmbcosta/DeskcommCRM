// @vitest-environment node
/**
 * A POLÍTICA DE GRAVAÇÃO PELA ROTA (F3): admin; o corpo aceita só `ativa` e uma
 * retenção da lista; ligar sem o aviso pronto é 409; a organização é a da sessão;
 * mudar audita (antes e depois), salvar o mesmo não audita. O SQL de
 * `salvarPoliticaDaOrg` é provado logo abaixo, com um banco dublado que responde
 * como o Postgres ao `update … where exists`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const estado = vi.hoisted(() => ({
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  linha: { recording_enabled: false, recording_retention_days: 90, recording_notice_prompt_id: null as string | null },
  avisoPronto: true,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: vi.fn(() => ({
    query: async (sql: string, params: unknown[] = []) => {
      estado.consultas.push({ sql, params });
      if (/^\s*select recording_enabled, recording_retention_days, recording_notice_prompt_id/.test(sql)) {
        return { rows: [estado.linha], rowCount: 1 };
      }
      if (/^\s*select recording_enabled, recording_retention_days from/.test(sql)) {
        return { rows: [estado.linha], rowCount: 1 };
      }
      if (/^\s*update phone_settings s/.test(sql)) {
        const [, ativa, dias] = params as [string, boolean, number];
        // Como o `where ($2 = false or exists (aviso pronto))` do Postgres.
        if (ativa && !estado.avisoPronto) return { rows: [], rowCount: 0 };
        estado.linha = { ...estado.linha, recording_enabled: ativa, recording_retention_days: dias };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";

import { GET, PUT } from "./route";

const salvar = (corpo: unknown) =>
  PUT(new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/gravacao", { method: "PUT", body: JSON.stringify(corpo) }));

beforeEach(() => {
  estado.consultas = [];
  estado.linha = { recording_enabled: false, recording_retention_days: 90, recording_notice_prompt_id: null };
  estado.avisoPronto = true;
  vi.mocked(audit).mockClear();
  vi.mocked(requireRole).mockClear();
});

describe("GET /api/v1/telefonia/gravacao", () => {
  it("admin: desligada por padrão, 90 dias, as opções de retenção e o aviso (ausente)", async () => {
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(await r.json()).toMatchObject({
      data: { ativa: false, retencao_dias: 90, retencoes: [30, 60, 90, 180, 365, 730, 1825], aviso: null },
    });
    expect(estado.consultas[0]!.params).toEqual([ORG]);
  });
});

describe("PUT /api/v1/telefonia/gravacao", () => {
  it("liga com o aviso pronto: grava na organização da sessão e audita antes e depois", async () => {
    const r = await salvar({ ativa: true, retencao_dias: 180 });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { ativa: true, retencao_dias: 180 } });
    const update = estado.consultas.find((c) => /update phone_settings s/.test(c.sql))!;
    expect(update.params).toEqual([ORG, true, 180]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.recording_settings_changed",
      organizationId: ORG,
      metadata: { antes: { ativa: false, retencao_dias: 90 }, depois: { ativa: true, retencao_dias: 180 } },
    });
  });

  it("ligar sem o aviso pronto: 409 aviso_de_gravacao_ausente, sem auditoria", async () => {
    estado.avisoPronto = false;
    const r = await salvar({ ativa: true, retencao_dias: 90 });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "aviso_de_gravacao_ausente" } });
    expect(audit).not.toHaveBeenCalled();
  });

  it("desligar não depende do aviso", async () => {
    estado.avisoPronto = false;
    estado.linha.recording_enabled = true;
    const r = await salvar({ ativa: false, retencao_dias: 90 });
    expect(r.status).toBe(200);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ metadata: { depois: { ativa: false } } });
  });

  it("salvar o que já estava: 200 sem auditoria", async () => {
    const r = await salvar({ ativa: false, retencao_dias: 90 });
    expect(r.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["retenção fora da lista", { ativa: true, retencao_dias: 45 }],
    ["retenção fracionada", { ativa: true, retencao_dias: 90.5 }],
    ["campo a mais (organização no corpo)", { ativa: true, retencao_dias: 90, organization_id: "x" }],
    ["sem ativa", { retencao_dias: 90 }],
  ])("%s: 422 sem escrever", async (_nome, corpo) => {
    const r = await salvar(corpo);
    expect(r.status).toBe(422);
    expect(estado.consultas.filter((c) => /update/.test(c.sql))).toEqual([]);
  });
});
