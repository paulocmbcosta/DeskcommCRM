/**
 * OS FILTROS DO INBOX MORAM NO ENDEREÇO — e o que sai deles para cada rota.
 *
 * Até aqui só a aba ia para o endereço; o resto era `useState` no `InboxLayout`
 * e se perdia ao recarregar. Este arquivo monta o Inbox inteiro sobre um
 * `next/navigation` de mentira que se comporta como o de verdade no ponto que
 * importa: `useSearchParams` lê o endereço do navegador e REDESENHA quando
 * `history.replaceState` é chamado (é assim que o Next integra a API nativa de
 * histórico).
 *
 * O que só este arquivo mede — as peças puras têm os seus testes:
 *   1. o encanamento: do endereço até o pedido que sai para cada rota;
 *   2. que um gesto na tela ESCREVE o endereço, sem perder a conversa aberta;
 *   3. ⭐ que a contagem leva TODOS os filtros ligados enquanto a lista leva só
 *      os que valem na aba — o selo de uma aba diz o que o clique vai mostrar.
 *
 * O que ele NÃO mede: que o Next de verdade sincroniza `useSearchParams` com
 * `replaceState`. Isso é do navegador, e quem prova é o teste de ponta a ponta
 * (`tests/e2e/inbox-filtros-por-atendente-e-caixa.spec.ts`, recarregar e abrir
 * o endereço copiado).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const ANA = "22222222-2222-4222-8222-222222222222";
const ASSUNTO = "33333333-3333-4333-8333-333333333333";

/** Quem escuta o endereço: `replaceState` avisa, e o hook de mentira relê. */
const { ouvintes } = vi.hoisted(() => ({ ouvintes: new Set<() => void>() }));

const get = vi.fn(async (url?: string): Promise<unknown> => {
  const u = url ?? "";
  if (u.startsWith("/api/v1/conversations/counts")) return { data: { fila: 0, mine: 0, all: 0, closed: 0 } };
  if (u.startsWith("/api/v1/conversations?")) return { data: [], meta: { has_more: false } };
  if (u.startsWith("/api/v1/atendimentos?")) return { data: [], meta: { has_more: false } };
  if (u === "/api/v1/ai/automatico-ativo") return { data: { ativo: true } };
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
vi.mock("next/navigation", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    usePathname: () => "/app/inbox",
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => {
      const busca = useSyncExternalStore(
        (avisar: () => void) => {
          ouvintes.add(avisar);
          return () => ouvintes.delete(avisar);
        },
        () => window.location.search,
      );
      return useMemo(() => new URLSearchParams(busca), [busca]);
    },
  };
});
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "00000000-0000-4000-8000-0000000000e1" },
    activeOrg: { orgId: ORG, role: "manager", visibility_mode: "all" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/telefonia/useFilaDoTelefone", () => ({
  useFilaDoTelefone: () => ({ data: undefined, isPending: false, isError: false, refetch: () => {} }),
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/PainelDaConversa", () => ({ PainelDaConversa: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ResultadosPorProtocolo", () => ({ ResultadosPorProtocolo: () => null }));
vi.mock("@/components/inbox/ChipsDosTimes", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ChipsDosTimes: () => null,
}));
vi.mock("@/components/telefonia/BotaoLigar", () => ({ BotaoLigar: () => null }));
vi.mock("@/components/telefonia/fila/FilaDoTelefone", () => ({ FilaDoTelefone: () => null }));

// AS LISTAS viram sentinelas que MOSTRAM o que receberam: é o que se mede.
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ filtrosAtivos, onLimparFiltros }: { filtrosAtivos: string[]; onLimparFiltros?: () => void }) => (
    <div data-testid="lista-de-conversas" data-nomes={filtrosAtivos.join("|")}>
      <button type="button" onClick={onLimparFiltros}>
        limpar
      </button>
    </div>
  ),
}));
vi.mock("@/components/inbox/AtendimentosFechadosList", () => ({
  AtendimentosFechadosList: ({
    filtros,
    filtrosAtivos,
    onLimparFiltros,
  }: {
    filtros: Record<string, unknown>;
    filtrosAtivos: string[];
    onLimparFiltros?: () => void;
  }) => (
    <div
      data-testid="lista-de-fechados"
      data-filtros={JSON.stringify(filtros)}
      data-nomes={filtrosAtivos.join("|")}
    >
      <button type="button" onClick={onLimparFiltros}>
        limpar
      </button>
    </div>
  ),
}));
// O FUNIL vira um painel de botões: cada um faz o gesto que o seletor de verdade
// faria (os seletores têm o teste deles, em `InboxFilters.novos.test.tsx`).
vi.mock("@/components/inbox/InboxFilters", () => ({
  InboxFilters: ({
    value,
    onChange,
  }: {
    value: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
  }) => (
    <div data-testid="funil" data-valor={JSON.stringify(value)}>
      <button type="button" onClick={() => onChange({ ...value, search: "maria" })}>
        buscar maria
      </button>
      <button type="button" onClick={() => onChange({ ...value, assigned_to: ANA })}>
        atendente ana
      </button>
      <button type="button" onClick={() => onChange({ ...value, channel: "phone" })}>
        caixa telefone
      </button>
    </div>
  ),
}));

