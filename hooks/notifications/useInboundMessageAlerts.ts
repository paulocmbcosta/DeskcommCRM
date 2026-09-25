"use client";

import { useCallback, useEffect } from "react";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { getOpenConversationId } from "@/hooks/notifications/OpenConversationContext";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { avatarUrlServivel } from "@/lib/notifications/avatar_url";
import { entregarAviso } from "@/lib/notifications/deliver";
import {
  escolhaDaSessaoAtual,
  escopoEfetivo,
  mensagemMereceAviso,
} from "@/lib/notifications/escopo-de-aviso";
import { shouldNotifyInbound } from "@/lib/notifications/policy";
import { syncPushSubscription } from "@/lib/notifications/push_client";
import { createClient } from "@/lib/supabase/browser";

function tabFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** postgres_changes entrega `{ new }`; alguns mocks aninham em `payload`. */
function rowFromRealtime(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    tipo?: unknown;
    new?: unknown;
    record?: unknown;
    payload?: { new?: unknown };
  };
  if (p.tipo === "reassinado") return null;
  const raw = p.new ?? p.record ?? p.payload?.new;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function previewFromMessage(row: { type?: unknown; body?: unknown }): string {
  if (row.type !== "text") return "Mídia";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  return body || "Nova mensagem";
}

async function contactNotifyBits(contactId: string): Promise<{ title: string; icon?: string }> {
  const supabase = createClient();
  const { data } = await supabase
    .from("contacts")
    .select("display_name, name")
    .eq("id", contactId)
    .maybeSingle();
  const row = data as { display_name?: string | null; name?: string | null } | null;
  const title = (row?.display_name || row?.name || "Nova mensagem").trim() || "Nova mensagem";
  let icon: string | undefined;
  try {
    const r = await fetch(`/api/v1/contacts/${contactId}/avatar`, {
      credentials: "include",
      redirect: "follow",
    });
    icon = r.ok ? avatarUrlServivel(r.url, window.location.origin) : undefined;
  } catch {
    // sem foto: badge da marca
  }
  return { title, icon };
}

/** A conversa da mensagem: de quem é, e o contato (quando a linha não trouxe). */
async function conversaDaMensagem(
  conversationId: string,
): Promise<{ contactId: string | null; assignedTo: string | null } | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("conversations")
    .select("contact_id, assigned_to_user_id")
    .eq("id", conversationId)
    .maybeSingle();
  const c = data as { contact_id?: string | null; assigned_to_user_id?: string | null } | null;
  if (!c) return null;
  return {
    contactId: typeof c.contact_id === "string" ? c.contact_id : null,
    assignedTo: typeof c.assigned_to_user_id === "string" ? c.assigned_to_user_id : null,
  };
}

export function useInboundMessageAlerts(): void {
  const activeOrg = useActiveOrg();
  const orgId = activeOrg?.orgId ?? null;
  const userId = useUser().id;
  // O que a RLS deixa chegar aqui é tudo que a pessoa ENXERGA; o escopo decide
  // de quais delas ela quer ser avisada (0281 — atendente: só as suas).
  const escopo = activeOrg
    ? (activeOrg.aviso_de_mensagem ?? escopoEfetivo(activeOrg.role, null))
    : "mine";

  useEffect(() => {
    if (!orgId) return;
    void syncPushSubscription();
  }, [orgId]);

  const onChange = useCallback((payload: unknown) => {
    const row = rowFromRealtime(payload);
    if (!row) return;
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id : null;
    const direction = typeof row.direction === "string" ? row.direction : null;
    if (
      !shouldNotifyInbound({
        direction,
        conversationId,
        openConversationId: getOpenConversationId(),
        tabFocused: tabFocused(),
        tipo: (payload as { tipo?: unknown }).tipo,
      })
    ) {
      return;
    }
    void (async () => {
      const escopoAgora = escolhaDaSessaoAtual() ?? escopo;
      const contatoDaLinha = typeof row.contact_id === "string" ? row.contact_id : null;
      // Só relê a conversa quando precisa: para saber de quem ela é ("só as
      // minhas") ou o contato que a linha não trouxe. Com "todas que vejo" e o
      // contato na linha, nenhuma consulta a mais por mensagem — cada navegador
      // aberto faria a sua.
      let contactId = contatoDaLinha;
      if (escopoAgora === "mine" || !contatoDaLinha) {
        const conversa = await conversaDaMensagem(conversationId as string);
        if (!conversa) return;
        if (!mensagemMereceAviso(escopoAgora, { assignedTo: conversa.assignedTo, userId })) return;
        contactId = contatoDaLinha ?? conversa.contactId;
      }
      const bits = contactId
        ? await contactNotifyBits(contactId)
        : { title: "Nova mensagem" as const, icon: undefined };
      entregarAviso({
        category: "message",
        kind: "message_inbound",
        title: bits.title,
        body: previewFromMessage(row),
        tag: conversationId ?? undefined,
        href: conversationId ? `/app/inbox?id=${conversationId}` : undefined,
        icon: bits.icon,
      });
    })();
  }, [escopo, userId]);

  useRealtimeChannel({
    name: orgId ? `alerts-messages-${orgId}` : "alerts-messages-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });
}
