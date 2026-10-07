// @vitest-environment node
/**
 * A ROTA DE "MOVER PARA OUTRO TIME" DA FILA DO TELEFONE (entrega 3; migration
 * 0296): gerente ou admin; confere, grava a ordem e só então a emite ao worker; a
 * ordem que não sai não deixa a linha aberta; cada recusa tem o seu status e a
 * sua frase; a auditoria só existe quando a ordem saiu, com o time de onde e o
 * para onde.
 *
 * O papel e a guarda de suporte são os DE VERDADE (`requireRole`,
 * `requireSupportWrite`), sobre uma sessão dublada — como na rota de atender. O
 * Zod do corpo também é o da rota: `{ team_id }` e mais nada, e um
 * `organization_id` ali é 422 antes de qualquer consulta.
 *
 * As regras do pedido em si (a ligação e o time desta organização, o horário, a
 * corrida) são medidas no Postgres real em
 * tests/invariants/telefonia-pedido-da-fila.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloDoPedido from "@/lib/channels/telefonia/pedido-da-fila";

const ids = vi.hoisted(() => ({
  ORG: "22222222-2222-4222-8222-222222222222",
  OUTRA_ORG: "99999999-9999-4999-8999-999999999999",
  EVA: "11111111-1111-4111-8111-111111111111",
  VC: "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab",
  ORDEM: "7e000000-0000-4000-8000-000000000002",
  SUPORTE: "44444444-4444-4444-8444-444444444444",
  VENDAS: "55555555-5555-4555-8555-555555555555",
}));
const { ORG, OUTRA_ORG, EVA, VC, ORDEM, SUPORTE, VENDAS } = ids;

type Pedido = { ok: true; id: string; deTimeId: string | null } | { ok: false; motivo: string; por?: string | null };

const estado = vi.hoisted(() => ({
  /** O papel que o BANCO devolve para quem está logado (`fn_user_role_in_org`). */
  papel: "manager" as string | null,
  idioma: "pt-BR",
  suporte: null as unknown,
  ari: true,
  pedido: null as unknown,
  emitidos: [] as Array<[string, Record<string, string>]>,
  emitirFalha: false,
  recusados: [] as unknown[][],
  pedidos: [] as unknown[][],
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: ids.EVA,
    email: "eva@exemplo.com",
    full_name: "Eva",
    avatar_url: null,
    is_platform_admin: false,
    idioma: estado.idioma,
    organizations: [{ organization_id: ids.ORG, organization_name: "Org", role: estado.papel }],
    support: estado.suporte,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ids.ORG, name: "Org", role: estado.papel })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: async () => ({ data: estado.papel, error: null }) })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({
  configAriDoAmbiente: () => (estado.ari ? { baseUrl: "http://telefonia:8088", senha: "x" } : null),
  ClienteAri: class {
    async emitirEvento(nome: string, v: Record<string, string>) {
      if (estado.emitirFalha) throw new Error("ari fora");
      estado.emitidos.push([nome, v]);
    }
  },
}));
vi.mock("@/lib/channels/telefonia/pedido-da-fila", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoPedido>();
  return {
    ...real,
    pedirMover: vi.fn(async (...args: unknown[]) => {
      estado.pedidos.push(args);
      return estado.pedido;
    }),
    recusarOrdemSemWorker: vi.fn(async (...args: unknown[]) => {
      estado.recusados.push(args);
    }),
  };
});

import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { MENSAGEM_DA_RECUSA_DA_FILA, statusDaRecusaDaFila, type RecusaDaFila } from "@/lib/channels/telefonia/pedido-da-fila";

import { POST } from "./route";

