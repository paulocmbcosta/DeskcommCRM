import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

import { FaixaDaEspera } from "./FaixaDaEspera";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const mutate = vi.fn();
let isPending = false;
vi.mock("@/hooks/inbox/useManterEspera", () => ({
  useManterEspera: () => ({ mutate, isPending }),
}));

let podeEscrever = true;
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => podeEscrever,
}));

const agora = new Date("2026-09-26T15:00:00Z");
const ha = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();

const base = {
  id: "c1",
  status: "claimed",
  assigned_to_user_id: "u1",
  assigned_to_user_name: "Ana",
  assignee_kind: "user",
  bot_silenced_until: "infinity",
  last_inbound_at: ha(6),
  last_outbound_at: ha(30),
  espera_desde: ha(6),
  espera_dispensada_ate: null,
  contacts: { id: "ct1", force_human: false, is_blocked: false },
} as unknown as ConversationWithContact;

const pintar = (mudancas: Record<string, unknown> = {}, props: { somenteLeitura?: boolean } = {}) =>
  render(
    <FaixaDaEspera conversa={{ ...base, ...mudancas } as ConversationWithContact} agora={agora} {...props} />,
  );

beforeEach(() => {
  mutate.mockReset();
  isPending = false;
  podeEscrever = true;
});
afterEach(() => cleanup());

describe("a faixa da espera no corpo do chat", () => {
  it("cliente esperando: diz há quanto tempo, na cor do termômetro", () => {
    pintar();
    const faixa = screen.getByTestId("faixa-da-espera");
    expect(faixa).toHaveTextContent("Cliente aguardando resposta há 6 min");
    expect(faixa).toHaveAttribute("data-nivel", "laranja");
    expect(screen.queryByRole("button", { name: "Contar mesmo assim" })).toBeNull();
  });

  it("a Assistente dispensou: diz por quê e oferece religar", async () => {
    pintar({ espera_desde: null, espera_dispensada_ate: ha(6) });
    expect(screen.getByTestId("faixa-da-espera-dispensada")).toHaveTextContent(
      "Assistente: o cliente só confirmou ou agradeceu — não pede resposta.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Contar mesmo assim" }));
    expect(mutate).toHaveBeenCalledWith("c1");
  });

  it("botão travado enquanto a religada está em curso", () => {
    isPending = true;
    pintar({ espera_desde: null, espera_dispensada_ate: ha(6) });
    expect(screen.getByRole("button", { name: "Contar mesmo assim" })).toBeDisabled();
  });

  it("no automático ou encerrada: nada", () => {
    const { container } = pintar({
      assigned_to_user_id: null,
      bot_silenced_until: null,
      espera_desde: null,
      espera_dispensada_ate: ha(6),
    });
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const r = pintar({ status: "closed" });
    expect(r.container).toBeEmptyDOMElement();
  });

  it("atendimento antigo (somente leitura): nada", () => {
    const { container } = pintar({}, { somenteLeitura: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("viewer ou suporte somente-leitura: mantém o texto, esconde o botão (receberia 403)", () => {
    podeEscrever = false;
    pintar({ espera_desde: null, espera_dispensada_ate: ha(6) });
    expect(screen.getByTestId("faixa-da-espera-dispensada")).toHaveTextContent(
      "Assistente: o cliente só confirmou ou agradeceu — não pede resposta.",
    );
    expect(screen.queryByRole("button", { name: "Contar mesmo assim" })).toBeNull();
  });
});
