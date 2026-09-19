import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { ConectoresClient } from "./_components/ConectoresClient";

export const dynamic = "force-dynamic";

/**
 * Configurações › Conectores — onde a organização liga o sistema que ela já usa
 * para operar (hoje: o IXC, de provedor de internet) ao atendimento.
 *
 * Só admin: a tela recebe o token de um ERP de terceiro.
 */
export default async function ConectoresPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Conectores", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Ligue o sistema que a sua empresa já usa para operar. Os dados do cliente passam a aparecer no atendimento, ao lado da conversa, sem ninguém precisar trocar de tela.",
            idioma,
          )}
        </p>
      </header>
      <ConectoresClient />
    </div>
  );
}
