/**
 * O PERÍODO do filtro da aba Fechadas — do que a pessoa escolhe ("hoje", "ontem",
 * um intervalo de datas) para os dois instantes que o servidor recebe.
 *
 * Mora num módulo próprio, sem React e sem rede, porque é a parte do filtro em
 * que um erro de um dia passa despercebido: a lista continua cheia, só que com o
 * dia errado.
 */

export const PERIODOS = ["hoje", "ontem", "7d", "30d"] as const;
export type Periodo = (typeof PERIODOS)[number];

export interface IntervaloDeFechamento {
  /** Inclusivo. */
  closed_from?: string;
  /** Exclusivo. Ausente = até agora. */
  closed_to?: string;
}

const FORMA = /^\d{4}-\d{2}-\d{2}$/;

function partes(data: string): [number, number, number] {
  const [ano, mes, dia] = data.split("-").map(Number);
  return [ano ?? 0, mes ?? 0, dia ?? 0];
}

/** `AAAA-MM-DD` que existe no calendário — `2026-02-30` tem a forma e não existe. */
export function dataValida(data: string): boolean {
  if (!FORMA.test(data)) return false;
  const [ano, mes, dia] = partes(data);
  // O `Date` aceita o dia 30 de fevereiro e o transforma em 2 de março. Conferir
  // que as partes voltam iguais é o que distingue data de conta.
  const dt = new Date(ano, mes - 1, dia);
  return dt.getFullYear() === ano && dt.getMonth() === mes - 1 && dt.getDate() === dia;
}

/** Hoje como `AAAA-MM-DD`, no fuso de quem olha — o valor de um `<input type="date">`. */
export function hojeComoData(agora: Date = new Date()): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;
}

/**
 * Os dois instantes do recorte.
 *
 * ─── O dia é o de QUEM OLHA A TELA ──────────────────────────────────────────
 * `new Date(ano, mês, dia)` é meia-noite LOCAL: "hoje" é o que a pessoa chama de
 * hoje. Um observador em outro fuso vê outro recorte — limite declarado no
 * desenho (D7), aceito porque usar o fuso da organização pediria conta de fuso
 * no navegador para um caso que hoje não existe.
 *
 * ─── Por que as escolhas abertas não mandam fim ─────────────────────────────
 * "Hoje", "7 dias" e "30 dias" vão até agora. Mandar `closed_to = agora`
 * mudaria a chave da consulta a cada render — e a lista se recarregaria sem
 * parar. O começo é a meia-noite, igual o dia inteiro.
 *
 * ─── Metade de um período não é um período ──────────────────────────────────
 * Uma data só, ou o começo depois do fim, não recorta nada. Recortar "a partir
 * de X" quando a pessoa ainda está escolhendo o fim esconderia atendimentos por
 * um filtro que ela não terminou de montar.
 */
export function resolverPeriodo(
  escolha: { periodo?: Periodo; de?: string; ate?: string },
  agora: Date = new Date(),
): IntervaloDeFechamento {
  const dia = (deslocamento: number) =>
    new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + deslocamento).toISOString();
  switch (escolha.periodo) {
    case "hoje":
      return { closed_from: dia(0) };
    case "ontem":
      return { closed_from: dia(-1), closed_to: dia(0) };
    case "7d":
      return { closed_from: dia(-6) };
    case "30d":
      return { closed_from: dia(-29) };
    default:
  }
  const { de, ate } = escolha;
  if (!de || !ate || !dataValida(de) || !dataValida(ate) || de > ate) return {};
  const [anoDe, mesDe, diaDe] = partes(de);
  const [anoAte, mesAte, diaAte] = partes(ate);
  return {
    closed_from: new Date(anoDe, mesDe - 1, diaDe).toISOString(),
    // O dia seguinte ao fim, e não 23:59:59: fim EXCLUSIVO não perde o
    // atendimento encerrado no último segundo do dia.
    closed_to: new Date(anoAte, mesAte - 1, diaAte + 1).toISOString(),
  };
}
