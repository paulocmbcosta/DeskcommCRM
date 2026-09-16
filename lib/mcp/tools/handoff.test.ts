/**
 * `crm_request_human_handoff` com destino de TIME (setor), contra o handler REAL.
 *
 * O caso que manda neste arquivo é o PRIMEIRO: **slug inválido não muta nada**.
 * A ordem da validação é a regra — se ela acontecesse depois do `triggerHandoff`,
 * a conversa ficaria em `pending`, com o bot silenciado, sem destino e sem
 * ninguém avisado. Recusar é melhor: o modelo recebe `available_teams` e se
 * corrige sozinho na chamada seguinte. A prova é por AUSÊNCIA de efeito
 * (orquestrador não chamado, nenhum `update`), nunca pelo texto do retorno.
 *
 * Os outros dois casos prendem o que o typecheck não pega:
 *  - `teamId` chega ao escopo dos elegíveis E ao `getQueuePosition` — o segundo
 *    tem o parâmetro OPCIONAL, então esquecê-lo compila e faz o cliente de um
 *    setor ouvir a posição da fila geral, número errado dito com confiança;
 *  - sem `team`, nada muda: nenhuma consulta a `attendance_teams`, nenhum
 *    `teamId` no escopo. Uma feature nova que altera o caminho de quem não a
 *    usa é regressão para toda instalação que não tem time nenhum.
 *
 * `triggerHandoff` é dublê (os efeitos dele têm teste próprio); `eligibles` e
 * `queue` são espiões que devolvem o real dublado — é o argumento que se mede,
 * não o efeito no banco, que é coisa de Postgres de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { getQueuePosition } from "@/lib/routing/queue";
import type { McpContext } from "@/lib/mcp/types";

import { crmRequestHumanHandoff } from "./handoff";

vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/routing/eligibles", () => ({ loadEligibleAttendants: vi.fn() }));
vi.mock("@/lib/routing/queue", () => ({ getQueuePosition: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const TIME_FINANCEIRO = "66666666-6666-4666-8666-666666666666";
const ANA = "11111111-1111-4111-8111-111111111111";

interface Efeitos {
  updates: Array<{ tabela: string; valores: Record<string, unknown> }>;
  inserts: Array<{ tabela: string; valores: unknown }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  /** Toda tabela tocada, na ordem — é como se vê a consulta que NÃO devia existir. */
  tabelas: string[];
}

interface Cenario {
  /** Times não arquivados da org, por slug. */
  times?: Array<{ id: string; slug: string; name: string; description: string }>;
  claim?: string;
}

function fazerCtx(cenario: Cenario, efeitos: Efeitos): McpContext {
  const times = cenario.times ?? [];

  const from = (tabela: string) => {
    efeitos.tabelas.push(tabela);
    const filtros: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return chain;
      },
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (valores: Record<string, unknown>) => {
        efeitos.updates.push({ tabela, valores });
        return chain;
      },
      insert: (valores: unknown) => {
        efeitos.inserts.push({ tabela, valores });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => {
        if (tabela === "conversations") {
          return Promise.resolve({
            data: {
              id: CONV,
              organization_id: ORG,
              contact_id: null,
              channel_session_id: CONV,
              last_inbound_at: null,
            },
            error: null,
          });
        }
        if (tabela === "attendance_teams") {
          const alvo = times.find((t) => t.slug === filtros.slug);
          return Promise.resolve({ data: alvo ? { id: alvo.id } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => unknown) => {
        if (tabela === "attendance_teams") {
          // A LISTAGEM do catálogo (carregarTimes), não a busca por slug.
          return Promise.resolve({
            data: times.map((t) => ({ ...t, schedule: {}, archived_at: null })),
            error: null,
          }).then(res);
        }
        if (tabela === "conversations" && efeitos.updates.length) {
          return Promise.resolve({ data: [{ id: CONV }], error: null }).then(res);
        }
        return Promise.resolve({ data: [], error: null }).then(res);
      },
    };
    return chain;
  };

  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "user", id: ANA },
    apiTokenId: "tok",
    requestId: "req",
    supabase: {
      from,
      rpc: (fn: string, args: Record<string, unknown>) => {
        efeitos.rpcs.push({ fn, args });
        return Promise.resolve({
          data: fn === "fn_channel_routing_claim" ? (cenario.claim ?? "assigned") : null,
          error: null,
        });
      },
    },
  } as unknown as McpContext;
}

