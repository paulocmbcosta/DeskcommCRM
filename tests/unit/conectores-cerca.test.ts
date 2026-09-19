/**
 * O NÚCLEO NÃO SABE O QUE É IXC — a cerca dos conectores.
 *
 * O produto é um só para todo cliente: a mesma imagem Docker atende o provedor de
 * internet que usa IXC e a imobiliária que nunca ouviu falar dele. O que mantém
 * isso verdadeiro é UMA regra de importação:
 *
 *   código específico de um conector mora em pasta `conectores/<id>/` e só é
 *   importado (a) por outro arquivo de pasta `conectores/<id>/`, ou (b) pelos
 *   dois registros — `lib/conectores/registro.ts` (servidor) e
 *   `components/conectores/PainelDoConector.tsx` (tela).
 *
 * Sem a cerca, o atalho natural é `import { montarResumo } from
 * "@/lib/conectores/ixc/resumo"` direto no painel da conversa — funciona, passa
 * no typecheck, e no segundo conector o inbox tem um `if (conector === "ixc")`
 * em cada canto. Mesmo desenho de `lib/channels/` e de `pnpm lint:channels`.
 *
 * A régua é textual (especificador de import), e é de propósito: alcança arquivo
 * que ainda não existe, e não depende de resolver módulo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_DE_CONECTOR } from "@/lib/conectores/tipos";

const RAIZ = process.cwd();
const AREAS = ["app", "components", "hooks", "lib", "workers"];
const REGISTROS = new Set(["lib/conectores/registro.ts", "components/conectores/PainelDoConector.tsx"]);

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

const ESPECIFICADOR = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function importaConector(especificador: string, id: string): boolean {
  // `@/lib/conectores/ixc`, `@/lib/conectores/ixc/resumo`, `./ixc`, `../ixc/painel`…
  return new RegExp(`(^|/)conectores/${id}(/|$)|^\\.{1,2}(/[^/]+)*/${id}(/|$)|^\\./${id}(/|$)`).test(especificador);
}

describe("cerca dos conectores", () => {
  const todos = AREAS.flatMap((a) => arquivos(join(RAIZ, a))).map((c) => relative(RAIZ, c).split(sep).join("/"));

  it("a varredura alcança o código (não passa por vazio)", () => {
    expect(todos.length).toBeGreaterThan(500);
    expect(todos).toContain("lib/conectores/registro.ts");
    expect(todos).toContain("components/inbox/PainelDaConversa.tsx");
  });

  it.each(IDS_DE_CONECTOR)("só a pasta do conector e os dois registros importam `conectores/%s`", (id) => {
    const infratores: string[] = [];
    for (const arquivo of todos) {
      const daPasta = arquivo.includes(`/conectores/${id}/`);
      if (daPasta || REGISTROS.has(arquivo)) continue;
      // Só arquivos que PODEM nomear um conector por caminho relativo curto
      // (`./ixc`) são os vizinhos de `conectores/`; para o resto vale o alias.
      const vizinho = /(^|\/)conectores\/[^/]+$/.test(arquivo);
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      for (const [, especificador] of fonte.matchAll(ESPECIFICADOR)) {
        if (!especificador) continue;
        const nomeia = vizinho ? importaConector(especificador, id) : new RegExp(`(^|/)conectores/${id}(/|$)`).test(especificador);
        if (nomeia) infratores.push(`${arquivo} → ${especificador}`);
      }
    }
    expect(infratores).toEqual([]);
  });

  it("controle positivo: os registros DE FATO importam o conector — a régua enxerga o import", () => {
    const registro = readFileSync(join(RAIZ, "lib/conectores/registro.ts"), "utf8");
    const achados = [...registro.matchAll(ESPECIFICADOR)].map((m) => m[1] ?? "");
    expect(achados.some((e) => importaConector(e, "ixc"))).toBe(true);

    const painel = readFileSync(join(RAIZ, "components/conectores/PainelDoConector.tsx"), "utf8");
    const doPainel = [...painel.matchAll(ESPECIFICADOR)].map((m) => m[1] ?? "");
    expect(doPainel.some((e) => importaConector(e, "ixc"))).toBe(true);
  });
});
