/**
 * O FILTRO POR MEIO — "só WhatsApp", "só telefone", "só chat do site".
 *
 * Até aqui só existia filtro por NÚMERO (`channel_session_id`). Quem queria ver
 * as conversas de telefone tinha de escolher o número certo — e o seletor nem
 * listava o telefone. O meio é o valor de `conversations.channel`, e a pergunta
 * é outra: ele alcança também a conversa de um número que já foi removido.
 *
 * Que a ROTA lê o parâmetro quem cobra é `rota-le-todo-filtro-do-schema.test.ts`,
 * que deriva as chaves do schema. Aqui fica o que aquela cerca não vê: o
 * predicado que chega ao banco.
 */
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { listConversationsQuerySchema } from "@/lib/schemas";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA — o mesmo de `nao-lidos-filtra-no-banco`. */
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            }
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

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function igualdadesCom(query: Record<string, unknown>): Promise<string[]> {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas
    .filter((x) => x.tabela === "conversations" && x.metodo === "eq")
    .map((x) => x.args.join(":"));
}

describe("o filtro por meio vira predicado de consulta", () => {
  it("⭐ com `channel=phone`, a consulta pede ao banco só as conversas de telefone", async () => {
    expect(await igualdadesCom({ channel: "phone" })).toContain("channel:phone");
  });

  it("CONTROLE: sem `channel`, nenhum predicado de meio é emitido", async () => {
    const eqs = await igualdadesCom({});
    expect(eqs.some((e) => e.startsWith("channel:"))).toBe(false);
  });

  it("⛔ o predicado compõe sobre a consulta que já filtra a organização", async () => {
    const eqs = await igualdadesCom({ channel: "whatsapp" });
    expect(eqs).toContain("organization_id:org-1");
    expect(eqs).toContain("channel:whatsapp");
  });

  it("meio e número juntos valem os dois (um link editado à mão pode trazer ambos)", async () => {
    const eqs = await igualdadesCom({
      channel: "whatsapp",
      channel_session_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(eqs).toContain("channel:whatsapp");
    expect(eqs).toContain("channel_session_id:11111111-1111-4111-8111-111111111111");
  });
});

describe("o schema só aceita os meios que existem", () => {
  it.each(["whatsapp", "site_chat", "phone"])("aceita `%s`", (meio) => {
    const r = listConversationsQuerySchema.safeParse({ channel: meio });
    expect(r.success && r.data.channel).toBe(meio);
  });

  it("recusa um meio que não existe — lista menor sem explicação parece resposta", () => {
    expect(listConversationsQuerySchema.safeParse({ channel: "fax" }).success).toBe(false);
  });

  it("recusa o nome de um PROVIDER: a tela fala meio, nunca transporte", () => {
    expect(listConversationsQuerySchema.safeParse({ channel: "meta_cloud" }).success).toBe(false);
  });

  it("ausente continua ausente", () => {
    const r = listConversationsQuerySchema.safeParse({});
    expect(r.success && r.data.channel).toBeUndefined();
  });
});
