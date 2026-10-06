import { describe, expect, it } from "vitest";

import { agruparAssuntos, percentual, type LinhaDeAssunto } from "./assuntos";

const linha = (parcial: Partial<LinhaDeAssunto>): LinhaDeAssunto => ({
  assunto_id: null,
  assunto_nome: null,
  assunto_team_id: null,
  assunto_team_nome: null,
  atendimento_team_id: null,
  atendimento_team_nome: null,
  total: 1,
  ...parcial,
});

const wifi = { assunto_id: "a-wifi", assunto_nome: "Wi-Fi", assunto_team_id: "t-sup", assunto_team_nome: "Suporte" };
const boleto = { assunto_id: "a-bol", assunto_nome: "Boleto", assunto_team_id: "t-cob", assunto_team_nome: "Cobrança" };

describe("agruparAssuntos", () => {
  it("lista vazia é zero em tudo, sem dividir por zero", () => {
    expect(agruparAssuntos([])).toEqual({
      total: 0,
      com_assunto: 0,
      sem_assunto: 0,
      sem_assunto_por_time: [],
      setores: [],
    });
  });

  it("soma as linhas do mesmo assunto atendidas por times diferentes", () => {
    const r = agruparAssuntos([
      linha({ ...wifi, atendimento_team_id: "t-sup", atendimento_team_nome: "Suporte", total: 7 }),
      linha({ ...wifi, atendimento_team_id: "t-com", atendimento_team_nome: "Comercial", total: 2 }),
      linha({ ...wifi, atendimento_team_id: null, total: 1 }),
    ]);
    expect(r.total).toBe(10);
    expect(r.setores).toHaveLength(1);
    expect(r.setores[0]).toMatchObject({ id: "t-sup", nome: "Suporte", total: 10 });
    expect(r.setores[0]!.assuntos).toEqual([{ id: "a-wifi", nome: "Wi-Fi", total: 10, de_outro_time: 2 }]);
  });

  it("atendimento SEM time não conta como 'de outro time'", () => {
    const r = agruparAssuntos([linha({ ...wifi, atendimento_team_id: null, total: 4 })]);
    expect(r.setores[0]!.assuntos[0]!.de_outro_time).toBe(0);
  });

  it("separa os sem assunto pelo time que atendeu, e 'sem time' é um deles", () => {
    const r = agruparAssuntos([
      linha({ ...boleto, atendimento_team_id: "t-cob", total: 5 }),
      linha({ atendimento_team_id: "t-sup", atendimento_team_nome: "Suporte", total: 3 }),
      linha({ atendimento_team_id: null, total: 8 }),
    ]);
    expect(r).toMatchObject({ total: 16, com_assunto: 5, sem_assunto: 11 });
    expect(r.sem_assunto_por_time).toEqual([
      { id: null, nome: null, total: 8 },
      { id: "t-sup", nome: "Suporte", total: 3 },
    ]);
  });

  it("ordena setores e assuntos do maior para o menor, e por nome no empate", () => {
    const r = agruparAssuntos([
      linha({ ...boleto, total: 2 }),
      linha({ ...wifi, total: 9 }),
      linha({ assunto_id: "a-len", assunto_nome: "Lentidão", assunto_team_id: "t-sup", assunto_team_nome: "Suporte", total: 9 }),
    ]);
    expect(r.setores.map((s) => s.nome)).toEqual(["Suporte", "Cobrança"]);
    expect(r.setores[0]!.assuntos.map((a) => a.nome)).toEqual(["Lentidão", "Wi-Fi"]);
  });

  it("aceita o total como texto (bigint do Postgres) e ignora lixo", () => {
    const r = agruparAssuntos([
      linha({ ...wifi, total: "12" }),
      linha({ ...wifi, total: "abc" }),
      linha({ ...wifi, total: -3 }),
    ]);
    expect(r.total).toBe(12);
  });
});

describe("percentual", () => {
  it("arredonda para inteiro e devolve 0 sem base", () => {
    expect(percentual(1, 3)).toBe(33);
    expect(percentual(2, 3)).toBe(67);
    expect(percentual(5, 0)).toBe(0);
  });
});
