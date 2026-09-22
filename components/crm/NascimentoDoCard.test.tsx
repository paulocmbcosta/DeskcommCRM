import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const definir = vi.fn();
const toastErro = vi.fn();
const toastOk = vi.fn();
const refreshMock = vi.fn();

vi.mock("sonner", () => ({ toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) } }));
vi.mock("@/app/actions/settings/definirNascimentoDoCard", () => ({
  definirNascimentoDoCard: (e: unknown) => definir(e),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const { NascimentoDoCard } = await import("@/components/crm/NascimentoDoCard");

/**
 * `delay: null` mata a espera que o user-event insere entre cada evento de
 * ponteiro — sem isso, abrir um Select do Radix neste ambiente estoura o teto
 * padrão do vitest (medido em outros testes deste repo).
 */
const usuario = () => userEvent.setup({ delay: null });
const TETO_MS = 30_000;

beforeEach(() => {
  definir.mockReset();
  toastErro.mockReset();
  toastOk.mockReset();
  refreshMock.mockReset();
});

describe("NascimentoDoCard", () => {
  it("no modo de sempre, não mostra a certeza mínima", () => {
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    expect(screen.getByLabelText(/toda conversa vira card/i)).toBeChecked();
    expect(screen.queryByText(/certeza mínima/i)).toBeNull();
  });

  it("Salvar começa desabilitado — nada foi mudado ainda", () => {
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    expect(screen.getByRole("button", { name: /salvar/i })).toBeDisabled();
  });

  it("escolher 'Só conversas comerciais' mostra a certeza mínima e salva a escolha", async () => {
    definir.mockResolvedValue({ ok: true, modo: "classificador", limiar: 0.7 });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    expect(screen.getByText(/certeza mínima/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(definir).toHaveBeenCalledWith({ modo: "classificador", limiar: 0.7 }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
  });

  it(
    "troca o valor da certeza mínima no Select e salva o limiar novo",
    { timeout: TETO_MS },
    async () => {
      definir.mockResolvedValue({ ok: true, modo: "classificador", limiar: 0.9 });
      const user = usuario();
      render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.7 }} podeEditar />);

      await user.click(screen.getByRole("combobox", { name: /certeza mínima/i }));
      await user.click(await screen.findByRole("option", { name: "90%" }));

      fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
      await waitFor(() => expect(definir).toHaveBeenCalledWith({ modo: "classificador", limiar: 0.9 }));
    },
  );

  it("sem chave da OpenRouter, diz onde cadastrar e deixa o link fixo no card", async () => {
    definir.mockResolvedValue({ ok: false, erro: "sem_chave_openrouter" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringMatching(/OpenRouter.*Credenciais/)));
    const link = screen.getByRole("link", { name: /cadastrar uma chave/i });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
  });

  it("erro tente_de_novo recarrega a página em vez de deixar o admin salvar em cima de dado velho", async () => {
    definir.mockResolvedValue({ ok: false, erro: "tente_de_novo" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastErro).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
  });

  it("quem não é admin vê a regra, mas não muda", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar={false} />);
    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /salvar/i })).toBeNull();
  });

  it("quando a regra salva muda por fora (key nova, no molde da página), remonta e Salvar volta a ficar desabilitado", () => {
    const { rerender } = render(
      <NascimentoDoCard key="toda_conversa:0.7" inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />,
    );
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    expect(screen.getByRole("button", { name: /salvar/i })).toBeEnabled();

    rerender(
      <NascimentoDoCard key="classificador:0.7" inicial={{ modo: "classificador", limiar: 0.7 }} podeEditar />,
    );
    expect(screen.getByRole("button", { name: /salvar/i })).toBeDisabled();
  });
});
