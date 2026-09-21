/**
 * Pede o rodízio da fila humana para UMA conversa — o gesto de quem tira a
 * conversa da IA.
 *
 * O rodízio (`lib/routing/worker.ts`) não distribui a conversa que a IA
 * automática está atendendo (migration 0273; medido em produção em 2026-09-21:
 * com atendente online, a IA não respondia ninguém). O pedido que nasce com a
 * conversa fecha como `skipped_ai_attending`, então quem a tira da IA pede de
 * novo — a transferência (`performHumanHandoff`) e o drain quando recusa o turno.
 *
 * `fn_request_channel_routing` se protege sozinha: conversa com dono, fechada ou
 * já esperando na fila é no-op (o `on conflict` só adianta o evento pendente).
 * Pedir a mais é inofensivo; pedir a menos é cliente esquecido.
 *
 * Best-effort de propósito: quem chama já fez o que importa (calou a IA, gravou o
 * time, ou decidiu não responder), e desfazer isso por causa de um pedido de fila
 * que falhou seria pior. A falha vira aviso no log, e a próxima mensagem do
 * cliente passa pelo drain e pede de novo.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';

export async function pedirRodizioDaFilaHumana(
  db: Pick<pg.Pool, 'query'>,
  ids: { organizationId: string; conversationId: string },
  log: Pick<Logger, 'warn'>,
  origem: string,
): Promise<boolean> {
  try {
    await db.query('select public.fn_request_channel_routing($1, $2)', [
      ids.organizationId,
      ids.conversationId,
    ]);
    return true;
  } catch (err) {
    log.warn('rodízio não pedido — a próxima mensagem do cliente tenta de novo', {
      origem,
      conversation_id: ids.conversationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return false;
  }
}
