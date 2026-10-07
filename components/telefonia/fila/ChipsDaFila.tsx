"use client";
/**
 * OS CHIPS DA FILA DO TELEFONE — quantas ligações esperam em cada time, e há
 * quanto tempo a mais antiga espera. Um clique filtra a aba por aquele time.
 *
 * São o mesmo chip dos times da aba Todas (`ChipsDosTimes`), com as mesmas
 * medidas e o mesmo nome acessível ("Filtrar por time: <nome>"): quem aprendeu
 * um, sabe o outro. A diferença é o que contam — lá, conversas; aqui, ligações
 * esperando por uma pessoa (aguardando, tocando ou transferida para a fila).
 *
 * As contagens saem da MESMA lista que a coluna desenha, já filtrada pelo número
 * da empresa e NÃO pelo time: filtrar por time zeraria os outros chips, e o selo
 * de um chip nunca pode contar o que a lista não mostra.
 */
import { CHIP, CHIP_DESLIGADO, CHIP_LIGADO } from "@/components/inbox/ChipsDosTimes";
import { useT } from "@/hooks/i18n/useT";
import { quantasEsperam, relogio, resumoDoTime, type FilaDoTelefone, type LigacaoNaFila } from "@/lib/telefonia/fila";
import { Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  times: FilaDoTelefone["times"];
  ligacoes: LigacaoNaFila[];
  /** O relógio do banco, já corrigido pela defasagem (ms). */
  agoraMs: number;
  /** O filtro de time em vigor: `undefined` (todos) ou um id. */
  timeEscolhido?: string;
  onEscolherTime: (id: string | undefined) => void;
}

export function ChipsDaFila({ times, ligacoes, agoraMs, timeEscolhido, onEscolherTime }: Props) {
  const t = useT();
  const total = quantasEsperam(ligacoes);

  // Sem ninguém esperando não há o que filtrar, e a faixa devolve a altura à
  // lista. Com um time ESCOLHIDO ela fica mesmo vazia: é nela que mora o
  // "Todos" que desfaz o filtro.
  if (total === 0 && timeEscolhido === undefined) return null;

  // O time com mais gente esperando à esquerda — é o que mais precisa estar à
  // vista. Time sem ninguém some, a não ser o escolhido (senão o filtro em vigor
  // ficaria sem chip para desligá-lo).
  const visiveis = times
    .map((time) => ({ time, ...resumoDoTime(ligacoes, time.id, agoraMs) }))
    .filter((c) => c.esperando > 0 || c.time.id === timeEscolhido)
    .sort((a, b) => b.esperando - a.esperando || a.time.nome.localeCompare(b.time.nome, "pt-BR"));

  return (
    <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5" data-testid="chips-da-fila">
      <button
        type="button"
        className={cn(CHIP, timeEscolhido === undefined ? CHIP_LIGADO : CHIP_DESLIGADO)}
        aria-pressed={timeEscolhido === undefined}
        onClick={() => onEscolherTime(undefined)}
      >
        {t("Todos")}
        <span className="tabular-nums">{total}</span>
      </button>
      {visiveis.map(({ time, esperando, maisAntigaMs }) => {
        const ligado = timeEscolhido === time.id;
        return (
          <button
            key={time.id}
            type="button"
            data-team-id={time.id}
            className={cn(CHIP, ligado ? CHIP_LIGADO : CHIP_DESLIGADO)}
            aria-pressed={ligado}
            aria-label={`${t("Filtrar por time")}: ${time.nome}${esperando > 0 ? ` (${esperando} ${t("na fila")})` : ""}`}
            onClick={() => onEscolherTime(ligado ? undefined : time.id)}
          >
            <span className="max-w-32 truncate">{time.nome}</span>
            <span className="tabular-nums">{esperando}</span>
            {/* O relógio vem com ícone: colado ao número, "3 3:20" se lê "33:20". */}
            {maisAntigaMs !== null && (
              <span className="inline-flex items-center gap-0.5 tabular-nums" data-testid="chip-espera" aria-hidden>
                <Clock size={10} weight="regular" aria-hidden />
                {relogio(maisAntigaMs)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
