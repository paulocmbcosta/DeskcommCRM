/**
 * POST /api/v1/telefonia/chamadas/[id]/mover — manda para a fila de OUTRO time
 * uma ligação que espera na fila do telefone (manager+; aba Telefone, entrega 3;
 * migration 0296).
 *
 * Corpo: `{ team_id }`, e mais nada — é `.strict()`, e um `organization_id` nele
 * é 422. A organização e quem pede vêm da sessão.
 *
 * Não move nada sozinha, como a transferência: confere (`pedirMover` — a ligação
 * recebida desta organização, viva, ainda não atendida e já na fila; o time
 * desta organização, ativo, diferente do atual e dentro do horário), grava o
 * PEDIDO (a linha `open` de `voice_call_queue_orders`) e emite a ORDEM para o
 * worker como evento de usuário da ARI. O worker relê a linha do banco, revalida
 * e troca a fila; o desfecho volta pela mesma linha, que a tela lê em
 * `GET /telefonia/fila/ordens/[id]`. Responde 202: aceito, ainda não feito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { EVENTO_DA_FILA } from "@/lib/channels/telefonia/ordens-da-fila";
import {
  fraseDaRecusaDaFila,
  pedirMover,
  recusarOrdemSemWorker,
  statusDaRecusaDaFila,
} from "@/lib/channels/telefonia/pedido-da-fila";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pedidoSchema = z.object({ team_id: z.string().uuid() }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cfg = configAriDoAmbiente();
  if (!cfg) return fail("telefonia_indisponivel", t("Esta instalação não tem telefonia ligada."), 409, { requestId });
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Ligação não encontrada."), 404, { requestId });
  const vcId = id.data;
  const corpo = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", t("Escolha para qual time mover."), 422, { requestId });

  const pool = getRequestPool();
  const r = await pedirMover(pool, {
    org: authz.org.orgId,
    userId: authz.user.id,
    vcId,
    teamId: corpo.data.team_id,
    agora: new Date(),
  });
  if (!r.ok) return fail(r.motivo, fraseDaRecusaDaFila(r, t), statusDaRecusaDaFila(r.motivo), { requestId });

  try {
    await new ClienteAri(cfg).emitirEvento(EVENTO_DA_FILA, { acao: "mover", ordem_id: r.id, voice_call_id: vcId });
  } catch (e) {
    logger.warn("[telefonia] ordem de mover da fila não entregue ao worker", {
      request_id: requestId,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    // A linha aberta travaria a próxima tentativa — de qualquer pessoa — nesta ligação (uma aberta por ligação).
    await recusarOrdemSemWorker(pool, authz.org.orgId, r.id).catch(() => undefined);
    return fail("telefonia_indisponivel", t("A telefonia não respondeu. Tente de novo em instantes."), 503, { requestId });
  }

  void audit({
    action: "phone.queue_call_moved",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "voice_call",
    resourceId: vcId,
    metadata: { ordem_id: r.id, de_time_id: r.deTimeId, para_time_id: corpo.data.team_id },
    requestId,
  });
  return ok({ ordem_id: r.id }, { requestId, status: 202 });
}
