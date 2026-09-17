/**
 * A LISTA APLICA O FILTRO DE TIME — no banco, e não em memória.
 *
 * `_filtro-de-time.test.ts` mede a tradução do parâmetro em predicado. Este mede
 * o elo seguinte, que é onde a cadeia já rompeu duas vezes neste mesmo arquivo
 * (`tag`, e depois `comando`): o handler pode conhecer o filtro e não aplicá-lo,
 * e o sintoma é a lista voltar INTEIRA, sem erro nenhum — parecendo funcionar.
 *
 * O dublê registra as chamadas ao builder do PostgREST em vez do SQL: o que se
 * mede aqui é a decisão do handler.
 */
import { describe, expect, it } from "vitest";

import { listConversationsQuerySchema } from "@/lib/schemas";

import { listConversationsHandler } from "./_handler";

const ORG = "70000000-0000-4000-8000-000000000001";
const PESSOA = "70000000-0000-4000-8000-000000000002";
const TIME_A = "70000000-0000-4000-8000-00000000000a";
const TIME_B = "70000000-0000-4000-8000-00000000000b";

/** Um Supabase de mentira que anota o que lhe pediram e devolve lista vazia. */
function supabaseFalso(timesDaPessoa: string[] = []) {
  const chamadas: string[] = [];
  const tabelas: string[] = [];

  const consultaDeConversas = {
    select: () => consultaDeConversas,
    order: () => consultaDeConversas,
    limit: () => consultaDeConversas,
    in: (c: string) => (chamadas.push(`in:${c}`), consultaDeConversas),
    not: () => consultaDeConversas,
    gt: () => consultaDeConversas,
    contains: () => consultaDeConversas,
    ilike: () => consultaDeConversas,
    eq: (c: string, v: unknown) => (chamadas.push(`eq:${c}:${String(v)}`), consultaDeConversas),
    is: (c: string, v: unknown) => (chamadas.push(`is:${c}:${String(v)}`), consultaDeConversas),
    or: (f: string) => (chamadas.push(`or:${f}`), consultaDeConversas),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };

  const consultaDeMembros = {
    select: () => consultaDeMembros,
    eq: () => consultaDeMembros,
    then: (resolve: (v: { data: Array<{ team_id: string }> }) => unknown) =>
      resolve({ data: timesDaPessoa.map((id) => ({ team_id: id })) }),
  };

  const supabase = {
    from: (tabela: string) => {
      tabelas.push(tabela);
      return tabela === "attendance_team_members" ? consultaDeMembros : consultaDeConversas;
    },
  };
  return { supabase: supabase as never, chamadas, tabelas };
}

const ctx = (ator: "user" | "ai_agent" = "user") => ({
  organization_id: ORG,
  actor: { type: ator, id: PESSOA } as never,
  requestId: "req-1",
});

/** A query passa pelo SCHEMA de verdade — é ele que valida as três formas. */
const consulta = (team_id?: string) =>
  listConversationsQuerySchema.parse({ limit: 50, ...(team_id ? { team_id } : {}) });

describe("listConversationsHandler + team_id", () => {
  it("sem o parâmetro, nenhum predicado de time entra na consulta", async () => {
    const { supabase, chamadas, tabelas } = supabaseFalso();
    await listConversationsHandler(supabase, ctx(), consulta());
    expect(chamadas.filter((c) => c.includes("team_id"))).toEqual([]);
    expect(tabelas).not.toContain("attendance_team_members");
  });

  it("`none` filtra `team_id is null` — a fila geral", async () => {
    const { supabase, chamadas } = supabaseFalso();
    await listConversationsHandler(supabase, ctx(), consulta("none"));
    expect(chamadas).toContain("is:team_id:null");
  });

  it("um uuid filtra por igualdade", async () => {
    const { supabase, chamadas } = supabaseFalso();
    await listConversationsHandler(supabase, ctx(), consulta(TIME_A));
    expect(chamadas).toContain(`eq:team_id:${TIME_A}`);
  });

  it("`mine` cobre os times da pessoa MAIS as sem time", async () => {
    const { supabase, chamadas, tabelas } = supabaseFalso([TIME_A, TIME_B]);
    await listConversationsHandler(supabase, ctx(), consulta("mine"));
    expect(tabelas).toContain("attendance_team_members");
    expect(chamadas).toContain(`or:team_id.is.null,team_id.in.(${TIME_A},${TIME_B})`);
  });

  it("`mine` de quem não está em time nenhum é a fila geral, nunca a lista inteira", async () => {
    const { supabase, chamadas } = supabaseFalso([]);
    await listConversationsHandler(supabase, ctx(), consulta("mine"));
    expect(chamadas).toContain("is:team_id:null");
  });

  it("`mine` pedido por ator de máquina é recusado, não respondido pela metade", async () => {
    const { supabase, chamadas } = supabaseFalso([TIME_A]);
    await expect(
      listConversationsHandler(supabase, ctx("ai_agent"), consulta("mine")),
    ).rejects.toMatchObject({ status: 400 });
    expect(chamadas.filter((c) => c.includes("team_id"))).toEqual([]);
  });

  it("o filtro é SEMPRE composto sobre a consulta que já filtra a organização", async () => {
    // O handler é compartilhado com as tools MCP, que entram com o client de
    // service role — e ele passa por cima da RLS. O `eq:organization_id` é a
    // única barreira, e um filtro de time montado numa consulta nova nasceria
    // sem ela.
    const { supabase, chamadas } = supabaseFalso();
    await listConversationsHandler(supabase, ctx(), consulta(TIME_A));
    expect(chamadas[0]).toBe(`eq:organization_id:${ORG}`);
  });

  it("CONTROLE: o schema recusa valor fora das três formas", async () => {
    // Sem isto, um `team_id=qualquer-coisa` chegaria ao Postgres como `22P02` e
    // viraria 500 — erro de sistema para o que é uma URL inválida.
    expect(() => consulta("qualquer-coisa")).toThrow();
  });
});
