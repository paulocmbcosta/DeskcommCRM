/**
 * POST /api/v1/telefonia/chamadas/[id]/transferencia — completa a consulta ou
 * volta ao cliente (agent+; quem transferiu, ou gerente/admin). Desenho da fase
 * 2, §12.4. Corpo: `{ acao: 'completar' | 'voltar' }`.
 *
 * Como `transferir`: confere contra o banco (há uma consultada aberta nesta
 * ligação, e quem pede pode) e emite a ORDEM ao worker, que confere a FASE
 * (completar só com o colega na linha) e age. Responde 202.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { MENSAGEM_DA_RECUSA_DO_PEDIDO, consultaAberta, statusDaRecusa } from "@/lib/channels/telefonia/pedido-de-transferencia";
import { EVENTO_DA_TRANSFERENCIA } from "@/lib/channels/telefonia/transferencia";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ordemSchema = z.object({ acao: z.enum(["completar", "voltar"]) }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_transferencia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cfg = configAriDoAmbiente();
  if (!cfg) return fail("telefonia_indisponivel", t("Esta instalação não tem telefonia ligada."), 409, { requestId });
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Ligação não encontrada."), 404, { requestId });
  const corpo = ordemSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", t("Ação inválida."), 422, { requestId });

  const r = await consultaAberta(getRequestPool(), {
    org: authz.org.orgId,
    userId: authz.user.id,
    papel: authz.org.role,
    vcId: id.data,
  });
  if (!r.ok) return fail(r.motivo, t(MENSAGEM_DA_RECUSA_DO_PEDIDO[r.motivo]), statusDaRecusa(r.motivo), { requestId });

  try {
    await new ClienteAri(cfg).emitirEvento(EVENTO_DA_TRANSFERENCIA, {
      acao: corpo.data.acao,
      transferencia_id: r.id,
      voice_call_id: id.data,
    });
  } catch (e) {
    logger.warn("[telefonia] ordem da consulta não entregue ao worker", {
      request_id: requestId,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    return fail("telefonia_indisponivel", t("A telefonia não respondeu. Tente de novo em instantes."), 503, { requestId });
  }

  void audit({
    action: "phone.call_transferred",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "voice_call",
    resourceId: id.data,
    metadata: { transferencia_id: r.id, acao: corpo.data.acao },
    requestId,
  });
  return ok({ id: r.id, acao: corpo.data.acao }, { requestId, status: 202 });
}
