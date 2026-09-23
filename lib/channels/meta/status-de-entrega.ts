/**
 * O status de entrega que a Meta devolve para uma mensagem NOSSA — e o que ele
 * muda na linha de `messages`.
 *
 * ─── O defeito (DYD-15, medido em 2026-09-23) ───────────────────────────────
 *
 * A rota do webhook gravava `status: e.status === "failed" ? "failed" : "sent"`:
 * `delivered` e `read` viravam `sent`. A bolha nunca passava de um check — o
 * atendente não tinha como saber se o cliente recebeu, nem se leu. E o erro
 * de uma falha (131047, janela fechada) chegava no evento e era jogado fora.
 *
 * ─── Só sobe, nunca desce ───────────────────────────────────────────────────
 *
 * A Meta não garante ordem: `sent` pode chegar DEPOIS de `delivered`, e um
 * `read` pode chegar sem `delivered` antes. Cada status só se aplica sobre os
 * estados abaixo dele (`deOnde`), então um evento atrasado não rebaixa a
 * bolha de dois checks azuis para um cinza. O filtro vai no UPDATE — decidir
 * em memória exigiria ler antes e perderia para o evento concorrente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MessageStatusEvent } from "./webhook";

export interface PlanoDoStatus {
  /** Estados de onde este status pode vir — o filtro do UPDATE. */
  deOnde: readonly string[];
  campos: Record<string, string | null>;
  /**
   * `read` implica `delivered`: quando o lido chega sem o entregue (ou antes
   * dele), o `delivered_at` vazio é preenchido com o mesmo horário.
   */
  preencherEntregueSeVazio?: string;
}

const ANTES_DE_SAIR = ["queued", "sending"] as const;

/** `null` = status que não muda a bolha (desconhecido, `deleted`, `warning`…). */
export function planoDoStatus(e: MessageStatusEvent, agora: Date): PlanoDoStatus | null {
  const em = (e.at ?? agora).toISOString();
  switch (e.status) {
    case "sent":
      return { deOnde: ANTES_DE_SAIR, campos: { status: "sent" } };
    case "delivered":
      return {
        deOnde: [...ANTES_DE_SAIR, "sent"],
        campos: { status: "delivered", delivered_at: em },
      };
    case "read":
      return {
        deOnde: [...ANTES_DE_SAIR, "sent", "delivered"],
        campos: { status: "read", read_at: em },
        preencherEntregueSeVazio: em,
      };
    case "failed": {
      const detalhe = [e.errorTitle, e.errorDetail].filter(Boolean).join(" — ");
      return {
        // Não rebaixa o que já foi entregue: uma falha depois disso não é da
        // entrega desta mensagem.
        deOnde: [...ANTES_DE_SAIR, "sent"],
        campos: {
          status: "failed",
          error_code: e.errorCode != null ? `meta_${e.errorCode}` : "meta_error",
          error_message: detalhe || null,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Aplica o status. A organização vem do CHAMADOR (o token do path do webhook),
 * nunca do corpo — o client é service role e bypassa a RLS.
 */
export async function aplicarStatusDeEntrega(
  admin: SupabaseClient,
  organizationId: string,
  e: MessageStatusEvent,
  agora = new Date(),
): Promise<{ aplicado: boolean; erro?: string }> {
  const plano = planoDoStatus(e, agora);
  if (!plano) return { aplicado: false };

  const { error } = await admin
    .from("messages")
    .update({ ...plano.campos, updated_at: agora.toISOString() })
    .eq("organization_id", organizationId)
    .eq("external_id", e.externalId)
    .in("status", plano.deOnde);
  if (error) return { aplicado: false, erro: error.message };

  if (plano.preencherEntregueSeVazio) {
    await admin
      .from("messages")
      .update({ delivered_at: plano.preencherEntregueSeVazio })
      .eq("organization_id", organizationId)
      .eq("external_id", e.externalId)
      .is("delivered_at", null);
  }
  return { aplicado: true };
}
