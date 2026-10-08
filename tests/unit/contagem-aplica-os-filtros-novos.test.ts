/**
 * O SELO DE CADA ABA ACOMPANHA OS FILTROS NOVOS — e só os que valem para ela.
 *
 * A regra é a de sempre ("badge que conta o que a aba não mostra manda procurar
 * trabalho que não existe"); o que muda é que os filtros novos NÃO valem em toda
 * aba, e errar para qualquer dos dois lados é defeito:
 *
 *   · o MEIO vale em todas — é da conversa;
 *   · o ATENDENTE vale em Todas (e nos chips de time, que são de Todas) e em
 *     Fechadas. Em Minhas a aba já é "eu"; Fila e Automático não têm atendente
 *     por definição — aplicá-lo ali zeraria um selo cuja lista não muda;
 *   · PERÍODO e ASSUNTO são do atendimento encerrado: só Fechadas.
 *
 * É a mesma tabela de `ONDE_VALE` (`lib/inbox/filtros-de-tela.ts`), que decide o
 * que a LISTA de cada aba recebe. Este arquivo é o lado do servidor dela.
 *
 * Dublê com DADOS, e não com registro de chamadas: o que se afirma é o número
 * que sai, que é o que a tela estampa.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const org = "33333333-3333-4333-8333-333333333333";
const ANA = "usuario";
const BRUNO = "44444444-4444-4444-8444-444444444444";
const TIME = "55555555-5555-4555-8555-555555555555";
const ASSUNTO_1 = "66666666-6666-4666-8666-666666666661";
const ASSUNTO_2 = "66666666-6666-4666-8666-666666666662";

type Linha = Record<string, unknown>;

const conversas: Linha[] = [
  { id: "c1", status: "open", channel: "whatsapp", assigned_to_user_id: ANA, comando_da_conversa: "humano", team_id: TIME },
  { id: "c2", status: "open", channel: "phone", assigned_to_user_id: BRUNO, comando_da_conversa: "humano", team_id: TIME },
  { id: "c3", status: "open", channel: "phone", assigned_to_user_id: null, comando_da_conversa: "aguardando", team_id: null },
  { id: "c4", status: "open", channel: "whatsapp", assigned_to_user_id: null, comando_da_conversa: "automatico", team_id: null },
  { id: "c5", status: "open", channel: "site_chat", assigned_to_user_id: null, comando_da_conversa: "aguardando", team_id: null },
  // NA FILA DO TIME: foi para o Suporte, ninguém pegou e o automático saiu do
  // comando (`bot_silenced_until` no futuro) — é o que o botão "Na fila N" conta.
  { id: "c6", status: "open", channel: "whatsapp", assigned_to_user_id: null, comando_da_conversa: "aguardando", team_id: TIME, bot_silenced_until: "9999-12-31T00:00:00.000Z" },
].map((l) => ({ ...l, organization_id: org }));

// As colunas da conversa chegam com o prefixo do embed, como a consulta as nomeia.
const atendimentos: Linha[] = [
  { id: "a1", assigned_to_user_id: ANA, closed_at: "2026-10-08T12:00:00.000Z", assunto_id: ASSUNTO_1, "conversations.channel": "whatsapp" },
  { id: "a2", assigned_to_user_id: ANA, closed_at: "2026-10-07T12:00:00.000Z", assunto_id: ASSUNTO_2, "conversations.channel": "phone" },
  { id: "a3", assigned_to_user_id: BRUNO, closed_at: "2026-10-08T15:00:00.000Z", assunto_id: ASSUNTO_1, "conversations.channel": "whatsapp" },
  { id: "a4", assigned_to_user_id: null, closed_at: "2026-10-01T12:00:00.000Z", assunto_id: null, "conversations.channel": "site_chat" },
  // Ainda aberto: nunca conta em Fechadas, com filtro ou sem.
  { id: "a5", assigned_to_user_id: ANA, closed_at: null, assunto_id: null, "conversations.channel": "whatsapp" },
].map((l) => ({ ...l, organization_id: org }));

function bancoFalso() {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: ANA } }, error: null }) },
    from(tabela: string) {
      const filtros: Array<(linha: Linha) => boolean> = [];
      const query = {
        select() { return query; },
        order() { return query; },
        limit() { return query; },
        eq(coluna: string, valor: unknown) { filtros.push((l) => l[coluna] === valor); return query; },
        is(coluna: string, valor: unknown) { filtros.push((l) => (l[coluna] ?? null) === valor); return query; },
        in(coluna: string, valores: unknown[]) { filtros.push((l) => valores.includes(l[coluna])); return query; },
        gt(coluna: string, valor: number | string) {
          filtros.push((l) => (typeof valor === "string" ? String(l[coluna] ?? "") > valor : Number(l[coluna]) > valor));
          return query;
        },
        gte(coluna: string, valor: string) { filtros.push((l) => typeof l[coluna] === "string" && String(l[coluna]) >= valor); return query; },
        lt(coluna: string, valor: string | number) {
          filtros.push((l) => (typeof valor === "string" ? typeof l[coluna] === "string" && String(l[coluna]) < valor : Number(l[coluna]) < valor));
          return query;
        },
        contains() { return query; },
        or() { return query; },
        ilike() { return query; },
        not(coluna: string, operador: string, valores: unknown) {
          if (operador === "in") {
            const excluidos = String(valores).replace(/[()]/g, "").split(",");
            filtros.push((l) => !excluidos.includes(String(l[coluna])));
          } else if (operador === "is" && valores === null) {
            filtros.push((l) => (l[coluna] ?? null) !== null);
          }
          return query;
        },
        then(resolve: (resultado: unknown) => unknown) {
          const fonte =
            tabela === "attendance_teams"
              ? [{ id: TIME, name: "Suporte", organization_id: org }]
              : tabela === "atendimentos"
                ? atendimentos
                : conversas;
          const visiveis = fonte.filter((linha) => filtros.every((filtro) => filtro(linha)));
          return Promise.resolve(
            resolve({ data: tabela === "attendance_teams" ? visiveis : null, count: visiveis.length, error: null }),
          );
        },
      };
      return query;
    },
  };
  return { client };
}

const banco = bancoFalso();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco.client }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: org }),
}));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => true }));

const { GET } = await import("@/app/api/v1/conversations/counts/route");

async function contar(qs = "") {
  const resposta = await GET(new NextRequest(`http://localhost/api/v1/conversations/counts${qs}`));
  return { status: resposta.status, data: (await resposta.json()).data };
}

const SEM_FILTRO = { fila: 3, automatico: 1, mine: 1, all: 6, closed: 4 };

function selos(data: Record<string, number>) {
  return { fila: data.fila, automatico: data.automatico, mine: data.mine, all: data.all, closed: data.closed };
}

describe("a linha de base do dublê", () => {
  it("CONTROLE: sem filtro, os cinco selos contam o que há — se isto mudar, os casos abaixo medem outra coisa", async () => {
    const { status, data } = await contar();
    expect(status).toBe(200);
    expect(selos(data)).toEqual(SEM_FILTRO);
  });
});

describe("o MEIO vale em todas as abas", () => {
  it("⭐ `channel=phone` recorta os cinco selos", async () => {
    const { data } = await contar("?channel=phone");
    expect(selos(data)).toEqual({ fila: 1, automatico: 0, mine: 0, all: 2, closed: 1 });
    // CONTROLE do recorte: o WhatsApp fica com o resto.
    expect(selos((await contar("?channel=whatsapp")).data)).toEqual({
      fila: 1,
      automatico: 1,
      mine: 1,
      all: 3,
      closed: 2,
    });
  });
});

describe("o ATENDENTE vale em Todas e em Fechadas — e em mais nenhuma", () => {
  it("⭐ `assigned_to=me` é o usuário da sessão", async () => {
    const { data } = await contar("?assigned_to=me");
    expect(data.all).toBe(1);
    expect(data.closed).toBe(2);
  });

  it("um colega pelo id", async () => {
    const { data } = await contar(`?assigned_to=${BRUNO}`);
    expect([data.all, data.closed]).toEqual([1, 1]);
  });

  it("`unassigned`: o que não tem dono", async () => {
    const { data } = await contar("?assigned_to=unassigned");
    expect([data.all, data.closed]).toEqual([4, 1]);
  });

  it("⛔ Fila, Automático e Minhas NÃO mudam: as listas delas ignoram o filtro", async () => {
    for (const qs of ["?assigned_to=me", `?assigned_to=${BRUNO}`, "?assigned_to=unassigned"]) {
      const { data } = await contar(qs);
      expect([data.fila, data.automatico, data.mine], qs).toEqual([
        SEM_FILTRO.fila,
        SEM_FILTRO.automatico,
        SEM_FILTRO.mine,
      ]);
    }
  });

  it("os chips de time são de Todas: acompanham o atendente", async () => {
    const semFiltro = (await contar("?by_team=true")).data.by_team;
    expect(semFiltro).toContainEqual({ team_id: TIME, name: "Suporte", count: 3, na_fila: 1 });
    const { data } = await contar("?by_team=true&assigned_to=me");
    expect(data.by_team).toContainEqual({ team_id: TIME, name: "Suporte", count: 1, na_fila: 0 });
  });

  it("⭐ o botão \"Na fila N\" acompanha o atendente: na fila é conversa SEM dono", async () => {
    // Achado da revisão: com um atendente escolhido o botão seguia dizendo
    // "Na fila 1", e o clique abria uma lista vazia — fila de time não tem dono.
    const naFila = async (qs: string) =>
      ((await contar(`?by_team=true${qs}`)).data.by_team as Array<{ team_id: string | null; na_fila: number }>).find(
        (g) => g.team_id === TIME,
      )?.na_fila;
    expect(await naFila("")).toBe(1);
    expect(await naFila("&assigned_to=me")).toBe(0);
    expect(await naFila(`&assigned_to=${BRUNO}`)).toBe(0);
    // "Sem atendente" é justamente quem está na fila: o número não muda.
    expect(await naFila("&assigned_to=unassigned")).toBe(1);
  });
});

describe("PERÍODO e ASSUNTO são do atendimento encerrado: só Fechadas", () => {
  it("⭐ a partir de um instante (\"hoje\")", async () => {
    const { data } = await contar("?closed_from=2026-10-08T00:00:00.000Z");
    expect(data.closed).toBe(2);
  });

  it("entre dois instantes (\"ontem\"): de inclusivo, até exclusivo", async () => {
    const { data } = await contar("?closed_from=2026-10-07T00:00:00.000Z&closed_to=2026-10-08T00:00:00.000Z");
    expect(data.closed).toBe(1);
  });

  it("por assunto", async () => {
    expect((await contar(`?assunto_id=${ASSUNTO_1}`)).data.closed).toBe(2);
  });

  it("⛔ as abas de conversa aberta não mudam", async () => {
    for (const qs of ["?closed_from=2026-10-08T00:00:00.000Z", `?assunto_id=${ASSUNTO_1}`]) {
      const { data } = await contar(qs);
      expect({ ...selos(data), closed: undefined }, qs).toEqual({ ...SEM_FILTRO, closed: undefined });
    }
  });

  it("todos juntos: os da Ana, por WhatsApp, de hoje, do assunto 1", async () => {
    const { data } = await contar(
      `?assigned_to=me&channel=whatsapp&closed_from=2026-10-08T00:00:00.000Z&assunto_id=${ASSUNTO_1}`,
    );
    expect(data.closed).toBe(1);
  });
});

describe("filtro fora de forma é recusado, não ignorado", () => {
  it.each([
    "?assigned_to=qualquer-coisa",
    "?channel=fax",
    "?closed_from=ontem",
    "?closed_to=2026-10-08",
    "?assunto_id=abc",
  ])("`%s` responde 422 — um selo calculado sem o filtro pareceria resposta", async (qs) => {
    expect((await contar(qs)).status).toBe(422);
  });
});
