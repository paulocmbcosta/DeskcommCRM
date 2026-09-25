import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";
import { montarPayloadDeInbound, truncar } from "./push_payload";
import { enviarPushAoUsuario } from "./web_push";
import { logger } from "@/lib/logger";
import { vapidPronto } from "./vapid";
import type { PushPayload } from "./push_payload";
import { nomeDoRemetente, previaDaMensagem, TITULO_SEM_CONTATO } from "./aviso-de-mensagem";

export const WEB_PUSH_INBOUND_KEY = "web-push-inbound.v1";

/**
 * Quem recebe o push de uma mensagem nesta conversa — perguntado ao banco.
 *
 * Até a 0281 o push ia para TODA inscrição da organização: o atendente recebia
 * na tela de bloqueio o texto de conversa que a RLS não o deixava abrir, e
 * recebia de todas as outras. `fn_destinatarios_do_aviso_de_mensagem` aplica a
 * MESMA régua da RLS (`fn_agent_sees_conversation`) e a escolha de cada pessoa
 * (`user_organizations.message_alert_scope`, padrão "só as minhas" para
 * atendente). Em erro, ninguém recebe: aviso a menos é melhor que vazamento.
 */
export async function destinatariosDoAviso(
  organizationId: string,
  conversationId: string,
): Promise<string[] | null> {
  const { data, error } = await createAdminClient().rpc(
    "fn_destinatarios_do_aviso_de_mensagem" as never,
    { p_org: organizationId, p_conversation: conversationId } as never,
  );
  if (error) {
    logger.warn("push_destinatarios_falhou", { detail: error.message });
    return null;
  }
  // `setof uuid` chega como lista de valores; aceita também a forma de objeto.
  return ((data as unknown[] | null) ?? [])
    .map((v) =>
      typeof v === "string"
        ? v
        : v && typeof v === "object"
          ? (Object.values(v as Record<string, unknown>)[0] as string | undefined)
          : undefined,
    )
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

async function handleInbound(row: EventRow): Promise<HandlerResult> {
  const conversationId =
    (typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null) ?? null;
  // Sem conversa não há dono nem escopo para medir — e mandar para a
  // organização inteira é exatamente o defeito que a 0281 fechou.
  if (!conversationId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_conversa" };
  }
  const destinatarios = await destinatariosDoAviso(row.organization_id, conversationId);
  // Erro ≠ ninguém: devolve `error` para o dispatcher tentar de novo, em vez de
  // descartar o aviso de vez. Nunca cai para "manda para todo mundo".
  if (destinatarios === null) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "error", detail: "destinatarios_indisponiveis" };
  }
  if (destinatarios.length === 0) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_destinatario" };
  }
  const previewRaw = row.payload.body_preview;
  const body = previaDaMensagem(
    typeof row.payload.type === "string" ? row.payload.type : "text",
    typeof previewRaw === "string" ? previewRaw : "",
  );

  const marca = await marcaDaSaida(row.organization_id);
  // UMA leitura: a conversa traz o contato e o time pelas FKs. Antes era a
  // leitura do contato sozinha — o time custou zero consulta a mais.
  const admin = createAdminClient();
  const { data } = await admin
    .from("conversations")
    .select(
      "contacts(display_name, name, phone_number, avatar_storage_path, is_anonymized), attendance_teams(name)",
    )
    .eq("id", conversationId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  const conversa = data as {
    contacts?: {
      display_name?: string | null;
      name?: string | null;
      phone_number?: string | null;
      avatar_storage_path?: string | null;
      is_anonymized?: boolean | null;
    } | null;
    attendance_teams?: { name?: string | null } | null;
  } | null;
  const c = conversa?.contacts ?? null;
  // A cadeia CANÔNICA (`rotuloDoContato`, via `nomeDoRemetente`), e não uma
  // remontada aqui: ela recusa o identificador técnico do WhatsApp — sem isso a
  // notificação chegaria à tela de bloqueio escrita com o id da conta — e cai
  // para o telefone formatado antes de desistir.
  const nome = c ? nomeDoRemetente(c) : null;
  const contactName = nome === TITULO_SEM_CONTATO ? null : nome;
  const teamName = conversa?.attendance_teams?.name ?? null;
  let icon: string | null = null;
  if (c?.avatar_storage_path && !c.is_anonymized) {
    const { data: signed } = await admin.storage
      .from("whatsapp-media")
      .createSignedUrl(c.avatar_storage_path, 300);
    icon = signed?.signedUrl ?? null;
  }
  const payload = montarPayloadDeInbound({
    brand: marca.nome,
    conversationId,
    preview: body,
    contactName,
    teamName,
    icon,
  });
  let sent = 0;
  for (const userId of destinatarios) {
    sent += (await enviarPushAoUsuario(row.organization_id, userId, payload)).sent;
  }
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

async function leadBits(organizationId: string, leadId: string): Promise<{
  title: string;
  ownerUserId: string | null;
  pipelineId: string | null;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_leads")
    .select("title, owner_user_id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = data as {
    title?: string | null;
    owner_user_id?: string | null;
    pipeline_id?: string | null;
  } | null;
  return {
    title: row?.title?.trim() || "Lead",
    ownerUserId: row?.owner_user_id ?? null,
    pipelineId: row?.pipeline_id ?? null,
  };
}

function hrefDoLead(pipelineId: string | null): string {
  return pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";
}

async function enviarParaUsuario(
  organizationId: string,
  userId: string | null,
  payload: PushPayload,
): Promise<HandlerResult> {
  if (!userId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_destinatario" };
  }
  const { sent } = await enviarPushAoUsuario(organizationId, userId, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

export const webPushInboundHandler: EventHandler = {
  key: WEB_PUSH_INBOUND_KEY,
  events: [
    "message.received",
    "conversation.assigned",
    "lead.assigned",
    "lead.won",
    "lead.lost",
    "user.mentioned",
  ],
  async handle(row): Promise<HandlerResult> {
    if (!vapidPronto()) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "vapid_ausente" };
    }
    if (row.event_type === "message.received") return handleInbound(row);

    if (row.event_type === "conversation.assigned") {
      // Emitido pelo trigger da 0281 quando alguém RECEBE uma conversa (rodízio,
      // transferência) — a primeira mensagem chegou antes de ela ter dono, e
      // "só as minhas" não teria avisado ninguém.
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : null;
      const conversationId =
        typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: "Conversa atribuída a você",
        body: "Um cliente está esperando a sua resposta.",
        tag: conversationId ? `assigned:${conversationId}` : "assigned",
        href: conversationId ? `/app/inbox?id=${conversationId}` : "/app/inbox",
      });
    }

    if (row.event_type === "user.mentioned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : null;
      const conversationId =
        typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
      const preview =
        typeof row.payload.body_preview === "string" ? row.payload.body_preview : "Você foi mencionado";
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: "Você foi mencionado",
        body: truncar(preview),
        tag: conversationId ? `mention:${conversationId}` : "mention",
        href: conversationId ? `/app/inbox/${conversationId}` : "/app/inbox",
      });
    }

    const leadId =
      (typeof row.payload.lead_id === "string" ? row.payload.lead_id : null) ??
      (typeof row.entity_id === "string" ? row.entity_id : null);
    if (!leadId) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_lead" };
    }
    const lead = await leadBits(row.organization_id, leadId);
    const href = hrefDoLead(lead.pipelineId);

    if (row.event_type === "lead.assigned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : lead.ownerUserId;
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: "Lead atribuído a você",
        body: truncar(lead.title),
        tag: `lead-assigned:${leadId}`,
        href,
      });
    }
    if (row.event_type === "lead.won") {
      return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
        title: "Lead ganho",
        body: truncar(lead.title),
        tag: `lead-won:${leadId}`,
        href,
      });
    }
    return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
      title: "Lead perdido",
      body: truncar(lead.title),
      tag: `lead-lost:${leadId}`,
      href,
    });
  },
};
