/**
 * GET /api/v1/telefonia/voz/chave — a chave da ElevenLabs está cadastrada? (manager+; só os 4 últimos)
 * PUT /api/v1/telefonia/voz/chave — cadastra ou troca a chave (admin).
 *
 * Desenho da fase 2, §6.1 e §7. A chave é VALIDADA antes de gravar, listando as
 * vozes da conta: chave que a ElevenLabs recusa não é guardada. Uma por
 * organização (trocar substitui). O texto puro entra só no corpo deste PUT e sai
 * só no header da chamada à ElevenLabs; é cifrado com AI_CRED_AES_KEY e nunca volta.
 * A organização é a da sessão: o corpo aceita só `chave` (`strict`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { PROVEDOR_DE_VOZ, estadoDaChaveDeVoz, guardarChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { STATUS_DA_FALHA, validarChaveDeVoz } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const chaveSchema = z.object({ chave: z.string().trim().min(8).max(256) }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  return ok(await estadoDaChaveDeVoz(getRequestPool(), authz.org.orgId), { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // Sem `details`: o que a Zod diria do campo não ajuda a pessoa, e o corpo aqui
  // é uma credencial — nada dele volta na resposta.
  const parsed = chaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Cole a chave da ElevenLabs (pelo menos 8 caracteres)."), 422, { requestId });
  }

  const validacao = await validarChaveDeVoz(parsed.data.chave);
  if (!validacao.ok) {
    const { motivo } = validacao;
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
  }
  const { vozes } = validacao;

  const pool = getRequestPool();
  let guardada: Awaited<ReturnType<typeof guardarChaveDeVoz>>;
  try {
    guardada = await guardarChaveDeVoz(pool, {
      organizationId: authz.org.orgId,
      userId: authz.user.id,
      chave: parsed.data.chave,
    });
  } catch (e) {
    // Cifra (AI_CRED_AES_KEY) ou banco. O log leva só a classe do erro — nunca a
    // mensagem nem o objeto, que podem carregar o que estava sendo gravado.
    logger.error("[telefonia] chave da ElevenLabs não foi guardada", {
      organization_id: authz.org.orgId,
      request_id: requestId,
      classe: e instanceof Error ? e.name : "desconhecida",
    });
    return fail("internal_error", t("Não foi possível guardar a chave agora. Tente de novo em instantes."), 500, {
      requestId,
    });
  }

  void audit({
    action: "ai.credential_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_provider_credential",
    resourceId: guardada.id,
    metadata: { provider: PROVEDOR_DE_VOZ, last4: guardada.last4, substituiu: guardada.substituiu, vozes },
    requestId,
  });
  return ok(await estadoDaChaveDeVoz(pool, authz.org.orgId), { requestId });
}
