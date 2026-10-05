/**
 * PATCH `/api/v1/settings/teams/[id]/assuntos/[assuntoId]` — renomeia e/ou
 * arquiva (ou reativa) um assunto de encerramento (migration 0293).
 *
 * Arquivar em vez de apagar: atendimento encerrado aponta para o assunto, e o
 * número do mês passado não pode mudar porque alguém limpou a lista.
 *
 * Time e assunto vêm do PATH, a organização da sessão. A RPC de renomear tem o
 * time no predicado: um assunto não muda de setor por esta porta.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { alterarAssuntoSchema, MENSAGEM_DA_TELA, recusaDoCadastro } from "@/lib/atendimento/assuntos";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; assuntoId: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  if (await mfaEmDivida()) return fail("mfa_required", t(MENSAGEM_DA_TELA.mfa_required), 403, { requestId });

  const { id, assuntoId } = await ctx.params;
  const uuid = z.string().uuid();
  if (!uuid.safeParse(id).success || !uuid.safeParse(assuntoId).success) {
    return fail("invalid_request", t("Assunto inválido."), 400, { requestId });
  }

  const parsed = alterarAssuntoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t(MENSAGEM_DA_TELA.validation_failed), 422, { requestId });

  const db = await createClient();
  const recusar = (erro: { code?: string | null; message?: string | null }) => {
    const recusa = recusaDoCadastro(erro);
    if (recusa) return fail(recusa.code, t(MENSAGEM_DA_TELA[recusa.code]), recusa.status, { requestId });
    return fail("internal_error", t("Não foi possível salvar. Tente novamente."), 500, { requestId });
  };

  if (parsed.data.name !== undefined) {
    const { error } = await db.rpc("fn_save_atendimento_assunto", {
      p_org: auth.org.orgId,        // fonte confiável — NUNCA o body
      p_team: id,
      p_assunto: assuntoId,
      p_name: parsed.data.name,
    });
    if (error) return recusar(error);
    void audit({ action: "atendimento.assunto_salvo", actorUserId: auth.user.id, organizationId: auth.org.orgId,
      resourceType: "atendimento_assunto", resourceId: assuntoId, requestId,
      metadata: { team_id: id, name: parsed.data.name, criado: false } });
  }

  if (parsed.data.archived !== undefined) {
    // O assunto precisa ser DESTE time: a RPC de arquivar só conhece a
    // organização, e sem esta conferência o `[id]` do caminho seria enfeite.
    const { data: doTime, error: erroLeitura } = await db
      .from("atendimento_assuntos")
      .select("id")
      .eq("organization_id", auth.org.orgId)
      .eq("team_id", id)
      .eq("id", assuntoId)
      .maybeSingle();
    if (erroLeitura) return fail("internal_error", t("Não foi possível salvar. Tente novamente."), 500, { requestId });
    if (!doTime) return fail("not_found", t(MENSAGEM_DA_TELA.not_found), 404, { requestId });

    const { error } = await db.rpc("fn_archive_atendimento_assunto", {
      p_org: auth.org.orgId,
      p_assunto: assuntoId,
      p_arquivar: parsed.data.archived,
    });
    if (error) return recusar(error);
    void audit({ action: "atendimento.assunto_arquivado", actorUserId: auth.user.id, organizationId: auth.org.orgId,
      resourceType: "atendimento_assunto", resourceId: assuntoId, requestId,
      metadata: { team_id: id, arquivar: parsed.data.archived } });
  }

  return ok({ id: assuntoId, team_id: id }, { requestId });
}
