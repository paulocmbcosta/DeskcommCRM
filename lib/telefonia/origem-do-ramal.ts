/**
 * De onde pode vir o WebSocket do ramal (spec 20 §4.3) — função pura.
 *
 * O WebSocket não tem CORS: qualquer página da internet abre
 * `new WebSocket("wss://crm.cliente.com/telefonia/ws")`, e o navegador manda
 * junto o cookie de sessão de quem está logado no CRM (é o mesmo site). Sem
 * conferir a origem, a autorização por sessão sozinha deixaria um site de
 * terceiro usar o ramal do atendente pelo navegador dele — o "WebSocket
 * cross-site". A única coisa que a página de fora não consegue forjar é o
 * cabeçalho `Origin`, que o navegador escreve sozinho.
 *
 * Sem `Origin` passa: navegador sempre o manda num WebSocket, então a ausência
 * é de cliente que não é navegador — e esse não tem o cookie de ninguém.
 */
export function origemDoRamalPermitida(origin: string | null, hostDaRequisicao: string | null): boolean {
  if (origin === null) return true;
  if (!hostDaRequisicao) return false;
  let host: string;
  try {
    // `null` literal (página em sandbox, `file://`) não é URL e cai aqui.
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host.toLowerCase() === hostDaRequisicao.trim().toLowerCase();
}

/**
 * O host que o navegador pediu. Atrás do proxy, o `x-forwarded-host` — o
 * Caddy e o Traefik o preenchem com o `Host` original, e uma página de outro
 * site não tem como pôr cabeçalho próprio num WebSocket. Mesma leitura de
 * `wsDoNavegador`, em `app/api/v1/telefonia/ramal/route.ts`.
 */
export function hostDaRequisicao(headers: Headers): string | null {
  const encaminhado = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return encaminhado || headers.get("host");
}
