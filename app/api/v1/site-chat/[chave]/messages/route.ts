/**
 * GET  /api/v1/site-chat/[chave]/messages — o que há de novo na MINHA conversa.
 * POST /api/v1/site-chat/[chave]/messages — o visitante escreve.
 *
 * ROTAS PÚBLICAS (ver `lib/auth/public-paths.ts`). A autorização inteira é o par
 * chave do widget (path) + token do visitante (header `X-Visitor-Token` — nunca
 * na query: query string fica em log de proxy, anti-pattern 12 do CLAUDE.md).
 *
 * O POST sem token ABRE conversa e devolve o token UMA vez. Depois disso o banco
 * só tem o SHA-256 dele (`lib/channels/chat-do-site/identidade.ts`).
 *
 * Audit log: a mensagem do visitante NÃO gera linha em `api_audit_log`, pelo
 * mesmo motivo por que a mensagem que chega pelo WhatsApp não gera — não é
 * mutação de um operador, é o dado do canal, e o rastro dela é a própria linha
 * de `messages` + `event_log` (`ai_agent.dispatch_requested`). Auditar cada
 * balão do visitante afogaria a auditoria no mesmo ruído que o achado 17 do
 * mapa de jornadas mediu nos crons.
 *
 * Casca fina — a regra mora em `lib/channels/chat-do-site/`.
 */
import { fail, ok } from "@/lib/api/wrappers";
import { conversaDoVisitante, ingerirMensagemDoVisitante } from "@/lib/channels/chat-do-site/entrada";
import {
  HEADER_DO_TOKEN,
  LIMITES,
  MAXIMO_DO_CORPO_BYTES,
  baldeDoToken,
  comCors,
  corpoDoEnvioSchema,
  dentroDoLimite,
  preflight,
  resolverPedidoPublico,
} from "@/lib/channels/chat-do-site/http";
import { threadDoVisitante } from "@/lib/channels/chat-do-site/identidade";
import { lerMensagensDoVisitante } from "@/lib/channels/chat-do-site/leitura";
import { logger } from "@/lib/logger";

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

  if (!ctx.token) {
    return fail("unauthenticated", "Token do visitante ausente ou inválido.", 401, {
      requestId: ctx.requestId,
      headers: comCors(),
    });
  }

  const barrado = await dentroDoLimite(ctx, [
    {
      chave: `site_chat:ler:${baldeDoToken(threadDoVisitante(ctx.token))}`,
      limite: LIMITES.leitura.porToken,
      janelaS: LIMITES.leitura.janelaS,
    },
  ]);
  if (barrado) return barrado;

  try {
    const conversa = await conversaDoVisitante(ctx.admin, ctx.canal, ctx.token);
    if (!conversa) {
      return fail("unauthenticated", "Conversa não encontrada para este token.", 401, {
        requestId: ctx.requestId,
        headers: comCors(),
      });
    }

    const after = new URL(req.url).searchParams.get("after");
    const depoisDe = after && !Number.isNaN(Date.parse(after)) ? after : null;

    const mensagens = await lerMensagensDoVisitante(ctx.admin, {
      organizationId: ctx.canal.organizationId,
      conversationId: conversa.id,
      depoisDe,
    });
    return ok(mensagens, { requestId: ctx.requestId, headers: comCors() });
  } catch (err) {
    logger.error("[site-chat] leitura falhou", {
      request_id: ctx.requestId,
      channel_session_id: ctx.canal.id,
      detail: err instanceof Error ? err.message.slice(0, 200) : "desconhecido",
    });
    return fail("internal_error", "Erro ao carregar as mensagens.", 500, {
      requestId: ctx.requestId,
      headers: comCors(),
    });
  }
}

export async function POST(req: Request, { params }: RouteCtx): Promise<Response> {
  const { chave } = await params;
  const r = await resolverPedidoPublico(req, chave);
  if (!r.ok) return r.response;
  const { ctx } = r;

  // Token presente e MALFORMADO não abre conversa nova em silêncio: o widget
  // precisa saber que o que ele guardou não presta, para limpar e recomeçar.
  if (!ctx.token && req.headers.get(HEADER_DO_TOKEN)) {
    return fail("unauthenticated", "Token do visitante inválido.", 401, {
      requestId: ctx.requestId,
      headers: comCors(),
    });
  }

  // Rota ANÔNIMA: o tamanho do corpo é conferido ANTES de virar objeto. Sem isto,
  // qualquer um faz o servidor parsear megabytes de JSON por pedido, de graça.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  const texto = declarado > MAXIMO_DO_CORPO_BYTES ? null : await req.text().catch(() => null);
  if (texto === null || texto.length > MAXIMO_DO_CORPO_BYTES) {
    return fail("payload_too_large", "Mensagem grande demais.", 413, {
      requestId: ctx.requestId,
      headers: comCors(),
    });
  }
  let bruto: unknown = null;
  try {
    bruto = JSON.parse(texto);
  } catch {
    bruto = null;
  }
  const parsed = corpoDoEnvioSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", "Mensagem inválida.", 422, {
      requestId: ctx.requestId,
      headers: comCors(),
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const corpo = parsed.data;

  // Campo-isca preenchido: responde como se tivesse dado certo e não grava nada.
  // Um 4xx ensinaria o robô a parar de preencher o campo.
  if (corpo.website) {
    return ok({ visitor_token: null, message: null }, { requestId: ctx.requestId, status: 201, headers: comCors() });
  }

  const barrado = await dentroDoLimite(
    ctx,
    ctx.token
      ? [
          {
            chave: `site_chat:env:${baldeDoToken(threadDoVisitante(ctx.token))}`,
            limite: LIMITES.envio.porToken,
            janelaS: LIMITES.envio.janelaS,
          },
        ]
      : [
          ...(ctx.ip
            ? [
                {
                  chave: `site_chat:nova:ip:${ctx.ip}`,
                  limite: LIMITES.conversaNova.porIp,
                  janelaS: LIMITES.conversaNova.janelaS,
                },
              ]
            : []),
          {
            chave: `site_chat:nova:w:${ctx.canal.id}`,
            limite: LIMITES.conversaNova.porWidget,
            janelaS: LIMITES.conversaNova.janelaS,
          },
        ],
  );
  if (barrado) return barrado;

  try {
    const desfecho = await ingerirMensagemDoVisitante(ctx.admin, {
      canal: ctx.canal,
      token: ctx.token,
      clientMessageId: corpo.client_message_id,
      texto: corpo.body,
      visitante: corpo.visitante,
      pagina: corpo.pagina,
      requestId: ctx.requestId,
    });

    if (desfecho.status === "token_desconhecido") {
      return fail("unauthenticated", "Conversa não encontrada para este token.", 401, {
        requestId: ctx.requestId,
        headers: comCors(),
      });
    }

    return ok(
      { visitor_token: desfecho.tokenNovo, message: desfecho.mensagem },
      { requestId: ctx.requestId, status: desfecho.status === "ingested" ? 201 : 200, headers: comCors() },
    );
  } catch (err) {
    logger.error("[site-chat] envio do visitante falhou", {
      request_id: ctx.requestId,
      channel_session_id: ctx.canal.id,
      detail: err instanceof Error ? err.message.slice(0, 200) : "desconhecido",
    });
    return fail("internal_error", "Não foi possível enviar a mensagem.", 500, {
      requestId: ctx.requestId,
      headers: comCors(),
    });
  }
}
