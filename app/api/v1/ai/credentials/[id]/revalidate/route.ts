import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/credentials/:id/revalidate (admin)
 *
 * Decifra a credential, faz ping síncrono ao provider e atualiza
 * `validated_at` / `validation_error` / `models_available`. Diferente do POST
 * de criação, aqui esperamos o resultado pra devolver ao usuário (botão "Test").
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { PROVEDOR_DE_VOZ } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { validarChaveDeVoz } from "@/lib/telefonia/servico-de-falas";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  // Pra revalidate ignoramos o gate `validated_at` do loadCredential — fazemos
  // a leitura bruta e decifragem direta.
  const { data: row, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select(
      "id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, is_active",
    )
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!row || row.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }
  if (!row.is_active) {
    return fail("credential_inactive", t("Credential desativada."), 409, { requestId });
  }

  // Leitura direta + decifragem (sem passar pelo gate `validated_at` do
  // loadCredential — revalidate aceita credenciais ainda não validadas).
  let apiKey: string;
  try {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(row.api_key_encrypted),
      iv: byteaToBuffer(row.api_key_iv),
      tag: byteaToBuffer(row.api_key_tag),
    });
  } catch (err) {
    // Só a CLASSE do erro: a mensagem e o objeto de uma falha de decifragem
    // podem carregar material da credencial.
    logger.error("[ai.credentials] decrypt failed during revalidate", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      classe: err instanceof Error ? err.name : "desconhecida",
    });
    return fail("decrypt_failed", t("Falha ao decifrar credential."), 500, { requestId });
  }

  // A chave de voz do telefone (ElevenLabs) não é de modelo de linguagem:
  // `validateProviderKey` devolveria `unknown_provider` e marcaria inválida uma
  // chave boa. Ela é conferida pela MESMA régua do cadastro — listar as vozes da
  // conta. A resposta é a do ramo de modelo (200 com `validation_error`), para a
  // tela tratar os dois iguais.
  if (row.provider === PROVEDOR_DE_VOZ) {
    const voz = await validarChaveDeVoz(apiKey);
    // Só a RECUSA da chave a desvalida. ElevenLabs fora do ar, erro dela ou
    // conta sem crédito registram o motivo e mantêm `validated_at`: a chave
    // continua sendo a certa, e desvalidá-la por uma queda do provedor seria
    // punir o cliente pelo problema de outro.
    const patchDeVoz = voz.ok
      ? { validated_at: new Date().toISOString(), validation_error: null }
      : voz.motivo === "chave_invalida"
        ? { validated_at: null, validation_error: voz.motivo }
        : { validation_error: voz.motivo };
    const { data: atualizada, error: erroDeVoz } = await admin
      .from("ai_provider_credentials")
      .update(patchDeVoz)
      .eq("id", id)
      .eq("organization_id", activeOrg.orgId)
      .select(SAFE_COLUMNS)
      .single();
    if (erroDeVoz || !atualizada) {
      return fail("internal_error", "Erro ao atualizar credential.", 500, { requestId });
    }
    await audit({
      action: "ai.credential_revalidated",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "ai_provider_credential",
      resourceId: id,
      requestId,
      metadata: { provider: row.provider, label: row.label, ok: voz.ok, error: voz.ok ? null : voz.motivo },
    });
    return ok(atualizada, { requestId });
  }

  const result = await validateProviderKey(row.provider, apiKey);
  const patch = result.ok
    ? {
        validated_at: new Date().toISOString(),
        validation_error: null,
        models_available: result.models,
      }
    : {
        validated_at: null,
        validation_error: result.error,
      };

  const { data: updated, error: updErr } = await admin
    .from("ai_provider_credentials")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(SAFE_COLUMNS)
    .single();

  if (updErr || !updated) {
    return fail("internal_error", "Erro ao atualizar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_revalidated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: {
      provider: row.provider,
      label: row.label,
      ok: result.ok,
      error: result.ok ? null : result.error,
    },
  });

  return ok(updated, { requestId });
}
