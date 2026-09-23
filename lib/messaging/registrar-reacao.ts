/**
 * O único escritor de `messages.metadata.reacoes` — via `fn_registrar_reacao`
 * (migration 0276), que grava num UPDATE só. Ver `./reacoes.ts` para o formato.
 *
 * O client é SERVICE ROLE (a função é fechada a authenticated), então a
 * organização vem sempre de fonte confiável do chamador: o token do path no
 * webhook, a sessão + a leitura por RLS na rota do atendente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LadoDaReacao } from "./reacoes";

export interface RegistroDeReacao {
  organizationId: string;
  lado: LadoDaReacao;
  /** `""` remove a reação deste lado. */
  emoji: string;
  /** Alvo pelo id interno (rota do atendente)… */
  alvoId?: string | null;
  /** …ou pelo id do provider (webhook). */
  alvoExternalId?: string | null;
  userId?: string | null;
  /** Id do provider da PRÓPRIA reação, quando houver. */
  externalId?: string | null;
  em?: Date | null;
}

/** Devolve o id da mensagem alvo, ou `null` quando ela não existe nesta org. */
export async function registrarReacao(
  admin: SupabaseClient,
  r: RegistroDeReacao,
): Promise<{ alvoId: string | null; erro?: string }> {
  const { data, error } = await admin.rpc(
    "fn_registrar_reacao" as never,
    {
      p_org: r.organizationId,
      p_alvo_id: r.alvoId ?? null,
      p_alvo_external_id: r.alvoExternalId ?? null,
      p_lado: r.lado,
      p_emoji: r.emoji,
      p_user: r.userId ?? null,
      p_external_id: r.externalId ?? null,
      p_em: (r.em ?? new Date()).toISOString(),
    } as never,
  );
  if (error) return { alvoId: null, erro: error.message };
  return { alvoId: (data as string | null) ?? null };
}
