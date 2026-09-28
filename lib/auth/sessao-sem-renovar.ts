/**
 * AUTORIZAR SEM RENOVAR A SESSÃO — para quem responde a um proxy, não ao navegador.
 *
 * O porteiro do WebSocket do ramal (`app/api/v1/telefonia/ws/autorizar`) é
 * chamado pelo `forward_auth` do Caddy e pelo `forwardAuth` do Traefik. A
 * resposta dele volta para o PROXY, e o proxy não repassa nenhum cabeçalho dela
 * ao navegador — `Set-Cookie` inclusive. `requireRole` não serve aqui por causa
 * disso: ele carrega a sessão do cookie, e o auth-js RENOVA a sessão que está a
 * menos de 90 s de vencer (`EXPIRY_MARGIN_MS` do `@supabase/auth-js` 2.116). A
 * renovação troca o refresh token no GoTrue; o par novo iria no `Set-Cookie`
 * que o proxy joga fora, e o navegador ficaria com o refresh token VELHO. No
 * próximo uso, passada a janela de reúso do GoTrue, o reúso de token já trocado
 * revoga a família inteira — o atendente é deslogado por ter aberto o telefone.
 * O `proxy.ts` faz a mesma renovação, e por isso a rota está em `PUBLIC_PATHS`.
 *
 * Então aqui NADA sabe renovar, por construção:
 *   - a sessão é lida do cookie como dado (`sessaoDoCookie`), sem cliente;
 *   - sessão ausente ou já vencida → 401. O JsSIP reconecta sozinho (2–30 s)
 *     e o sinal de vida do app, a cada 60 s, renova o cookie pelo caminho
 *     normal, que devolve o `Set-Cookie`. Token PERTO de vencer é aceito: nada
 *     aqui renova, e quem confere o `exp` de verdade é o GoTrue — recusar com
 *     folga só tirava o ramal do ar à toa (até ~90 s antes de o proxy renovar);
 *   - o resto usa um cliente que só tem o token de acesso — nenhum refresh
 *     token existe nele — e valida o token no GoTrue com `getUser(token)`.
 *
 * A REGRA de papel é a de `requireRole`, não uma cópia: a mesma consulta e a
 * mesma ordem de vínculos (`consultaDeMembros`), a mesma escolha da organização
 * ativa (`escolherMembroAtivo` + cookie `active_org`), o papel efetivo pela
 * mesma função do banco (`fn_user_role_in_org`) e a mesma dívida de MFA (tem
 * fator verificado e a sessão não é `aal2`). O que muda é de onde vem a
 * identidade. Duas diferenças deliberadas: acompanhamento de suporte é recusado
 * (a credencial do ramal nunca é entregue a ele — `requireSupportWrite` em
 * `POST /telefonia/ramal`), e a recusa não grava `authz.denied`, porque a
 * reconexão automática do JsSIP a repetiria a cada poucos segundos.
 */
import { combineChunks, stringFromBase64URL } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ACTIVE_ORG_COOKIE, consultaDeMembros, escolherMembroAtivo, lerMembros } from "@/lib/auth/server";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { readSupportContext } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { NOME_DO_COOKIE_DE_SESSAO } from "@/lib/supabase/server";


const PREFIXO_BASE64 = "base64-";

const sessaoGravada = z.object({
  access_token: z.string().min(1),
  /** Segundos desde a época — como o auth-js grava. */
  expires_at: z.number(),
});

export interface SessaoDoCookie {
  accessToken: string;
  expiraEmMs: number;
}

interface Cookie {
  name: string;
  value: string;
}

/**
 * A sessão como o `@supabase/ssr` a grava: um cookie ou pedaços `.0`, `.1`…
 * (`combineChunks` da própria lib junta), com o valor em `base64-<base64url>`
 * de um JSON. `null` para ausente ou ilegível — nunca lança.
 */
