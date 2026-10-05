/**
 * O PÉ DA CONVERSA, CONFORME O ESTADO DELA.
 *
 * Com a conversa ENCERRADA, o que o Inbox oferece para falar com o cliente é um
 * atendimento novo — não o seletor de modelo, que gravava a mensagem dentro do
 * atendimento que já tinha acabado (medição em `NovoAtendimentoAviso`).
 *
 * Aqui o Inbox é montado de verdade, com a conversa chegando pela rota, e o que
 * se mede é QUAL das duas peças aparece em cada estado. As peças em si têm
 * teste próprio; o defeito que isto prende é o da composição.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_QUE_FALAM_PRIMEIRO,
  canalFalaPrimeiro,
  capabilitiesOf,
} from "@/lib/channels/capabilities";

// Nenhum canal é nomeado aqui: quem sabe quais existem é `lib/channels`, e a
// tela decide pela CAPACIDADE. Se a matriz mudar, estes dois seguem achando um
// canal com a propriedade que o caso precisa — ou o teste acusa que não há.
/** Um canal que exige modelo aprovado fora da janela de 24h. */
const CANAL_COM_JANELA = PROVIDERS_QUE_FALAM_PRIMEIRO.find((p) => !capabilitiesOf(p).freeformOutsideWindow)!;
/** Um canal de mensagem que só responde quem já escreveu (não fala primeiro). */
const CANAL_QUE_NAO_FALA_PRIMEIRO = PROVIDERS_DE_MENSAGEM.find((p) => !canalFalaPrimeiro(p))!;

const CONVERSA = "00000000-0000-4000-8000-0000000000c1";
let conversa: Record<string, unknown> = {};
let podeEscrever = true;

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async (url?: string) => {
      if ((url ?? "").startsWith("/api/v1/conversations?")) return new Promise(() => {});
      if (url === `/api/v1/conversations/${CONVERSA}`) return { data: conversa };
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
  usePermission: () => podeEscrever,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({ useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({ useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/PainelDaConversa", () => ({ PainelDaConversa: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/FaixaDaEspera", () => ({ FaixaDaEspera: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/telefonia/BotaoLigar", () => ({ BotaoLigar: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({
  JanelaFechadaAviso: () => <div data-testid="seletor-de-modelo" />,
}));
const propsDoAviso = vi.fn();
vi.mock("@/components/inbox/NovoAtendimentoAviso", () => ({
  NovoAtendimentoAviso: (props: Record<string, unknown>) => {
    propsDoAviso(props);
    return <div data-testid="atendimento-novo" />;
  },
}));

import { InboxLayout } from "./InboxLayout";

/** Conversa no canal com janela, cliente que nunca escreveu: a janela está fechada. */
const base = {
  id: CONVERSA,
  organization_id: "00000000-0000-4000-8000-0000000000aa",
  contact_id: "00000000-0000-4000-8000-0000000000d1",
  channel_session_id: "sessao-7232",
  channel: "whatsapp",
  status: "claimed",
  service_revision: 3,
  protocol: "20260925000092",
  last_inbound_at: null,
  unread_count_for_assignee: 0,
  assigned_to_user_id: "u-1",
  contacts: { id: "00000000-0000-4000-8000-0000000000d1", name: "MRV", phone_number: "+5561999990000", is_blocked: false, is_anonymized: false },
  channel_sessions: { id: "sessao-7232", provider: CANAL_COM_JANELA },
};

async function pintar(mudancas: Record<string, unknown> = {}) {
  conversa = { ...base, ...mudancas };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} />
    </QueryClientProvider>,
  );
  // O composer só existe com a conversa carregada: é o sinal de que a tela assentou.
  await waitFor(() => expect(screen.getByTestId("composer")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  propsDoAviso.mockReset();
  podeEscrever = true;
});

describe("os canais que os casos precisam existem (guarda de vacuidade)", () => {
  it("há um canal com janela e um que não fala primeiro", () => {
    expect(CANAL_COM_JANELA).toBeTruthy();
    expect(CANAL_QUE_NAO_FALA_PRIMEIRO).toBeTruthy();
  });
});

describe("o pé da conversa conforme o estado", () => {
  it("EM ANDAMENTO com a janela fechada: o seletor de modelo, como sempre", async () => {
    await pintar({ status: "claimed" });

    expect(screen.getByTestId("seletor-de-modelo")).toBeTruthy();
    expect(screen.queryByTestId("atendimento-novo")).toBeNull();
  });

  it("ENCERRADA: o atendimento novo — e o seletor de modelo NÃO aparece", async () => {
    // O estado da captura de tela do relato: "Fechada", "o cliente nunca
    // escreveu", e o seletor de modelo logo abaixo.
    await pintar({ status: "closed" });

    expect(screen.getByTestId("atendimento-novo")).toBeTruthy();
    expect(screen.queryByTestId("seletor-de-modelo"), "modelo saindo de dentro do atendimento encerrado").toBeNull();
    expect(propsDoAviso).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contactId: base.contact_id,
        nome: "MRV",
        // Pelo número DESTA conversa: é nela que o atendimento novo nasce.
        conexaoId: "sessao-7232",
      }),
    );
  });

  it.each(["resolved", "archived"])("%s também é encerrada", async (status) => {
    await pintar({ status });

    expect(screen.getByTestId("atendimento-novo")).toBeTruthy();
    expect(screen.queryByTestId("seletor-de-modelo")).toBeNull();
  });
});

describe("encerrada, mas sem como chamar por aqui — nenhuma das duas portas", () => {
  it("contato bloqueado", async () => {
    await pintar({ status: "closed", contacts: { ...base.contacts, is_blocked: true } });

    expect(screen.queryByTestId("atendimento-novo")).toBeNull();
    expect(screen.queryByTestId("seletor-de-modelo")).toBeNull();
  });

  it("quem só lê não recebe um botão que o servidor vai recusar", async () => {
    podeEscrever = false;
    await pintar({ status: "closed" });

    expect(screen.queryByTestId("atendimento-novo")).toBeNull();
  });

  it("conversa de telefone: por ali se liga, não se escreve", async () => {
    await pintar({ status: "closed", channel: "phone" });

    expect(screen.queryByTestId("atendimento-novo")).toBeNull();
  });

  it("visitante do chat do site que não deixou telefone: não há para onde chamar", async () => {
    await pintar({
      status: "closed",
      contacts: { ...base.contacts, phone_number: null },
      channel_sessions: { id: "sessao-site", provider: CANAL_QUE_NAO_FALA_PRIMEIRO },
    });

    expect(screen.queryByTestId("atendimento-novo")).toBeNull();
  });

  it("…mas com telefone no cadastro, o visitante do site pode ser chamado no WhatsApp", async () => {
    await pintar({
      status: "closed",
      channel_sessions: { id: "sessao-site", provider: CANAL_QUE_NAO_FALA_PRIMEIRO },
    });

    expect(screen.getByTestId("atendimento-novo")).toBeTruthy();
  });
});
