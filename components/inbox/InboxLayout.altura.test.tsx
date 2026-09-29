/**
 * A INBOX DESCONTA AS FAIXAS DO TOPO DA ALTURA DELA.
 *
 * A grade da Inbox ocupa a janela abaixo da TopBar (`100dvh - 3.5rem`) e não rola:
 * o composer mora no rodapé dela. Com uma faixa de estado visível no topo
 * (conexão caída, aviso de instabilidade do telefone, acompanhamento), essa conta
 * sobrava pela altura da faixa — a página rolava e o campo de digitar nascia fora
 * da dobra. A altura passa a descontar `--altura-das-faixas`, que o contêiner das
 * faixas publica (`FaixasDoTopo`), 0 sem faixa nenhuma.
 *
 * O jsdom não mede layout: prova-se que a grade USA a variável. O composer dentro
 * da dobra, com a faixa na tela, é da prova pela tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ALTURA_ABAIXO_DA_TOPBAR, VARIAVEL_DA_ALTURA_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async (url?: string) => {
      if ((url ?? "").startsWith("/api/v1/conversations?")) return new Promise(() => {});
      if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
      if (url === "/api/v1/conversations/counts") return { data: {} };
      return { data: [] };
    },
  },
}));
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
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: "00000000-0000-4000-8000-0000000000aa" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({ useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({ useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "./InboxLayout";

afterEach(() => cleanup());

describe("a altura da Inbox e as faixas do topo", () => {
  it("a grade mede a janela menos a TopBar E menos as faixas do topo", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxLayout />
      </QueryClientProvider>,
    );
    const grade = await waitFor(() => {
      const g = document.querySelector("[data-realtime-status]");
      expect(g).not.toBeNull();
      return g as HTMLElement;
    });
    expect(ALTURA_ABAIXO_DA_TOPBAR).toBe(`calc(100dvh - 3.5rem - var(${VARIAVEL_DA_ALTURA_DAS_FAIXAS}, 0px))`);
    expect(grade.getAttribute("style") ?? "").toContain(`var(${VARIAVEL_DA_ALTURA_DAS_FAIXAS}, 0px)`);
    // A altura antiga, fixa, numa classe junto brigaria com a nova.
    expect(grade.className).not.toContain("h-[calc(100dvh-3.5rem)]");
  });
});
