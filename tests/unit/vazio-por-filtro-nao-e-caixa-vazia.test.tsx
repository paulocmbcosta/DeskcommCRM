import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { filtrosAplicados, nomesDosFiltros, type FiltrosDeTela } from "@/lib/inbox/filtros-de-tela";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

/**
 * LISTA VAZIA POR FILTRO NÃO É CAIXA VAZIA.
 *
 * ─── O defeito, medido na tela de uma instalação real ────────────────────────
 * Com duas conversas EXISTINDO e "Não lidos" ligado, a tela dizia:
 *
 *     "Sem conversas por aqui — quando chegarem mensagens, elas aparecem aqui"
 *
 * Verdade quando a caixa está vazia; mentira quando um filtro escondeu tudo. E o
 * `return` do vazio vinha ANTES do bloco do "Carregar mais", então o operador
 * ficava sem como alcançar a página seguinte: um beco sem saída.
 *
 * Os dois casos que importam são o do texto e o do botão — e eles quebram por
 * motivos diferentes, então são testes diferentes.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
// O catálogo de times alimenta o rodapé do card (que aqui é um mock) — a lista
// o consulta uma vez. Sem time nenhum, o caso medido por este arquivo não muda.
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: false }),
}));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: () => null,
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");

function listaFalsa({ itens = [], hasNextPage = false }: { itens?: unknown[]; hasNextPage?: boolean }) {
  return {
    data: { pages: [{ data: itens, meta: { has_more: hasNextPage } }] },
    isLoading: false,
    isError: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as never;
}

const SEM_FILTRO: FiltrosDeTela = { search: "", onlyUnread: false };
/** Os nomes como o `InboxLayout` os monta: da régua única, para a aba Todas. */
const nomes = (tela: Partial<FiltrosDeTela>, aba: "all" | "unassigned" | "mine" = "all") =>
  nomesDosFiltros(filtrosAplicados(aba, { ...SEM_FILTRO, ...tela }));

function montar(filters: ConversationsFilters, hasNextPage = false) {
  return render(
    <ConversationList
      listQuery={listaFalsa({ itens: [], hasNextPage })}
      filters={filters}
      // A lista deixou de derivar os nomes sozinha: quem monta a consulta os
      // entrega, a partir do mesmo objeto. Aqui, o que o `InboxLayout` entregaria
      // para estes filtros.
      filtrosAtivos={nomes({ onlyUnread: Boolean(filters.unread) })}
      selectedId={null}
      onSelect={() => undefined}
    />,
  );
}

afterEach(() => cleanup());

describe("quais filtros a tela nomeia", () => {
  it("a ABA não entra — ela é onde o operador está, não algo a limpar", () => {
    // Nenhum filtro auxiliar ligado: a Fila, Minhas e Todas não nomeiam nada,
    // embora cada uma mande à rota o filtro DA ABA (`comando`, `assigned_to=me`,
    // `exclude_finished`).
    expect(nomes({}, "unassigned")).toEqual([]);
    expect(nomes({}, "mine")).toEqual([]);
    expect(nomes({}, "all")).toEqual([]);
  });

  it("os auxiliares entram, e só quando ligados", () => {
    expect(nomes({ onlyUnread: true })).toEqual(["Não lidos"]);
    expect(nomes({ onlyUnread: true, tag: "urgente" })).toEqual(["Não lidos", "Etiqueta"]);
  });

  it("⭐ o TIME é nomeado — era o filtro que a lista antiga aplicava e não citava", () => {
    // Com só o time ligado e nenhum resultado, a tela dizia "Sem conversas por
    // aqui": a caixa parecia vazia com um filtro aceso.
    expect(nomes({ team_id: "mine" })).toEqual(["Time"]);
  });

  it("os filtros novos também: atendente e caixa de entrada", () => {
    expect(nomes({ assigned_to: "me", channel: "phone" })).toEqual(["Caixa de entrada", "Atendente"]);
  });
});

describe("o vazio por FILTRO não se disfarça de caixa vazia", () => {
  it("sem filtro e sem conversa: diz que a caixa está vazia", () => {
    montar({} as ConversationsFilters);
    expect(screen.getByText(/Sem conversas por aqui/i)).toBeInTheDocument();
  });

  it("COM filtro e sem resultado: NÃO diz que a caixa está vazia, e nomeia o filtro", () => {
    montar({ unread: true } as ConversationsFilters);
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhuma conversa com esses filtros/i)).toBeInTheDocument();
    expect(screen.getByText(/Não lidos/i)).toBeInTheDocument();
  });

  it("⭐ COM filtro, sem resultado e com próxima página: o 'Carregar mais' CONTINUA lá", () => {
    // O defeito original em uma frase: o `return` do vazio vinha ANTES do bloco do
    // botão. Este é o caso que a sabotagem tem de derrubar.
    montar({ unread: true } as ConversationsFilters, true);
    expect(screen.getByRole("button", { name: /Carregar mais/i })).toBeInTheDocument();
  });

  it("CONTROLE: sem filtro e sem conversa, o 'Carregar mais' não é oferecido", () => {
    // Sem este caso, desenhar o botão SEMPRE passaria no de cima.
    montar({} as ConversationsFilters, false);
    expect(screen.queryByRole("button", { name: /Carregar mais/i })).not.toBeInTheDocument();
  });
});
