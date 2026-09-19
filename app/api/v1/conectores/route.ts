/**
 * GET /api/v1/conectores — o catálogo de conectores e o estado da conexão desta
 * organização com cada um. Alimenta Configurações › Conectores (admin).
 *
 * O token NUNCA sai daqui: `ConexaoPublica` não tem o campo, só `token_last4`.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerConexaoPublica } from "@/lib/conectores/conexao";
import { listarConectores } from "@/lib/conectores/registro";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;

  try {
    const admin = createAdminClient();
    const conectores = await Promise.all(
      listarConectores().map(async (c) => ({
        id: c.id,
        rotulo: c.rotulo,
        descricao: c.descricao,
        ajuda_do_endereco: c.ajudaDoEndereco,
        ajuda_do_token: c.ajudaDoToken,
        conexao: await lerConexaoPublica(admin, authz.org.orgId, c.id),
      })),
    );
    return ok(conectores, { requestId });
  } catch {
    return fail("internal_error", "Erro ao ler os conectores.", 500, { requestId });
  }
}
