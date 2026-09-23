import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationList } from "./ConversationList";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({
  useTimesDoInbox: () => ({ data: [
    { id: "time-a", name: "Cobrança", archived: false },
    { id: "time-b", name: "Suporte", archived: false },
  ] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));

const conversa = (id: string, team_id: string | null) => ({
  id,
  organization_id: "org",
  contact_id: id,
  channel_session_id: "canal",
  channel: "whatsapp",
  team_id,
  status: "open",
  last_message_at: "2026-09-22T12:00:00Z",
  last_message_preview: "Olá",
  unread_count_for_assignee: 0,
  created_at: "2026-09-22T12:00:00Z",
  contacts: { id, display_name: id, name: id, phone_number: null, tags: [], is_blocked: false, is_anonymized: false },
}) as unknown as ConversationWithContact;

function pintar(agruparPorTime: boolean, onFiltrarTime = vi.fn(), erroNasContagens = false) {
  const data = { pages: [{ data: [conversa("cliente-geral", null), conversa("cliente-cobranca", "time-a")], meta: { has_more: true } }] };
  const listQuery = {
    data, isLoading: false, isError: false, hasNextPage: true,
    isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn(),
  } as never;
  render(<ConversationList
    listQuery={listQuery}
    filters={{ exclude_finished: true }}
    selectedId={null}
    onSelect={() => undefined}
    agruparPorTime={agruparPorTime}
    contagensPorTime={[
      { team_id: "time-a", name: "Cobrança", count: 60 },
      { team_id: "time-b", name: "Suporte", count: 1 },
      { team_id: null, name: null, count: 3 },
    ]}
    onFiltrarTime={onFiltrarTime}
    erroNasContagens={erroNasContagens}
    onRecarregarContagens={vi.fn()}
  />);
  return onFiltrarTime;
}

afterEach(() => cleanup());

describe("Todas por time", () => {
  it("mostra contagens exatas, inclusive de grupos ainda fora da página carregada", async () => {
    const filtrar = pintar(true);
    expect(screen.getByRole("button", { name: "Filtrar por time: Cobrança" })).toHaveTextContent("60");
    expect(screen.getByRole("button", { name: "Filtrar por time: Suporte" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Filtrar por time: Sem time" })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: "Carregar mais" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filtrar por time: Suporte" }));
    expect(filtrar).toHaveBeenCalledWith("time-b");
  });

  it("o grupo sem time aplica o filtro de fila geral", async () => {
    const filtrar = pintar(true);
    await userEvent.click(screen.getByRole("button", { name: "Filtrar por time: Sem time" }));
    expect(filtrar).toHaveBeenCalledWith("none");
  });

  it("as outras abas mantêm a lista sem cabeçalhos de time", () => {
    pintar(false);
    expect(screen.queryByRole("button", { name: /Filtrar por time: (Cobrança|Suporte|Sem time)/ })).not.toBeInTheDocument();
  });

  it("avisa quando não pode confirmar a contagem, sem inventar um número", () => {
    pintar(true, vi.fn(), true);
    expect(screen.getByText("Não foi possível carregar o volume por time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filtrar por time: Cobrança" })).not.toHaveTextContent("60");
  });
});
