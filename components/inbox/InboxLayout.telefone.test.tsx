/**
 * A ABA TELEFONE NO INBOX — a composição.
 *
 * As peças têm teste próprio (`FilaDoTelefone`, `InboxAbas`, `tabToFilter`); o
 * que se prende aqui é o que só existe com o Inbox montado:
 *
 *  - com `?filter=phone`, a coluna da lista mostra a FILA DE LIGAÇÕES, e deixa
 *    de mostrar o que é de conversa (lista, busca e filtros, protocolo);
 *  - nas OUTRAS abas nada disso muda — é o controle, e é ele que impede a aba
 *    nova de custar alguma coisa a quem nunca a abriu;
 *  - clicar numa ligação abre a conversa dela à direita, pelo caminho de sempre;
 *  - os atalhos `j`/`k` não seguem navegando pelas conversas da aba anterior.
 *
 * A fila entra por um dublê do hook (a leitura e o tempo real dele têm teste em
 * `hooks/telefonia/useFilaDoTelefone.test.tsx`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilaComRelogio } from "@/hooks/telefonia/useFilaDoTelefone";

const CONVERSA_DA_LIGACAO = "00000000-0000-4000-8000-0000000000c7";

const filtroRef: { current: string | null } = { current: "phone" };
const filaRef: { current: { data: FilaComRelogio | undefined; isPending: boolean; isError: boolean; refetch: () => void } } = {
  current: { data: undefined, isPending: true, isError: false, refetch: () => {} },
};

const get = vi.fn(async (url?: string): Promise<unknown> => {
  if ((url ?? "").startsWith("/api/v1/conversations?")) return new Promise(() => {});
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (url === "/api/v1/conversations/counts") return { data: {} };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(filtroRef.current ? { filter: filtroRef.current } : {}),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  // `agent` em modo `own`: o papel que NÃO vê "Todas" — e vê a aba Telefone.
  useAuth: () => ({
    user: { id: "u-1", role: "agent" },
    activeOrg: { orgId: "00000000-0000-4000-8000-0000000000aa", role: "agent", visibility_mode: "own" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/telefonia/useFilaDoTelefone", () => ({ useFilaDoTelefone: () => filaRef.current }));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({ useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({ useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/PainelDaConversa", () => ({ PainelDaConversa: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/telefonia/BotaoLigar", () => ({ BotaoLigar: () => null }));

// As três peças DE CONVERSA da coluna viram sentinelas: o que se mede é se cada
// uma está ou não na tela, em cada aba.
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: function Lista({ onVisibleChange }: { onVisibleChange?: (ids: string[]) => void }) {
    // A lista de verdade informa aos atalhos quais conversas estão à vista.
    useEffect(() => onVisibleChange?.(["conversa-1", "conversa-2"]), [onVisibleChange]);
    return <div data-testid="lista-de-conversas" />;
  },
}));
// A aba Fechadas lista ATENDIMENTOS, por um componente próprio.
vi.mock("@/components/inbox/AtendimentosFechadosList", () => ({
  AtendimentosFechadosList: () => <div data-testid="lista-de-fechados" />,
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => <div data-testid="filtros-de-conversa" /> }));
vi.mock("@/components/inbox/ResultadosPorProtocolo", () => ({
  ResultadosPorProtocolo: () => <div data-testid="busca-por-protocolo" />,
}));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: ({ visibleIds }: { visibleIds: string[] }) => (
    <div data-testid="atalhos" data-ids={visibleIds.join(",")} />
  ),
}));

import { InboxLayout } from "./InboxLayout";

const AGORA = Date.now();

/** Uma ligação aguardando em Vendas, com conversa, e uma em ligação. */
const FILA: FilaComRelogio = {
  ativa: true,
  agora: new Date(AGORA).toISOString(),
  defasagemMs: 0,
  times: [{ id: "t-vendas", nome: "Vendas", espera_maxima_s: 600 }],
  numeros: [{ id: "n-1", nome: "Matriz", numero: "+551130250000" }],
  ligacoes: [
    {
      id: "lig-aguardando",
      fase: "aguardando",
      contato: { id: "c-1", nome: "Maria Souza" },
      numero: "+5511988887777",
      time_id: "t-vendas",
      numero_da_empresa_id: "n-1",
      conversa_id: CONVERSA_DA_LIGACAO,
      entrou_em: new Date(AGORA - 90_000).toISOString(),
      na_fila_desde: new Date(AGORA - 60_000).toISOString(),
      posicao: 1,
      cai_em: new Date(AGORA + 540_000).toISOString(),
      tocando_para: null,
      com: null,
      atendida_em: null,
    },
    {
      id: "lig-em-ligacao",
      fase: "em_ligacao",
      contato: null,
      numero: "+5511977776666",
      time_id: "t-vendas",
      numero_da_empresa_id: "n-1",
      conversa_id: null,
      entrou_em: new Date(AGORA - 300_000).toISOString(),
      na_fila_desde: new Date(AGORA - 280_000).toISOString(),
      posicao: null,
      cai_em: null,
      tocando_para: null,
      com: { id: "u-2", nome: "Bruno" },
      atendida_em: new Date(AGORA - 200_000).toISOString(),
    },
  ],
  perdidas: [],
};

