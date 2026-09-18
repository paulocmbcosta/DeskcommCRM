/**
 * GET /api/v1/conversations/[id]/timeline — a linha do tempo DA CONVERSA
 * (migration 0266): aberta, encaminhada a um time, assumida, transferida,
 * encerrada, reaberta, automático pausado ou devolvido.
 *
 * Quem escreve é o trigger `fn_atendimento_acompanha_conversa`; esta rota só lê.
 *
 * Client do USUÁRIO, de propósito: a policy de `conversation_events` herda o
 * escopo da conversa (`exists` sobre `conversations`, que aplica a RLS dela).
 * Org em `visibility_mode='own'` não entrega a linha do tempo de uma conversa
 * que o atendente não enxerga — e nada disso precisa ser reescrito aqui.
 *
 * `?atendimento_id=` recorta um episódio: é o que a aba de histórico usa para
 * mostrar o que aconteceu NAQUELE protocolo, e não na vida inteira do contato.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto: um atendimento normal gasta 4–8 linhas; 200 cobre meses de conversa. */
const TETO_DE_EVENTOS = 200;

const querySchema = z.object({ atendimento_id: z.string().uuid().optional() });

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Conversa inválida."), 400, { requestId });
  }
  const url = new URL(req.url);
  const query = querySchema.safeParse({
    atendimento_id: url.searchParams.get("atendimento_id") ?? undefined,
  });
  if (!query.success) return fail("validation_failed", t("Query inválida."), 422, { requestId });

  const db = await createClient();
  // A conversa primeiro: 404 honesto para o que não existe OU está fora do
  // acesso — sem isso, conversa invisível responderia "sem eventos", que é uma
  // afirmação sobre o atendimento feita em cima de uma falta de permissão.
  const { data: conversa, error: erroDaConversa } = await db
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (erroDaConversa) return fail("internal_error", t("Não foi possível ler a conversa."), 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  let consulta = db
    .from("conversation_events")
    .select("id, type, actor_kind, actor_user_id, actor_name, atendimento_id, payload, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(TETO_DE_EVENTOS);
  if (query.data.atendimento_id) consulta = consulta.eq("atendimento_id", query.data.atendimento_id);

  const { data, error } = await consulta;
  if (error) return fail("internal_error", t("Não foi possível ler a linha do tempo."), 500, { requestId });
  return ok(data ?? [], { requestId });
}
