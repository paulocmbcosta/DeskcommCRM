/**
 * A casca HTTP das rotas PÚBLICAS do chat do site — o que as três têm em comum.
 *
 * Estas são as únicas rotas do produto chamadas por `fetch` a partir do site de
 * um TERCEIRO, então são as únicas com CORS. O resto da API não tem, e não deve
 * ganhar: CORS aberto numa rota de cookie é CSRF com convite.
 *
 * ─── Por que `Access-Control-Allow-Origin: *` é seguro AQUI ─────────────────
 *
 * Nenhuma destas rotas lê cookie (`credentials: "omit"` no widget, e nada aqui
 * chama `createClient()` de sessão). A autorização inteira é o par chave do
 * widget + token do visitante, os dois em header/path — credencial que o site
 * hospedeiro já tem por construção. `*` com credenciais o navegador recusa; sem
 * credenciais, `*` só diz "qualquer página pode FAZER o pedido", e quem decide
 * se ele é atendido é `origemPermitida`, no servidor.
 *
 * ─── Rate limit: dois baldes, porque um só mente ────────────────────────────
 *
 * Por IP quando há IP; por chave do widget SEMPRE. O kit self-host sem proxy
 * na frente não tem `x-forwarded-for` (ver `lib/auth/rate-limit.ts`), e um
 * limite só-por-IP viraria limite nenhum justamente na instalação mais simples.
 * O balde por widget é o teto que vale em qualquer topologia.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

import { canalPelaChave, type CanalPublico } from "./canal";
import { origemPermitida } from "./config";
import { chaveDoWidgetTemForma, tokenDoVisitanteTemForma } from "./identidade";

export const HEADER_DO_TOKEN = "x-visitor-token";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Visitor-Token",
  "Access-Control-Max-Age": "86400",
  // A resposta depende do `Origin` (lista de domínios do dono): cache
  // compartilhado não pode servir a de um site para outro.
  Vary: "Origin",
};

export function comCors(extra?: Record<string, string>): Record<string, string> {
  return { ...CORS, "Cache-Control": "no-store", ...extra };
}

/** Resposta do preflight. Sem corpo, sem consulta a banco. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** Limites por janela. Nomeados para o teste poder prender os valores. */
export const LIMITES = {
  /** Carga de configuração — uma por página aberta. */
  config: { porIp: 120, porWidget: 3000, janelaS: 60 },
  /** Sondagem: o widget aberto pergunta a cada 3s (20/min). Folga de 3×. */
  leitura: { porToken: 60, janelaS: 60 },
  /** Mensagens numa conversa que já existe. */
  envio: { porToken: 20, janelaS: 60 },
  /**
   * Conversa NOVA — o pedido caro: cria contato, conversa, lead e pode acordar o
   * agente de IA (custo por token). É o alvo de quem quer encher o inbox de lixo.
   */
  conversaNova: { porIp: 5, porWidget: 60, janelaS: 600 },
} as const;

export interface ContextoPublico {
  requestId: string;
  admin: ReturnType<typeof createAdminClient>;
  canal: CanalPublico;
  /** `hostname` do `Origin`, quando o navegador mandou. */
  site: string | null;
  ip: string | null;
  /** Token do visitante já com a FORMA conferida; `null` = não veio. */
  token: string | null;
}

export type ResolucaoPublica = { ok: true; ctx: ContextoPublico } | { ok: false; response: Response };

function recusar(
  code: Parameters<typeof fail>[0],
  message: string,
  status: number,
  requestId: string,
  extra?: Record<string, string>,
): ResolucaoPublica {
  return { ok: false, response: fail(code, message, status, { requestId, headers: comCors(extra) }) };
}

/**
 * Chave do path → canal + organização, com as recusas que valem para as três
 * rotas. A ORDEM é barata-primeiro: forma da chave (sem I/O) → banco → origem.
 *
 * 404 tanto para chave malformada quanto para chave inexistente ou arquivada:
 * distinguir os três diria a quem enumera quais chaves "quase" existem.
 */
export async function resolverPedidoPublico(req: Request, chave: string): Promise<ResolucaoPublica> {
  const requestId = randomUUID();
  if (!chaveDoWidgetTemForma(chave)) return recusar("not_found", "Widget não encontrado.", 404, requestId);

  const admin = createAdminClient();
  let canal: CanalPublico | null;
  try {
    canal = await canalPelaChave(admin, chave);
  } catch {
    return recusar("internal_error", "Erro ao carregar o widget.", 500, requestId);
  }
  if (!canal) return recusar("not_found", "Widget não encontrado.", 404, requestId);

  const origin = req.headers.get("origin");
  if (!origemPermitida(origin, canal.config.dominios_permitidos)) {
    return recusar("forbidden", "Este site não está autorizado a usar este widget.", 403, requestId);
  }

  let site: string | null = null;
  if (origin) {
    try {
      site = new URL(origin).hostname.toLowerCase().slice(0, 253);
    } catch {
      site = null;
    }
  }

  const bruto = req.headers.get(HEADER_DO_TOKEN);
  // Token presente e MALFORMADO é tratado como ausente só na rota de envio (que
  // então abre conversa nova); quem exige token decide o 401 por conta própria.
  const token = tokenDoVisitanteTemForma(bruto) ? bruto : null;

  return { ok: true, ctx: { requestId, admin, canal, site, ip: ipDoCliente(req.headers), token } };
}

/** `true` = passou. Falso devolve a 429 pronta, já com CORS e `Retry-After`. */
export async function dentroDoLimite(
  ctx: ContextoPublico,
  baldes: Array<{ chave: string; limite: number; janelaS: number }>,
): Promise<Response | null> {
  for (const b of baldes) {
    const r = await checkRateLimit(b.chave, b.limite, b.janelaS);
    if (!r.allowed) {
      return fail("rate_limited", "Muitos pedidos em pouco tempo. Tente de novo em instantes.", 429, {
        requestId: ctx.requestId,
        headers: comCors({
          "Retry-After": String(b.janelaS),
          "X-RateLimit-Limit": String(b.limite),
          "X-RateLimit-Remaining": "0",
        }),
      });
    }
  }
  return null;
}

/** Identificador curto do token para chave de balde — nunca o token em si no Redis. */
export function baldeDoToken(thread: string): string {
  return thread.slice(-24);
}

const textoCurto = (max: number) => z.string().trim().max(max);

/**
 * O corpo do envio. Estrito no que importa (texto, id de idempotência) e
 * tolerante no resto: campo opcional malformado é DESCARTADO, não motivo de
 * 422 — o visitante não tem como consertar um `utm` torto que o site dele
 * gerou, e perder a mensagem por isso seria punir a pessoa errada.
 */
export const corpoDoEnvioSchema = z.object({
  body: z.string().trim().min(1, "mensagem vazia").max(4000),
  client_message_id: z.string().uuid(),
  visitante: z
    .object({
      nome: textoCurto(120).optional(),
      email: textoCurto(254).optional(),
      telefone: textoCurto(32).optional(),
    })
    .partial()
    .optional()
    .catch(undefined),
  pagina: z
    .object({
      url: textoCurto(500).optional(),
      titulo: textoCurto(200).optional(),
      utm: z.record(z.string().regex(/^utm_[a-z_]{1,20}$/), textoCurto(120)).optional().catch(undefined),
    })
    .partial()
    .optional()
    .catch(undefined),
  /** Campo-isca: gente não vê, robô preenche. Preenchido = descarta em silêncio. */
  website: z.string().max(200).optional().catch(undefined),
});

export type CorpoDoEnvio = z.infer<typeof corpoDoEnvioSchema>;
