import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/site-chat — os widgets de chat do site desta organização.
 * POST /api/v1/channels/site-chat — cria um widget e devolve o trecho para colar.
 *
 * Casca: quais colunas o canal usa, como a chave nasce e o que é uma
 * configuração válida moram em `lib/channels/chat-do-site/`. Esta rota não
 * nomeia provider nem coluna de provider — o `lint:channels` reprovaria.
 *
 * Admin: criar um canal abre uma porta pública para dentro do atendimento da
 * empresa. É decisão de dono, como conectar um número.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  MAXIMO_DE_CANAIS_DO_SITE,
  criarCanalDoSite,
  listarCanaisDoSite,
  type CanalDoSite,
} from "@/lib/channels/chat-do-site/canal";
import { CONFIG_PADRAO_DO_WIDGET, configDoWidgetSchema } from "@/lib/channels/chat-do-site/config";
import { enderecoPublico, snippetDoWidget } from "@/lib/channels/chat-do-site/snippet";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const criarSchema = z.object({
  nome: z.string().trim().min(1).max(60),
  config: configDoWidgetSchema.optional(),
});

function paraResposta(canal: CanalDoSite, base: string) {
  return {
    id: canal.id,
    nome: canal.nome,
    widget_key: canal.chave,
    config: canal.config,
    snippet: snippetDoWidget(base, canal.chave),
    created_at: canal.criadoEm,
    last_seen: canal.ultimoSinal ? { at: canal.ultimoSinal.em, site: canal.ultimoSinal.site } : null,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_site_chat", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;

  try {
    const canais = await listarCanaisDoSite(createAdminClient(), authz.org.orgId);
    const base = enderecoPublico(req);
    return ok(
      { canais: canais.map((c) => paraResposta(c, base)), config_padrao: CONFIG_PADRAO_DO_WIDGET },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Erro ao listar os canais do site.", 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_site_chat", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = criarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const admin = createAdminClient();
  try {
    const existentes = await listarCanaisDoSite(admin, authz.org.orgId);
    if (existentes.length >= MAXIMO_DE_CANAIS_DO_SITE) {
      return fail("limit_reached", t("Limite de chats do site atingido. Exclua um para criar outro."), 422, { requestId });
    }

    const canal = await criarCanalDoSite(admin, {
      organizationId: authz.org.orgId,
      nome: parsed.data.nome,
      config: parsed.data.config,
      criadoPor: authz.user.id,
    });

    void audit({
      action: "channel.site_chat_created",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: canal.id,
      requestId,
      metadata: { nome: canal.nome },
    });

    return ok(paraResposta(canal, enderecoPublico(req)), { requestId, status: 201 });
  } catch {
    return fail("internal_error", "Erro ao criar o chat do site.", 500, { requestId });
  }
}
