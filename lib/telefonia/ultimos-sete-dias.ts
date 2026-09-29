/**
 * O "últimos 7 dias" de cada menu (desenho da fase 2, §6.2 e §8) — puro e
 * client-safe. É o laço de retorno da URA: muita gente caindo no time padrão sem
 * escolher, ou desligando no meio do menu, é o sinal de que a fala confunde, e o
 * dono reescreve.
 */
import type { DesfechoDoMenu, UltimosSeteDias } from "./vocabulario";

/**
 * Uma linha agregada da semana. `menu_outcome=null` é quem DESLIGOU dentro do
 * menu, sem escolher e sem cair no padrão.
 *
 * **Para quem escreve a consulta (Task 8):** some só ligações JÁ ENCERRADAS.
 * Uma ligação ainda em curso pode terminar escolhendo uma opção — contá-la
 * aqui como "desligou no menu" (ou em qualquer bucket) seria contar um
 * desfecho que ainda não aconteceu.
 */
export interface LinhaDoMenuNaSemana {
  menu_outcome: DesfechoDoMenu | null;
  menu_digit: string | null;
  n: number;
}

export const MINIMO_PARA_ALERTA = 5;
export const PROPORCAO_QUE_CONFUNDE = 0.3;

export function somarUltimosSeteDias(linhas: readonly LinhaDoMenuNaSemana[]): UltimosSeteDias {
  const u: UltimosSeteDias = { total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 };
  for (const l of linhas) {
    u.total += l.n;
    if (l.menu_outcome === "chosen" && l.menu_digit) u.por_tecla[l.menu_digit] = (u.por_tecla[l.menu_digit] ?? 0) + l.n;
    else if (l.menu_outcome === "default_no_input") u.sem_escolha += l.n;
    else if (l.menu_outcome === "default_invalid") u.tecla_errada += l.n;
    else if (l.menu_outcome === null) u.desligou_no_menu += l.n;
  }
  return u;
}

/**
 * Menu que confunde: 5+ ligações na semana e 30%+ delas sem escolher — caindo
 * no padrão (sem tecla ou tecla errada) OU desligando no meio. Desistir no
 * meio do menu é o mesmo sinal de confusão que cair no padrão sem digitar
 * nada; menu comprido demais também faz o cliente desistir.
 */
export function menuConfunde(u: UltimosSeteDias): boolean {
  return (
    u.total >= MINIMO_PARA_ALERTA &&
    (u.sem_escolha + u.tecla_errada + u.desligou_no_menu) / u.total >= PROPORCAO_QUE_CONFUNDE
  );
}
