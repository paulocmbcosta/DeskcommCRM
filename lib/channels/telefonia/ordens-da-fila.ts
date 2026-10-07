/**
 * AS ORDENS DA FILA — o vocabulário do evento que leva "atender" e "mover" da
 * tela para o worker (desenho `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md`,
 * §4.3), no molde da ordem da transferência (`transferencia.ts`): a rota confere
 * e GRAVA o pedido em `voice_call_queue_orders`, emite o evento pela ARI, e o
 * worker relê a linha pelo id — presa à organização da ligação que ELE tem em
 * memória — antes de agir. O evento é ponteiro, nunca autoridade.
 *
 * Aqui mora só o que os três lados precisam combinar: o nome do evento (rota e
 * worker), o cabeçalho do toque (worker e navegador) e a leitura do evento. A
 * mecânica — puxar para o ramal de quem pediu, mover para a fila de outro time —
 * mexe no estado privado da fila e por isso mora no controlador.
 */
import type { EventoAri } from "./portas";

/** O evento de usuário da ARI que leva a ordem da tela para a fila (atender, mover). */
export const EVENTO_DA_FILA = "telefonia_fila";

/** O cabeçalho do toque de quem pediu para atender: o navegador que clicou atende sozinho. */
export const CABECALHO_DO_ATENDER = "X-Fila-Atender";

export const ACOES_DA_FILA = ["atender", "mover"] as const;
export type AcaoDaFila = (typeof ACOES_DA_FILA)[number];

/**
 * Quanto o ramal de quem puxou toca antes de a ligação voltar ao rodízio. Dez
 * segundos, e não os vinte do rodízio: o navegador que clicou atende em menos
 * de um; o resto do prazo só cobre a aba que fechou no meio.
 */
export const TOQUE_DE_QUEM_PUXOU_MS = 10_000;

export interface OrdemDaFilaNoEvento {
  acao: AcaoDaFila;
  ordemId: string;
  voiceCallId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * O id da ligação é procurado primeiro NA MEMÓRIA do worker (só vai ao banco
 * junto com a organização da ligação achada): basta ser um identificador
 * limpo. O da ordem vai ao banco — tem de ser uuid.
 */
const ID_DA_LIGACAO = /^[0-9A-Za-z-]{1,64}$/;

/**
 * A ordem da tela, lida do evento de usuário da ARI — `ChannelUserevent` com o
 * `eventname` e as variáveis em `userevent` (o mesmo formato da transferência,
 * medido na VPS). O Asterisk repete o `eventname` DENTRO de `userevent`: esse
 * é ignorado, quem manda é o do evento. `null` para qualquer evento que não
 * seja uma ordem da fila bem formada — e nada aqui devolve mais que a ação e os
 * dois ids: o resto (quem pediu, para onde) se relê do banco.
 */
export function lerOrdemDaFila(ev: EventoAri): OrdemDaFilaNoEvento | null {
  if (ev.type !== "ChannelUserevent") return null;
  const e = ev as { eventname?: unknown; userevent?: unknown };
  if (e.eventname !== EVENTO_DA_FILA) return null;
  const v = e.userevent && typeof e.userevent === "object" ? (e.userevent as Record<string, unknown>) : null;
  if (!v) return null;
  const acao = v.acao;
  const ordemId = v.ordem_id;
  const voiceCallId = v.voice_call_id;
  if (typeof acao !== "string" || !(ACOES_DA_FILA as readonly string[]).includes(acao)) return null;
  if (typeof ordemId !== "string" || !UUID.test(ordemId)) return null;
  if (typeof voiceCallId !== "string" || !ID_DA_LIGACAO.test(voiceCallId)) return null;
  return { acao: acao as AcaoDaFila, ordemId, voiceCallId };
}