export async function sessaoDoCookie(cookies: Cookie[]): Promise<SessaoDoCookie | null> {
  const porNome = new Map(cookies.map((c) => [c.name, c.value]));
  const bruto = await combineChunks(NOME_DO_COOKIE_DE_SESSAO, (nome) => porNome.get(nome));
  if (!bruto) return null;
  try {
    const json = bruto.startsWith(PREFIXO_BASE64) ? stringFromBase64URL(bruto.slice(PREFIXO_BASE64.length)) : bruto;
    const lida = sessaoGravada.safeParse(JSON.parse(json));
    if (!lida.success) return null;
    return { accessToken: lida.data.access_token, expiraEmMs: lida.data.expires_at * 1000 };
  } catch {
    return null;
  }
}

/** O `aal` do token — só lido DEPOIS de o GoTrue validar o token em `getUser`. */
function nivelDoToken(token: string): string | null {
  try {
    const carga = JSON.parse(stringFromBase64URL(token.split(".")[1] ?? "")) as { aal?: unknown };
    return typeof carga.aal === "string" ? carga.aal : null;
  } catch {
    return null;
  }
}

/**
 * Um cliente que só conhece o token de acesso. Sem sessão guardada e sem
 * refresh token, ele NÃO TEM como renovar nada; as consultas ao banco vão com o
 * token no `Authorization`, como a pessoa (RLS e `auth.uid()` valem).
 */
export function clienteSoComToken(token: string): SupabaseClient {
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export type Autorizacao =
  | { ok: true; userId: string; orgId: string; role: Role }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string };

const negado = (status: 401 | 403 | 503, code: string, message: string): Autorizacao => ({
  ok: false,
  status,
  code,
  message,
});

export async function autorizarSemRenovar(entrada: {
  cookies: Cookie[];
  min: Role;
  agora?: number;
  /** Injetável nos testes; em produção, `clienteSoComToken`. */
  criarCliente?: (token: string) => SupabaseClient;
}): Promise<Autorizacao> {
  const { cookies, min, agora = Date.now(), criarCliente = clienteSoComToken } = entrada;

  const sessao = await sessaoDoCookie(cookies);
  if (!sessao) return negado(401, "unauthenticated", "Auth required.");
  if (sessao.expiraEmMs <= agora) {
    return negado(401, "session_expired", "A sessão venceu; o app a renova e o ramal tenta de novo.");
  }

  const cliente = criarCliente(sessao.accessToken);
  try {
    const { data, error } = await cliente.auth.getUser(sessao.accessToken);
    const user = data?.user;
    if (error || !user) {
      // Rede ou GoTrue fora do ar não é "não autenticado" — é indisponível.
      if (error?.name === "AuthRetryableFetchError") {
        return negado(503, "upstream_unavailable", "Não foi possível confirmar a sessão agora.");
      }
      return negado(401, "unauthenticated", "Auth required.");
    }

    if (await readSupportContext(cliente as Parameters<typeof readSupportContext>[0])) {
      return negado(403, "forbidden", "O acompanhamento de suporte não usa o ramal.");
    }

    const { data: linhas, error: erroDosVinculos } = await consultaDeMembros(cliente, user.id);
    if (erroDosVinculos) throw new Error(erroDosVinculos.message);
    const ativo = escolherMembroAtivo(
      lerMembros(linhas),
      cookies.find((c) => c.name === ACTIVE_ORG_COOKIE)?.value,
    );
    if (!ativo) return negado(403, "forbidden_tenant", "Sem organização ativa.");

    const { data: papel, error: erroDoPapel } = await cliente.rpc("fn_user_role_in_org", {
      p_org: ativo.organization_id,
    });
    if (erroDoPapel) throw new Error(erroDoPapel.message);
    if (!roleAtLeast(papel as string | null, min)) {
      return negado(403, "forbidden_role", `Permissão insuficiente. Requer role >= ${min}.`);
    }

    // A dívida de MFA de `mfaEmDivida`, lida do usuário validado e do token: tem
    // fator TOTP verificado e a sessão não provou o segundo fator.
    const temFator = (user.factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified");
    if (temFator && nivelDoToken(sessao.accessToken) !== "aal2") {
      return negado(
        403,
        "mfa_required",
        "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.",
      );
    }

    return { ok: true, userId: user.id, orgId: ativo.organization_id, role: papel as Role };
  } catch (e) {
    logger.warn("[auth] autorização sem renovar falhou — negando", {
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    return negado(503, "upstream_unavailable", "Não foi possível confirmar a permissão agora.");
  }
}
