/**
 * POST /api/v1/conversations/:id/manter-espera — "Contar mesmo assim".
 *
 * A Assistente dispensou a espera (a fala do cliente não pedia resposta) e a
 * pessoa discorda. Devolve o `espera_desde` ORIGINAL e trava a Assistente até
 * o ciclo de espera terminar (`espera_mantida_em`, migration 0285). É o único
 * gesto humano sobre a espera: ninguém DISPENSA na mão (decisão D do plano
 * 2026-09-26). Cada chamada é um erro medido da Assistente.
 *
 * Auth: cookie session, agent+. Leitura e escrita pelo client do REQUEST: a
 * policy de `conversations` aplica o escopo de visibilidade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { EVENTO_ESPERA_MANTIDA } from "@/lib/inbox/eventos-da-conversa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  // Sem isto, um id que não é uuid chega ao Postgres como `invalid input
  // syntax` e vira 500 — erro de sistema para o que é uma URL inválida. Mesma
  // régua de `../team/route.ts`.
  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Conversa inválida."), 400, { requestId });
  }

  const supabase = await createClient();
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, last_inbound_at, espera_dispensada_ate, espera_dispensada_desde")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  const c = conv as {
    last_inbound_at: string | null;
    espera_dispensada_ate: string | null;
    espera_dispensada_desde: string | null;
  };
  if (!c.espera_dispensada_ate) {
    return fail("state_conflict", t("A espera desta conversa já está sendo contada."), 409, { requestId });
  }

  const esperaDesde = c.espera_dispensada_desde ?? c.last_inbound_at;
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      espera_desde: esperaDesde,
      espera_dispensada_ate: null,
      espera_dispensada_desde: null,
      espera_mantida_em: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("espera_dispensada_ate", c.espera_dispensada_ate)
    .is("espera_desde", null)
    .select("id, espera_desde, espera_mantida_em")
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  if (!atualizada) {
    return fail(
      "state_conflict",
      t("A conversa mudou enquanto você clicava. Atualize e veja de novo."),
      409,
      { requestId },
    );
  }

  await audit({
    action: "conversation.espera_mantida",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { espera_desde: esperaDesde, dispensada_ate: c.espera_dispensada_ate },
  });

  // A linha do tempo do painel (log visível). Falha aqui não desfaz a religada.
  const { error: evErr } = await createAdminClient().rpc("fn_conversation_event_add", {
    p_org: org.orgId,
    p_conversation: id,
    p_type: EVENTO_ESPERA_MANTIDA,
    p_actor: user.id,
    p_payload: { espera_desde: esperaDesde },
  });
  if (evErr) {
    logger.warn("manter-espera: evento não gravou", {
      conversation_id: id,
      error: evErr.message.slice(0, 120),
    });
  }

  return ok({ conversation: atualizada }, { requestId });
}
