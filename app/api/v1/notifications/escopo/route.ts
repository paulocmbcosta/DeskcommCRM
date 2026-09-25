import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH — de quais conversas ESTA pessoa recebe aviso de mensagem
 * (`user_organizations.message_alert_scope`, migration 0281).
 *
 * Cada um escolhe o próprio: a função do banco usa `auth.uid()` como único
 * seletor de linha, e por isso a chamada vai com o client da SESSÃO — nunca o
 * de service role, que não tem `auth.uid()` e não gravaria nada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ESCOPOS_DE_AVISO, escopoEfetivo } from "@/lib/notifications/escopo-de-aviso";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** `null` devolve a pessoa ao padrão do papel. */
const corpoSchema = z.object({ escopo: z.enum(ESCOPOS_DE_AVISO).nullable() }).strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "notification_scope" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { user, org } = authz;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "fn_definir_escopo_de_aviso" as never,
    { p_org: org.orgId, p_scope: parsed.data.escopo } as never,
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (Number(data) !== 1) {
    return fail("not_found", t("Vínculo com a organização não encontrado."), 404, { requestId });
  }

  void audit({
    action: "notification_prefs.changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "user_organization",
    requestId,
    metadata: { message_alert_scope: parsed.data.escopo },
  });

  return ok(
    { escopo: escopoEfetivo(org.role, parsed.data.escopo), gravado: parsed.data.escopo },
    { requestId },
  );
}
