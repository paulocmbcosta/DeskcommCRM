/**
 * PUT    /api/v1/conectores/[conector]/conexao — liga ou troca a conexão (admin).
 * DELETE /api/v1/conectores/[conector]/conexao — desliga (admin).
 * PATCH  /api/v1/conectores/[conector]/conexao — ajusta o limite de dias da cobrança pela IA (admin).
 *
 * SALVAR TESTA ANTES DE GRAVAR. Uma conexão gravada sem teste só falharia na
 * frente do atendente, no meio de um atendimento, com uma mensagem sobre token —
 * que ele não pode consertar. Aqui quem erra é quem está com o token na mão.
 *
 * O token entra em claro SÓ por este endpoint, é cifrado e descartado. Trocar
 * apenas o endereço não pede o token de novo: sem `token` no corpo, vale o que
 * já está guardado.
 *
 * Desligar NÃO apaga os vínculos contato ↔ cadastro: religar com outro token é o
 * caso comum (rotação), e perder os vínculos obrigaria a re-identificar a base.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerConexaoPublica, lerCredencial, removerConexao, salvarConexao, salvarLimiteDeCobranca } from "@/lib/conectores/conexao";
import { obterConector } from "@/lib/conectores/registro";
import { FRASE_DA_FALHA } from "@/lib/conectores/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const salvarSchema = z.object({
  base_url: z.string().trim().min(4).max(300),
  token: z.string().trim().min(8).max(500).optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ conector: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const conector = obterConector((await ctx.params).conector);
  if (!conector) return fail("conector_desconhecido", t("Conector desconhecido."), 404, { requestId });

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = salvarSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  try {
    const token = parsed.data.token ?? (await lerCredencial(admin, orgId, conector.id))?.token;
    if (!token) {
      return fail("validation_failed", t("Informe o token."), 422, { requestId });
    }

    const teste = await conector.testar({ baseUrl: parsed.data.base_url, token });
    if (!teste.ok) {
      // 422 e não 502: o que falhou foi o que a PESSOA informou, e ela conserta.
      return fail("validation_failed", t(FRASE_DA_FALHA[teste.motivo]), 422, {
        requestId,
        details: { motivo: teste.motivo },
      });
    }

    const jaExistia = (await lerConexaoPublica(admin, orgId, conector.id)) !== null;
    await salvarConexao({ admin, orgId, userId: authz.user.id, conector: conector.id, baseUrl: parsed.data.base_url, token });

    void audit({
      action: "conector.conexao_salva",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "conector_conexao",
      resourceId: null,
      // Sem o endereço inteiro e sem o token: o host basta para a trilha.
      metadata: { conector: conector.id, troca: jaExistia, trocou_token: Boolean(parsed.data.token) },
      requestId,
    });

    return ok(await lerConexaoPublica(admin, orgId, conector.id), { requestId });
  } catch {
    return fail("internal_error", "Erro ao salvar a conexão.", 500, { requestId });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ conector: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const conector = obterConector((await ctx.params).conector);
  if (!conector) return fail("conector_desconhecido", t("Conector desconhecido."), 404, { requestId });

  try {
    const removeu = await removerConexao(createAdminClient(), authz.org.orgId, conector.id);
    if (!removeu) return fail("conector_desligado", t("Este conector já está desligado."), 404, { requestId });

    void audit({
      action: "conector.conexao_removida",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "conector_conexao",
      resourceId: null,
      metadata: { conector: conector.id },
      requestId,
    });
    return ok({ removida: true }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao desligar o conector.", 500, { requestId });
  }
}

const preferenciasSchema = z
  .object({ cobranca_encaminha_apos_dias: z.number().int().min(1).max(3650) })
  .strict();

/**
 * O limite de dias da cobrança pela IA: fatura com MAIS dias de atraso que isto a
 * IA não envia — encaminha à Cobrança (regra do dono, 22/09). Não passa pelo teste
 * do token: é política da empresa, não credencial. `.strict()` recusa campo
 * estranho (inclusive `organization_id`) em vez de ignorar.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ conector: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const conector = obterConector((await ctx.params).conector);
  if (!conector) return fail("conector_desconhecido", t("Conector desconhecido."), 404, { requestId });

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = preferenciasSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Informe um número inteiro de dias, entre 1 e 3650."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  try {
    const antes = await lerConexaoPublica(admin, orgId, conector.id);
    const gravou = await salvarLimiteDeCobranca(admin, orgId, conector.id, parsed.data.cobranca_encaminha_apos_dias);
    if (!gravou) return fail("conector_desligado", t("Este conector está desligado."), 404, { requestId });

    void audit({
      action: "conector.preferencias_alteradas",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "conector_conexao",
      resourceId: null,
      metadata: {
        conector: conector.id,
        campo: "cobranca_encaminha_apos_dias",
        de: antes?.cobranca_encaminha_apos_dias ?? null,
        para: parsed.data.cobranca_encaminha_apos_dias,
      },
      requestId,
    });
    return ok(await lerConexaoPublica(admin, orgId, conector.id), { requestId });
  } catch {
    return fail("internal_error", "Erro ao salvar a preferência.", 500, { requestId });
  }
}
