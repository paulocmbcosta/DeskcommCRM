/**
 * GET /api/v1/site-chat/[chave]/config — a aparência do widget, para o widget.
 *
 * ROTA PÚBLICA (ver `lib/auth/public-paths.ts`): quem chama é o `widget.js`
 * rodando no site de um terceiro, sem cookie e sem login. A organização sai da
 * CHAVE do path — fonte confiável, nunca do corpo (CLAUDE.md, multi-tenancy).
 *
 * É também o batimento de instalação: cada carga carimba "o widget foi visto no
 * site X" (no máximo uma escrita a cada 5 min), que é o que a tela de Conexões
 * mostra para o dono saber que o snippet colado está no ar.
 *
 * Casca fina de propósito — toda a regra mora em `lib/channels/chat-do-site/`.
 */
import { ok } from "@/lib/api/wrappers";
import { registrarSinalDoWidget } from "@/lib/channels/chat-do-site/canal";
import { configPublica } from "@/lib/channels/chat-do-site/config";
import {
  LIMITES,
  comCors,
  dentroDoLimite,
  preflight,
  resolverPedidoPublico,
} from "@/lib/channels/chat-do-site/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ chave: string }>;
}

export function OPTIONS(): Response {
  return preflight();
}

export async function GET(req: Request, { params }: RouteCtx): Promise<Response> {
  const { chave } = await params;
  const r = await resolverPedidoPublico(req, chave);
  if (!r.ok) return r.response;
  const { ctx } = r;

  const barrado = await dentroDoLimite(ctx, [
    ...(ctx.ip ? [{ chave: `site_chat:cfg:ip:${ctx.ip}`, limite: LIMITES.config.porIp, janelaS: LIMITES.config.janelaS }] : []),
    { chave: `site_chat:cfg:w:${ctx.canal.id}`, limite: LIMITES.config.porWidget, janelaS: LIMITES.config.janelaS },
  ]);
  if (barrado) return barrado;

  // Só carimba quando o navegador disse de onde vem: pedido sem `Origin` é
  // `curl` ou monitor, e gravá-lo diria "instalado" para um widget que ninguém
  // colou em site nenhum.
  if (ctx.site) await registrarSinalDoWidget(ctx.admin, ctx.canal, ctx.site);

  return ok(configPublica(ctx.canal.config), { requestId: ctx.requestId, headers: comCors() });
}