const POOL = { pool: "da-rota" };
const mover = (corpo: unknown, id: string = VC) =>
  POST(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/chamadas/${id}/mover`, {
      method: "POST",
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id }) },
  );
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
/** As linhas de auditoria que NÃO são a recusa de papel do `requireRole`. */
const auditadas = () => vi.mocked(audit).mock.calls.map((c) => c[0]).filter((l) => l.action !== "authz.denied");

beforeEach(() => {
  estado.papel = "manager";
  estado.idioma = "pt-BR";
  estado.suporte = null;
  estado.ari = true;
  estado.pedido = { ok: true, id: ORDEM, deTimeId: SUPORTE } satisfies Pedido;
  estado.emitidos = [];
  estado.emitirFalha = false;
  estado.recusados = [];
  estado.pedidos = [];
  vi.mocked(audit).mockClear();
  vi.mocked(getRequestPool).mockClear();
});

describe("POST /telefonia/chamadas/[id]/mover", () => {
  it("aceita (202), emite a ordem com a ação e os ids, e audita de onde para onde", async () => {
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(202);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ ordem_id: ORDEM });
    expect(estado.emitidos).toEqual([["telefonia_fila", { acao: "mover", ordem_id: ORDEM, voice_call_id: VC }]]);

    expect(auditadas()).toHaveLength(1);
    const linha = auditadas()[0]!;
    expect(linha).toMatchObject({
      action: "phone.queue_call_moved",
      actorUserId: EVA,
      organizationId: ORG,
      resourceType: "voice_call",
      resourceId: VC,
      metadata: { ordem_id: ORDEM, de_time_id: SUPORTE, para_time_id: VENDAS },
    });
    expect(linha.requestId).toBe(r.headers.get("X-Request-Id"));
  });

  it("a organização e quem pede vêm da SESSÃO; do corpo, só o time", async () => {
    await mover({ team_id: VENDAS });
    expect(estado.pedidos).toHaveLength(1);
    const [db, p] = estado.pedidos[0] as [unknown, { org: string; userId: string; vcId: string; teamId: string; agora: Date }];
    expect(db).toEqual(POOL);
    expect({ org: p.org, userId: p.userId, vcId: p.vcId, teamId: p.teamId }).toEqual({ org: ORG, userId: EVA, vcId: VC, teamId: VENDAS });
    expect(p.agora).toBeInstanceOf(Date);
    expect(Object.keys(p).sort()).toEqual(["agora", "org", "teamId", "userId", "vcId"]);
  });

  it.each([
    ["a organização no corpo (o corpo não troca a organização)", { team_id: ids.VENDAS, organization_id: ids.OUTRA_ORG }],
    ["quem pede no corpo", { team_id: ids.VENDAS, user_id: ids.OUTRA_ORG }],
    ["a ligação no corpo", { team_id: ids.VENDAS, voice_call_id: ids.OUTRA_ORG }],
    ["sem o time", {}],
    ["time que não é uuid", { team_id: "vendas" }],
    ["time nulo", { team_id: null }],
    ["corpo que não é JSON", "<html>"],
  ])("corpo inválido — %s → 422, sem chegar ao banco, emitir nem auditar", async (_nome, corpo) => {
    const r = await mover(corpo);
    expect(r.status).toBe(422);
    expect(await erroDe(r)).toEqual({ code: "validation_failed", message: "Escolha para qual time mover." });
    expect(estado.pedidos).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(estado.emitidos).toEqual([]);
    expect(auditadas()).toEqual([]);
  });

  it.each(["viewer", "agent"])("%s não move ligação: 403 pelo papel, sem pedir, emitir nem auditar a ação", async (papel) => {
    estado.papel = papel;
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(403);
    expect((await erroDe(r)).code).toBe("forbidden_role");
    expect(estado.pedidos).toEqual([]);
    expect(estado.emitidos).toEqual([]);
    expect(auditadas()).toEqual([]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "authz.denied",
      resourceType: "telefonia_fila",
      metadata: { required_role: "manager", effective_role: papel },
    });
  });

  it.each(["manager", "admin"])("%s move", async (papel) => {
    estado.papel = papel;
    expect((await mover({ team_id: VENDAS })).status).toBe(202);
  });

  it("suporte somente-leitura: barrado ANTES de qualquer coisa", async () => {
    estado.papel = "admin";
    estado.suporte = { status: "active", access_mode: "support_readonly", organization_id: ORG };
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(403);
    expect((await erroDe(r)).code).toBe("forbidden");
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(estado.pedidos).toEqual([]);
    expect(estado.emitidos).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("a ordem que não sai: a linha é fechada (não trava a próxima) e responde 503, sem auditoria", async () => {
    estado.emitirFalha = true;
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(503);
    expect(await erroDe(r)).toEqual({
      code: "telefonia_indisponivel",
      message: "A telefonia não respondeu. Tente de novo em instantes.",
    });
    expect(estado.recusados).toEqual([[POOL, ORG, ORDEM]]);
    expect(auditadas()).toEqual([]);
  });

  it.each<[RecusaDaFila, number]>([
    ["ligacao_inexistente", 404],
    ["ligacao_encerrada", 409],
    ["ligacao_ja_atendida", 409],
    ["ligacao_fora_da_fila", 409],
    ["ja_ha_ordem", 409],
    ["destino_invalido", 422],
    ["ja_esta_nesse_time", 409],
    ["time_fora_do_horario", 409],
  ])("recusa %s → %i, com a frase dela, sem emitir nem auditar", async (motivo, status) => {
    estado.pedido = { ok: false, motivo } satisfies Pedido;
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(status);
    expect(statusDaRecusaDaFila(motivo)).toBe(status);
    expect(await erroDe(r)).toEqual({ code: motivo, message: MENSAGEM_DA_RECUSA_DA_FILA[motivo] });
    expect(estado.emitidos).toEqual([]);
    expect(estado.recusados).toEqual([]);
    expect(auditadas()).toEqual([]);
  });

  it("alguém já está puxando a ligação: a frase diz QUEM", async () => {
    estado.pedido = { ok: false, motivo: "ja_ha_ordem", por: "Bia" } satisfies Pedido;
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(409);
    expect(await erroDe(r)).toEqual({ code: "ja_ha_ordem", message: "Bia já está atendendo esta ligação." });
  });

  it("id que não é uuid: 404, sem chegar ao banco", async () => {
    const r = await mover({ team_id: VENDAS }, "nao-e-uuid");
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual({ code: "not_found", message: "Ligação não encontrada." });
    expect(estado.pedidos).toEqual([]);
  });

  it("instalação sem telefonia: 409, sem chegar ao banco", async () => {
    estado.ari = false;
    const r = await mover({ team_id: VENDAS });
    expect(r.status).toBe(409);
    expect((await erroDe(r)).code).toBe("telefonia_indisponivel");
    expect(estado.pedidos).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it("o corpo não leva a outra organização a lugar nenhum", async () => {
    await mover({ team_id: VENDAS, organization_id: OUTRA_ORG });
    expect(JSON.stringify(estado.pedidos) + JSON.stringify(estado.emitidos) + JSON.stringify(auditadas())).not.toContain(OUTRA_ORG);
  });
});
