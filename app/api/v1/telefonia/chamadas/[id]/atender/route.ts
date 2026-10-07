/**
 * POST /api/v1/telefonia/chamadas/[id]/atender — quem pede puxa para o PRÓPRIO
 * ramal uma ligação que espera na fila do telefone (agent+; aba Telefone,
 * entrega 3; migration 0296). Não tem corpo: a ligação vem do caminho, e a
 * organização e a pessoa, da sessão.
 *
 * Não atende nada sozinha, como a transferência: confere (`pedirAtender` — a
 * ligação recebida desta organização, viva, ainda não atendida e já na fila; o
 * ramal de quem pede registrado; a pessoa fora de outra ligação), grava o PEDIDO
 * (a linha `open` de `voice_call_queue_orders`) e emite a ORDEM para o worker
 * como evento de usuário da ARI. O worker relê a linha do banco, revalida contra
 * o estado dele e toca só o ramal de quem pediu; o desfecho volta pela mesma
 * linha, que a tela lê em `GET /telefonia/fila/ordens/[id]`. Responde 202:
 * aceito, ainda não feito.
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
import { EVENTO_DA_FILA } from "@/lib/channels/telefonia/ordens-da-fila";
import {
  fraseDaRecusaDaFila,
  pedirAtender,
  recusarOrdemSemWorker,
  statusDaRecusaDaFila,
} from "@/lib/channels/telefonia/pedido-da-fila";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cfg = configAriDoAmbiente();
  if (!cfg) return fail("telefonia_indisponivel", t("Esta instalação não tem telefonia ligada."), 409, { requestId });
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Ligação não encontrada."), 404, { requestId });
  const vcId = id.data;

  const ari = new ClienteAri(cfg);
  const pool = getRequestPool();
  const r = await pedirAtender(pool, {
    org: authz.org.orgId,
    userId: authz.user.id,
    vcId,
    online: await ramaisOnline(ari),
  });
  if (!r.ok) return fail(r.motivo, fraseDaRecusaDaFila(r, t), statusDaRecusaDaFila(r.motivo), { requestId });

  try {
    await ari.emitirEvento(EVENTO_DA_FILA, { acao: "atender", ordem_id: r.id, voice_call_id: vcId });
  } catch (e) {
    logger.warn("[telefonia] ordem de atender da fila não entregue ao worker", {
      request_id: requestId,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    // A linha aberta travaria a próxima tentativa — de qualquer pessoa — nesta ligação (uma aberta por ligação).
    await recusarOrdemSemWorker(pool, authz.org.orgId, r.id).catch(() => undefined);
    return fail("telefonia_indisponivel", t("A telefonia não respondeu. Tente de novo em instantes."), 503, { requestId });
  }

  void audit({
    action: "phone.queue_call_pulled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "voice_call",
    resourceId: vcId,
    metadata: { ordem_id: r.id, time_id: r.timeId },
    requestId,
  });
  return ok({ ordem_id: r.id }, { requestId, status: 202 });
}
