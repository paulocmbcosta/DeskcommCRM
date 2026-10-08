/**
 * "SEM ATENDENTE" É UM FILTRO, NÃO A FILA.
 *
 * A Fila já foi `assigned_to=unassigned` — e sobraram dois restos disso: a rota
 * ordenava por tempo de espera sempre que via esse par sem `comando`, e a lista
 * numerava as linhas ("1º, 2º… Aguardando"). Enquanto só a Fila mandava
 * "sem dono", os restos não apareciam. Com o seletor de atendente, a aba Todas
 * passou a mandar exatamente esse par ("Sem atendente") — e a lista dela viraria
 * de cabeça para baixo, com cada conversa que o automático está respondendo
 * marcada como "aguardando", sem a pessoa ter pedido a fila.
 *
 * Achado da revisão independente desta entrega, antes do merge.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { tabToFilter } from "@/components/inbox/InboxLayout";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";
import { filtrosAplicados, paraConversas } from "@/lib/inbox/filtros-de-tela";
import { listConversationsQuerySchema } from "@/lib/schemas";

// ─── A ROTA ────────────────────────────────────────────────────────────────

interface Chamada {
  metodo: string;
  args: unknown[];
}

function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: () => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = { organization_id: "org-1", requestId: "r", actor: { type: "user" as const, id: "u-1" } } as never;

/** A primeira ordenação que a consulta pede: coluna e sentido. */
async function ordemCom(query: Record<string, unknown>): Promise<string> {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  const primeira = chamadas.find((c) => c.metodo === "order");
  const opcoes = primeira?.args[1] as { ascending: boolean };
  return `${String(primeira?.args[0])} ${opcoes.ascending ? "asc" : "desc"}`;
}

describe("a rota: `ordem=atividade` desliga a leitura de \"sem dono\" como fila", () => {
  it("⭐ Todas + \"Sem atendente\": atividade recente primeiro, como em qualquer Todas", async () => {
    expect(
      await ordemCom({ exclude_finished: true, assigned_to: "unassigned", ordem: "atividade" }),
    ).toBe("last_message_at desc");
  });

  it("\"Mais tempo esperando\" continua vencendo", async () => {
    expect(await ordemCom({ exclude_finished: true, assigned_to: "unassigned", ordem: "espera" })).toBe(
      "espera_desde asc",
    );
  });

  it("CONTROLE: o pedido antigo da Fila (sem a ordem dita) segue na ordem de espera — quem consome a API não muda", async () => {
    expect(await ordemCom({ assigned_to: "unassigned" })).toBe("last_inbound_at asc");
  });

  it("CONTROLE: a Fila de hoje (pelo comando) segue na ordem de espera", async () => {
    expect(await ordemCom({ comando: ["aguardando"] })).toBe("last_inbound_at asc");
  });

  it("o schema aceita a ordem dita, e só as duas que existem", () => {
    expect(listConversationsQuerySchema.safeParse({ ordem: "atividade" }).success).toBe(true);
    expect(listConversationsQuerySchema.safeParse({ ordem: "recente" }).success).toBe(false);
  });
});

// ─── A TELA ────────────────────────────────────────────────────────────────

describe("a aba Todas manda a ordem junto com o filtro", () => {
  const todasCom = (assigned_to?: string, ordem?: "espera") =>
    ({
      ...tabToFilter("all"),
      ...paraConversas("all", filtrosAplicados("all", { search: "", onlyUnread: false, assigned_to, ordem })),
    }) as ConversationsFilters;

  it("⭐ com \"Sem atendente\", o pedido leva `ordem=atividade`", () => {
    expect(todasCom("unassigned")).toMatchObject({ assigned_to: "unassigned", ordem: "atividade" });
  });

  it("o botão \"Espera\" troca a ordem — o auxiliar entra por cima da aba", () => {
    expect(todasCom("unassigned", "espera").ordem).toBe("espera");
  });
});

const linhas: Array<{ queuePosition?: number }> = [];
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: (props: { queuePosition?: number }) => {
    linhas.push({ queuePosition: props.queuePosition });
    return null;
  },
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");

function montarLista(filters: ConversationsFilters) {
  linhas.length = 0;
  const conversa = (id: string) => ({ id, assigned_to_user_id: null, contacts: null });
  render(
    <ConversationList
      listQuery={
        {
          data: { pages: [{ data: [conversa("c1"), conversa("c2")], meta: { has_more: false } }] },
          isLoading: false,
          isError: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        } as never
      }
      filters={filters}
      filtrosAtivos={[]}
      selectedId={null}
      onSelect={() => undefined}
    />,
  );
  return linhas.map((l) => l.queuePosition);
}

afterEach(cleanup);

describe("a lista: a numeração \"1º, 2º\" é só da Fila", () => {
  it("⭐ Todas + \"Sem atendente\": nenhuma linha numerada", () => {
    const posicoes = montarLista({ exclude_finished: true, assigned_to: "unassigned", ordem: "atividade" });
    expect(posicoes.length).toBeGreaterThan(0);
    expect(posicoes.every((p) => p === undefined)).toBe(true);
  });

  it("CONTROLE: a Fila (pelo comando) numera", () => {
    expect(montarLista({ comando: ["aguardando"] })).toEqual([1, 2]);
  });
});
