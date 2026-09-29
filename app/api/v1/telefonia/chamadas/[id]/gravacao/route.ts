/**
 * GET /api/v1/telefonia/chamadas/[id]/gravacao — OUVIR a gravação de uma
 * ligação: devolve uma URL assinada de 10 min e deixa uma linha na auditoria
 * (`phone.recording_listened`) — a "escuta auditada" da F3 (spec 20; desenho
 * docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md, D6).
 *
 * Quem ouve: papel atendente ou acima (`viewer` não) E quem ENXERGA a conversa.
 * A segunda parte é da RLS, não daqui: a mensagem da ligação é lida pelo cliente
 * de SESSÃO, e a visibilidade por time (0281) decide se ela volta. Não voltou →
 * 404, sem dizer se a ligação existe.
 *
 * Nunca o caminho do arquivo na resposta nem na auditoria: só a URL assinada,
 * que vence. O caminho ainda precisa morar debaixo de `<org>/<conversa>/` — a
 * mesma régua do envio de mídia —, para uma linha gravada por fora não virar
 * porta para o arquivo de outra conversa.
 *
 * A rota genérica de mídia (`/api/v1/messages/[id]/media`) RECUSA a mensagem de
 * ligação: sem isso, ela serviria a gravação sem piso de papel nem auditoria.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { BUCKET_DAS_GRAVACOES } from "@/lib/telefonia/gravacao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Quanto vale a URL: o suficiente para ouvir uma ligação longa com pausas. */
const VALIDADE_DA_URL_S = 600;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_gravacao_escuta" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const naoHa = () => fail("not_found", t("Gravação não encontrada."), 404, { requestId });

  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return naoHa();
  const vcId = id.data;
  const org = authz.org.orgId;

  const supabase = await createClient();
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, conversation_id, media_storage_path")
    .eq("organization_id", org)
    .eq("external_id", `ligacao:${vcId}`)
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao buscar a gravação."), 500, { requestId });
  const caminho = msg?.media_storage_path;
  if (!msg || !caminho || !msg.conversation_id || !isMediaPathOwnedBy(caminho, org, msg.conversation_id)) return naoHa();

  const { data: assinada, error: erroDaAssinatura } = await createAdminClient()
    .storage.from(BUCKET_DAS_GRAVACOES)
    .createSignedUrl(caminho, VALIDADE_DA_URL_S);
  if (erroDaAssinatura || !assinada?.signedUrl) {
    logger.warn("telefonia: URL da gravação não assinada", { voice_call: vcId, erro: erroDaAssinatura?.message });
    return fail("bad_gateway", t("A gravação está indisponível no momento. Tente de novo em instantes."), 502, { requestId });
  }

  void audit({
    action: "phone.recording_listened",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "voice_call",
    resourceId: vcId,
    metadata: { conversation_id: msg.conversation_id },
    requestId,
  });
  return ok(
    { url: assinada.signedUrl, expira_em: new Date(Date.now() + VALIDADE_DA_URL_S * 1000).toISOString() },
    { requestId },
  );
}
