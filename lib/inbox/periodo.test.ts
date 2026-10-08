/**
 * DO QUE A PESSOA ESCOLHEU PARA OS DOIS INSTANTES QUE O SERVIDOR RECEBE.
 *
 * O esperado é escrito com `new Date(ano, mês, dia)` — meia-noite LOCAL — e não
 * com uma string UTC fixa: a regra é "o dia de quem olha a tela", e um esperado
 * em UTC passaria só no fuso de quem escreveu o teste.
 */
import { describe, expect, it } from "vitest";

import { dataValida, hojeComoData, resolverPeriodo } from "./periodo";

/** Quinta, 8 de outubro de 2026, 15:30 — no fuso da máquina que roda o teste. */
const AGORA = new Date(2026, 9, 8, 15, 30);
const dia = (ano: number, mes: number, d: number) => new Date(ano, mes - 1, d).toISOString();

describe("as quatro escolhas prontas", () => {
  it("⭐ hoje: desde a meia-noite, sem fim", () => {
    expect(resolverPeriodo({ periodo: "hoje" }, AGORA)).toEqual({ closed_from: dia(2026, 10, 8) });
  });

  it("ontem: o dia inteiro — começo inclusivo, fim exclusivo na meia-noite de hoje", () => {
    expect(resolverPeriodo({ periodo: "ontem" }, AGORA)).toEqual({
      closed_from: dia(2026, 10, 7),
      closed_to: dia(2026, 10, 8),
    });
  });

  it("últimos 7 dias: hoje e os seis anteriores", () => {
    expect(resolverPeriodo({ periodo: "7d" }, AGORA)).toEqual({ closed_from: dia(2026, 10, 2) });
  });

  it("últimos 30 dias: hoje e os 29 anteriores — atravessa o mês", () => {
    expect(resolverPeriodo({ periodo: "30d" }, AGORA)).toEqual({ closed_from: dia(2026, 9, 9) });
  });

  it("o começo NÃO muda ao longo do dia — a chave da consulta fica estável", () => {
    const cedo = resolverPeriodo({ periodo: "hoje" }, new Date(2026, 9, 8, 0, 0, 1));
    const tarde = resolverPeriodo({ periodo: "hoje" }, new Date(2026, 9, 8, 23, 59, 59));
    expect(cedo).toEqual(tarde);
  });

  it("à meia-noite em ponto já é o dia novo", () => {
    expect(resolverPeriodo({ periodo: "hoje" }, new Date(2026, 9, 9, 0, 0, 0))).toEqual({
      closed_from: dia(2026, 10, 9),
    });
  });

  it("ontem no dia 1º volta para o mês anterior", () => {
    expect(resolverPeriodo({ periodo: "ontem" }, new Date(2026, 9, 1, 10))).toEqual({
      closed_from: dia(2026, 9, 30),
      closed_to: dia(2026, 10, 1),
    });
  });
});

describe("o intervalo de datas", () => {
  it("⭐ as duas datas são INCLUSIVAS: o fim vira a meia-noite do dia seguinte", () => {
    expect(resolverPeriodo({ de: "2026-10-01", ate: "2026-10-03" }, AGORA)).toEqual({
      closed_from: dia(2026, 10, 1),
      closed_to: dia(2026, 10, 4),
    });
  });

  it("um dia só é um intervalo de um dia", () => {
    expect(resolverPeriodo({ de: "2026-10-05", ate: "2026-10-05" }, AGORA)).toEqual({
      closed_from: dia(2026, 10, 5),
      closed_to: dia(2026, 10, 6),
    });
  });

  it("o último dia do mês vira o dia 1º do seguinte", () => {
    expect(resolverPeriodo({ de: "2026-10-31", ate: "2026-10-31" }, AGORA).closed_to).toBe(dia(2026, 11, 1));
  });

  it.each([
    ["começo depois do fim", { de: "2026-10-03", ate: "2026-10-01" }],
    ["só o começo", { de: "2026-10-01" }],
    ["só o fim", { ate: "2026-10-01" }],
    ["data que não existe", { de: "2026-02-30", ate: "2026-03-01" }],
    ["forma errada", { de: "01/10/2026", ate: "03/10/2026" }],
  ])("%s: nenhum recorte — metade de um período não é um período", (_nome, escolha) => {
    expect(resolverPeriodo(escolha, AGORA)).toEqual({});
  });

  it("a escolha pronta vence as datas quando as duas vêm", () => {
    expect(resolverPeriodo({ periodo: "hoje", de: "2026-01-01", ate: "2026-01-31" }, AGORA)).toEqual({
      closed_from: dia(2026, 10, 8),
    });
  });

  it("CONTROLE: nada escolhido, nada recortado", () => {
    expect(resolverPeriodo({}, AGORA)).toEqual({});
  });
});

describe("as datas", () => {
  it.each(["2026-10-08", "2024-02-29", "2026-12-31"])("`%s` existe", (data) => {
    expect(dataValida(data)).toBe(true);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "08/10/2026", ""])(
    "`%s` não existe ou não tem a forma",
    (data) => {
      expect(dataValida(data)).toBe(false);
    },
  );

  it("hoje como data, no fuso de quem olha — com zero à esquerda", () => {
    expect(hojeComoData(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(hojeComoData(AGORA)).toBe("2026-10-08");
  });
});
