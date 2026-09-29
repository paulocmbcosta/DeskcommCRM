// @vitest-environment node
/**
 * A TELEFONIA NA SUÍTE DE E2E SÓ ONDE ELA É MEDIDA — a parte 3.
 *
 * `TELEFONIA_ARI_URL`/`TELEFONIA_ARI_PASSWORD` no `.env.e2e` ligam a telefonia
 * da instalação inteira (abas do Telefone, faixa do aviso de instabilidade em
 * toda tela, cartão da ElevenLabs). Escritas para a suíte inteira, elas tiravam
 * das três partes do CI o estado de PRIMEIRO DEPLOY — o que a doutrina de QA
 * Visual manda testar com os opcionais ausentes (o mesmo cuidado de
 * `voz-desligada-por-padrao.spec.ts`).
 *
 * O desenho: o gerador (`scripts/gerar-env-e2e.sh`) lê `E2E_TELEFONIA` (padrão
 * `1`, para quem roda local) e só escreve as duas com `1`; o workflow passa `1`
 * na parte 3 — onde mora `telefonia-ura-e-falas.spec.ts` — e `0` nas outras. A
 * fonte do ambiente continua UMA: nada edita o arquivo depois de gerado.
 *
 * O gerador roda DE VERDADE aqui, numa cópia isolada (ele escreve o `.env.e2e`
 * na raiz de onde mora — a cópia não encosta no do repositório), com um
 * `supabase` falso no PATH que responde o `status` do stack local.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const GERADOR = path.join(RAIZ, "scripts", "gerar-env-e2e.sh");
const WORKFLOW = path.join(RAIZ, ".github", "workflows", "e2e.yml");
const DIR_SPECS = path.join(RAIZ, "tests", "e2e");
const SPEC_DA_TELEFONIA = "telefonia-ura-e-falas.spec.ts";

const pastas: string[] = [];
afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

interface Geracao {
  status: number | null;
  saida: string;
  /** O `.env.e2e` gerado, chave → valor; `null` se o arquivo não nasceu. */
  env: Record<string, string> | null;
}

/** Roda o gerador numa cópia isolada, com `E2E_TELEFONIA` no valor pedido (`undefined` = ausente). */
function gerar(telefonia: string | undefined): Geracao {
  const raiz = mkdtempSync(path.join(tmpdir(), "e2e-env-telefonia-"));
  pastas.push(raiz);
  mkdirSync(path.join(raiz, "scripts"));
  copyFileSync(GERADOR, path.join(raiz, "scripts", "gerar-env-e2e.sh"));
  mkdirSync(path.join(raiz, "bin"));
  const supabase = path.join(raiz, "bin", "supabase");
  writeFileSync(
    supabase,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "status" ] && [ "$2" = "-o" ] && [ "$3" = "env" ]; then',
      "  echo 'API_URL=\"http://127.0.0.1:54321\"'",
      "  echo 'ANON_KEY=\"anon-falsa\"'",
      "  echo 'SERVICE_ROLE_KEY=\"service-role-falsa\"'",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(supabase, 0o755);

  const ambiente: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(raiz, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete ambiente.E2E_TELEFONIA;
  if (telefonia !== undefined) ambiente.E2E_TELEFONIA = telefonia;

  const r = spawnSync("bash", [path.join(raiz, "scripts", "gerar-env-e2e.sh")], { env: ambiente, encoding: "utf8" });
  const arquivo = path.join(raiz, ".env.e2e");
  let env: Record<string, string> | null = null;
  if (existsSync(arquivo)) {
    env = {};
    for (const bruta of readFileSync(arquivo, "utf8").split("\n")) {
      const linha = bruta.trim();
      if (linha === "" || linha.startsWith("#")) continue;
      const i = linha.indexOf("=");
      if (i > 0) env[linha.slice(0, i)] = linha.slice(i + 1);
    }
  }
  return { status: r.status, saida: `${r.stdout ?? ""}${r.stderr ?? ""}`, env };
}

/** A mesma leitura estreita de `tests/unit/e2e-cobertura-completa.test.ts`. */
function listaDoWorkflow(yml: string, chave: string): string[] {
  const m = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m").exec(yml);
  if (m === null) return [];
  return m[1]!
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".spec.ts"));
}

/** As linhas (sem comentário) do passo do workflow que roda `pnpm e2e:env`. */
function passoQueGeraOEnv(yml: string): string[] {
  const linhas = yml.split("\n");
  const i = linhas.findIndex((l) => l.trim() === "run: pnpm e2e:env");
  if (i < 0) return [];
  let inicio = i;
  while (inicio > 0 && !/^\s*- (name|uses):/.test(linhas[inicio]!)) inicio--;
  const recuo = linhas[inicio]!.search(/\S/);
  const passo: string[] = [];
  for (let j = inicio + 1; j < linhas.length; j++) {
    const l = linhas[j]!;
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    // O próximo passo (ou o fim da lista de passos) fecha este.
    if (l.search(/\S/) <= recuo) break;
    passo.push(l.trim());
  }
  return passo;
}

