import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/types/contacts";

import { ContactsTable } from "./ContactsTable";

/**
 * A PORTA DA LISTA DE CONTATOS — o relato de 2026-10-05.
 *
 * A atendente chamou um cliente em 25/09, encerrou, e em 01/10 quis chamá-lo de
 * novo. O ícone da linha, em vez de abrir "Chamar no WhatsApp", levou para a
 * conversa antiga: bastava o contato TER conversa para o diálogo sumir. De lá
 * só havia dois gestos — mandar modelo e "Reabrir" —, e os dois escrevem no
 * atendimento encerrado. O atendimento de 01/10 saiu com o protocolo de 25/09.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ cliente_pela_agenda: false }) }));
vi.mock("@/hooks/contacts/useDeleteContact", () => ({
  useDeleteContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const dialogo = vi.fn();
vi.mock("@/components/contacts/ChamarNoWhatsAppDialog", () => ({
  ChamarNoWhatsAppDialog: (props: Record<string, unknown>) => {
    dialogo(props);
    return <div data-testid="dialogo-de-chamar" />;
  },
}));

const contato = (id: string, conversa?: Contact["conversa"]): Contact =>
  ({
    id,
    organization_id: "org",
    name: `Cliente ${id}`,
    display_name: `Cliente ${id}`,
    email: null,
    phone_number: "+5561999990000",
    tags: [],
    is_anonymized: false,
    is_blocked: false,
    last_activity_at: null,
    first_service_at: null,
    conversa,
  }) as unknown as Contact;

const conversa = (status: string): NonNullable<Contact["conversa"]> => ({
  id: `conv-${status}`,
  preview: "oi",
  last_message_at: "2026-09-25T18:15:00Z",
  unread: 0,
  status,
  channel_session_id: "sessao-7232",
});

const pintar = (contatos: Contact[]) =>
  render(<ContactsTable contacts={contatos} orderBy="display_name" orderDir="asc" onSort={() => {}} />);

afterEach(() => {
  cleanup();
  dialogo.mockReset();
});

describe("o ícone de conversa da lista de contatos", () => {
  it("atendimento ENCERRADO: oferece chamar no WhatsApp, não a conversa que acabou", async () => {
    pintar([contato("a", conversa("closed"))]);

    expect(screen.queryByRole("link", { name: /Abrir conversa com/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Chamar no WhatsApp/ }));

    expect(screen.getByTestId("dialogo-de-chamar")).toBeTruthy();
    expect(dialogo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contactId: "a",
        // Chamar de novo sai, por padrão, pelo MESMO número do atendimento
        // anterior: é o número que o cliente conhece, e é a mesma conversa.
        conexaoInicial: "sessao-7232",
        atendimentoAnteriorEncerrado: true,
      }),
    );
  });

  it("atendimento EM ANDAMENTO: continua levando para a conversa — é lá que se responde", () => {
    pintar([contato("b", conversa("claimed"))]);

    const link = screen.getByRole("link", { name: /Abrir conversa com/ });
    expect(link.getAttribute("href")).toBe("/app/inbox?id=conv-claimed");
    expect(screen.queryByRole("button", { name: /Chamar no WhatsApp/ })).toBeNull();
  });

  it("sem conversa nenhuma: chamar, como sempre foi", async () => {
    pintar([contato("c")]);

    await userEvent.click(screen.getByRole("button", { name: /Chamar no WhatsApp/ }));

    expect(dialogo).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactId: "c", atendimentoAnteriorEncerrado: false }),
    );
  });
});
