"use server";

/**
 * QUANDO O CARD NASCE — toda conversa (padrão) ou só a comercial (Jev).
 *
 * Leitura-mescla-escrita pelo ADMIN client, no molde de `definirExigenciaDeMfa`
 * (app/actions/auth/politicaDeMfa.ts): é configuração reversível que não
 * reescreve dado nenhum. Pela sessão, `.from("organizations").update` de um
 * admin de tenant casaria ZERO linhas e devolveria sucesso.
 *
 * `settings` é jsonb compartilhado (o provedor de IA e a regra "cliente pela
 * agenda" moram nele): mesclar preserva o que não é nosso.
 *
 * ⚠️ RISCO ACEITO, e escrito para ninguém redescobrir: a mescla é no
 * TypeScript (ler → mesclar → gravar o objeto inteiro). Se
 * `fn_definir_cliente_pela_agenda` rodar ENTRE a leitura e a gravação, esta
 * action regrava o `crm.cliente_pela_agenda` antigo por fora da RPC (sem o
 * advisory lock, sem MFA, sem o recálculo das etiquetas). São dois
 * interruptores raros e só de admin, e o repositório já convive com a mesma
 * janela em `definirExigenciaDeMfa`. Fechar exigiria uma RPC com
 * `jsonb_set(settings, '{crm,nascimento_do_card}', ...)` — migration nova —,
 * o que fica para quando o custo da corrida aparecer.
 *
 * Não liga o classificador sem chave da OpenRouter: ligado sem chave, todo card
 * nasceria "sem classificar" — o comportamento de antes com um rótulo de erro.
 * Melhor recusar na tela, onde dá para consertar.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import {
  nascimentoDoCard,
  nascimentoDoCardWriteSchema,
  type ModoDeNascimentoDoCard,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroNascimentoDoCard =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "sem_chave_openrouter"
  | "falha";

export type RespostaNascimentoDoCard =
  | { ok: true; modo: ModoDeNascimentoDoCard; limiar: number }
  | { ok: false; erro: ErroNascimentoDoCard };

export async function definirNascimentoDoCard(entrada: unknown): Promise<RespostaNascimentoDoCard> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = nascimentoDoCardWriteSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, erro: "sem_permissao" };

  const admin = createAdminClient();
  if (lido.data.modo === "classificador" && !(await chaveDaOpenRouter(admin, org.orgId))) {
    return { ok: false, erro: "sem_chave_openrouter" };
  }

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, erro: "falha" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const crm =
    settings.crm && typeof settings.crm === "object" && !Array.isArray(settings.crm)
      ? (settings.crm as Record<string, unknown>)
      : {};
  const antes = nascimentoDoCard(settings);
  const novo = { ...settings, crm: { ...crm, nascimento_do_card: lido.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[nascimento-do-card] gravação falhou", { organization_id: org.orgId, error: error.message });
    return { ok: false, erro: "falha" };
  }

  await audit({
    action: "crm.nascimento_do_card_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { antes, depois: lido.data },
  });

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true, ...lido.data };
}
