"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Clock, Globe, HourglassMedium, Phone, Robot, Siren, SmileySad, Thermometer, UsersThree } from "@/lib/ui/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { esperaDaConversa, estaNaFilaDoTime, formatarEspera, type NivelDeEspera } from "@/lib/inbox/espera";
import type { ReguaDeEspera } from "@/lib/schemas/settings";
import { formatarNota, pedeAtencao, ROTULO_DA_FAIXA, sentimentoDaConversa } from "@/lib/inbox/sentimento";
import { canalPorExtenso as canalInteiro, rotuloDoCanal } from "@/lib/inbox/rotulo-do-canal";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Posição 1-based na fila (G5-03). Presente só na visão Fila. */
  queuePosition?: number;
  /**
   * Mostrar POR ONDE a conversa entrou — hoje, SEMPRE.
   *
   * Já foi "só com mais de um número": com um só, o rótulo se repete em toda
   * linha. A decisão virou a pedido do dono do produto, e por uma razão de
   * operação: a instalação nasce com um número e ganha o segundo (ou um canal
   * de outro tipo) sem aviso, e quem atende precisa saber por onde a pessoa
   * entrou ANTES de abrir a conversa. A repetição deixou de ser ruído porque
   * saiu da faixa dos selos — agora mora no rodapé do card, ao lado do time,
   * numa linha que tem sempre a mesma forma e o olho aprende a ler em bloco.
   *
   * A prop fica (ausente = mostra) para o teste conseguir desligá-la.
   */
  mostrarCanal?: boolean;
  /**
   * O NOME do time que espera pela conversa. Vem por PROP, do catálogo que a
   * lista carrega UMA vez — a conversa só carrega o id, e um hook por linha
   * seriam 50 assinaturas da mesma consulta.
   *
   * `undefined` = o catálogo ainda não chegou (não afirme nada);
   * `null` = a conversa não tem time.
   */
  nomeDoTime?: string | null;
  /** A organização usa times? Sem nenhum, "Sem time" seria a mesma palavra em toda linha de uma feature que ela não usa. */
  orgTemTimes?: boolean;
  /** Relógio injetável: a espera é função do tempo, e teste não espera meia hora. */
  agora?: Date;
  /** A régua da organização (minutos até amarelo/laranja/vermelho). Ausente = padrão 2/5/10. */
  regua?: ReguaDeEspera;
  /**
   * Mostrar QUEM está no comando de cada conversa.
   *
   * Mesma regra do canal, e pelo mesmo motivo: só quando o rótulo DISCRIMINA. Nas
   * abas "Fila" (todas sem dono), "Minhas" (todas do mesmo dono) e "IA" o badge
   * seria a mesma palavra em toda linha — ruído que ensina o olho a ignorar a
   * área onde vivem os avisos que importam. Quem decide é a lista, que é quem
   * sabe quantos donos distintos ela tem.
   */
  mostrarAtendente?: boolean;
  /**
   * Mostrar o ícone de robô na prévia da mensagem, quando quem manda é o
   * automático. Mesma regra dos dois badges acima: só quando DISCRIMINA. Na
   * aba "Automático" toda linha já é robô, e o ícone repetido em cada uma vira
   * ruído. Ausente ou `true` = mostra (comportamento anterior, seguro para o
   * teste que não passa esta prop).
   */
  mostrarAutomatico?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
}

/**
 * A COR SAI DE QUEM MANDA, NÃO DO STATUS.
 *
 * O mapa anterior era por `conversations.status`, e o `bg-purple-500` de
 * `ai_handling` era a mesma mentira das abas em forma de cor: `ai_handling` é
 * escrito por UM caminho só em produção, então a bolinha do automático quase
 * nunca aparecia — enquanto o robô atendia a maior parte da lista — e, quando
 * aparecia, sobrevivia ao silêncio, porque o status não muda quando o atendente
 * cala o automático.
 *
 * As chaves são as de `Comando["quem"]`, ao lado de `ROTULO_DO_COMANDO`, pela
 * mesma razão que ele mora ali: a cor e a palavra dizem a mesma coisa e não
 * podem ser mantidas em arquivos diferentes.
 */
