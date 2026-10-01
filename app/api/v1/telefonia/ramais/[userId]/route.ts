/**
 * PATCH /api/v1/telefonia/ramais/[userId] — o admin troca o número do ramal de
 * alguém (D11, D22). Corpo: `{ numero }` — 2 a 4 dígitos, sem começar por 0.
 * Número de outra pessoa da organização: 409 `ramal_em_uso`. Quem não tem papel
 * de atendimento não tem ramal: 404. Audita `phone.extension_changed`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { REGUA_DO_RAMAL, trocarRamal } from "@/lib/channels/telefonia/interna";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const corpoSchema = z.object({ numero: z.string().trim().regex(REGUA_DO_RAMAL) }).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_ramais" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const userId = z.string().uuid().safeParse((await ctx.params).userId);
  if (!userId.success) return fail("not_found", t("Essa pessoa não tem ramal nesta organização."), 404, { requestId });
  const alvoId = userId.data;
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("O ramal tem de 2 a 4 dígitos e não começa por 0."), 422, { requestId });
  }

  const r = await trocarRamal(getRequestPool(), {
    organizationId: authz.org.orgId,
    userId: alvoId,
    numero: corpo.data.numero,
    por: authz.user.id,
  });
  if (!r.ok) {
    return r.motivo === "ramal_em_uso"
      ? fail("ramal_em_uso", t("Esse ramal já é de outra pessoa."), 409, { requestId })
      : fail("not_found", t("Essa pessoa não tem ramal nesta organização."), 404, { requestId });
  }
  if (r.antes !== corpo.data.numero) {
    void audit({
      action: "phone.extension_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "phone_extension",
      resourceId: alvoId,
      metadata: { antes: r.antes, depois: corpo.data.numero },
      requestId,
    });
  }
  return ok({ user_id: alvoId, numero: corpo.data.numero }, { requestId });
}
