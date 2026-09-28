// @vitest-environment node
/**
 * O ÁUDIO DA FALA SALVA PELA ROTA: qualquer membro da organização; só a fala da
 * organização da SESSÃO; só o objeto `<org da sessão>/<hash>.ulaw`, com o hash
 * conferido como sha256 — o caminho gravado na linha nunca é usado sem bater com
 * esse; bytes μ-law com `audio/basic` e cache só privado; e Storage fora não é
 * "fala inexistente".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const ID = "33333333-3333-4333-8333-333333333333";
const HASH = "c".repeat(64);
const estado = vi.hoisted(() => ({
  fala: null as null | Record<string, unknown>,
  bytes: null as Uint8Array | null,
  storageFora: false,
  baixados: [] as string[],
  consultas: [] as unknown[][],
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "viewer" },
  })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: vi.fn(() => ({
    query: async (_sql: string, params: unknown[] = []) => {
      estado.consultas.push(params);
      // A leitura de verdade filtra id E organização: a fala de outra organização não volta.
      const f = estado.fala;
      const rows = f && f.id === params[0] && f.organization_id === params[1] ? [f] : [];
      return { rows, rowCount: rows.length };
    },
  })),
}));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  armazemDaInstalacao: vi.fn(() => ({
    baixar: async (caminho: string) => {
      estado.baixados.push(caminho);
      if (estado.storageFora) throw new Error("armazem_download: StorageApiError 500");
      return estado.bytes;
    },
  })),
}));

import { requireRole } from "@/lib/auth/require-role";

import { GET } from "./route";

const ouvir = (id: string) =>
  GET(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/falas/${id}/audio`), { params: Promise.resolve({ id }) });

const linha = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  organization_id: ORG,
  tipo: "waiting",
  texto: "Aguarde.",
  voice_id: "v1",
  model_id: "eleven_multilingual_v2",
  status: "ready",
  erro: null,
  duracao_ms: 200,
  atualizada_em: new Date("2026-09-28T13:00:00Z"),
  content_hash: HASH,
  storage_path: `${ORG}/${HASH}.ulaw`,
  ...extra,
});

beforeEach(() => {
  estado.fala = linha();
  estado.bytes = new Uint8Array([0xff, 0x7f, 0x00]);
  estado.storageFora = false;
  estado.baixados = [];
  estado.consultas = [];
  vi.mocked(requireRole).mockClear();
});

describe("GET /api/v1/telefonia/falas/[id]/audio", () => {
  it("qualquer membro: os bytes μ-law do objeto <org da sessão>/<hash>.ulaw, com audio/basic e cache privado", async () => {
    const r = await ouvir(ID);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("audio/basic");
    expect(r.headers.get("Cache-Control")).toMatch(/^private/);
    expect(r.headers.get("Cache-Control")).not.toMatch(/public/);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Request-Id")).toBeTruthy();
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0xff, 0x7f, 0x00]));
    expect(estado.baixados).toEqual([`${ORG}/${HASH}.ulaw`]);
    expect(estado.consultas[0]).toEqual([ID, ORG]);
  });

  it("id que não é UUID (inclusive tentativa de caminho) → 404 sem ler nada", async () => {
    for (const id of ["x", "../../outra", `${ORG}/${HASH}.ulaw`, "%2e%2e"]) {
      expect((await ouvir(id)).status, id).toBe(404);
    }
    expect(estado.consultas).toEqual([]);
    expect(estado.baixados).toEqual([]);
  });

  it("fala de OUTRA organização → 404, sem baixar nada", async () => {
    estado.fala = linha({ organization_id: OUTRA, storage_path: `${OUTRA}/${HASH}.ulaw` });
    expect((await ouvir(ID)).status).toBe(404);
    expect(estado.baixados).toEqual([]);
  });

  it("fala sem áudio pronto (failed, ou sem caminho) → 404", async () => {
    estado.fala = linha({ status: "failed", storage_path: null });
    expect((await ouvir(ID)).status).toBe(404);
    expect(estado.baixados).toEqual([]);
  });

  it("caminho gravado que não é <org da sessão>/<hash>.ulaw, ou hash fora de sha256 → 404, e ele NUNCA é baixado", async () => {
    for (const extra of [
      { storage_path: `${OUTRA}/${HASH}.ulaw` },
      { storage_path: `${ORG}/../${OUTRA}/${HASH}.ulaw` },
      { storage_path: `${ORG}/${"d".repeat(64)}.ulaw` },
      { content_hash: "../x", storage_path: `${ORG}/../x.ulaw` },
      { content_hash: HASH.toUpperCase(), storage_path: `${ORG}/${HASH.toUpperCase()}.ulaw` },
    ]) {
      estado.fala = linha(extra);
      expect((await ouvir(ID)).status, JSON.stringify(extra)).toBe(404);
    }
    expect(estado.baixados).toEqual([]);
  });

  it("o objeto sumiu do Storage: 404 que manda gerar a prévia de novo", async () => {
    estado.bytes = null;
    const r = await ouvir(ID);
    expect(r.status).toBe(404);
    const e = ((await r.json()) as { error: { code: string; message: string } }).error;
    expect(e.code).toBe("audio_ausente");
    expect(e.message).toMatch(/gere a prévia de novo/i);
  });

  it("o Storage falhou: 502 (tente de novo) — não é o mesmo que o áudio ter sumido", async () => {
    estado.storageFora = true;
    const r = await ouvir(ID);
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("audio_indisponivel");
  });
});
