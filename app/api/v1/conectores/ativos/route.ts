/**
 * GET /api/v1/conectores/ativos — quais conectores ESTA organização ligou.
 *
 * É a pergunta que o trilho do painel da conversa faz para decidir se ganha aba.
 * Organização sem conector recebe `[]` e a tela não muda em nada — é o que
 * mantém a imobiliária da instalação ao lado sem saber que o IXC existe.
 *
 * A aba abre CPF, financeiro e endereço de instalação, então é de `agent` para
 * cima. Mas a PERGUNTA é feita por toda tela de inbox, inclusive a do `viewer`:
 * responder 403 a ele viraria um toast de erro a cada carregamento e uma linha
 * `authz.denied` no audit por visita. Para quem não pode ver, a resposta honesta
 * é a mesma de quem não tem conector: nenhuma aba.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { conectoresLigados } from "@/lib/conectores/conexao";
import { obterConector } from "@/lib/conectores/registro";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  if (ROLE_RANK[authz.org.role] < ROLE_RANK.agent) return ok([], { requestId });

  try {
    const ligados = await conectoresLigados(createAdminClient(), authz.org.orgId);
    const ativos = ligados.flatMap((id) => {
      const c = obterConector(id);
      return c ? [{ id: c.id, rotulo: c.rotulo }] : [];
    });
    return ok(ativos, { requestId });
  } catch {
    return fail("internal_error", "Erro ao ler os conectores.", 500, { requestId });
  }
}
