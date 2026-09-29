"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";
import { StatusDoAtendente } from "./StatusDoAtendente";
import { BotaoDoTelefone } from "@/components/telefonia/BotaoDoTelefone";
import { TOPO_ABAIXO_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

export function TopBar() {
  return (
    // Gruda LOGO ABAIXO das faixas do topo (acompanhamento, conexão caída, aviso
    // de instabilidade), que publicam a altura delas — em `top: 0`, o contêiner
    // `z-50` das faixas cobria esta barra ao rolar. Ver lib/ui/faixas-do-topo.ts.
    <header
      className="sticky z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-4 md:px-6"
      style={{ top: TOPO_ABAIXO_DAS_FAIXAS }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      <div className="flex min-w-0 flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <BotaoDoTelefone />
        <StatusDoAtendente />
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
