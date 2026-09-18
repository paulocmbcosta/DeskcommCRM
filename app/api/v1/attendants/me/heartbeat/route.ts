/**
 * POST /api/v1/attendants/me/heartbeat — o SINAL DE VIDA de quem está online.
 *
 * O cron `attendant-heartbeat` marca offline quem não pinga há 15 minutos
 * (defesa contra aba fechada sem aviso). Ele existia; quem PINGASSE não. Nenhuma
 * tela emitia o sinal, então todo atendente era derrubado 15 minutos depois de
 * ficar disponível — e o rodízio parava de distribuir sem nada na tela dizendo
 * por quê. Esta rota é o outro lado daquele cron.
 *
 * Só renova quem JÁ está disponível: o sinal de vida não tira ninguém da pausa
 * nem do offline. Por isso não é mutação auditável — ele não muda decisão
 * nenhuma, só impede uma (mesma régua dos crons que não auditam rodada vazia).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  // Sessão de suporte somente-leitura não é atendente: não mantém ninguém online
  // em nome de outra pessoa. A tela nem mostra o controle para ela; esta guarda
  // é a do servidor.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // Client do USUÁRIO: a policy de UPDATE de `attendant_availability` só deixa a
  // pessoa tocar a PRÓPRIA linha (ou gestor) — e os dois `eq` dizem qual.
  const db = await createClient();
  const { data, error } = await db
    .from("attendant_availability")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", authz.user.id)
    .eq("is_available", true)
    .select("user_id");
  if (error) return fail("internal_error", t("Não foi possível renovar o sinal de vida."), 500, { requestId });
  return ok({ renovado: (data ?? []).length > 0 }, { requestId });
}
