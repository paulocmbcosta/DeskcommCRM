// @vitest-environment node
/**
 * A PRÉVIA PELA ROTA (desenho da fase 2, D15 e §4): gerente ou admin; o corpo só
 * traz o texto; a cota é da organização da SESSÃO e só conta quando a prévia vai
 * à ElevenLabs; o limite estourado volta 429 com Retry-After (limite NOSSO, pela
 * doutrina da API); toda síntese PAGA é auditada — também a que não ficou
 * guardada —, a reaproveitada não; e o texto recusado pela NOSSA régua nunca
 * aparece como recusa da ElevenLabs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloArmazem from "@/lib/telefonia/armazem";
import type * as ModuloServico from "@/lib/telefonia/servico-de-falas";

const ORG = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const estado = vi.hoisted(() => ({
  resultado: null as unknown,
  /** A verdadeira só gasta cota quando iria à ElevenLabs; o falso imita isso. */
  iriaAElevenLabs: true,
  cota: { permitida: true, limite: 30, restantes: 29, reabreEmS: 1200 },
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
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
// O `STATUS_DA_FALHA` é o DE VERDADE (vocabulario.ts, sem mock): é ele que decide o 429 da cota e o 502 do Storage.
vi.mock("@/lib/telefonia/armazem", async () => ({
  ...(await vi.importActual<typeof ModuloArmazem>("@/lib/telefonia/armazem")),
  armazemDaInstalacao: vi.fn(() => ({})),
}));
vi.mock("@/lib/telefonia/servico-de-falas", async () => {
  const real = await vi.importActual<typeof ModuloServico>("@/lib/telefonia/servico-de-falas");
  return {
    ...real,
    contextoDeFala: vi.fn(async () => ({ chave: "sk_ficticia", voz: { voiceId: "v1", modelId: "eleven_multilingual_v2" } })),
    sintetizadorDaInstalacao: vi.fn(() => vi.fn()),
    consumirCotaDePrevia: vi.fn(async () => estado.cota),
  };
});
vi.mock("@/lib/telefonia/previa", () => ({
  gerarPrevia: vi.fn(async (p: { consumirCota: () => Promise<boolean> }) => {
    if (estado.iriaAElevenLabs && !(await p.consumirCota())) return { ok: false, motivo: "limite_de_previas" };
    return estado.resultado;
  }),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { hashDaFala } from "@/lib/telefonia/falas";
import { gerarPrevia } from "@/lib/telefonia/previa";
import { consumirCotaDePrevia } from "@/lib/telefonia/servico-de-falas";

import { POST } from "./route";

const chamar = (corpo: unknown) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/falas/previa", { method: "POST", body: JSON.stringify(corpo) }),
  );
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: unknown } }).error;

