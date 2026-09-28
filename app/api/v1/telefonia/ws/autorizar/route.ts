/**
 * GET /api/v1/telefonia/ws/autorizar — o porteiro do WebSocket do ramal.
 *
 * Spec 20 §4.3. Quem chama não é a tela: é o proxy reverso, ANTES de entregar
 * `/telefonia/ws` ao Asterisk — o `forward_auth` do Caddyfile e o middleware
 * `forwardAuth` do `docker-compose.traefik.yml`. Os dois repassam os
 * cabeçalhos do navegador (cookie de sessão e `Origin` inclusive) e só abrem o
 * WebSocket com um 2xx daqui.
 *
 * Por que existe: até aqui o `/telefonia/ws` ia direto para o Asterisk, e
 * qualquer anônimo da internet abria um WebSocket SIP com o PABX — para tentar
 * senha de ramal, gastar os slots de conexão ou explorar o próprio Asterisk. A
 * senha do ramal continua sendo exigida pelo Asterisk depois disto; esta rota
 * tira da frente dele quem nem é atendente desta instalação.
 *
 * ESTA ROTA NUNCA RENOVA A SESSÃO. A resposta volta para o proxy, que não
 * repassa `Set-Cookie` ao navegador: uma renovação aqui trocaria o refresh
 * token no GoTrue e perderia o novo, e o reúso do velho revogaria a sessão do
 * atendente. Por isso não usa `requireRole` (que carrega a sessão do cookie) e
 * está em `PUBLIC_PATHS` (o `proxy.ts` também renovaria) — a autorização mora
 * em `lib/auth/sessao-sem-renovar.ts`, com a mesma regra de papel.
 *
 * 204 sem corpo = pode; 401 = sem sessão, ou sessão a menos de 2 min de vencer
 * (o app renova pelo caminho normal e o JsSIP reconecta); 403 = papel abaixo de
 * `agent`, MFA não provada, acompanhamento de suporte ou origem de outro site.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, noContent } from "@/lib/api/wrappers";
import { autorizarSemRenovar } from "@/lib/auth/sessao-sem-renovar";
import { hostDaRequisicao, origemDoRamalPermitida } from "@/lib/telefonia/origem-do-ramal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // A origem vem ANTES da sessão, e é o que fecha o WebSocket cross-site: a
  // página de outro site abre o socket e o navegador manda o cookie de quem
  // está logado — a sessão seria válida. Só o `Origin` a denuncia.
  if (!origemDoRamalPermitida(req.headers.get("origin"), hostDaRequisicao(req.headers))) {
    return fail("forbidden", "Origem não permitida.", 403, { requestId });
  }

  // `agent` é o mesmo piso de `POST /telefonia/ramal`, que entrega a credencial.
  const r = await autorizarSemRenovar({ cookies: req.cookies.getAll(), min: "agent" });
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  return noContent(requestId);
}
