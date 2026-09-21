/**
 * Revoga o acesso do NAVEGADOR de um visitante à conversa dele.
 *
 * Nos canais de WhatsApp a conversa mora no aparelho do cliente e o CRM não tem
 * como (nem por que) tirá-la de lá. Aqui é o contrário: a única cópia que o
 * visitante tem é a que a rota pública devolve a quem apresenta o token. Então
 * anonimizar o contato SEM revogar o token deixaria uma porta aberta — o
 * histórico redigido continuaria legível por fora, e o navegador seguiria
 * podendo escrever numa conversa de um titular que pediu para ser esquecido.
 *
 * Revogar é apagar a thread: sem o hash em `provider_conversation_id`, o token
 * não abre mais nada (`conversaDoVisitante` devolve `null`, a rota responde 401
 * e o widget recomeça como visitante novo).
 *
 * Filtra pelo MEIO (`channel = 'site_chat'`), não pelo provider: a thread de um
 * canal de WhatsApp intermediado é endereço de envio, e apagá-la calaria um
 * canal que não tem nada a ver com isto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { MEIO_CHAT_DO_SITE } from "./entrada";

export async function revogarAcessoDoVisitante(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<number> {
  const { data, error } = await admin
    .from("conversations")
    .update({ provider_conversation_id: null })
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .eq("channel", MEIO_CHAT_DO_SITE)
    .not("provider_conversation_id", "is", null)
    .select("id");
  // Falha FECHADA: quem chama é a cascata de anonimização, e seguir adiante com
  // a porta aberta produziria uma auditoria afirmando que a redação ocorreu.
  if (error) throw new Error(`site_chat_revoke_failed: ${error.message}`);
  return (data ?? []).length;
}
