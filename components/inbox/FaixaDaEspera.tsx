"use client";
/**
 * A ESPERA NO CORPO DO CHAT. Duas situações, uma faixa só (estado, não log —
 * uma linha por mensagem seria ruído):
 *  · o cliente espera ⇒ "Cliente aguardando resposta há X", na cor do termômetro;
 *  · a Assistente dispensou (migration 0285) ⇒ o porquê, e o único gesto
 *    humano: religar ("Contar mesmo assim"). Ninguém dispensa na mão.
 * O histórico (quem dispensou, quem religou) fica na linha do tempo do painel.
 *
 * Quem manda sai da MESMA regra do card (`comandoDaConversa`), para a faixa e o
 * card nunca discordarem sobre haver espera.
 */
import { Button } from "@/components/ui/button";
import { usePermission } from "@/hooks/auth/AuthProvider";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useManterEspera } from "@/hooks/inbox/useManterEspera";
import { useT } from "@/hooks/i18n/useT";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { esperaDaConversa, esperaDispensada, formatarEspera, type NivelDeEspera } from "@/lib/inbox/espera";
import type { ReguaDeEspera } from "@/lib/schemas/settings";
import { CheckCircle, Siren, Thermometer } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  conversa: ConversationWithContact;
  /** O automático da org está de pé? Mesma entrada do card. */
  automaticoDaOrg?: boolean;
  regua?: ReguaDeEspera;
  /** Relógio de quem monta (o layout já tem um de 30 s). */
  agora: Date;
  /** Atendimento antigo aberto: a espera é do atendimento vigente, não deste. */
  somenteLeitura?: boolean;
}

// Mesmas cores do termômetro do card (`COR_DA_ESPERA`), sem a sirene pulsando:
// aqui a faixa é larga, e piscar o rodapé do chat inteiro distrairia a escrita.
const COR: Record<NivelDeEspera, string> = {
  normal: "border-border bg-surface-elevated text-text-muted",
  amarelo: "border-border bg-warning-bg text-warning-fg",
  laranja: "border-border bg-alert/25 text-alert-fg",
  vermelho: "border-error bg-error text-bg",
};

export function FaixaDaEspera({ conversa, automaticoDaOrg, regua, agora, somenteLeitura = false }: Props) {
  const t = useT();
  const manter = useManterEspera();
  // Mesmo piso da rota (`requireRole("agent")`): viewer e sessão de suporte
  // somente-leitura (rebaixada a viewer em `resolveActiveOrg`) recebem 403 ao
  // clicar — o botão some, o texto explicativo fica.
  const podeEscrever = usePermission("inbox.reply");
  if (somenteLeitura) return null;

  const { comando } = comandoDaConversa(
    {
      status: conversa.status,
      assigned_to_user_id: conversa.assigned_to_user_id,
      assigned_to_user_name: conversa.assigned_to_user_name ?? null,
      assignee_kind: conversa.assignee_kind ?? null,
      bot_silenced_until: conversa.bot_silenced_until ?? null,
      force_human: conversa.contacts?.force_human ?? null,
      is_blocked: conversa.contacts?.is_blocked ?? null,
      automaticoDaOrg,
    },
    agora,
  );
  // "ninguem" (org sem automático) também espera gente — como no card.
  const comandoDaEspera = comando.quem === "ninguem" ? "aguardando" : comando.quem;

  const espera = esperaDaConversa(
    {
      status: conversa.status,
      last_inbound_at: conversa.last_inbound_at,
      last_outbound_at: conversa.last_outbound_at,
      espera_desde: conversa.espera_desde,
      comando_da_conversa: comandoDaEspera,
    },
    agora,
    regua,
  );
  if (espera) {
    return (
      <div
        className={cn("flex items-center gap-2 border-t px-4 py-1.5 text-xs font-medium", COR[espera.nivel])}
        data-testid="faixa-da-espera"
        data-nivel={espera.nivel}
        role="status"
      >
        {espera.nivel === "vermelho" ? (
          <Siren size={14} weight="fill" aria-hidden />
        ) : (
          <Thermometer size={14} weight="fill" aria-hidden />
        )}
        <span>{`${t("Cliente aguardando resposta há")} ${formatarEspera(espera.ms, t)}`}</span>
      </div>
    );
  }

  const dispensada = esperaDispensada({
    status: conversa.status,
    espera_desde: conversa.espera_desde,
    espera_dispensada_ate: conversa.espera_dispensada_ate,
    comando_da_conversa: comandoDaEspera,
  });
  if (!dispensada) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-elevated px-4 py-1.5 text-xs text-text-muted"
      data-testid="faixa-da-espera-dispensada"
      role="status"
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <CheckCircle size={14} weight="regular" aria-hidden />
        <span>{t("Assistente: o cliente só confirmou ou agradeceu — não pede resposta.")}</span>
      </span>
      {podeEscrever && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={manter.isPending}
          onClick={() => manter.mutate(conversa.id)}
        >
          {t("Contar mesmo assim")}
        </Button>
      )}
    </div>
  );
}
