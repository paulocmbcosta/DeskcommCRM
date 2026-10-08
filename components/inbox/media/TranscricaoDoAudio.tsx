"use client";
import { useEffect, useId, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  estadoDaTranscricao,
  JANELA_DA_TRANSCRICAO_MS,
  trechoDaTranscricao,
} from "@/lib/inbox/transcricao-do-audio";
import type { Message } from "@/lib/types/messaging";
import { cn } from "@/lib/utils";

interface Props {
  message: Message;
  isOutbound: boolean;
}

/**
 * O que o cliente FALOU, por escrito, logo abaixo do player — para o atendente
 * ler em vez de ouvir. Mostra o começo; "Ler mais" abre a caixa inteira ali
 * mesmo, sem tirar a conversa de vista (cliente que manda quatro áudios seguidos
 * é comum, e os quatro podem ficar abertos ao mesmo tempo).
 *
 * Não busca nada: o texto vem na própria mensagem, e chega sozinho quando o
 * worker termina — `useMessagesRealtime` recarrega a conversa a cada mudança na
 * linha.
 */
export function TranscricaoDoAudio({ message, isOutbound }: Props) {
  const t = useT();
  const idDoTexto = useId();
  const caixaRef = useRef<HTMLDivElement>(null);
  const [aberta, setAberta] = useState(false);
  const [agora, setAgora] = useState(() => Date.now());

  const estado = estadoDaTranscricao(message, agora);
  const transcrevendo = estado?.tipo === "transcrevendo";

  // "Transcrevendo…" tem prazo. Sem este relógio a frase ficaria na tela até a
  // próxima renderização por outro motivo — prometendo um texto que não veio.
  // `agora` está nas dependências para o relógio se REARMAR: se ele disparar e o
  // prazo ainda não tiver vencido (o relógio do sistema andou para trás), sem
  // rearmar a frase ficaria presa.
  useEffect(() => {
    if (!transcrevendo) return;
    const resta = JANELA_DA_TRANSCRICAO_MS - (Date.now() - Date.parse(message.created_at));
    const id = window.setTimeout(() => setAgora(Date.now()), Math.max(resta, 0) + 100);
    return () => window.clearTimeout(id);
  }, [transcrevendo, message.created_at, agora]);

  // Abriu: a caixa cresce para baixo e, no último balão da conversa, o fim dela
  // ficaria fora da tela. `nearest` não mexe em nada quando ela já está inteira
  // à vista.
  useEffect(() => {
    if (aberta) caixaRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [aberta]);

  if (!estado) return null;

  if (estado.tipo !== "texto") {
    return (
      <p
        data-testid="transcricao-do-audio"
        data-estado={estado.tipo}
        role={transcrevendo ? "status" : undefined}
        className="mt-1 text-[11px] italic opacity-70"
      >
        {estado.tipo === "transcrevendo"
          ? t("Transcrevendo…")
          : estado.tipo === "sem_fala"
            ? t("Nenhuma fala reconhecida neste áudio")
            : t("Transcrição indisponível")}
      </p>
    );
  }

  const { trecho, cortou } = trechoDaTranscricao(estado.texto);

  return (
    <div
      ref={caixaRef}
      data-testid="transcricao-do-audio"
      data-estado="texto"
      // A mesma moldura da citação do balão: um bloco que é conteúdo de outra
      // origem (ali, a mensagem citada; aqui, o que a máquina ouviu).
      className={cn(
        "mt-1.5 w-72 max-w-full rounded-md border-l-2 px-2 py-1.5",
        isOutbound
          ? "border-primary-foreground/50 bg-primary-foreground/10"
          : "border-primary bg-background/60",
      )}
    >
      {/* O rótulo não é enfeite: sem ele o texto se lê como algo que o cliente
          DIGITOU. Nome, valor e número de documento são onde a transcrição mais
          erra — e é o que o atendente mais copia. */}
      <div
        className="mb-0.5 text-[10px] font-semibold tracking-wide uppercase opacity-60"
        title={t("Gerada automaticamente a partir do áudio. Pode conter erros.")}
      >
        {t("Transcrição automática")}
      </div>
      <p
        id={idDoTexto}
        // Aberta, a caixa pode rolar por dentro — e quem navega pelo teclado só
        // rola o que consegue focar.
        tabIndex={aberta ? 0 : undefined}
        className={cn(
          "text-[13px] leading-snug break-words whitespace-pre-wrap",
          // Um áudio de três minutos passa de 3.000 caracteres: aberta, a caixa
          // rola por dentro em vez de empurrar a conversa uma tela inteira.
          aberta && "max-h-64 overflow-y-auto pr-1",
        )}
      >
        {aberta ? estado.texto : trecho}
      </p>
      {estado.incompleta && (aberta || !cortou) && (
        // O texto bateu no teto do que o sistema guarda: o áudio continua, e
        // quem lê precisa saber que o fim não está aqui.
        <p data-testid="transcricao-incompleta" className="mt-1 text-[11px] italic opacity-70">
          {t("O áudio continua além deste ponto: a transcrição tem um limite de tamanho.")}
        </p>
      )}
      {cortou && (
        <button
          type="button"
          aria-expanded={aberta}
          aria-controls={idDoTexto}
          onClick={() => setAberta((v) => !v)}
          className="mt-1 rounded-sm text-[11px] font-semibold underline-offset-2 hover:underline focus-visible:underline"
        >
          {aberta ? t("Ler menos") : t("Ler mais")}
        </button>
      )}
    </div>
  );
}
