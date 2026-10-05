import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChamarNoWhatsAppDialog } from "./ChamarNoWhatsAppDialog";

/**
 * CHAMAR DE NOVO — o que o diálogo ganhou para servir a quem já foi atendido.
 *
 * Três coisas, e cada uma tem um jeito próprio de falhar em silêncio:
 *
 *   1. o número padrão é o da conversa anterior — sem isso, numa empresa com
 *      dois números, chamar de novo sairia pelo primeiro da lista e abriria uma
 *      conversa PARALELA em vez de um atendimento novo na conversa do cliente;
 *   2. a janela diz que vai nascer um atendimento novo — é a dúvida exata de
 *      quem relatou o defeito;
 *   3. de dentro do Inbox, quem mostra a conversa é o Inbox — navegar para a
 *      mesma página não troca nada na tela.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({
  useTimesDoInbox: () => ({ data: [], isLoading: false, isError: false }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const CONEXOES = [
  { id: "sessao-3025", display_name: "Totus · 3025", phone_number: null, status: "WORKING" },
  { id: "sessao-7232", display_name: "Totus · 7232", phone_number: null, status: "WORKING" },
];

function pintar(props: Partial<React.ComponentProps<typeof ChamarNoWhatsAppDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChamarNoWhatsAppDialog open onOpenChange={() => {}} contactId="contato-1" nome="MRV" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/channel-sessions")) return { data: CONEXOES };
    if (url.startsWith("/api/v1/channels/modelos")) return { data: { exige_modelo: false, modelos: [] } };
    throw new Error(`rota não esperada: ${url}`);
  });
  post.mockResolvedValue({ data: { conversation_id: "conv-1", enviada: true, erro_envio: null } });
});

afterEach(() => {
  cleanup();
  get.mockReset();
  post.mockReset();
  push.mockReset();
});

async function escreverEEnviar() {
  await userEvent.type(await screen.findByLabelText("Mensagem"), "Olá de novo");
  await userEvent.click(screen.getByRole("button", { name: "Enviar e abrir conversa" }));
  await waitFor(() => expect(post).toHaveBeenCalled());
}

describe("o número que vem escolhido", () => {
  it("chamar de novo sai pelo número da conversa ANTERIOR, não pelo primeiro da lista", async () => {
    pintar({ conexaoInicial: "sessao-7232", atendimentoAnteriorEncerrado: true });

    const seletor = (await screen.findByLabelText("Enviar pelo número")) as HTMLSelectElement;
    expect(seletor.value).toBe("sessao-7232");

    await escreverEEnviar();
    expect(post.mock.calls[0]![1]).toMatchObject({ channel_session_id: "sessao-7232", contact_id: "contato-1" });
  });

  it("número que não existe mais entre as conexões é ignorado — cai no padrão de sempre", async () => {
    pintar({ conexaoInicial: "sessao-arquivada" });

    const seletor = (await screen.findByLabelText("Enviar pelo número")) as HTMLSelectElement;
    expect(seletor.value).toBe("sessao-3025");
  });

  it("sem conversa anterior, nada muda: a primeira conexão viva", async () => {
    pintar();

    const seletor = (await screen.findByLabelText("Enviar pelo número")) as HTMLSelectElement;
    expect(seletor.value).toBe("sessao-3025");
  });
});

describe("a janela diz o que vai acontecer", () => {
  it("com atendimento anterior encerrado, avisa que nasce um atendimento NOVO", async () => {
    pintar({ atendimentoAnteriorEncerrado: true });

    expect((await screen.findByTestId("aviso-novo-atendimento")).textContent).toMatch(
      /abre um atendimento novo, com protocolo próprio/,
    );
  });

  it("na primeira chamada não há atendimento anterior, e o aviso não aparece", async () => {
    pintar();

    await screen.findByLabelText("Enviar pelo número");
    expect(screen.queryByTestId("aviso-novo-atendimento")).toBeNull();
  });
});

describe("para onde a pessoa vai depois de enviar", () => {
  it("de fora do Inbox: navega para a conversa", async () => {
    pintar();

    await escreverEEnviar();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-1"));
  });

  it("de dentro do Inbox: entrega a conversa a quem abriu a janela, sem navegar", async () => {
    const onIniciada = vi.fn();
    pintar({ onIniciada });

    await escreverEEnviar();
    await waitFor(() => expect(onIniciada).toHaveBeenCalledWith("conv-1"));
    expect(push).not.toHaveBeenCalled();
  });
});
