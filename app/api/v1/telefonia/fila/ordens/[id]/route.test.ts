// @vitest-environment node
/**
 * O DESFECHO DE UMA ORDEM DA FILA PELA ROTA (entrega 3; migration 0296): a tela
 * de quem clicou em "Atender" ou "Mover" pergunta por aqui o que o worker fez.
 *
 * Quem lê é quem PEDIU a ordem, ou gerente/admin; para qualquer outra pessoa — e
 * para a ordem de outra organização — a resposta é a mesma do que não existe
 * (404). A organização é a da SESSÃO: é com ela que a leitura vai ao banco. A
 * resposta leva só o tipo, a situação, o desfecho e o motivo.
 *
 * O papel é o DE VERDADE (`requireRole` sobre uma sessão dublada). O SQL da
 * leitura — preso à organização — é provado no Postgres real em
 * tests/invariants/telefonia-pedido-da-fila.test.ts; aqui ele é uma porta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloDoPedido from "@/lib/channels/telefonia/pedido-da-fila";

const ids = vi.hoisted(() => ({
  ORG: "22222222-2222-4222-8222-222222222222",
  EU: "11111111-1111-4111-8111-111111111111",
  BIA: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ORDEM: "7e000000-0000-4000-8000-000000000003",
  VENDAS: "55555555-5555-4555-8555-555555555555",
}));
const { ORG, EU, BIA, ORDEM, VENDAS } = ids;

interface Ordem {
  id: string;
  kind: "pull" | "move";
  status: "open" | "ended";
  outcome: string | null;
  reason: string | null;
  requested_by: string | null;
  to_team_id: string | null;
}

const estado = vi.hoisted(() => ({
  /** O papel que o BANCO devolve para quem está logado (`fn_user_role_in_org`). */
  papel: "agent" as string | null,
  ordem: null as unknown,
  leituras: [] as unknown[][],
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: ids.EU,
    email: "eu@exemplo.com",
    full_name: "Eu",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ids.ORG, organization_name: "Org", role: estado.papel }],
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ids.ORG, name: "Org", role: estado.papel })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: async () => ({ data: estado.papel, error: null }) })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/pedido-da-fila", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoPedido>();
  return {
    ...real,
    lerOrdemParaATela: vi.fn(async (...args: unknown[]) => {
      estado.leituras.push(args);
      return estado.ordem;
    }),
  };
});

import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

import { GET } from "./route";

const POOL = { pool: "da-rota" };
const ler = (id: string = ORDEM) =>
  GET(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/fila/ordens/${id}`), { params: Promise.resolve({ id }) });
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const ordem = (o: Partial<Ordem> = {}): Ordem => ({
  id: ORDEM,
  kind: "pull",
  status: "open",
  outcome: null,
  reason: null,
  requested_by: EU,
  to_team_id: null,
  ...o,
});
const NAO_ENCONTRADA = { code: "not_found", message: "Pedido não encontrado." };

beforeEach(() => {
  estado.papel = "agent";
  estado.ordem = ordem();
  estado.leituras = [];
  vi.mocked(audit).mockClear();
  vi.mocked(getRequestPool).mockClear();
});

describe("GET /telefonia/fila/ordens/[id]", () => {
  it("quem pediu lê a própria ordem — com a organização DA SESSÃO, e só o que a tela precisa", async () => {
    const r = await ler();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({
      id: ORDEM,
      tipo: "pull",
      situacao: "open",
      desfecho: null,
      motivo: null,
    });
    expect(estado.leituras).toEqual([[POOL, ORG, ORDEM]]);
  });

  it("a ordem encerrada volta com o desfecho e o motivo", async () => {
    estado.ordem = ordem({ kind: "move", status: "ended", outcome: "refused", reason: "time_fora_do_horario", to_team_id: VENDAS });
    const r = await ler();
    expect(((await r.json()) as { data: unknown }).data).toEqual({
      id: ORDEM,
      tipo: "move",
      situacao: "ended",
      desfecho: "refused",
      motivo: "time_fora_do_horario",
    });
  });

  it("outro atendente NÃO lê a ordem que não pediu: 404, igual à que não existe", async () => {
    estado.ordem = ordem({ requested_by: BIA });
    const r = await ler();
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual(NAO_ENCONTRADA);
  });

  it("a ordem de quem saiu da equipe (`requested_by` nulo) não é de nenhum atendente", async () => {
    estado.ordem = ordem({ requested_by: null });
    expect((await ler()).status).toBe(404);
  });

  it.each(["manager", "admin"])("%s lê a ordem pedida por outra pessoa", async (papel) => {
    estado.papel = papel;
    estado.ordem = ordem({ requested_by: BIA, status: "ended", outcome: "done" });
    const r = await ler();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { situacao: string; desfecho: string } }).data).toMatchObject({ situacao: "ended", desfecho: "done" });
  });

  it("ordem de outra organização (a leitura, presa à da sessão, não a acha): 404 — até para o admin", async () => {
    estado.papel = "admin";
    estado.ordem = null;
    const r = await ler();
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual(NAO_ENCONTRADA);
    expect(estado.leituras).toEqual([[POOL, ORG, ORDEM]]);
  });

  it("viewer não lê ordem: 403 pelo papel, sem chegar ao banco", async () => {
    estado.papel = "viewer";
    const r = await ler();
    expect(r.status).toBe(403);
    expect((await erroDe(r)).code).toBe("forbidden_role");
    expect(estado.leituras).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it("id que não é uuid: 404, sem chegar ao banco", async () => {
    const r = await ler("nao-e-uuid");
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual(NAO_ENCONTRADA);
    expect(estado.leituras).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it("ler não é mutação: nada auditado", async () => {
    await ler();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
