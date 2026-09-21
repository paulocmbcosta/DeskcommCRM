import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/channels/site-chat/[id] — muda o nome e/ou a aparência do widget.
 *
 * A configuração vai INTEIRA (não é merge de campos): a tela edita o objeto todo
 * e o schema é estrito, então "o que está gravado" é sempre uma configuração que
 * passou pela validação de uma vez só — nunca a soma de dois PATCHes parciais
 * que ninguém validou juntos.
 *
 * Excluir NÃO mora aqui: `DELETE /api/v1/channel-sessions/[id]` já é o caminho
 * único de exclusão de canal (com o preflight de impacto — agentes e regras
 * amarrados ao canal), e um segundo caminho seria o que esquece metade disso.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarCanalDoSite } from "@/lib/channels/chat-do-site/canal";
import { configDoWidgetSchema } from "@/lib/channels/chat-do-site/config";
import { enderecoPublico, snippetDoWidget } from "@/lib/channels/chat-do-site/snippet";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const atualizarSchema = z
  .object({
    nome: z.string().trim().min(1).max(60).optional(),
    config: configDoWidgetSchema.optional(),
  })
  .refine((v) => v.nome !== undefined || v.config !== undefined, { message: "nada a atualizar" });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_site_chat", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Canal não encontrado."), 404, { requestId });
  }

  const parsed = atualizarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const canal = await atualizarCanalDoSite(createAdminClient(), {
      // Da SESSÃO, nunca do corpo: é o filtro que impede o id de outra
      // organização de ser editado por um client que bypassa RLS.
      organizationId: authz.org.orgId,
      id,
      nome: parsed.data.nome,
      config: parsed.data.config,
    });
    if (!canal) return fail("not_found", t("Canal não encontrado."), 404, { requestId });

    void audit({
      action: "channel.site_chat_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: canal.id,
      requestId,
      metadata: { campos: Object.keys(parsed.data) },
    });

    return ok(
      {
        id: canal.id,
        nome: canal.nome,
        widget_key: canal.chave,
        config: canal.config,
        snippet: snippetDoWidget(enderecoPublico(req), canal.chave),
        created_at: canal.criadoEm,
        last_seen: canal.ultimoSinal ? { at: canal.ultimoSinal.em, site: canal.ultimoSinal.site } : null,
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Erro ao salvar o chat do site.", 500, { requestId });
  }
}
