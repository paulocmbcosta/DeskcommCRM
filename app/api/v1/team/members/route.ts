import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/members — cadastra um membro JÁ COM SENHA.
 *
 * A outra porta de entrada da equipe, ao lado do convite
 * (`../invite/route.ts`): em vez de um link que depende de e-mail, quem
 * administra escolhe a senha e a pessoa já entra. A regra inteira — o que se
 * recusa e por quê, a compensação, o criador provisório que não escolhe a senha
 * do dono — mora em `lib/team/cadastro-direto.ts`; aqui só se autentica, valida
 * e traduz.
 *
 * A senha entra no body e morre aqui: não volta na resposta, não vai para a
 * auditoria, não vai para log. A tela mostra a que a própria pessoa digitou.
 *
 * SEM `Idempotency-Key`, de propósito, e contra a regra geral dos POST de
 * criação. O recibo de `lib/api/idempotency.ts` guarda por 24h o sha256 do
 * corpo — e aqui o corpo tem a senha: seria um hash rápido, sem sal, de uma
 * senha recém-escolhida, sentado no banco. Tirar a senha do hash faria uma
 * repetição com senha diferente devolver o recibo da primeira, e a tela
 * mostraria como válida uma senha que não vale. O efeito já é único pelo
 * e-mail: repetir o POST responde 409 "já faz parte da equipe" e nada
 * acontece duas vezes.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { cadastrarMembroSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { cadastrarMembroComSenha } from "@/lib/team/cadastro-direto";
import { corpoEhJson, emAcompanhamento } from "@/lib/team/guardas-de-credencial";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  if (emAcompanhamento(authUser)) {
    return fail(
      "forbidden",
      t("O acompanhamento não cadastra membros com senha. Saia do acompanhamento ou use o convite."),
      403,
      { requestId },
    );
  }
  if (!corpoEhJson(req)) {
    return fail("unsupported_media_type", t("O corpo precisa ser JSON."), 415, { requestId });
  }

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
    if (resultado.motivo === "falha") {
      // O detalhe nunca leva a senha: é a mensagem do banco ou do provedor.
      logger.error("team.members: cadastro com senha falhou", {
        requestId,
        organization_id: activeOrg.orgId,
        detalhe: resultado.detalhe ?? null,
      });
    }
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
      case "entrega_por_convite":
        return fail(
          "state_conflict",
          t(
            "Você abriu esta organização para outra pessoa. O administrador que vai assumi-la entra por convite, escolhendo a própria senha — assim só ele a conhece.",
          ),
          409,
          { details: { motivo: "entrega_por_convite" }, requestId },
        );
      case "email_invalido":
        return fail("unprocessable_entity", t("Este e-mail foi recusado. Confira se está escrito certo."), 422, {
          details: { motivo: "email_invalido" },
          requestId,
        });
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
    },
  });

  return ok(
    {
      user_id: resultado.userId,
      email: input.email,
      full_name: input.full_name,
      role: input.role,
      login_url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/login`,
    },
    { status: 201, requestId },
  );
}
