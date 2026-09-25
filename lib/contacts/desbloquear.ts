/**
 * Desbloquear um contato — a porta de volta do opt-out.
 *
 * `contacts.is_blocked` é gravado `true` pela detecção de opt-out
 * (`lib/channels/pos-entrada.ts`, `aplicarOptOut`) e o motor o trata como
 * parada dura. Até esta porta existir, a única reversão possível era SQL à mão —
 * foi o que aconteceu em 2026-09-25, quando um falso positivo (corrigido na
 * v1.42.1) calou um cliente que só queria cancelar a assinatura do plano.
 *
 * ⚠️ QUEM PEDIU PARA SAIR PODE TER PEDIDO DE VERDADE.
 *
 * Desbloquear é voltar a escrever para uma pessoa que, pelo que o sistema leu,
 * pediu para não receber mais nada. Por isso as três exigências:
 *
 *   1. **manager+** — a rota barra antes de chegar aqui. É decisão de quem
 *      responde pela operação, não gesto de atendimento; `agent` edita a ficha,
 *      mas não desfaz o pedido de saída do titular.
 *   2. **motivo obrigatório** — vai para o audit `contact.unblocked` junto com
 *      quem desbloqueou e o bloqueio que foi desfeito (motivo e data). É o que
 *      responde, depois, a um "por que me escreveram se eu pedi para sair?".
 *   3. **nada de efeito retroativo** — o que foi cancelado enquanto o contato
 *      estava bloqueado (follow-up, campanha) NÃO volta. Destravar é permitir o
 *      PRÓXIMO envio, não reenviar o que não saiu.
 *
 * Se a pessoa pedir para sair de novo, a mesma detecção bloqueia outra vez — o
 * desbloqueio não imuniza ninguém.
 *
 * ⚠️ ADMIN CLIENT, com `organization_id` filtrado aqui.
 *
 * A org vem de `requireRole` (cookie validado contra membership), nunca do
 * body. E o UPDATE é condicional a `is_blocked = true` e `is_anonymized = false`:
 * entre a tela renderizar e o clique, outro gerente pode ter desbloqueado ou o
 * contato ter sido anonimizado — quem perde a corrida recebe 409, em vez de uma
 * segunda linha de auditoria para um desbloqueio que não aconteceu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";

export const MOTIVO_MINIMO = 10;
export const MOTIVO_MAXIMO = 500;

export const desbloquearContatoSchema = z.object({
  motivo: z
    .string()
    .trim()
    // Frases fixas, não template: são chaves do dicionário (`lib/i18n/dicionario.ts`).
    .min(MOTIVO_MINIMO, "Explique o motivo em pelo menos 10 caracteres.")
    .max(MOTIVO_MAXIMO, "O motivo pode ter no máximo 500 caracteres."),
});

export type DesbloquearContatoInput = z.infer<typeof desbloquearContatoSchema>;

export interface DesbloqueioCtx {
  organizationId: string;
  actorUserId: string;
  requestId: string;
}

export interface ResultadoDoDesbloqueio {
  contact_id: string;
  is_blocked: false;
  /** O bloqueio que foi desfeito — a tela o cita no aviso de sucesso. */
  bloqueio_anterior: { reason: string | null; blocked_at: string | null };
}

interface LinhaDoContato {
  id: string;
  is_blocked: boolean;
  is_anonymized: boolean;
  blocked_reason: string | null;
  blocked_at: string | null;
}

export async function desbloquearContato(
  admin: SupabaseClient,
  ctx: DesbloqueioCtx,
  contactId: string,
  input: DesbloquearContatoInput,
): Promise<ResultadoDoDesbloqueio> {
  const { data: atual, error: erroDeLeitura } = await admin
    .from("contacts")
    .select("id, is_blocked, is_anonymized, blocked_reason, blocked_at")
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (erroDeLeitura) throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Não foi possível ler o contato.");
  // Contato de outra org cai aqui também — 404, e não 403, para não confirmar
  // que o id existe em outro tenant.
  if (!atual) throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");

  const contato = atual as LinhaDoContato;
  if (contato.is_anonymized) {
    throw new ApiError(403, "lgpd_anonymization_irreversible", undefined, ctx.requestId, "Contato anonimizado não pode ser desbloqueado.");
  }
  if (!contato.is_blocked) {
    throw new ApiError(409, "state_conflict", undefined, ctx.requestId, "Este contato não está bloqueado.");
  }

  const { data: atualizado, error: erroDeEscrita } = await admin
    .from("contacts")
    .update({ is_blocked: false, blocked_reason: null, blocked_at: null })
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId)
    .eq("is_blocked", true)
    .eq("is_anonymized", false)
    .select("id")
    .maybeSingle();

  if (erroDeEscrita) throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Não foi possível desbloquear o contato.");
  if (!atualizado) {
    // Perdeu a corrida: alguém desbloqueou ou anonimizou entre a leitura e aqui.
    throw new ApiError(409, "state_conflict", undefined, ctx.requestId, "Este contato já não está bloqueado.");
  }

  await audit({
    action: "contact.unblocked",
    actorUserId: ctx.actorUserId,
    organizationId: ctx.organizationId,
    resourceType: "contact",
    resourceId: contactId,
    requestId: ctx.requestId,
    bypassedRls: true,
    metadata: {
      contact_id: contactId,
      motivo: input.motivo,
      // O bloqueio desfeito, inteiro: sem ele o audit diria "desbloqueou" sem
      // dizer o QUÊ — e é o par (pedido lido, decisão humana) que responde ao
      // titular.
      blocked_reason_anterior: contato.blocked_reason,
      blocked_at_anterior: contato.blocked_at,
    },
  });

  return {
    contact_id: contactId,
    is_blocked: false,
    bloqueio_anterior: { reason: contato.blocked_reason, blocked_at: contato.blocked_at },
  };
}
