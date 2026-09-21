/**
 * Estado da barra lateral: quem lê o cookie e quem o escreve concordam num lugar só.
 *
 * O cookie tem três estados, e o que decide o padrão é o AUSENTE:
 *
 *   `"0"`  → a pessoa expandiu a barra de propósito (o botão grava isto ao sair do
 *            estado recolhido)
 *   `"1"`  → a pessoa a recolheu
 *   ausente → nunca mexeu
 *
 * Quem nunca mexeu recebe a barra RECOLHIDA. O padrão anterior era expandida, e
 * ela toma 240px de uma tela em que o que se usa o dia inteiro é o Inbox — a lista,
 * a conversa e a ficha do cliente, lado a lado, disputando a mesma largura. A barra
 * recolhida devolve 176px a essa disputa, e as funções continuam a um clique
 * (o botão de expandir, o ⌘K e o `title` de cada ícone).
 *
 * Por isso a comparação é com `"0"` e não com `"1"`: escrever `=== "1"` (a forma
 * antiga) faz o AUSENTE cair no lado errado sem que nenhum tipo reclame.
 */
export const COOKIE_BARRA_RECOLHIDA = "sidebar_collapsed";

export function barraLateralRecolhida(valorDoCookie: string | undefined): boolean {
  return valorDoCookie !== "0";
}