import { InboxLayout } from "@/components/inbox/InboxLayout";

const replaceOriginal = window.history.replaceState.bind(window.history);

function abrirEm(endereco: string) {
  replaceOriginal(null, "", endereco);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

const pedidos = (prefixo: string) =>
  get.mock.calls.map((chamada) => String(chamada[0])).filter((url) => url.startsWith(prefixo));
const ultimo = (prefixo: string) => new URLSearchParams((pedidos(prefixo).at(-1) ?? "?").split("?")[1] ?? "");
const endereco = () => new URLSearchParams(window.location.search);
const fechados = () => screen.getByTestId("lista-de-fechados");
const filtrosDosFechados = () => JSON.parse(fechados().getAttribute("data-filtros") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  get.mockClear();
  // O `replaceState` de verdade muda o endereço; este avisa quem está lendo —
  // que é o que o roteador do Next faz por baixo.
  window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    replaceOriginal(...args);
    act(() => ouvintes.forEach((avisar) => avisar()));
  };
});

afterEach(() => {
  cleanup();
  window.history.replaceState = replaceOriginal;
  replaceOriginal(null, "", "/app/inbox");
});

describe("⭐ abrir um endereço com filtros abre a lista já filtrada", () => {
  it("Fechadas, só as minhas, de hoje, de um assunto", async () => {
    abrirEm(`/app/inbox?filter=closed&assigned_to=me&periodo=hoje&assunto_id=${ASSUNTO}`);
    const filtros = filtrosDosFechados();
    expect(filtros.assigned_to).toBe("me");
    expect(filtros.assunto_id).toBe(ASSUNTO);
    // O período chega como INSTANTE: a meia-noite de hoje, no fuso de quem olha.
    const hoje = new Date();
    expect(filtros.closed_from).toBe(
      new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).toISOString(),
    );
    expect(fechados().getAttribute("data-nomes")).toBe("Atendente|Período|Assunto");
  });

  it("o botão \"Só as minhas\" nasce pressionado", () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=me");
    expect(screen.getByTestId("so-as-minhas").getAttribute("aria-pressed")).toBe("true");
  });

  it("…e também com o PRÓPRIO id no endereço — o link que a gestora manda para a pessoa", () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=00000000-0000-4000-8000-0000000000e1");
    expect(screen.getByTestId("so-as-minhas").getAttribute("aria-pressed")).toBe("true");
  });

  it("valor fora de forma no endereço é ignorado — a lista abre sem aquele filtro", () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=qualquer-coisa&channel=fax");
    expect(filtrosDosFechados()).toEqual({});
    expect(fechados().getAttribute("data-nomes")).toBe("");
  });

  it("CONTROLE: sem filtro no endereço, nada é filtrado", () => {
    abrirEm("/app/inbox?filter=closed");
    expect(filtrosDosFechados()).toEqual({});
    expect(screen.getByTestId("so-as-minhas").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("um gesto na tela escreve o endereço", () => {
  it("⭐ ligar \"Só as minhas\" grava `assigned_to=me` — e a conversa aberta continua no endereço", async () => {
    abrirEm("/app/inbox?filter=closed&id=conversa-1");
    await userEvent.click(screen.getByTestId("so-as-minhas"));
    expect(endereco().get("assigned_to")).toBe("me");
    expect(endereco().get("id")).toBe("conversa-1");
    expect(endereco().get("filter")).toBe("closed");
    // …e a lista já pede com o filtro.
    expect(filtrosDosFechados().assigned_to).toBe("me");
  });

  it("desligar tira o parâmetro", async () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=me");
    await userEvent.click(screen.getByTestId("so-as-minhas"));
    expect(endereco().has("assigned_to")).toBe(false);
    expect(filtrosDosFechados()).toEqual({});
  });

  it("escolher um colega no funil desliga o \"Só as minhas\": é o MESMO filtro", async () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=me");
    await userEvent.click(screen.getByText("atendente ana"));
    expect(endereco().get("assigned_to")).toBe(ANA);
    expect(screen.getByTestId("so-as-minhas").getAttribute("aria-pressed")).toBe("false");
  });

  it("⭐ trocar de aba mantém os filtros no endereço", async () => {
    abrirEm("/app/inbox?filter=closed&assigned_to=me&channel=phone");
    await userEvent.click(within(screen.getByTestId("inbox-abas")).getByRole("tab", { name: /Todas/ }));
    expect(endereco().get("filter")).toBe("all");
    expect(endereco().get("assigned_to")).toBe("me");
    expect(endereco().get("channel")).toBe("phone");
  });

  it("⭐ \"Limpar filtros\" apaga todos os filtros e mantém a aba e a conversa aberta", async () => {
    abrirEm(`/app/inbox?filter=closed&id=conversa-1&assigned_to=me&periodo=hoje&channel=phone&assunto_id=${ASSUNTO}`);
    await userEvent.click(within(fechados()).getByText("limpar"));
    expect(endereco().toString()).toBe("filter=closed&id=conversa-1");
    expect(filtrosDosFechados()).toEqual({});
  });

  it("⛔ a busca NÃO vai para o endereço — nome de cliente não fica no histórico do navegador", async () => {
    abrirEm("/app/inbox");
    const escritas = vi.fn();
    const comAviso = window.history.replaceState;
    window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      escritas();
      comAviso(...args);
    };
    await userEvent.click(screen.getByText("buscar maria"));
    expect(window.location.search).not.toContain("maria");
    // Nem uma escrita: o `replaceState` derruba uma navegação que esteja em
    // curso, e em `/app/inbox` sem parâmetro digitar não pode acrescentar `filter`.
    expect(escritas).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    await userEvent.click(within(screen.getByTestId("inbox-abas")).getByRole("tab", { name: /Todas/ }));
    // …mas vale: a lista pede com ela.
    await waitFor(() => expect(ultimo("/api/v1/conversations?").get("search")).toBe("maria"));
  });
});

