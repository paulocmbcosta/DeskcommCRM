/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * UMA engine: pdfjs-dist (build `legacy`, que é a que roda em Node).
 * Uma tentativa só. Se ela falhar, lança PdfExtractError — não há segunda.
 *
 * Este arquivo já teve duas tentativas (pdf-parse como primária, pdfjs como
 * fallback) e elas NÃO eram duas engines. O pdf-parse@1 vendoriza quatro cópias
 * completas do pdf.js da Mozilla dentro de si — 29 dos 29 MB do pacote estão em
 * `lib/` — e fixa a `v1.10.100`, de 2018. Ou seja: era o MESMO pdf.js duas vezes,
 * com 7 majors de distância, e a cópia velha rodava PRIMEIRO.
 *
 * Medido na issue #238: a v1.10.100 falha com "bad XRef entry" na própria fixture
 * deste repo (`tests/fixtures/sample-text.pdf`) e com "Illegal character: 41" num
 * PDF gerado pelo @react-pdf/renderer. A "primária" já estava morta há tempos e
 * quem extraía era o fallback — o teste verde media o caminho de baixo achando que
 * media o de cima. Redundância que não é redundante é código morto, e este arquivo
 * já pagou por isso uma vez (issue #102, no comentário lá embaixo).
 *
 * ═══ DOIS LUGARES ONDE O PDF.JS RODA, E POR QUÊ ═══
 *
 * O laço de extração é UM só (`pdf-nucleo.mjs`). O que muda é o processo:
 *
 *   * **dentro do processo** (padrão) — o app Next, os testes;
 *   * **num processo filho** (`isolarExtracaoDePdf`) — o worker do agent-engine,
 *     que liga o isolamento no boot (`workers/agent-worker/main.ts`).
 *
 * O worker roda sob `tsx`, e o `tsx` liga mapas de fonte no processo inteiro e
 * passa cada módulo pelo loader dele. Para o pdf.js — 3,4 MB de JavaScript com
 * 7,7 MB de source map ao lado — isso custa caro. Medido na imagem do worker
 * (node:22-alpine, contêiner de 512 MB, teto de heap de 259 MB):
 *
 *   node puro:  pdf.js + um PDF de 598 bytes cabem num heap de 24 MB;
 *   sob tsx:    o mesmo arquivo reprova em 160 MB e passa em 192 MB.
 *
 * O grafo de módulos do worker ocioso já ocupa 86 MB. 86 + ~180 passa de 259: o
 * PRIMEIRO PDF que o worker lê o derruba com `JavaScript heap out of memory`,
 * qualquer que seja o tamanho do arquivo. Foi o que aconteceu em produção de 25 a
 * 28/09/2026 — PDFs de 2,6 KB a 338 KB, todos, e o `event_log` devolvendo o
 * evento a cada 10 minutos para derrubar o worker de novo (`drain.ts`).
 *
 * No filho, o pdf.js roda em `node` puro, com teto de memória e de tempo
 * próprios. O worker não carrega o pdf.js nunca; um PDF que estoure o teto — ou
 * que prenda a engine num laço — mata o filho, vira `PdfExtractError`, e o
 * processo que atende as conversas segue de pé.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/** Como o processo filho roda. Os padrões abaixo são medidos, não chutados. */
export interface IsolamentoDoPdf {
  /** Caminho de `pdf-processo-filho.mjs`. */
  script: string;
  /**
   * Teto do heap do filho. Medido com pdf.js em node puro: 300 páginas (1 MB,
   * 941 mil caracteres) cabem em 32 MB; 2.000 páginas (7 MB) precisam de mais de
   * 64 MB e cabem em 128 MB, com RSS de 220 MB — que somados aos ~200 MB do
   * worker ainda ficam dentro dos 512 MB do contêiner.
   */
  tetoDeMemoriaMb: number;
  /** As mesmas 2.000 páginas levam 1,8 s. 30 s é folga de mais de 15×. */
  tempoMaximoMs: number;
}

export const ISOLAMENTO_PADRAO: Omit<IsolamentoDoPdf, "script"> = {
  tetoDeMemoriaMb: 128,
  tempoMaximoMs: 30_000,
};

/**
 * Onde o filho mora. Relativo ao diretório de trabalho porque é assim que o
 * worker sobe (`WORKDIR /app` + `tsx workers/agent-worker/main.ts`, e `pnpm
 * worker` na raiz em dev) — o mesmo diretório dos testes, que conferem que o
 * arquivo existe aí.
 */
export function caminhoDoExtratorIsolado(): string {
  return path.join(process.cwd(), "lib", "ai", "rag", "extractors", "pdf-processo-filho.mjs");
}

let isolamento: IsolamentoDoPdf | null = null;

/**
 * Liga o processo filho para TODA extração de PDF deste processo. Chamada pelo
 * boot do worker; devolve a configuração em vigor para ele registrar no log.
 */
export function isolarExtracaoDePdf(opcoes: Partial<IsolamentoDoPdf> = {}): IsolamentoDoPdf {
  isolamento = { script: caminhoDoExtratorIsolado(), ...ISOLAMENTO_PADRAO, ...opcoes };
  return isolamento;
}

/**
 * Extrai texto puro de um buffer de PDF usando pdfjs-dist.
 * Lança `PdfExtractError` se o arquivo for ilegível ou não tiver texto algum.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const combined =
      isolamento === null
        ? await (await import("./pdf-nucleo.mjs")).extrairTextoComPdfjs(new Uint8Array(buffer))
        : await extrairEmProcessoFilho(buffer, isolamento);

    if (combined.length === 0) {
      throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)");
    }
    return combined;
  } catch (err) {
    if (err instanceof PdfExtractError) throw err;

    // O pdfjs 6 faz `new DOMMatrix()` no topo do módulo e depende do
    // `@napi-rs/canvas` (optionalDependency) para o polyfill. Sem esse binário —
    // plataforma sem binding publicado, registry corporativo sem os artefatos, ou
    // instalação com optional deps podadas — ele estoura no IMPORT, antes de ler o
    // arquivo. A versão 4 só avisava e extraía o texto assim mesmo.
    //
    // Sem esta mensagem, quem instalou vê "DOMMatrix is not defined" e não tem como
    // ligar isso a uma dependência que ele nem sabe que existe. O diagnóstico custa
    // 4 linhas; a caçada custa uma tarde.
    if (err instanceof Error && /DOMMatrix|@napi-rs\/canvas/.test(err.message)) {
      throw new PdfExtractError(
        "Extração de PDF indisponível: o binário nativo @napi-rs/canvas não foi instalado " +
          "nesta plataforma. Reinstale as dependências SEM podar as opcionais " +
          "(`pnpm install`, não `--no-optional`). Até lá, PDFs não são lidos.",
        err,
      );
    }

    // A causa vai NA mensagem, e não só em `cause`: quem lê é `event_log.last_error`
    // e o aviso da Central, que guardam a mensagem e jogam o resto fora. Em
    // produção, 12 PDFs seguidos morreram com esta frase sem o motivo ao lado.
    const causa = err instanceof Error ? err.message : String(err);
    throw new PdfExtractError(
      `pdfjs-dist failed to extract text from the PDF: ${(causa.split("\n", 1)[0] ?? "").slice(0, 200)}`,
      err,
    );
  }
}

/**
 * Roda `pdf-processo-filho.mjs` em `node` puro — sem os `execArgv` deste
 * processo, que no worker são justamente o loader do `tsx` — e devolve o texto.
 *
 * O erro do pdf.js volta como `Error` comum, para passar pela MESMA tradução do
 * caminho dentro do processo. O que só existe aqui (teto de memória, tempo,
 * arquivo ausente) já sai como `PdfExtractError`.
 */
export function extrairEmProcessoFilho(buffer: Buffer, opcoes: IsolamentoDoPdf): Promise<string> {
  if (!existsSync(opcoes.script)) {
    return Promise.reject(
      new PdfExtractError(
        `extração isolada de PDF indisponível: ${opcoes.script} não existe nesta instalação`,
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const filho = spawn(
      process.execPath,
      [`--max-old-space-size=${opcoes.tetoDeMemoriaMb}`, opcoes.script],
      // Sem o `env` do worker: quem abre arquivo de terceiro não precisa de
      // segredo nenhum. (`NODE_ENV` vai só porque o tipo do Next o exige.)
      { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: process.env.NODE_ENV } },
    );
    const saida: Buffer[] = [];
    // O COMEÇO do stderr, não o fim: a linha do V8 que diz "heap out of memory"
    // vem antes de um rastro nativo que passa de 100 linhas — guardar o fim
    // cortava justamente a frase que explica a morte.
    let inicioDoStderr = "";
    let estourouOTempo = false;
    const relogio = setTimeout(() => {
      estourouOTempo = true;
      filho.kill("SIGKILL");
    }, opcoes.tempoMaximoMs);

    filho.stdout.on("data", (parte: Buffer) => saida.push(parte));
    filho.stderr.on("data", (parte: Buffer) => {
      if (inicioDoStderr.length < 16_000) inicioDoStderr += parte.toString("utf8");
    });
    // O filho que morre antes de ler o arquivo inteiro fecha o pipe: EPIPE aqui é
    // consequência, e a causa chega pelo `close` logo abaixo.
    filho.stdin.on("error", () => {});

    filho.on("error", (err) => {
      clearTimeout(relogio);
      reject(new PdfExtractError(`não consegui abrir o extrator isolado de PDF: ${err.message}`, err));
    });
    filho.on("close", (codigo, sinal) => {
      clearTimeout(relogio);
      if (estourouOTempo) {
        reject(
          new PdfExtractError(
            `a leitura do PDF passou de ${opcoes.tempoMaximoMs / 1000} s e foi interrompida`,
          ),
        );
        return;
      }
      if (codigo !== 0) {
        const semMemoria = /heap out of memory|Reached heap limit/i.test(inicioDoStderr);
        reject(
          new PdfExtractError(
            semMemoria
              ? `a leitura do PDF passou do teto de ${opcoes.tetoDeMemoriaMb} MB de memória e foi interrompida`
              : `o extrator isolado de PDF terminou com ${codigo ?? sinal}`,
          ),
        );
        return;
      }
      let resposta: { ok: true; texto: string } | { ok: false; erro: string };
      try {
        resposta = JSON.parse(Buffer.concat(saida).toString("utf8"));
      } catch {
        reject(new PdfExtractError("o extrator isolado de PDF devolveu uma resposta ilegível"));
        return;
      }
      if (resposta.ok) resolve(resposta.texto);
      else reject(new Error(resposta.erro));
    });

    filho.stdin.end(buffer);
  });
}
