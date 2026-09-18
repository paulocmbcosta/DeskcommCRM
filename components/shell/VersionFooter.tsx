"use client";
import Link from "next/link";

import { ArrowCircleUp } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { cn } from "@/lib/utils";

/**
 * Controle essencial da instalação: não é removível pela interface do vínculo.
 * Versão instalada no rodapé da sidebar. Vira um aviso clicável só para quem
 * é dono do servidor E tem versão nova — quem não pode atualizar não é
 * alertado sobre algo que não pode resolver.
 */
export function VersionFooter({
  collapsed,
  onNavigate,
  variante,
}: {
  collapsed: boolean;
  /** Fecha a gaveta do mobile — é o único Link do drawer que não a recebia. */
  onNavigate?: () => void;
  /**
   * QUAL das duas formas desenhar. O rodapé tem duas — o rótulo discreto
   * ("versão 1.30.0") e o ALERTA de versão nova — e elas custam alturas
   * diferentes. O rótulo discreto ocupava uma linha inteira (~24px) que o
   * orçamento de altura do menu nunca contou: medido em 1280×900 como admin, com
   * ele presente o menu precisava de 744px e tinha 739px. Agora a barra lateral
   * o põe NA MESMA LINHA do "Recolher", e só o alerta, que pede atenção, segue
   * com linha própria. Ausente = as duas, como antes (o comportamento de quem
   * já usava o componente não muda).
   */
  variante?: "discreta" | "alerta";
}) {
  const t = useT();
  const { data } = useSystemVersion();
  if (!data?.current_version) return null;

  const label = data.current_version.replace(/^v/i, "");
  // Só acende quando existe versão nova de verdade. `off_release` sozinho não
  // conta: uma instalação de desenvolvimento sem versão publicada mais nova
  // ficava com o ponto pulsando pra sempre, e o texto "Nova versão · " com o
  // número vazio, apontando para uma tela que não tem o que oferecer.
  const alerta = data.is_owner && data.update_available;

  if (!alerta) {
    if (variante === "alerta") return null;
    return (
      <p
        data-testid="versao-em-execucao"
        className={cn(
          // Em linha com o "Recolher" não há padding horizontal próprio: quem
          // posiciona é a linha. Sozinho (rail recolhido, gaveta do celular),
          // volta a ter o seu.
          variante === "discreta" && !collapsed ? "shrink-0 pr-3 text-[11px]" : "px-3 py-1 text-[11px]",
          "text-muted-foreground",
          collapsed && "px-0 text-center",
        )}
        title={`${t("Versão")} ${label}`}
      >
        {collapsed ? label.split(".").slice(0, 2).join(".") : `${t("versão")} ${label}`}
      </p>
    );
  }

  if (variante === "discreta") return null;
  const novo = data.latest_version?.replace(/^v/i, "") ?? "";
  return (
    <Link
      href="/app/settings/atualizacao"
      onClick={onNavigate}
      title={`${t("Nova versão")} ${novo} ${t("disponível")}`}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-xs text-foreground hover:bg-accent/50",
        collapsed && "justify-center px-2",
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      {!collapsed && (
        <span className="truncate">
          {t("Nova versão")}
          {novo ? ` · ${novo}` : ""}
        </span>
      )}
      {collapsed && <ArrowCircleUp size={16} aria-hidden />}
    </Link>
  );
}
