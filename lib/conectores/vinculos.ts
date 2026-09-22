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

export interface ResultadoDeVincular {
  /** Criou linha nova OU promoveu uma existente — "aconteceu algo" nos dois casos. */
  vinculou: boolean;
  /** A linha já existia com uma forma mais fraca e foi PROMOVIDA agora (ver `MAIS_FRACAS_QUE`). */
  promovido: boolean;
}

/**
 * Ordem de força da verificação — a mais fraca nunca sobrescreve a mais forte.
 * `telefone` é o sistema batendo sozinho o número da conversa (nenhuma
 * confirmação humana); `documento` é o CPF/CNPJ que o cliente informou,
 * conferido no IXC; `manual` é o atendente clicando "É este" — confirmação
 * humana direta, a mais forte das três.
 */
const MAIS_FRACAS_QUE: Record<FormaDeVerificacao, readonly FormaDeVerificacao[]> = {
  telefone: [],
  documento: ["telefone"],
  manual: ["telefone", "documento"],
};

/**
 * Idempotente: vincular o que já está vinculado não é erro (`23505` capturado).
 * Mas "já vinculado" não é sempre o mesmo caso: quando a linha existente foi
 * verificada por uma forma MAIS FRACA que a que chegou agora, ela é PROMOVIDA.
 *
 * Sem isto era beco sem saída: um vínculo por telefone que deixou de valer
 * (canal onde o telefone não é identidade) fazia o painel descartar a linha na
 * leitura e cair em "escolher"; o atendente clicava "É este"; o INSERT batia no
 * `23505` da linha antiga, que `vincular` devolvia `false` sem nunca tocar —
 * o contato ficava preso, o clique sem efeito nenhum, para sempre.
 *
 * NUNCA REBAIXA: `telefone` não promove nada (é a mais fraca de todas), e uma
 * forma já gravada não regride para uma mais fraca que ela mesma.
 */
export async function vincular(p: PedidoDeVincular): Promise<ResultadoDeVincular> {
  const { error } = await p.admin.from("contato_vinculos_externos").insert({
    organization_id: p.orgId,
    contact_id: p.contactId,
    conector: p.conector,
    external_id: p.externalId,
    verificado_por: p.verificadoPor,
    created_by: p.userId,
  });
  if (!error) return { vinculou: true, promovido: false };
  if (error.code !== "23505") throw new Error(`contato_vinculos_externos: ${error.message}`);

  const formasMaisFracas = MAIS_FRACAS_QUE[p.verificadoPor];
  if (formasMaisFracas.length === 0) return { vinculou: false, promovido: false };

  const { data, error: erroPromocao } = await p.admin
    .from("contato_vinculos_externos")
    .update({ verificado_por: p.verificadoPor, created_by: p.userId })
    .eq("organization_id", p.orgId)
    .eq("contact_id", p.contactId)
    .eq("conector", p.conector)
    .eq("external_id", p.externalId)
    .in("verificado_por", formasMaisFracas)
    .select("contact_id");
  if (erroPromocao) throw new Error(`contato_vinculos_externos: ${erroPromocao.message}`);
  const promoveu = (data ?? []).length > 0;
  return { vinculou: promoveu, promovido: promoveu };
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
