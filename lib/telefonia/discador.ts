/**
 * O QUE O DISCADOR DO CABEÇALHO ENTENDE (v3; desenho §12.5) — regra pura,
 * client-safe. O campo aceita três coisas:
 *  - um RAMAL: 2 a 4 dígitos, sem começar por 0 (D22) — liga para o colega;
 *  - um NOME: tem letra — o discador sugere os colegas que casam, e o clique
 *    liga para o ramal da pessoa;
 *  - um NÚMERO de telefone: o resto, julgado pela política de saída
 *    (`numeroParaLigar`), como antes.
 * O 0 na frente continua sendo do número de fora: é o prefixo da operadora.
 */
import { REGUA_DO_RAMAL } from "./vocabulario";

export type AlvoDoDiscador = { tipo: "vazio" } | { tipo: "ramal"; ramal: string } | { tipo: "nome"; busca: string } | { tipo: "numero" };

export function alvoDoDiscador(digitado: string): AlvoDoDiscador {
  const d = digitado.trim();
  if (!d) return { tipo: "vazio" };
  if (/\p{L}/u.test(d)) return { tipo: "nome", busca: d };
  if (REGUA_DO_RAMAL.test(d)) return { tipo: "ramal", ramal: d };
  return { tipo: "numero" };
}
