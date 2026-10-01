// @vitest-environment node
/**
 * A ROTA DA TRANSFERÊNCIA (desenho §12.4): confere, grava o pedido e só então
 * emite a ordem ao worker; a ordem que não sai não deixa a linha aberta; cada
 * recusa tem o seu status; a auditoria só existe quando a ordem saiu. As regras
 * do pedido em si (ligação, permissão, D17) são medidas no Postgres real em
 * tests/invariants/telefonia-pedido-de-transferencia.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloDoPedido from "@/lib/channels/telefonia/pedido-de-transferencia";

const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
const BIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T1 = "7e000000-0000-4000-8000-000000000001";

const estado = vi.hoisted(() => ({
  ari: true,
  pedido: { ok: true, id: "7e000000-0000-4000-8000-000000000001", kind: "blind", fromUserId: "11111111-1111-4111-8111-111111111111" } as
    | { ok: true; id: string; kind: string; fromUserId: string }
    | { ok: false; motivo: string },
  emitidos: [] as Array<[string, Record<string, string>]>,
  emitirFalha: false,
  recusados: [] as string[],
  pedidos: [] as unknown[],
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({
  configAriDoAmbiente: () => (estado.ari ? { baseUrl: "http://telefonia:8088", senha: "x" } : null),
  ClienteAri: class {
    async pedir() {
      return [];
    }
    async emitirEvento(nome: string, v: Record<string, string>) {
      if (estado.emitirFalha) throw new Error("ari fora");
      estado.emitidos.push([nome, v]);
    }
  },
}));
vi.mock("@/lib/channels/telefonia/pedido-de-transferencia", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoPedido>();
  return {
    ...real,
    pedirTransferencia: vi.fn(async (_db: unknown, p: unknown) => {
      estado.pedidos.push(p);
      return estado.pedido;
    }),
    recusarPedidoSemWorker: vi.fn(async (_db: unknown, _org: string, id: string) => {
      estado.recusados.push(id);
    }),
  };
});

import { audit } from "@/lib/audit";

import { POST } from "./route";

const transferir = (corpo: unknown, id = VC) =>
  POST(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/chamadas/${id}/transferir`, {
      method: "POST",
      body: JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  estado.ari = true;
  estado.pedido = { ok: true, id: T1, kind: "blind", fromUserId: "11111111-1111-4111-8111-111111111111" };
  estado.emitidos = [];
  estado.emitirFalha = false;
  estado.recusados = [];
  estado.pedidos = [];
  vi.mocked(audit).mockClear();
});

describe("POST /telefonia/chamadas/[id]/transferir", () => {
  it("aceita (202), emite a ordem com os ids e audita", async () => {
    const r = await transferir({ modo: "direta", para: { user_id: BIA } });
    expect(r.status).toBe(202);
    expect(estado.emitidos).toEqual([["telefonia_transferencia", { acao: "transferir", transferencia_id: T1, voice_call_id: VC }]]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "phone.call_transferred", resourceId: VC }));
    // A organização e o papel vêm da SESSÃO.
    expect(estado.pedidos[0]).toMatchObject({ org: "22222222-2222-4222-8222-222222222222", papel: "agent", vcId: VC });
  });

  it("a ordem que não sai: a linha é recusada (não trava a próxima) e responde 503, sem auditoria", async () => {
    estado.emitirFalha = true;
    const r = await transferir({ modo: "direta", para: { user_id: BIA } });
    expect(r.status).toBe(503);
    expect(estado.recusados).toEqual([T1]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it.each([
    ["ligacao_inexistente", 404],
    ["sem_permissao", 403],
    ["consultada_so_para_pessoa", 422],
    ["destino_em_pausa", 409],
    ["time_fora_do_horario", 409],
    ["ja_ha_transferencia", 409],
  ])("recusa %s → %i, com a mensagem, sem emitir", async (motivo, status) => {
    estado.pedido = { ok: false, motivo };
    const r = await transferir({ modo: "direta", para: { user_id: BIA } });
    expect(r.status).toBe(status);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe(motivo);
    expect(corpo.error.message.length).toBeGreaterThan(5);
    expect(estado.emitidos).toEqual([]);
  });

  it("corpo inválido: 422 (destino com as duas chaves, modo desconhecido, id que não é uuid)", async () => {
    expect((await transferir({ modo: "direta", para: { user_id: BIA, team_id: BIA } })).status).toBe(422);
    expect((await transferir({ modo: "conferencia", para: { user_id: BIA } })).status).toBe(422);
    expect((await transferir({ modo: "direta", para: { user_id: "x" } })).status).toBe(422);
    expect(estado.pedidos).toEqual([]);
  });

  it("instalação sem telefonia: 409", async () => {
    estado.ari = false;
    expect((await transferir({ modo: "direta", para: { user_id: BIA } })).status).toBe(409);
  });
});
