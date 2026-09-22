import { redirect } from "next/navigation";

import { NascimentoDoCard } from "@/components/crm/NascimentoDoCard";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerNascimentoDoCard } from "@/lib/leads/modo-de-nascimento";
import { createClient } from "@/lib/supabase/server";
import { PipelinesClient, type PipelineRow } from "./_client";

export const dynamic = "force-dynamic";

/**
 * ⚠️ A PÁGINA É manager+, O EDITOR DE VOCABULÁRIO CONTINUA admin.
 *
 * O mapeamento do funil do agente mora aqui, e a rota que o grava exige manager
 * — é configuração de operação, não de estrutura da empresa. O Painel de
 * Evolução (também manager+) manda o dono da operação para cá quando aponta a
 * lacuna; se a página seguisse admin-only, o CTA levaria metade dos usuários
 * autorizados a um 403 e o ciclo "vejo o problema → conserto" morreria no meio.
 *
 * O editor de vocabulário/custom fields NÃO afrouxou: `updatePipelineConfig`
 * continua recusando quem não é admin no servidor, e a UI dele só é renderizada
 * para admin — esconder o que a ação recusaria é honestidade, não permissão nova.
 */
export default async function PipelinesSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const podeEditarConfig =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  // "Quando o card nasce" é decisão de CONTROLADOR (LGPD), mesma régua de
  // `fn_definir_cliente_pela_agenda`: só admin do TENANT, SEM o atalho de
  // platform admin que `podeEditarConfig` concede pro resto da tela — a
  // action já recusa quem não é; aqui é só não oferecer um Salvar que ela vai
  // barrar.
  const podeEditarNascimento = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  const supabase = await createClient();
  const [{ data }, regraDeNascimento] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, name, slug, vocabulary, settings")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_archived", false)
      .order("position"),
    lerNascimentoDoCard(supabase, activeOrg.orgId),
  ]);

  const pipelines = (data ?? []) as PipelineRow[];
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Etapas do funil", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Para onde o agente leva o card em cada passo do atendimento", idioma)}
          {podeEditarConfig
            ? traduzir(", vocabulário, custom fields, motivos de perda e quando o card nasce", idioma)
            : traduzir(" e quando o card nasce", idioma)}
          .
        </p>
      </header>
      {/* `key` força remontar quando a regra SALVA muda por fora (ex.: outra
          aba, ou o `router.refresh()` que o próprio componente pede depois de
          um "tente_de_novo") — sem isso o estado local ficaria preso no valor
          do primeiro mount, e o botão Salvar compararia contra um `inicial`
          que já não é mais o valor em vigor no servidor. */}
      <NascimentoDoCard
        key={`${regraDeNascimento.modo}:${regraDeNascimento.limiar}`}
        inicial={regraDeNascimento}
        podeEditar={podeEditarNascimento}
      />
      <PipelinesClient pipelines={pipelines} podeEditarConfig={podeEditarConfig} />
    </div>
  );
}
