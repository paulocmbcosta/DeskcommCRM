"use client";
import dynamic from "next/dynamic";
import type { ComponentType } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";

/**
 * O REGISTRO DE PAINÉIS — o par, no navegador, de `lib/conectores/registro.ts`.
 *
 * O painel da conversa não sabe o que é IXC: ele recebe a lista de conectores
 * que a organização ligou e pede a ESTE componente o painel de cada um. É o único
 * arquivo de tela que nomeia um conector (cerca: tests/unit/conectores-cerca.test.ts).
 *
 * `dynamic`: o código do painel de um conector só é baixado por quem o abre. A
 * organização que não tem IXC não carrega um byte dele.
 */
export interface PropsDoPainelDeConector {
  contactId: string | null;
  conversationId: string | null;
}

function Carregando() {
  return (
    <div className="space-y-3 p-3">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

const PAINEIS: Record<string, ComponentType<PropsDoPainelDeConector>> = {
  ixc: dynamic(() => import("./ixc/PainelIxc").then((m) => m.PainelIxc), { ssr: false, loading: Carregando }),
};

export function PainelDoConector({ conector, ...props }: PropsDoPainelDeConector & { conector: string }) {
  const t = useT();
  const Painel = PAINEIS[conector];
  if (!Painel) {
    // Conector ligado no banco e sem painel neste build: versão antiga do app
    // lendo banco novo. Dizer isso é melhor que uma aba em branco.
    return <p className="p-3 text-xs text-text-muted">{t("Este conector não tem painel nesta versão.")}</p>;
  }
  // `key` por contato: trocar de conversa REMONTA o painel, e o estado local dele
  // (cadastro escolhido, CPF digitado) não vaza de um cliente para o outro.
  return <Painel key={props.contactId ?? "sem-contato"} {...props} />;
}
