// @vitest-environment node
/**
 * O PDF NÃO DERRUBA MAIS O WORKER.
 *
 * Em produção, de 25 a 28/09/2026, todo PDF que chegava pelo WhatsApp derrubava
 * o worker do agent-engine com `JavaScript heap out of memory` — PDFs de 2,6 KB
 * inclusive. Não era o arquivo: era carregar o pdf.js SOB `tsx`, que liga mapas
 * de fonte no processo inteiro e passa cada módulo pelo loader dele. Medido na
 * imagem do worker (node:22-alpine): pdf.js + um PDF de 598 bytes pedem ~180 MB
 * de heap sob `tsx` e menos de 24 MB em `node` puro. Com 86 MB do grafo ocioso e
 * teto de 259 MB, o primeiro PDF do processo o derrubava — e os turnos de
 * conversa em voo iam junto. O cabeçalho de `lib/ai/rag/extractors/pdf.ts` tem
 * os números.
 *
 * ⚠️ POR QUE ESTE ARQUIVO ABRE UM PROCESSO SOB `tsx`
 *
 * O vitest não usa `tsx`, e o defeito só existe sob ele: um teste que chamasse
 * `extractPdfText` daqui passaria com ou sem o conserto. É a mesma lição de
 * `drain-loop-carrega-deps-sob-tsx.test.ts`: prenda o RUNTIME de produção, não
 * o do teste. O teto de 96 MB fica bem abaixo do que o pdf.js pede sob `tsx` e
 * bem acima do que o processo pai precisa com o pdf.js fora dele — por isso o
 * CONTROLE (sem isolamento) tem de morrer, e morre: é ele que prova que este
 * teste enxerga o defeito, e não só a ausência dele.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ISOLAMENTO_PADRAO,
  PdfExtractError,
  caminhoDoExtratorIsolado,
  extrairEmProcessoFilho,
} from "@/lib/ai/rag/extractors/pdf";

const TSX = "node_modules/tsx/dist/cli.mjs";
const FIXTURE = "tests/fixtures/sample-text.pdf";
const HEAP_DO_PAI_MB = 96;

/** Um processo sob `tsx`, com heap apertado, que lê um PDF como o worker lê. */
function lerPdfSobTsx(isolar: boolean): { ok: boolean; stdout: string; stderr: string } {
  const script =
    `import("@/lib/ai/rag/extractors/pdf").then(async (m) => {` +
    (isolar ? `m.isolarExtracaoDePdf();` : "") +
    `const t = await m.extractPdfText(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}));` +
    `process.stdout.write("TEXTO:" + t); process.exit(0);` +
    `}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); })`;
  try {
    const stdout = execFileSync(
      "node",
      [TSX, `--max-old-space-size=${HEAP_DO_PAI_MB}`, "--eval", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? e) };
  }
}

describe(`PDF num processo sob tsx com ${HEAP_DO_PAI_MB} MB de heap`, () => {
  it("CONTROLE — sem isolamento, o pdf.js derruba o processo (é o defeito de produção)", () => {
    const r = lerPdfSobTsx(false);
    expect(r.ok, "o processo sobreviveu: o teste deixou de enxergar o defeito").toBe(false);
    expect(r.stderr).toMatch(/heap out of memory|Reached heap limit/);
  }, 150_000);

  it("com o isolamento que o worker liga no boot, o processo sobrevive e lê o texto", () => {
    const r = lerPdfSobTsx(true);
    expect(r.stderr, "o processo morreu lendo o PDF").toBe("");
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("TEXTO:DeskcommCRM RAG fixture");
  }, 150_000);
});

/**
 * E quem liga o isolamento é o WORKER, no boot — é isso que um teste precisa
 * ver, porque `isolarExtracaoDePdf` funcionar não adianta se ninguém a chama.
 * Roda o entrypoint de produção sob `tsx` sem banco e sem `.env`: ele liga o
 * isolamento, registra, e só depois morre no `loadEnv` (é essa a ordem em
 * `main()`). As três variáveis abaixo são as que `lib/env.ts` exige no IMPORT;
 * valores de mentira, que nada aqui usa. `SENTRY_DSN=off` porque o boot que
 * falha manda o erro ao Sentry — e o da comunidade não é lugar de teste.
 *
 * (Que o módulo é UM só no processo — o `import` estático do `main.ts` e o
 * `await import` do laço do event_log veem o mesmo estado — foi medido: o corpo
 * de `pdf.ts` é avaliado uma única vez sob `tsx`.)
 */
