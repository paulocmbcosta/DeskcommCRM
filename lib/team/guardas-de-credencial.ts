/**
 * As duas guardas que as rotas de CREDENCIAL da equipe (cadastrar com senha,
 * definir nova senha) têm e as outras rotas de equipe não precisam.
 *
 * O que torna estas rotas diferentes: elas terminam com uma senha que QUEM
 * CHAMOU conhece. Um erro de autorização aqui não vaza um dado — entrega uma
 * conta.
 */
import type { AuthUser } from "@/lib/auth/types";

/**
 * O corpo tem de ser JSON declarado. `request.json()` aceita `text/plain`, que
 * um `<form>` de outro site manda SEM preflight de CORS; exigir
 * `application/json` obriga o preflight, que este servidor não concede. O
 * cookie é SameSite=Strict, mas um subdomínio irmão é o MESMO site — e esta é a
 * primeira rota em que um CSRF às cegas entregaria uma credencial conhecida
 * (um admin com a senha que o atacante escolheu).
 */
export function corpoEhJson(req: Request): boolean {
  const tipo = req.headers.get("content-type") ?? "";
  return /^application\/json\b/i.test(tipo.trim());
}

/**
 * Acompanhamento administrativo (suporte personificando a organização) não
 * cria credencial nem troca senha — nem em acesso total. A sessão de
 * acompanhamento tem prazo; uma conta com senha conhecida não tem, e criar uma
 * daqui transformaria acesso temporário em permanente, em nome de outra pessoa.
 */
export function emAcompanhamento(user: AuthUser): boolean {
  return Boolean(user.support);
}
