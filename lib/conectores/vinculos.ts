/**
 * O VÍNCULO contato ↔ cadastro no sistema externo.
 *
 * Guarda SÓ o id de lá (DIRC: referenciar). Achar o cliente pelo telefone custa
 * quatro chamadas ao ERP; paga-se uma vez, grava-se o ponteiro, e daí em diante
 * a leitura vai direto pelo id.
 *
 * Como `conexao.ts`: tabela server-side only, admin client, e `orgId` SEMPRE da
 * sessão. O trigger `fn_vinculo_externo_confere_org` (0271) é a segunda catraca —
 * recusa vínculo com contato de outra organização mesmo se a rota errar.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

import type { ConectorId, FormaDeVerificacao } from "./tipos";

type Admin = ReturnType<typeof createAdminClient>;

export interface Vinculo {
  external_id: string;
  verificado_por: FormaDeVerificacao;
  created_at: string;
}

export async function listarVinculos(
  admin: Admin,
  orgId: string,
  contactId: string,
  conector: ConectorId,
): Promise<Vinculo[]> {
  const { data, error } = await admin
    .from("contato_vinculos_externos")
    .select("external_id, verificado_por, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("conector", conector)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`contato_vinculos_externos: ${error.message}`);
  return (data ?? []) as Vinculo[];
}

export interface PedidoDeVincular {
  admin: Admin;
  orgId: string;
  contactId: string;
  conector: ConectorId;
  externalId: string;
  verificadoPor: FormaDeVerificacao;
  /** `null` = o sistema vinculou sozinho (um único candidato pelo telefone). */
  userId: string | null;
}

/** Idempotente: vincular o que já está vinculado não é erro (`23505` capturado). Devolve se CRIOU. */
export async function vincular(p: PedidoDeVincular): Promise<boolean> {
  const { error } = await p.admin.from("contato_vinculos_externos").insert({
    organization_id: p.orgId,
    contact_id: p.contactId,
    conector: p.conector,
    external_id: p.externalId,
    verificado_por: p.verificadoPor,
    created_by: p.userId,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`contato_vinculos_externos: ${error.message}`);
}

export async function desvincular(
  admin: Admin,
  orgId: string,
  contactId: string,
  conector: ConectorId,
  externalId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("contato_vinculos_externos")
    .delete()
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("conector", conector)
    .eq("external_id", externalId)
    .select("id");
  if (error) throw new Error(`contato_vinculos_externos: ${error.message}`);
  return (data ?? []).length > 0;
}
