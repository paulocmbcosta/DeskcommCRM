/**
 * O PREFIXO DE DISCAGEM NA TELA DO NÚMERO (Conexões › Telefone, migration 0287).
 *
 * Medido pelo que a pessoa vê e pelo que a tela manda à API: o prefixo aparece
 * no cartão, volta no formulário de edição, o valor fora da régua trava o
 * "Salvar" com a explicação no lugar da ajuda, e mudar SÓ o prefixo manda o
 * PATCH sem senha (não é a conta).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const api = vi.hoisted(() => ({ patch: vi.fn(async () => ({ data: null })), prefixo: "0" as string | null }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        oferecida: true,
        numeros: [
          {
            id: "n1",
            nome: "Totus 3025",
            numero: "+556136861503",
            servidor: "voip.totussistema.com.br",
            porta: 5060,
            transporte: "udp",
            usuario: "6136861503",
            prefixo: api.prefixo,
            time_id: null,
            time_nome: null,
            status: "WORKING",
            status_reason: null,
          },
        ],
      },
    })),
    patch: api.patch,
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { CanalTelefoneClient } from "./CanalTelefoneClient";

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CanalTelefoneClient />
    </QueryClientProvider>,
  );
}

const AJUDA =
  "Algumas operadoras pedem um 0 (ou 0 + código da operadora) antes do DDD. Na dúvida, pergunte à operadora. Ex.: 0";

beforeEach(() => {
  api.patch.mockClear();
  api.prefixo = "0";
});
afterEach(() => cleanup());

describe("prefixo de discagem na tela do número", () => {
  it("aparece no cartão do número e volta no formulário de edição", async () => {
    pintar();
    const cartao = (await screen.findByText("Totus 3025")).closest("[data-telefonia-numero]") as HTMLElement;
    expect(within(cartao).getByText(/Prefixo de discagem:/)).toHaveTextContent("Prefixo de discagem: 0");

    await userEvent.click(within(cartao).getByRole("button", { name: "Editar" }));
    const campo = screen.getByLabelText("Prefixo de discagem (opcional)");
    expect(campo).toHaveValue("0");
    expect(screen.getByText(AJUDA)).toBeInTheDocument();
  });

  it("número sem prefixo não mostra o rótulo no cartão", async () => {
    api.prefixo = null;
    pintar();
    await screen.findByText("Totus 3025");
    expect(screen.queryByText(/Prefixo de discagem:/)).toBeNull();
  });

  it("fora da régua: explica e trava o Salvar; mudar SÓ o prefixo salva sem senha", async () => {
    pintar();
    await userEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const campo = screen.getByLabelText("Prefixo de discagem (opcional)");
    const salvar = screen.getByRole("button", { name: "Salvar e conectar" });

    await userEvent.clear(campo);
    await userEvent.type(campo, "0a");
    expect(campo).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Só números, de 1 a 4 dígitos.")).toBeInTheDocument();
    expect(salvar).toBeDisabled();

    await userEvent.clear(campo);
    await userEvent.type(campo, "015");
    expect(salvar).toBeEnabled();
    await userEvent.click(salvar);

    expect(api.patch).toHaveBeenCalledTimes(1);
    const [url, corpo] = api.patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe("/api/v1/telefonia/numeros/n1");
    expect(corpo.prefixo).toBe("015");
    expect(corpo).not.toHaveProperty("senha");
  });
});
