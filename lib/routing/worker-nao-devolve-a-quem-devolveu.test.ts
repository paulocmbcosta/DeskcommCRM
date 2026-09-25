/**
 * QUEM DEVOLVEU A CONVERSA À FILA DO TIME NÃO A RECEBE DE VOLTA PELO RODÍZIO.
 *
 * A troca de turno: o atendente que vai embora devolve a conversa ao próprio
 * time e continua "Disponível" (esqueceu, ou ainda está saindo). Sem a regra de
 * `quem-devolveu.ts`, ele seria o elegível com MENOS carga — justamente porque
 * acabou de soltar a conversa — e o rodízio a devolveria a ele no minuto
 * seguinte.
 *
 * Roda `runRoutingWorker` de ponta a ponta contra o mesmo tipo de duplo de
 * `worker-respeita-o-time.test.ts` (que projeta o `select`) e mede a quem o
 * claim foi pedido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutingScope } from "./eligibles";

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const capturado = vi.hoisted(() => ({
  admin: null as unknown,
  claims: [] as string[],
  elegiveis: [] as Array<{ userId: string; currentLoad: number; lastAssignedAt: number | null }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => capturado.admin,
}));

vi.mock("@/lib/routing/eligibles", async (original) => {
  const real = await original<typeof import("./eligibles")>();
  return {
    ...real,
    loadEligibleAttendants: vi.fn(async (_db: unknown, _org: string, _now: Date, _scope: RoutingScope) =>
      capturado.elegiveis,
    ),
  };
});

import { runRoutingWorker } from "./worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const TIME = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-09-25T21:00:00Z");
const CLAIMED_AT = "2026-09-25T21:00:00.000Z";

/** Projeta uma linha pelas colunas do `select` — coluna não pedida vira `undefined`. */
function projetar(linha: Record<string, unknown>, colunas: string[] | null): Record<string, unknown> {
  if (!colunas || colunas.length === 0) return linha;
  const saida: Record<string, unknown> = {};
  for (const coluna of colunas) {
    if (coluna in linha) saida[coluna] = linha[coluna];
  }
  return saida;
}

function adminFalso(conversa: Record<string, unknown>, ultimoEvento: Record<string, unknown> | null) {
  const evento = {
    id: "evt-1",
    organization_id: ORG,
    payload: { organization_id: ORG, conversation_id: CONVERSA },
    metadata: null,
    consumed_by: [],
    attempts: 0,
    next_attempt_at: null,
    status: "pending",
    updated_at: CLAIMED_AT,
  };

  function construtor(tabela: string) {
    const chamadas: string[] = [];
    let colunas: string[] | null = null;
    let ehUpdate = false;

    const q: Record<string, unknown> = {};
    const encadeia = (nome: string) => (..._args: unknown[]) => {
      chamadas.push(nome);
      return q;
    };
    for (const metodo of ["eq", "is", "in", "lte", "gte", "or", "order", "limit", "neq"]) {
      q[metodo] = encadeia(metodo);
    }
    q.select = (cols?: string) => {
      chamadas.push("select");
      if (typeof cols === "string") colunas = cols.split(",").map((c) => c.trim());
      return q;
    };
    q.update = (..._args: unknown[]) => {
      ehUpdate = true;
      chamadas.push("update");
      return q;
    };

    const resolver = (): { data: unknown; error: null } => {
      if (tabela === "event_log") {
        // claim: UPDATE ... select("id, updated_at").maybeSingle()
        if (ehUpdate) return { data: projetar(evento, colunas), error: null };
        // pull dos pendentes usa `.or(...)`; a varredura de abandonados, `.lte(...)`
        if (chamadas.includes("or")) return { data: [projetar(evento, colunas)], error: null };
        return { data: [], error: null };
      }
      if (tabela === "conversations") return { data: projetar(conversa, colunas), error: null };
      if (tabela === "conversation_assignment_events") {
        return { data: ultimoEvento ? projetar(ultimoEvento, colunas) : null, error: null };
      }
      if (tabela === "organizations") {
        return {
          data: projetar({ id: ORG, settings: { routing: { mode: "round_robin" } } }, colunas),
          error: null,
        };
      }
      return { data: null, error: null };
    };

    q.maybeSingle = async () => resolver();
    q.single = async () => resolver();
    q.then = (aceita: (x: unknown) => unknown, rejeita?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(aceita, rejeita);
    return q;
  }

  return {
    from: (tabela: string) => construtor(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "fn_channel_routing_claim") {
        capturado.claims.push(String(args.p_user));
        return { data: "assigned", error: null };
      }
      return { data: null, error: null };
    },
  };
}

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: "55555555-5555-4555-8555-555555555555",
  channel_session_id: CANAL,
  assigned_to_user_id: null,
  status: "open",
  team_id: TIME,
  service_started_at: "2026-09-25T18:00:00.000Z",
};

const devolvidaPelaAna = { reason: "team_transfer", from_user_id: ANA, to_user_id: null };

beforeEach(() => {
  capturado.claims = [];
});

describe("o rodízio não devolve a conversa a quem a devolveu ao time", () => {
  it("com outra pessoa elegível, a conversa vai para ela — mesmo a Ana tendo menos carga", async () => {
    capturado.elegiveis = [
      { userId: ANA, currentLoad: 0, lastAssignedAt: null },
      { userId: BIA, currentLoad: 2, lastAssignedAt: 1 },
    ];
    capturado.admin = adminFalso(conversa, devolvidaPelaAna);

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.assigned).toBe(1);
    expect(capturado.claims).toEqual([BIA]);
  });

  it("se só quem devolveu está elegível, a conversa ESPERA na fila em vez de voltar para ela", async () => {
    capturado.elegiveis = [{ userId: ANA, currentLoad: 0, lastAssignedAt: null }];
    capturado.admin = adminFalso(conversa, devolvidaPelaAna);

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.requeued_no_eligible).toBe(1);
    expect(capturado.claims).toEqual([]);
  });

  it("controle: sem devolução no atendimento, a Ana recebe normalmente", async () => {
    // Sem este caso, um filtro que excluísse todo mundo passaria nos dois acima.
    capturado.elegiveis = [
      { userId: ANA, currentLoad: 0, lastAssignedAt: null },
      { userId: BIA, currentLoad: 2, lastAssignedAt: 1 },
    ];
    capturado.admin = adminFalso(conversa, null);

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.assigned).toBe(1);
    expect(capturado.claims).toEqual([ANA]);
  });
});
