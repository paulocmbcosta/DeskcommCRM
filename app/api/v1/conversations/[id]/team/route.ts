/**
 * `POST /api/v1/conversations/[id]/team` — encaminha a conversa para um TIME,
 * ou a tira de todos eles (`team_id: null`, que é valor, não ausência).
 *
 * Molde: `../transfer/route.ts`, que é a transferência para uma PESSOA. As duas
 * são o mesmo gesto com destinos de natureza diferente, e por isso os portões
 * são os mesmos: `requireSupportWrite`, papel `agent` (escrita é agent+; viewer
 * é read-only, spec 13 §4) e a org resolvida do cookie validado.
 *
 * ⚠️ QUEM MUDA A LINHA É A RPC, NUNCA UM `update` DAQUI.
 * `fn_conversation_set_team` (migration 0263) faz três coisas numa transação só:
 * grava o time, SOLTA o dono atual e pede o roteamento. Um `update` aqui gravaria
 * o time e deixaria a conversa com um dono que não é mais quem vai atender — e
 * sem evento em `conversation_assignment_events`, que é onde "por que esta
 * conversa foi parar no financeiro?" tem resposta.
 *
 * E ela prova os portões de novo no BANCO (`fn_role_at_least`,
 * `fn_support_write_allowed`, `auth.uid()`): os daqui são a primeira barreira, e
 * é por isso que o client tem de ser o do USUÁRIO — com o admin client, `auth.uid()`
 * seria nulo dentro da função e ela recusaria tudo com `42501`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { conversationTeamSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), NUNCA o body

  const { id } = await ctx.params;
  // Um id que não é uuid não chega ao banco: o Postgres devolveria `22P02`
  // (invalid input syntax), que viraria 500 — erro de sistema para o que é, na
  // verdade, uma URL inválida.
  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Conversa inválida."), 400, { requestId });
  }

  const parsed = conversationTeamSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // `.strict()`: um `organization_id` no corpo cai aqui, com 422, em vez de
    // ser ignorado em silêncio. A org sai da sessão e de nenhum outro lugar.
    return fail("validation_failed", t("Informe o time de destino."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const db = await createClient();
  const { data, error } = await db.rpc("fn_conversation_set_team", {
    p_org: orgId,
    p_conversation: id,
    p_team: parsed.data.team_id,
  });

  if (error) {
    // `P0002` cobre os DOIS "não encontrei" da RPC — o time e a conversa — e os
    // dois são 404 pela mesma razão: quem pede um recurso de outra organização
    // recebe a resposta de quem pede um recurso que não existe.
    if (error.code === "P0002") {
      return fail("not_found", t("Conversa ou time não encontrado."), 404, { requestId });
    }
    if (error.code === "42501") {
      return fail("forbidden", t("Esta sessão não pode mudar o time da conversa."), 403, { requestId });
    }
    // A mensagem crua do Postgres não sai daqui: ela nomeia função, coluna e
    // constraint para quem só perguntou por uma conversa.
    return fail("internal_error", t("Não foi possível transferir. Tente novamente."), 500, { requestId });
  }

  await audit({
    action: "routing.team_changed",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    // `null` é o destino "fila geral" e entra no rastro como tal: sem ele, tirar
    // uma conversa de um time seria indistinguível de nunca ter tido um.
    metadata: { team_id: parsed.data.team_id },
  });

  return ok(data, { requestId });
}
