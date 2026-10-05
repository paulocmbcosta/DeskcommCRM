/**
 * Os períodos do painel de assuntos. Pura, com o "agora" por parâmetro: o
 * recorte "hoje" e "este mês" é pelo relógio de QUEM OLHA a tela (o navegador),
 * que é o dia de trabalho que a pessoa tem em mente ao perguntar "quanto
 * fechamos hoje?".
 */
export const PERIODOS_DE_ASSUNTOS = ["hoje", "7d", "30d", "mes"] as const;
export type PeriodoDeAssuntos = (typeof PERIODOS_DE_ASSUNTOS)[number];

export const ROTULO_DO_PERIODO: Readonly<Record<PeriodoDeAssuntos, string>> = {
  hoje: "Hoje",
  "7d": "7 dias",
  "30d": "30 dias",
  mes: "Este mês",
};

const DIA_MS = 24 * 60 * 60 * 1000;

export function intervaloDoPeriodo(periodo: PeriodoDeAssuntos, agora: Date): { from: string; to: string } {
  const inicio = new Date(agora);
  if (periodo === "hoje") inicio.setHours(0, 0, 0, 0);
  else if (periodo === "mes") {
    inicio.setDate(1);
    inicio.setHours(0, 0, 0, 0);
  } else inicio.setTime(agora.getTime() - (periodo === "7d" ? 7 : 30) * DIA_MS);
  return { from: inicio.toISOString(), to: agora.toISOString() };
}
