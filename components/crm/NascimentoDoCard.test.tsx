import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const { NascimentoDoCard, SecaoNascimentoDoCard } = await import("@/components/crm/NascimentoDoCard");

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

  it("no modo classificador, avisa que as últimas mensagens vão pra OpenRouter e TypeSafe — LGPD", () => {
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    expect(screen.queryByTestId("aviso-lgpd-envio-terceiros")).toBeNull();

    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    expect(screen.getByTestId("aviso-lgpd-envio-terceiros")).toHaveTextContent(
      "Para decidir, as últimas mensagens da conversa são enviadas à OpenRouter e à TypeSafe (o Jev).",
    );
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

  it("sem chave da OpenRouter, diz onde cadastrar e deixa o link fixo no card — SEM role=alert (o toast já anuncia)", async () => {
    definir.mockResolvedValue({ ok: false, erro: "sem_chave_openrouter" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringMatching(/OpenRouter.*Credenciais/)));
    const link = screen.getByRole("link", { name: /cadastrar uma chave/i });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
    // Duplicar o anúncio (toast + alert) faria um leitor de tela ouvir a
    // mesma frase duas vezes — por isso este aviso é texto comum, não alerta.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ao salvar com sucesso, o foco vai para o título da seção", async () => {
    definir.mockResolvedValue({ ok: true, modo: "classificador", limiar: 0.7 });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: /quando o card nasce/i })).toHaveFocus();
  });

  it("erro tente_de_novo pede pra conferir e salvar de novo — NUNCA 'recarregue', o refresh() já fez isso", async () => {
    definir.mockResolvedValue({ ok: false, erro: "tente_de_novo" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() =>
      expect(toastErro).toHaveBeenCalledWith("Outra pessoa mudou esta configuração agora. Confira e salve de novo."),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("quem não é admin vê a regra, mas não muda", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar={false} />);
    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /salvar/i })).toBeNull();
  });

  it("quem não é admin vê o selo 'Em vigor' na opção marcada — sem ele a prova pela tela não mostra qual regra vale", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar={false} />);
    const marcada = screen.getByTestId("opcao-nascimento-classificador");
    const naoMarcada = screen.getByTestId("opcao-nascimento-toda_conversa");
    expect(within(marcada).getByText("Em vigor")).toBeInTheDocument();
    expect(within(naoMarcada).queryByText("Em vigor")).toBeNull();
  });

  it("admin vê o rádio marcado e o destaque de sempre, sem o selo — ele já sabe que pode mudar", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar />);
    expect(screen.queryByText("Em vigor")).toBeNull();
    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeChecked();
  });
});

describe("SecaoNascimentoDoCard — o invólucro que a página usa (é quem tem a key)", () => {
  /**
   * ⚠️ Este é o teste que PROVA a `key`, não o clique.
   *
   * Uma versão anterior deste teste clicava em "Só conversas comerciais"
   * ANTES do rerender e só então rerenderizava com `inicial` já em
   * `classificador`/0.7 — os MESMOS valores que o clique já tinha deixado no
   * estado local. Isso passava com ou sem remontagem: o clique, sozinho, já
   * igualava `modo`/`limiar` ao `inicial` novo, então a asserção "Salvar
   * desabilitado" era verdadeira mesmo se a `key` nunca existisse. Sabotagem
   * confirmou: comentar a `key` de `SecaoNascimentoDoCard` não derrubava
   * aquele teste.
   *
   * Este aqui NÃO clica em nada — o `rerender` troca só o `inicial`, com um
   * `limiar` (0.8) que o usuário nunca escolheu. Só a REMONTAGEM (a `key`
   * mudando de "toda_conversa:0.7" pra "classificador:0.8") explica o rádio
   * novo aparecer marcado e o Salvar nascer desabilitado — sem ela, o estado
   * local ficaria preso em "toda_conversa"/0.7 e o teste reprovaria. Sabotado
   * de novo (removendo a `key` do invólucro) para confirmar que ESTE vai pro
   * vermelho: foi.
   */
  it("quando a regra salva muda por fora, remonta com a regra nova sem precisar de clique", () => {
    const { rerender } = render(
      <SecaoNascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />,
    );
    expect(screen.getByLabelText(/toda conversa vira card/i)).toBeChecked();

    rerender(<SecaoNascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar />);

    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeChecked();
    expect(screen.getByRole("button", { name: /salvar/i })).toBeDisabled();
  });
});
