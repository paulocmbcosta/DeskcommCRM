import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const definir = vi.fn();
const toastErro = vi.fn();
const toastOk = vi.fn();

vi.mock("sonner", () => ({ toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) } }));
vi.mock("@/app/actions/settings/definirNascimentoDoCard", () => ({
  definirNascimentoDoCard: (e: unknown) => definir(e),
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const { NascimentoDoCard } = await import("@/components/crm/NascimentoDoCard");

beforeEach(() => {
  definir.mockReset();
  toastErro.mockReset();
  toastOk.mockReset();
});

describe("NascimentoDoCard", () => {
  it("no modo de sempre, não mostra a certeza mínima", () => {
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    expect(screen.getByLabelText(/toda conversa vira card/i)).toBeChecked();
    expect(screen.queryByText(/certeza mínima/i)).toBeNull();
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

  it("sem chave da OpenRouter, diz onde cadastrar", async () => {
    definir.mockResolvedValue({ ok: false, erro: "sem_chave_openrouter" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringMatching(/OpenRouter.*Provedores/)));
  });

  it("quem não é admin vê a regra, mas não muda", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar={false} />);
    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /salvar/i })).toBeNull();
  });
});
