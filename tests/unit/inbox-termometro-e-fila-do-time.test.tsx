import { readFileSync } from "node:fs";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * O TERMÔMETRO de espera e o selo "Na fila · <time>" no card (migration 0279).
 *
 * Pedido do dono (2026-09-24): ver de relance quem falou e ninguém respondeu —
 * amarelo aos 2 min, laranja aos 5, vermelho PULSANDO aos 10 — e quem foi para
 * um time e ninguém pegou. A régua é da organização; o padrão é 2/5/10.
 */
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const agora = new Date("2026-09-24T15:00:00Z");
const ha = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "claimed",
  assigned_to_user_id: "u1",
  assigned_to_user_name: "Ana",
  assignee_kind: "user",
  bot_silenced_until: "infinity",
  last_inbound_at: ha(1),
  last_outbound_at: ha(30),
  espera_desde: ha(1),
  last_message_at: ha(1),
  last_message_preview: "alguém aí?",
  unread_count_for_assignee: 1,
  created_at: ha(60),
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+5511", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

const pintar = (
  mudancas: Record<string, unknown>,
  props: Partial<React.ComponentProps<typeof ConversationListItem>> = {},
) =>
  render(
    <ConversationListItem
      conversation={{ ...base, ...mudancas } as ConversationWithContact}
      isSelected={false}
      onSelect={() => {}}
      agora={agora}
      {...props}
    />,
  );

afterEach(() => cleanup());

describe("o termômetro sobe pela régua (padrão 2 / 5 / 10 min)", () => {
  it.each([
    [1, "normal"],
    [3, "amarelo"],
    [7, "laranja"],
    [14, "vermelho"],
  ])("%d min sem resposta → %s", (min, nivel) => {
    pintar({ espera_desde: ha(min) });
    expect(screen.getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", nivel);
  });

  it("mede desde a PRIMEIRA mensagem sem resposta, não a última", () => {
    pintar({ espera_desde: ha(12), last_inbound_at: ha(1) });
    expect(screen.getByTestId("espera-da-conversa")).toHaveTextContent("Sem resposta há 12 min");
  });

  it("só o vermelho pulsa (a sirene)", () => {
    pintar({ espera_desde: ha(14) });
    expect(screen.getByTestId("espera-da-conversa").className).toContain("espera-sirene");
    cleanup();
    pintar({ espera_desde: ha(7) });
    expect(screen.getByTestId("espera-da-conversa").className).not.toContain("espera-sirene");
  });

  it("a régua da organização manda", () => {
    pintar({ espera_desde: ha(3) }, { regua: { amarelo_min: 1, laranja_min: 2, vermelho_min: 3 } });
    expect(screen.getByTestId("espera-da-conversa")).toHaveAttribute("data-nivel", "vermelho");
  });

  it("empresa respondeu: sem termômetro", () => {
    pintar({ espera_desde: null });
    expect(screen.queryByTestId("espera-da-conversa")).not.toBeInTheDocument();
  });

  it("no automático não há termômetro (a IA leva minutos para responder)", () => {
    pintar({
      espera_desde: ha(14),
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      assignee_kind: null,
      bot_silenced_until: null,
    }, { automaticoDaOrg: true });
    expect(screen.queryByTestId("espera-da-conversa")).not.toBeInTheDocument();
  });

  it("a sirene respeita quem desligou animação", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const bloco = css.slice(css.indexOf("@keyframes deskcomm-sirene"));
    expect(bloco).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.espera-sirene\s*\{\s*animation: none/);
  });
});

describe("o selo 'Na fila · <time>'", () => {
  const naFila = {
    team_id: "t-suporte",
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: null,
    bot_silenced_until: "infinity",
  };

  it("transferida para o time e ninguém pegou: selo com o nome do time", () => {
    pintar(naFila, { nomeDoTime: "Suporte", orgTemTimes: true });
    expect(screen.getByTestId("selo-na-fila-do-time")).toHaveTextContent("Na fila · Suporte");
  });

  it("alguém pegou: sem selo", () => {
    pintar({ ...naFila, assigned_to_user_id: "u1" }, { nomeDoTime: "Suporte", orgTemTimes: true });
    expect(screen.queryByTestId("selo-na-fila-do-time")).not.toBeInTheDocument();
  });

  it("sem time: sem selo (a fila geral tem a aba Fila)", () => {
    pintar({ ...naFila, team_id: null }, { nomeDoTime: null, orgTemTimes: true });
    expect(screen.queryByTestId("selo-na-fila-do-time")).not.toBeInTheDocument();
  });
});
