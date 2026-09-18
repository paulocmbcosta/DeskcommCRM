/**
 * Carregador ÚNICO dos times de uma organização.
 *
 * Um só, e não um por consumidor: a tela de Times, a tool `crm_list_teams` e o
 * filtro do inbox fazem a mesma pergunta, e três leituras divergentes do mesmo
 * fato é como se produz uma tela que discorda do que o agente vê.
 *
 * `aberto_agora` sai da MESMA `isWithinSchedule` do roteamento — se a tela
 * dissesse "aberto" com o roteador achando "fechado", o usuário não teria como
 * descobrir qual das duas mente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isWithinSchedule } from "@/lib/routing/eligibility";

import { lerAgenda } from "./agenda";

export interface TimeDoCatalogo {
  id: string;
  name: string;
  slug: string;
  description: string;
  schedule: unknown;
  archived_at: string | null;
  /** Teto de conversas simultâneas por atendente neste time (0267). `null` = sem teto. */
  max_concurrent: number | null;
  aberto_agora: boolean;
  /** A agenda gravada não é legível pelo parser ⇒ o time conta como FECHADO. */
  horario_invalido: boolean;
  user_ids: string[];
}

export async function carregarTimes(
  db: SupabaseClient,
  organizationId: string,
  now: Date,
  opts: { incluirArquivados?: boolean } = {},
): Promise<TimeDoCatalogo[]> {
  let consulta = db.from("attendance_teams")
    .select("id, name, slug, description, schedule, archived_at, max_concurrent")
    .eq("organization_id", organizationId)
    .order("name");
  if (!opts.incluirArquivados) consulta = consulta.is("archived_at", null);
  const { data: times, error } = await consulta;
  if (error) throw new Error(error.message);

  const { data: membros, error: erroMembros } = await db.from("attendance_team_members")
    .select("team_id, user_id").eq("organization_id", organizationId);
  if (erroMembros) throw new Error(erroMembros.message);

  const porTime = new Map<string, string[]>();
  for (const m of (membros ?? []) as Array<{ team_id: string; user_id: string }>) {
    porTime.set(m.team_id, [...(porTime.get(m.team_id) ?? []), m.user_id]);
  }

  return ((times ?? []) as Array<Omit<TimeDoCatalogo, "aberto_agora" | "user_ids" | "horario_invalido">>).map((t) => {
    const { agenda, valida } = lerAgenda(t.schedule);
    return {
      ...t,
      // Agenda ilegível = FECHADO, nunca 24/7: a tela mostra o aviso e o gestor
      // conserta. "Aberto" sob um horário que ninguém lê é mentira sem sintoma.
      aberto_agora: valida && isWithinSchedule(agenda, now),
      horario_invalido: !valida,
      user_ids: porTime.get(t.id) ?? [],
    };
  });
}
