"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import type { ReguaDeEspera } from "@/lib/schemas/settings";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import { EmptyPorFiltro } from "./EmptyPorFiltro";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

interface Props {
  /** Query já montada no pai — evita duplicar subscription Realtime + refetch. */
  listQuery: UseInfiniteQueryResult<InfiniteData<ListResponse>, Error>;
  filters: ConversationsFilters;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Desliga os filtros auxiliares. Sem ele, o vazio por filtro nao oferece o botao. */
  onLimparFiltros?: () => void;
  /** Notifies parent when the visible list changes (used by keyboard nav). */
  onVisibleChange?: (ids: string[]) => void;
  /** A régua do termômetro da organização (`ActiveOrg.regua_de_espera`); ausente = padrão. */
  regua?: ReguaDeEspera;
}

export function ConversationList({
  listQuery: q,
  filters,
  selectedId,
  onSelect,
  onVisibleChange,
  onLimparFiltros,
  regua,
}: Props) {
  const t = useT();
  // O RELÓGIO da lista: o termômetro é função do tempo, e sem este tique o card
  // só mudava de cor quando a lista recarregava. Um por lista (não por card), a
  // cada 30 s — a régua conta em minutos.
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  // O TIME de cada conversa. O catálogo é UMA consulta para a lista inteira (e o
  // react-query a dedupa com o cabeçalho e os filtros); a conversa carrega só o
  // id, e o nome sai daqui. Arquivado entra no mapa de propósito: conversa
  // antiga aponta para time arquivado, e ele ainda precisa ter nome.
  //
  // O CANAL deixou de ser decidido aqui. Era "só com mais de um número"; hoje o
  // card mostra sempre, no rodapé, ao lado do time — ver o comentário da prop
  // `mostrarCanal` em `ConversationListItem`.
  const times = useTimesDoInbox();
  const nomeDoTimePorId = useMemo(
    () => new Map((times.data ?? []).map((time) => [time.id, time.name] as const)),
    [times.data],
  );
  const orgTemTimes = (times.data ?? []).some((time) => !time.archived);

  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  // A Fila deixou de mandar `assigned_to=unassigned` (agora pede `comando`), e
  // sem esta linha a numeração "1º, 2º…" e o tempo de espera sumiriam da única
  // visão em que servem para alguma coisa — sem erro nenhum, só sumiriam.
  const isQueue =
    filters.comando?.includes("aguardando") ?? filters.assigned_to === "unassigned";
  // Uma leitura por lista, compartilhada por todas as linhas (react-query dedupa
  // com o cabeçalho, que faz a mesma pergunta).
  const automaticoDaOrg = useAutomaticoAtivo();

  // Sem filtro de cliente: TODO filtro é parâmetro do schema e roda no banco.
  // `clientFilter` era o mecanismo que permitia um filtro existir fora do contrato
  // — e foi por ele que "Não lidos" virou ilha, fora da cerca que vigia os demais.
  const items = useMemo(
    () => (q.data?.pages.flatMap((p) => p.data) ?? []) as ConversationWithContact[],
    [q.data],
  );

  // Notify parent of currently-visible IDs (for j/k nav). Must use effect
  // (not render-time call) — invoking onVisibleChange during render triggers
  // setState in InboxLayout from inside ConversationList's render phase,
  // which React 19 forbids.

  /**
   * O badge de atendente só entra quando DISCRIMINA — mesma regra do badge de
   * canal, e pelo mesmo motivo escrito lá: rótulo que se repete em toda linha
   * ensina o olho a ignorar a área onde vivem os avisos que importam.
   *
   * Medido nas abas: "Fila" pede `comando=aguardando` (nenhuma linha tem dono —
   * a régua põe quem tem dono em `humano`), "Minhas" filtra `assigned_to=me`
   * (todas têm o MESMO) e "Automático" pede `comando=automatico` (também sem
   * dono, pela mesma razão). Sobram "Todas" e "Fechadas" — e mesmo nelas, só
   * vale se a página realmente tiver mais de um dono distinto.
   *
   * O `filters.comando` entrou junto com as abas novas: sem ele, a Fila voltaria
   * a repetir o mesmo selo de atendente em cada uma das linhas.
   */
  const mostrarAtendente = useMemo(() => {
    if (filters.assigned_to) return false;
    if (filters.comando && !filters.comando.includes("humano")) return false;
    const donos = new Set(
      items.map((i) => i.assigned_to_user_id).filter((id): id is string => Boolean(id)),
    );
    return donos.size > 1;
  }, [filters.assigned_to, filters.comando, items]);

  /**
   * O ícone de robô, mesma regra dos dois badges acima: só entra quando
   * DISCRIMINA. A aba "Automático" pede `comando=["automatico"]` — toda linha
   * já é robô, e repetir o ícone em cada uma vira ruído. Nas outras abas a
   * lista é mista (ou pode ser), então o ícone segue dizendo algo.
   */
  const mostrarAutomatico =
    !(filters.comando?.length === 1 && filters.comando[0] === "automatico");

  useEffect(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>{t("Erro ao carregar conversas.")}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  // Vazio por AUSENCIA: a caixa esta mesmo vazia, e o texto pode prometer que
  // mensagens vao aparecer. Este e o unico caso que ainda sai por `return`
  // precoce, porque aqui nao ha pagina seguinte a alcancar.
  const filtrosAtivos = filtrosAuxiliaresAtivos(filters);
  if (items.length === 0 && filtrosAtivos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyInbox />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Vazio por FILTRO: fica DENTRO do return, nunca como `return` precoce —
            e por isso o bloco do `hasNextPage` abaixo continua sendo alcancado. */}
        {items.length === 0 && filtrosAtivos.length > 0 && (
          <EmptyPorFiltro filtros={filtrosAtivos} onLimpar={onLimparFiltros} />
        )}
        {items.map((c, i) => renderItem(c, i))}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  function renderItem(c: ConversationWithContact, i: number) {
    return (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
            queuePosition={isQueue ? i + 1 : undefined}
            // `undefined` enquanto o catálogo carrega: o card não afirma
            // "Sem time" sobre uma conversa cujo time ele ainda não sabe nomear.
            nomeDoTime={
              times.data == null
                ? undefined
                : c.team_id
                  ? (nomeDoTimePorId.get(c.team_id) ?? undefined)
                  : null
            }
            orgTemTimes={orgTemTimes}
            mostrarAtendente={mostrarAtendente}
            mostrarAutomatico={mostrarAutomatico}
            automaticoDaOrg={automaticoDaOrg.data}
            agora={agora}
            regua={regua}
          />
    );
  }
}
