import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * "Só na fila" e "Mais tempo esperando" (migration 0279) viram predicado e
 * ordem DE CONSULTA — e o cursor não perde quem não espera ninguém.
 *
 * O caso do cursor foi achado em revisão: com `ordem=espera`, a página 2 pedia
 * `espera_desde > X` e o Postgres nunca devolve NULL numa comparação. Como as
 * conversas já respondidas têm `espera_desde` nulo (a maior parte da caixa),
 * a paginação terminava junto com quem esperava e o resto sumia sem aviso.
 */
interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
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

const ctx = { organization_id: "org-1", requestId: "req-1", actor: { type: "user" as const, id: "user-1" } } as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas.filter((c) => c.tabela === "conversations");
}

const cursor = (sort: string | null, id: string) =>
  Buffer.from(JSON.stringify({ sort, id }), "utf8").toString("base64url");

describe("na_fila: a régua da fila do time no banco", () => {
  it("com `na_fila`, pede time, sem dono, não encerrada e IA calada", async () => {
    const c = await listar({ na_fila: true });
    const args = c.map((x) => `${x.metodo}:${x.args.map(String).join(":")}`);
    expect(args).toContain("not:team_id:is:null");
    expect(args).toContain("is:assigned_to_user_id:null");
    expect(args.some((a) => a.startsWith("gt:bot_silenced_until:"))).toBe(true);
    // A barreira de organização continua vindo ANTES, e é a única aqui (admin client).
    expect(args).toContain("eq:organization_id:org-1");
  });

  it("CONTROLE: sem `na_fila`, nenhum predicado de fila", async () => {
    const c = await listar({});
    expect(c.some((x) => x.metodo === "gt" && x.args[0] === "bot_silenced_until")).toBe(false);
  });
});

describe("ordem=espera", () => {
  it("ordena por espera_desde, mais antiga primeiro, nulas no fim", async () => {
    const c = await listar({ ordem: "espera" });
    const ordem = c.find((x) => x.metodo === "order");
    expect(ordem?.args[0]).toBe("espera_desde");
    expect(ordem?.args[1]).toMatchObject({ ascending: true, nullsFirst: false });
  });

  it("⭐ a página seguinte inclui as nulas (quem não espera ninguém)", async () => {
    const c = await listar({ ordem: "espera", cursor: cursor("2026-09-24T10:00:00Z", "c-9") });
    const or = c.find((x) => x.metodo === "or");
    expect(String(or?.args[0])).toContain("espera_desde.is.null");
    expect(String(or?.args[0])).toContain("espera_desde.gt.2026-09-24T10:00:00Z");
  });
});
