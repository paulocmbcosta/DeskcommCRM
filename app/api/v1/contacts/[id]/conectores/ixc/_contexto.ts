/**
 * O que as três rotas do painel do IXC precisam antes de fazer qualquer coisa:
 * quem é o usuário, de qual organização, qual contato — e a credencial do IXC
 * DESSA organização.
 *
 * A ordem é a segurança: o contato é lido com o client de SESSÃO, então a RLS
 * decide se este usuário o enxerga; só depois o admin client (que ignora RLS) lê
 * a credencial, já filtrando pela organização que veio da sessão. O id do
 * contato vem da URL e a organização NUNCA vem do pedido.
 */
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carimbarEstado, lerCredencial, type CredencialGuardada } from "@/lib/conectores/conexao";
import { FRASE_DA_FALHA, FalhaDoConector } from "@/lib/conectores/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

export type ContextoIxc =
  | {
      ok: true;
      userId: string;
      orgId: string;
      admin: Admin;
      credencial: CredencialGuardada;
      contato: { id: string; phone_number: string | null };
      t: (texto: string) => string;
      idioma: Parameters<typeof traduzir>[1];
    }
  | { ok: false; response: Response };

export async function contextoIxc(contactId: string, requestId: string): Promise<ContextoIxc> {
  const authz = await requireRole("agent", { requestId, resource: "conector_ixc" });
  if (!authz.ok) return { ok: false, response: authz.response };
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.string().uuid().safeParse(contactId).success) {
    return { ok: false, response: fail("not_found", t("Contato não encontrado."), 404, { requestId }) };
  }

  const supabase = await createClient();
  const { data: contato, error } = await supabase
    .from("contacts")
    .select("id, phone_number, is_anonymized")
    .eq("id", contactId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return { ok: false, response: fail("internal_error", error.message, 500, { requestId }) };
  if (!contato || contato.is_anonymized) {
    return { ok: false, response: fail("not_found", t("Contato não encontrado."), 404, { requestId }) };
  }

  const admin = createAdminClient();
  let credencial: CredencialGuardada | null;
  try {
    credencial = await lerCredencial(admin, authz.org.orgId, "ixc");
  } catch {
    return { ok: false, response: fail("internal_error", "Erro ao ler a conexão.", 500, { requestId }) };
  }
  if (!credencial) {
    return {
      ok: false,
      response: fail("conector_desligado", t("O IXC não está ligado nesta organização."), 404, { requestId }),
    };
  }

  return {
    ok: true,
    userId: authz.user.id,
    orgId: authz.org.orgId,
    admin,
    credencial,
    contato: { id: contato.id, phone_number: contato.phone_number },
    t,
    idioma: authz.user.idioma,
  };
}

/**
 * A falha do ERP vira resposta E vira estado. 502 com `details.motivo`, para a
 * tela dizer a coisa certa; e o carimbo `erro` na conexão, para o admin ver em
 * Configurações o que o atendente viu no painel (o laço de retorno da peça).
 * `recurso_indisponivel` NÃO carimba: é uma tabela fora do escopo do token, e
 * `montarResumo` já trata isso por seção — aqui só chega se for o cadastro.
 */
export async function respostaDaFalha(
  err: unknown,
  ctx: Extract<ContextoIxc, { ok: true }>,
  requestId: string,
): Promise<Response> {
  if (err instanceof FalhaDoConector) {
    await carimbarEstado(ctx.admin, ctx.orgId, "ixc", "erro", err.motivo);
    return fail("conector_indisponivel", ctx.t(FRASE_DA_FALHA[err.motivo]), 502, {
      requestId,
      details: { motivo: err.motivo },
    });
  }
  return fail("internal_error", "Erro ao consultar o IXC.", 500, { requestId });
}

/** A leitura funcionou e a conexão estava marcada `erro`: o ERP voltou — a marca sai. */
export async function limparErroSeHavia(ctx: Extract<ContextoIxc, { ok: true }>): Promise<void> {
  if (ctx.credencial.status === "erro") await carimbarEstado(ctx.admin, ctx.orgId, "ixc", "ativa", null);
}
