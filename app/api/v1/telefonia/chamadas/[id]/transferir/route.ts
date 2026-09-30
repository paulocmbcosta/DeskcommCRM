/**
 * POST /api/v1/telefonia/chamadas/[id]/transferir — transfere a ligação em curso
 * (agent+; o dono atual da ligação, ou gerente/admin). Desenho da fase 2, §12.4.
 *
 * Corpo: `{ modo: 'direta' | 'consultada', para: { user_id } | { team_id } }`.
 *
 * Não transfere nada sozinha: confere (`pedirTransferencia` — ligação, permissão,
 * destino pela régua de D17, time no horário), grava o PEDIDO (a linha `open`
 * de `voice_call_transfers`) e emite a ORDEM para o worker como evento de
 * usuário da ARI. O worker relê a linha do banco, revalida contra o estado dele
 * e age; o desfecho volta pela mesma linha, que o painel lê em
 * `GET /telefonia/chamadas/[id]`. Responde 202: aceito, ainda não feito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { ramaisOnline } from "@/lib/channels/telefonia/diretorio";
import {
  MENSAGEM_DA_RECUSA_DO_PEDIDO,
  pedirTransferencia,
  recusarPedidoSemWorker,
  statusDaRecusa,
} from "@/lib/channels/telefonia/pedido-de-transferencia";
import { EVENTO_DA_TRANSFERENCIA } from "@/lib/channels/telefonia/transferencia";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pedidoSchema = z
  .object({
    modo: z.enum(["direta", "consultada"]),
    para: z.union([
      z.object({ user_id: z.string().uuid() }).strict(),
      z.object({ team_id: z.string().uuid() }).strict(),
    ]),
  })
  .strict();

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
  const vcId = id.data;
  const corpo = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", t("Escolha para quem transferir."), 422, { requestId });

  const ari = new ClienteAri(cfg);
  const pool = getRequestPool();
  const r = await pedirTransferencia(pool, {
    org: authz.org.orgId,
    userId: authz.user.id,
    papel: authz.org.role,
    vcId: vcId,
    modo: corpo.data.modo,
    para: corpo.data.para,
    agora: new Date(),
    online: await ramaisOnline(ari),
  });
  if (!r.ok) {
    return fail(r.motivo, t(MENSAGEM_DA_RECUSA_DO_PEDIDO[r.motivo]), statusDaRecusa(r.motivo), { requestId });
  }

  try {
    await ari.emitirEvento(EVENTO_DA_TRANSFERENCIA, {
      acao: "transferir",
      transferencia_id: r.id,
      voice_call_id: vcId,
    });
  } catch (e) {
    logger.warn("[telefonia] ordem de transferência não entregue ao worker", {
      request_id: requestId,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    // A linha aberta travaria a próxima tentativa (uma aberta por ligação).
    await recusarPedidoSemWorker(pool, authz.org.orgId, r.id).catch(() => undefined);
    return fail("telefonia_indisponivel", t("A telefonia não respondeu. Tente de novo em instantes."), 503, { requestId });
  }

  void audit({
    action: "phone.call_transferred",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "voice_call",
    resourceId: vcId,
    metadata: { transferencia_id: r.id, modo: corpo.data.modo, para: corpo.data.para, de: r.fromUserId },
    requestId,
  });
  return ok({ id: r.id, tipo: r.kind }, { requestId, status: 202 });
}
