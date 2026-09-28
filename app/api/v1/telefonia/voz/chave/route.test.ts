// @vitest-environment node
/**
 * A CHAVE DA ELEVENLABS PELA ROTA: validada ANTES de gravar, auditada sem o texto
 * da chave, e a resposta só traz os 4 últimos dígitos (desenho da fase 2, §7).
 *
 * A chave aqui é fictícia, e a ElevenLabs também: ou `listarVozes` falso, ou o
 * cliente de verdade com um `fetch` falso — nenhuma chamada sai da máquina.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloElevenLabs from "@/lib/telefonia/elevenlabs";

const estado = vi.hoisted(() => ({
  falhaDaElevenLabs: null as null | string,
  usarClienteDeVerdade: false,
  falhaAoGuardar: null as null | Error,
}));

const ORG_DA_SESSAO = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  opcoesDaElevenLabs: () => ({}),
  STATUS_DA_FALHA: { chave_invalida: 422, sem_credito: 422, sem_resposta: 502, erro_do_provedor: 502 },
}));
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof ModuloElevenLabs>("@/lib/telefonia/elevenlabs");
  return {
    ...real,
    listarVozes: vi.fn(async (chave: string, o: Parameters<typeof real.listarVozes>[1]) => {
      if (estado.usarClienteDeVerdade) return real.listarVozes(chave, o);
      if (estado.falhaDaElevenLabs) throw new real.ErroDaElevenLabs(estado.falhaDaElevenLabs as "chave_invalida", 401);
      return [{ voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null }];
    }),
  };
});
vi.mock("@/lib/telefonia/chave-elevenlabs", () => ({
  PROVEDOR_DE_VOZ: "elevenlabs",
  guardarChaveDeVoz: vi.fn(async () => {
    if (estado.falhaAoGuardar) throw estado.falhaAoGuardar;
    return { id: "33333333-3333-4333-8333-333333333333", last4: "1234", substituiu: false };
  }),
  estadoDaChaveDeVoz: vi.fn(async () => ({ cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { estadoDaChaveDeVoz, guardarChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { listarVozes } from "@/lib/telefonia/elevenlabs";

import { GET, PUT } from "./route";

const CHAVE = "sk_segredo_da_elevenlabs_1234";
const pedido = (corpo: unknown) =>
  new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/voz/chave", { method: "PUT", body: JSON.stringify(corpo) });

/** Tudo o que o logger recebeu, serializado — para provar que a chave não está lá. */
function tudoQueFoiLogado(): string {
  const l = vi.mocked(logger);
  return JSON.stringify([l.info.mock.calls, l.warn.mock.calls, l.error.mock.calls, l.debug.mock.calls]);
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(guardarChaveDeVoz).mockClear();
  vi.mocked(estadoDaChaveDeVoz).mockClear();
  vi.mocked(listarVozes).mockClear();
  vi.mocked(requireRole).mockClear();
  for (const f of Object.values(vi.mocked(logger))) f.mockClear();
  estado.falhaDaElevenLabs = null;
  estado.usarClienteDeVerdade = false;
  estado.falhaAoGuardar = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PUT /api/v1/telefonia/voz/chave", () => {
  it("só admin grava", async () => {
    await PUT(pedido({ chave: CHAVE }));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
  });

  it("quem não é admin recebe a recusa do requireRole, sem ir à ElevenLabs nem gravar", async () => {
    const recusa = new Response(JSON.stringify({ error: { code: "forbidden", message: "x" } }), { status: 403 });
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: recusa } as Awaited<ReturnType<typeof requireRole>>);
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(403);
    expect(listarVozes).not.toHaveBeenCalled();
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();
  });

  it("chave que a ElevenLabs recusa NÃO é guardada nem auditada, e a mensagem vem traduzida", async () => {
    estado.falhaDaElevenLabs = "chave_invalida";
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("chave_invalida");
    expect(corpo.error.message).toMatch(/recusou a chave/);
    expect(JSON.stringify(corpo)).not.toContain(CHAVE);
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("chave válida: guarda, audita sem a chave, e a resposta só tem os 4 últimos", async () => {
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(200);
    const texto = await r.text();
    expect(texto).not.toContain(CHAVE);
    expect(texto).toContain("1234");
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({ action: "ai.credential_created", metadata: { provider: "elevenlabs", last4: "1234", vozes: 1 } });
    expect(JSON.stringify(entrada)).not.toContain(CHAVE);
    expect(tudoQueFoiLogado()).not.toContain(CHAVE);
  });

  it("a organização sai da SESSÃO: o corpo não escolhe onde a chave é gravada", async () => {
    const intruso = await PUT(pedido({ chave: CHAVE, organization_id: "99999999-9999-4999-8999-999999999999" }));
    expect(intruso.status).toBe(422);
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();

    await PUT(pedido({ chave: `  ${CHAVE}  ` }));
    expect(listarVozes).toHaveBeenCalledWith(CHAVE, {});
    expect(vi.mocked(guardarChaveDeVoz).mock.calls[0]![1]).toEqual({
      organizationId: ORG_DA_SESSAO,
      userId: USUARIO,
      chave: CHAVE,
    });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({ organizationId: ORG_DA_SESSAO, actorUserId: USUARIO });
  });

  it("com o cliente de verdade, a chave vai SÓ no header — nunca na URL — e não chega ao log", async () => {
    estado.usarClienteDeVerdade = true;
    const pedidos: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        pedidos.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) } });
        return new Response(JSON.stringify({ voices: [{ voice_id: "voz_ana", name: "Ana" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const r = await PUT(pedido({ chave: CHAVE }));

    expect(r.status).toBe(200);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(pedidos[0]!.url).not.toContain(CHAVE);
    expect(pedidos[0]!.headers["xi-api-key"]).toBe(CHAVE);
    expect(tudoQueFoiLogado()).not.toContain(CHAVE);
  });

  it("falha ao guardar (cifra ou banco) → 500 no formato da API, sem auditar e sem a chave no log", async () => {
    estado.falhaAoGuardar = new Error(`falhou com ${CHAVE}`);
    const r = await PUT(pedido({ chave: CHAVE }));
    expect(r.status).toBe(500);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("internal_error");
    expect(JSON.stringify(corpo)).not.toContain(CHAVE);
    expect(audit).not.toHaveBeenCalled();
    expect(vi.mocked(logger).error).toHaveBeenCalledTimes(1);
    expect(tudoQueFoiLogado()).not.toContain(CHAVE);
  });

  it("corpo inválido → 422, sem ir à ElevenLabs nem gravar", async () => {
    const r = await PUT(pedido({ chave: "curta" }));
    expect(r.status).toBe(422);
    expect(listarVozes).not.toHaveBeenCalled();
    expect(guardarChaveDeVoz).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/telefonia/voz/chave", () => {
  it("gerente lê o estado — sem a chave", async () => {
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(await r.json()).toMatchObject({ data: { cadastrada: true, last4: "1234" } });
    expect(vi.mocked(estadoDaChaveDeVoz).mock.calls[0]![1]).toBe(ORG_DA_SESSAO);
  });
});
