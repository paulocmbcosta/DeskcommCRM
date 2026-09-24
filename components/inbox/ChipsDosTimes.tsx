"use client";

/**
 * OS CHIPS DE TIME da aba Todas — substituem os grupos por time.
 *
 * Antes, Todas agrupava a lista por time, com "Sem time" em cima e os demais
 * em ordem alfabética. Com volume, o time do fim (o Suporte, na Totus) virava
 * uma barra longa depois de todos os outros, e rastrear uma conversa dele era
 * rolar a lista inteira (pedido do dono, 2026-09-24). Agora a lista é uma só,
 * por tempo, e o time é um FILTRO de um clique, com o total à vista.
 *
 * O trilho de abas (Fila, Minhas, Todas…) não muda: isto só existe em Todas.
 *
 * Os números vêm de `counts?by_team=true`, contados SEM o filtro de time (senão
 * escolher "Suporte" zeraria os outros chips). O vermelho "N na fila" é quantos
 * daquele time ninguém pegou; a dica diz POR QUÊ (`/conversations/teams/fila`,
 * a mesma régua do roteador).
 *
 * O nome acessível de cada chip é "Filtrar por time: <nome>" — o mesmo dos
 * cabeçalhos de grupo que eles substituem, que o e2e já dirige.
 */
import { useT } from "@/hooks/i18n/useT";
import type { ConversationCounts } from "@/hooks/inbox/useConversationCounts";
import type { FilaDoTime, MotivoDaFila } from "@/lib/inbox/fila-do-time";
import { HourglassMedium, SortAscending } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MOTIVO: Record<MotivoDaFila, string> = {
  livre: "Há atendente livre: a conversa deve ser entregue em instantes.",
  fechado: "O time está fora do horário de atendimento.",
  sem_membros: "O time não tem nenhum atendente cadastrado.",
  ninguem_disponivel: "Nenhum atendente do time está disponível agora.",
  todos_ocupados: "Todos os atendentes disponíveis estão no limite de conversas.",
};

interface Props {
  /** `false` em Minhas: só a ordem por espera (os times e a fila são de Todas). */
  mostrarTimes?: boolean;
  contagens?: ConversationCounts["by_team"];
  erro?: boolean;
  onRecarregar?: () => void;
  /** O filtro de time em vigor: `undefined` (todos), `none` (sem time) ou um id. */
  timeEscolhido?: string;
  onEscolherTime: (teamId: string | undefined) => void;
  soNaFila: boolean;
  onSoNaFila: (ligado: boolean) => void;
  porEspera: boolean;
  onPorEspera: (ligado: boolean) => void;
  motivos?: FilaDoTime[];
}

const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors";
const CHIP_LIGADO = "border-accent bg-accent-soft text-accent";
const CHIP_DESLIGADO =
  "border-border bg-surface text-text-muted hover:bg-surface-elevated hover:text-text";

export function ChipsDosTimes({
  mostrarTimes = true,
  contagens,
  erro = false,
  onRecarregar,
  timeEscolhido,
  onEscolherTime,
  soNaFila,
  onSoNaFila,
  porEspera,
  onPorEspera,
  motivos,
}: Props) {
  const t = useT();
  const grupos = contagens ?? [];
  const motivoPorTime = new Map((motivos ?? []).map((m) => [m.team_id, m.motivo] as const));
  const total = grupos.reduce((soma, g) => soma + g.count, 0);
  const naFilaTotal = grupos.reduce((soma, g) => soma + (g.na_fila ?? 0), 0);

  // "Sem time" primeiro; depois os times por volume, o maior à esquerda — é o
  // que mais precisa estar à vista. Time zerado some, a não ser o escolhido
  // (senão o filtro em vigor ficaria sem chip para desligá-lo).
  const visiveis = grupos
    .filter((g) => g.count > 0 || (g.team_id ?? "none") === timeEscolhido)
    .sort((a, b) =>
      a.team_id === null
        ? -1
        : b.team_id === null
          ? 1
          : b.count - a.count || (a.name ?? "").localeCompare(b.name ?? "", "pt-BR"),
    );

  return (
    <div className="space-y-2 border-b border-border px-3 py-2" data-testid="chips-dos-times">
      {!mostrarTimes ? null : erro ? (
        <div role="alert" className="text-xs text-text-muted">
          {t("Não foi possível carregar o volume por time.")}
          <Button size="sm" variant="outline" className="ml-2 h-6" onClick={onRecarregar}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={cn(CHIP, timeEscolhido === undefined ? CHIP_LIGADO : CHIP_DESLIGADO)}
            aria-pressed={timeEscolhido === undefined}
            onClick={() => onEscolherTime(undefined)}
          >
            {t("Todos")}
            <span className="tabular-nums">{contagens ? total : "…"}</span>
          </button>
          {visiveis.map((grupo) => {
            const valor = grupo.team_id ?? "none";
            const nome =
              grupo.team_id === null ? t("Sem time") : (grupo.name ?? t("Time indisponível"));
            const naFila = grupo.na_fila ?? 0;
            const motivo = grupo.team_id ? motivoPorTime.get(grupo.team_id) : undefined;
            const ligado = timeEscolhido === valor;
            return (
              <button
                key={valor}
                type="button"
                data-team-id={valor}
                className={cn(CHIP, ligado ? CHIP_LIGADO : CHIP_DESLIGADO)}
                aria-pressed={ligado}
                aria-label={`${t("Filtrar por time")}: ${nome}`}
                title={naFila > 0 && motivo ? t(MOTIVO[motivo]) : undefined}
                onClick={() => onEscolherTime(ligado ? undefined : valor)}
              >
                <span className="max-w-32 truncate">{nome}</span>
                <span className="tabular-nums">{grupo.count}</span>
                {naFila > 0 && (
                  <span
                    className="rounded-full bg-error-bg px-1.5 text-[10px] text-error-fg tabular-nums"
                    data-testid="chip-na-fila"
                  >
                    {naFila} {t("na fila")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {mostrarTimes && (
          <button
            type="button"
            className={cn(
              CHIP,
              soNaFila ? "border-error bg-error-bg text-error-fg" : CHIP_DESLIGADO,
            )}
            aria-pressed={soNaFila}
            onClick={() => onSoNaFila(!soNaFila)}
            title={t("Transferidas para um time e ainda sem atendente")}
          >
            <HourglassMedium size={12} weight={soNaFila ? "fill" : "regular"} aria-hidden />
            {t("Só na fila")}
            {naFilaTotal > 0 && <span className="tabular-nums">{naFilaTotal}</span>}
          </button>
        )}
        <button
          type="button"
          className={cn(CHIP, porEspera ? CHIP_LIGADO : CHIP_DESLIGADO)}
          aria-pressed={porEspera}
          onClick={() => onPorEspera(!porEspera)}
          title={t("Quem está há mais tempo sem resposta aparece primeiro")}
        >
          <SortAscending size={12} weight="regular" aria-hidden />
          {t("Mais tempo esperando")}
        </button>
      </div>
    </div>
  );
}
