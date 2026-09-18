"use client";
import { format } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useBuscaPorProtocolo } from "@/hooks/inbox/useAtendimentos";
import { rotuloDoAtendimento, type AtendimentoResumo } from "@/lib/inbox/eventos-da-conversa";
import { Hash } from "@/lib/ui/icons";

/**
 * A BUSCA PELO NÚMERO DO PROTOCOLO, acima da lista e FORA da aba.
 *
 * A lista de conversas responde dentro da aba em que se está (Fila, Minhas,
 * Fechadas…) e conhece só o protocolo VIGENTE de cada conversa. Quem liga
 * dizendo "meu protocolo é tal" pode ter o número de um atendimento de três
 * meses atrás, numa conversa que hoje está em qualquer aba — ou encerrada.
 * Estes resultados vêm de `atendimentos`, pelo número, sem aba no caminho, e
 * abrem a conversa JÁ recortada naquele atendimento.
 *
 * Não renderiza nada enquanto o termo não parece protocolo: a busca por nome é
 * o caso comum, e um bloco vazio em cima da lista seria ruído.
 */
interface Props {
  termo: string;
  onAbrir: (atendimento: AtendimentoResumo) => void;
}

export function ResultadosPorProtocolo({ termo, onAbrir }: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const busca = useBuscaPorProtocolo(termo);
  const achados = busca.data ?? [];
  if (achados.length === 0) return null;

  return (
    <div className="border-b border-border bg-accent-50/60" data-testid="resultados-por-protocolo">
      <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {t("Atendimentos com este protocolo")}
      </p>
      <ul>
        {achados.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-testid="resultado-por-protocolo"
              onClick={() => onAbrir(a)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-elevated"
            >
              <Hash size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs tabular-nums text-text">{a.protocol}</span>
                  <span className="shrink-0 text-[11px] text-text-muted">{t(rotuloDoAtendimento(a))}</span>
                </span>
                <span className="block truncate text-xs text-text">{a.contato}</span>
                <span className="block text-[11px] tabular-nums text-text-muted">
                  {Number.isNaN(new Date(a.started_at).getTime()) ? "—" : format(new Date(a.started_at), "dd/MM/yyyy HH:mm", { locale })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
