/**
 * O RODÍZIO DE TEXTO NÃO DISTRIBUI A CONVERSA DE UMA LIGAÇÃO.
 *
 * A telefonia (spec 20) cria a conversa `phone` sem dono no instante em que a
 * ligação chega (`acharOuCriarConversa`), e o trigger da 0040 emite
 * `conversation.routing_requested` para ela como para qualquer conversa. Numa
 * organização em `round_robin`, este worker a entregava a um atendente em até
 * um minuto — antes de a ligação ser atendida, sem relação com quem o telefone
 * escolheu tocar, contando no teto de conversas dele, e na perdida deixando-a
 * com alguém que nunca ouviu o telefone tocar. A spec 20 §10 registrava isso
 * como "não medido". Quem recebe a ligação é a distribuição da telefonia; quem
 * atende faz o `claim`.
 *
 * Mesmo desenho de `worker-respeita-a-ia.test.ts`: `runRoutingWorker` de ponta
 * a ponta contra um dublê do admin client, medindo o DESFECHO — se procurou
 * elegíveis, se chamou alguma RPC de atribuição, com que desfecho fechou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEIO_TELEFONE } from "@/lib/channels/capabilities";
import type * as Elegiveis from "./eligibles";
import type { RoutingScope } from "./eligibles";

const capturado = vi.hoisted(() => ({
  escopos: [] as RoutingScope[],
  rpcs: [] as Array<{ nome: string; args: unknown }>,
  eventoAtualizado: [] as Array<Record<string, unknown>>,
  admin: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => capturado.admin,
}));

vi.mock("@/lib/routing/eligibles", async (original) => {
  const real = await original<typeof Elegiveis>();
  return {
    ...real,
    loadEligibleAttendants: vi.fn(async (_db: unknown, _org: string, _now: Date, scope: RoutingScope) => {
      capturado.escopos.push(scope);
      return [
        { userId: "66666666-6666-4666-8666-666666666666", currentLoad: 0, lastAssignedAt: null, scheduleSnapshot: {} },
      ];
    }),
  };
});

import { runRoutingWorker } from "./worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const AGORA = new Date("2026-09-28T15:00:00Z");
const CLAIMED_AT = "2026-09-28T15:00:00.000Z";

function projetar(linha: Record<string, unknown>, colunas: string[] | null): Record<string, unknown> {
  if (!colunas || colunas.length === 0) return linha;
  const saida: Record<string, unknown> = {};
  for (const coluna of colunas) if (coluna in linha) saida[coluna] = linha[coluna];
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
    for (const metodo of ["eq", "is", "in", "lte", "gte", "or", "order", "limit", "neq"]) {
      q[metodo] = () => {
        chamadas.push(metodo);
        return q;
      };
    }
    q.select = (cols?: string) => {
      chamadas.push("select");
      if (typeof cols === "string") colunas = cols.split(",").map((c) => c.trim());
      return q;
    };
    q.update = (valores: Record<string, unknown>) => {
      ehUpdate = true;
      if (tabela === "event_log") capturado.eventoAtualizado.push(valores);
      return q;
    };
    const resolver = (): { data: unknown; error: null } => {
      if (tabela === "event_log") {
        if (ehUpdate) return { data: projetar(evento, colunas), error: null };
        if (chamadas.includes("or")) return { data: [projetar(evento, colunas)], error: null };
        return { data: [], error: null };
      }
      // Projeta pelas colunas pedidas: se o worker não SELECIONAR `channel`, o
      // dublê não o entrega — e o caso do telefone fica vermelho, como deve.
      if (tabela === "conversations") return { data: projetar(conversa, colunas), error: null };
      if (tabela === "organizations") {
        return { data: projetar({ id: ORG, settings: { routing: { mode: "round_robin" } } }, colunas), error: null };
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
      if (nome === "fn_ia_automatica_no_canal") return { data: false, error: null };
      if (nome === "fn_channel_routing_claim") return { data: "assigned", error: null };
      return { data: null, error: null };
    },
  };
}

const conversa = (channel: string) => ({
  id: CONVERSA,
  organization_id: ORG,
  contact_id: "55555555-5555-4555-8555-555555555555",
  channel_session_id: CANAL,
  channel,
  assigned_to_user_id: null,
  status: "open",
  team_id: null,
});

const atribuiu = () => capturado.rpcs.some((r) => r.nome === "fn_channel_routing_claim");

beforeEach(() => {
  capturado.escopos = [];
  capturado.rpcs = [];
  capturado.eventoAtualizado = [];
});

describe("o rodízio de texto e a conversa de telefone", () => {
  it("conversa de telefone, organização em rodízio ⇒ ninguém a recebe, e o evento fecha nomeado", async () => {
    capturado.admin = adminFalso(conversa(MEIO_TELEFONE));

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_voice_channel).toBe(1);
    expect(resumo.outcomes.assigned).toBe(0);
    expect(capturado.escopos).toHaveLength(0);
    expect(atribuiu()).toBe(false);
    // Nem pergunta pela IA: a conversa da ligação não é assunto do rodízio.
    expect(capturado.rpcs).toHaveLength(0);
    const fechamento = capturado.eventoAtualizado.find((v) => v.status === "done");
    expect(fechamento?.metadata).toMatchObject({ outcome: "skipped_voice_channel" });
  });

  it("conversa de WhatsApp na mesma organização ⇒ o rodízio distribui como sempre (controle)", async () => {
    capturado.admin = adminFalso(conversa("whatsapp"));

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes.skipped_voice_channel).toBe(0);
    expect(resumo.outcomes.assigned).toBe(1);
    expect(atribuiu()).toBe(true);
  });

  it("o desfecho novo entra no resumo zerado, como os outros `skipped_*`", async () => {
    capturado.admin = adminFalso(conversa("site_chat"));

    const resumo = await runRoutingWorker({ now: AGORA });

    expect(resumo.outcomes).toHaveProperty("skipped_voice_channel", 0);
  });
});
