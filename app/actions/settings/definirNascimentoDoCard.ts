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
 * ✅ TRAVA CONTRA A CORRIDA COM `fn_definir_cliente_pela_agenda` — concorrência
 * otimista pelo `updated_at`, e não mais um risco aceito. `organizations` tem o
 * gatilho `trg_organizations_touch` (BEFORE UPDATE → `fn_touch_updated_at`,
 * `supabase/baseline.sql:3034`), que toca `updated_at` em TODO UPDATE da linha —
 * inclusive o que a RPC faz. Lemos `updated_at` junto com `settings` e só
 * regravamos se ele CONTINUA o mesmo (`.eq("updated_at", atual.updated_at)`):
 * se a RPC correu entre a nossa leitura e a nossa gravação, o UPDATE casa ZERO
 * linhas — `.select("id")` é o que torna isso detectável — e devolvemos
 * "tente_de_novo" em vez de regravar por cima o `crm.cliente_pela_agenda` que
 * ela acabou de calcular (sem o advisory lock dela, sem MFA, sem recálculo de
 * etiqueta). Quem perde a corrida tenta de novo; ninguém perde escrita em
 * silêncio. A prova de verdade é o e2e da Tarefa 14 (liga a regra pela tela no
 * Postgres real): se a igualdade de timestamp não casar com o gatilho de
 * verdade, aquele teste reprova.
 *
 * ⚠️ SÓ ADMIN DO TENANT — de propósito, sem atalho de platform admin. É decisão
 * de CONTROLADOR (LGPD) sobre o mesmo `crm` cuja RPC irmã (`fn_definir_cliente_
 * pela_agenda`) também exige admin do tenant; platform admin que precisa mexer
 * aqui usa o caminho do suporte em modo completo, como em qualquer outra tela.
 *
 * ⚠️ MFA PROVADO, NÃO A POLÍTICA. DEPOIS do papel, de propósito — mesma ordem e
 * mesmo motivo de `updateMarcaDaOrganizacao.ts`: quem nem tem o papel recebe
 * `sem_permissao`, que é a verdade sobre ele; só quem passaria pelo papel é
 * cobrado pelo segundo fator. `mfaEmDivida()` NÃO consulta
 * `organizations.settings.security.mfa_required` nem `platform_admins.
 * mfa_required` — cadastrar e provar são perguntas diferentes (CLAUDE.md): quem
 * TEM fator prova SEMPRE, senão ligar a verificação por vontade própria faria o
 * fator ser ignorado numa sessão sem `aal2`.
 *
 * Não liga o classificador sem chave da OpenRouter: ligado sem chave, todo card
 * nasceria "sem classificar" — o comportamento de antes com um rótulo de erro.
 * Melhor recusar na tela, onde dá para consertar.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
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
  | "mfa"
  | "sem_chave_openrouter"
  | "tente_de_novo"
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
  // DEPOIS do papel, de propósito (ver o cabeçalho): quem nem tem o papel recebe
  // `sem_permissao`, que é a verdade sobre ele.
  if (await mfaEmDivida()) return { ok: false, erro: "mfa" };

  const admin = createAdminClient();
  if (lido.data.modo === "classificador" && !(await chaveDaOpenRouter(admin, org.orgId))) {
    return { ok: false, erro: "sem_chave_openrouter" };
  }

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings, updated_at")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    logger.error("[nascimento-do-card] leitura falhou", { organization_id: org.orgId, code: erroLeitura.code });
    return { ok: false, erro: "falha" };
  }
  if (!atual) return { ok: false, erro: "sem_empresa" };

  const settings = (atual.settings ?? {}) as Record<string, unknown>;
  const crm =
    settings.crm && typeof settings.crm === "object" && !Array.isArray(settings.crm)
      ? (settings.crm as Record<string, unknown>)
      : {};
  const antes = nascimentoDoCard(settings);

  // Nada mudou: nem grava, nem audita. Uma auditoria "trocou X por X" não é
  // mutação — é ruído na trilha que alguém vai ler depois tentando entender o
  // que de fato aconteceu. A comparação é pela regra EM VIGOR — `nascimentoDoCard`
  // arredonda o limiar lido para a opção mais próxima da tela, de propósito: um
  // valor cru fora das opções (só alcançável por SQL, fora da tela) fica como
  // está até a próxima mudança REAL. Normalizar esse valor aqui exigiria gravar
  // sem deixar trilha (silencioso) ou auditar "0.7 → 0.7", que não é mutação
  // nenhuma.
  if (antes.modo === lido.data.modo && antes.limiar === lido.data.limiar) {
    // Aba velha reaberta com o banco já igual: sem revalidar, o `inicial` que a
    // tela usa para decidir se o botão fica habilitado nunca se atualiza.
    revalidatePath("/app/settings/tenant/pipelines");
    return { ok: true, modo: lido.data.modo, limiar: lido.data.limiar };
  }

  const novo = { ...settings, crm: { ...crm, nascimento_do_card: lido.data } };

  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", org.orgId)
    .eq("updated_at", atual.updated_at)
    .select("id");
  if (error) {
    logger.error("[nascimento-do-card] gravação falhou", { organization_id: org.orgId, code: error.code });
    return { ok: false, erro: "falha" };
  }
  // Zero linhas: alguém (a RPC irmã, outra aba) mudou `organizations` entre a
  // nossa leitura e a nossa gravação — o gatilho tocou `updated_at` e o filtro
  // não casou mais nada. Tentar de novo lê o estado fresco; sobrescrever por
  // cima seria a corrida que o cabeçalho descreve.
  if (!gravado || gravado.length === 0) return { ok: false, erro: "tente_de_novo" };

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
