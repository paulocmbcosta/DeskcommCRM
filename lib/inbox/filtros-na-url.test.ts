/**
 * OS FILTROS NO ENDEREÇO — ida e volta, e o que um link quebrado faz.
 */
import { describe, expect, it } from "vitest";

import {
  escreverFiltrosNaUrl,
  lerFiltrosDaUrl,
  PARAMETROS_DE_FILTRO,
  type FiltrosNaUrl,
} from "./filtros-na-url";

const NUMERO = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const ASSUNTO = "33333333-3333-4333-8333-333333333333";
const TIME = "44444444-4444-4444-8444-444444444444";

const sp = (s = "") => new URLSearchParams(s);
const NADA: FiltrosNaUrl = { onlyUnread: false };

describe("⭐ ida e volta: o que a tela escreve é o que ela lê de volta", () => {
  const casos: Array<[string, FiltrosNaUrl]> = [
    ["nada", NADA],
    ["não lidos", { onlyUnread: true }],
    ["time por id", { onlyUnread: false, team_id: TIME }],
    ["meus times", { onlyUnread: false, team_id: "mine" }],
    ["fila geral", { onlyUnread: false, team_id: "none" }],
    ["etiqueta", { onlyUnread: false, tag: "urgente" }],
    ["caixa pelo meio", { onlyUnread: false, channel: "phone" }],
    ["caixa por número", { onlyUnread: false, channel_session_id: NUMERO }],
    ["eu", { onlyUnread: false, assigned_to: "me" }],
    ["sem atendente", { onlyUnread: false, assigned_to: "unassigned" }],
    ["um atendente", { onlyUnread: false, assigned_to: MARIA }],
    ["período pronto", { onlyUnread: false, periodo: "7d" }],
    ["período por datas", { onlyUnread: false, de: "2026-10-01", ate: "2026-10-03" }],
    ["assunto", { onlyUnread: false, assunto_id: ASSUNTO }],
    ["só na fila", { onlyUnread: false, na_fila: true }],
    ["ordem por espera", { onlyUnread: false, ordem: "espera" }],
    ["insatisfeitos", { onlyUnread: false, insatisfeitos: true }],
    [
      "tudo junto",
      {
        onlyUnread: true,
        team_id: TIME,
        tag: "vip",
        channel_session_id: NUMERO,
        assigned_to: MARIA,
        periodo: "hoje",
        assunto_id: ASSUNTO,
        na_fila: true,
        ordem: "espera",
        insatisfeitos: true,
      },
    ],
  ];

  it.each(casos)("%s", (_nome, filtros) => {
    expect(lerFiltrosDaUrl(escreverFiltrosNaUrl(sp(), "closed", filtros))).toEqual(filtros);
  });

  it("passa pelo texto do endereço, e não só pelo objeto: é o que o recarregar faz", () => {
    const filtros: FiltrosNaUrl = { onlyUnread: true, assigned_to: "me", periodo: "ontem" };
    const texto = escreverFiltrosNaUrl(sp(), "closed", filtros).toString();
    expect(lerFiltrosDaUrl(sp(texto))).toEqual(filtros);
  });
});

