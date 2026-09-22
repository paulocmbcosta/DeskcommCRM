import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/members — cadastra um membro JÁ COM SENHA.
 *
 * A outra porta de entrada da equipe, ao lado do convite
 * (`../invite/route.ts`): em vez de um link que depende de e-mail, quem
 * administra escolhe a senha e a pessoa já entra. A regra inteira — o que se
 * recusa e por quê, a compensação, a entrega do criador provisório — mora em
 * `lib/team/cadastro-direto.ts`; aqui só se autentica, valida e traduz.
 *
 * A senha entra no body e morre aqui: não volta na resposta, não vai para a
 * auditoria, não vai para log. A tela mostra a que a própria pessoa digitou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { cadastrarMembroSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { cadastrarMembroComSenha } from "@/lib/team/cadastro-direto";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  let input;
  try {
    input = await validateRequest(cadastrarMembroSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Criar conta no provedor de auth só existe pela chave de serviço. Sem ela,
  // dizer o que falta é melhor que um 500 sem nome.
  if (!isServiceRoleConfigured()) {
    return fail(
      "unavailable",
      t("Esta instalação não tem a chave de serviço do banco configurada; use o convite por link."),
      503,
      { requestId },
    );
  }

  const resultado = await cadastrarMembroComSenha(createAdminClient(), {
    organizationId: activeOrg.orgId,
    actorId: authUser.id,
    fullName: input.full_name,
    email: input.email,
    password: input.password,
    role: input.role,
    interfaceSettings: input.interface_settings,
  });

  if (!resultado.ok) {
    switch (resultado.motivo) {
      case "ja_membro":
        return fail("state_conflict", t("Esta pessoa já faz parte da equipe."), 409, {
          details: { motivo: "ja_membro" },
          requestId,
        });
      case "conta_existente":
        return fail(
          "state_conflict",
          t(
            "Este e-mail já tem uma conta no sistema, e a senha dela não é trocada por aqui. Se a pessoa já foi da equipe, use “Devolver acesso” na lista de membros; se não, use o convite por link — ela entra com a senha que já tem.",
          ),
          409,
          { details: { motivo: "conta_existente" }, requestId },
        );
      case "senha_recusada":
        return fail(
          "unprocessable_entity",
          t("A senha foi recusada pela política de senhas desta instalação. Escolha outra, mais longa e menos óbvia."),
          422,
          { details: { motivo: "senha_recusada", provedor: resultado.detalhe ?? null }, requestId },
        );
      default:
        return fail("internal_error", t("Não foi possível cadastrar o membro. Tente novamente."), 500, {
          details: { motivo: "falha" },
          requestId,
        });
    }
  }

  await audit({
    action: "member.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: resultado.membershipId,
    requestId,
    bypassedRls: true,
    metadata: {
      target_user_id: resultado.userId,
      email: input.email,
      role: input.role,
      entregue: resultado.entregue,
    },
  });

  return ok(
    {
      user_id: resultado.userId,
      email: input.email,
      full_name: input.full_name,
      role: input.role,
      entregue: resultado.entregue,
      login_url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/login`,
    },
    { status: 201, requestId },
  );
}
