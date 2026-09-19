/**
 * POST /api/v1/conectores/[conector]/conexao/testar — prova a conexão GUARDADA.
 *
 * É o botão "Testar conexão" da tela de Conectores, e é também quem limpa o
 * estado `erro`: o painel do atendente carimba `erro` quando o ERP recusa o
 * token, e o admin, depois de consertar do lado de lá, confirma aqui.
 *
 * Não é mutação de negócio — não audita. O carimbo de estado é o registro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carimbarEstado, lerConexaoPublica, lerCredencial } from "@/lib/conectores/conexao";
import { obterConector } from "@/lib/conectores/registro";
import { FRASE_DA_FALHA } from "@/lib/conectores/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ conector: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const conector = obterConector((await ctx.params).conector);
  if (!conector) return fail("conector_desconhecido", t("Conector desconhecido."), 404, { requestId });

  try {
    const admin = createAdminClient();
    const orgId = authz.org.orgId;
    const credencial = await lerCredencial(admin, orgId, conector.id);
    if (!credencial) return fail("conector_desligado", t("Este conector não está ligado."), 404, { requestId });

    const teste = await conector.testar(credencial);
    await carimbarEstado(admin, orgId, conector.id, teste.ok ? "ativa" : "erro", teste.ok ? null : teste.motivo);

    return ok(
      {
        funcionou: teste.ok,
        motivo: teste.ok ? null : teste.motivo,
        mensagem: teste.ok ? t("Conexão funcionando.") : t(FRASE_DA_FALHA[teste.motivo]),
        conexao: await lerConexaoPublica(admin, orgId, conector.id),
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Erro ao testar a conexão.", 500, { requestId });
  }
}
