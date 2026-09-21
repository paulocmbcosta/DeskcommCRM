import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/conversations/[id]/notes — lista notas internas da conversa (nunca vai ao WhatsApp).
 * POST /api/v1/conversations/[id]/notes — cria nota interna (autor = user.id, org de authz).
 *
 * Ambos confirmam antes que a conversa pertence à org ativa (`.select("id").maybeSingle()`)
 * pra devolver 404 honesto em vez de vazar existência cross-org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { janelaDoAtendimento } from "@/lib/atendimento/janela-do-atendimento";
import { requireRole } from "@/lib/auth/require-role";
import { mencaoAtingeUsuario, tokensDeMencao } from "@/lib/notifications/mentions";
import { ATENDIMENTO_VIGENTE } from "@/lib/schemas/messaging";
import { createNoteSchema } from "@/lib/schemas/notes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
const COLS = "id, conversation_id, body, created_by_user_id, created_by_name, created_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * `?atendimento_id=vigente|<uuid>` recorta as notas no MESMO episódio que a rota
 * de mensagens recorta — as duas entram intercaladas no mesmo thread. Ausente,
 * devolve a conversa inteira (o contrato de antes, que a API versionada mantém).
 */
const consultaDasNotas = z.object({
  atendimento_id: z.union([z.literal(ATENDIMENTO_VIGENTE), z.string().uuid()]).optional(),
});

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const consulta = consultaDasNotas.safeParse({
    atendimento_id: new URL(req.url).searchParams.get("atendimento_id") ?? undefined,
  });
  if (!consulta.success) return fail("validation_failed", t("Query inválida."), 422, { requestId });

  let notas = supabase
    .from("conversation_notes")
    .select(COLS)
    .eq("conversation_id", id)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: true });

  // A nota pertence ao atendimento em que foi ESCRITA. Sem este recorte, a nota
  // do Financeiro aparecia dentro do atendimento novo do Suporte — e a de hoje,
  // dentro do atendimento encerrado na semana passada.
  if (consulta.data.atendimento_id) {
    const janela = await janelaDoAtendimento(supabase, org.orgId, id, consulta.data.atendimento_id);
    if (!janela.ok) {
      return janela.motivo === "atendimento_nao_encontrado"
        ? fail("not_found", t("Atendimento não encontrado nesta conversa."), 404, { requestId })
        : fail("internal_error", "Erro ao listar notas.", 500, { requestId });
    }
    if (janela.desde) notas = notas.gte("created_at", janela.desde);
    if (janela.ate) notas = notas.lt("created_at", janela.ate);
  }

  const { data, error } = await notas;
  if (error) return fail("internal_error", "Erro ao listar notas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const raw = await req.json().catch(() => null);
  const parsed = createNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { data, error } = await supabase
    .from("conversation_notes")
    .insert({
      organization_id: org.orgId,
      conversation_id: id,
      body: parsed.data.body,
      created_by_user_id: user.id,
      created_by_name: user.full_name ?? null,
    })
    .select(COLS)
    .single();
  if (error || !data) return fail("internal_error", "Erro ao criar nota.", 500, { requestId });

  void audit({
    action: "conversation.note_added",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation_note",
    resourceId: data.id,
    requestId,
    metadata: { conversation_id: id },
  });
  void emitirMencoesDaNota({
    organizationId: org.orgId,
    conversationId: id,
    body: parsed.data.body,
    fromUserId: user.id,
  });
  return ok(data, { requestId, status: 201 });
}

async function emitirMencoesDaNota(input: {
  organizationId: string;
  conversationId: string;
  body: string;
  fromUserId: string;
}): Promise<void> {
  if (tokensDeMencao(input.body).length === 0) return;
  const admin = createAdminClient();
  const { data: members } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null);
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id).filter((id) => id !== input.fromUserId);
  const preview = input.body.trim().slice(0, 140);
  await Promise.all(
    ids.map(async (userId) => {
      const { data: userRes } = await admin.auth.admin.getUserById(userId);
      const u = userRes?.user;
      if (!u?.email) return;
      const fullName =
        (typeof u.user_metadata?.full_name === "string" ? u.user_metadata.full_name : null) ?? null;
      if (!mencaoAtingeUsuario(input.body, { id: userId, email: u.email, full_name: fullName })) return;
      await admin.rpc("emit_event", {
        p_event_type: "user.mentioned",
        p_entity_kind: "conversation_note",
        p_entity_id: input.conversationId,
        p_payload: {
          conversation_id: input.conversationId,
          to_user_id: userId,
          from_user_id: input.fromUserId,
          body_preview: preview,
        },
        p_metadata: {},
        p_organization_id: input.organizationId,
      });
    }),
  );
}