describe("escrever só mexe no que é dos filtros", () => {
  it("⭐ a conversa aberta (`id`) e parâmetro desconhecido atravessam intactos", () => {
    const proximo = escreverFiltrosNaUrl(sp("id=conversa-1&outro=x"), "all", { onlyUnread: true });
    expect(proximo.get("id")).toBe("conversa-1");
    expect(proximo.get("outro")).toBe("x");
    expect(proximo.get("unread")).toBe("1");
  });

  it("grava a aba", () => {
    expect(escreverFiltrosNaUrl(sp("filter=all"), "closed", NADA).get("filter")).toBe("closed");
  });

  it("⭐ \"Limpar filtros\": o que não veio some do endereço, sem enumerar filtro nenhum", () => {
    const cheio = sp(
      `filter=closed&id=c1&unread=1&team_id=mine&tag=vip&channel=phone&channel_session_id=${NUMERO}` +
        `&assigned_to=me&periodo=hoje&de=2026-10-01&ate=2026-10-02&assunto_id=${ASSUNTO}&na_fila=1&ordem=espera&insatisfeitos=1`,
    );
    const limpo = escreverFiltrosNaUrl(cheio, "closed", NADA);
    expect(limpo.toString()).toBe("filter=closed&id=c1");
  });

  it("CONTROLE: a lista de parâmetros cobre tudo o que `escrever` grava", () => {
    const tudo = escreverFiltrosNaUrl(sp(), "all", {
      onlyUnread: true,
      team_id: TIME,
      tag: "vip",
      channel: "phone",
      channel_session_id: NUMERO,
      assigned_to: MARIA,
      de: "2026-10-01",
      ate: "2026-10-02",
      assunto_id: ASSUNTO,
      na_fila: true,
      ordem: "espera",
      insatisfeitos: true,
    });
    const gravados = [...tudo.keys()].filter((chave) => chave !== "filter");
    // Todo parâmetro gravado tem de estar na lista do que se apaga — senão
    // "Limpar filtros" deixaria um filtro de pé.
    for (const chave of gravados) {
      expect(PARAMETROS_DE_FILTRO as readonly string[], chave).toContain(chave);
    }
    // `periodo` é o único que este caso não grava (as datas ocupam o lugar dele).
    expect([...gravados, "periodo"].sort()).toEqual([...PARAMETROS_DE_FILTRO].sort());
  });

  it("não devolve o mesmo objeto: quem compara antes e depois precisa de dois", () => {
    const atual = sp("filter=all");
    expect(escreverFiltrosNaUrl(atual, "all", NADA)).not.toBe(atual);
  });
});

describe("link quebrado abre a lista sem aquele filtro — não um erro", () => {
  it.each([
    ["team_id=xyz"],
    ["assigned_to=qualquer-coisa"],
    ["channel=fax"],
    ["channel=WhatsApp"],
    ["channel_session_id=1"],
    ["periodo=semana"],
    ["ordem=recente"],
    ["assunto_id=abc"],
    ["tag="],
    ["tag=" + "x".repeat(41)],
    ["unread=0"],
    ["unread=false"],
    ["na_fila=sim"],
    ["de=2026-10-01"],
    ["ate=2026-10-01"],
    ["de=2026-10-03&ate=2026-10-01"],
    ["de=2026-02-30&ate=2026-03-01"],
  ])("`%s` é descartado", (texto) => {
    expect(lerFiltrosDaUrl(sp(texto))).toEqual(NADA);
  });

  it("um valor inválido não derruba os válidos ao lado", () => {
    expect(lerFiltrosDaUrl(sp("assigned_to=xyz&channel=phone&unread=1"))).toEqual({
      onlyUnread: true,
      channel: "phone",
    });
  });

  it("a escolha pronta vence as datas quando as duas vêm", () => {
    expect(lerFiltrosDaUrl(sp("periodo=hoje&de=2026-10-01&ate=2026-10-02"))).toEqual({
      onlyUnread: false,
      periodo: "hoje",
    });
  });

  it("a etiqueta é normalizada como no servidor: sem espaço nas pontas, minúscula", () => {
    expect(lerFiltrosDaUrl(sp("tag=%20VIP%20")).tag).toBe("vip");
  });

  it("`unread=true` (a forma da API) também liga", () => {
    expect(lerFiltrosDaUrl(sp("unread=true")).onlyUnread).toBe(true);
  });

  it("⛔ a busca não é lida do endereço, mesmo que alguém a escreva lá", () => {
    expect(lerFiltrosDaUrl(sp("search=maria&q=maria"))).toEqual(NADA);
    expect(PARAMETROS_DE_FILTRO as readonly string[]).not.toContain("search");
  });
});
