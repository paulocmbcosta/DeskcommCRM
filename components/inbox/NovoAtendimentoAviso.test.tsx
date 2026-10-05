import { readFileSync } from "node:fs";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NovoAtendimentoAviso } from "./NovoAtendimentoAviso";

/**
 * O PÉ DA CONVERSA ENCERRADA.
 *
 * Medido em produção em 2026-10-05: com a conversa encerrada o campo de texto
 * trava, mas o seletor de modelo aprovado continuava ali — e o que saía por ele
 * era gravado no atendimento ENCERRADO. 53 mensagens em 48 conversas desde
 * 19/09: 32 seguidas de "Reabrir" (o mesmo protocolo de dias atrás), 13 que
 * ficaram dentro do atendimento fechado, 8 em que o cliente respondeu e a
 * resposta caiu no rodízio, sem dono.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const dialogo = vi.fn();
vi.mock("@/components/contacts/ChamarNoWhatsAppDialog", () => ({
  ChamarNoWhatsAppDialog: (props: { onIniciada?: (id: string) => void }) => {
    dialogo(props);
    return (
      <button type="button" data-testid="dialogo-de-chamar" onClick={() => props.onIniciada?.("conv-nova")}>
        enviar
      </button>
    );
  },
}));

afterEach(() => {
  cleanup();
  dialogo.mockReset();
});

describe("conversa encerrada: o caminho para falar de novo é um atendimento NOVO", () => {
  it("diz que o atendimento acabou e abre o diálogo pelo número DESTA conversa", async () => {
    const onIniciada = vi.fn();
    render(
      <NovoAtendimentoAviso
        contactId="contato-1"
        nome="MRV"
        telefone="+5561999990000"
        conexaoId="sessao-7232"
        onIniciada={onIniciada}
      />,
    );

    expect(screen.getByText(/Este atendimento foi encerrado/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Chamar no WhatsApp" }));

    expect(dialogo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contactId: "contato-1",
        conexaoInicial: "sessao-7232",
        atendimentoAnteriorEncerrado: true,
      }),
    );

    // O Inbox já está aberto: quem leva para o atendimento novo é ele, não uma
    // navegação — por isso o aviso repassa o id em vez de trocar de página.
    await userEvent.click(screen.getByTestId("dialogo-de-chamar"));
    expect(onIniciada).toHaveBeenCalledWith("conv-nova");
  });
});

describe("o Inbox não oferece mais mandar modelo DENTRO do atendimento encerrado", () => {
  const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");

  it("o seletor de modelo só aparece com a conversa em andamento", () => {
    expect(fonte, "o seletor de modelo voltou a aparecer na conversa encerrada").toMatch(
      /motivoDaJanela && !conversaJaEncerrada && \(\s*<JanelaFechadaAviso/,
    );
  });

  it("no lugar dele, a conversa encerrada oferece o atendimento novo", () => {
    expect(fonte).toMatch(/podeChamarDeNovo && \(\s*<NovoAtendimentoAviso/);
  });
});
