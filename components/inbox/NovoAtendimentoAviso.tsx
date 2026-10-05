"use client";
import { useState } from "react";

import { ChamarNoWhatsAppDialog } from "@/components/contacts/ChamarNoWhatsAppDialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * O PÉ DA CONVERSA ENCERRADA — o atendimento acabou, e aqui está como começar
 * outro.
 *
 * ─── O que havia neste lugar, e o que ele produzia ──────────────────────────
 *
 * Com a conversa encerrada o campo de texto trava. Mas no canal oficial o
 * seletor de modelo aprovado (`JanelaFechadaAviso`) continuava aparecendo logo
 * acima — ele pergunta pela janela de 24h, não pelo estado da conversa. O que
 * saía por ele ia pela rota comum de envio, que não abre atendimento: a
 * mensagem era gravada DENTRO do atendimento encerrado.
 *
 * Medido em produção em 2026-10-05 — 53 mensagens em 48 conversas desde 19/09:
 *
 *   - 32 foram seguidas de "Reabrir", que continua o MESMO atendimento: o
 *     contato de hoje saiu com o protocolo de dias atrás (o relato que originou
 *     este arquivo: chamado em 25/09, chamado de novo em 01/10, um protocolo só);
 *   - 13 ficaram lá, numa conversa que seguiu "Fechada";
 *   - em 8 o cliente respondeu, e a resposta abriu um atendimento sem time e
 *     sem dono — caiu no rodízio, não em quem chamou.
 *
 * ─── A saída certa já existia ───────────────────────────────────────────────
 *
 * "Chamar no WhatsApp" numa conversa encerrada abre atendimento novo, com
 * protocolo próprio, no time escolhido e em nome de quem chamou. Este aviso só
 * põe essa porta onde a pessoa está. "Reabrir", no cabeçalho, continua
 * existindo para o caso dele: seguir o mesmo atendimento, fechado por engano.
 */
export function NovoAtendimentoAviso({
  contactId,
  nome,
  telefone,
  conexaoId,
  onIniciada,
}: {
  contactId: string;
  nome: string;
  /** Só para MOSTRAR: quem resolve o destino é o servidor, pelo cadastro. */
  telefone?: string | null;
  /** O número desta conversa — é por ele que o atendimento novo sai por padrão. */
  conexaoId: string | null;
  /** O Inbox mostra a conversa que voltou (ou a de outro número, se foi o escolhido). */
  onIniciada: (conversationId: string) => void;
}) {
  const t = useT();
  const [chamando, setChamando] = useState(false);

  return (
    <div
      data-testid="aviso-atendimento-encerrado"
      className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-xs text-text-muted">
        {t("Este atendimento foi encerrado. Para falar com o cliente de novo, comece um atendimento novo — ele ganha um protocolo próprio.")}
      </p>
      <Button type="button" size="sm" onClick={() => setChamando(true)}>
        {t("Chamar no WhatsApp")}
      </Button>

      {chamando && (
        <ChamarNoWhatsAppDialog
          open
          onOpenChange={setChamando}
          contactId={contactId}
          phoneNumber={telefone ?? undefined}
          nome={nome}
          conexaoInicial={conexaoId}
          atendimentoAnteriorEncerrado
          onIniciada={onIniciada}
        />
      )}
    </div>
  );
}
