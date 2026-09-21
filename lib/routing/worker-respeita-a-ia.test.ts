/**
 * O RODÍZIO NÃO TIRA DA IA A CONVERSA QUE ELA ESTÁ ATENDENDO.
 *
 * Medido em produção em 2026-09-21 (v1.34.1, organização em `round_robin`, com a
 * "Bia - 3025" publicada no canal oficial): o cliente escreveu, o cron de
 * roteamento entregou a conversa ao atendente online em 2 segundos, e o motor
 * pulou o turno por `conversa_de_humano`. Soltar a conversa não adiantou — o
 * rodízio a entregou de novo em menos de um minuto. Com qualquer atendente
 * online, a IA não respondia NINGUÉM.
 *
 * O fluxo que o dono do produto definiu: a IA atende primeiro; a conversa só
 * entra no rodízio quando SAI da IA — pela transferência para um time (que
 * cala a IA e pede o rodízio daquele time) ou porque a IA não vai atendê-la
 * (nenhum agente automático no canal, contato fora da lista de teste, passagem
 * para humano já feita).
 *
 * ## O que este teste mede, e como
 *
 * Roda `runRoutingWorker` de ponta a ponta contra um duplo do admin client — o
 * mesmo desenho de `worker-respeita-o-time.test.ts` — e mede o DESFECHO: se a
 * conversa chegou a pedir elegíveis (`loadEligibleAttendants`) e se alguma RPC
 * de atribuição foi chamada. A pergunta "a IA atende?" tem duas metades, e as
 * duas estão sob vigilância: a RPC `fn_ia_automatica_no_canal` (há IA
 * automática no ar NESTE canal?) e a trava de elegibilidade da conversa (a
 * mesma que o motor aplica antes de responder).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { DecisaoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";
import type { RoutingScope } from "./eligibles";

const capturado = vi.hoisted(() => ({
  escopos: [] as RoutingScope[],
  rpcs: [] as Array<{ nome: string; args: unknown }>,
  eventoAtualizado: [] as Array<Record<string, unknown>>,
  elegibilidade: null as DecisaoDeElegibilidade | null,
  consultasDeElegibilidade: 0,
  admin: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => capturado.admin,
}));

vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => {
    capturado.consultasDeElegibilidade += 1;
    return capturado.elegibilidade;
  }),
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
const AGORA = new Date("2026-09-21T20:19:00Z");
const CLAIMED_AT = "2026-09-21T20:19:00.000Z";

const IA_ATENDE: DecisaoDeElegibilidade = { permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false };
const JA_PASSOU_PARA_HUMANO: DecisaoDeElegibilidade = {
  permite: false,
  motivo: "conversa_silenciada",
  bloqueioPorAllowlist: false,
};

function projetar(linha: Record<string, unknown>, colunas: string[] | null): Record<string, unknown> {
  if (!colunas || colunas.length === 0) return linha;
  const saida: Record<string, unknown> = {};
  for (const coluna of colunas) {
    if (coluna in linha) saida[coluna] = linha[coluna];
  }
  return saida;
}

interface Cenario {
  conversa: Record<string, unknown>;
  modo?: "round_robin" | "manual";
  /** Resposta da RPC `fn_ia_automatica_no_canal`. `Error` = a RPC falhou. */
  iaNoCanal: boolean | Error;
}

