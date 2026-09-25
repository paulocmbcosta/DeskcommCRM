"use client";

import { faixaDoSentimento, formatarNota, pedeAtencao, ROTULO_DA_FAIXA } from "@/lib/inbox/sentimento";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft, Check, Checks, Robot, WarningOctagon } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { ContactCard } from "@/components/inbox/media/ContactCard";
import { AcoesDaMensagem, ReacoesDoBalao } from "@/components/inbox/AcoesDaMensagem";
import { reacoesDe } from "@/lib/messaging/reacoes";
import { extractCitations, isAiGeneratedMessage } from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
  /**
   * QUEM está lendo a conversa. É o que separa "Você" de "Atendente": a coluna
   * `sent_via='user'` só diz *"um humano digitou no CRM"*, nunca QUAL humano.
   *
   * Sem este id, uma organização com dois atendentes mostrava "Você" nas
   * mensagens do colega — cada um lia o atendimento do outro como se fosse o
   * seu. Por isso a ausência do id NÃO cai em "Você": quem não sabe quem está
   * lendo (a leitura do super-admin em `AdminThread`, por exemplo) rotula
   * "Atendente", que é verdadeiro para todo mundo.
   */
  viewerUserId?: string | null;
  /**
   * Reagir com emoji a esta mensagem (DYD-16). Ausente = o canal não reage, ou
   * a janela de 24h fechou: o item "Reagir" some do menu. `""` tira a reação.
   */
  onReagir?: (m: Message, emoji: string) => void;
}

function AckIndicator({ status, t }: { status: string; t: (texto: string) => string }) {
  if (status === "read") {
    // O azul do WhatsApp (#53bdeb): o balão enviado é a cor de destaque da
    // marca (verde no padrão), e o `blue-400` de antes quase sumia sobre ela.
    return <Checks size={14} weight="bold" className="text-[#53bdeb]" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return (
      <Checks size={14} weight="bold" className="text-current/70" aria-label={t("Entregue")} />
    );
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label={t("Enviada")} />;
  }
  return null;
}

