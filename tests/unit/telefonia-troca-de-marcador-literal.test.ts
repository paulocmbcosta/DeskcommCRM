/**
 * TODA TROCA DE MARCADOR DA TELEFONIA É LITERAL.
 *
 * `"… {nome}".replace("{nome}", valor)` com o valor em STRING interpreta `$&`,
 * `` $` ``, `$'` e `$$` dentro do valor: o nome "Ana $` X" de quem ligou o aviso
 * saía na tela como "Ana Ligado às 11:30 por  X" (revisão de segurança da fase 2,
 * Task 26 — não é XSS, é o nome deturpado, e ele é editável por qualquer usuário).
 * A troca de um marcador só passa por `trocarMarcador` (lib/telefonia/texto-do-menu.ts,
 * puro e client-safe); o preenchimento de VÁRIOS marcadores numa passada só usa um
 * regex com FUNÇÃO (`preencher` do cartão da ligação, `montarTextoDoMenu`), que esta
 * cerca não alcança.
 *
 * Varre o texto das pastas da telefonia, sem os testes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const PASTAS = [
  "app/api/v1/telefonia",
  "components/telefonia",
  "components/connections/telefone",
  "lib/telefonia",
  "lib/channels/telefonia",
];
/** `.replace("{x}"` / `.replaceAll('{x}'` / com crase — o marcador como string no 1º argumento. */
const TROCA_POR_STRING = /\.replace(?:All)?\(\s*["'`]\{[^}"'`]+\}["'`]/;

function arquivos(pasta: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(join(RAIZ, pasta), { withFileTypes: true })) {
    const caminho = join(pasta, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.(ts|tsx)$/.test(entrada.name) && !/\.test\.tsx?$/.test(entrada.name))
      saida.push(caminho);
  }
  return saida;
}

describe("a troca de marcador da telefonia é literal (trocarMarcador)", () => {
  it('nenhum `.replace("{marcador}", …)` nas pastas da telefonia', () => {
    const achados: string[] = [];
    for (const pasta of PASTAS) {
      for (const arquivo of arquivos(pasta)) {
        readFileSync(join(RAIZ, arquivo), "utf8")
          .split("\n")
          .forEach((linha, i) => {
            if (TROCA_POR_STRING.test(linha))
              achados.push(`${relative(RAIZ, join(RAIZ, arquivo))}:${i + 1}: ${linha.trim()}`);
          });
      }
    }
    expect(achados).toEqual([]);
  });

  it("controle: a régua pega as três formas que a cerca proíbe, e não a troca por regex com função", () => {
    expect(TROCA_POR_STRING.test('t("Ouvir: {fala}").replace("{fala}", nome)')).toBe(true);
    expect(TROCA_POR_STRING.test("x.replaceAll('{numero}', n)")).toBe(true);
    expect(TROCA_POR_STRING.test("x.replace(`{time}`, () => n)")).toBe(true);
    expect(
      TROCA_POR_STRING.test("modelo.replace(/\\{(menu|tecla|time)\\}/g, (_, c) => v[c])"),
    ).toBe(false);
    expect(TROCA_POR_STRING.test('trocarMarcador(t("Ouvir: {fala}"), "{fala}", nome)')).toBe(false);
  });
});
