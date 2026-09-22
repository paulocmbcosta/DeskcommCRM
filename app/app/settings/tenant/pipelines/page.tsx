import { redirect } from "next/navigation";

import { NascimentoDoCard } from "@/components/crm/NascimentoDoCard";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { nascimentoDoCard } from "@/lib/schemas/settings";
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

  const supabase = await createClient();
  const { data } = await supabase
    .from("crm_pipelines")
    .select("id, name, slug, vocabulary, settings")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position");

  const pipelines = (data ?? []) as PipelineRow[];
  const idioma = user.idioma;

  // A regra "quando o card nasce" (settings.crm.nascimento_do_card). Membro lê
  // a própria organização pela RLS; falha de leitura mostra o padrão, que é o
  // que a ingestão também assume.
  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const regraDeNascimento = nascimentoDoCard((org as { settings?: unknown } | null)?.settings);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Etapas do funil", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Para onde o agente leva o card em cada passo do atendimento", idioma)}
          {podeEditarConfig
            ? traduzir(", vocabulário, custom fields e motivos de perda", idioma)
            : ""}
          .
        </p>
      </header>
      <NascimentoDoCard inicial={regraDeNascimento} podeEditar={podeEditarConfig} />
      <PipelinesClient pipelines={pipelines} podeEditarConfig={podeEditarConfig} />
    </div>
  );
}
