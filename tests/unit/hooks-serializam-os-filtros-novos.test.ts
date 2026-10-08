/**
 * O HOOK MANDA TODO FILTRO QUE A TELA MONTA.
 *
 * `rota-le-todo-filtro-do-schema.test.ts` vigia a ponta do servidor: o schema
 * aceita, a rota tem de ler. Esta é a outra ponta da mesma corda. A tela monta o
 * objeto de filtros (`lib/inbox/filtros-de-tela.ts`), o tipo do hook aceita o
 * campo — e se faltar a linha `qs.set(...)`, a requisição sai SEM o filtro e a
 * lista volta inteira, parecendo funcionar. É a metade do trabalho que o
 * typecheck não pega, e a que já custou o `comando` e o `team_id` uma vez cada
 * (os comentários em `useConversationsRealtime.ts` contam).
 *
 * As chaves saem das funções de verdade, com tudo ligado: filtro novo que entre
 * em `filtros-de-tela` passa a ser cobrado aqui sem ninguém lembrar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { InboxTab } from "@/lib/inbox/abas";
import {
  filtrosAplicados,
  paraContagens,
  paraConversas,
  paraFechados,
  type FiltrosDeTela,
} from "@/lib/inbox/filtros-de-tela";

const RAIZ = join(__dirname, "..", "..");
const AGORA = new Date(2026, 9, 8, 15, 30);

/** "Ontem" de propósito: é a escolha que produz os DOIS instantes do período. */
const TUDO: FiltrosDeTela = {
  search: "maria",
  onlyUnread: true,
  team_id: "mine",
  tag: "urgente",
  channel: "phone",
  channel_session_id: "11111111-1111-4111-8111-111111111111",
  assigned_to: "me",
  periodo: "ontem",
  assunto_id: "33333333-3333-4333-8333-333333333333",
  na_fila: true,
  ordem: "espera",
  insatisfeitos: true,
};

const ABAS: InboxTab[] = ["unassigned", "mine", "all", "ai", "closed"];

function fonte(caminho: string): string {
  return readFileSync(join(RAIZ, caminho), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const serializa = (src: string, chave: string) =>
  new RegExp(`qs\\.set\\(\\s*["']${chave}["']`).test(src);

const casos: Array<[nome: string, arquivo: string, chaves: string[]]> = [
  [
    "a lista de conversas",
    "hooks/inbox/useConversationsRealtime.ts",
    [...new Set(ABAS.flatMap((aba) => Object.keys(paraConversas(aba, filtrosAplicados(aba, TUDO, AGORA)))))].sort(),
  ],
  [
    "a lista dos atendimentos encerrados",
    "hooks/inbox/useAtendimentosFechados.ts",
    Object.keys(paraFechados(filtrosAplicados("closed", TUDO, AGORA))).sort(),
  ],
  ["a contagem das abas", "hooks/inbox/useConversationCounts.ts", Object.keys(paraContagens(TUDO, AGORA)).sort()],
];

describe.each(casos)("%s", (_nome, arquivo, chaves) => {
  it("CONTROLE: a tela monta filtros — lista vazia aqui aprovaria tudo abaixo", () => {
    expect(chaves.length).toBeGreaterThanOrEqual(6);
    expect(chaves).toContain("channel");
  });

  it.each(chaves)("o hook serializa `%s`", (chave) => {
    expect(
      serializa(fonte(arquivo), chave),
      `${arquivo} não tem \`qs.set("${chave}", …)\` — a tela monta o filtro e a requisição sai sem ele`,
    ).toBe(true);
  });

  it("CONTROLE: a cerca reprova quando a linha some", () => {
    const sabotado = fonte(arquivo).replace(/qs\.set\(\s*["']channel["'][^;]*;/, "");
    expect(serializa(sabotado, "channel")).toBe(false);
  });
});

describe("os filtros que só Fechadas tem chegam às duas rotas que os aplicam", () => {
  it.each(["assigned_to", "closed_from", "closed_to", "assunto_id"])("`%s`", (chave) => {
    expect(casos[1]?.[2]).toContain(chave);
    expect(casos[2]?.[2]).toContain(chave);
  });
});
