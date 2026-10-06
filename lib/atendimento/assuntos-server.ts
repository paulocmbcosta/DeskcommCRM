/**
 * Os ASSUNTOS de uma lista de atendimentos, com o nome do setor (migration 0293).
 *
 * `atendimentos` guarda só `assunto_id` (DIRC: referência). Quem lista
 * atendimentos — histórico do contato, aba Fechadas, busca por protocolo —
 * resolve os nomes AQUI, em duas consultas pequenas, em vez de um embed
 * aninhado: a relação assunto → time é por FK composta, e um embed que o
 * PostgREST deixasse de resolver derrubaria a lista inteira por causa de um
 * rótulo.
 *
 * Falha de leitura devolve mapa VAZIO, com log: o atendimento continua na
 * lista, sem o rótulo do assunto. Perder a lista por causa do rótulo seria
 * pior que perder o rótulo.
 *
 * Client de quem chama — o do usuário nas rotas, e a RLS de tenant das duas
 * tabelas vale. O filtro de organização é explícito mesmo assim (doutrina).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssuntoDoAtendimento } from "@/lib/atendimento/encerramento";
import { logger } from "@/lib/logger";

export async function carregarAssuntos(
  db: SupabaseClient,
  organizationId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, AssuntoDoAtendimento>> {
  const unicos = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
  const mapa = new Map<string, AssuntoDoAtendimento>();
  if (unicos.length === 0) return mapa;

  const { data: assuntos, error } = await db
    .from("atendimento_assuntos")
    .select("id, name, team_id")
    .eq("organization_id", organizationId)
    .in("id", unicos);
  if (error) {
    logger.warn("[assuntos] leitura dos assuntos falhou", { organization_id: organizationId, code: error.code });
    return mapa;
  }
  const linhas = (assuntos ?? []) as { id: string; name: string; team_id: string }[];

  const timeIds = [...new Set(linhas.map((a) => a.team_id))];
  const nomeDoTime = new Map<string, string>();
  if (timeIds.length > 0) {
    const { data: times, error: erroDosTimes } = await db
      .from("attendance_teams")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", timeIds);
    if (erroDosTimes) {
      logger.warn("[assuntos] leitura dos times falhou", { organization_id: organizationId, code: erroDosTimes.code });
    }
    for (const time of (times ?? []) as { id: string; name: string }[]) nomeDoTime.set(time.id, time.name);
  }

  for (const a of linhas) mapa.set(a.id, { id: a.id, nome: a.name, time: nomeDoTime.get(a.team_id) ?? null });
  return mapa;
}
