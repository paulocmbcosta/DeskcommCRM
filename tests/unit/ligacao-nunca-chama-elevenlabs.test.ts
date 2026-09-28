/**
 * A LIGAÇÃO NUNCA CHAMA A ELEVENLABS (desenho da fase 2, D15 e §4).
 *
 * A ElevenLabs é chamada SÓ quando alguém gera uma PRÉVIA na tela; toda ligação
 * toca um arquivo já gravado, e mil ligações custam zero. A regra se sustenta por
 * ESTRUTURA: nenhum módulo do caminho da ligação — `lib/channels/telefonia/`
 * (controlador, repositório, falas no disco, números) e `workers/` — alcança o
 * cliente da ElevenLabs (`lib/telefonia/elevenlabs.ts`), nem direto nem por um
 * módulo no meio. Se alcançasse, bastaria uma linha para uma fala faltante virar
 * síntese paga no meio de uma ligação, repetida a cada ligação.
 *
 * TRANSITIVO de propósito: um import direto é fácil de ver na revisão; o que
 * escapa é o worker importar um módulo que importa outro que importa o cliente. A
 * varredura segue `import`, `export … from`, `import()` e `require()` com caminho
 * `@/` ou relativo, e conta também `import type` — o caminho da ligação não tem
 * motivo nem para conhecer os tipos do cliente.
 *
 * Os controles, porque varredura quebrada devolve "nada encontrado" e isso é
 * indistinguível de "está tudo certo" (tests/unit/helpers/varrer-codigo.ts):
 *  1. o alvo existe — renomear o cliente não pode deixar este teste verde e cego;
 *  2. a varredura viu o caminho da ligação e resolveu `@/` e `./`;
 *  3. o detector acha uma cadeia de VERDADE (o teste do cliente importa o cliente)
 *     e uma cadeia transitiva num grafo montado à mão.
 * A prova de que ele morde é a sabotagem descrita no plano da fase 2 (Task 2,
 * Steps 9 e 10; de novo na Task 25): um import do cliente num arquivo do caminho
 * da ligação deixa este teste vermelho, com a cadeia na mensagem.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { RAIZ_DO_REPO, arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const ALVO = path.join(RAIZ_DO_REPO, "lib/telefonia/elevenlabs.ts");
const CAMINHO_DA_LIGACAO = ["lib/channels/telefonia", "workers"] as const;

/** Os especificadores que um arquivo importa: estático, reexport, `import x = require()`, `import()` e `require()`. */
function especificadores(arquivo: string, fonte: string): string[] {
  const sf = ts.createSourceFile(
    arquivo,
    fonte,
    ts.ScriptTarget.Latest,
    false,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const achados: string[] = [];
  const visitar = (no: ts.Node): void => {
    if ((ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) && no.moduleSpecifier && ts.isStringLiteral(no.moduleSpecifier)) {
      achados.push(no.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(no) &&
      ts.isExternalModuleReference(no.moduleReference) &&
      ts.isStringLiteral(no.moduleReference.expression)
    ) {
      achados.push(no.moduleReference.expression.text);
    } else if (ts.isCallExpression(no) && no.arguments.length > 0 && ts.isStringLiteralLike(no.arguments[0]!)) {
      const chamado = no.expression;
      if (chamado.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(chamado) && chamado.text === "require")) {
        achados.push((no.arguments[0] as ts.StringLiteralLike).text);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return achados;
}

/** `@/x` e `./x` → o arquivo do repo; pacote de fora → `null`. */
function resolver(de: string, especificador: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = path.join(RAIZ_DO_REPO, especificador.slice(2));
  else if (especificador.startsWith(".")) base = path.resolve(path.dirname(de), especificador);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const lidos = new Map<string, string[]>();
/** Os arquivos do repo que `arquivo` importa. Só `.ts`/`.tsx` são lidos: um `.json` ou `.css` não importa ninguém. */
function importsDoRepo(arquivo: string): string[] {
  const guardado = lidos.get(arquivo);
  if (guardado) return guardado;
  const achados = /\.tsx?$/.test(arquivo)
    ? especificadores(arquivo, readFileSync(arquivo, "utf8"))
        .map((e) => resolver(arquivo, e))
        .filter((c): c is string => c !== null)
    : [];
  lidos.set(arquivo, achados);
  return achados;
}

/**
 * A cadeia mais curta de uma das `entradas` até o `alvo`, ou `null`. Busca em
 * largura com vários pontos de partida; `importsDe` é injetável para o controle
 * com um grafo montado à mão.
 */
function cadeiaAte(alvo: string, entradas: readonly string[], importsDe: (arquivo: string) => string[]): string[] | null {
  const veioDe = new Map<string, string | null>();
  const fila: string[] = [];
  for (const e of entradas) {
    if (!veioDe.has(e)) {
      veioDe.set(e, null);
      fila.push(e);
    }
  }
  for (let i = 0; i < fila.length; i++) {
    const atual = fila[i]!;
    if (atual === alvo) {
      const cadeia: string[] = [];
      for (let c: string | null = atual; c !== null; c = veioDe.get(c) ?? null) cadeia.unshift(c);
      return cadeia;
    }
    for (const proximo of importsDe(atual)) {
      if (!veioDe.has(proximo)) {
        veioDe.set(proximo, atual);
        fila.push(proximo);
      }
    }
  }
  return null;
}

const entradas = arquivosDeCodigo(CAMINHO_DA_LIGACAO);

describe("a ligação nunca chama a ElevenLabs (desenho da fase 2, D15)", () => {
  it("controle: o cliente da ElevenLabs existe onde este teste o procura", () => {
    expect(existsSync(ALVO), `${caminhoRelativo(ALVO)} sumiu — atualize ALVO, ou este teste fica verde e cego`).toBe(true);
  });

  it("controle: a varredura vê o caminho da ligação e resolve `@/` e `./`", () => {
    const relativos = entradas.map(caminhoRelativo);
    expect(relativos).toContain("lib/channels/telefonia/laco.ts");
    expect(relativos).toContain("workers/agent-worker/main.ts");
    expect(importsDoRepo(path.join(RAIZ_DO_REPO, "workers/agent-worker/main.ts")).map(caminhoRelativo)).toContain(
      "lib/channels/telefonia/laco.ts",
    );
    expect(importsDoRepo(path.join(RAIZ_DO_REPO, "lib/channels/telefonia/laco.ts")).map(caminhoRelativo)).toContain(
      "lib/channels/telefonia/controle.ts",
    );
  });

  it("controle: o detector acha uma cadeia de verdade e uma transitiva", () => {
    const testeDoCliente = path.join(RAIZ_DO_REPO, "lib/telefonia/elevenlabs.test.ts");
    expect(cadeiaAte(ALVO, [testeDoCliente], importsDoRepo)?.map(caminhoRelativo)).toEqual([
      "lib/telefonia/elevenlabs.test.ts",
      "lib/telefonia/elevenlabs.ts",
    ]);
    const grafo: Record<string, string[]> = { "/a.ts": ["/b.ts"], "/b.ts": ["/c.ts"], "/c.ts": [ALVO] };
    expect(cadeiaAte(ALVO, ["/a.ts"], (f) => grafo[f] ?? [])).toEqual(["/a.ts", "/b.ts", "/c.ts", ALVO]);
    expect(cadeiaAte(ALVO, ["/a.ts"], (f) => (f === "/c.ts" ? [] : (grafo[f] ?? [])))).toBeNull();
  });

  it(
    "nenhum arquivo de lib/channels/telefonia/ ou de workers/ alcança o cliente da ElevenLabs",
    () => {
      const cadeia = cadeiaAte(ALVO, entradas, importsDoRepo);
      expect(
        cadeia,
        cadeia
          ? `a ligação alcança a ElevenLabs por: ${cadeia.map(caminhoRelativo).join(" → ")}. ` +
              "Só a prévia da tela sintetiza (desenho D15): tire o import, ou mova para o caminho da ligação só o que não depende do cliente."
          : "",
      ).toBeNull();
    },
    60_000,
  );
});
