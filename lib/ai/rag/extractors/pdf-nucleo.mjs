/**
 * O NÚCLEO da extração de PDF — a única receita, lida pelos dois caminhos.
 *
 * JavaScript puro, e não TypeScript, porque um dos leitores é o processo filho
 * de `pdf-processo-filho.mjs`, que roda em `node` sem `tsx` (é esse o ponto do
 * isolamento — ver o cabeçalho de `pdf.ts`). O outro leitor é `pdf.ts`, no
 * caminho dentro do processo. Duas cópias deste laço seriam duas receitas para
 * o mesmo arquivo, e a #617 já mostrou onde isso termina.
 *
 * Os tipos para quem importa daqui estão em `pdf-nucleo.d.mts`.
 */

/**
 * Extrai o texto de todas as páginas. Devolve `""` quando o PDF não tem texto
 * (a decisão de chamar isso de erro é de quem chama) e deixa o erro do pdf.js
 * subir cru — a tradução para `PdfExtractError` mora em `pdf.ts`.
 *
 * @param {Uint8Array} dados
 * @returns {Promise<string>}
 */
export async function extrairTextoComPdfjs(dados) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // NÃO mexa em GlobalWorkerOptions.workerSrc aqui (issue #102).
  //
  // Havia um `workerSrc = ""` nesta linha, com a intenção de "desligar o worker
  // em Node". O efeito era o oposto: string vazia é falsy, e o getter
  // `PDFWorker.workerSrc` lança `No "GlobalWorkerOptions.workerSrc" specified.`
  // ANTES de ler um byte do arquivo — ou seja, a extração inteira era inalcançável,
  // e o erro chegava ao usuário como a mensagem genérica de `pdf.ts`.
  //
  // Em Node o pdf.js já se auto-configura; as três linhas sobrescreviam justamente
  // o que a lib tinha preparado. Medido nas versões 4.10.38 e 6.2.108: com
  // `workerSrc = ""` falha nas duas; sem tocar, extrai nas duas.
  const loadingTask = pdfjsLib.getDocument({ data: dados });
  const pdfDocument = await loadingTask.promise;

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const content = await page.getTextContent();

    // A quebra de linha vem do `hasEOL` do próprio pdf.js, não de comparar o Y do
    // `transform`. Medido na issue #238 com um PDF que tem "10,00" + um "2"
    // sobrescrito na MESMA linha visual: agrupar por `transform[5]` (o que o
    // pdf-parse fazia) devolve `"Assinatura R$ 10,00\n2 \npor mes"` — três linhas
    // onde há uma —, enquanto `hasEOL` devolve `"Assinatura R$ 10,002 por mes"`.
    // O sobrescrito muda o Y sem terminar a linha; só a engine sabe disso.
    const pageText = content.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
      .join("")
      .trim();
    if (pageText.length > 0) pageTexts.push(pageText);
  }

  return pageTexts.join("\n\n").trim();
}
