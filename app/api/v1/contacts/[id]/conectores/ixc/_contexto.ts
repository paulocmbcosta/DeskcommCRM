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
import { identidadeDoTelefone, type IdentidadeDoTelefone } from "@/lib/channels/capabilities";
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

/**
 * O telefone do contato é identidade no canal DESTA conversa — tri-estado, não
 * booleano. `"desconhecido"` é toda situação em que não dá para saber: sem
 * `conversationId` (aba antiga aberta depois de uma atualização da VPS, antes
 * de o navegador mandar `?conversa=`), id que não existe/não é deste contato
 * ou desta organização, sessão sem `provider` reconhecido pela matriz. SÓ
 * `"nao"` autoriza descartar um vínculo por telefone já gravado — colapsar
 * "não sei" em `false` fazia uma aba desatualizada (ou um provider novo que
 * esta imagem ainda não conhece) parecer prova de que o telefone NUNCA foi
 * identidade, escondendo vínculo de WhatsApp de verdade.
 *
 * É ADMIN CLIENT, e não o de sessão — e o motivo, conferido no `baseline.sql`,
 * não é "channel_sessions é ilegível pro papel `agent`" (é legível: a policy
 * `channel_sessions_tenant_select` não tem `fn_role_at_least`, só organização).
 * O motivo é `conversations_select`: ela passa por `fn_can_view_conversation`,
 * que decide VISIBILIDADE (papel + atribuição + `visibility_mode` da
 * organização) — uma pergunta diferente da que esta função faz, que é
 * ESTRUTURAL ("esta linha pertence a este contato e a esta organização?"). Se
 * usasse o client de sessão, um agente sob `visibility_mode: 'own'` olhando uma
 * conversa que passou a ser de outro atendente depois que ele a abriu perderia
 * a prova de identidade por um motivo que não tem nada a ver com o IXC. O filtro
 * manual por `contact_id` (lido antes, já escopado pela sessão) e
 * `organization_id` (da sessão, nunca do pedido) é exatamente o padrão que a
 * doutrina pede para admin client em request handler — RLS não teria nada a
 * acrescentar aqui além dessa mesma checagem.
 */
export async function identidadeDoTelefoneNaConversa(
  ctx: Extract<ContextoIxc, { ok: true }>,
  conversationId: string | null,
): Promise<IdentidadeDoTelefone> {
  if (!conversationId || !z.string().uuid().safeParse(conversationId).success) return "desconhecido";
  const { data: conversa } = await ctx.admin
    .from("conversations")
    .select("channel_session_id")
    .eq("id", conversationId)
    .eq("contact_id", ctx.contato.id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  if (!conversa?.channel_session_id) return "desconhecido";
  const { data: sessao } = await ctx.admin
    .from("channel_sessions")
    .select("provider")
    .eq("id", conversa.channel_session_id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  return identidadeDoTelefone(sessao?.provider as string | undefined);
}
