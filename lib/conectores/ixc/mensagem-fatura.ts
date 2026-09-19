/**
 * O TEXTO DA FATURA — composto no SERVIDOR, a partir do que o IXC devolveu.
 *
 * Quem clica em "Enviar fatura" manda só o id; nunca o texto. Valor, vencimento
 * e linha digitável são o tipo de dado em que um dígito errado custa dinheiro
 * de alguém, e é por isso que nem o navegador nem (na fase seguinte) a IA
 * escrevem estes números: os dois só disparam esta função.
 *
 * DUAS mensagens quando há linha digitável: no WhatsApp copia-se a mensagem
 * INTEIRA com um toque longo, e uma linha digitável no meio de um parágrafo
 * obriga o cliente a selecionar 47 dígitos com o dedo.
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

export function mensagensDaFatura(fatura: Fatura): string[] {
  const quando =
    fatura.situacao === "vencida"
      ? `Vencimento: ${dataBr(fatura.vencimento)} (vencida há ${fatura.diasDeAtraso} ${fatura.diasDeAtraso === 1 ? "dia" : "dias"})`
      : `Vencimento: ${dataBr(fatura.vencimento)}`;
  const linhas = ["Segue a sua fatura:", "", quando, `Valor: ${valorBr(fatura.valorCents)}`];
  if (fatura.link) linhas.push("", `Boleto: ${fatura.link}`);
  if (fatura.linhaDigitavel) linhas.push("", "A linha digitável vai na próxima mensagem, para você copiar com um toque.");

  const mensagens = [linhas.join("\n")];
  if (fatura.linhaDigitavel) mensagens.push(fatura.linhaDigitavel);
  return mensagens;
}
