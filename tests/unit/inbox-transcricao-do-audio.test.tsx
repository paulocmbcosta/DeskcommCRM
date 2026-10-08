import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { JANELA_DA_TRANSCRICAO_MS } from "@/lib/inbox/transcricao-do-audio";
import type { Message } from "@/lib/types/messaging";

/**
 * A TRANSCRIÇÃO NO BALÃO — montada pelo `MessageBubble`, que é por onde ela
 * chega à conversa, e não pelo componente solto: é o balão que decide não
 * desenhar mídia nenhuma numa mensagem apagada, e a transcrição tem de sumir
 * junto.
 *
 * O que este arquivo NÃO prova: que a rota entrega `media_derived_text` ao
 * componente. Isso é do invariante de `listMessagesHandler` (banco real) e do
 * spec de tela.
 */

const LONGA =
  "Bom dia, tudo bem? Eu estou ligando porque a minha internet caiu ontem à noite, " +
  "eu já tirei o aparelho da tomada, esperei uns minutos e liguei de novo, mas a luz " +
  "vermelha continua piscando. Queria saber se tem algum problema na minha rua ou se " +
  "vocês conseguem mandar um técnico ainda hoje, porque eu trabalho de casa.";

function audio(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "audio",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: null,
    media_url: null,
    media_mime: "audio/ogg",
    media_size_bytes: 1000,
    media_storage_path: "o1/c1/m1.ogg",
    media_derived_text: LONGA,
    media_derived_status: "ready",
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-07-21T20:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-07-21T20:00:00.000Z",
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Transcrição do áudio no balão", () => {
  it("mostra o começo do que o cliente falou, abaixo do player", () => {
    render(<MessageBubble message={audio()} />);
    expect(screen.getByRole("button", { name: /reproduzir áudio/i })).toBeInTheDocument();
    expect(screen.getByText("Transcrição automática")).toBeInTheDocument();
    const caixa = screen.getByTestId("transcricao-do-audio");
    expect(caixa).toHaveTextContent("Bom dia, tudo bem? Eu estou ligando");
    // O trecho, não o texto todo.
    expect(caixa).not.toHaveTextContent("porque eu trabalho de casa");
  });

  it("'Ler mais' abre o texto inteiro ali mesmo, e 'Ler menos' recolhe", () => {
    render(<MessageBubble message={audio()} />);
    const botao = screen.getByRole("button", { name: "Ler mais" });
    expect(botao).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(botao);
    expect(screen.getByTestId("transcricao-do-audio")).toHaveTextContent(LONGA);
    const recolher = screen.getByRole("button", { name: "Ler menos" });
    expect(recolher).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(recolher);
    expect(screen.getByTestId("transcricao-do-audio")).not.toHaveTextContent(
      "porque eu trabalho de casa",
    );
  });

  it("transcrição curta aparece inteira e sem botão", () => {
    render(<MessageBubble message={audio({ media_derived_text: "Oi, pode me ligar?" })} />);
    expect(screen.getByTestId("transcricao-do-audio")).toHaveTextContent("Oi, pode me ligar?");
    expect(screen.queryByRole("button", { name: "Ler mais" })).toBeNull();
  });

  it("áudio que acabou de chegar diz 'Transcrevendo…' — e para de dizer quando o prazo vence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:05.000Z"));
    render(
      <MessageBubble
        message={audio({
          media_derived_text: null,
          media_derived_status: null,
          created_at: "2026-10-08T12:00:00.000Z",
        })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Transcrevendo…");

    act(() => {
      vi.advanceTimersByTime(JANELA_DA_TRANSCRICAO_MS);
    });
    expect(screen.queryByTestId("transcricao-do-audio")).toBeNull();
    // O player continua lá: só a promessa saiu.
    expect(screen.getByRole("button", { name: /reproduzir áudio/i })).toBeInTheDocument();
  });

  it("quando o texto chega, ele toma o lugar do 'Transcrevendo…'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:05.000Z"));
    const pendente = audio({
      media_derived_text: null,
      media_derived_status: null,
      created_at: "2026-10-08T12:00:00.000Z",
    });
    const { rerender } = render(<MessageBubble message={pendente} />);
    expect(screen.getByTestId("transcricao-do-audio")).toHaveAttribute("data-estado", "transcrevendo");

    rerender(
      <MessageBubble
        message={{ ...pendente, media_derived_text: "Oi, pode me ligar?", media_derived_status: "ready" }}
      />,
    );
    expect(screen.getByTestId("transcricao-do-audio")).toHaveAttribute("data-estado", "texto");
    expect(screen.getByTestId("transcricao-do-audio")).toHaveTextContent("Oi, pode me ligar?");
  });

  it("falha de transcrição diz que está indisponível, sem inventar texto", () => {
    render(
      <MessageBubble message={audio({ media_derived_text: null, media_derived_status: "failed" })} />,
    );
    expect(screen.getByTestId("transcricao-do-audio")).toHaveTextContent("Transcrição indisponível");
    expect(screen.queryByText("Transcrição automática")).toBeNull();
  });

  it("áudio antigo sem transcrição: só o player, como sempre foi", () => {
    render(
      <MessageBubble message={audio({ media_derived_text: null, media_derived_status: null })} />,
    );
    expect(screen.getByRole("button", { name: /reproduzir áudio/i })).toBeInTheDocument();
    expect(screen.queryByTestId("transcricao-do-audio")).toBeNull();
  });

  it("mensagem apagada pelo cliente não mostra a transcrição", () => {
    render(<MessageBubble message={audio({ revoked_at: "2026-07-21T20:05:00.000Z" })} />);
    expect(screen.getByText("Esta mensagem foi apagada")).toBeInTheDocument();
    expect(screen.queryByTestId("transcricao-do-audio")).toBeNull();
    expect(screen.queryByText(/Bom dia, tudo bem/)).toBeNull();
  });
});
