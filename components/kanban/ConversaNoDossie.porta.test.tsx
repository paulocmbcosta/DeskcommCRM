import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/types/contacts";

import { ConversaNoDossie } from "./ConversaNoDossie";

/**
 * A mesma porta da lista de contatos, na ficha do contato e na do negócio.
 * Ver `components/contacts/ContactsTable.porta.test.tsx` para o relato.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const dialogo = vi.fn();
vi.mock("@/components/contacts/ChamarNoWhatsAppDialog", () => ({
  ChamarNoWhatsAppDialog: (props: Record<string, unknown>) => {
    dialogo(props);
    return <div data-testid="dialogo-de-chamar" />;
  },
}));

const conversa = (status: string): NonNullable<Contact["conversa"]> => ({
  id: "conv-1",
  preview: "Prezado(a), tentamos entrar em contato",
  last_message_at: "2026-09-25T18:15:00Z",
  unread: 0,
  status,
  channel_session_id: "sessao-7232",
});

afterEach(() => {
  cleanup();
  dialogo.mockReset();
});

describe("a conversa na ficha — três estados, três portas", () => {
  it("atendimento ENCERRADO: oferece começar um novo E mantém o caminho para o histórico", async () => {
    render(<ConversaNoDossie conversa={conversa("closed")} contactId="contato-1" nome="MRV" telefone="+5561999990000" />);

    // O histórico continua a um clique: encerrado não é apagado.
    expect(screen.getByRole("link", { name: /Ver a conversa no Inbox/ }).getAttribute("href")).toBe(
      "/app/inbox?id=conv-1",
    );

    await userEvent.click(screen.getByRole("button", { name: /Chamar no WhatsApp/ }));

    expect(screen.getByTestId("dialogo-de-chamar")).toBeTruthy();
    expect(dialogo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contactId: "contato-1",
        conexaoInicial: "sessao-7232",
        atendimentoAnteriorEncerrado: true,
      }),
    );
  });

  it("atendimento EM ANDAMENTO: só a conversa — não se chama por fora de quem está atendendo", () => {
    render(<ConversaNoDossie conversa={conversa("open")} contactId="contato-1" nome="MRV" />);

    expect(screen.getByRole("link", { name: /Abrir conversa no Inbox/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chamar no WhatsApp/ })).toBeNull();
  });

  it("sem conversa: começar, como sempre foi", async () => {
    render(<ConversaNoDossie conversa={null} contactId="contato-1" nome="MRV" />);

    await userEvent.click(screen.getByRole("button", { name: /Chamar no WhatsApp/ }));

    expect(dialogo).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactId: "contato-1", atendimentoAnteriorEncerrado: false }),
    );
  });

  it("sem conversa e sem contato vinculado: não há nada a oferecer, e o bloco some", () => {
    const { container } = render(<ConversaNoDossie conversa={null} contactId={null} />);

    expect(container.innerHTML).toBe("");
  });

  it("encerrado e sem contato vinculado: não há a quem escrever, fica só o histórico", () => {
    render(<ConversaNoDossie conversa={conversa("closed")} contactId={null} />);

    expect(screen.getByRole("link", { name: /Ver a conversa no Inbox/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chamar no WhatsApp/ })).toBeNull();
  });
});
