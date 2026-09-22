/**
 * `identidadeDoTelefoneNaConversa` (`app/api/v1/contacts/[id]/conectores/ixc/_contexto.ts`)
 * — a pergunta que decide se o painel do IXC pode vincular um único candidato
 * sozinho e se pode descartar um vínculo por telefone já gravado. É TRI-ESTADO,
 * não booleano: `"sim"` (identidade), `"nao"` (chat do site — telefone
 * DIGITADO) e `"desconhecido"` (sem `?conversa=`, id que não existe/não é
 * deste contato-org, sessão sem provider reconhecido). Só `"nao"` autoriza
 * descartar vínculo já gravado — colapsar em booleano fazia "não sei" se
 * passar por "definitivamente não", escondendo vínculo de WhatsApp de verdade.
 *
 * O admin falso abaixo reproduz só o que a função usa: `from(tabela).select().
 * eq().eq()[.eq()].maybeSingle()`, registrando os filtros de cada chamada. O
 * `resolver` de cada tabela só devolve a linha quando TODO FILTRO QUE FOI
 * REALMENTE APLICADO bate com o dono esperado — filtro que a implementação
 * deixasse de aplicar (um `.eq()` removido) simplesmente não aparece em
 * `filtros`, e por isso NÃO barra a devolução da linha: é assim que o teste de
 * "conversa de outro contato" reprovaria de verdade se o `.eq("contact_id")`
 * sumisse do código (a linha vazaria, a sessão devolveria "waha", e o
 * resultado seria "sim" em vez de "desconhecido").
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

import { identidadeDoTelefoneNaConversa, type ContextoIxc } from "@/app/api/v1/contacts/[id]/conectores/ixc/_contexto";

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

/**
 * Só devolve `linha` se TODO filtro que a chamada de fato aplicou bate com o
 * `esperado` (o dono de verdade). Uma chave de `esperado` que NÃO aparecer em
 * `filtros` — porque o `.eq()` correspondente sumiu da implementação — não
 * barra nada: é essa omissão que expõe o vazamento nos testes que simulam um
 * pedido de fora do escopo.
 */
function linhaSeDonoCasa(filtros: Filtros, esperado: Filtros, linha: Record<string, unknown>): Record<string, unknown> | null {
  for (const [chave, valor] of Object.entries(esperado)) {
    if (chave in filtros && filtros[chave] !== valor) return null;
  }
  return linha;
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

describe("identidadeDoTelefoneNaConversa", () => {
  it("sem conversationId → desconhecido, sem consultar o banco", async () => {
    const admin = adminFalso({});
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), null)).toBe("desconhecido");
    expect(admin.chamadas).toEqual([]);
  });

  it("conversationId que não é UUID → desconhecido, sem consultar o banco", async () => {
    const admin = adminFalso({});
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), "não-é-um-uuid")).toBe("desconhecido");
    expect(admin.chamadas).toEqual([]);
  });

  it("conversa de OUTRO contato → desconhecido (reprovaria com 'sim' se o .eq('contact_id') sumisse — ver linhaSeDonoCasa)", async () => {
    const admin = adminFalso({
      conversations: (f) =>
        linhaSeDonoCasa(f, { id: CONVERSA_ID, contact_id: CONTATO_ID, organization_id: ORG_ID }, { channel_session_id: SESSAO_ID }),
      // Provider bem "positivo": se o vazamento acontecer, o resultado final
      // vira "sim" — um jeito difícil de não notar no CI.
      channel_sessions: (f) => linhaSeDonoCasa(f, { id: SESSAO_ID, organization_id: ORG_ID }, { provider: "waha" }),
    });
    // O contexto pede pelo contato OUTRO_CONTATO_ID: o filtro real aplicado é
    // contact_id=OUTRO_CONTATO_ID, que diverge do dono esperado (CONTATO_ID) —
    // e como a chave FOI aplicada, `linhaSeDonoCasa` barra.
    const ctx = { ...ctxCom(admin), contato: { id: OUTRO_CONTATO_ID, phone_number: null } };
    expect(await identidadeDoTelefoneNaConversa(ctx, CONVERSA_ID)).toBe("desconhecido");
  });

  it("sessão sem provider → desconhecido", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: null }),
    });
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), CONVERSA_ID)).toBe("desconhecido");
  });

  it("provider site_widget → nao (o telefone foi digitado pelo visitante)", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "site_widget" }),
    });
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), CONVERSA_ID)).toBe("nao");
  });

  it("provider fora da matriz (imagem antiga que não conhece um canal novo) → desconhecido, não 'nao'", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "provider-que-nao-existe" }),
    });
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), CONVERSA_ID)).toBe("desconhecido");
  });

  it("controle positivo: provider waha → sim", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "waha" }),
    });
    expect(await identidadeDoTelefoneNaConversa(ctxCom(admin), CONVERSA_ID)).toBe("sim");
  });

  it("os filtros nas DUAS consultas vêm do CONTEXTO — organization_id e contact_id nunca do pedido", async () => {
    const admin = adminFalso({
      conversations: () => ({ channel_session_id: SESSAO_ID }),
      channel_sessions: () => ({ provider: "waha" }),
    });
    await identidadeDoTelefoneNaConversa(ctxCom(admin), CONVERSA_ID);

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