const comFila = (data: FilaComRelogio | undefined) => {
  filaRef.current = { data, isPending: data === undefined, isError: false, refetch: () => {} };
};

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = () => (
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>
  );
  const tela = render(arvore());
  return { ...tela, redesenhar: () => tela.rerender(arvore()) };
}

const tituloDaAba = () => screen.getByTestId("inbox-aba-atual");
const trilho = () => within(screen.getByTestId("inbox-abas"));

beforeEach(() => {
  filtroRef.current = "phone";
  comFila(FILA);
  get.mockClear();
});
afterEach(() => cleanup());

describe("com ?filter=phone, a coluna mostra a fila de ligações", () => {
  it("a fila no lugar da lista de conversas — e sem busca, filtros nem protocolo de conversa", () => {
    montar();

    expect(tituloDaAba()).toHaveTextContent("Telefone");
    const fila = screen.getByTestId("fila-do-telefone");
    expect(within(fila).getByText("Maria Souza")).toBeInTheDocument();
    expect(fila.querySelector('[data-secao="na-fila"] [data-ligacao-id="lig-aguardando"]')).not.toBeNull();
    expect(fila.querySelector('[data-secao="em-ligacao"] [data-ligacao-id="lig-em-ligacao"]')).not.toBeNull();

    expect(screen.queryByTestId("lista-de-conversas")).toBeNull();
    expect(screen.queryByTestId("filtros-de-conversa")).toBeNull();
    expect(screen.queryByTestId("busca-por-protocolo")).toBeNull();
    expect(screen.queryByTestId("chips-dos-times")).toBeNull();
    expect(screen.queryByTestId("alternancias-da-lista")).toBeNull();
  });

  it("o trilho marca a aba Telefone, com o selo de quem ESPERA (em ligação não conta)", () => {
    montar();
    const aba = trilho().getByRole("tab", { name: "Telefone" });
    expect(aba).toHaveAttribute("aria-selected", "true");
    expect(aba).toHaveTextContent("1");
  });

  it("a grade do Inbox é a mesma: a aba troca o conteúdo da coluna, não o esqueleto", () => {
    montar();
    expect(document.querySelector("[data-realtime-status]")).not.toBeNull();
    expect(screen.getByTestId("atalhos")).toBeInTheDocument();
  });

  it("clicar numa ligação com conversa a abre à direita, pelo caminho de sempre", async () => {
    montar();
    expect(get.mock.calls.map((c) => c[0])).not.toContain(`/api/v1/conversations/${CONVERSA_DA_LIGACAO}`);

    await userEvent.click(document.querySelector('[data-ligacao-id="lig-aguardando"]') as HTMLElement);

    await waitFor(() =>
      expect(get.mock.calls.map((c) => c[0])).toContain(`/api/v1/conversations/${CONVERSA_DA_LIGACAO}`),
    );
    // A linha da conversa aberta fica marcada — e a fila continua na coluna.
    expect(document.querySelector('[data-ligacao-id="lig-aguardando"]')).toHaveAttribute("aria-current", "true");
  });

  it("a leitura ainda não chegou: o esqueleto da fila, nunca a lista de conversas", () => {
    comFila(undefined);
    montar();
    expect(screen.getByTestId("fila-do-telefone-carregando")).toBeInTheDocument();
    expect(screen.queryByTestId("lista-de-conversas")).toBeNull();
  });

  it("link guardado numa organização sem telefone: a coluna diz por quê, e o trilho não tem a aba", () => {
    comFila({ ...FILA, ativa: false, times: [], numeros: [], ligacoes: [] });
    montar();
    expect(screen.getByText("O telefone não está ligado nesta organização.")).toBeInTheDocument();
    expect(trilho().queryByRole("tab", { name: "Telefone" })).toBeNull();
    expect(screen.queryByTestId("lista-de-conversas")).toBeNull();
  });
});