describe("⭐ a lista leva o que vale NA ABA; a contagem leva TUDO o que está ligado", () => {
  it("na Fila, o atendente e o período não são aplicados à lista — e a contagem os recebe", async () => {
    abrirEm("/app/inbox?filter=unassigned&assigned_to=me&periodo=hoje&channel=phone");
    await waitFor(() => expect(pedidos("/api/v1/conversations?").length).toBeGreaterThan(0));
    const lista = ultimo("/api/v1/conversations?");
    // A Fila não tem atendente: aplicado ali, o filtro só poderia esvaziá-la.
    expect(lista.has("assigned_to")).toBe(false);
    expect(lista.has("closed_from")).toBe(false);
    // O meio vale em toda aba.
    expect(lista.get("channel")).toBe("phone");
    // E os nomes do vazio são os do que foi aplicado — nem mais, nem menos.
    expect(screen.getByTestId("lista-de-conversas").getAttribute("data-nomes")).toBe("Caixa de entrada");

    await waitFor(() => expect(pedidos("/api/v1/conversations/counts").length).toBeGreaterThan(0));
    const contagem = ultimo("/api/v1/conversations/counts");
    // O selo de Fechadas e o de Todas têm de dizer o que o clique vai mostrar.
    expect(contagem.get("assigned_to")).toBe("me");
    expect(contagem.get("channel")).toBe("phone");
    expect(contagem.has("closed_from")).toBe(true);
  });

  it("em Todas, o atendente chega à lista de conversas", async () => {
    abrirEm(`/app/inbox?filter=all&assigned_to=${ANA}`);
    await waitFor(() => expect(ultimo("/api/v1/conversations?").get("assigned_to")).toBe(ANA));
    expect(ultimo("/api/v1/conversations?").get("exclude_finished")).toBe("true");
  });

  it("\"Sem atendente\" em Todas pede a ordem de Todas — não a da Fila", async () => {
    abrirEm("/app/inbox?filter=all&assigned_to=unassigned");
    await waitFor(() => expect(ultimo("/api/v1/conversations?").get("assigned_to")).toBe("unassigned"));
    expect(ultimo("/api/v1/conversations?").get("ordem")).toBe("atividade");
  });

  it("⛔ em Minhas, o filtro de atendente do endereço NÃO troca o dono da aba", async () => {
    // O defeito possível: os auxiliares são espalhados por cima do filtro da
    // aba, e um `assigned_to` vindo do endereço transformaria "Minhas" em "as
    // da Ana" com o título da aba dizendo "Minhas".
    abrirEm(`/app/inbox?filter=mine&assigned_to=${ANA}`);
    await waitFor(() => expect(pedidos("/api/v1/conversations?").length).toBeGreaterThan(0));
    expect(ultimo("/api/v1/conversations?").get("assigned_to")).toBe("me");
  });

  it("um pedido de contagem só — o trilho não faz o dele com outros parâmetros", async () => {
    abrirEm("/app/inbox?filter=all&insatisfeitos=1&assigned_to=me");
    await waitFor(() => expect(pedidos("/api/v1/conversations/counts").length).toBeGreaterThan(0));
    const distintos = new Set(pedidos("/api/v1/conversations/counts"));
    expect([...distintos]).toHaveLength(1);
    // Era o que o trilho deixava de mandar, e o selo de Todas discordava da lista.
    expect(ultimo("/api/v1/conversations/counts").get("insatisfeitos")).toBe("true");
  });
});
