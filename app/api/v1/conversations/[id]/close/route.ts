import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/close — encerra o atendimento.
 *
 * Não bloqueia por assignee — qualquer membro com permissão (RLS) pode fechar.
 *
 * O corpo leva o REGISTRO do encerramento (migration 0293): `assunto_id` e
 * `resumo`, ambos opcionais aqui. Se são obrigatórios é decisão da organização
 * (`settings.atendimento.encerramento`), e quem aplica é o banco, dentro de
 * `fn_atendimento_encerrar` — a mesma função que o PATCH com status terminal
 * chama. Esta rota só traduz a recusa em 422 dizendo QUAL campo faltou.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { fraseDaRecusa, motivoDaRecusa } from "@/lib/atendimento/encerramento";
import { requireRole } from "@/lib/auth/require-role";
import { closeConversationSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Estados em que a conversa já está encerrada: fechar de novo não grava registro. */
const ENCERRADOS: ReadonlySet<string> = new Set(["closed", "resolved", "archived"]);

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let body: unknown = {};
  const text = await req.text();
  try { body = text ? JSON.parse(text) : {}; } catch { return fail("validation_failed", "Corpo inválido.", 422, { requestId }); }
  const parsed = closeConversationSchema.safeParse(body);
  if (!parsed.success) return fail("validation_failed", "Confira o assunto e o resumo do atendimento.", 422, { requestId });
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;

  const { data: visible, error: readError } = await supabase.from("conversations")
    .select("id, organization_id, service_revision, status, is_group").eq("id", id)
    .eq("organization_id", authz.org.orgId).maybeSingle();
  if (readError) return fail("internal_error", readError.message, 500, { requestId });
  if (!visible) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  // COM AUTOR (migration 0266): o service role não tem `auth.uid()`, e sem o
  // parâmetro o atendimento fecharia sem dizer por quem — que é exatamente o que
  // o protocolo existe para responder.
  const { data, error } = await createAdminClient().rpc("fn_atendimento_encerrar", {
    p_org: visible.organization_id, p_conversation: id,
    p_expected: parsed.data.expected_revision ?? visible.service_revision ?? null,
    p_actor: user.id,
    p_assunto: parsed.data.assunto_id ?? null,
    p_resumo: parsed.data.resumo ?? null,
    p_status: "closed",
  });
  if (error) {
    // 22023 é o código das QUATRO recusas do registro. A mensagem diz qual, e
    // o `details` leva o campo para a janela marcar o lugar certo.
    const recusa = error.code === "22023" ? motivoDaRecusa(error.message) : null;
    if (recusa) return fail("validation_failed", t(fraseDaRecusa(recusa)), 422, { requestId, details: { ...recusa } });
    return fail(error.code === "40001" ? "conflict" : "internal_error",
      error.code === "40001" ? t("O atendimento mudou. Atualize e tente novamente.") : error.message,
      error.code === "40001" ? 409 : 500, { requestId });
  }
  const conv = data as unknown as Conversation;
  const registrou = !visible.is_group && !ENCERRADOS.has(String(visible.status));

  await audit({
    action: "conversation.closed",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
    // O resumo NÃO vai para a auditoria: é texto livre sobre o cliente, e o
    // audit log é append-only — não haveria como apagá-lo numa anonimização.
    //
    // E a auditoria diz o que ACONTECEU, não o que foi pedido: fechar o que já
    // estava encerrado, ou uma conversa de grupo (que não tem atendimento), não
    // grava registro nenhum — afirmar `assunto_id` ali seria auditar um efeito
    // que não houve.
    metadata: registrou
      ? {
          assunto_id: parsed.data.assunto_id ?? null,
          com_resumo: (parsed.data.resumo ?? "").trim().length > 0,
        }
      : { sem_registro: true },
  });

  return ok(conv, { requestId });
}
