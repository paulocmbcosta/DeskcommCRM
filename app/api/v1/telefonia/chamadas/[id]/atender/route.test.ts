// @vitest-environment node
/**
 * A ROTA DE "ATENDER" DA FILA DO TELEFONE (entrega 3; migration 0296): confere,
 * grava a ordem e só então a emite ao worker; a ordem que não sai não deixa a
 * linha aberta; cada recusa tem o seu status e a sua frase; a auditoria só existe
 * quando a ordem saiu.
 *
 * O papel e a guarda de suporte são os DE VERDADE (`requireRole`,
 * `requireSupportWrite`): o que é dublê é a sessão por baixo deles — quem está
 * logado e que papel o banco devolve. Assim "viewer não puxa ligação" é medido
 * na decisão de produção, e não num dublê que devolve o que o teste mandou.
 *
 * As regras do pedido em si (a ligação desta organização, viva, na fila; o ramal
 * de quem pede; a corrida) são medidas no Postgres real em
 * tests/invariants/telefonia-pedido-da-fila.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloDoPedido from "@/lib/channels/telefonia/pedido-da-fila";

const ids = vi.hoisted(() => ({
  ORG: "22222222-2222-4222-8222-222222222222",
  OUTRA_ORG: "99999999-9999-4999-8999-999999999999",
  ANA: "11111111-1111-4111-8111-111111111111",
  VC: "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab",
  ORDEM: "7e000000-0000-4000-8000-000000000001",
  TIME: "44444444-4444-4444-8444-444444444444",
}));
const { ORG, OUTRA_ORG, ANA, VC, ORDEM, TIME } = ids;

type Pedido = { ok: true; id: string; timeId: string | null } | { ok: false; motivo: string; por?: string | null };

const estado = vi.hoisted(() => ({
  /** O papel que o BANCO devolve para quem está logado (`fn_user_role_in_org`). */
  papel: "agent" as string | null,
  idioma: "pt-BR",
  suporte: null as unknown,
  ari: true,
  endpoints: [] as Array<{ resource: string; state: string }>,
  pedido: null as unknown,
  emitidos: [] as Array<[string, Record<string, string>]>,
  emitirFalha: false,
  recusados: [] as unknown[][],
  pedidos: [] as unknown[][],
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: ids.ANA,
    email: "ana@exemplo.com",
    full_name: "Ana",
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
    async pedir() {
      return estado.endpoints;
    }
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
    pedirAtender: vi.fn(async (...args: unknown[]) => {
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
import { DICIONARIO } from "@/lib/i18n/dicionario";

import { POST } from "./route";

const POOL = { pool: "da-rota" };
const atender = (id: string = VC, corpo?: unknown) =>
  POST(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/chamadas/${id}/atender`, {
      method: "POST",
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    }),
    { params: Promise.resolve({ id }) },
  );
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
/** As linhas de auditoria que NÃO são a recusa de papel do `requireRole`. */
const auditadas = () => vi.mocked(audit).mock.calls.map((c) => c[0]).filter((l) => l.action !== "authz.denied");

beforeEach(() => {
  estado.papel = "agent";
  estado.idioma = "pt-BR";
  estado.suporte = null;
  estado.ari = true;
  estado.endpoints = [{ resource: `ramal-${ANA}`, state: "online" }];
  estado.pedido = { ok: true, id: ORDEM, timeId: TIME } satisfies Pedido;
  estado.emitidos = [];
  estado.emitirFalha = false;
  estado.recusados = [];
  estado.pedidos = [];
  vi.mocked(audit).mockClear();
  vi.mocked(getRequestPool).mockClear();
});

describe("POST /telefonia/chamadas/[id]/atender", () => {
  it("aceita (202), emite a ordem com a ação e os ids, e audita", async () => {
    const r = await atender();
    expect(r.status).toBe(202);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ ordem_id: ORDEM });
    expect(estado.emitidos).toEqual([["telefonia_fila", { acao: "atender", ordem_id: ORDEM, voice_call_id: VC }]]);

    expect(auditadas()).toHaveLength(1);
    const linha = auditadas()[0]!;
    expect(linha).toMatchObject({
      action: "phone.queue_call_pulled",
      actorUserId: ANA,
      organizationId: ORG,
      resourceType: "voice_call",
      resourceId: VC,
      metadata: { ordem_id: ORDEM, time_id: TIME },
    });
    expect(linha.requestId).toBe(r.headers.get("X-Request-Id"));
  });

  it("a organização e quem pede vêm da SESSÃO; o ramal online, da ARI — o corpo não é nem lido", async () => {
    const r = await atender(VC, { organization_id: OUTRA_ORG, user_id: OUTRA_ORG, voice_call_id: OUTRA_ORG });
    expect(r.status).toBe(202);
    expect(estado.pedidos).toHaveLength(1);
    const [db, p] = estado.pedidos[0] as [unknown, { org: string; userId: string; vcId: string; online: Set<string> }];
    expect(db).toEqual(POOL);
    expect({ org: p.org, userId: p.userId, vcId: p.vcId }).toEqual({ org: ORG, userId: ANA, vcId: VC });
    expect([...p.online]).toEqual([ANA]);
    expect(Object.keys(p).sort()).toEqual(["online", "org", "userId", "vcId"]);
    expect(JSON.stringify(estado.pedidos) + JSON.stringify(estado.emitidos) + JSON.stringify(auditadas())).not.toContain(OUTRA_ORG);
  });

  it("viewer não puxa ligação: 403 pelo papel, sem pedir, emitir nem auditar a ação", async () => {
    estado.papel = "viewer";
    const r = await atender();
    expect(r.status).toBe(403);
    expect((await erroDe(r)).code).toBe("forbidden_role");
    expect(estado.pedidos).toEqual([]);
    expect(estado.emitidos).toEqual([]);
    expect(auditadas()).toEqual([]);
    // A recusa de papel fica registrada com o recurso desta rota.
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "authz.denied",
      resourceType: "telefonia_fila",
      metadata: { required_role: "agent", effective_role: "viewer" },
    });
  });

  it.each(["agent", "manager", "admin"])("%s puxa", async (papel) => {
    estado.papel = papel;
    expect((await atender()).status).toBe(202);
  });

  it("suporte somente-leitura: barrado ANTES de qualquer coisa", async () => {
    estado.papel = "admin";
    estado.suporte = { status: "active", access_mode: "support_readonly", organization_id: ORG };
    const r = await atender();
    expect(r.status).toBe(403);
    expect((await erroDe(r)).code).toBe("forbidden");
    expect(getRequestPool).not.toHaveBeenCalled();
    expect(estado.pedidos).toEqual([]);
    expect(estado.emitidos).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("a ordem que não sai: a linha é fechada (não trava a próxima) e responde 503, sem auditoria", async () => {
    estado.emitirFalha = true;
    const r = await atender();
    expect(r.status).toBe(503);
    expect(await erroDe(r)).toEqual({
      code: "telefonia_indisponivel",
      message: "A telefonia não respondeu. Tente de novo em instantes.",
    });
    // Fechada com a organização DA SESSÃO e o id da ordem que acabou de ser gravada.
    expect(estado.recusados).toEqual([[POOL, ORG, ORDEM]]);
    expect(auditadas()).toEqual([]);
  });

  it.each<[RecusaDaFila, number]>([
    ["ligacao_inexistente", 404],
    ["ligacao_encerrada", 409],
    ["ligacao_ja_atendida", 409],
    ["ligacao_fora_da_fila", 409],
    ["voce_offline", 409],
    ["voce_em_ligacao", 409],
    ["ja_ha_ordem", 409],
  ])("recusa %s → %i, com a frase dela, sem emitir nem auditar", async (motivo, status) => {
    estado.pedido = { ok: false, motivo } satisfies Pedido;
    const r = await atender();
    expect(r.status).toBe(status);
    expect(statusDaRecusaDaFila(motivo)).toBe(status);
    expect(await erroDe(r)).toEqual({ code: motivo, message: MENSAGEM_DA_RECUSA_DA_FILA[motivo] });
    expect(estado.emitidos).toEqual([]);
    expect(estado.recusados).toEqual([]);
    expect(auditadas()).toEqual([]);
  });

  it("outra pessoa já puxou: a frase diz QUEM — e o nome entra literal, sem `$&` virar outra coisa", async () => {
    estado.pedido = { ok: false, motivo: "ja_ha_ordem", por: "Bia $& Souza" } satisfies Pedido;
    const r = await atender();
    expect(r.status).toBe(409);
    expect(await erroDe(r)).toEqual({ code: "ja_ha_ordem", message: "Bia $& Souza já está atendendo esta ligação." });
  });

  it("sem o nome de quem puxou (`por` nulo), a frase geral", async () => {
    estado.pedido = { ok: false, motivo: "ja_ha_ordem", por: null } satisfies Pedido;
    expect((await erroDe(await atender())).message).toBe("Outra pessoa já está cuidando desta ligação.");
  });

  it("id que não é uuid: 404, sem chegar ao banco", async () => {
    const r = await atender("nao-e-uuid");
    expect(r.status).toBe(404);
    expect(await erroDe(r)).toEqual({ code: "not_found", message: "Ligação não encontrada." });
    expect(estado.pedidos).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it("instalação sem telefonia: 409, sem chegar ao banco", async () => {
    estado.ari = false;
    const r = await atender();
    expect(r.status).toBe(409);
    expect((await erroDe(r)).code).toBe("telefonia_indisponivel");
    expect(estado.pedidos).toEqual([]);
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it("quem usa em espanhol lê a recusa em espanhol", async () => {
    estado.idioma = "es";
    estado.pedido = { ok: false, motivo: "voce_em_ligacao" } satisfies Pedido;
    expect((await erroDe(await atender())).message).toBe(DICIONARIO["Você está em outra ligação."]!.es);
    estado.pedido = { ok: false, motivo: "ja_ha_ordem", por: "Bia" } satisfies Pedido;
    expect((await erroDe(await atender())).message).toBe("Bia ya está atendiendo esta llamada.");
  });
});

describe("as frases das recusas da fila", () => {
  // `app/api` fica fora da varredura de tests/unit/i18n-espanhol-cobre-a-tela, e a
  // tabela das frases não é chamada por `t()` no arquivo dela: sem este caso, uma
  // recusa nova sairia em português para quem escolheu espanhol, com tudo verde.
  it("toda recusa tem a frase em espanhol", () => {
    const semEspanhol = Object.values(MENSAGEM_DA_RECUSA_DA_FILA).filter((frase) => !DICIONARIO[frase]?.es);
    expect(semEspanhol).toEqual([]);
    expect(Object.keys(MENSAGEM_DA_RECUSA_DA_FILA).length).toBeGreaterThanOrEqual(10);
  });
});
