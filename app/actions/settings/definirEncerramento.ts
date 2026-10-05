"use server";

/**
 * O QUE A JANELA DE ENCERRAMENTO EXIGE — "exigir assunto" e "exigir resumo"
 * (`settings.atendimento.encerramento`, migration 0293).
 *
 * Mesmo molde de `definirReguaDeEspera.ts`: leitura-mescla-escrita pelo ADMIN
 * client, concorrência otimista pelo `updated_at` e grava SÓ a própria chave —
 * `settings` é jsonb compartilhado, e regravar o objeto inteiro apagaria a
 * regra de outra tela.
 *
 * manager+, que é o gate da tela onde mora (Distribuição de atendimento). MFA
 * provado depois do papel. O `organization_id` vem de `resolveActiveOrg`, nunca
 * de argumento.
 *
 * Esta action só GUARDA a escolha. Quem a aplica é `fn_atendimento_encerrar`,
 * que lê estas mesmas duas chaves a cada encerramento.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import {
  encerramentoDoAtendimento,
  encerramentoWriteSchema,
  type EncerramentoDoAtendimento,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroDoEncerramento =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaDoEncerramento =
  | { ok: true; regra: EncerramentoDoAtendimento }
  | { ok: false; erro: ErroDoEncerramento };

export async function definirEncerramento(entrada: unknown): Promise<RespostaDoEncerramento> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = encerramentoWriteSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, erro: "sem_permissao" };
  if (await mfaEmDivida()) return { ok: false, erro: "mfa" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings, updated_at")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    logger.error("[encerramento] leitura falhou", { organization_id: org.orgId, code: erroLeitura.code });
    return { ok: false, erro: "falha" };
  }
  if (!atual) return { ok: false, erro: "sem_empresa" };

  const settings = (atual.settings ?? {}) as Record<string, unknown>;
  const antes = encerramentoDoAtendimento(settings);
  const depois = lido.data;

  // Nada mudou: nem grava, nem audita — "trocou X por X" não é mutação.
  if (antes.exigir_assunto === depois.exigir_assunto && antes.exigir_resumo === depois.exigir_resumo) {
    revalidatePath("/app/settings/atendimento");
    return { ok: true, regra: depois };
  }

  const atendimento =
    settings.atendimento && typeof settings.atendimento === "object" && !Array.isArray(settings.atendimento)
      ? (settings.atendimento as Record<string, unknown>)
      : {};
  const novo = { ...settings, atendimento: { ...atendimento, encerramento: depois } };

  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", org.orgId)
    .eq("updated_at", atual.updated_at)
    .select("id");
  if (error) {
    logger.error("[encerramento] gravação falhou", { organization_id: org.orgId, code: error.code });
    return { ok: false, erro: "falha" };
  }
  // Zero linhas: alguém mudou `organizations` entre a leitura e a gravação.
  if (!gravado || gravado.length === 0) return { ok: false, erro: "tente_de_novo" };

  await audit({
    action: "atendimento.encerramento_configurado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { antes, depois },
  });

  revalidatePath("/app/settings/atendimento");
  return { ok: true, regra: depois };
}
