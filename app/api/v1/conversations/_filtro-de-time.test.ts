/**
 * O FILTRO DE TIME, MEDIDO SEM BANCO.
 *
 * O que estes casos guardam é a TRADUÇÃO do parâmetro em predicado — e ela é
 * onde o defeito silencioso mora. As três formas produzem SQL diferente, e
 * trocar uma pela outra não quebra nada: devolve uma lista plausível e errada.
 *
 *   `none`   tem de virar `is null` (a fila geral). Virar `eq "none"` seria um
 *            `22P02` no Postgres; virar "sem filtro" devolveria a organização
 *            inteira com a tela dizendo "fila geral".
 *   `mine`   tem de somar os times da pessoa COM as sem time. Sem o `is.null`,
 *            criar o primeiro time faria a fila geral sumir da tela de todos.
 *   `<uuid>` tem de virar igualdade.
 *
 * O dublê registra a CHAMADA, e não o SQL: o que se mede aqui é a decisão. O
 * comportamento contra o PostgREST de verdade é assunto de `tests/e2e`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  aplicarPredicadoDeTime,
  predicadoDeTime,
  type ConsultaFiltravel,
} from "./_filtro-de-time";

const ORG = "10000000-0000-4000-8000-000000000001";
const PESSOA = "10000000-0000-4000-8000-000000000002";
const TIME_A = "10000000-0000-4000-8000-00000000000a";
const TIME_B = "10000000-0000-4000-8000-00000000000b";

/** Um builder de mentira que só anota o que lhe pediram. */
function consultaFalsa() {
  const chamadas: string[] = [];
  const q: ConsultaFiltravel & { chamadas: string[] } = {
    chamadas,
    is(coluna: string, valor: null) {
      chamadas.push(`is:${coluna}:${String(valor)}`);
      return this;
    },
    eq(coluna: string, valor: string) {
      chamadas.push(`eq:${coluna}:${valor}`);
      return this;
    },
    or(filtro: string) {
      chamadas.push(`or:${filtro}`);
      return this;
    },
  };
  return q;
}

/** O client de mentira: devolve os times de quem perguntar. */
function bancoComTimes(ids: string[]) {
  const eq = vi.fn();
  const select = vi.fn();
  const from = vi.fn();
  const filtros: Array<[string, string]> = [];
  const encadeado = {
    select: (cols: string) => {
      select(cols);
      return encadeado;
    },
    eq: (coluna: string, valor: string) => {
      eq(coluna, valor);
      filtros.push([coluna, valor]);
      return encadeado;
    },
    then: (resolve: (v: { data: Array<{ team_id: string }> }) => unknown) =>
      resolve({ data: ids.map((id) => ({ team_id: id })) }),
  };
  return {
    db: { from: (tabela: string) => (from(tabela), encadeado) } as never,
    from,
    filtros,
  };
}

describe("predicadoDeTime", () => {
  it("sem parâmetro não filtra nada — e não vai ao banco", async () => {
    const { db, from } = bancoComTimes([]);
    expect(await predicadoDeTime(db, ORG, PESSOA, undefined)).toEqual({ tipo: "sem_filtro" });
    expect(await predicadoDeTime(db, ORG, PESSOA, null)).toEqual({ tipo: "sem_filtro" });
    expect(from).not.toHaveBeenCalled();
  });

  it("`none` é a fila geral", async () => {
    const { db, from } = bancoComTimes([]);
    expect(await predicadoDeTime(db, ORG, PESSOA, "none")).toEqual({ tipo: "sem_time" });
    expect(from).not.toHaveBeenCalled();
  });

  it("um uuid é um time só", async () => {
    const { db } = bancoComTimes([]);
    expect(await predicadoDeTime(db, ORG, PESSOA, TIME_A)).toEqual({
      tipo: "um_time",
      id: TIME_A,
    });
  });

  it("`mine` lê os times da pessoa, filtrando a organização explicitamente", async () => {
    const { db, from, filtros } = bancoComTimes([TIME_A, TIME_B]);
    expect(await predicadoDeTime(db, ORG, PESSOA, "mine")).toEqual({
      tipo: "meus_times",
      ids: [TIME_A, TIME_B],
    });
    expect(from).toHaveBeenCalledWith("attendance_team_members");
    // O handler pode estar com o client de service role (as tools MCP usam o
    // mesmo caminho), que passa por cima da RLS: sem este filtro, "meus times"
    // alcançaria alocação de OUTRA organização.
    expect(filtros).toContainEqual(["organization_id", ORG]);
    expect(filtros).toContainEqual(["user_id", PESSOA]);
  });

  it("`mine` de quem não está em time nenhum é a fila geral, não a lista inteira", async () => {
    const { db } = bancoComTimes([]);
    expect(await predicadoDeTime(db, ORG, PESSOA, "mine")).toEqual({ tipo: "sem_time" });
  });

  it("`mine` sem pessoa não vira lista inteira", async () => {
    // Ator de máquina. A rota recusa antes, mas a rede de baixo tem de existir:
    // devolver "sem filtro" aqui responderia a organização toda a uma pergunta
    // sobre uma pessoa.
    const { db } = bancoComTimes([TIME_A]);
    expect(await predicadoDeTime(db, ORG, null, "mine")).toEqual({ tipo: "sem_time" });
  });
});

describe("aplicarPredicadoDeTime", () => {
  it("`sem_filtro` não toca na consulta", () => {
    const q = consultaFalsa();
    aplicarPredicadoDeTime(q, { tipo: "sem_filtro" });
    expect(q.chamadas).toEqual([]);
  });

  it("`sem_time` vira `is null`", () => {
    const q = consultaFalsa();
    aplicarPredicadoDeTime(q, { tipo: "sem_time" });
    expect(q.chamadas).toEqual(["is:team_id:null"]);
  });

  it("`um_time` vira igualdade", () => {
    const q = consultaFalsa();
    aplicarPredicadoDeTime(q, { tipo: "um_time", id: TIME_A });
    expect(q.chamadas).toEqual([`eq:team_id:${TIME_A}`]);
  });

  it("`meus_times` soma os times DA PESSOA com as sem time", () => {
    const q = consultaFalsa();
    aplicarPredicadoDeTime(q, { tipo: "meus_times", ids: [TIME_A, TIME_B] });
    expect(q.chamadas).toEqual([`or:team_id.is.null,team_id.in.(${TIME_A},${TIME_B})`]);
  });

  it("CONTROLE: `meus_times` sem o `is.null` não passaria", () => {
    // Sem este caso, uma implementação que filtrasse SÓ os times da pessoa
    // passaria nos de cima — e a fila geral sumiria da tela de quem está em
    // algum time, que é o pior modo de falha desta feature: trabalho que ninguém
    // vê porque ninguém sabe que ele existe.
    const q = consultaFalsa();
    aplicarPredicadoDeTime(q, { tipo: "meus_times", ids: [TIME_A] });
    expect(q.chamadas[0]).toContain("team_id.is.null");
  });
});