beforeEach(() => {
  estado.iriaAElevenLabs = true;
  estado.cota = { permitida: true, limite: 30, restantes: 29, reabreEmS: 1200 };
  estado.resultado = { ok: true, hash: HASH, audio: new Uint8Array([0xff, 0x7f]), duracaoMs: 1, reaproveitada: false };
  vi.mocked(audit).mockClear();
  vi.mocked(gerarPrevia).mockClear();
  vi.mocked(consumirCotaDePrevia).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

describe("POST /api/v1/telefonia/falas/previa", () => {
  it("gerente ou admin (o aviso de instabilidade também passa pela prévia), e com a guarda de suporte", async () => {
    await chamar({ texto: "Aguarde." });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(requireSupportWrite).toHaveBeenCalled();
  });

  it("prévia nova: hash, duração e o μ-law em base64; a cota é da organização da sessão; audita sem o texto", async () => {
    const r = await chamar({ texto: "  Aguarde.  " });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { hash: HASH, duracao_ms: 1, reaproveitada: false, audio_base64: "/38=" } });
    expect(consumirCotaDePrevia).toHaveBeenCalledWith(ORG);
    expect(r.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("29");
    expect(vi.mocked(gerarPrevia).mock.calls[0]![0]).toMatchObject({ organizationId: ORG, texto: "Aguarde." });
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "phone.prompt_previewed",
      organizationId: ORG,
      resourceId: null,
      metadata: { hash: HASH, caracteres: 8, guardada: true },
    });
    expect(JSON.stringify(entrada)).not.toContain("Aguarde.");
  });

  it("prévia reaproveitada do Storage: não gasta cota nem audita (nada foi pago nem gravado)", async () => {
    estado.iriaAElevenLabs = false;
    estado.resultado = { ok: true, hash: HASH, audio: new Uint8Array([0xff]), duracaoMs: 1, reaproveitada: true };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(200);
    expect(consumirCotaDePrevia).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(r.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("limite de 30 por hora estourado: 429 limite_de_previas com Retry-After e X-RateLimit-*, sem auditar", async () => {
    estado.cota = { permitida: false, limite: 30, restantes: 0, reabreEmS: 1200 };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(429);
    const e = await erroDe(r);
    expect(e.code).toBe("limite_de_previas");
    expect(e.message).toMatch(/Muitas prévias/);
    expect(r.headers.get("Retry-After")).toBe("1200");
    expect(r.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(audit).not.toHaveBeenCalled();
  });

  it("a síntese foi PAGA e o áudio não ficou guardado: 502, diz que a fala foi gerada mas não guardada, e AUDITA o gasto", async () => {
    estado.resultado = { ok: false, motivo: "armazenamento", paga: true };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(502);
    const e = await erroDe(r);
    expect(e.code).toBe("armazenamento");
    expect(e.message).toMatch(/foi gerada/);
    expect(e.message).toMatch(/não foi guardada/);
    // O que o comentário da rota promete: a pessoa fica sabendo que gerar de novo CUSTA de novo.
    expect(e.message).toMatch(/Gerar de novo consome outra geração da ElevenLabs/);
    expect(e.details).toEqual({ paga: true });
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "phone.prompt_previewed",
      resourceId: null,
      metadata: {
        hash: hashDaFala("Aguarde.", "v1", "eleven_multilingual_v2"),
        caracteres: 8,
        guardada: false,
        motivo: "armazenamento",
      },
    });
    expect(JSON.stringify(entrada)).not.toContain("Aguarde.");
  });

  it("CONTROLE — o Storage falhou ANTES de pagar: a mensagem comum do Storage, e nada auditado", async () => {
    estado.resultado = { ok: false, motivo: "armazenamento" };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(502);
    const e = await erroDe(r);
    expect(e.message).not.toMatch(/foi gerada/);
    expect(e.details).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a ElevenLabs recusou: a mensagem traduzida, com o status da falha (422, nunca 429)", async () => {
    estado.resultado = { ok: false, motivo: "sem_credito" };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(422);
    expect((await erroDe(r)).message).toMatch(/sem crédito/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("texto recusado pela NOSSA régua (vazio, longo demais, NUL): mensagem própria, sem culpar a ElevenLabs e sem gastar cota", async () => {
    for (const texto of ["   ", "x".repeat(1001), "Oi\u0000."]) {
      const r = await chamar({ texto });
      expect(r.status, JSON.stringify(texto.slice(0, 10))).toBe(422);
      const e = await erroDe(r);
      expect(e.code).toBe("validation_failed");
      expect(e.message).toMatch(/^Texto inválido/);
      expect(e.message).not.toMatch(/ElevenLabs/);
    }
    expect(gerarPrevia).not.toHaveBeenCalled();
    expect(consumirCotaDePrevia).not.toHaveBeenCalled();
  });

  it("CONTROLE — a recusa de texto que vem da ElevenLabs continua dizendo que foi ela", async () => {
    estado.resultado = { ok: false, motivo: "texto_recusado" };
    const r = await chamar({ texto: "Aguarde." });
    expect(r.status).toBe(422);
    expect((await erroDe(r)).message).toMatch(/A ElevenLabs recusou este texto/);
  });

  it("corpo inválido (sem texto, ou um campo a mais como caminho ou organização) → 422 sem gerar nada", async () => {
    expect((await chamar({})).status).toBe(422);
    expect((await chamar({ texto: "Oi.", caminho: "outra-org/x.ulaw" })).status).toBe(422);
    expect((await chamar({ texto: "Oi.", organization_id: "33333333-3333-4333-8333-333333333333" })).status).toBe(422);
    expect(gerarPrevia).not.toHaveBeenCalled();
  });
});
