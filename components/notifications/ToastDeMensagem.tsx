"use client";

import { MessageCircle, X } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

export interface ToastDeMensagemInput {
  /** Um por conversa: a rajada do mesmo cliente atualiza o aviso, não empilha. */
  id: string;
  nome: string;
  contexto: string | null;
  previa: string;
  rajada: string | null;
  foto?: string;
  aoAbrir: () => void;
}

/** Mensagens chegam para ser lidas — 4 s do toast padrão não dão tempo. */
export const DURACAO_DO_TOAST_DE_MENSAGEM_MS = 8_000;

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return (partes[0] ?? "").slice(0, 2).toUpperCase();
  return `${partes[0]?.[0] ?? ""}${partes[partes.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * O aviso de mensagem na esquina da tela: QUEM (foto + nome), DE ONDE (time e
 * com quem está) e O QUÊ (a prévia). O cartão inteiro abre a conversa.
 *
 * Fica fora do `<Toaster richColors>` padrão de título + descrição porque ali o
 * nome e o texto tinham o mesmo peso — com três avisos empilhados, o olho não
 * achava de quem era cada um.
 */
export function mostrarToastDeMensagem(input: ToastDeMensagemInput): void {
  const idioma = idiomaAtual();
  const t = (texto: string) => traduzir(texto, idioma);
  toast.custom(
    (id) => (
      <div
        data-testid="toast-de-mensagem"
        className="group relative flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-3 rounded-lg border border-border bg-surface p-3 pr-8 text-left shadow-lg"
      >
        <button
          type="button"
          onClick={() => {
            input.aoAbrir();
            toast.dismiss(id);
          }}
          aria-label={`${t("Abrir conversa com")} ${input.nome}`}
          className="absolute inset-0 rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        />
        <Avatar className="pointer-events-none h-10 w-10 shrink-0">
          {input.foto ? <AvatarImage src={input.foto} alt="" /> : null}
          <AvatarFallback className="bg-surface-elevated text-xs font-medium text-text-muted">
            {iniciais(input.nome)}
          </AvatarFallback>
        </Avatar>
        <div className="pointer-events-none min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="truncate text-sm font-semibold text-text" data-testid="toast-de-mensagem-nome">
              {input.nome}
            </p>
            {input.rajada ? (
              <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold leading-4 text-accent-foreground">
                {input.rajada}
              </span>
            ) : null}
          </div>
          {input.contexto ? (
            <p className="flex items-center gap-1 truncate text-xs text-text-muted" data-testid="toast-de-mensagem-contexto">
              <MessageCircle className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{input.contexto}</span>
            </p>
          ) : null}
          <p className="mt-1 line-clamp-2 break-words text-sm text-text" data-testid="toast-de-mensagem-previa">
            {input.previa}
          </p>
        </div>
        <button
          type="button"
          onClick={() => toast.dismiss(id)}
          aria-label={t("Fechar")}
          className="absolute right-2 top-2 rounded-md p-0.5 text-text-muted hover:bg-surface-elevated hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    ),
    { id: input.id, duration: DURACAO_DO_TOAST_DE_MENSAGEM_MS },
  );
}
