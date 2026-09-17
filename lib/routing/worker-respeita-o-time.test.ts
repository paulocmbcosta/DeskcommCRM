/**
 * O CRON DE ROTEAMENTO RESPEITA O TIME DA CONVERSA.
 *
 * Esta é a catraca que fecha a feature de times por dentro. O handoff põe a
 * conversa na fila de um setor (`conversations.team_id`) e devolve ao cliente a
 * posição DAQUELA fila; mas quem atribui de verdade, um minuto depois, é o cron
 * — e o cron lê a conversa e monta o `RoutingScope` sozinho. Se o escopo dele
 * não levar o time, a promessa ("fila do time, sem transbordo") é desfeita em
 * até 60 segundos, em silêncio e com a suíte inteira verde: o pedido de
 * cancelamento cai no comercial porque o comercial estava elegível.
 *
 * ## O que este teste mede, e como
 *
 * Mede COMPORTAMENTO, não a presença de um símbolo: roda `runRoutingWorker` de
 * ponta a ponta contra um duplo do admin client e captura o `scope` que chegou
 * a `loadEligibleAttendants`.
 *
 * O duplo **projeta o `select`** — pedir uma coluna que o `select` não nomeou
 * devolve `undefined`, como no PostgREST de verdade. É isso que faz as DUAS
 * linhas da correção ficarem sob vigilância: tirar `team_id` da lista de
 * colunas reprova tanto quanto tirar `teamId` do escopo. Um fake que devolvesse
 * a linha inteira vigiaria só metade do conserto.
 *
 * Os elegíveis voltam vazios de propósito: o escopo já foi capturado quando o
 * worker chega à decisão, e a fila vazia leva ao `requeue` — o caminho mais
 * curto até a medição, sem precisar encenar o claim no Postgres.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { RoutingScope } from "./eligibles";

const capturado = vi.hoisted(() => ({
  escopos: [] as RoutingScope[],
  admin: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => capturado.admin,
}));

vi.mock("@/lib/routing/eligibles", async (original) => {
  const real = await original<typeof import("./eligibles")>();
  return {
    ...real,
    loadEligibleAttendants: vi.fn(
      async (_db: unknown, _org: string, _now: Date, scope: RoutingScope) => {
        capturado.escopos.push(scope);
        return [];
      },
    ),
  };
});

import { runRoutingWorker } from "./worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const TIME = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-09-16T15:00:00Z");
const CLAIMED_AT = "2026-09-16T15:00:00.000Z";

/** Projeta uma linha pelas colunas do `select` — coluna não pedida vira `undefined`. */
function projetar(linha: Record<string, unknown>, colunas: string[] | null): Record<string, unknown> {
  if (!colunas || colunas.length === 0) return linha;
  const saida: Record<string, unknown> = {};
  for (const coluna of colunas) {
    if (coluna in linha) saida[coluna] = linha[coluna];
  }
  return saida;
}

function adminFalso(conversa: Record<string, unknown>) {
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
    rpc: async () => ({ data: null, error: null }),
  };
}

const conversaBase = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: "55555555-5555-4555-8555-555555555555",
  channel_session_id: CANAL,
  assigned_to_user_id: null,
  status: "pending",
};

beforeEach(() => {
  capturado.escopos = [];
});

/** O escopo da única chamada — falha alto se o worker nem chegou a pedir elegíveis. */
function escopoUnico(): RoutingScope {
  expect(capturado.escopos).toHaveLength(1);
  const escopo = capturado.escopos[0];
  if (!escopo) throw new Error("o worker não chegou a carregar os elegíveis");
  return escopo;
}

describe("o cron de roteamento respeita o time da conversa", () => {
  it("conversa com time ⇒ o escopo dos elegíveis leva aquele time", async () => {
    capturado.admin = adminFalso({ ...conversaBase, team_id: TIME });

    const resumo = await runRoutingWorker({ now: AGORA });

    // O worker chegou ao ponto que interessa (e não abortou antes).
    expect(resumo.outcomes.requeued_no_eligible).toBe(1);

    const escopo = escopoUnico();
    expect(escopo.teamId).toBe(TIME);
    // O canal continua no escopo: time e canal SOMAM, um não substitui o outro.
    expect(escopo).toMatchObject({ kind: "conversation_channel", channelSessionId: CANAL });
  });

  it("conversa sem time ⇒ o escopo leva time nulo, nunca um time inventado", async () => {
    capturado.admin = adminFalso({ ...conversaBase, team_id: null });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.requeued_no_eligible).toBe(1);
    // `null` e não `undefined`: undefined é o que sai de uma coluna que o
    // `select` não pediu, e é exatamente o defeito que este arquivo vigia.
    expect(escopoUnico().teamId).toBeNull();
  });
});
