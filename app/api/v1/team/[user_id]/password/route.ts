import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/password — quem administra define uma senha nova
 * para um membro.
 *
 * É o laço de retorno do cadastro com senha (`../../members/route.ts`): numa
 * instalação sem e-mail, "esqueci a senha" não chega a lugar nenhum, e sem esta
 * rota quem esquece fica preso — nem recadastrar resolve, porque a conta já
 * existe. As recusas (a própria senha, outra organização, admin de plataforma)
 * e o porquê de cada uma estão em `lib/team/cadastro-direto.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { definirSenhaSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { definirSenhaDoMembro } from "@/lib/team/cadastro-direto";
import { corpoEhJson, emAcompanhamento } from "@/lib/team/guardas-de-credencial";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { user_id: bruto } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  // Forma canônica ANTES de qualquer comparação: o banco aceita o uuid com
  // chaves, sem hífens ou em maiúsculas, e a guarda "a própria senha" compara
  // texto. Fora do formato, não é id de ninguém.
  const idValido = z.string().uuid().safeParse(bruto);
  if (!idValido.success) {
    return fail("invalid_request", t("Membro inválido."), 400, { requestId });
  }
  const targetUserId = idValido.data.toLowerCase();

  if (emAcompanhamento(authUser)) {
    return fail(
      "forbidden",
      t("O acompanhamento não troca a senha de ninguém. Saia do acompanhamento para continuar."),
      403,
      { requestId },
    );
  }
  if (!corpoEhJson(req)) {
    return fail("unsupported_media_type", t("O corpo precisa ser JSON."), 415, { requestId });
  }

  let input;
  try {
    input = await validateRequest(definirSenhaSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (!isServiceRoleConfigured()) {
    return fail(
      "unavailable",
      t("Esta instalação não tem a chave de serviço do banco configurada; a senha não pode ser trocada por aqui."),
      503,
      { requestId },
    );
  }

  const resultado = await definirSenhaDoMembro(createAdminClient(), {
    organizationId: activeOrg.orgId,
    actorId: authUser.id,
    targetUserId,
    password: input.password,
  });

  if (!resultado.ok) {
    if (resultado.motivo === "falha") {
      logger.error("team.password: definir senha falhou", {
        requestId,
        organization_id: activeOrg.orgId,
        target_user_id: targetUserId,
        detalhe: resultado.detalhe ?? null,
      });
    }
    const detalhes = { details: { motivo: resultado.motivo }, requestId };
    switch (resultado.motivo) {
      case "si_mesmo":
        return fail(
          "invalid_request",
          t("A sua própria senha não se troca por aqui."),
          400,
          detalhes,
        );
      case "nao_membro":
        return fail("not_found", t("Membro não encontrado."), 404, detalhes);
      case "revogado":
        return fail(
          "state_conflict",
          t("Este membro está sem acesso. Devolva o acesso antes de definir uma senha."),
          409,
          detalhes,
        );
      case "outra_organizacao":
        return fail(
          "state_conflict",
          t(
            "Esta pessoa também faz parte de outra organização; só ela pode trocar a própria senha, em Configurações › Perfil.",
          ),
          409,
          detalhes,
        );
      case "senha_igual":
        return fail("unprocessable_entity", t("A senha nova é igual à atual. Escolha outra."), 422, detalhes);
      case "admin_de_plataforma":
        return fail(
          "forbidden",
          t("A senha de um administrador da plataforma não se troca por aqui."),
          403,
          detalhes,
        );
      case "senha_recusada":
        return fail(
          "unprocessable_entity",
          t("A senha foi recusada pela política de senhas desta instalação. Escolha outra, mais longa e menos óbvia."),
          422,
          { details: { motivo: "senha_recusada", provedor: resultado.detalhe ?? null }, requestId },
        );
      default:
        return fail("internal_error", t("Não foi possível trocar a senha. Tente novamente."), 500, detalhes);
    }
  }

  await audit({
    action: "member.password_set",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: resultado.membershipId,
    requestId,
    bypassedRls: true,
    metadata: { target_user_id: targetUserId },
  });

  return ok({ user_id: targetUserId, password_set: true }, { requestId });
}