function adminFalso(cenario: Cenario) {
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
    q.update = (valores: Record<string, unknown>) => {
      ehUpdate = true;
      chamadas.push("update");
      if (tabela === "event_log") capturado.eventoAtualizado.push(valores);
      return q;
    };

    const resolver = (): { data: unknown; error: null } => {
      if (tabela === "event_log") {
        if (ehUpdate) return { data: projetar(evento, colunas), error: null };
        if (chamadas.includes("or")) return { data: [projetar(evento, colunas)], error: null };
        return { data: [], error: null };
      }
      if (tabela === "conversations") return { data: projetar(cenario.conversa, colunas), error: null };
      if (tabela === "organizations") {
        return {
          data: projetar({ id: ORG, settings: { routing: { mode: cenario.modo ?? "round_robin" } } }, colunas),
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
    rpc: async (nome: string, args: unknown) => {
      capturado.rpcs.push({ nome, args });
      if (nome === "fn_ia_automatica_no_canal") {
        if (cenario.iaNoCanal instanceof Error) {
          return { data: null, error: { message: cenario.iaNoCanal.message } };
        }
        return { data: cenario.iaNoCanal, error: null };
      }
      return { data: null, error: null };
    },
  };
}

const conversaDeEntrada = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: "55555555-5555-4555-8555-555555555555",
  channel_session_id: CANAL,
  assigned_to_user_id: null,
  status: "open",
  team_id: null,
};

const atribuiu = () => capturado.rpcs.some((r) => r.nome === "fn_channel_routing_claim");

beforeEach(() => {
  capturado.escopos = [];
  capturado.rpcs = [];
  capturado.eventoAtualizado = [];
  capturado.elegibilidade = IA_ATENDE;
  capturado.consultasDeElegibilidade = 0;
});

describe("o rodízio respeita a IA que está atendendo", () => {
  it("IA automática no ar no canal + conversa elegível ⇒ ninguém recebe a conversa", async () => {
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, iaNoCanal: true });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_ai_attending).toBe(1);
    // Nem chegou a procurar atendente — e, sobretudo, não atribuiu.
    expect(capturado.escopos).toHaveLength(0);
    expect(atribuiu()).toBe(false);
    // A pergunta foi feita sobre O CANAL DA CONVERSA, na organização do evento.
    expect(capturado.rpcs.find((r) => r.nome === "fn_ia_automatica_no_canal")?.args).toEqual({
      p_org: ORG,
      p_channel: CANAL,
    });
    // O evento fecha com o desfecho nomeado — a transferência pede outro depois.
    const fechamento = capturado.eventoAtualizado.find((v) => v.status === "done");
    expect(fechamento?.metadata).toMatchObject({ outcome: "skipped_ai_attending" });
  });

  it("sem IA automática no canal ⇒ o rodízio distribui como sempre", async () => {
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, iaNoCanal: false });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_ai_attending).toBe(0);
    expect(capturado.escopos).toHaveLength(1);
  });

  it("IA no canal, mas a conversa já passou para humano ⇒ distribui DENTRO do time", async () => {
    // É o caminho da transferência: a IA calou (silêncio 'infinity' + force_human),
    // gravou o time e pediu o rodízio. A trava diz "IA não atende" e o rodízio
    // procura dentro do time — sem isto a conversa transferida ficaria órfã.
    capturado.elegibilidade = JA_PASSOU_PARA_HUMANO;
    capturado.admin = adminFalso({ conversa: { ...conversaDeEntrada, status: "pending", team_id: TIME }, iaNoCanal: true });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_ai_attending).toBe(0);
    expect(capturado.escopos).toHaveLength(1);
    expect(capturado.escopos[0]?.teamId).toBe(TIME);
  });

  it("contato que a IA não vai atender (fora da lista de teste) ⇒ vai para uma pessoa", async () => {
    capturado.elegibilidade = { permite: false, motivo: "fora_da_lista_de_teste", bloqueioPorAllowlist: true };
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, iaNoCanal: true });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_ai_attending).toBe(0);
    expect(capturado.escopos).toHaveLength(1);
  });

  it("sem IA no canal, a trava de elegibilidade nem é consultada", async () => {
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, iaNoCanal: false });

    await runRoutingWorker({ now: AGORA });

    expect(capturado.consultasDeElegibilidade).toBe(0);
  });

  it("a consulta da IA falha ⇒ não atribui às cegas: erro, e o evento volta para a fila", async () => {
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, iaNoCanal: new Error("rpc caiu") });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.error).toBe(1);
    expect(capturado.escopos).toHaveLength(0);
    expect(atribuiu()).toBe(false);
    expect(capturado.eventoAtualizado.some((v) => v.status === "pending")).toBe(true);
  });

  it("modo manual ⇒ nem pergunta pela IA (ninguém distribui mesmo)", async () => {
    capturado.admin = adminFalso({ conversa: conversaDeEntrada, modo: "manual", iaNoCanal: true });

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_manual).toBe(1);
    expect(capturado.rpcs.some((r) => r.nome === "fn_ia_automatica_no_canal")).toBe(false);
  });
});
