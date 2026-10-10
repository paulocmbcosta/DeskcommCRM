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
  linha: {
    recording_enabled: false,
    recording_retention_days: 90,
    recording_notice_prompt_id: null as string | null,
    transcription_enabled: false,
  },
  avisoPronto: true,
  /** A chave do transcritor: o valor, `null` (não há) ou um erro (não deu para saber). */
  chave: "sk-da-org" as string | null | Error,
  perguntasPelaChave: 0,
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
      if (/^\s*select recording_enabled, recording_retention_days, transcription_enabled from/.test(sql)) {
        return { rows: [estado.linha], rowCount: 1 };
      }
      if (/^\s*update phone_settings s/.test(sql)) {
        const [, ativa, dias, transcrever] = params as [string, boolean, number, boolean];
        // Como o `where ($2 = false or exists (aviso pronto))` do Postgres.
        if (ativa && !estado.avisoPronto) return { rows: [], rowCount: 0 };
        estado.linha = { ...estado.linha, recording_enabled: ativa, recording_retention_days: dias, transcription_enabled: transcrever };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  })),
}));
vi.mock("@/lib/telefonia/chave-do-transcritor", () => ({
  chaveDoTranscritor: vi.fn(async () => {
    estado.perguntasPelaChave += 1;
    if (estado.chave instanceof Error) throw estado.chave;
    return estado.chave;
  }),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";

import { GET, PUT } from "./route";

const salvar = (corpo: unknown) =>
  PUT(new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/gravacao", { method: "PUT", body: JSON.stringify(corpo) }));

beforeEach(() => {
  estado.consultas = [];
  estado.linha = { recording_enabled: false, recording_retention_days: 90, recording_notice_prompt_id: null, transcription_enabled: false };
  estado.avisoPronto = true;
  estado.chave = "sk-da-org";
  estado.perguntasPelaChave = 0;
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

  it("diz se a transcrição está ligada e se há chave para transcrever", async () => {
    estado.linha.transcription_enabled = true;
    expect(await (await GET()).json()).toMatchObject({ data: { transcrever: true, transcricao_com_chave: true } });
    estado.chave = null;
    expect(await (await GET()).json()).toMatchObject({ data: { transcrever: true, transcricao_com_chave: false } });
  });

  it("não conseguiu conferir a chave: responde `null` — a aba não cai nem afirma que falta", async () => {
    estado.chave = new Error("banco fora");
    const r = await GET();
    expect(r.status).toBe(200);
    expect((await r.json()).data.transcricao_com_chave).toBeNull();
  });

  it("a chave nunca aparece na resposta", async () => {
    expect(JSON.stringify(await (await GET()).json())).not.toContain("sk-da-org");
  });
});

describe("PUT /api/v1/telefonia/gravacao", () => {
  it("liga com o aviso pronto: grava na organização da sessão e audita antes e depois", async () => {
    const r = await salvar({ ativa: true, retencao_dias: 180 });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { ativa: true, retencao_dias: 180 } });
    const update = estado.consultas.find((c) => /update phone_settings s/.test(c.sql))!;
    expect(update.params).toEqual([ORG, true, 180, false]);
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

  it("liga a transcrição com chave: grava, devolve e audita o antes e o depois", async () => {
    const r = await salvar({ ativa: true, retencao_dias: 90, transcrever: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { ativa: true, retencao_dias: 90, transcrever: true } });
    expect(estado.consultas.find((c) => /update phone_settings s/.test(c.sql))!.params).toEqual([ORG, true, 90, true]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      metadata: { antes: { transcrever: false }, depois: { transcrever: true } },
    });
  });

  it("ligar a transcrição SEM chave: 409 chave_de_transcricao_ausente, nada é gravado nem auditado", async () => {
    estado.chave = null;
    const r = await salvar({ ativa: false, retencao_dias: 90, transcrever: true });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "chave_de_transcricao_ausente" } });
    expect(estado.consultas.filter((c) => /update/.test(c.sql))).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ligar a transcrição sem conseguir conferir a chave: 500, nada é gravado", async () => {
    estado.chave = new Error("banco fora");
    const r = await salvar({ ativa: false, retencao_dias: 90, transcrever: true });
    expect(r.status).toBe(500);
    expect(estado.consultas.filter((c) => /update/.test(c.sql))).toEqual([]);
  });

  it("corpo sem `transcrever` (integração antiga): a transcrição fica como está, e a chave nem é perguntada", async () => {
    estado.linha.transcription_enabled = true;
    estado.chave = null;
    const r = await salvar({ ativa: false, retencao_dias: 180 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { transcrever: true } });
    expect(estado.consultas.find((c) => /update phone_settings s/.test(c.sql))!.params).toEqual([ORG, false, 180, true]);
    expect(estado.perguntasPelaChave).toBe(0);
  });

  it("com a transcrição já ligada, salvar outra coisa não depende da chave — quem a perdeu ainda muda a retenção", async () => {
    estado.linha.transcription_enabled = true;
    estado.chave = null;
    const r = await salvar({ ativa: false, retencao_dias: 365, transcrever: true });
    expect(r.status).toBe(200);
    expect(estado.perguntasPelaChave).toBe(0);
  });

  it("desligar a transcrição nunca depende da chave, e audita", async () => {
    estado.linha.transcription_enabled = true;
    estado.chave = null;
    const r = await salvar({ ativa: false, retencao_dias: 90, transcrever: false });
    expect(r.status).toBe(200);
    expect(estado.perguntasPelaChave).toBe(0);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      metadata: { antes: { transcrever: true }, depois: { transcrever: false } },
    });
  });

  it.each([
    ["transcrever que não é booleano", { ativa: true, retencao_dias: 90, transcrever: "sim" }],
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
