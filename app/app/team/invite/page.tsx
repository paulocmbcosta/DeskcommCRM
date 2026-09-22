import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { isEmailConfigured } from "@/lib/email/resend";
import { traduzir } from "@/lib/i18n/dicionario";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CadastroComSenhaForm } from "./_components/CadastroComSenhaForm";
import { InviteForm } from "./_components/InviteForm";

export const dynamic = "force-dynamic";

/**
 * Duas portas para a mesma equipe.
 *
 * **Cadastrar com senha** é a aba padrão: funciona em qualquer instalação,
 * inclusive na que não configurou envio de e-mail — que é toda VPS recém-
 * instalada. Até 2026-09-22 esta página só tinha o convite, e sem e-mail ele
 * virava um link copiado de uma tela marcada "(DEV)".
 *
 * **Convidar por e-mail** segue intacto: é o caminho de quem prefere que a
 * pessoa escolha a própria senha. `?modo=convite` abre direto nele.
 */
export default async function TeamInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ modo?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const { modo } = await searchParams;
  const abaInicial = modo === "convite" ? "convite" : "senha";
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Adicionar membros")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Cadastre a pessoa já com uma senha, ou mande um convite para ela criar a própria.")}
        </p>
      </header>
      <Tabs defaultValue={abaInicial} className="flex flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="senha">{t("Cadastrar com senha")}</TabsTrigger>
          <TabsTrigger value="convite">{t("Convidar por e-mail")}</TabsTrigger>
        </TabsList>
        <TabsContent value="senha">
          <CadastroComSenhaForm />
        </TabsContent>
        <TabsContent value="convite" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {t("Cole até 20 emails (um por linha) e escolha a role compartilhada.")}
          </p>
          {isEmailConfigured() ? null : (
            <p className="rounded-md border bg-muted/40 p-3 text-sm">
              {t(
                "O envio de e-mail não está configurado nesta instalação: o convite gera um link que você copia e manda para a pessoa. Para entrar sem link, use “Cadastrar com senha”.",
              )}
            </p>
          )}
          <InviteForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
