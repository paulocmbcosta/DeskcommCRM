/**
 * GET /api/v1/contacts/[id]/atendimentos — o HISTÓRICO de atendimentos de um
 * contato (migration 0266): um por protocolo, do mais novo para o mais velho,
 * somando todos os canais por onde ele já falou.
 *
 * É o que alimenta o "relógio" do painel do inbox: quem atende vê, antes de
 * responder, quantas vezes aquela pessoa já chamou, quando, e como acabou — e
 * abre qualquer um deles.
 *
 * Client do USUÁRIO: a policy de `atendimentos` herda o escopo da conversa, e o
 * embed `conversations!inner` aplica a RLS de `conversations` de novo. O
 * contato NÃO está em `atendimentos` (DIRC: ele vem da conversa, por FK) — é
 * por isso que uma fusão de contatos não precisa repontar nada aqui.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import type { AtendimentoResumo } from "@/lib/inbox/eventos-da-conversa";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Um contato com mais de 100 atendimentos é raro; acima disso a lista pagina depois. */
const TETO = 100;

interface Linha {
  id: string;
  conversation_id: string;
  protocol: string;
  started_at: string;
  closed_at: string | null;
  closed_status: string | null;
  closed_by_name: string | null;
  assigned_to_user_name: string | null;
  team_id: string | null;
  conversations: {
    contact_id: string;
    channel_sessions: { phone_number: string | null; display_name: string | null } | null;
  } | null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: contactId } = await ctx.params;
  if (!z.string().uuid().safeParse(contactId).success) {
    return fail("invalid_request", t("Contato inválido."), 400, { requestId });
  }

  const db = await createClient();
  const { data, error } = await db
    .from("atendimentos")
    .select(
      `id, conversation_id, protocol, started_at, closed_at, closed_status, closed_by_name,
       assigned_to_user_name, team_id,
       conversations!inner (contact_id, channel_sessions:channel_session_id (phone_number, display_name))`,
    )
    .eq("organization_id", authz.org.orgId)
    .eq("conversations.contact_id", contactId)
    .order("started_at", { ascending: false })
    .limit(TETO);
  if (error) return fail("internal_error", t("Não foi possível ler o histórico de atendimentos."), 500, { requestId });

  const linhas = ((data ?? []) as unknown as Linha[]).map<AtendimentoResumo>((a) => ({
    id: a.id,
    conversation_id: a.conversation_id,
    protocol: a.protocol,
    started_at: a.started_at,
    closed_at: a.closed_at,
    closed_status: a.closed_status,
    closed_by_name: a.closed_by_name,
    assigned_to_user_name: a.assigned_to_user_name,
    team_id: a.team_id,
    canal: a.conversations?.channel_sessions?.phone_number ?? a.conversations?.channel_sessions?.display_name ?? null,
  }));
  return ok(linhas, { requestId });
}