describe("CONTROLE — nas outras abas, a coluna segue sendo a de conversas", () => {
  it.each([
    // [o ?filter=, o título da coluna, a lista que a coluna desenha]
    ["unassigned", "Fila", "lista-de-conversas"],
    ["mine", "Minhas", "lista-de-conversas"],
    ["all", "Todas", "lista-de-conversas"],
    ["closed", "Fechadas", "lista-de-fechados"],
    ["ai", "Automático", "lista-de-conversas"],
    [null, "Fila", "lista-de-conversas"],
  ] as const)("?filter=%s: lista, filtros e protocolo de conversa; nada da fila do telefone", (filtro, titulo, lista) => {
    filtroRef.current = filtro;
    montar();

    expect(tituloDaAba()).toHaveTextContent(titulo);
    expect(screen.getByTestId(lista)).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^lista-de-/)).toHaveLength(1);
    expect(screen.getByTestId("filtros-de-conversa")).toBeInTheDocument();
    expect(screen.getByTestId("busca-por-protocolo")).toBeInTheDocument();
    expect(screen.queryByTestId("fila-do-telefone")).toBeNull();
    expect(screen.queryByTestId("chips-da-fila")).toBeNull();
    // A aba existe no trilho (a organização tem telefone), só não é a escolhida.
    expect(trilho().getByRole("tab", { name: "Telefone" })).toHaveAttribute("aria-selected", "false");
  });

  it("Todas segue com os chips de TIME e as alternâncias dela — e sem os chips da fila do telefone", () => {
    filtroRef.current = "all";
    montar();
    expect(screen.getByTestId("chips-dos-times")).toBeInTheDocument();
    expect(screen.getByTestId("alternancias-da-lista")).toBeInTheDocument();
    expect(screen.queryByTestId("chips-da-fila")).toBeNull();
  });

  it("organização SEM telefone: o trilho é o de sempre, sem a aba", () => {
    filtroRef.current = "mine";
    comFila({ ...FILA, ativa: false, times: [], numeros: [], ligacoes: [] });
    montar();

    expect(trilho().queryByRole("tab", { name: "Telefone" })).toBeNull();
    expect(trilho().getAllByRole("tab").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Fila",
      "Minhas",
      "Fechadas",
      "Automático",
    ]);
    expect(screen.getByTestId("lista-de-conversas")).toBeInTheDocument();
  });

  it("a leitura da fila falhando não tira nada das outras abas", () => {
    filtroRef.current = "mine";
    filaRef.current = { data: undefined, isPending: false, isError: true, refetch: () => {} };
    montar();

    expect(screen.getByTestId("lista-de-conversas")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(trilho().queryByRole("tab", { name: "Telefone" })).toBeNull();
  });
});

describe("os atalhos de teclado não navegam por uma lista que não está na tela", () => {
  const idsDosAtalhos = () => screen.getByTestId("atalhos").getAttribute("data-ids");

  it("ao entrar na aba Telefone os ids visíveis zeram; ao voltar, a lista os devolve", async () => {
    filtroRef.current = "mine";
    const { redesenhar } = montar();
    await waitFor(() => expect(idsDosAtalhos()).toBe("conversa-1,conversa-2"));

    filtroRef.current = "phone";
    redesenhar();
    await waitFor(() => expect(idsDosAtalhos()).toBe(""));
    expect(screen.getByTestId("fila-do-telefone")).toBeInTheDocument();

    filtroRef.current = "mine";
    redesenhar();
    await waitFor(() => expect(idsDosAtalhos()).toBe("conversa-1,conversa-2"));
  });
});
