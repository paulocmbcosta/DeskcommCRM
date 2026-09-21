/**
 * O trecho de HTML que o dono cola no site — montado no SERVIDOR.
 *
 * ─── Por que o endereço não pode sair de `process.env` no cliente ───────────
 *
 * `NEXT_PUBLIC_*` é substituída no BUILD, e a imagem genérica do self-host é
 * construída com `https://placeholder.invalid` (Dockerfile). Um snippet montado
 * no navegador a partir dessa variável apontaria o `<script src>` para o nada:
 * o dono colaria no site, não apareceria balão nenhum, e não haveria erro em
 * lugar nenhum. É o mesmo defeito que `app/api/v1/channels/partner/route.ts`
 * documenta para a URL de webhook, e a saída é a mesma: `env.*` (parseado em
 * runtime) e, na falta, o host por onde a própria tela está sendo servida.
 */
import { env } from "@/lib/env";

export const CAMINHO_DO_SCRIPT = "/site-chat/widget.js";

export function enderecoPublico(req: { headers: Headers; url: string }): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  const daRequisicao = (() => {
    try {
      const u = new URL(req.url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "";
    }
  })();
  return (usavel ?? req.headers.get("origin") ?? daRequisicao).replace(/\/+$/, "");
}

/**
 * `async`: o widget nunca pode segurar o carregamento do site do cliente.
 * A chave é `[a-zA-Z0-9_]` por construção (`identidade.ts`) e a base vem do
 * servidor, então não há o que escapar — mas quem monta é só esta função, para
 * que a garantia continue sendo de um lugar só.
 */
export function snippetDoWidget(base: string, chave: string): string {
  return `<script async src="${base}${CAMINHO_DO_SCRIPT}" data-widget-key="${chave}"></script>`;
}
