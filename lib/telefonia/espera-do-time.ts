/**
 * A ESPERA MÁXIMA NA FILA DO TELEFONE, por time (migration 0295) — ler e gravar
 * `attendance_teams.phone_queue_max_wait_seconds`. Server-only. A tabela só tem
 * GRANT de leitura para `authenticated`: quem grava é a rota, pela conexão do
 * app, com a organização DA SESSÃO em toda consulta.
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { ESPERA_NA_FILA_MAX_S, ESPERA_NA_FILA_MIN_S, esperaMaximaMs } from "./distribuicao";

export const esperaDoTimeSchema = z
  .object({
    /** Segundos; `null` volta ao padrão. */
    espera_maxima_s: z.number().int().min(ESPERA_NA_FILA_MIN_S).max(ESPERA_NA_FILA_MAX_S).nullable(),
  })
  .strict();

export interface EsperaDoTime {
  team_id: string;
  /** O que está gravado; `null` = o padrão. */
  espera_maxima_s: number | null;
  /** O que VALE (o gravado, ou o padrão). */
  em_vigor_s: number;
}

/** O que `GET /api/v1/telefonia/fila/times` devolve. */
export interface EsperaDosTimesNaResposta {
  /** A instalação tem telefonia: sem ela o seletor nem aparece. */
  oferecida: boolean;
  times: EsperaDoTime[];
}

const paraATela = (r: { id: string; espera: number | null }): EsperaDoTime => ({
  team_id: r.id,
  espera_maxima_s: r.espera,
  em_vigor_s: esperaMaximaMs(r.espera) / 1000,
});

/** Os times ATIVOS da organização, com a espera de cada um. */
export async function lerEsperaDosTimes(db: Queryable, organizationId: string): Promise<EsperaDoTime[]> {
  const { rows } = await db.query<{ id: string; espera: number | null }>(
    `select id, phone_queue_max_wait_seconds as espera
       from attendance_teams
      where organization_id = $1 and archived_at is null
      order by name asc`,
    [organizationId],
  );
  return rows.map(paraATela);
}

export type ResultadoDaEspera =
  | { ok: true; time: EsperaDoTime; anterior: number | null }
  | { ok: false; motivo: "nao_encontrado" | "time_arquivado" };

/** Grava a espera do time DESTA organização. Time de outra organização: `nao_encontrado`. */
export async function gravarEsperaDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  segundos: number | null,
): Promise<ResultadoDaEspera> {
  // Uma instrução só: o `antes` trava a linha (duas gravações do mesmo time não
  // leem o mesmo "anterior") e o `gravado` só alcança o que o `antes` achou — o
  // time desta organização, e não arquivado.
  const { rows } = await db.query<{ id: string; espera: number | null; anterior: number | null; arquivado: boolean }>(
    `with antes as (
       select id, phone_queue_max_wait_seconds as anterior, archived_at is not null as arquivado
         from attendance_teams
        where id = $1 and organization_id = $2
        for no key update
     ), gravado as (
       update attendance_teams t
          set phone_queue_max_wait_seconds = $3, updated_at = now()
         from antes
        where t.id = antes.id and t.organization_id = $2 and not antes.arquivado
       returning t.id, t.phone_queue_max_wait_seconds as espera
     )
     select antes.id, gravado.espera, antes.anterior, antes.arquivado
       from antes left join gravado on gravado.id = antes.id`,
    [teamId, organizationId, segundos],
  );
  const r = rows[0];
  if (!r) return { ok: false, motivo: "nao_encontrado" };
  if (r.arquivado) return { ok: false, motivo: "time_arquivado" };
  return { ok: true, time: paraATela({ id: r.id, espera: r.espera }), anterior: r.anterior };
}
