/**
 * `POST /api/v1/settings/teams/[id]/archive` — arquiva ou desarquiva um time.
 *
 * Arquivar, e não apagar: um time some das listas de destino mas continua
 * nomeando as conversas que passaram por ele. Apagar apagaria o histórico
 * junto (a FK de `conversations.team_id` é `on delete set null`), e um relatório
 * que perde o setor não avisa que perdeu.
 *
 * Portões na ordem do molde (`settings/routing/channels/route.ts`). O id vem do
 * PATH — que é fonte confiável — e a org, da sessão; o corpo carrega SÓ a
 * direção do gesto.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** `arquivar: false` é o desarquivar — a mesma rota nos dois sentidos. */
const corpoSchema = z.object({ arquivar: z.boolean() }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const { id } = await ctx.params;
  // Um id que não é uuid não chega ao banco: o Postgres devolveria `22P02`
  // (invalid input syntax), que virava 500 — erro de sistema para o que é,
  // na verdade, uma URL inválida.
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", "Time inválido.", 400, { requestId });

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe se o time deve ser arquivado.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db.rpc("fn_archive_attendance_team", {
    p_org: auth.org.orgId,          // fonte confiável — NUNCA o body
    p_team: id,
    p_arquivar: parsed.data.arquivar,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Time não encontrado.", 404, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar os times.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({ action: "routing.team_archived", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "attendance_team", resourceId: id, requestId,
    metadata: { arquivar: parsed.data.arquivar } });
  return ok(data, { requestId });
}
