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
import { ORIGENS_JA_CONTADAS_PELA_CONVERSA } from "@/lib/inbox/eventos-da-conversa";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

/** Teto: um atendimento normal gasta 4–8 linhas; 200 cobre meses de conversa. */
const TETO_DE_EVENTOS = 200;
/** As atividades do NEGÓCIO entram como contexto, não como arquivo: as mais recentes bastam. */
const TETO_DE_ATIVIDADES = 40;

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
    .select("id, contact_id")
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

  // ─── O QUE O NEGÓCIO FEZ, NA MESMA LINHA ────────────────────────────────
  //
  // A seção "Atividade" do painel lia `crm_lead_activities` — a linha do tempo
  // do LEAD. Ela sai de lá e entra aqui, numa linha só com os eventos da
  // conversa: duas listas contando a mesma história é como o vocabulário da
  // timeline já divergiu uma vez.
  //
  // O que a conversa JÁ conta (assumir, transferir, liberar, pausar, passar para
  // humano) fica de fora, senão o mesmo gesto apareceria duas vezes. Quem
  // decide é `source_module`, porque é ele que diz DE ONDE a linha veio.
  //
  // A RLS de `crm_lead_activities` é a do lead: quem não enxerga o negócio não
  // recebe a atividade — e a linha do tempo da conversa continua inteira.
  let janela: { de: string | null; ate: string | null } = { de: null, ate: null };
  if (query.data.atendimento_id) {
    const { data: episodios } = await db
      .from("atendimentos")
      .select("id, started_at")
      .eq("organization_id", authz.org.orgId)
      .eq("conversation_id", id)
      .order("started_at", { ascending: true })
      .order("created_at", { ascending: true });
    const lista = (episodios ?? []) as Array<{ id: string; started_at: string }>;
    const indice = lista.findIndex((a) => a.id === query.data.atendimento_id);
    if (indice >= 0) {
      janela = {
        de: indice > 0 ? (lista[indice]?.started_at ?? null) : null,
        ate: lista[indice + 1]?.started_at ?? null,
      };
    }
  }

  let atividades: Array<Record<string, unknown>> = [];
  if (conversa.contact_id) {
    let consultaDeAtividades = db
      .from("crm_lead_activities")
      .select("id, type, source_module, performed_at, reason, actor_kind, performed_by_user_id")
      .eq("organization_id", authz.org.orgId)
      .eq("contact_id", conversa.contact_id)
      .not("source_module", "in", `(${ORIGENS_JA_CONTADAS_PELA_CONVERSA.join(",")})`)
      .order("performed_at", { ascending: false })
      .limit(TETO_DE_ATIVIDADES);
    if (janela.de) consultaDeAtividades = consultaDeAtividades.gte("performed_at", janela.de);
    if (janela.ate) consultaDeAtividades = consultaDeAtividades.lt("performed_at", janela.ate);
    const { data: linhas, error: erroDasAtividades } = await consultaDeAtividades;
    // A atividade do negócio é CONTEXTO: falhar aqui não pode apagar a linha do
    // tempo da conversa, que é o que esta rota existe para entregar. Mas a
    // falha é DITA — `atividades_indisponiveis` — em vez de virar lista vazia.
    if (erroDasAtividades) {
      return ok({ eventos: data ?? [], atividades: [], atividades_indisponiveis: true }, { requestId });
    }
    const brutas = (linhas ?? []) as Array<{ performed_by_user_id?: string | null; [k: string]: unknown }>;
    const nomes = await nomesDosAtendentes(brutas.map((a) => a.performed_by_user_id ?? null));
    atividades = brutas.map((a) => ({
      ...a,
      performed_by_name: a.performed_by_user_id ? (nomes.get(a.performed_by_user_id) ?? null) : null,
    }));
  }

  return ok({ eventos: data ?? [], atividades, atividades_indisponiveis: false }, { requestId });
}
