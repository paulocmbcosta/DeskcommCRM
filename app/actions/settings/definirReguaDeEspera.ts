"use server";

/**
 * A RÉGUA DO TERMÔMETRO do Inbox — em quantos minutos sem resposta o card fica
 * amarelo, laranja e vermelho pulsando (`settings.inbox.regua_de_espera`).
 *
 * Mesmo molde de `definirNascimentoDoCard.ts`: leitura-mescla-escrita pelo ADMIN
 * client (pela sessão, o `update` em `organizations` casaria zero linhas e
 * devolveria sucesso), concorrência otimista pelo `updated_at` (o gatilho
 * `trg_organizations_touch` toca a coluna em todo UPDATE) e grava SÓ a própria
 * chave — `settings` é jsonb compartilhado, e regravar o objeto inteiro apagaria
 * a regra de outra tela.
 *
 * manager+, que é o gate da tela onde ela mora (Distribuição de atendimento,
 * spec 13 §4 — "config de atendimento/roteamento"). MFA PROVADO depois do papel,
 * pela razão escrita em `definirNascimentoDoCard.ts`.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { reguaDeEspera, reguaDeEsperaWriteSchema, type ReguaDeEspera } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroReguaDeEspera =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaReguaDeEspera = { ok: true; regua: ReguaDeEspera } | { ok: false; erro: ErroReguaDeEspera };

export async function definirReguaDeEspera(entrada: unknown): Promise<RespostaReguaDeEspera> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = reguaDeEsperaWriteSchema.safeParse(entrada);
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
    logger.error("[regua-de-espera] leitura falhou", { organization_id: org.orgId, code: erroLeitura.code });
    return { ok: false, erro: "falha" };
  }
  if (!atual) return { ok: false, erro: "sem_empresa" };

  const settings = (atual.settings ?? {}) as Record<string, unknown>;
  const antes = reguaDeEspera(settings);
  const depois = lido.data;

  // Nada mudou: nem grava, nem audita — "trocou X por X" não é mutação.
  if (
    antes.amarelo_min === depois.amarelo_min &&
    antes.laranja_min === depois.laranja_min &&
    antes.vermelho_min === depois.vermelho_min
  ) {
    revalidatePath("/app/settings/atendimento");
    return { ok: true, regua: depois };
  }

  const inbox =
    settings.inbox && typeof settings.inbox === "object" && !Array.isArray(settings.inbox)
      ? (settings.inbox as Record<string, unknown>)
      : {};
  const novo = { ...settings, inbox: { ...inbox, regua_de_espera: depois } };

  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", org.orgId)
    .eq("updated_at", atual.updated_at)
    .select("id");
  if (error) {
    logger.error("[regua-de-espera] gravação falhou", { organization_id: org.orgId, code: error.code });
    return { ok: false, erro: "falha" };
  }
  // Zero linhas: alguém mudou `organizations` entre a leitura e a gravação.
  if (!gravado || gravado.length === 0) return { ok: false, erro: "tente_de_novo" };

  await audit({
    action: "inbox.regua_de_espera_alterada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { antes, depois },
  });

  revalidatePath("/app/settings/atendimento");
  // O Inbox lê a régua do layout de `/app` (ActiveOrg): revalida para a próxima
  // navegação já pintar com os degraus novos.
  revalidatePath("/app", "layout");
  return { ok: true, regua: depois };
}
