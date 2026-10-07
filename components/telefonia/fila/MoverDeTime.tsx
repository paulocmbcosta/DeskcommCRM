"use client";
/**
 * O MENU DE MOVER uma ligação que espera para a fila de OUTRO time (aba
 * Telefone; entrega 3) — de gerente e admin. Um clique no time manda o pedido;
 * quem confere e recusa, com o motivo, é a rota (time fora do horário, ligação
 * que já foi atendida).
 *
 * Cada time vem com o que o diretório do telefone diz dele AGORA: quantos estão
 * livres, ou que está fora do horário — o mesmo que o seletor da transferência
 * mostra (`TransferirLigacao`), com as mesmas palavras. O diretório só é lido
 * com o menu ABERTO (e relido a cada 5 s enquanto ele fica): com a fila cheia há
 * um destes por linha, e ler sempre seria um pedido por linha a cada 5 s.
 *
 * O time fora do horário NÃO fica desligado aqui: o que o diretório disse pode
 * ter até 5 s, e quem decide é a rota. O menu só avisa.
 */
import { useState } from "react";

import { useDiretorio } from "@/components/telefonia/useDiretorio";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { ArrowsLeftRight, CircleNotch } from "@/lib/ui/icons";

interface Props {
  ligacaoId: string;
  /** Os times para onde dá para mover — já sem o time em que a ligação está. */
  destinos: ReadonlyArray<{ id: string; nome: string }>;
  /** O pedido de mover DESTE navegador ainda corre nesta ligação. */
  movendo: boolean;
  /** Outro pedido deste navegador corre nesta ligação: o menu espera. */
  desligado: boolean;
  onMover: (time: { id: string; nome: string }) => void;
}

export function MoverDeTime({ ligacaoId, destinos, movendo, desligado, onMover }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const { diretorio } = useDiretorio(aberto);
  const noDiretorio = new Map((diretorio?.times ?? []).map((time) => [time.id, time] as const));

  return (
    <DropdownMenu open={aberto} onOpenChange={setAberto}>
      {/* O `disabled` vai no GATILHO, que o repassa ao botão: é o gatilho que
          abre o menu, no `pointerdown` — e o navegador entrega esse evento
          também ao botão desligado. Só no botão, o menu abriria no meio do pedido. */}
      <DropdownMenuTrigger asChild disabled={movendo || desligado}>
        <Button
          size="icon"
          variant="ghost"
          className="lg:h-8 lg:w-8"
          aria-label={t("Mover para outro time")}
          aria-busy={movendo}
          data-fila-mover={ligacaoId}
        >
          {movendo ? <CircleNotch className="animate-spin" aria-hidden /> : <ArrowsLeftRight aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">{t("Mover para outro time")}</DropdownMenuLabel>
        {destinos.map((time) => {
          const agora = noDiretorio.get(time.id);
          return (
            <DropdownMenuItem
              key={time.id}
              className="flex-col items-start gap-0"
              data-fila-mover-para={time.id}
              onClick={() => onMover(time)}
            >
              <span className="max-w-56 truncate">{time.nome}</span>
              {agora ? (
                // Sem cor própria: o item em foco troca fundo e texto, e a dica acompanha.
                <span className="text-[11px] opacity-75">
                  {agora.situacao !== "aberto"
                    ? t("Fora do horário")
                    : agora.disponiveis === 1
                      ? t("1 disponível")
                      : trocarMarcador(t("{n} disponíveis"), "{n}", String(agora.disponiveis))}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
