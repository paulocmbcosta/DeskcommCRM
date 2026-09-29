// @vitest-environment node
/**
 * A VOZ DA ORGANIZAÇÃO PELA ROTA: admin; o `voice_id` passa pela régua ÚNICA
 * (`ID_DE_VOZ`) antes de qualquer chamada; a voz é conferida contra as vozes da
 * conta (listar não sintetiza nada) antes de gravar; a organização é a da sessão;
 * trocar audita, escolher a mesma de novo não escreve nem audita.
 *
 * A ElevenLabs aqui é falsa: `listarVozes` é trocado, nenhuma chamada sai da máquina.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloElevenLabs from "@/lib/telefonia/elevenlabs";
import type * as ModuloFalas from "@/lib/telefonia/falas";

const ORG = "22222222-2222-4222-8222-222222222222";
const estado = vi.hoisted(() => ({
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  chave: "sk_ficticia" as string | null,
  vozes: ["v1", "v2"],
  falha: null as null | "chave_invalida" | "sem_resposta",
  anterior: { voiceId: "v1", modelId: "eleven_multilingual_v2" } as null | { voiceId: string; modelId: string },
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
      return { rows: [], rowCount: 1 };
    },
  })),
}));
vi.mock("@/lib/telefonia/chave-elevenlabs", () => ({
  chaveDeVoz: vi.fn(async () => estado.chave),
  estadoDaChaveDeVoz: vi.fn(async () => ({ cadastrada: true, last4: "1234", validada_em: null })),
}));
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof ModuloElevenLabs>("@/lib/telefonia/elevenlabs");
  return {
    ...real,
    listarVozes: vi.fn(async () => {
      if (estado.falha) throw new real.ErroDaElevenLabs(estado.falha, estado.falha === "chave_invalida" ? 401 : null);
      return estado.vozes.map((v) => ({ voice_id: v, nome: v, categoria: null, amostra_url: null }));
    }),
  };
});
vi.mock("@/lib/telefonia/falas", async () => ({
  ...(await vi.importActual<typeof ModuloFalas>("@/lib/telefonia/falas")),
  vozDaOrganizacao: vi.fn(async () => estado.anterior),
  falasGeraisDaOrg: vi.fn(async () => ({ waiting: null, nobody: null, after_hours: null, recording_notice: null })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { listarVozes } from "@/lib/telefonia/elevenlabs";

import { GET, PUT } from "./route";

const escolher = (corpo: unknown) =>
  PUT(new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/voz", { method: "PUT", body: JSON.stringify(corpo) }));
const escritas = () => estado.consultas.filter((c) => /^\s*(insert|update)/i.test(c.sql));

beforeEach(() => {
  estado.consultas = [];
  estado.chave = "sk_ficticia";
  estado.vozes = ["v1", "v2"];
  estado.falha = null;
  estado.anterior = { voiceId: "v1", modelId: "eleven_multilingual_v2" };
  vi.mocked(audit).mockClear();
  vi.mocked(listarVozes).mockClear();
  vi.mocked(requireRole).mockClear();
});

describe("GET /api/v1/telefonia/voz", () => {
  it("admin: a chave (só os 4 últimos), a voz e as falas gerais", async () => {
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(await r.json()).toMatchObject({
      data: {
        chave: { cadastrada: true, last4: "1234" },
        voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
        falas: { waiting: null, nobody: null, after_hours: null, recording_notice: null },
      },
    });
  });
});

describe("PUT /api/v1/telefonia/voz", () => {
  it("admin; troca para uma voz da conta: grava na organização da sessão e audita a anterior", async () => {
    const r = await escolher({ voice_id: "v2" });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(r.status).toBe(200);
    expect(escritas()).toHaveLength(1);
    expect(escritas()[0]!.sql).toMatch(/insert into phone_settings/);
    expect(escritas()[0]!.params).toEqual([ORG, "v2"]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.voice_changed",
      organizationId: ORG,
      metadata: { voice_id: "v2", anterior: "v1" },
    });
  });

  it("a mesma voz de novo: confere na conta, mas não escreve nem audita", async () => {
    const r = await escolher({ voice_id: "v1" });
    expect(r.status).toBe(200);
    expect(listarVozes).toHaveBeenCalled();
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("voice_id fora da régua ID_DE_VOZ (ou campo a mais): 422 sem chamar a ElevenLabs", async () => {
    for (const corpo of [{ voice_id: "../x" }, { voice_id: "a b" }, { voice_id: "x".repeat(65) }, { voice_id: "" }, { voice_id: "v2", organization_id: ORG }]) {
      expect((await escolher(corpo)).status, JSON.stringify(corpo).slice(0, 40)).toBe(422);
    }
    expect(listarVozes).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("o limite da régua é o de ID_DE_VOZ: 64 caracteres ainda passam para a conferência", async () => {
    estado.vozes = ["x".repeat(64)];
    expect((await escolher({ voice_id: "x".repeat(64) })).status).toBe(200);
  });

  it("voz que não está na conta: 422 voz_inexistente, nada gravado", async () => {
    const r = await escolher({ voice_id: "v9" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("voz_inexistente");
    expect(escritas()).toEqual([]);
  });

  it("sem chave cadastrada: 422 sem_chave; chave recusada: 422; ElevenLabs fora: 502 — nunca 429", async () => {
    estado.chave = null;
    expect((await escolher({ voice_id: "v2" })).status).toBe(422);
    estado.chave = "sk_ficticia";
    estado.falha = "chave_invalida";
    expect((await escolher({ voice_id: "v2" })).status).toBe(422);
    estado.falha = "sem_resposta";
    expect((await escolher({ voice_id: "v2" })).status).toBe(502);
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