describe("o worker liga o isolamento no boot", () => {
  it("o entrypoint de produção registra a extração isolada antes de qualquer laço", () => {
    let saida = "";
    try {
      saida = execFileSync("node", [TSX, "workers/agent-worker/main.ts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          NODE_NO_WARNINGS: "1",
          SENTRY_DSN: "off",
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "chave-de-mentira",
          SUPABASE_SERVICE_ROLE_KEY: "chave-de-mentira",
        },
      });
    } catch (e) {
      // Sem SUPABASE_DB_URL o boot falha no `loadEnv` — é o esperado; o que se
      // lê é o que ele escreveu ANTES.
      saida = String((e as { stdout?: string }).stdout ?? "");
    }
    const linha = saida
      .split("\n")
      .find((l) => l.includes("extração de PDF isolada em processo filho"));
    expect(linha, "o worker subiu sem isolar o pdf.js — o primeiro PDF volta a derrubá-lo").toBeDefined();
    expect(JSON.parse(linha!)).toMatchObject({ teto_de_memoria_mb: ISOLAMENTO_PADRAO.tetoDeMemoriaMb });
  }, 150_000);
});

describe("o processo filho da extração", () => {
  const pdf = readFileSync(FIXTURE);
  const temp = mkdtempSync(join(tmpdir(), "pdf-filho-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  /** Um filho de mentira, para os desfechos que um PDF de verdade não produz sob demanda. */
  function filhoFalso(nome: string, corpo: string): string {
    const caminho = join(temp, nome);
    writeFileSync(caminho, corpo);
    return caminho;
  }

  it("mora onde o worker o procura (o diretório de trabalho é a raiz, como no contêiner)", () => {
    expect(existsSync(caminhoDoExtratorIsolado())).toBe(true);
  });

  it("estourar o teto de memória mata o FILHO e vira PdfExtractError — o pai segue", async () => {
    const promessa = extrairEmProcessoFilho(pdf, {
      script: caminhoDoExtratorIsolado(),
      tetoDeMemoriaMb: 8,
      tempoMaximoMs: ISOLAMENTO_PADRAO.tempoMaximoMs,
    });
    await expect(promessa).rejects.toBeInstanceOf(PdfExtractError);
    await expect(promessa).rejects.toThrow(/teto de 8 MB/);
  }, 60_000);

  it("passar do tempo mata o filho e vira PdfExtractError", async () => {
    const preso = filhoFalso("preso.mjs", "setInterval(() => {}, 1000);");
    const inicio = Date.now();
    const promessa = extrairEmProcessoFilho(pdf, {
      script: preso,
      tetoDeMemoriaMb: ISOLAMENTO_PADRAO.tetoDeMemoriaMb,
      tempoMaximoMs: 300,
    });
    await expect(promessa).rejects.toThrow(/passou de 0.3 s/);
    expect(Date.now() - inicio).toBeLessThan(10_000);
  });

  it("script ausente vira PdfExtractError com o caminho — nunca volta para dentro do processo", async () => {
    await expect(
      extrairEmProcessoFilho(pdf, { ...ISOLAMENTO_PADRAO, script: join(temp, "nao-existe.mjs") }),
    ).rejects.toThrow(/não existe nesta instalação/);
  });

  it("o filho não recebe o ambiente do worker — quem abre arquivo de terceiro não vê segredo", async () => {
    process.env.SEGREDO_DO_TESTE_DO_FILHO = "nao-deveria-vazar";
    try {
      const espiao = filhoFalso(
        "espiao.mjs",
        `for await (const _ of process.stdin) {}\n` +
          `process.stdout.write(JSON.stringify({ ok: true, texto: Object.keys(process.env).join(",") }));`,
      );
      const chaves = await extrairEmProcessoFilho(pdf, { ...ISOLAMENTO_PADRAO, script: espiao });
      expect(chaves.split(",")).not.toContain("SEGREDO_DO_TESTE_DO_FILHO");
    } finally {
      delete process.env.SEGREDO_DO_TESTE_DO_FILHO;
    }
  });
});
