/**
 * A TABELA DOS FILTROS DO INBOX — em que aba cada um vale, e o que sai dela.
 *
 * O caso que mais importa é o último bloco, "a cerca": todo filtro que a tela
 * aplica é também nomeado no vazio. Era exatamente o que faltava ao TIME, e é o
 * tipo de falta que nasce de novo a cada filtro acrescentado.
 */
import { describe, expect, it } from "vitest";

import type { InboxTab } from "@/lib/inbox/abas";

import {
  contarFiltrosDoFunil,
  filtrosAplicados,
  nomesDosFiltros,
  ONDE_VALE,
  paraContagens,
  paraConversas,
  paraFechados,
  valeNaAba,
  type FiltrosDeTela,
} from "./filtros-de-tela";

const AGORA = new Date(2026, 9, 8, 15, 30);
const HOJE = new Date(2026, 9, 8).toISOString();
const NUMERO = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const ASSUNTO = "33333333-3333-4333-8333-333333333333";
const TIME = "44444444-4444-4444-8444-444444444444";

/** Tudo ligado de uma vez. (Meio E número juntos só existem num link editado à mão.) */
const TUDO: FiltrosDeTela = {
  search: "maria",
  onlyUnread: true,
  team_id: TIME,
  tag: "urgente",
  channel: "phone",
  channel_session_id: NUMERO,
  assigned_to: MARIA,
  periodo: "hoje",
  assunto_id: ASSUNTO,
  na_fila: true,
  ordem: "espera",
  insatisfeitos: true,
};
const NADA: FiltrosDeTela = { search: "", onlyUnread: false };

const COMUNS = ["channel", "channel_session_id", "search", "tag", "team_id", "unread"];
const chaves = (o: object) => Object.keys(o).sort();
const aplicadosEm = (tab: InboxTab) => chaves(filtrosAplicados(tab, TUDO, AGORA));

describe("⭐ o que vale em cada aba, com TUDO ligado", () => {
  it("Fila: só os comuns — o atendente não entra (a fila não tem dono)", () => {
    expect(aplicadosEm("unassigned")).toEqual(COMUNS);
  });

  it("Automático: só os comuns", () => {
    expect(aplicadosEm("ai")).toEqual(COMUNS);
  });

  it("Minhas: os comuns, a ordem e insatisfeitos — o atendente não entra (a aba já é \"eu\")", () => {
    expect(aplicadosEm("mine")).toEqual([...COMUNS, "insatisfeitos", "ordem"].sort());
  });

  it("Todas: os comuns, atendente, na fila, ordem e insatisfeitos", () => {
    expect(aplicadosEm("all")).toEqual(
      [...COMUNS, "assigned_to", "insatisfeitos", "na_fila", "ordem"].sort(),
    );
  });

  it("Fechadas: os comuns, atendente, período e assunto", () => {
    expect(aplicadosEm("closed")).toEqual([...COMUNS, "assigned_to", "assunto_id", "closed_from"].sort());
  });

  it("Telefone: nenhum — a aba lista ligações e tem os filtros dela", () => {
    expect(aplicadosEm("phone")).toEqual([]);
  });

  it("CONTROLE: com nada ligado, nada é aplicado em aba nenhuma", () => {
    for (const tab of ["unassigned", "mine", "all", "ai", "closed", "phone"] as const) {
      expect(filtrosAplicados(tab, NADA, AGORA), tab).toEqual({});
    }
  });

  it("nenhuma chave sai com `undefined`: espalhada por cima da aba, ela apagaria o filtro da aba", () => {
    const aplicados = filtrosAplicados("mine", TUDO, AGORA);
    expect(Object.values(aplicados).every((valor) => valor !== undefined)).toBe(true);
    expect("assigned_to" in aplicados).toBe(false);
  });
});

describe("os valores, não só as chaves", () => {
  it("o período vira instante no dia de quem olha", () => {
    expect(filtrosAplicados("closed", TUDO, AGORA).closed_from).toBe(HOJE);
  });

  it("uma letra só não é busca — a tela não pede o que a rota recusa", () => {
    expect(filtrosAplicados("all", { ...NADA, search: "a" }, AGORA)).toEqual({});
    expect(filtrosAplicados("all", { ...NADA, search: "ana" }, AGORA)).toEqual({ search: "ana" });
  });

  it("`ordem` vale em Todas e Minhas", () => {
    expect(filtrosAplicados("all", { ...NADA, ordem: "espera" }, AGORA)).toEqual({ ordem: "espera" });
    expect(filtrosAplicados("unassigned", { ...NADA, ordem: "espera" }, AGORA)).toEqual({});
  });

  it("`valeNaAba` lê a mesma tabela", () => {
    expect(valeNaAba("assigned_to", "closed")).toBe(true);
    expect(valeNaAba("assigned_to", "mine")).toBe(false);
    expect(valeNaAba("periodo", "all")).toBe(false);
  });
});