export function MessageBubble({
  message,
  debugCitations,
  onResponder,
  citada,
  viewerUserId,
  onReagir,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  const isContact = message.type === "contact";
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  const apagada = Boolean(message.revoked_at);
  const editada = Boolean(message.edited_at) && !apagada;
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton = isOutbound && aiGenerated && (debugCitations ?? false);
  // De quem saiu esta linha. `external_device` é a resposta pelo CELULAR — o
  // operador atendeu pelo WhatsApp do telefone, fora do CRM, e o ingest carimba
  // aqui. Antes isto voltava null para tudo que não fosse IA, e a bolha ficava
  // sem nome: o dono lia a conversa como se tudo tivesse sido digitado no CRM.
  // Os rótulos passam por t() no render (ver dicionario.ts para o espanhol).
  //
  // NÃO HÁ RAMO PARA `'automation'`. O CHECK do banco aceita o valor e o union
  // de `Message` o declara, mas nenhuma linha de app/, lib/ ou workers/ o
  // grava: as ações de automação chamam `sendMessageHandler` com
  // `actor.type === "webhook_source"`, e `_handler.ts` carimba `'ai'` em tudo
  // que não é `"user"`. Um ramo aqui seria controle decorativo — a tela
  // prometendo uma distinção que o motor não faz. Carimbar `'automation'` na
  // origem é decisão de produto com efeito colateral medido (o dedup de eco da
  // ingestão de canal filtra `sent_via in ('ai','user')`, e o valor novo
  // duplicaria a mensagem na conversa), então fica para uma issue própria.
  // Vigiado nas duas direções por tests/unit/rotulo-de-origem-tem-emissor.
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") return "IA";
    if (message.sent_via === "external_device") return "Celular";
    if (message.sent_via === "user" || message.sent_via === "crm") {
      // "Você" exige as DUAS pontas: saber quem lê e saber quem enviou. Falta
      // qualquer uma, o rótulo cai para "Atendente" — que continua dizendo o
      // que `sent_via` de fato garante (um humano, pelo CRM) sem afirmar uma
      // identidade que o dado não sustenta.
      if (viewerUserId != null && message.sent_by_user_id === viewerUserId) return "Você";
      // O NOME de quem enviou (DYD-13), quando a leitura do histórico o
      // resolveu. É dado, não interface: não passa por t().
      return message.sent_by_name?.trim() ? { nome: message.sent_by_name.trim() } : "Atendente";
    }
    return null;
  })();
  const reacoes = reacoesDe(message.metadata);
  const notaLida = (message.metadata as Record<string, unknown> | null)?.["sentiment_score"];
  const notaDaMensagem = typeof notaLida === "number" ? notaLida : null;
  const faixaDaMensagem = faixaDoSentimento(notaDaMensagem);
  // Desde a 1.46 a nota gravada na mensagem é a do ATENDIMENTO inteiro naquele
  // momento (o Jev lê tudo a cada mensagem); as antigas eram da frase sozinha.
  const escopoDoAtendimento =
    (message.metadata as Record<string, unknown> | null)?.["sentiment_escopo"] === "atendimento";
  // Só reage a quem existe no WhatsApp: sem `external_id` a mensagem não saiu,
  // e apagada não tem mais o que reagir.
  const reagirAqui =
    onReagir && message.external_id && !apagada && message.status !== "failed"
      ? (emoji: string) => onReagir(message, emoji)
      : undefined;
  const responderAqui = onResponder ? () => onResponder(message) : undefined;
  const lado = isOutbound ? ("direita" as const) : ("esquerda" as const);

  // O botão ao lado do balão. Com reação disponível, é o menu de ações
  // (Responder / Reagir — DYD-16); sem ela, segue o atalho direto de responder
  // que já existia, sem clique a mais para quem não tem o que escolher.
  const acoes = reagirAqui ? (
    <AcoesDaMensagem
      lado={lado}
      onResponder={responderAqui}
      onReagir={reagirAqui}
      minhaReacao={reacoes.empresa?.emoji ?? null}
    />
  ) : responderAqui ? (
    <button
      type="button"
      onClick={responderAqui}
      aria-label={t("Responder a esta mensagem")}
      className={cn(
        "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
        // VISÍVEL POR PADRÃO, e escondido só onde EXISTE hover.
        //
        // A primeira versão era `opacity-0` + `group-hover`, copiando o
        // WhatsApp Web. No celular isso deixa o botão invisível para
        // sempre: não há como passar o mouse, e `focus-visible` só chega
        // por teclado. Ou seja, a função sumia exatamente onde o dono
        // deste CRM mais atende.
        //
        // `@media (hover: hover)` pergunta pelo DISPOSITIVO, não pela
        // largura: um tablet largo com toque continua mostrando, e um
        // desktop estreito continua escondendo. Largura não é a pergunta.
        "opacity-100 [@media(hover:hover)]:opacity-0",
        "focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100",
      )}
    >
      <ArrowBendUpLeft size={14} />
    </button>
  ) : null;

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 px-4 py-1",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      {/*
        RESPONDER — aparece ao passar o mouse, como no WhatsApp Web.
        Fica FORA da bolha para não disputar espaço com o texto, e do lado de
        dentro da conversa (à esquerda no que sai, à direita no que entra), que
        é onde a mão já está.

        `opacity` e não `hidden`: esconder de verdade faria o layout pular
        quando o mouse entra. Em telas de toque não há hover — por isso
        `focus-visible` também revela, e o teclado alcança.
      */}
      {isOutbound && acoes}
      <div
        className={cn(
          "flex max-w-[75%] min-w-0 flex-col",
          isOutbound ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "max-w-full text-sm",
            isBareSticker
              ? "px-0 py-0"
              : cn(
                  "rounded-2xl px-3 py-2 shadow-sm",
                  isOutbound
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm bg-muted text-foreground",
                ),
            isFailed && "border border-destructive",
          )}
        >
          {/*
          A CITAÇÃO, dentro da bolha e acima do texto — o fio.

          Mostra de quem era e um trecho. `line-clamp-2` porque serve para
          reconhecer, não para reler: a original está logo acima no histórico.
        */}
          {citada && (
            <div
              className={cn(
                "mb-1 rounded-md border-l-2 px-2 py-1 text-xs",
                isOutbound
                  ? "border-primary-foreground/50 bg-primary-foreground/10"
                  : "border-primary bg-background/60",
              )}
            >
              <div className="font-medium opacity-80">
                {citada.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              {/*
              A CITADA PODE TER SIDO APAGADA — e aí o texto dela não volta aqui.

              A bolha principal já trata isto (`apagada`, acima): "mostrá-lo
              seria expor justamente o que o cliente pediu para tirar do ar". A
              citação é o mesmo texto, num segundo lugar da tela — sem esta
              linha, o "apagar para todos" do cliente sumia da bolha original e
              continuava legível dentro de cada resposta que a citou. O fio
              permanece (a citação some, não a resposta); o conteúdo, não.
            */}
              <div className={cn("line-clamp-2 opacity-70", citada.revoked_at && "italic")}>
                {citada.revoked_at
                  ? t("Esta mensagem foi apagada")
                  : citada.body?.trim() || t("(sem texto)")}
              </div>
            </div>
          )}
          {senderLabel && (
            <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-80">
              {senderLabel === "IA" ? <Robot size={10} weight="duotone" aria-hidden /> : null}
              {typeof senderLabel === "string" ? t(senderLabel) : senderLabel.nome}
            </div>
          )}

          {apagada ? (
            // Nem corpo nem mídia: o anexo apagado também sai. Em itálico e
            // esmaecido porque não é texto de ninguém — é o CRM narrando o que
            // aconteceu com aquele lugar da conversa.
            <p className="leading-snug break-words whitespace-pre-wrap italic opacity-60">
              {t("Esta mensagem foi apagada")}
            </p>
          ) : (
            <>
              {hasMedia && (
                <div className={cn(message.body && "mb-1")}>
                  <MediaRenderer message={message} />
                </div>
              )}

              {isContact && !hasMedia && (
                <div className={cn(message.body && isContact && "mb-1")}>
                  <ContactCard message={message} />
                </div>
              )}

              {message.body && !isContact && (
                <p className="leading-snug break-words whitespace-pre-wrap">{message.body}</p>
              )}
            </>
          )}

          <div
            className={cn(
              "mt-1 flex items-center justify-end gap-1 text-[10px]",
              isOutbound ? "text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {editada && (
              // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
              // que falta é avisar que ele mudou. Sem isso, um combinado de preço
              // ou endereço é lido como se sempre tivesse dito aquilo — e a
              // divergência só aparece quando alguém cobra o que não foi.
              <span title={t("O autor editou esta mensagem")}>{t("editada")}</span>
            )}
            {/* O TOM desta mensagem (migration 0280): só nas do cliente que pedem
                atenção — um ponto ao lado da hora, para achar onde ele se irritou
                sem reler a conversa inteira. */}
            {!isOutbound && pedeAtencao(faixaDaMensagem) && notaDaMensagem !== null && (
              <span
                data-testid="tom-da-mensagem"
                data-faixa={faixaDaMensagem ?? undefined}
                title={`${t(escopoDoAtendimento ? "Atendimento até esta mensagem" : "Tom desta mensagem")}: ${t(ROTULO_DA_FAIXA[faixaDaMensagem!])} (${formatarNota(notaDaMensagem)})`}
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  faixaDaMensagem === "critico" ? "bg-error" : "bg-alert",
                )}
              />
            )}
            <span>{time}</span>
            {showCitationButton && <CitationButton citations={citations} messageId={message.id} />}
            {isOutbound && !isFailed && <AckIndicator status={message.status} t={t} />}
            {isFailed && (
              // Provider local: o painel do inbox não tem TooltipProvider ancestral e
              // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
              // conversa com falha de envio derrubava o painel inteiro (error boundary).
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                      <WarningOctagon size={10} weight="fill" aria-hidden /> {t("Falhou")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {message.error_message
                      ? t(message.error_message)
                      : (message.error_code ?? t("Erro desconhecido"))}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <ReacoesDoBalao reacoes={reacoes} lado={lado} />
      </div>
      {!isOutbound && acoes}
    </div>
  );
}
