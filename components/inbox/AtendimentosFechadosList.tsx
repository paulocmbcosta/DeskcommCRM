"use client";
import { useEffect, useMemo } from "react";
import { format } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useAtendimentosFechados, type FiltrosDosFechados } from "@/hooks/inbox/useAtendimentosFechados";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import type { AtendimentoFechado } from "@/app/api/v1/atendimentos/_handler";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import { rotuloDoAtendimento } from "@/lib/inbox/eventos-da-conversa";
import { ArrowBendUpLeft, Hash, Phone, UsersThree } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { EmptyPorFiltro } from "./EmptyPorFiltro";

/**
 * A ABA "FECHADAS" LISTA ATENDIMENTOS, NÃO CONVERSAS.
 *
 * A conversa é uma por cliente e canal, e reabre quando ele volta. Listando
 * conversas fechadas, o atendimento que o Financeiro encerrou às 10h sumia desta
 * aba às 14h, quando o mesmo cliente escrevia pedindo suporte — e "o que foi
 * encerrado hoje?" ficava sem resposta justamente para quem mais volta.
 *
 * Cada linha é um atendimento: o protocolo, quando e por quem foi encerrado, o
 * time que o encerrou (o do FECHAMENTO, não o de agora) e o canal. Um cliente
 * que voltou aparece aqui com a marca "cliente voltou", e clicar abre AQUELE
 * atendimento — a conversa recortada nele, com o composer travado —, não o atual.
 */
interface Props {
  filtros: FiltrosDosFechados;
  /** O atendimento que a tela mostra agora (para destacar a linha). */
  atendimentoEmTelaId: string | null;
  onAbrir: (atendimento: AtendimentoFechado) => void;
  onLimparFiltros?: () => void;
  onVisibleChange?: (conversationIds: string[]) => void;
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return (partes[0] ?? "?").slice(0, 2).toUpperCase();
  return `${partes[0]?.[0] ?? ""}${partes[partes.length - 1]?.[0] ?? ""}`.toUpperCase();
}

export function AtendimentosFechadosList({
  filtros,
  atendimentoEmTelaId,
  onAbrir,
  onLimparFiltros,
  onVisibleChange,
}: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const q = useAtendimentosFechados(filtros, true);
  const times = useTimesDoInbox();
  const nomeDoTime = useMemo(
    () => new Map((times.data ?? []).map((time) => [time.id, time.name] as const)),
    [times.data],
  );

  const itens = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);

  useEffect(() => {
    // J/K navegam por CONVERSA; dois atendimentos da mesma conversa contam uma vez.
    if (onVisibleChange) onVisibleChange([...new Set(itens.map((a) => a.conversation_id))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itens]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>{t("Erro ao carregar os atendimentos encerrados.")}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </div>
    );
  }

  const filtrosAtivos = filtrosAuxiliaresAtivos(filtros);

  return (
    <div className="flex h-full flex-col" data-testid="lista-de-atendimentos-fechados">
      <div className="flex-1 overflow-y-auto">
        {itens.length === 0 &&
          (filtrosAtivos.length > 0 ? (
            <EmptyPorFiltro filtros={filtrosAtivos} onLimpar={onLimparFiltros} />
          ) : (
            <p className="p-6 text-center text-sm text-text-muted">{t("Nenhum atendimento encerrado ainda.")}</p>
          ))}
        {itens.map((a) => {
          const naTela = a.id === atendimentoEmTelaId;
          const time = a.team_id ? (nomeDoTime.get(a.team_id) ?? null) : null;
          return (
            <button
              key={a.id}
              type="button"
              data-testid="atendimento-fechado"
              data-atendimento-id={a.id}
              data-conversation-id={a.conversation_id}
              aria-current={naTela ? "true" : undefined}
              onClick={() => onAbrir(a)}
              className={cn(
                "group relative flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated",
                "focus-visible:bg-surface-elevated focus-visible:outline-hidden",
                naTela && "bg-accent-50 hover:bg-accent-50",
              )}
            >
              {naTela && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
              <Avatar className="h-10 w-10 shrink-0">
                {a.avatar_storage_path && a.contact_id ? (
                  <AvatarImage src={`/api/v1/contacts/${a.contact_id}/avatar`} alt="" className="object-cover" />
                ) : null}
                <AvatarFallback className="bg-surface-elevated text-xs font-medium text-text-muted">
                  {iniciais(a.contato)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm font-medium text-text", a.anonimizado && "font-normal italic text-text-muted")}>
                    {a.contato}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-text-subtle">
                    {a.closed_at ? format(new Date(a.closed_at), "dd/MM HH:mm", { locale }) : ""}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-[12px] text-text-muted">
                  <Hash size={11} className="shrink-0" aria-hidden />
                  <span className="font-mono tabular-nums text-text">{a.protocol}</span>
                </div>
                {/* Linha própria: ao lado do protocolo, em 300px, o nome de quem
                    encerrou saía cortado ("por J…") — e é ele que o gestor procura. */}
                <div className="mt-0.5 truncate text-[12px] text-text-muted" data-testid="quem-encerrou">
                  {t(rotuloDoAtendimento(a))}
                  {(a.closed_by_name ?? a.assigned_to_user_name) &&
                    ` ${t("por")} ${a.closed_by_name ?? a.assigned_to_user_name}`}
                </div>
                {/* O cliente voltou: este atendimento acabou, mas a conversa anda.
                    Sem a marca, "Fechada" ao lado de um cliente que está sendo
                    atendido AGORA leria como contradição. */}
                {a.conversa_em_andamento && (
                  <div
                    className="mt-1 flex items-center gap-1 text-[11px] font-medium text-info-fg"
                    data-testid="cliente-voltou"
                  >
                    <ArrowBendUpLeft size={11} aria-hidden />
                    {t("O cliente voltou — há outro atendimento em andamento")}
                  </div>
                )}
                {(time !== null || a.canal !== null) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                    {time !== null && (
                      <span className="flex min-w-0 items-center gap-1" title={`${t("Time")}: ${time}`}>
                        <UsersThree size={12} className="shrink-0" aria-hidden />
                        <span className="truncate">{time}</span>
                      </span>
                    )}
                    {a.canal !== null && (
                      <span className="flex min-w-0 items-center gap-1" title={`${t("Entrou por")} ${a.canal}`}>
                        <Phone size={12} className="shrink-0" aria-hidden />
                        <span className="truncate">{a.canal}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button size="sm" variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
