/**
 * O PROCESSO FILHO da extração de PDF — aberto por `extrairEmProcessoFilho`
 * (`pdf.ts`) em `node` puro, sem `tsx`. O porquê está no cabeçalho de `pdf.ts`.
 *
 * Contrato: lê o PDF inteiro do stdin e escreve UM JSON no stdout —
 * `{ ok: true, texto }` ou `{ ok: false, erro }`. Morrer (teto de memória,
 * `kill` por tempo) é resposta também: quem chama lê o código de saída.
 */

import { extrairTextoComPdfjs } from "./pdf-nucleo.mjs";

// O pdf.js avisa com `console.log("Warning: …")`, e o stdout é o canal da
// resposta. Um aviso ali tornaria o JSON ilegível; no stderr ele não atrapalha
// ninguém. (O pdf.js só é carregado DENTRO de `extrairTextoComPdfjs`, então
// nenhum aviso sai antes desta linha.)
// eslint-disable-next-line no-console -- não é log: é o desvio do log do pdf.js para fora do canal da resposta.
console.log = (...partes) => console.error(...partes);

const pedacos = [];
for await (const pedaco of process.stdin) pedacos.push(pedaco);

let resposta;
try {
  resposta = { ok: true, texto: await extrairTextoComPdfjs(new Uint8Array(Buffer.concat(pedacos))) };
} catch (err) {
  resposta = { ok: false, erro: err instanceof Error ? err.message : String(err) };
}

// `exit` no callback, e não solto: o pdf.js pode deixar alça aberta no laço de
// eventos, e sair antes do flush cortaria a resposta no meio.
process.stdout.write(JSON.stringify(resposta), () => process.exit(0));
