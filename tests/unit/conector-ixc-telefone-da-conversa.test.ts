/**
 * `telefoneEhIdentidadeNaConversa` (`app/api/v1/contacts/[id]/conectores/ixc/_contexto.ts`)
 * — a pergunta que decide se o painel do IXC pode vincular um único candidato
 * sozinho: o telefone da conversa aberta é a identidade do canal, ou foi
 * DIGITADO pelo visitante (chat do site)?
 *
 * O admin falso abaixo reproduz só o que a função usa: `from(tabela).select().
 * eq().eq()[.eq()].maybeSingle()`, registrando os filtros de cada chamada para
 * provar que `organization_id` e `contact_id` vêm do CONTEXTO (nunca do
 * pedido) — é a mesma garantia que a doutrina de admin client exige.
 *
 * Os quatro módulos que `_contexto.ts` importa e que esta função NÃO usa
 * (`require-role`, `supabase/server`, `supabase/admin`, `conectores/conexao`)
 * são mockados só para o import do arquivo não puxar env real nem tocar rede —
 * o objeto `ctx` é montado à mão, sem passar por `contextoIxc()`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/conectores/conexao", () => ({ carimbarEstado: vi.fn(), lerCredencial: vi.fn() }));

import { telefoneEhIdentidadeNaConversa, type ContextoIxc } from "@/app/api/v1/contacts/[id]/conectores/ixc/_contexto";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const CONTATO_ID = "44444444-4444-4444-8444-444444444444";
const OUTRO_CONTATO_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSA_ID = "66666666-6666-4666-8666-666666666666";
const SESSAO_ID = "77777777-7777-4777-8777-777777777777";

type Filtros = Record<string, unknown>;
type Chamada = { tabela: string; filtros: Filtros };

/**
 * Um admin de mentira: encadeia `select/eq/maybeSingle` como o Supabase client
 * de verdade, registra CADA chamada (tabela + filtros acumulados) em `chamadas`,
 * e devolve a linha que o `resolver` da tabela decidir a partir desses filtros.
 */
function adminFalso(
  resolvers: Partial<Record<"conversations" | "channel_sessions", (filtros: Filtros) => Record<string, unknown> | null>>,
) {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    from(tabela: string) {
      const filtros: Filtros = {};
      const chain = {
        select: () => chain,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          return chain;
        },
        maybeSingle: async () => {
          chamadas.push({ tabela, filtros: { ...filtros } });
          const resolver = resolvers[tabela as "conversations" | "channel_sessions"];
          return { data: resolver ? resolver(filtros) : null, error: null };
        },
      };
      return chain;
    },
  };
}

function ctxCom(admin: ReturnType<typeof adminFalso>): Extract<ContextoIxc, { ok: true }> {
  return {
    ok: true,
    admin: admin as never,
    orgId: ORG_ID,
    contato: { id: CONTATO_ID, phone_number: "+5511987654321" },
    userId: "user-1",
    credencial: {} as never,
    t: (texto: string) => texto,
    idioma: "pt-BR",
  };
}

describe("telefoneEhIdentidadeNaConversa", () => {
  it("sem conversationId → false, sem consultar o banco", async () => {
    const admin = adminFalso({});
    expect(await telefoneEhIdentidadeNaConversa(ctxCom(admin), null)).toBe(false);
    expect(admin.chamadas).toEqual([]);
  });

  it("conversationId que não é UUID → false, sem consultar o banco", async () => {
    const admin = adminFalso({});
    expect(await telefoneEhIdentidadeNaConversa(ctxCom(admin), "não-é-um-uuid")).toBe(false);
    expect(admin.chamadas).toEqual([]);
  });

  it("conversa de OUTRO contato → false (o admin falso só devolve a linha quando o contact_id filtrado é o do contexto)", async () => {
    const admin = adminFalso({
      conversations: (f) =>
        f.contact_id === CONTATO_ID ? { channel_session_id: SESSAO_ID } : null,
    });
    // O contexto pede pelo contato OUTRO_CONTATO_ID: o admin falso não acha a linha
    // porque simula uma conversa que pertence a um contato diferente.
    const ctx = { ...ctxCom(admin), contato: { id: OUTRO_CONTATO_ID, phone_number: null } };
    expect(await telefoneEhIdentidadeNaConversa(ctx, CONVERSA_ID)).toBe(false);
  });

  it("sessão sem provider → false", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: null }),
    });
    expect(await telefoneEhIdentidadeNaConversa(ctxCom(admin), CONVERSA_ID)).toBe(false);
  });

  it("provider site_widget → false (o telefone foi digitado pelo visitante)", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "site_widget" }),
    });
    expect(await telefoneEhIdentidadeNaConversa(ctxCom(admin), CONVERSA_ID)).toBe(false);
  });

  it("controle positivo: provider waha → true", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "waha" }),
    });
    expect(await telefoneEhIdentidadeNaConversa(ctxCom(admin), CONVERSA_ID)).toBe(true);
  });

  it("os filtros nas DUAS consultas vêm do CONTEXTO — organization_id e contact_id nunca do pedido", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "waha" }),
    });
    await telefoneEhIdentidadeNaConversa(ctxCom(admin), CONVERSA_ID);

    expect(admin.chamadas).toHaveLength(2);
    const [conversas, sessoes] = admin.chamadas;
    expect(conversas).toEqual({
      tabela: "conversations",
      filtros: { id: CONVERSA_ID, contact_id: CONTATO_ID, organization_id: ORG_ID },
    });
    expect(sessoes).toEqual({
      tabela: "channel_sessions",
      filtros: { id: SESSAO_ID, organization_id: ORG_ID },
    });
    // Nem OUTRA_ORG nem qualquer coisa fora do contexto entra em filtro nenhum.
    for (const chamada of admin.chamadas) expect(Object.values(chamada.filtros)).not.toContain(OUTRA_ORG);
  });
});
