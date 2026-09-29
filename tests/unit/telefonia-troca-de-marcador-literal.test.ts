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
 * Varre o texto das pastas da telefonia, sem os testes — o ARQUIVO INTEIRO, e
 * não linha a linha: o prettier quebra um `.replace(` longo em várias linhas, e a
 * leitura por linha não via a segunda troca de `lib/channels/telefonia/repositorio.ts`
 * (o marcador numa linha, o `.replace(` na anterior). O número da linha sai da
 * posição do achado. Pega também o marcador duplo (`{{x}}`).
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
/**
 * `.replace("{x}"` / `.replaceAll('{x}'` / com crase / `"{{x}}"` — o marcador como
 * string no 1º argumento, com qualquer espaço (quebra de linha inclusive) depois do `(`.
 */
const TROCA_POR_STRING = /\.replace(?:All)?\(\s*["'`]\{\{?[^{}"'`]+\}\}?["'`]/g;

/** Cada troca por string no texto inteiro, com a linha em que o `.replace` começa. */
function trocasPorString(conteudo: string): Array<{ linha: number; trecho: string }> {
  return [...conteudo.matchAll(TROCA_POR_STRING)].map((m) => ({
    linha: conteudo.slice(0, m.index).split("\n").length,
    trecho: m[0].replace(/\s+/g, " "),
  }));
}

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
        for (const { linha, trecho } of trocasPorString(
          readFileSync(join(RAIZ, arquivo), "utf8"),
        )) {
          achados.push(`${relative(RAIZ, join(RAIZ, arquivo))}:${linha}: ${trecho}`);
        }
      }
    }
    expect(achados).toEqual([]);
  });

  it("controle: a régua pega as formas que a cerca proíbe, e não a troca por regex com função", () => {
    const linhas = (texto: string) => trocasPorString(texto).map((a) => a.linha);
    expect(linhas('t("Ouvir: {fala}").replace("{fala}", nome)')).toEqual([1]);
    expect(linhas("x.replaceAll('{numero}', n)")).toEqual([1]);
    expect(linhas("x.replace(`{time}`, () => n)")).toEqual([1]);
    expect(linhas('x.replace("{{nome}}", n)')).toEqual([1]);
    expect(linhas("modelo.replace(/\\{(menu|tecla|time)\\}/g, (_, c) => v[c])")).toEqual([]);
    expect(linhas('trocarMarcador(t("Ouvir: {fala}"), "{fala}", nome)')).toEqual([]);
    expect(linhas('x.replace("{}", n)')).toEqual([]);
  });

  it("controle: o `.replace(` quebrado em várias linhas (o formato do prettier) é pego, na linha em que começa", () => {
    const texto = [
      "const a = 1;",
      'const titulo = traduzir("Ligação de {numero}").replace("{numero}", () => n);',
      "const corpo = traduzir(",
      '  "Ninguém do time {time} atendeu.",',
      ").replace(",
      '  "{time}",',
      "  () => nome,",
      ");",
    ].join("\n");
    expect(trocasPorString(texto).map((a) => a.linha)).toEqual([2, 5]);
  });
});
