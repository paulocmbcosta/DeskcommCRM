/**
 * O QUE VAI ESCRITO JUNTO DA COBRANÇA — composto no SERVIDOR, a partir do que o
 * IXC devolveu.
 *
 * Quem pede o envio manda só o id da fatura e a forma; nunca o texto. Valor,
 * vencimento, linha digitável e copia-e-cola são o tipo de dado em que um dígito
 * errado custa dinheiro de alguém — então nem o navegador nem (na fase seguinte)
 * a IA escrevem estes números: os dois só disparam `enviarCobrancaIxc`.
 *
 * Cada cobrança sai em DUAS mensagens: o arquivo (PDF do boleto, ou a imagem do
 * QR code) com a legenda, e depois o código SOZINHO — linha digitável ou
 * copia-e-cola. No WhatsApp copia-se a mensagem inteira com um toque longo; um
 * código de 47 ou 190 caracteres no meio de um parágrafo obriga o cliente a
 * selecionar com o dedo.
 */
import type { Fatura } from "./faturas";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function dataBr(ymd: string): string {
  const [a, m, d] = ymd.slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : ymd;
}

export function valorBr(cents: number): string {
  // O Intl separa com NBSP (U+00A0); no WhatsApp ele cola igual, mas em teste e
  // em log vira um espaço que não é espaço.
  return BRL.format(cents / 100).replace(/ /g, " ");
}

function linhaDoVencimento(fatura: Fatura): string {
  return fatura.situacao === "vencida"
    ? `Vencimento: ${dataBr(fatura.vencimento)} (vencida há ${fatura.diasDeAtraso} ${fatura.diasDeAtraso === 1 ? "dia" : "dias"})`
    : `Vencimento: ${dataBr(fatura.vencimento)}`;
}

/** A legenda do PDF. Só promete a segunda mensagem quando ela vai existir. */
export function legendaDoBoleto(fatura: Fatura): string {
  const linhas = ["Segue o boleto da sua fatura.", "", linhaDoVencimento(fatura), `Valor: ${valorBr(fatura.valorCents)}`];
  if (fatura.linhaDigitavel) linhas.push("", "A linha digitável vai na próxima mensagem, para você copiar com um toque.");
  return linhas.join("\n");
}

/**
 * A legenda do QR code. `valorCents` é o do PIX (o que o QR de fato cobra),
 * que quem chama lê de `get_pix`; sem ele, vale o da fatura.
 */
export function legendaDoPix(fatura: Fatura, valorCents: number = fatura.valorCents): string {
  return [
    "Segue o Pix da sua fatura.",
    "",
    linhaDoVencimento(fatura),
    `Valor: ${valorBr(valorCents)}`,
    "",
    "Aponte a câmera do app do seu banco para o QR code — ou use o Pix copia e cola, que vai na próxima mensagem.",
  ].join("\n");
}

/** O nome do arquivo é o que o cliente vê no WhatsApp: `boleto-10-09-2026.pdf`, não `out-3f2a….pdf`. */
export function nomeDoArquivo(forma: "boleto" | "pix", fatura: Fatura): string {
  return `${forma}-${dataBr(fatura.vencimento).replace(/\//g, "-")}`;
}