describe("o gerador do .env.e2e só oferece a telefonia com E2E_TELEFONIA=1", () => {
  it("sem a variável, oferece — é o padrão de quem roda local", () => {
    const g = gerar(undefined);
    expect(g.status, g.saida).toBe(0);
    expect(g.env?.TELEFONIA_ARI_URL).toBe("http://127.0.0.1:3995");
    expect(g.env?.TELEFONIA_ARI_PASSWORD).toBeTruthy();
  });

  it("com E2E_TELEFONIA=1, oferece", () => {
    const g = gerar("1");
    expect(g.status, g.saida).toBe(0);
    expect(g.env?.TELEFONIA_ARI_URL).toBe("http://127.0.0.1:3995");
    expect(g.env?.TELEFONIA_ARI_PASSWORD).toBeTruthy();
  });

  it("com E2E_TELEFONIA=0, as duas nem existem no arquivo — e o resto dele nasce igual", () => {
    const g = gerar("0");
    expect(g.status, g.saida).toBe(0);
    // Controle positivo: o arquivo nasceu inteiro (a última linha do heredoc
    // principal está lá), então a ausência abaixo não é arquivo pela metade.
    expect(g.env?.SENTRY_DSN).toBe("off");
    expect(Object.keys(g.env ?? {}).filter((k) => k.startsWith("TELEFONIA_"))).toEqual([]);
    // A ElevenLabs falsa fica nas duas formas: sem ela, qualquer caminho que
    // chegasse à síntese chamaria a ElevenLabs de verdade.
    expect(g.env?.ELEVENLABS_API_BASE_URL).toBe("http://127.0.0.1:3996");
  });

  it("valor fora de 0/1 falha alto e não escreve arquivo nenhum", () => {
    const g = gerar("sim");
    expect(g.status).not.toBe(0);
    expect(g.saida).toContain("E2E_TELEFONIA");
    expect(g.env).toBeNull();
  });
});

describe("o workflow do e2e liga a telefonia só na parte 3", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const semComentario = yml.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("o passo que gera o .env.e2e passa E2E_TELEFONIA=1 na parte 3 e 0 nas partes 1 e 2", () => {
    const passo = passoQueGeraOEnv(yml);
    expect(passo, "o passo `run: pnpm e2e:env` não foi achado").toContain("run: pnpm e2e:env");
    const linha = passo.find((l) => l.startsWith("E2E_TELEFONIA:"));
    expect(linha, "o passo que gera o .env.e2e não passa E2E_TELEFONIA").toBeTruthy();
    const m = /^E2E_TELEFONIA:\s*\$\{\{\s*matrix\.parte\s*==\s*(\d+)\s*&&\s*'1'\s*\|\|\s*'0'\s*\}\}$/.exec(linha!);
    expect(m, `forma inesperada: ${linha}`).not.toBeNull();

    const matriz = /^\s*parte:\s*\[([^\]]+)\]/m.exec(yml);
    expect(matriz, "a matrix de partes não foi achada").not.toBeNull();
    const partes = matriz![1]!.split(",").map((s) => Number(s.trim()));
    const comTelefonia = Number(m![1]);
    const valorPorParte = Object.fromEntries(partes.map((p) => [p, p === comTelefonia ? "1" : "0"]));
    expect(valorPorParte).toEqual({ 1: "0", 2: "0", 3: "1" });
  });

  it("ninguém mais define E2E_TELEFONIA no workflow — um `env:` de job por cima desfaria a escolha", () => {
    const definicoes = semComentario.filter((l) => /(^|\s)E2E_TELEFONIA\s*[:=]/.test(l));
    expect(definicoes).toHaveLength(1);
  });

  it("toda spec que depende da telefonia mora na parte 3, e só nela", () => {
    const parte1 = listaDoWorkflow(yml, "SPECS_PARTE_1");
    const parte2 = listaDoWorkflow(yml, "SPECS_PARTE_2");
    const parte3 = listaDoWorkflow(yml, "SPECS_PARTE_3");
    expect(parte3.length, "SPECS_PARTE_3 não foi lida do workflow").toBeGreaterThan(10);

    // "Depende da telefonia" = a spec exige E2E_TELEFONIA=1 (é o que ela diz ao
    // falhar sem ela). Sidecars AppleDouble (`._x.spec.ts`) não são specs.
    const dependentes = readdirSync(DIR_SPECS)
      .filter((f) => f.endsWith(".spec.ts") && !f.startsWith("._"))
      .filter((f) => readFileSync(path.join(DIR_SPECS, f), "utf8").includes("E2E_TELEFONIA"));
    expect(dependentes, "controle positivo: a spec da URA declara a dependência").toContain(SPEC_DA_TELEFONIA);
    for (const spec of dependentes) {
      expect(parte3, `${spec} depende da telefonia e não está na parte 3`).toContain(spec);
      expect([...parte1, ...parte2], `${spec} depende da telefonia e está numa parte sem ela`).not.toContain(spec);
    }
  });
});
