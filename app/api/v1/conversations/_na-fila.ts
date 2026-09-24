/**
 * NA FILA DO TIME, no banco — o espelho de `estaNaFilaDoTime` (`lib/inbox/espera.ts`).
 *
 * A lista (`_handler.ts`) e a contagem do chip (`counts/route.ts`) aplicam ESTA
 * função, e não cada uma o seu predicado: badge que conta o que a lista não
 * mostra manda o atendente procurar trabalho que não existe
 * (`tests/unit/badge-espelha-o-filtro.test.ts`).
 *
 * Pergunta colunas, não o campo calculado `comando_da_conversa`: ela entra numa
 * contagem POR TIME, e o campo calculado lê `contacts` duas vezes por linha
 * (incidente de 2026-09-24, migration 0278). Transferência para time (0279) e
 * handoff da IA gravam `bot_silenced_until`, então os caminhos reais caem aqui.
 */
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";

/** O mínimo do builder do PostgREST que este módulo usa. */
export interface ConsultaDaFila {
  not(coluna: string, operador: string, valor: unknown): this;
  is(coluna: string, valor: null): this;
  gt(coluna: string, valor: string): this;
}

export function aplicarNaFilaDoTime<Q extends ConsultaDaFila>(query: Q, agora: Date): Q {
  return query
    .not("team_id", "is", null)
    .is("assigned_to_user_id", null)
    .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`)
    .gt("bot_silenced_until", agora.toISOString());
}
