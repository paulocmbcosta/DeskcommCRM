"use client";
import { useState } from "react";
import Link from "next/link";

import { ChamarNoWhatsAppDialog } from "@/components/contacts/ChamarNoWhatsAppDialog";
import { useT } from "@/hooks/i18n/useT";
import { ArrowRight, ChatCircle } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";

/**
 * A porta para a conversa, dentro do dossiê — e, quando ela não existe, a porta
 * para CRIAR uma.
 *
 * ─── Por que não bastava o atalho do card ───────────────────────────────────
 *
 * O card tem o atalho desde o PR do quadro, e ele funciona. Mas o dossiê é para
 * onde se vai quando a pergunta é "o que está acontecendo com este negócio?" — e
 * lá dentro a linha do tempo ANUNCIA "Entrou pelo WhatsApp / primeira mensagem
 * recebida no WhatsApp" e não oferecia nenhum jeito de abrir essa conversa.
 *
 * Anunciar um canal e não dar a porta é pior que não anunciar: quem lê procura,
 * não acha, e fecha o painel para ir caçar a conversa na mão no inbox.
 *
 * ─── Por que aqui é um bloco, e no card é uma linha ─────────────────────────
 *
 * No card o espaço é disputado por oito outras coisas e a prévia precisa caber
 * em uma linha discreta. No dossiê não há disputa, e o alvo de clique pode ser
 * grande o suficiente para ser óbvio — que é o defeito que se está consertando.
 *
 * ─── A ausência deixou de ser um beco ───────────────────────────────────────
 *
 * Este componente dizia que "ausência continua sendo estado normal" e devolvia
 * `null` quando não havia conversa. Era verdade pela metade: contato sem
 * conversa é mesmo normal, mas devolver nada transformava o caso mais comum de
 * todos — **o cliente que a gente ainda não chamou** — no único sem saída.
 * Quem abria o dossiê de um cliente recém-importado do IXC via o cadastro
 * inteiro e nenhuma forma de falar com ele.
 *
 * Agora a ausência oferece o começo. Sem `contactId` (negócio criado à mão, sem
 * contato vinculado) não há a quem escrever, e aí o bloco continua sumindo — é
 * o único caso em que "não há nada a oferecer" é literal.
 */
export function ConversaNoDossie({
  conversa,
  contactId,
  nome,
  telefone,
}: {
  conversa: Contact["conversa"] | null | undefined;
  /** Sem ele não há destinatário, e o bloco some. */
  contactId?: string | null;
  /** Como chamar a pessoa no diálogo. Cai para um genérico se a tela não souber. */
  nome?: string;
  /** Só para MOSTRAR: quem resolve o destino é o servidor, pelo cadastro. */
  telefone?: string | null;
}) {
  const t = useT();
  const [chamando, setChamando] = useState(false);

  if (!conversa) {
    if (!contactId) return null;
    return (
      <>
        <button
          type="button"
          onClick={() => setChamando(true)}
          className="group mt-3 flex w-full items-center gap-2.5 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <ChatCircle size={16} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-text">{t("Chamar no WhatsApp")}</span>
            <span className="block truncate text-[11px] text-text-muted">
              {t("Ainda não há conversa — comece você")}
            </span>
          </span>
          <ArrowRight
            size={14}
            weight="regular"
            className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </button>

        {chamando && (
          <ChamarNoWhatsAppDialog
            open
            onOpenChange={setChamando}
            contactId={contactId}
            phoneNumber={telefone ?? undefined}
            nome={nome?.trim() || t("este contato")}
          />
        )}
      </>
    );
  }

  const preview = conversa.preview?.trim();

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      className="group mt-3 flex items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted"
    >
      <ChatCircle size={16} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-text">{t("Abrir conversa no Inbox")}</span>
        {preview && (
          // A última mensagem responde "vale a pena entrar agora?" sem entrar —
          // sem ela o botão é uma aposta, e o dossiê já existe para não obrigar
          // a abrir outra tela para saber.
          <span className="block truncate text-[11px] text-text-muted">{preview}</span>
        )}
      </span>
      {conversa.unread > 0 && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
      <ArrowRight
        size={14}
        weight="regular"
        className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}
