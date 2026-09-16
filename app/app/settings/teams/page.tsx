/**
 * Configurações → Times de atendimento.
 *
 * A tela onde o gestor cadastra os SETORES que recebem conversa. O resto da
 * feature já existia inteiro sem ela: as tabelas (`attendance_teams`,
 * `attendance_team_members`), as RPCs de escrita, o filtro do inbox, a
 * transferência manual e o handoff do agente de IA. Sem esta tela, o único jeito
 * de criar um time num self-host seria INSERT à mão no Postgres — que é o mesmo
 * defeito que a tela de Distribuição de atendimento (issue #144) veio corrigir,
 * e a razão de ela ser a vizinha desta no menu.
 *
 * Gate = manager+, igual ao da vizinha e igual ao que a rota
 * `/api/v1/settings/teams` exige. Se a tela abrisse para `agent`, ele veria o
 * formulário e levaria 403 no Salvar.
 *
 * Os DADOS não são lidos aqui: quem lê é `useTimes`, contra a rota. A rota monta
 * a lista de alocáveis com a mesma cláusula que `fn_save_attendance_team` exige,
 * e uma segunda leitura aqui ofereceria gente que a RPC recusa.
 */
import { redirect } from "next/navigation";

import { PainelDeTimes } from "./_client";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function TimesSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Times de atendimento", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Os setores que recebem conversa — Financeiro, Suporte, Vendas. Cada time tem as pessoas que atendem por ele e o horário em que atende; fora desse horário a conversa espera na fila dele em vez de morrer sem resposta.",
            idioma,
          )}
        </p>
      </header>

      <PainelDeTimes />
    </div>
  );
}
