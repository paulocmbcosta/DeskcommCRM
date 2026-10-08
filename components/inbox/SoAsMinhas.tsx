"use client";
import { useT } from "@/hooks/i18n/useT";
import { User } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { ALTERNANCIA, CHIP_DESLIGADO, CHIP_LIGADO } from "./ChipsDosTimes";

/**
 * "SÓ AS MINHAS" — o botão da aba Fechadas.
 *
 * O pedido que originou os filtros por atendente veio de quem atende: "as
 * conversas finalizadas aqui são todas misturadas de todos os atendentes". O
 * seletor completo mora no funil; este é o caso de todo dia, num clique, na
 * linha do título — o mesmo lugar e a mesma aparência das alternâncias de Todas
 * (`AlternanciasDaLista`), que não custam altura nenhuma à lista.
 *
 * É o MESMO filtro do seletor (`assigned_to=me`), não um segundo: ligar aqui
 * marca "Eu" lá, e escolher um colega lá desliga este.
 *
 * "Minhas" quer dizer: estavam comigo quando foram encerradas — e não "fui eu
 * que cliquei em encerrar". Ver `aplicarFiltrosDosFechados`.
 */
export function SoAsMinhas({
  ligado,
  onChange,
}: {
  ligado: boolean;
  onChange: (ligado: boolean) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={cn(ALTERNANCIA, ligado ? CHIP_LIGADO : CHIP_DESLIGADO)}
      aria-pressed={ligado}
      aria-label={t("Só as minhas")}
      title={t("Só os atendimentos que estavam comigo quando foram encerrados")}
      data-testid="so-as-minhas"
      onClick={() => onChange(!ligado)}
    >
      <User size={12} weight={ligado ? "fill" : "regular"} aria-hidden />
      {t("Só as minhas")}
    </button>
  );
}