describe("o que vai para cada rota", () => {
  it("conversas: sem período nem assunto, que não existem numa conversa", () => {
    const filtros = paraConversas("all", filtrosAplicados("all", TUDO, AGORA));
    expect(chaves(filtros)).toEqual(
      [...COMUNS, "assigned_to", "insatisfeitos", "na_fila", "ordem"].sort(),
    );
  });

  it("⛔ em Fechadas, a consulta de conversas NÃO recebe o atendente — ali ele é o do atendimento", () => {
    const filtros = paraConversas("closed", filtrosAplicados("closed", TUDO, AGORA));
    expect("assigned_to" in filtros).toBe(false);
    expect(chaves(filtros)).toEqual(COMUNS);
  });

  it("fechados: atendente, período e assunto — e nada do que é só de conversa aberta", () => {
    const filtros = paraFechados(filtrosAplicados("closed", TUDO, AGORA));
    expect(filtros).toMatchObject({ assigned_to: MARIA, closed_from: HOJE, assunto_id: ASSUNTO, channel: "phone" });
    expect("na_fila" in filtros || "ordem" in filtros || "insatisfeitos" in filtros).toBe(false);
  });

  it("⭐ contagens: TODOS os ligados, sem olhar a aba — o selo diz o que o clique vai mostrar", () => {
    expect(chaves(paraContagens(TUDO, AGORA))).toEqual(
      [...COMUNS, "assigned_to", "assunto_id", "closed_from", "insatisfeitos", "na_fila"].sort(),
    );
  });

  it("contagens com nada ligado não mandam nada", () => {
    expect(paraContagens(NADA, AGORA)).toEqual({});
  });
});

describe("o funil e o vazio", () => {
  it("o funil conta o que mora DENTRO dele: time, etiqueta, caixa, atendente, período, assunto", () => {
    expect(contarFiltrosDoFunil(filtrosAplicados("closed", TUDO, AGORA))).toBe(6);
  });

  it("meio e número são UMA caixa de entrada, não duas", () => {
    expect(contarFiltrosDoFunil({ channel: "phone", channel_session_id: NUMERO })).toBe(1);
    expect(nomesDosFiltros({ channel: "phone", channel_session_id: NUMERO })).toEqual(["Caixa de entrada"]);
  });

  it("o funil NÃO conta o que tem botão próprio à vista", () => {
    expect(
      contarFiltrosDoFunil({ unread: true, search: "ana", na_fila: true, insatisfeitos: true, ordem: "espera" }),
    ).toBe(0);
  });

  it("o funil conta só o que vale NA ABA: o período ligado não conta em Todas", () => {
    expect(contarFiltrosDoFunil(filtrosAplicados("all", { ...NADA, periodo: "hoje" }, AGORA))).toBe(0);
    expect(contarFiltrosDoFunil(filtrosAplicados("closed", { ...NADA, periodo: "hoje" }, AGORA))).toBe(1);
  });

  it("o TIME é citado no vazio — era o filtro que a lista antiga esquecia", () => {
    expect(nomesDosFiltros({ team_id: "mine" })).toEqual(["Time"]);
  });

  it("a ordem não é citada: não esconde conversa nenhuma", () => {
    expect(nomesDosFiltros({ ordem: "espera" })).toEqual([]);
  });
});

/**
 * ⭐ A CERCA. Para cada filtro que ESCONDE linha, ligado sozinho numa aba onde
 * vale: ele chega ao servidor E é nomeado no vazio. Filtro novo acrescentado a
 * `ONDE_VALE` sem nome cai aqui.
 */
describe("a cerca: todo filtro aplicado é nomeado", () => {
  const SOZINHO: Record<Exclude<keyof typeof ONDE_VALE, "ordem">, Partial<FiltrosDeTela>> = {
    unread: { onlyUnread: true },
    search: { search: "maria" },
    team_id: { team_id: TIME },
    tag: { tag: "urgente" },
    caixa: { channel: "phone" },
    assigned_to: { assigned_to: "me" },
    periodo: { de: "2026-10-01", ate: "2026-10-03" },
    assunto_id: { assunto_id: ASSUNTO },
    na_fila: { na_fila: true },
    insatisfeitos: { insatisfeitos: true },
  };

  it("a tabela de casos cobre toda chave de `ONDE_VALE` (menos a ordem)", () => {
    expect(chaves(SOZINHO)).toEqual(chaves(ONDE_VALE).filter((chave) => chave !== "ordem"));
  });

  for (const [chave, parte] of Object.entries(SOZINHO)) {
    const abas = ONDE_VALE[chave as keyof typeof ONDE_VALE];
    it.each(abas.map((aba) => [aba]))(`\`${chave}\` em %s: aplicado e nomeado`, (aba) => {
      const aplicados = filtrosAplicados(aba, { ...NADA, ...parte }, AGORA);
      expect(Object.keys(aplicados).length, "o filtro não chegou ao servidor").toBeGreaterThan(0);
      expect(nomesDosFiltros(aplicados).length, "o filtro foi aplicado e o vazio não o nomeia").toBe(1);
    });

    const foraDaqui = (["unassigned", "mine", "all", "ai", "closed", "phone"] as const).filter(
      (aba) => !abas.includes(aba),
    );
    if (foraDaqui.length > 0) {
      it.each(foraDaqui.map((aba) => [aba]))(`\`${chave}\` em %s: nem aplicado, nem nomeado`, (aba) => {
        const aplicados = filtrosAplicados(aba, { ...NADA, ...parte }, AGORA);
        expect(aplicados).toEqual({});
        expect(nomesDosFiltros(aplicados)).toEqual([]);
      });
    }
  }
});
