/**
 * event_log dispatcher — registry of consumers for domain events.
 *
 * Pattern: each handler declares the event types it consumes. The dispatcher
 * receives an `EventRow` (one row from `public.event_log`) and routes it to
 * every handler whose key has not yet been recorded in `consumed_by`.
 *
 * The actual *cron driver* that drains `event_log` (selects rows where
 * `status='pending'` AND `next_attempt_at <= now()`) is intentionally NOT in
 * this file — that lives in `app/api/v1/cron/event-log-drain/route.ts`
 * (created later in this epic). This module only owns the registry and the
 * single-row dispatch contract.
 */

import { logger } from "@/lib/logger";

export interface EventRow {
  id: string;
  organization_id: string;
  event_type: string;
  entity_kind: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  consumed_by: string[];
  attempts: number;
  /**
   * Quando o evento foi EMITIDO — não quando foi lido.
   *
   * ⚠️ OPCIONAL DE PROPÓSITO, e a razão é o raio: 26 arquivos constroem um
   * `EventRow`, a maioria fixtures de teste de outras features. Torná-lo
   * obrigatório quebraria todas elas por uma necessidade de um consumidor só.
   * O caminho de PRODUÇÃO sempre o traz — `drain.ts` o seleciona.
   *
   * Quem depende dele para DESCARTAR (ex.: teto de idade contra backlog de
   * `pending`) tem de falhar ABERTO quando ele faltar: sem a idade não dá para
   * afirmar que o evento é velho, e descartar na dúvida perderia um evento bom.
   */
  created_at?: string;
}

export interface HandlerResult {
  /** Stable key to push into `event_log.consumed_by`. */
  consumer_key: string;
  status: "ok" | "skipped" | "error" | "retry";
  /** ISO timestamp — obrigatório quando status="retry"; drain reagenda sem contar attempt. */
  retry_at?: string;
  detail?: string;
}

export interface EventHandler {
  /** Stable key recorded in `event_log.consumed_by`. */
  key: string;
  /** Event types this handler consumes (`["message.received", "message.sent"]`). */
  events: string[];
  /**
   * Handler que chama serviço externo LENTO e não pode segurar a resposta de
   * um webhook.
   *
   * O dreno também roda DENTRO do POST de todo canal
   * (`acelerarPipelineDeEventos`, lib/dev/kick-local-pipeline.ts), e lá ele
   * pega até 50 eventos — de qualquer organização. Um handler assim ali faria
   * cada webhook esperar por ele, inclusive pelos eventos dos outros.
   *
   * Com `contexto: "requisicao"`, o dispatcher NÃO o chama: devolve `retry`
   * para AGORA (`ADIADO_PARA_O_WORKER`). O dreno trata `retry` sem contar
   * tentativa, guarda em `consumed_by` quem já rodou e devolve o evento a
   * `pending` — e quem o pega é o dreno do serviço `worker`
   * (`runEventLogDrainLoop`, lib/event-log/drain-loop.ts, ligado em
   * workers/agent-worker/main.ts): em produção, a cada 2 s depois de um tick
   * com trabalho e a cada 10 s ocioso (`EVENT_LOG_DRAIN_INTERVAL_MS` /
   * `EVENT_LOG_DRAIN_IDLE_INTERVAL_MS`, lib/agent-engine/env.ts), com o cron
   * `event-log-drain` (1×/min, docker/scheduler/entrypoint.sh) de rede de
   * segurança. Os dois drenam no contexto padrão, `worker`.
   *
   * `skipped` NÃO serviria: marcaria o evento `done` e o trabalho se perderia.
   */
  foraDaRequisicao?: true;
  handle(row: EventRow): Promise<HandlerResult>;
}

/**
 * Onde o dreno está rodando. `worker` (o padrão) é o serviço `worker`, o cron
 * e o relógio; `requisicao` é o dreno que corre dentro do POST de um webhook.
 */
export type ContextoDoDreno = "requisicao" | "worker";

/** `detail` do `retry` sintético de um handler `foraDaRequisicao` adiado. */
export const ADIADO_PARA_O_WORKER = "adiado_para_o_worker";

const _handlers: EventHandler[] = [];
const _registeredKeys = new Set<string>();

export function registerHandler(handler: EventHandler): void {
  if (_registeredKeys.has(handler.key)) {
    // Hot-reload friendly — overwrite by removing prior entry.
    const idx = _handlers.findIndex((h) => h.key === handler.key);
    if (idx >= 0) _handlers.splice(idx, 1);
  }
  _handlers.push(handler);
  _registeredKeys.add(handler.key);
}

export function getRegisteredHandlers(): readonly EventHandler[] {
  return _handlers;
}

/**
 * Match handlers for a single event row, skipping any whose key already lives
 * in `consumed_by`. Returns the per-handler results so the cron driver can
 * decide how to update `consumed_by` / `status` / `attempts`.
 */
export async function dispatchEvent(
  row: EventRow,
  opts: { contexto?: ContextoDoDreno } = {},
): Promise<HandlerResult[]> {
  const contexto = opts.contexto ?? "worker";
  const matches = _handlers.filter(
    (h) => h.events.includes(row.event_type) && !row.consumed_by.includes(h.key),
  );
  if (!matches.length) return [];

  const results: HandlerResult[] = [];
  for (const handler of matches) {
    if (contexto === "requisicao" && handler.foraDaRequisicao) {
      // Não chama: devolve o evento à fila para o worker (ver `foraDaRequisicao`).
      results.push({
        consumer_key: handler.key,
        status: "retry",
        retry_at: new Date().toISOString(),
        detail: ADIADO_PARA_O_WORKER,
      });
      continue;
    }
    try {
      const r = await handler.handle(row);
      results.push(r);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[event-log.dispatcher] handler threw", {
        handler: handler.key,
        event: row.event_type,
        event_id: row.id,
        error: detail,
      });
      results.push({ consumer_key: handler.key, status: "error", detail });
    }
  }
  return results;
}
