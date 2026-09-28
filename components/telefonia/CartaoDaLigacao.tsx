"use client";
/**
 * A ligação DENTRO da conversa (spec 20 §2.4): o registro que o worker grava
 * como mensagem de sistema com `metadata.voice_call`. Centralizado, como os
 * marcadores de dia — não é fala do cliente nem da empresa, é um fato.
 *
 * O texto é montado aqui a partir do metadado, e não lido do `body`: o `body`
 * existe para a prévia da lista e para busca, e está em português; a tela
 * precisa falar o idioma de quem a usa.
 */
import { format } from "date-fns";

import { PhoneIncoming, PhoneOutgoing, PhoneX } from "@/lib/ui/icons";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

export interface MetadadoDaLigacao {
  id: string;
  direcao: "inbound" | "outbound";
  desfecho: "atendida" | "perdida" | "sem_resposta" | "recusada_pela_rede";
  duracao_ms: number | null;
  atendente_nome?: string | null;
}

export function ligacaoDaMensagem(metadata: unknown): MetadadoDaLigacao | null {
  const v = (metadata as { voice_call?: unknown } | null)?.voice_call as Partial<MetadadoDaLigacao> | undefined;
  if (!v || typeof v.id !== "string" || (v.direcao !== "inbound" && v.direcao !== "outbound")) return null;
  return v as MetadadoDaLigacao;
}

function duracao(ms: number | null): string | null {
  if (!ms || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function CartaoDaLigacao({ ligacao, em }: { ligacao: MetadadoDaLigacao; em: string }) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const recebida = ligacao.direcao === "inbound";
  const atendida = ligacao.desfecho === "atendida";
  const titulo = recebida
    ? atendida
      ? t("Ligação recebida")
      : t("Ligação perdida")
    : atendida
      ? t("Ligação feita")
      : ligacao.desfecho === "recusada_pela_rede"
        ? t("Ligação não completada")
        : t("Ligação sem resposta");
  const Icone = !atendida ? PhoneX : recebida ? PhoneIncoming : PhoneOutgoing;
  // A mesma régua da hora de cada balão (MessageBubble): 24 h, no idioma do app.
  const hora = format(new Date(em), "HH:mm", { locale: localeDaData });
  const tempo = duracao(ligacao.duracao_ms);

  return (
    <div className="flex justify-center py-1" data-ligacao={ligacao.desfecho}>
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
          atendida ? "border-border bg-muted/50 text-foreground" : "border-destructive/30 bg-destructive/5 text-destructive"
        }`}
      >
        <Icone size={14} weight="bold" aria-hidden />
        <span className="font-medium">{titulo}</span>
        {ligacao.atendente_nome && atendida ? (
          <span className="text-muted-foreground">
            · {recebida ? t("atendida por") : t("por")} {ligacao.atendente_nome}
          </span>
        ) : null}
        {tempo ? <span className="tabular-nums text-muted-foreground">· {tempo}</span> : null}
        <span className="tabular-nums text-muted-foreground">· {hora}</span>
      </div>
    </div>
  );
}
