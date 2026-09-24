import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const timeA = "11111111-1111-4111-8111-111111111111";
const timeB = "22222222-2222-4222-8222-222222222222";
const org = "33333333-3333-4333-8333-333333333333";

const linhas = [
  ...Array.from({ length: 60 }, (_, i) => ({ id: `a-${i}`, team_id: timeA, status: "open", organization_id: org, assigned_to_user_id: null, comando_da_conversa: "aguardando", contact_id: i === 0 ? "contato-maria" : null, last_message_preview: "olá" })),
  { id: "a-fechada", team_id: timeA, status: "closed", organization_id: org, assigned_to_user_id: null, comando_da_conversa: "encerrada" },
  { id: "b-1", team_id: timeB, status: "pending", organization_id: org, assigned_to_user_id: null, comando_da_conversa: "aguardando", bot_silenced_until: "infinity" },
  ...Array.from({ length: 3 }, (_, i) => ({ id: `geral-${i}`, team_id: null, status: "open", organization_id: org, assigned_to_user_id: null, comando_da_conversa: "aguardando" })),
];

function bancoFalso() {
  const consultas: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "usuario" } }, error: null }) },
    from(tabela: string) {
      const filtros: Array<(linha: Record<string, unknown>) => boolean> = [];
      const query = {
        select() { return query; },
        order() { return query; },
        limit() { return query; },
        eq(coluna: string, valor: unknown) { consultas.push({ tabela, coluna, valor }); filtros.push((l) => l[coluna] === valor); return query; },
        is(coluna: string, valor: unknown) { consultas.push({ tabela, coluna, valor }); filtros.push((l) => l[coluna] === valor); return query; },
        gt(coluna: string, valor: number | string) {
          filtros.push((l) =>
            typeof valor === "string"
              ? // Carimbo: `infinity` é maior que qualquer data; ISO compara como texto.
                l[coluna] === "infinity" || (typeof l[coluna] === "string" && String(l[coluna]) > valor)
              : Number(l[coluna]) > valor,
          );
          return query;
        },
        contains() { return query; },
        in(coluna: string, valores: unknown[]) { filtros.push((l) => valores.includes(l[coluna])); return query; },
        or(predicado: string) {
          consultas.push({ tabela, coluna: "or", valor: predicado });
          if (tabela === "conversations") {
            filtros.push((linha) => predicado.includes(`contact_id.in.(${linha.contact_id})`) || String(linha.last_message_preview ?? "").toLowerCase().includes("maria"));
          }
          return query;
        },
        ilike(coluna: string, padrao: string) {
          filtros.push((linha) => String(linha[coluna] ?? "").toLowerCase().includes(padrao.replaceAll("%", "").toLowerCase()));
          return query;
        },
        not(coluna: string, operador: string, valores: string) {
          if (coluna === "status" && operador === "in") {
            const excluidos = valores.replace(/[()]/g, "").split(",");
            filtros.push((l) => !excluidos.includes(String(l.status)));
          }
          return query;
        },
        then(resolve: (resultado: unknown) => unknown) {
          const fonte = tabela === "attendance_teams"
            ? [{ id: timeA, name: "Cobrança", organization_id: org }, { id: timeB, name: "Suporte", organization_id: org }]
            : tabela === "contacts"
              ? [{ id: "contato-maria", display_name: "Maria", organization_id: org, is_anonymized: false }]
            : linhas;
          const visiveis = fonte.filter((linha) => filtros.every((filtro) => filtro(linha)));
          return Promise.resolve(resolve({ data: tabela === "attendance_teams" || tabela === "contacts" ? visiveis : null, count: visiveis.length, error: null }));
        },
      };
      return query;
    },
  };
  return { client, consultas };
}

const banco = bancoFalso();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco.client }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: org }),
}));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => true }));

const { GET } = await import("@/app/api/v1/conversations/counts/route");

describe("contagem exata da aba Todas por time", () => {
  it("conta todas as abertas além da primeira página e separa a fila geral", async () => {
    const response = await GET(new NextRequest("http://localhost/api/v1/conversations/counts?by_team=true"));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.all).toBe(64);
    expect(data.by_team).toEqual([
      { team_id: timeA, name: "Cobrança", count: 60, na_fila: 0 },
      { team_id: timeB, name: "Suporte", count: 1, na_fila: 1 },
      { team_id: null, name: null, count: 3, na_fila: 0 },
    ]);
    expect(banco.consultas).toContainEqual({ tabela: "attendance_teams", coluna: "organization_id", valor: org });
  });

  it("a busca por nome afeta o total e cada time pela mesma regra da lista", async () => {
    const response = await GET(new NextRequest("http://localhost/api/v1/conversations/counts?by_team=true&search=Maria"));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.all).toBe(1);
    expect(data.by_team).toEqual([
      { team_id: timeA, name: "Cobrança", count: 1, na_fila: 0 },
      { team_id: timeB, name: "Suporte", count: 0, na_fila: 0 },
      { team_id: null, name: null, count: 0, na_fila: 0 },
    ]);
  });

  it("as outras abas não fazem uma contagem por time", async () => {
    const anterior = banco.consultas.length;
    const response = await GET(new NextRequest("http://localhost/api/v1/conversations/counts"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.by_team).toBeUndefined();
    expect(banco.consultas.slice(anterior).filter((c) => c.tabela === "attendance_teams")).toEqual([]);
  });
  it("escolher um time NÃO zera os outros chips (by_team é contado sem o filtro de time)", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/conversations/counts?by_team=true&team_id=${timeB}`),
    );
    const { data } = await response.json();
    expect(data.by_team).toEqual([
      { team_id: timeA, name: "Cobrança", count: 60, na_fila: 0 },
      { team_id: timeB, name: "Suporte", count: 1, na_fila: 1 },
      { team_id: null, name: null, count: 3, na_fila: 0 },
    ]);
    // …mas a aba segue a lista: com o time escolhido, "Todas" conta só o Suporte.
    expect(data.all).toBe(1);
  });

  it("'Só na fila' entra na fábrica: a aba conta o que a lista mostra", async () => {
    const semFiltro = (await (await GET(new NextRequest("http://localhost/api/v1/conversations/counts"))).json()).data;
    const response = await GET(new NextRequest("http://localhost/api/v1/conversations/counts?na_fila=true"));
    const { data } = await response.json();
    expect(data.all).toBe(1);
    // …e SÓ a de Todas: as outras abas ignoram o chip, e o badge delas também.
    expect(data.fila).toBe(semFiltro.fila);
    expect(data.mine).toBe(semFiltro.mine);
    expect(data.automatico).toBe(semFiltro.automatico);
  });
});
