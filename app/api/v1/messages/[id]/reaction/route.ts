import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages/[id]/reaction — o atendente reage com emoji a uma
 * mensagem da conversa (DYD-16). Body: `{ "emoji": "👍" }`; `""` tira a reação.
 *
 * Ordem das guardas, e por quê:
 *   1. A mensagem é lida pelo client de RLS: quem não enxerga a conversa
 *      (escopo `own` de um agent) recebe 404, como em qualquer outra rota.
 *   2. O canal precisa reagir (`canalReage`): gravar no balão uma reação que
 *      o cliente nunca vê seria a tela mentindo.
 *   3. Janela de 24h: para a Meta a reação é mensagem livre — com a janela
 *      fechada ela devolve 200 e recusa a entrega depois (131047). Barrar aqui
 *      é dizer a verdade antes, como o composer já faz.
 *   4. Só com o aceite do canal a reação é gravada (`fn_registrar_reacao`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  canalReage,
  getAdapter,
  resolveSessionRef,
  CHANNEL_SESSION_REF_COLUMNS,
} from "@/lib/channels";
import type { ChannelProvider, ChannelSessionRef } from "@/lib/channels";
import { estadoDaJanela } from "@/lib/channels/janela";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { ehEmojiValido } from "@/lib/messaging/reacoes";
import { registrarReacao } from "@/lib/messaging/registrar-reacao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const corpoSchema = z.object({
  emoji: z
    .string()
    .max(32)
    .refine((v) => v === "" || ehEmojiValido(v), "emoji_invalido"),
});

type Linha = {
  id: string;
  organization_id: string;
  conversation_id: string;
  external_id: string | null;
  conversations: {
    is_group: boolean;
    group_chat_id: string | null;
    last_inbound_at: string | null;
    contacts: {
      phone_number: string | null;
      wa_identity: string | null;
      wa_lid: string | null;
      is_blocked: boolean;
    } | null;
    channel_sessions: ChannelSessionRef | null;
  } | null;
};

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });
  }
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha um emoji."), 422, { requestId });
  }
  const { emoji } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("messages")
    .select(
      `id, organization_id, conversation_id, external_id, conversations:conversation_id(is_group, group_chat_id, last_inbound_at, contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}))`,
    )
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const m = data as unknown as Linha | null;
  if (!m || !m.conversations) {
    return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });
  }

  const conv = m.conversations;
  const provider = conv.channel_sessions?.provider ?? null;
  if (!conv.channel_sessions || !canalReage(provider)) {
    return fail("channel_unsupported", t("Este canal não permite reagir a mensagens."), 422, {
      requestId,
    });
  }
  if (!m.external_id) {
    return fail(
      "validation_failed",
      t("Esta mensagem ainda não chegou ao WhatsApp — não dá para reagir a ela."),
      422,
      { requestId },
    );
  }
  if (conv.contacts?.is_blocked) {
    return fail("forbidden", t("Contato bloqueou o atendimento."), 403, { requestId });
  }
  if (estadoDaJanela(provider, conv.last_inbound_at, new Date()).tipo === "fechada") {
    return fail(
      "window_closed",
      t("A janela de 24h está fechada — a reação seria recusada pela plataforma."),
      422,
      { requestId },
    );
  }

  const adapter = getAdapter(provider as ChannelProvider);
  const to = adapter.resolveRecipient({
    isGroup: conv.is_group,
    groupChatId: conv.group_chat_id,
    phoneNumber: conv.contacts?.phone_number,
    waIdentity: conv.contacts?.wa_identity,
    waLid: conv.contacts?.wa_lid,
  });
  if (!to || !adapter.sendReaction) {
    return fail("channel_unsupported", t("Este canal não permite reagir a mensagens."), 422, {
      requestId,
    });
  }

  let reacaoExternalId: string | null = null;
  try {
    const r = await adapter.sendReaction({
      organizationId: orgId,
      sessionRef: resolveSessionRef(conv.channel_sessions),
      to,
      targetExternalId: m.external_id,
      emoji,
    });
    reacaoExternalId = r.externalId;
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    logger.warn("[reaction] o canal recusou a reação", {
      request_id: requestId,
      message_id: id,
      motivo,
    });
    return fail("channel_error", t("O WhatsApp recusou a reação."), 502, {
      requestId,
      details: { motivo: motivo.slice(0, 300) },
    });
  }

  const gravada = await registrarReacao(createAdminClient(), {
    organizationId: orgId,
    lado: "empresa",
    emoji,
    alvoId: m.id,
    userId: authz.user.id,
    externalId: reacaoExternalId,
  });
  if (gravada.erro || !gravada.alvoId) {
    // A reação JÁ saiu: o cliente a vê. Falhar aqui é só a nossa tela ficar
    // para trás — declarado no log, e a resposta diz a verdade.
    logger.error("[reaction] enviada mas não gravada", {
      request_id: requestId,
      message_id: id,
      erro: gravada.erro,
    });
    return fail("internal_error", t("A reação foi enviada, mas não foi registrada aqui."), 500, {
      requestId,
    });
  }

  await audit({
    action: "message.reaction_sent",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "message",
    resourceId: m.id,
    requestId,
    metadata: { conversation_id: m.conversation_id, emoji, removida: emoji === "" },
  });

  return ok({ message_id: m.id, emoji }, { requestId });
}
