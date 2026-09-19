"use client";
import type { ComponentType } from "react";
import { format, type Locale } from "date-fns";
import Link from "next/link";

import { PainelDoConector } from "@/components/conectores/PainelDoConector";
import { useConectoresAtivos } from "@/hooks/conectores/useConectoresAtivos";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useLinhaDoTempoDaConversa } from "@/hooks/inbox/useAtendimentos";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { copyToClipboard } from "@/lib/clipboard";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  descreverEventoDaConversa,
  rotuloDoAtendimento,
  type AtendimentoResumo,
  type TomDoEvento,
} from "@/lib/inbox/eventos-da-conversa";
import { activityLabel, actorLabel } from "@/lib/leads/activity-vocabulary";
import {
  ArrowSquareOut,
  ClockCounterClockwise,
  Copy,
  Envelope,
  Info,
  Phone,
  PlugsConnected,
  Pulse,
} from "@/lib/ui/icons";
import { rotuloDoCanal } from "@/lib/inbox/rotulo-do-canal";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import { CRMSidePanel } from "./CRMSidePanel";

/**
 * O PAINEL DA CONVERSA — três perguntas, três abas, um trilho.
 *
 *   detalhes ... QUEM é e O QUE é este atendimento (contato, protocolo, canal,
 *                time, demandas, negócios). O corpo continua sendo o
 *                `CRMSidePanel` de sempre; o que entrou foi o cabeçalho com o
 *                protocolo e a ficha da conversa.
 *   histórico .. QUANTAS VEZES esta pessoa já chamou. Um atendimento por
 *                protocolo, somando todos os canais; clicar abre aquele.
 *   linha ...... O QUE ACONTECEU aqui: aberta, encaminhada, assumida, encerrada.
 *
 * A seção "Atividade" morava no fim dos detalhes, em cartões. Saiu de lá e virou
 * a terceira aba, em LINHA — é uma sequência no tempo, e cartão não diz ordem.
 *
 * O TRILHO fica sempre à vista; o painel abre e fecha. Clicar na aba aberta a
 * fecha, e a conversa ganha a largura de volta: é o mesmo gesto do funil da
 * coluna esquerda, e pelo mesmo motivo.
 *
 * DEPOIS das três vêm as abas de CONECTOR — uma por sistema externo que a
 * organização ligou (hoje: o IXC, ERP de provedor). Este arquivo não sabe o que
 * é IXC: ele pergunta quais conectores estão ligados e entrega o corpo a
 * `PainelDoConector`. Organização sem conector não vê aba a mais, nem a vê piscar.
 */
export type AbaDoPainel = "detalhes" | "historico" | "linha" | `conector:${string}`;

const PREFIXO_DE_CONECTOR = "conector:";

type AbaDoTrilho = {
  aba: AbaDoPainel;
  rotulo: string;
  Icone: ComponentType<{ size?: number; weight?: "regular" | "fill" }>;
  /** Nome que veio do cadastro do conector ("IXC") — é marca, não se traduz. */
  literal?: boolean;
};

const ABAS: AbaDoTrilho[] = [
  { aba: "detalhes", rotulo: "Detalhes", Icone: Info },
  { aba: "historico", rotulo: "Atendimentos anteriores", Icone: ClockCounterClockwise },
  { aba: "linha", rotulo: "Linha do tempo", Icone: Pulse },
];

const STATUS_LEGIVEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

const COR_DO_TOM: Record<TomDoEvento, string> = {
  entrada: "bg-success",
  espera: "bg-warning",
  pessoa: "bg-info",
  fim: "bg-success",
  neutro: "bg-border-strong",
};

interface Props {
  conversation: ConversationWithContact | null;
  aba: AbaDoPainel | null;
  onAbaChange: (aba: AbaDoPainel | null) => void;
  /** O histórico do contato, carregado pelo pai — a conversa e o composer também dependem dele. */
  atendimentos: AtendimentoResumo[] | undefined;
  atendimentosComErro: boolean;
  onTentarDeNovo: () => void;
  /** O atendimento que a tela está mostrando (o vigente, ou um antigo aberto pelo histórico). */
  atendimentoEmTela: AtendimentoResumo | null;
  onAbrirAtendimento: (atendimento: AtendimentoResumo) => void;
  /** Dentro do painel deslizante do celular não há grade para encaixar: ocupa a largura toda. */
  larguraLivre?: boolean;
}

