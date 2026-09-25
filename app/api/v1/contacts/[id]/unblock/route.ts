import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/[id]/unblock — desfaz o bloqueio de opt-out.
 *
 * Body: `{ motivo: string }` (10..500). Regra, corrida e auditoria em
 * `lib/contacts/desbloquear.ts`; aqui só autorização, validação e ok/fail.
 *
 * **manager+**, e não `agent` como o PATCH do contato: desbloquear é decidir
 * voltar a escrever para quem, pelo que o sistema leu, pediu para sair (LGPD) —
 * decisão de quem responde pela operação, não gesto de atendimento.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { desbloquearContato, desbloquearContatoSchema } from "@/lib/contacts/desbloquear";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!UUID.test(id)) {
    return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  }

  const parsed = desbloquearContatoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // A frase do Zod só serve quando é NOSSA (tamanho do motivo); corpo ausente
    // ou tipo errado daria a mensagem crua da biblioteca, em inglês.
    const doMotivo = parsed.error.issues.find(
      (i) => i.path[0] === "motivo" && (i.code === "too_small" || i.code === "too_big"),
    );
    return fail(
      "validation_failed",
      doMotivo ? t(doMotivo.message) : t("Explique o motivo do desbloqueio."),
      400,
      { requestId, details: { issues: parsed.error.issues } },
    );
  }

  try {
    const resultado = await desbloquearContato(
      createAdminClient(),
      { organizationId: authz.org.orgId, actorUserId: authz.user.id, requestId },
      id,
      parsed.data,
    );
    return ok(resultado, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, t(err.message), err.status, { requestId });
    }
    throw err;
  }
}
