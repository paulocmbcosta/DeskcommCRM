/**
 * A RÉGUA DO FILTRO DE TIME, UMA SÓ, PARA A LISTA E PARA O BADGE.
 *
 * `GET /api/v1/conversations` e `GET /api/v1/conversations/counts` respondem a
 * mesma pergunta por caminhos diferentes — uma devolve as linhas, a outra o
 * número ao lado da aba. Quando as duas montam o predicado por conta própria,
 * elas divergem, e a divergência aparece na tela como a aba dizendo "Fila 1" com
 * cinco conversas embaixo. Já aconteceu neste inbox, com `unread`
 * (`tests/unit/badge-espelha-o-filtro.test.ts` guarda o conserto).
 *
 * Por isso o filtro nasce aqui: quem decide O QUE filtrar é `predicadoDeTime`,
 * quem aplica é `aplicarPredicadoDeTime`, e os dois consumidores chamam os dois.
 *
 * ⚠️ ISTO É FILTRO, NÃO BARREIRA. Quem enxerga o quê continua sendo a RLS de
 * `conversations` e o `visibility_mode` da organização. Um time não restringe
 * visibilidade — dizer o contrário seria afirmar uma proteção que não existe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** A fila geral: o que ninguém encaminhou para setor nenhum. */
export const FILA_GERAL = "none";
/** Os times de quem está olhando, MAIS a fila geral. */
export const MEUS_TIMES = "mine";

/**
 * O que o filtro virou, resolvido ANTES de tocar no builder da consulta.
 *
 * Separar decidir de aplicar é o que torna a decisão testável sem banco: os três
 * caminhos são medidos em `_filtro-de-time.test.ts` sem um Postgres por perto.
 */
export type PredicadoDeTime =
  | { tipo: "sem_filtro" }
  | { tipo: "sem_time" }
  | { tipo: "um_time"; id: string }
  | { tipo: "meus_times"; ids: string[] };

/** O mínimo do builder do PostgREST que este módulo usa. */
export interface ConsultaFiltravel {
  is(coluna: string, valor: null): this;
  eq(coluna: string, valor: string): this;
  or(filtro: string): this;
}

/**
 * Traduz o parâmetro em predicado, indo ao banco só quando precisa.
 *
 * `mine` é o único caso que faz leitura: os times de quem está olhando. Ela é
 * filtrada por `organization_id` explicitamente porque o chamador pode estar com
 * o client de service role (as tools MCP usam o mesmo handler), que passa por
 * cima da RLS.
 */
export async function predicadoDeTime(
  db: SupabaseClient,
  organizationId: string,
  userId: string | null,
  filtro: string | null | undefined,
): Promise<PredicadoDeTime> {
  if (!filtro) return { tipo: "sem_filtro" };
  if (filtro === FILA_GERAL) return { tipo: "sem_time" };
  if (filtro !== MEUS_TIMES) return { tipo: "um_time", id: filtro };
  // Sem pessoa não há "meus": um ator de máquina pedindo `mine` receberia a
  // fila geral em silêncio, que é uma resposta plausível e errada. Quem chama
  // recusa antes de chegar aqui — este `null` é a rede de baixo.
  if (!userId) return { tipo: "sem_time" };

  const { data } = await db
    .from("attendance_team_members")
    .select("team_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId);
  const ids = (data ?? []).map((m: { team_id: string }) => m.team_id);
  // Sem time nenhum, "meus times" é exatamente a fila geral — e não a lista
  // inteira. Cair para "sem filtro" aqui faria o mesmo pedido responder coisas
  // diferentes conforme a alocação do usuário, sem nada na tela dizendo por quê.
  return ids.length > 0 ? { tipo: "meus_times", ids } : { tipo: "sem_time" };
}

/** Aplica o predicado sobre uma consulta que JÁ filtra a organização. */
export function aplicarPredicadoDeTime<Q extends ConsultaFiltravel>(
  consulta: Q,
  predicado: PredicadoDeTime,
): Q {
  switch (predicado.tipo) {
    case "sem_filtro":
      return consulta;
    case "sem_time":
      return consulta.is("team_id", null);
    case "um_time":
      return consulta.eq("team_id", predicado.id);
    case "meus_times":
      // A fila geral entra junto de propósito: quem atende um setor continua
      // sendo quem pega o que ninguém encaminhou. Sem o `is.null`, criar o
      // primeiro time faria a fila geral sumir da tela de todo mundo.
      return consulta.or(
        `team_id.is.null,team_id.in.(${predicado.ids.join(",")})`,
      );
  }
}
