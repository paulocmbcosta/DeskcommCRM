// @vitest-environment node
/**
 * O "SALVAR E USAR" DA FALA GERAL PELA ROTA: tipo fora da lista não existe; admin;
 * o corpo traz texto e hash (nunca caminho nem organização); a gravação sob a
 * trava (`salvarFalaGeral`) recebe a organização da SESSÃO; a fala salva é
 * auditada e a mesma fala de novo não; o texto recusado pela nossa régua não culpa
 * a ElevenLabs; e a rota nem CARREGA o cliente da ElevenLabs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloFalas from "@/lib/telefonia/falas";

const ORG = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const HASH = "b".repeat(64);
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
// Salvar não pode nem CARREGAR o cliente da ElevenLabs: só a rota da prévia o usa.
vi.mock("@/lib/telefonia/elevenlabs", () => {
  throw new Error("o Salvar e usar carregou o cliente da ElevenLabs");
});
vi.mock("@/lib/telefonia/servico-de-falas", () => ({
  STATUS_DA_FALHA: { previa_ausente: 422, previa_desatualizada: 422, sem_voz: 422, armazenamento: 502, texto_recusado: 422 },
  armazemDaInstalacao: vi.fn(() => ({ marca: "armazem" })),
}));
vi.mock("@/lib/telefonia/falas", async () => ({
  ...(await vi.importActual<typeof ModuloFalas>("@/lib/telefonia/falas")),
  salvarFalaGeral: vi.fn(async () => estado.resultado),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { salvarFalaGeral } from "@/lib/telefonia/falas";

import { PUT } from "./route";

const FALA = {
  id: "33333333-3333-4333-8333-333333333333",
  tipo: "after_hours",
  texto: "Aguarde.",
  voice_id: "v1",
  hash: HASH,
  status: "ready",
  erro: null,
  duracao_ms: 900,
  atualizada_em: "2026-09-28T13:00:00.000Z",
};
const chamar = (tipo: string, corpo: unknown = { texto: "Aguarde.", hash: HASH }) =>
  PUT(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/falas/gerais/${tipo}`, { method: "PUT", body: JSON.stringify(corpo) }),
    { params: Promise.resolve({ tipo }) },
  );
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

beforeEach(() => {
  estado.resultado = { ok: true, fala: FALA, mudou: true };
  vi.mocked(audit).mockClear();
  vi.mocked(salvarFalaGeral).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

describe("PUT /api/v1/telefonia/falas/gerais/[tipo]", () => {
  it("só admin, e com a guarda de suporte", async () => {
    await chamar("waiting");
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(requireSupportWrite).toHaveBeenCalled();
  });

  it("tipo que não é fala geral → 404, sem salvar nada", async () => {
    for (const tipo of ["menu", "emergency", "invalid", "../waiting", "WAITING"]) {
      const r = await chamar(tipo);
      expect(r.status, tipo).toBe(404);
    }
    expect(salvarFalaGeral).not.toHaveBeenCalled();
  });

  it("grava sob a trava com a organização e o usuário da SESSÃO, o pool da rota e o tipo do caminho; audita", async () => {
    const r = await chamar("after_hours");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { fala: { id: FALA.id, hash: HASH } } });
    expect(vi.mocked(salvarFalaGeral).mock.calls[0]![0]).toMatchObject({
      pool: POOL,
      armazem: { marca: "armazem" },
      organizationId: ORG,
      userId: USUARIO,
      tipo: "after_hours",
      texto: "Aguarde.",
      hash: HASH,
    });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.prompt_saved",
      organizationId: ORG,
      resourceType: "phone_prompt",
      resourceId: FALA.id,
      metadata: { tipo: "after_hours", hash: HASH },
    });
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toContain("Aguarde.");
  });

  it("a mesma fala de novo (nada mudou): 200, sem auditar", async () => {
    estado.resultado = { ok: true, fala: FALA, mudou: false };
    const r = await chamar("waiting");
    expect(r.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a prévia não está no Storage da organização: 422 previa_ausente, e nada é auditado", async () => {
    estado.resultado = { ok: false, motivo: "previa_ausente" };
    const r = await chamar("nobody");
    expect(r.status).toBe(422);
    const e = await erroDe(r);
    expect(e.code).toBe("previa_ausente");
    expect(e.message).toMatch(/Gere a prévia de novo/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("o Storage falhou ao conferir: 502 armazenamento", async () => {
    estado.resultado = { ok: false, motivo: "armazenamento" };
    expect((await chamar("waiting")).status).toBe(502);
  });

  it("texto recusado pela NOSSA régua (vazio, longo, NUL): mensagem própria, nunca 'a ElevenLabs recusou'", async () => {
    for (const texto of ["   ", "x".repeat(1001), "Oi\u0000."]) {
      const r = await chamar("waiting", { texto, hash: HASH });
      expect(r.status).toBe(422);
      const e = await erroDe(r);
      expect(e.code).toBe("validation_failed");
      expect(e.message).toMatch(/^Texto inválido/);
      expect(e.message).not.toMatch(/ElevenLabs/);
    }
    expect(salvarFalaGeral).not.toHaveBeenCalled();
    // E se a régua da gravação recusar (defesa em profundidade), a mensagem é a mesma.
    estado.resultado = { ok: false, motivo: "texto_recusado" };
    const e = await erroDe(await chamar("waiting"));
    expect(e.message).toMatch(/^Texto inválido/);
  });

  it("corpo com caminho ou organização (campo a mais) ou hash fora da régua → 422 genérico, sem salvar", async () => {
    for (const corpo of [
      { texto: "Aguarde.", hash: HASH, caminho: `outra/${HASH}.ulaw` },
      { texto: "Aguarde.", hash: HASH, organization_id: "44444444-4444-4444-8444-444444444444" },
      { texto: "Aguarde.", hash: "x" },
      { texto: "Aguarde.", hash: `../${HASH}` },
    ]) {
      const r = await chamar("waiting", corpo);
      expect(r.status).toBe(422);
      expect((await erroDe(r)).message).toBe("Campos inválidos.");
    }
    expect(salvarFalaGeral).not.toHaveBeenCalled();
  });
});
