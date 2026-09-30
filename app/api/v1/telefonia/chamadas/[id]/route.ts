/**
 * GET /api/v1/telefonia/chamadas/[id] — o estado de uma ligação de telefone e
 * quem está do outro lado (agent+, da própria organização).
 *
 * É o que o painel do telefone pergunta enquanto a ligação acontece: o ramal
 * do navegador é atendido pelo Asterisk na hora (para o atendente ouvir o
 * chamar da operadora), então "chamando" e "atendeu" só se sabem por aqui.
 *
 * Na v2, também a transferência: a aberta (com a fase da consulta, lida da
 * ponte `k-` na ARI), quem a transferiu para mim e a última que fechou comigo —
 * é daí que o painel diz "Transferindo para Bruno…", "Transferida por Ana" e
 * "Bruno não atendeu, o cliente voltou". Na v3, o colega da ligação interna.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { ponteDeConsulta } from "@/lib/channels/telefonia/transferencia";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_chamadas" });
  if (!authz.ok) return authz.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", "Ligação não encontrada.", 404, { requestId });

  const pool = getRequestPool();
  const { rows } = await pool.query<{
    id: string;
    status: string;
    direction: string;
    peer_phone: string;
    answered_at: string | null;
    ended_at: string | null;
    end_reason: string | null;
    conversation_id: string | null;
    contact_id: string | null;
    contact_name: string | null;
    owner_user_id: string | null;
    peer_user_id: string | null;
    peer_user_name: string | null;
    owner_name: string | null;
  }>(
    `select v.id, v.status, v.direction, v.peer_phone, v.answered_at, v.ended_at, v.end_reason,
            v.conversation_id, v.contact_id, coalesce(c.display_name, c.name) as contact_name,
            v.owner_user_id, v.peer_user_id,
            (select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = v.peer_user_id) as peer_user_name,
            (select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = v.owner_user_id) as owner_name
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
      where v.id = $1 and v.organization_id = $2`,
    [id.data, authz.org.orgId],
  );
  const l = rows[0];
  if (!l) return fail("not_found", "Ligação não encontrada.", 404, { requestId });

  // A transferência (v2): a aberta, a que trouxe a ligação a MIM, e a última
  // que fechou envolvendo a mim — o painel diz o que está acontecendo a partir delas.
  const { rows: transferencias } = await pool.query<{
    id: string;
    kind: "blind" | "attended";
    status: "open" | "ended";
    outcome: string | null;
    reason: string | null;
    from_user_id: string | null;
    to_user_id: string | null;
    answered_by: string | null;
    de_nome: string | null;
    para_nome: string | null;
    para_time: string | null;
    ended_at: string | null;
  }>(
    `select t.id, t.kind, t.status, t.outcome, t.reason, t.from_user_id, t.to_user_id, t.answered_by, t.ended_at,
            (select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = t.from_user_id) as de_nome,
            (select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = t.to_user_id) as para_nome,
            (select tm.name from attendance_teams tm where tm.id = t.to_team_id and tm.organization_id = t.organization_id) as para_time
       from voice_call_transfers t
      where t.organization_id = $1 and t.voice_call_id = $2
      order by t.created_at desc
      limit 20`,
    [authz.org.orgId, id.data],
  );
  const eu = authz.user.id;
  const aberta = transferencias.find((t) => t.status === "open") ?? null;
  // Consultada: o colega já atendeu? A ponte de consulta com duas pontas diz que sim.
  let consulta: "tocando" | "falando" | null = null;
  if (aberta?.kind === "attended") {
    consulta = "tocando";
    const cfg = configAriDoAmbiente();
    if (cfg) {
      try {
        const ponte = await new ClienteAri(cfg).pedir<{ channels?: string[] }>("GET", `/bridges/${ponteDeConsulta(id.data)}`);
        if ((ponte.channels ?? []).length >= 2) consulta = "falando";
      } catch {
        /* sem a ponte: ainda tocando (ou já acabou — a próxima leitura diz) */
      }
    }
  }
  const trouxe = transferencias.find(
    (t) => t.answered_by === eu && (t.outcome === "answered" || t.outcome === "queue_answered"),
  );
  const ultima = transferencias.find((t) => t.status === "ended" && (t.from_user_id === eu || t.answered_by === eu));

  return ok(
    {
      ...l,
      transferencia: aberta
        ? {
            id: aberta.id,
            tipo: aberta.kind,
            de_user_id: aberta.from_user_id,
            para_nome: aberta.para_nome,
            para_time: aberta.para_time,
            consulta,
          }
        : null,
      transferida_por: trouxe ? { de_nome: trouxe.de_nome } : null,
      ultima_transferencia: ultima
        ? {
            id: ultima.id,
            tipo: ultima.kind,
            desfecho: ultima.outcome,
            motivo: ultima.reason,
            de_nome: ultima.de_nome,
            para_nome: ultima.para_nome,
            para_time: ultima.para_time,
            fui_eu: ultima.from_user_id === eu,
            fechada_em: ultima.ended_at,
          }
        : null,
    },
    { requestId },
  );
}
