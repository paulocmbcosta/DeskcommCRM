"use client";

/**
 * O TOM DO CLIENTE no topo da conversa (migration 0280).
 *
 * Pedido do dono (2026-09-25): quem pega a conversa precisa saber, antes de ler,
 * se o cliente está irritado — para dar atenção. A nota vem do worker de
 * sentimento, que classifica toda mensagem do cliente (com a IA ou com uma
 * pessoa); a conversa guarda a última e a pior do atendimento.
 *
 * Aqui aparece em TODA faixa (satisfeito também informa); no card só quando pede
 * atenção. Texto E cor: a faixa vem escrita, e a dica diz a nota e o pior momento.
 */
import { useT } from "@/hooks/i18n/useT";
import {
  formatarNota,
  ROTULO_DA_FAIXA,
  sentimentoDaConversa,
  type FaixaDeSentimento,
} from "@/lib/inbox/sentimento";
import { Smiley, SmileyMeh, SmileySad } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const COR: Record<FaixaDeSentimento, string> = {
  satisfeito: "border-success/40 bg-success-bg text-success-fg",
  neutro: "border-border text-text-muted",
  insatisfeito: "border-alert/50 bg-alert/25 text-alert-fg",
  critico: "border-error bg-error text-bg",
};

export function SeloDeSentimento({
  conversa,
}: {
  conversa: { status: string; sentimento_atual?: number | null; sentimento_minimo?: number | null };
}) {
  const t = useT();
  const s = sentimentoDaConversa(conversa);
  if (!s) return null;
  const Icone = s.faixa === "satisfeito" ? Smiley : s.faixa === "neutro" ? SmileyMeh : SmileySad;
  const pior =
    s.minimo < s.atual ? ` · ${t("pior momento do atendimento")}: ${formatarNota(s.minimo)}` : "";
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
        COR[s.faixa],
      )}
      data-testid="selo-sentimento-da-conversa"
      data-faixa={s.faixa}
      title={`${t("Tom do cliente, pelas mensagens dele")}: ${t(ROTULO_DA_FAIXA[s.faixa])} · ${t("nota")} ${formatarNota(s.atual)} (0 ${t("a")} 1)${pior}`}
    >
      <Icone size={11} weight="fill" aria-hidden />
      {t(ROTULO_DA_FAIXA[s.faixa])} · {formatarNota(s.atual)}
    </span>
  );
}
