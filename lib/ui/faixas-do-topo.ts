/**
 * A ALTURA DAS FAIXAS DO TOPO DE /app — a única fonte da conta.
 *
 * As faixas de estado (acompanhamento administrativo, conexão caída, aviso de
 * instabilidade do telefone) grudam no topo num contêiner só
 * (`components/app/FaixasDoTopo.tsx`), que publica a própria altura em
 * `--altura-das-faixas` no `<html>` — 0 sem faixa nenhuma, e ausente antes de
 * hidratar (daí o `0px` de reserva).
 *
 * Quem gruda ou mede a janela abaixo delas desconta essa altura:
 *  - a casca de /app (`AppShell`) mede, no mínimo, a janela menos as faixas —
 *    com `min-h-screen`, a página somava faixa + 100vh e rolava pela altura dela
 *    em toda tela;
 *  - a barra lateral gruda logo abaixo das faixas e mede a janela menos elas —
 *    `top-0 h-screen` nascia com o rodapé (o `VersionFooter`) cortado e, ao
 *    rolar, com o topo coberto;
 *  - a TopBar gruda LOGO ABAIXO das faixas ao rolar (antes, as duas em `top: 0`,
 *    o contêiner `z-50` cobria a TopBar `z-20`);
 *  - a Inbox, que ocupa a janela abaixo da TopBar (`h-14` = 3.5rem) e não rola,
 *    mede a janela menos a TopBar menos as faixas — sem isso a página rolava pela
 *    altura da faixa e o composer nascia fora da dobra.
 *
 * São valores de `style`, e não classes do Tailwind, para a conta morar num lugar
 * só: classe arbitrária precisa ser texto literal no componente para o scanner a
 * achar, e duas cópias da conta divergem.
 */
export const VARIAVEL_DA_ALTURA_DAS_FAIXAS = "--altura-das-faixas";

const ALTURA_DAS_FAIXAS = `var(${VARIAVEL_DA_ALTURA_DAS_FAIXAS}, 0px)`;

/** O `top` de quem gruda logo abaixo das faixas (a TopBar, a barra lateral). */
export const TOPO_ABAIXO_DAS_FAIXAS = ALTURA_DAS_FAIXAS;

/**
 * A janela menos as faixas — o `min-height` da casca e a altura da barra lateral.
 * `100vh`, como o `min-h-screen`/`h-screen` que substitui: sem faixa, nada muda.
 */
export const JANELA_ABAIXO_DAS_FAIXAS = `calc(100vh - ${ALTURA_DAS_FAIXAS})`;

/** A altura de uma tela que ocupa a janela abaixo da TopBar (3.5rem) e das faixas (a Inbox). */
export const ALTURA_ABAIXO_DA_TOPBAR = `calc(100dvh - 3.5rem - ${ALTURA_DAS_FAIXAS})`;
