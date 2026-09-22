import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { NASCIMENTO_DO_CARD_PADRAO, nascimentoDoCard, type NascimentoDoCard } from "@/lib/schemas/settings";

/**
 * A regra "quando o card nasce" desta organização — para o SERVIDOR (ingest e
 * worker, ambos com service role; o filtro por organização é explícito).
 *
 * ⚠️ FALHA LÊ COMO `toda_conversa`. Quem consome decide se um card nasce, e
 * errar para o lado de criar é o comportamento de antes da regra existir:
 * visível e corrigível. O erro não some: vai para o log com a organização.
 */
export async function lerNascimentoDoCard(db: SupabaseClient, organizationId: string): Promise<NascimentoDoCard> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) {
    logger.warn("[nascimento-do-card] leitura da regra falhou; seguindo como toda_conversa", {
      organization_id: organizationId,
      error: error.message,
    });
    return { ...NASCIMENTO_DO_CARD_PADRAO };
  }
  return nascimentoDoCard((data as { settings?: unknown } | null)?.settings);
}
