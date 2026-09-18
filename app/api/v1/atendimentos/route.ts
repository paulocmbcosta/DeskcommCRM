/**
 * GET /api/v1/atendimentos?protocol=<dígitos> — acha o atendimento pelo NÚMERO
 * DE PROTOCOLO (migration 0266).
 *
 * Por que existe ao lado da busca do inbox: a lista de conversas filtra por ABA
 * (Fila, Minhas, Fechadas…) e guarda só o protocolo VIGENTE de cada conversa.
 * O cliente que liga com o protocolo de três atendimentos atrás tem um número
 * que não mora em `conversations.protocol`, numa conversa que hoje pode estar
 * em qualquer aba. Esta rota responde pelo número, sem aba nenhuma no caminho.
 *
 * Client do USUÁRIO: o escopo é o da conversa (RLS herdada). Quem não enxerga a
 * conversa não acha o protocolo dela.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import type { AtendimentoResumo } from "@/lib/inbox/eventos-da-conversa";
import { rotuloDoCanal } from "@/lib/inbox/rotulo-do-canal";
import { createClient } from "@/lib/supabase/server";

import { listarAtendimentosFechados, listarFechadosSchema } from "./_handler";

export const dynamic = "force-dynamic";

/** Mesmo piso do telefone na busca do inbox: menos que isso casa metade da base. */
export const PISO_DE_DIGITOS_DO_PROTOCOLO = 4;
const TETO = 8;

const querySchema = z.object({
  protocol: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().min(PISO_DE_DIGITOS_DO_PROTOCOLO).max(24)),
});

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
    channel_sessions: { phone_number: string | null; display_name: string | null } | null;
    contacts: {
      display_name: string | null;
      name: string | null;
      phone_number: string | null;
      is_anonymized: boolean | null;
    } | null;
  } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // DUAS PERGUNTAS NA MESMA PORTA, separadas por `status`:
  //   ?status=closed  → a lista paginada da aba "Fechadas" do inbox;
  //   ?protocol=…     → a busca pelo número, que responde fora de qualquer aba.
  const sp = new URL(req.url).searchParams;
  if (sp.get("status") === "closed") {
    const q = listarFechadosSchema.safeParse({
      cursor: sp.get("cursor") ?? undefined,
      limit: sp.get("limit") ?? undefined,
      search: sp.get("search") ?? undefined,
      channel_session_id: sp.get("channel_session_id") ?? undefined,
      tag: sp.get("tag") ?? undefined,
      team_id: sp.get("team_id") ?? undefined,
      unread: sp.get("unread") ?? undefined,
    });
    if (!q.success) return fail("validation_failed", t("Query inválida."), 422, { requestId });
    const resultado = await listarAtendimentosFechados(
      await createClient(),
      { organizationId: authz.org.orgId, userId: authz.user.id, t },
      q.data,
    );
    if (!resultado.ok) {
      return resultado.motivo === "cursor_invalido"
        ? fail("invalid_cursor", t("Cursor inválido."), 400, { requestId })
        : fail("internal_error", t("Não foi possível ler os atendimentos encerrados."), 500, { requestId });
    }
    return ok(resultado.data, { requestId, meta: { cursor: resultado.cursor, has_more: resultado.has_more } });
  }

  const query = querySchema.safeParse({ protocol: new URL(req.url).searchParams.get("protocol") ?? "" });
  if (!query.success) {
    return fail("validation_failed", t("Informe ao menos 4 dígitos do protocolo."), 422, { requestId });
  }

  const db = await createClient();
  const { data, error } = await db
    .from("atendimentos")
    .select(
      `id, conversation_id, protocol, started_at, closed_at, closed_status, closed_by_name,
       assigned_to_user_name, team_id,
       conversations!inner (
         channel_sessions:channel_session_id (phone_number, display_name),
         contacts:contact_id (display_name, name, phone_number, is_anonymized)
       )`,
    )
    .eq("organization_id", authz.org.orgId)
    // Só dígitos chegam aqui (o schema os filtrou), então o padrão não carrega
    // curinga nem metacaractere de quem digitou.
    .ilike("protocol", `%${query.data.protocol}%`)
    .order("started_at", { ascending: false })
    .limit(TETO);
  if (error) return fail("internal_error", t("Não foi possível buscar o protocolo."), 500, { requestId });

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
    canal: rotuloDoCanal(a.conversations?.channel_sessions ?? null),
    contato: rotuloDoContato(a.conversations?.contacts ?? null, t),
  }));
  return ok(linhas, { requestId });
}