/**
 * Data que NUNCA derruba o painel. `format` do date-fns LANÇA em data inválida,
 * e um carimbo ausente (conversa em cache de versão anterior, payload parcial)
 * viraria tela em branco na coluna inteira por causa de um rótulo.
 */
function dataLegivel(iso: string | null | undefined, padrao: string, locale: Locale): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, padrao, { locale });
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return (partes[0] ?? "?").slice(0, 2).toUpperCase();
  return `${partes[0]?.[0] ?? ""}${partes[partes.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function Copiavel({ valor, rotulo }: { valor: string; rotulo: string }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={`${t("Copiar")} ${rotulo}`}
      title={`${t("Copiar")} ${rotulo}`}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-subtle hover:bg-surface-elevated hover:text-text"
      onClick={async () => {
        const copiou = await copyToClipboard(valor);
        if (copiou) toast.success(t("Copiado."));
        else toast.error(t("Não foi possível copiar."));
      }}
    >
      <Copy size={12} aria-hidden />
    </button>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-text-muted">{rotulo}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-right text-xs font-medium text-text">{children}</dd>
    </div>
  );
}

export function PainelDaConversa({
  conversation,
  aba,
  onAbaChange,
  atendimentos,
  atendimentosComErro,
  onTentarDeNovo,
  atendimentoEmTela,
  onAbrirAtendimento,
  larguraLivre = false,
}: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const times = useTimesDoInbox();
  const conectores = useConectoresAtivos();
  const abas: AbaDoTrilho[] = [
    ...ABAS,
    ...(conectores.data ?? []).map((c) => ({
      aba: `${PREFIXO_DE_CONECTOR}${c.id}` as AbaDoPainel,
      rotulo: c.rotulo,
      Icone: PlugsConnected,
      literal: true,
    })),
  ];
  const conectorAberto = aba?.startsWith(PREFIXO_DE_CONECTOR) ? aba.slice(PREFIXO_DE_CONECTOR.length) : null;

  const contato = conversation?.contacts ?? null;
  const nome = rotuloDoContato(contato, t);
  const telefone = contato?.phone_number ? phoneForDisplay(contato.phone_number) : null;
  const email = contato?.email ?? null;
  const protocolo = atendimentoEmTela?.protocol ?? conversation?.protocol ?? null;

  // Os OUTROS atendimentos: o que está na tela não é "anterior" a si mesmo.
  const outros = (atendimentos ?? []).filter((a) => a.id !== atendimentoEmTela?.id);

  const linha = useLinhaDoTempoDaConversa(
    aba === "linha" ? (conversation?.id ?? null) : null,
    atendimentoEmTela?.id ?? null,
    // O gatilho honesto do refetch: o que muda quando algo ACONTECE na conversa.
    [
      conversation?.status,
      conversation?.assigned_to_user_id,
      conversation?.team_id,
      conversation?.bot_silenced_until,
      conversation?.protocol,
      conversation?.service_revision,
    ].join(":"),
  );

  const itensDaLinha = (() => {
    const eventos = (linha.data?.eventos ?? []).map((e) => {
      const d = descreverEventoDaConversa(e, t);
      return { id: `e-${e.id}`, quando: e.created_at, titulo: d.titulo, detalhe: d.detalhe, tom: d.tom };
    });
    const atividades = (linha.data?.atividades ?? []).map((a) => ({
      id: `a-${a.id}`,
      quando: a.performed_at,
      titulo: t(activityLabel(a.type)),
      detalhe:
        [a.reason ? t(a.reason) : null, a.performed_by_name ?? t(actorLabel(a.actor_kind))].filter(Boolean).join(" · ") ||
        null,
      tom: "neutro" as TomDoEvento,
    }));
    return [...eventos, ...atividades].sort((x, y) => new Date(x.quando).getTime() - new Date(y.quando).getTime());
  })();

  // O time da FICHA é o do atendimento que está na tela — a mesma regra do
  // Responsável logo abaixo. Encerrado, vale o time com que ele FECHOU
  // (`atendimentos.team_id`): depois que o cliente volta, a conversa começa sem
  // time (0269), e a ficha do atendimento que a Cobrança encerrou diria "Sem time".
  const timeDaFichaId = atendimentoEmTela?.closed_at
    ? atendimentoEmTela.team_id
    : (conversation?.team_id ?? null);
  const nomeDoTime =
    timeDaFichaId != null ? ((times.data ?? []).find((time) => time.id === timeDaFichaId)?.name ?? null) : null;
  const rotuloCanal = rotuloDoCanal(conversation?.channel_sessions ?? null);

  const trilho = (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label={t("Painel da conversa")}
        data-testid="painel-trilho"
        className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-2"
      >
        {abas.map(({ aba: alvo, rotulo: rotuloCru, Icone, literal }) => {
          const ativa = aba === alvo;
          const rotulo = literal ? rotuloCru : t(rotuloCru);
          const contador = alvo === "historico" ? outros.length : 0;
          return (
            <Tooltip key={alvo}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={rotulo}
                  aria-pressed={ativa}
                  data-testid={`painel-aba-${alvo}`}
                  disabled={!conversation}
                  onClick={() => onAbaChange(ativa ? null : alvo)}
                  className={cn(
                    "relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors",
                    "hover:bg-surface-elevated hover:text-text disabled:pointer-events-none disabled:opacity-40",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                    ativa && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent",
                  )}
                >
                  <Icone size={18} weight={ativa ? "fill" : "regular"} />
                  {contador > 0 && (
                    <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums leading-none text-accent-foreground">
                      {contador > 99 ? "99+" : contador}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{rotulo}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </TooltipProvider>
  );

  if (!conversation || aba === null) {
    return (
      <div className="flex h-full min-h-0" data-testid="painel-da-conversa" data-aba={aba ?? "fechado"}>
        {trilho}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-testid="painel-da-conversa" data-aba={aba}>
      <section
        className={cn(
          "flex h-full min-h-0 flex-col border-l border-border bg-background",
          larguraLivre ? "min-w-0 flex-1" : "w-[264px] 2xl:w-[320px]",
        )}
      >
        {/* O CABEÇALHO é o mesmo nas três abas: quem é, em que pé está, e o
            PROTOCOLO — que é o dado que o cliente pede por telefone e o
            atendente precisa achar sem procurar. */}
        <header className="border-b border-border px-3 py-3">
          <div className="flex items-start gap-3">
            <Avatar className="h-10 w-10 shrink-0">
              <AvatarFallback className="bg-surface-elevated text-xs font-medium text-text-muted">
                {iniciais(nome)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-text">{nome}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      atendimentoEmTela && !atendimentoEmTela.closed_at ? "bg-success" : "bg-border-strong",
                    )}
                    aria-hidden
                  />
                  {atendimentoEmTela
                    ? t(rotuloDoAtendimento(atendimentoEmTela))
                    : t(STATUS_LEGIVEL[conversation.status] ?? conversation.status)}
                </span>
              </div>
              {telefone && <div className="truncate text-xs text-text-muted">{telefone}</div>}
            </div>
          </div>
          {/* O protocolo em linha PRÓPRIA: dividindo a fileira com o nome, os dois
              se cortavam numa coluna de 264px — e são os dois dados que o
              atendente lê em voz alta para o cliente. */}
          {protocolo && (
            <div
              className="mt-2 flex items-center justify-between gap-2 rounded-md bg-surface-elevated px-2 py-1"
              data-testid="protocolo-do-atendimento"
            >
              <span className="text-[11px] text-text-muted">{t("Protocolo")}</span>
              <span className="flex items-center gap-1">
                <span className="font-mono text-xs font-medium tabular-nums text-text">{protocolo}</span>
                <Copiavel valor={protocolo} rotulo={t("protocolo")} />
              </span>
            </div>
          )}
        </header>

        {aba === "detalhes" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-1 border-b border-border px-3 py-3">
              {telefone && (
                <div className="flex items-center gap-2 text-xs text-text">
                  <Phone size={13} className="shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 truncate">{telefone}</span>
                  <Copiavel valor={contato?.phone_number ?? telefone} rotulo={t("telefone")} />
                </div>
              )}
              {email && (
                <div className="flex items-center gap-2 text-xs text-text">
                  <Envelope size={13} className="shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 truncate">{email}</span>
                  <Copiavel valor={email} rotulo={t("e-mail")} />
                </div>
              )}
              {contato?.id && (
                <Link
                  href={`/app/contacts/${contato.id}`}
                  className="inline-flex items-center gap-1 pt-1 text-xs font-medium text-accent hover:underline"
                >
                  <ArrowSquareOut size={12} aria-hidden />
                  {t("Ver detalhes do contato")}
                </Link>
              )}
            </div>

            <div className="border-b border-border px-3 py-3" data-testid="ficha-da-conversa">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {t("Conversa")}
              </h3>
              <dl>
                <Campo rotulo={t("Protocolo")}>
                  {protocolo ? (
                    <>
                      <span className="font-mono tabular-nums">{protocolo}</span>
                      <Copiavel valor={protocolo} rotulo={t("protocolo")} />
                    </>
                  ) : (
                    "—"
                  )}
                </Campo>
                <Campo rotulo={t("Status")}>
                  {atendimentoEmTela
                    ? t(rotuloDoAtendimento(atendimentoEmTela))
                    : t(STATUS_LEGIVEL[conversation.status] ?? conversation.status)}
                </Campo>
                <Campo rotulo={t("Canal")}>
                  <span className="truncate">{rotuloCanal ?? "—"}</span>
                </Campo>
                {(nomeDoTime !== null || (times.data ?? []).some((time) => !time.archived)) && (
                  <Campo rotulo={t("Time")}>
                    <span className="truncate">{nomeDoTime ?? t("Sem time")}</span>
                  </Campo>
                )}
                <Campo rotulo={t("Responsável")}>
                  <span className="truncate">
                    {atendimentoEmTela?.closed_at
                      ? (atendimentoEmTela.assigned_to_user_name ?? "—")
                      : (conversation.assigned_to_user_name ?? "—")}
                  </span>
                </Campo>
                <Campo rotulo={t("Criada em")}>
                  {dataLegivel(atendimentoEmTela?.started_at ?? conversation.created_at, "dd/MM/yyyy HH:mm", locale)}
                </Campo>
                {atendimentoEmTela?.closed_at ? (
                  <Campo rotulo={t("Encerrada em")}>
                    {dataLegivel(atendimentoEmTela.closed_at, "dd/MM/yyyy HH:mm", locale)}
                  </Campo>
                ) : (
                  conversation.last_message_at && (
                    <Campo rotulo={t("Última mensagem")}>
                      {dataLegivel(conversation.last_message_at, "dd/MM/yyyy HH:mm", locale)}
                    </Campo>
                  )
                )}
              </dl>
            </div>

            <CRMSidePanel conversation={conversation} embutido />
          </div>
        )}

        {aba === "historico" && (
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="historico-de-atendimentos">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <ClockCounterClockwise size={13} aria-hidden />
                {t("Atendimentos anteriores")}
              </h3>
              <span className="rounded-full bg-surface-elevated px-1.5 text-[11px] tabular-nums text-text-muted">
                {outros.length}
              </span>
            </div>
            {atendimentosComErro ? (
              <div className="space-y-2 p-3">
                <p className="text-xs text-error-fg">{t("Não consegui ler o histórico de atendimentos.")}</p>
                <Button size="sm" variant="outline" onClick={onTentarDeNovo}>
                  {t("Tentar de novo")}
                </Button>
              </div>
            ) : atendimentos === undefined ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <ul>
                {atendimentos.map((a) => {
                  const naTela = a.id === atendimentoEmTela?.id;
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        data-testid="atendimento-do-historico"
                        aria-current={naTela ? "true" : undefined}
                        onClick={() => onAbrirAtendimento(a)}
                        className={cn(
                          "flex w-full flex-col gap-0.5 border-b border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated",
                          naTela && "bg-accent-50 hover:bg-accent-50",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs tabular-nums text-text">{a.protocol}</span>
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
                            <span
                              className={cn("h-1.5 w-1.5 rounded-full", a.closed_at ? "bg-border-strong" : "bg-success")}
                              aria-hidden
                            />
                            {t(rotuloDoAtendimento(a))}
                          </span>
                        </span>
                        <span className="text-[11px] tabular-nums text-text-muted">
                          {dataLegivel(a.started_at, "dd/MM/yyyy HH:mm", locale)}
                          {a.canal ? ` · ${a.canal}` : ""}
                        </span>
                        {(a.assigned_to_user_name || naTela) && (
                          <span className="truncate text-[11px] text-text-subtle">
                            {naTela ? t("Você está vendo este atendimento") : `${t("Atendido por")} ${a.assigned_to_user_name}`}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {atendimentos.length === 0 && (
                  <li className="p-3 text-xs text-text-muted">{t("Nenhum atendimento registrado para este contato.")}</li>
                )}
              </ul>
            )}
          </div>
        )}

        {aba === "linha" && (
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="linha-do-tempo-da-conversa">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <Pulse size={13} aria-hidden />
                {t("Linha do tempo")}
              </h3>
              <span className="rounded-full bg-surface-elevated px-1.5 text-[11px] tabular-nums text-text-muted">
                {itensDaLinha.length}
              </span>
            </div>
            {linha.isError ? (
              <div className="space-y-2 p-3">
                <p className="text-xs text-error-fg">{t("Não consegui ler a linha do tempo.")}</p>
                <Button size="sm" variant="outline" onClick={() => linha.refetch()}>
                  {t("Tentar de novo")}
                </Button>
              </div>
            ) : linha.isLoading ? (
              <div className="space-y-3 p-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : itensDaLinha.length === 0 ? (
              <p className="p-3 text-xs text-text-muted">{t("Nada registrado neste atendimento ainda.")}</p>
            ) : (
              <ol className="px-3 py-3">
                {itensDaLinha.map((item, i) => (
                  <li key={item.id} className="relative flex gap-3 pb-4 last:pb-0" data-testid="evento-da-linha">
                    {/* A LINHA: um traço contínuo entre os pontos. É ela que diz
                        "isto veio depois daquilo" — o que o cartão não dizia. */}
                    {i < itensDaLinha.length - 1 && (
                      <span className="absolute bottom-0 left-[4px] top-3.5 w-px bg-border-strong" aria-hidden />
                    )}
                    <span
                      className={cn("relative mt-1 h-[9px] w-[9px] shrink-0 rounded-full", COR_DO_TOM[item.tom])}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-text">{item.titulo}</span>
                        <time className="shrink-0 text-[11px] tabular-nums text-text-subtle" dateTime={item.quando}>
                          {dataLegivel(item.quando, "dd/MM HH:mm", locale)}
                        </time>
                      </div>
                      {item.detalhe && <p className="mt-0.5 text-[11px] leading-snug text-text-muted">{item.detalhe}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {linha.data?.atividades_indisponiveis && (
              <p className="border-t border-border p-3 text-[11px] text-warning-fg">
                {t("As atividades do negócio não puderam ser lidas agora; a linha acima mostra só o que aconteceu na conversa.")}
              </p>
            )}
          </div>
        )}

        {conectorAberto && (
          <PainelDoConector conector={conectorAberto} contactId={contato?.id ?? null} conversationId={conversation.id} />
        )}
      </section>
      {trilho}
    </div>
  );
}
