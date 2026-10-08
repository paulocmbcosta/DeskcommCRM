/**
 * A ABA "FECHADAS" LISTA ATENDIMENTOS, NÃO CONVERSAS.
 *
 * ─── O defeito de modelo ────────────────────────────────────────────────────
 *
 * A conversa é UMA por cliente e canal (`uniq_conversations_1to1_per_contact_session`)
 * e REABRE quando o cliente volta; o atendimento é o episódio dentro dela, com o
 * seu protocolo (migration 0266). A aba Fechadas listava `conversations` em
 * status terminal. Consequência, no cenário que o dono do produto descreveu:
 *
 *   10h  Financeiro encerra o atendimento do Fernando   → aparece em Fechadas
 *   14h  Fernando escreve pedindo suporte               → a conversa reabre…
 *        …e o atendimento das 10h SOME de Fechadas.
 *
 * "O que foi encerrado hoje?" ficava sem resposta justamente para quem voltou.
 * A unidade da aba passa a ser o atendimento; este arquivo guarda as decisões
 * que não são óbvias lendo só a consulta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listarAtendimentosFechados,
  listarFechadosSchema,
  type ListarFechadosQuery,
} from "@/app/api/v1/atendimentos/_handler";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA e devolve, por tabela, o que o teste mandar. */
function fakeSupabase(respostas: Record<string, unknown[]>) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: respostas[tabela] ?? [], error: null });
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

const ctx = { organizationId: "org-1", userId: "user-1", t: (s: string) => s };
const consulta = (extra: Record<string, string> = {}): ListarFechadosQuery =>
  listarFechadosSchema.parse(extra);

const args = (c: Chamada[], tabela: string, metodo: string) =>
  c
    .filter((x) => x.tabela === tabela && x.metodo === metodo)
    .map((x) => JSON.stringify(x.args))
    .join(" | ");

