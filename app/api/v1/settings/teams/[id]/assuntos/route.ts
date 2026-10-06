/**
 * `/api/v1/settings/teams/[id]/assuntos` — os ASSUNTOS de encerramento de um
 * time (migration 0293): a lista (com os arquivados) e a criação.
 *
 * Mesmo desenho de `settings/teams/route.ts`: LEITURA pelo client do usuário
 * (RLS de tenant) e ESCRITA só por RPC `security definer`, que prova papel,
 * suporte e MFA no banco. O time vem do PATH, a organização da sessão — o
 * schema é estrito, então `organization_id` ou `team_id` no corpo é 422.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import {
  criarAssuntoSchema,
  MENSAGEM_DA_TELA,
  recusaDoCadastro,
  type AssuntoCadastrado,
} from "@/lib/atendimento/assuntos";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET — todos os assuntos do time, ativos primeiro e arquivados no fim. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  if (await mfaEmDivida()) return fail("mfa_required", t(MENSAGEM_DA_TELA.mfa_required), 403, { requestId });

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", t("Time inválido."), 400, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("atendimento_assuntos")
    .select("id, team_id, name, archived_at")
    .eq("organization_id", auth.org.orgId)
    .eq("team_id", id)
    .order("name", { ascending: true });
  if (error) return fail("internal_error", t("Não foi possível carregar os assuntos. Tente novamente."), 500, { requestId });

  const assuntos = (data ?? []).map<AssuntoCadastrado>((a) => ({
    id: a.id,
    team_id: a.team_id,
    name: a.name,
    archived: a.archived_at !== null,
  }));
  assuntos.sort((a, b) => Number(a.archived) - Number(b.archived));
  return ok(assuntos, { requestId });
}

/** POST — cria um assunto no time. Nome que existia arquivado é REATIVADO. */
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  if (await mfaEmDivida()) return fail("mfa_required", t(MENSAGEM_DA_TELA.mfa_required), 403, { requestId });

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("invalid_request", t("Time inválido."), 400, { requestId });

  const parsed = criarAssuntoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t(MENSAGEM_DA_TELA.validation_failed), 422, { requestId });

  const db = await createClient();
  const { data, error } = await db.rpc("fn_save_atendimento_assunto", {
    p_org: auth.org.orgId,          // fonte confiável — NUNCA o body
    p_team: id,
    p_assunto: null,
    p_name: parsed.data.name,
  });
  if (error) {
    const recusa = recusaDoCadastro(error);
    if (recusa) return fail(recusa.code, t(MENSAGEM_DA_TELA[recusa.code]), recusa.status, { requestId });
    return fail("internal_error", t("Não foi possível salvar. Tente novamente."), 500, { requestId });
  }
  const salvo = data as { id: string; name: string } | null;
  void audit({ action: "atendimento.assunto_salvo", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "atendimento_assunto", resourceId: salvo?.id ?? null, requestId,
    metadata: { team_id: id, name: parsed.data.name, criado: true } });
  return ok({ id: salvo?.id ?? null, team_id: id, name: salvo?.name ?? parsed.data.name, archived: false }, { requestId });
}
