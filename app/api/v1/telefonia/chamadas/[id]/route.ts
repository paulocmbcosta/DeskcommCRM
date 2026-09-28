/**
 * GET /api/v1/telefonia/chamadas/[id] — o estado de uma ligação de telefone e
 * quem está do outro lado (agent+, da própria organização).
 *
 * É o que o painel do telefone pergunta enquanto a ligação acontece: o ramal
 * do navegador é atendido pelo Asterisk na hora (para o atendente ouvir o
 * chamar da operadora), então "chamando" e "atendeu" só se sabem por aqui.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_chamadas" });
  if (!authz.ok) return authz.response;
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", "Ligação não encontrada.", 404, { requestId });

  const { rows } = await getRequestPool().query<{
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
  }>(
    `select v.id, v.status, v.direction, v.peer_phone, v.answered_at, v.ended_at, v.end_reason,
            v.conversation_id, v.contact_id, coalesce(c.display_name, c.name) as contact_name
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
      where v.id = $1 and v.organization_id = $2`,
    [id.data, authz.org.orgId],
  );
  if (!rows[0]) return fail("not_found", "Ligação não encontrada.", 404, { requestId });
  return ok(rows[0], { requestId });
}