function linha(over: Record<string, unknown> = {}) {
  return {
    id: "at-1",
    conversation_id: "conv-1",
    protocol: "20260919000001",
    started_at: "2026-09-19T10:00:00Z",
    closed_at: "2026-09-19T10:30:00Z",
    closed_status: "closed",
    closed_by_name: "Ana",
    assigned_to_user_name: "Ana",
    team_id: "time-financeiro",
    conversations: {
      status: "closed",
      contact_id: "ct-1",
      channel_sessions: { phone_number: "5511999990000", display_name: "Comercial" },
      contacts: {
        id: "ct-1",
        display_name: "Fernando",
        name: null,
        phone_number: "5511988887777",
        is_anonymized: false,
        avatar_storage_path: "avatars/ct-1.jpg",
      },
    },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("a consulta é sobre ATENDIMENTOS encerrados", () => {
  it("lê `atendimentos` com `closed_at` preenchido, da organização da SESSÃO, do mais recente para o mais antigo", async () => {
    const { client, chamadas } = fakeSupabase({ atendimentos: [linha()] });
    const r = await listarAtendimentosFechados(client, ctx, consulta());

    expect(r.ok).toBe(true);
    expect(args(chamadas, "atendimentos", "eq")).toContain('["organization_id","org-1"]');
    expect(args(chamadas, "atendimentos", "not")).toContain('["closed_at","is",null]');
    const ordens = chamadas.filter((x) => x.tabela === "atendimentos" && x.metodo === "order");
    expect(ordens.map((o) => o.args[0])).toEqual(["closed_at", "id"]);
    expect(ordens.every((o) => (o.args[1] as { ascending: boolean }).ascending === false)).toBe(true);
    // Nunca `conversations` como tabela-base: é o caminho antigo.
    expect(chamadas.some((x) => x.tabela === "conversations")).toBe(false);
  });

  it("⭐ o cliente VOLTOU: o atendimento encerrado continua na lista, marcado", async () => {
    // A conversa está `open` de novo — é exatamente a linha que a lista antiga perdia.
    const voltou = linha({ conversations: { ...linha().conversations, status: "open" } });
    const { client } = fakeSupabase({ atendimentos: [voltou, linha({ id: "at-0" })] });
    const r = await listarAtendimentosFechados(client, ctx, consulta());
    if (!r.ok) throw new Error("esperava sucesso");

    expect(r.data.map((a) => a.id)).toEqual(["at-1", "at-0"]);
    expect(r.data[0]?.conversa_em_andamento).toBe(true);
    // CONTROLE: a conversa que segue fechada não ganha a marca.
    expect(r.data[1]?.conversa_em_andamento).toBe(false);
  });
});

describe("os filtros auxiliares — a mesma régua da lista de conversas", () => {
  it("o TIME é o do FECHAMENTO: filtra `atendimentos.team_id`, não o time atual da conversa", async () => {
    // Depois que o cliente volta, a conversa começa SEM time (0269). Filtrar
    // pelo time atual esconderia tudo o que o Financeiro encerrou.
    const { client, chamadas } = fakeSupabase({ atendimentos: [] });
    await listarAtendimentosFechados(
      client,
      ctx,
      consulta({ team_id: "8d9f3c1e-0000-4000-8000-000000000001" }),
    );
    const eqs = args(chamadas, "atendimentos", "eq");
    expect(eqs).toContain('["team_id","8d9f3c1e-0000-4000-8000-000000000001"]');
    expect(eqs).not.toContain("conversations.team_id");
  });

  it("número, etiqueta e não lidas são da CONVERSA — e a etiqueta é `contains`, nunca igualdade", async () => {
    const { client, chamadas } = fakeSupabase({ atendimentos: [] });
    await listarAtendimentosFechados(
      client,
      ctx,
      consulta({
        channel_session_id: "8d9f3c1e-0000-4000-8000-000000000002",
        tag: "urgente",
        unread: "true",
      }),
    );
    expect(args(chamadas, "atendimentos", "eq")).toContain(
      '["conversations.channel_session_id","8d9f3c1e-0000-4000-8000-000000000002"]',
    );
    expect(args(chamadas, "atendimentos", "contains")).toContain('["conversations.tags",["urgente"]]');
    expect(args(chamadas, "atendimentos", "gt")).toContain('["conversations.unread_count_for_assignee",0]');
  });

  it("CONTROLE: sem filtro, nenhum predicado de conversa nem de time", async () => {
    const { client, chamadas } = fakeSupabase({ atendimentos: [] });
    await listarAtendimentosFechados(client, ctx, consulta());
    expect(chamadas.some((x) => x.metodo === "contains" || x.metodo === "gt" || x.metodo === "is")).toBe(false);
    expect(args(chamadas, "atendimentos", "eq")).not.toContain("team_id");
  });
});

describe("a busca acha pelo PROTOCOLO e pelo CLIENTE", () => {
  it("pelo nome: contatos → conversas → atendimentos, tudo na organização da sessão", async () => {
    const { client, chamadas } = fakeSupabase({
      contacts: [{ id: "ct-1" }],
      conversations: [{ id: "conv-1" }],
      atendimentos: [linha()],
    });
    const r = await listarAtendimentosFechados(client, ctx, consulta({ search: "Fernando" }));
    if (!r.ok) throw new Error("esperava sucesso");

    expect(args(chamadas, "contacts", "eq")).toContain('["organization_id","org-1"]');
    // Anonimizar é direito do titular: o nome antigo não pode voltar a achá-lo.
    expect(args(chamadas, "contacts", "eq")).toContain('["is_anonymized",false]');
    expect(args(chamadas, "conversations", "eq")).toContain('["organization_id","org-1"]');
    expect(args(chamadas, "atendimentos", "or")).toContain("conversation_id.in.(conv-1)");
    expect(r.data).toHaveLength(1);
  });

  it("pelo número: os dígitos casam `protocol`, mesmo sem contato nenhum com esse nome", async () => {
    const { client, chamadas } = fakeSupabase({ atendimentos: [linha()] });
    await listarAtendimentosFechados(client, ctx, consulta({ search: "2026-0919 000001" }));
    expect(args(chamadas, "atendimentos", "or")).toContain("protocol.ilike.*20260919000001*");
  });

  it("nada casou: lista VAZIA — nunca a lista inteira, nunca um `or=()` inválido", async () => {
    const { client, chamadas } = fakeSupabase({ atendimentos: [linha()] });
    const r = await listarAtendimentosFechados(client, ctx, consulta({ search: "Zuleica" }));
    expect(r).toEqual({ ok: true, data: [], cursor: null, has_more: false });
    expect(chamadas.some((x) => x.tabela === "atendimentos" && x.metodo === "or")).toBe(false);
  });

  it("uma letra só não é busca — o schema descarta, igual à lista de conversas", () => {
    expect(consulta({ search: "a" }).search).toBeUndefined();
  });
});

describe("paginação e o que o card recebe", () => {
  it("pede uma linha a mais para saber se há próxima página, e o cursor é o par (closed_at, id)", async () => {
    const tres = [linha({ id: "a3" }), linha({ id: "a2" }), linha({ id: "a1" })];
    const { client, chamadas } = fakeSupabase({ atendimentos: tres });
    const r = await listarAtendimentosFechados(client, ctx, consulta({ limit: "2" }));
    if (!r.ok) throw new Error("esperava sucesso");

    expect(args(chamadas, "atendimentos", "limit")).toContain("[3]");
    expect(r.data.map((a) => a.id)).toEqual(["a3", "a2"]);
    expect(r.has_more).toBe(true);
    expect(JSON.parse(Buffer.from(r.cursor ?? "", "base64url").toString("utf8"))).toEqual({
      closed_at: "2026-09-19T10:30:00Z",
      id: "a2",
    });

    // E a volta: o cursor vira keyset, não OFFSET.
    const segunda = fakeSupabase({ atendimentos: [] });
    await listarAtendimentosFechados(segunda.client, ctx, consulta({ cursor: r.cursor ?? "" }));
    expect(args(segunda.chamadas, "atendimentos", "or")).toContain(
      "closed_at.lt.2026-09-19T10:30:00Z,and(closed_at.eq.2026-09-19T10:30:00Z,id.lt.a2)",
    );
  });

  it("cursor adulterado é recusado, não ignorado", async () => {
    const { client } = fakeSupabase({ atendimentos: [linha()] });
    const r = await listarAtendimentosFechados(client, ctx, consulta({ cursor: "isto-nao-e-cursor" }));
    expect(r).toEqual({ ok: false, motivo: "cursor_invalido" });
  });

  it("contato anonimizado: o card não recebe a foto", async () => {
    const anon = linha({
      conversations: {
        ...linha().conversations,
        contacts: { ...linha().conversations.contacts, is_anonymized: true, display_name: "Cliente Anonimizado #7" },
      },
    });
    const { client } = fakeSupabase({ atendimentos: [anon] });
    const r = await listarAtendimentosFechados(client, ctx, consulta());
    if (!r.ok) throw new Error("esperava sucesso");
    expect(r.data[0]?.anonimizado).toBe(true);
    expect(r.data[0]?.avatar_storage_path).toBeNull();
  });

  it("o card recebe protocolo, quem encerrou, o time do fechamento e o canal", async () => {
    const { client } = fakeSupabase({ atendimentos: [linha()] });
    const r = await listarAtendimentosFechados(client, ctx, consulta());
    if (!r.ok) throw new Error("esperava sucesso");
    expect(r.data[0]).toMatchObject({
      protocol: "20260919000001",
      closed_by_name: "Ana",
      team_id: "time-financeiro",
      contato: "Fernando",
      contact_id: "ct-1",
    });
    expect(r.data[0]?.canal).toBeTruthy();
  });
});

/**
 * OS FILTROS QUE A ABA GANHOU (desenho de 2026-10-08): atendente, meio, período
 * e assunto. O pedido veio de quem atende — "as conversas finalizadas aqui são
 * todas misturadas de todos os atendentes".
 */
describe("atendente, meio, período e assunto viram predicado", () => {
  const MARIA = "8d9f3c1e-0000-4000-8000-00000000000a";
  const ASSUNTO = "8d9f3c1e-0000-4000-8000-00000000000b";

  async function predicados(extra: Record<string, string>) {
    const { client, chamadas } = fakeSupabase({ atendimentos: [] });
    await listarAtendimentosFechados(client, ctx, consulta(extra));
    return chamadas;
  }

  it("⭐ `assigned_to=me` é quem estava com a conversa NO ENCERRAMENTO — e o `me` é o usuário da sessão", async () => {
    const c = await predicados({ assigned_to: "me" });
    // `atendimentos.assigned_to_user_id`, carimbado no fechamento. O dono ATUAL
    // da conversa não serve: ela perde o dono quando o cliente volta (0269), e o
    // histórico de quem atendeu sumiria do "Só as minhas".
    expect(args(c, "atendimentos", "eq")).toContain('["assigned_to_user_id","user-1"]');
    expect(args(c, "atendimentos", "eq")).not.toContain("conversations.assigned_to_user_id");
    // Nunca "quem clicou em encerrar": o supervisor que fecha a conversa parada
    // de um atendente não vira dono dela.
    expect(args(c, "atendimentos", "eq")).not.toContain("closed_by_user_id");
  });

  it("um atendente pelo id filtra o mesmo campo", async () => {
    const c = await predicados({ assigned_to: MARIA });
    expect(args(c, "atendimentos", "eq")).toContain(`["assigned_to_user_id","${MARIA}"]`);
  });

  it("`unassigned` é `is null`: o que foi encerrado sem ninguém ter assumido", async () => {
    const c = await predicados({ assigned_to: "unassigned" });
    expect(args(c, "atendimentos", "is")).toContain('["assigned_to_user_id",null]');
    expect(args(c, "atendimentos", "eq")).not.toContain("assigned_to_user_id");
  });

  it("o MEIO é da conversa, pelo mesmo `!inner` do número", async () => {
    const c = await predicados({ channel: "phone" });
    expect(args(c, "atendimentos", "eq")).toContain('["conversations.channel","phone"]');
  });

  it("o período recorta `closed_at`: de inclusivo, até exclusivo", async () => {
    const c = await predicados({
      closed_from: "2026-10-08T03:00:00.000Z",
      closed_to: "2026-10-09T03:00:00.000Z",
    });
    expect(args(c, "atendimentos", "gte")).toContain('["closed_at","2026-10-08T03:00:00.000Z"]');
    expect(args(c, "atendimentos", "lt")).toContain('["closed_at","2026-10-09T03:00:00.000Z"]');
  });

  it("só o começo do período (\"hoje\", \"últimos 7 dias\") não inventa um fim", async () => {
    const c = await predicados({ closed_from: "2026-10-08T03:00:00.000Z" });
    expect(args(c, "atendimentos", "gte")).toContain('["closed_at","2026-10-08T03:00:00.000Z"]');
    expect(c.some((x) => x.tabela === "atendimentos" && x.metodo === "lt")).toBe(false);
  });

  it("o assunto é o do atendimento", async () => {
    const c = await predicados({ assunto_id: ASSUNTO });
    expect(args(c, "atendimentos", "eq")).toContain(`["assunto_id","${ASSUNTO}"]`);
  });

  it("CONTROLE: sem filtro, nenhum predicado novo", async () => {
    const c = await predicados({});
    const eqs = args(c, "atendimentos", "eq");
    expect(eqs).not.toContain("assigned_to_user_id");
    expect(eqs).not.toContain("assunto_id");
    expect(eqs).not.toContain("conversations.channel");
    expect(c.some((x) => x.metodo === "gte" || x.metodo === "lt")).toBe(false);
  });

  it("todos juntos convivem com os que já existiam", async () => {
    const c = await predicados({
      assigned_to: MARIA,
      channel: "whatsapp",
      closed_from: "2026-10-01T03:00:00.000Z",
      assunto_id: ASSUNTO,
      tag: "urgente",
    });
    const eqs = args(c, "atendimentos", "eq");
    expect(eqs).toContain('["organization_id","org-1"]');
    expect(eqs).toContain(`["assigned_to_user_id","${MARIA}"]`);
    expect(eqs).toContain('["conversations.channel","whatsapp"]');
    expect(eqs).toContain(`["assunto_id","${ASSUNTO}"]`);
    expect(args(c, "atendimentos", "contains")).toContain('["conversations.tags",["urgente"]]');
  });

  it.each([
    ["assigned_to", "qualquer-coisa"],
    ["channel", "fax"],
    ["closed_from", "ontem"],
    ["closed_to", "2026-10-08"],
    ["assunto_id", "abc"],
  ])("o schema recusa `%s=%s` — filtro fora de forma não vira lista menor em silêncio", (chave, valor) => {
    expect(listarFechadosSchema.safeParse({ [chave]: valor }).success).toBe(false);
  });
});