function efeitosVazios(): Efeitos {
  return { updates: [], inserts: [], rpcs: [], tabelas: [] };
}

const entradaBase = {
  conversation_id: CONV,
  reason: "cliente pediu humano",
  urgency: "normal" as const,
  target_user_id: undefined,
  team: undefined,
  metadata: undefined,
};

const FINANCEIRO = {
  id: TIME_FINANCEIRO,
  slug: "financeiro",
  name: "Financeiro",
  description: "Cobrança, boleto e reembolso.",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(triggerHandoff).mockResolvedValue({ triggered: true, reason: "requested_human" });
  vi.mocked(loadEligibleAttendants).mockResolvedValue([]);
  vi.mocked(getQueuePosition).mockResolvedValue(3);
});

describe("crm_request_human_handoff — destino de time", () => {
  it("slug inválido NÃO muta nada e devolve a lista válida", async () => {
    const efeitos = efeitosVazios();
    const ctx = fazerCtx({ times: [FINANCEIRO] }, efeitos);

    const saida = (await crmRequestHumanHandoff.handler(
      { ...entradaBase, team: "finaceiro" },
      ctx,
    )) as {
      handoff_recorded: boolean;
      error: string;
      available_teams: Array<{ slug: string; name: string; when_to_use: string }>;
      next_action: string;
    };

    expect(saida.error).toBe("team_not_found");
    expect(saida.handoff_recorded).toBe(false);
    expect(saida.available_teams).toEqual([
      { slug: "financeiro", name: "Financeiro", when_to_use: "Cobrança, boleto e reembolso." },
    ]);
    expect(saida.next_action).toContain("available_teams");

    // A ORDEM É A REGRA: nada foi mutado. Se a validação migrasse para depois do
    // orquestrador, a conversa ficaria em `pending`, com o bot calado e sem destino.
    expect(triggerHandoff, "handoff disparado com slug inválido").not.toHaveBeenCalled();
    expect(efeitos.updates).toEqual([]);
    expect(efeitos.inserts).toEqual([]);
    expect(efeitos.rpcs).toEqual([]);
  });

  it("slug válido grava team_id e leva o time ao roteamento E à fila", async () => {
    const efeitos = efeitosVazios();
    const ctx = fazerCtx({ times: [FINANCEIRO] }, efeitos);

    const saida = (await crmRequestHumanHandoff.handler(
      { ...entradaBase, team: "financeiro" },
      ctx,
    )) as { team_id: string | null; queued: boolean; position: number | null };

    expect(efeitos.updates).toContainEqual({
      tabela: "conversations",
      valores: { team_id: TIME_FINANCEIRO },
    });
    expect(saida.team_id).toBe(TIME_FINANCEIRO);

    // Quem pode assumir é procurado DENTRO do time.
    expect(vi.mocked(loadEligibleAttendants).mock.calls[0]?.[3]).toEqual({
      kind: "conversation_channel",
      channelSessionId: CONV,
      teamId: TIME_FINANCEIRO,
    });

    // E a posição contada é a da fila DO TIME — o parâmetro é opcional, então
    // esquecê-lo passaria no typecheck e mentiria para o cliente.
    expect(saida.queued).toBe(true);
    expect(vi.mocked(getQueuePosition).mock.calls[0]?.[4]).toBe(TIME_FINANCEIRO);
    expect(saida.position).toBe(3);
  });

  it("sem team: nem consulta os times, nem restringe o roteamento", async () => {
    const efeitos = efeitosVazios();
    const ctx = fazerCtx({ times: [FINANCEIRO] }, efeitos);

    const saida = (await crmRequestHumanHandoff.handler(entradaBase, ctx)) as {
      team_id: string | null;
      queued: boolean;
    };

    expect(
      efeitos.tabelas,
      "instalação sem time nenhum não pode pagar uma consulta a mais por handoff",
    ).not.toContain("attendance_teams");
    expect(efeitos.updates).not.toContainEqual(
      expect.objectContaining({ valores: expect.objectContaining({ team_id: expect.anything() }) }),
    );
    expect(saida.team_id).toBeNull();

    expect(vi.mocked(loadEligibleAttendants).mock.calls[0]?.[3]).toEqual({
      kind: "conversation_channel",
      channelSessionId: CONV,
      teamId: null,
    });
    expect(vi.mocked(getQueuePosition).mock.calls[0]?.[4]).toBeNull();
    expect(saida.queued).toBe(true);
  });
});
