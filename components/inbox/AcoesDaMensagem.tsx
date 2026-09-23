"use client";

import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import {
  EMOJIS_DA_GRADE,
  EMOJIS_RAPIDOS,
  ehEmojiValido,
  type ReacoesDaMensagem,
} from "@/lib/messaging/reacoes";
import { ArrowBendUpLeft, CaretDown, Plus, Smiley } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  /** Lado da conversa em que o botão está — o menu abre para dentro dela. */
  lado: "esquerda" | "direita";
  onResponder?: () => void;
  /** Ausente = o canal (ou o momento) não permite reagir: o item some. */
  onReagir?: (emoji: string) => void;
  /** A reação atual do NOSSO lado — clicar nela de novo a tira, como no WhatsApp. */
  minhaReacao?: string | null;
}

/**
 * O botão de ações do balão (DYD-16): "Responder" e "Reagir", e o Reagir abre
 * os seis emojis do WhatsApp mais o "+" para qualquer outro.
 *
 * VISÍVEL POR PADRÃO e escondido só onde existe hover — a mesma regra do
 * botão de responder que ele substitui: no celular não há como passar o mouse,
 * e a função sumiria exatamente onde mais se atende.
 */
export function AcoesDaMensagem({ lado, onResponder, onReagir, minhaReacao }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [tela, setTela] = useState<"menu" | "reagir" | "mais">("menu");
  const [outro, setOutro] = useState("");

  const abrir = (v: boolean) => {
    setAberto(v);
    if (!v) {
      setTela("menu");
      setOutro("");
    }
  };
  const reagir = (emoji: string) => {
    // A mesma reação de novo TIRA a reação — é o gesto do celular.
    onReagir?.(emoji === minhaReacao ? "" : emoji);
    abrir(false);
  };
  const outroValido = ehEmojiValido(outro.trim());

  return (
    <Popover open={aberto} onOpenChange={abrir}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("Ações da mensagem")}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
            "opacity-100 [@media(hover:hover)]:opacity-0",
            "focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100",
            aberto && "[@media(hover:hover)]:opacity-100",
          )}
        >
          <CaretDown size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={lado === "direita" ? "end" : "start"}
        className={cn("p-1", tela === "menu" ? "w-44" : tela === "reagir" ? "w-auto" : "w-72")}
      >
        {tela === "menu" && (
          <div className="flex flex-col">
            {onResponder && (
              <button
                type="button"
                aria-label={t("Responder a esta mensagem")}
                onClick={() => {
                  onResponder();
                  abrir(false);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <ArrowBendUpLeft size={14} /> {t("Responder")}
              </button>
            )}
            {onReagir && (
              <button
                type="button"
                onClick={() => setTela("reagir")}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <Smiley size={14} /> {t("Reagir")}
              </button>
            )}
          </div>
        )}

        {tela === "reagir" && (
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label={t("Escolha uma reação")}
          >
            {EMOJIS_RAPIDOS.map((e, i) => (
              <button
                key={e}
                // O botão "Reagir" que tinha o foco acabou de sumir: sem isto o
                // foco cai no <body> e quem navega por teclado se perde.
                autoFocus={i === 0}
                type="button"
                aria-label={`${t("Reagir com")} ${e}`}
                aria-pressed={e === minhaReacao}
                onClick={() => reagir(e)}
                className={cn(
                  "rounded-full p-1 text-xl leading-none transition-transform hover:scale-125 hover:bg-muted",
                  e === minhaReacao && "bg-muted",
                )}
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              aria-label={t("Mais emojis")}
              onClick={() => setTela("mais")}
              className="ml-0.5 rounded-full bg-muted p-1.5 text-muted-foreground hover:text-foreground"
            >
              <Plus size={14} />
            </button>
          </div>
        )}

        {tela === "mais" && (
          <div className="space-y-2 p-1">
            <div
              className="grid grid-cols-10 gap-0.5"
              role="group"
              aria-label={t("Todos os emojis")}
            >
              {EMOJIS_DA_GRADE.map((e, i) => (
                <button
                  key={e}
                  autoFocus={i === 0}
                  type="button"
                  aria-label={`${t("Reagir com")} ${e}`}
                  onClick={() => reagir(e)}
                  className={cn(
                    "rounded-md p-0.5 text-lg leading-none hover:bg-muted",
                    e === minhaReacao && "bg-muted",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
            <form
              className="flex items-center gap-1 border-t pt-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (outroValido) reagir(outro.trim());
              }}
            >
              <input
                value={outro}
                onChange={(ev) => setOutro(ev.target.value)}
                placeholder={t("Outro emoji")}
                aria-label={t("Outro emoji")}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-base"
              />
              <button
                type="submit"
                disabled={!outroValido}
                className="h-8 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {t("Reagir")}
              </button>
            </form>
            <p className="text-[11px] text-muted-foreground">
              {t(
                "Cole um emoji ou abra o teclado de emojis do sistema (Windows: Win + . · Mac: Ctrl + Cmd + Espaço).",
              )}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** As reações coladas na borda de baixo do balão, como no WhatsApp. */
export function ReacoesDoBalao({
  reacoes,
  lado,
}: {
  reacoes: ReacoesDaMensagem;
  lado: "esquerda" | "direita";
}) {
  const t = useT();
  const itens = [
    reacoes.contato && { emoji: reacoes.contato.emoji, quem: t("Cliente") },
    reacoes.empresa && { emoji: reacoes.empresa.emoji, quem: t("Nós") },
  ].filter(Boolean) as { emoji: string; quem: string }[];
  if (itens.length === 0) return null;
  const titulo = itens.map((i) => `${i.quem}: ${i.emoji}`).join(" · ");
  return (
    <div
      title={titulo}
      role="img"
      aria-label={`${t("Reações")}: ${titulo}`}
      data-testid="reacoes-do-balao"
      className={cn(
        "relative z-10 -mt-2 flex items-center gap-0.5 rounded-full border bg-background px-1.5 py-0.5 text-sm leading-none shadow-sm",
        lado === "direita" ? "mr-2 self-end" : "ml-2 self-start",
      )}
    >
      {itens.map((i) => (
        <span key={i.quem}>{i.emoji}</span>
      ))}
    </div>
  );
}