const COR_DO_COMANDO: Record<string, string> = {
  humano: "bg-blue-500",
  automatico: "bg-purple-500",
  aguardando: "bg-amber-500",
  ninguem: "bg-muted-foreground/60",
  encerrada: "bg-muted-foreground/30",
};

function initials(name: string | null | undefined, fallback: string): string {
  const v = (name ?? "").trim();
  if (!v) return fallback.slice(0, 2).toUpperCase();
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

/**
 * A cor da espera. Texto E cor: quem enxerga mal cor lê o mesmo tempo escrito.
 * Os degraus são da organização (`settings.inbox.regua_de_espera`); o vermelho
 * ganha a sirene (`.espera-sirene`, `app/globals.css`) — pedido do dono.
 */
const COR_DA_ESPERA: Record<NivelDeEspera, string> = {
  normal: "text-text-muted",
  // A intensidade sobe junto com a cor: tinta clara, tinta forte, sólido. Só a
  // cor (amarelo × laranja em tinta clara) ficava parecida demais na tela.
  amarelo: "bg-warning-bg text-warning-fg",
  laranja: "bg-alert/25 text-alert-fg",
  vermelho: "bg-error text-bg espera-sirene",
};

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  queuePosition,
  mostrarCanal = true,
  mostrarAtendente,
  mostrarAutomatico = true,
  automaticoDaOrg,
  nomeDoTime,
  orgTemTimes = false,
  agora,
  regua,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || t("Sem mensagens");
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const time = relativeTime(conversation.last_message_at, localeDaData);
  const unread = conversation.unread_count_for_assignee ?? 0;


  /**
   * Quem manda, pela MESMA regra do cabeçalho.
   *
   * `status === 'ai_handling'` era um proxy ruim e foi medido: o único escritor
   * desse status em produção é o botão "Devolver ao automático", então o ícone de
   * robô aparecia só em conversa que já tinha sido escalada E devolvida — nunca
   * na que o automático atendeu do começo ao fim, que é a maioria.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  const dot = COR_DO_COMANDO[comando.quem] ?? COR_DO_COMANDO.ninguem;

  // O número DA EMPRESA por onde esta conversa chegou — não o do cliente. Com
  // dois canais é o que decide o tom da resposta e qual número a pessoa vê
  // respondendo. Cai no nome do canal quando não há número (canal recém-criado).
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = rotuloDoCanal(canal);
  // O `title` diz o NÚMERO inteiro: o rótulo abrevia, e quem precisa conferir
  // por qual linha a pessoa entrou não deveria ter de abrir a conversa.
  const canalPorExtenso = canalInteiro(canal);
  const veioDoSite = conversation.channel === "site_chat";

  const temSelos =
    visibleTags.length > 0 ||
    (mostrarAtendente && comando.quem === "humano") ||
    Boolean(c?.is_blocked) ||
    Boolean(c?.is_anonymized);

  const relogio = agora ?? new Date();
  const espera = esperaDaConversa(
    {
      status: conversation.status,
      last_inbound_at: conversation.last_inbound_at,
      last_outbound_at: conversation.last_outbound_at,
      espera_desde: conversation.espera_desde,
      // "ninguem" (org sem automático) também espera gente: a régua pergunta
      // o nome do banco, e ali ele é `aguardando`.
      comando_da_conversa: comando.quem === "ninguem" ? "aguardando" : comando.quem,
    },
    relogio,
    regua,
  );
  // O TOM DO CLIENTE (migration 0280): o card só fala quando pede atenção —
  // insatisfeito ou crítico. Satisfeito e neutro ficam no topo da conversa, não
  // aqui: selo em toda linha ensinaria o olho a ignorar a faixa.
  const sentimento = sentimentoDaConversa(conversation);
  const mostrarSentimento = sentimento !== null && pedeAtencao(sentimento.faixa);
  // NA FILA DO TIME: foi para um setor e ninguém pegou (`lib/inbox/espera.ts`,
  // mesma régua do filtro "Só na fila" e do número vermelho do chip).
  const naFilaDoTime = estaNaFilaDoTime(
    {
      status: conversation.status,
      team_id: conversation.team_id,
      assigned_to_user_id: conversation.assigned_to_user_id,
      bot_silenced_until: conversation.bot_silenced_until ?? null,
    },
    relogio,
  );

  // O rodapé: DE QUEM é (time) e POR ONDE entrou (canal). Três estados para o
  // time, e só dois viram texto — o mesmo critério do selo do cabeçalho: com o
  // catálogo ainda carregando (`undefined`), afirmar "Sem time" sobre uma
  // conversa que TEM time seria mentira de tela.
  const rotuloDoTime =
    typeof nomeDoTime === "string" ? nomeDoTime : nomeDoTime === null && orgTemTimes ? t("Sem time") : null;
  const mostrarRodape = rotuloDoTime !== null || (mostrarCanal && rotuloCanal !== null);

  return (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      className={cn(
        "group relative flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated",
        "focus-visible:outline-hidden focus-visible:bg-surface-elevated",
        isSelected && "bg-accent-50 hover:bg-accent-50",
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      {isSelected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />
      )}
      <div className="relative shrink-0">
        <Avatar className="h-10 w-10">
          {/* Só monta a <img> quando existe arquivo: sem isso o browser pediria
              a rota para TODO contato da lista e levaria 404 em cada um sem
              foto — que é a maioria. O AvatarFallback do Radix já cobre o caso
              de a imagem não carregar, então as iniciais nunca somem. */}
          {c?.avatar_storage_path && !c?.is_anonymized ? (
            <AvatarImage
              src={`/api/v1/contacts/${c.id}/avatar`}
              alt=""
              className="object-cover"
            />
          ) : null}
          <AvatarFallback className="bg-surface-elevated text-xs font-medium text-text-muted">
            {initials(displayName, phoneFallback)}
          </AvatarFallback>
        </Avatar>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
            dot,
          )}
          aria-hidden
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm",
              unread > 0 ? "font-semibold text-text" : "font-medium text-text",
              c?.is_anonymized && "font-normal italic text-text-muted",
            )}
          >
            {displayName}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-subtle">{time}</span>
        </div>

        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              "min-w-0 truncate text-[13px]",
              unread > 0 ? "text-text" : "text-text-muted",
            )}
          >
            {isAi && mostrarAutomatico ? (
              <Robot size={12} weight="duotone" className="mr-1 inline align-[-2px]" aria-hidden />
            ) : null}
            {truncated}
          </p>
          {unread > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold tabular-nums text-accent-foreground">
              {unread}
            </span>
          )}
        </div>

        {temSelos && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {visibleTags.map((t) => (
              <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
                {t}
              </Badge>
            ))}
            {overflow > 0 && (
              <span className="text-[10px] text-text-muted">+{overflow}</span>
            )}
            {mostrarAtendente && comando.quem === "humano" && (
              <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
            )}
            {c?.is_blocked && (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {t("Bloqueado")}
              </Badge>
            )}
            {c?.is_anonymized && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {t("Anonimizado")}
              </Badge>
            )}
          </div>
        )}

        {/* A ESPERA, em linha própria e em TODA aba — não só na Fila. É a
            resposta a "qual eu atendo primeiro?", e a conversa com dono parada
            há dez minutos precisa gritar tanto quanto a que ninguém pegou.
            Ao lado, o selo "Na fila · <time>": foi para um setor e ninguém
            pegou — o gargalo, visível sem abrir nada. */}
        {(espera || queuePosition !== undefined || naFilaDoTime || mostrarSentimento) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
            {queuePosition !== undefined && (
              <span
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-medium tabular-nums text-accent"
                aria-label={`${t("Posição")} ${queuePosition} ${t("na fila")}`}
              >
                {queuePosition}º
              </span>
            )}
            {(espera || queuePosition !== undefined) && (
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 rounded-full",
                  espera && espera.nivel !== "normal" && "px-1.5 py-0.5",
                  COR_DA_ESPERA[espera?.nivel ?? "normal"],
                )}
                data-testid="espera-da-conversa"
                data-nivel={espera?.nivel ?? "normal"}
                title={espera ? `${t("Cliente sem resposta desde")} ${format(espera.desde, "HH:mm")}` : undefined}
              >
                {espera?.nivel === "vermelho" ? (
                  <Siren size={12} weight="fill" aria-hidden />
                ) : espera && espera.nivel !== "normal" ? (
                  <Thermometer size={12} weight="fill" aria-hidden />
                ) : (
                  <Clock size={12} weight="regular" aria-hidden />
                )}
                <span className="truncate">
                  {espera ? `${t("Aguardando há")} ${formatarEspera(espera.ms, t)}` : t("Aguardando")}
                </span>
              </span>
            )}
            {mostrarSentimento && sentimento && (
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5",
                  sentimento.faixa === "critico" ? "bg-error text-bg" : "bg-alert/25 text-alert-fg",
                )}
                data-testid="selo-sentimento"
                data-faixa={sentimento.faixa}
                title={`${t("Tom do cliente")}: ${t(ROTULO_DA_FAIXA[sentimento.faixa])} (${formatarNota(sentimento.atual)})`}
              >
                <SmileySad size={12} weight="fill" aria-hidden />
                <span className="truncate">{t(ROTULO_DA_FAIXA[sentimento.faixa])}</span>
              </span>
            )}
            {naFilaDoTime && (
              <span
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg"
                data-testid="selo-na-fila-do-time"
                title={t("Transferida para o time e ainda sem atendente")}
              >
                <HourglassMedium size={12} weight="fill" aria-hidden />
                <span className="truncate">
                  {t("Na fila")}
                  {typeof nomeDoTime === "string" ? ` · ${nomeDoTime}` : ""}
                </span>
              </span>
            )}
          </div>
        )}

        {mostrarRodape && (
          <div
            // `flex-wrap`: em coluna estreita o canal desce para a linha de baixo
            // em vez de cortar o nome do time — reticências aqui escondem
            // justamente o que o rodapé existe para dizer.
            className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted"
            data-testid="rodape-da-conversa"
          >
            {rotuloDoTime !== null && (
              <span className="flex min-w-0 items-center gap-1" title={`${t("Time")}: ${rotuloDoTime}`}>
                <UsersThree size={12} weight="regular" className="shrink-0" aria-hidden />
                <span className="truncate">{rotuloDoTime}</span>
              </span>
            )}
            {mostrarCanal && rotuloCanal !== null && (
              <span
                className="flex min-w-0 items-center gap-1"
                title={
                  veioDoSite
                    ? `${t("Entrou pelo chat do site")} · ${rotuloCanal}`
                    : `${t("Entrou por")} ${canalPorExtenso ?? rotuloCanal}`
                }
                data-meio={veioDoSite ? "site_chat" : "whatsapp"}
              >
                {/* O ícone acompanha o MEIO (`conversations.channel`), não o
                    provider: telefone numa conversa que veio de um site diz ao
                    atendente para procurar um número que não existe. */}
                {veioDoSite ? (
                  <Globe size={12} weight="regular" className="shrink-0" aria-hidden />
                ) : (
                  <Phone size={12} weight="regular" className="shrink-0" aria-hidden />
                )}
                <span className="truncate">{rotuloCanal}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
