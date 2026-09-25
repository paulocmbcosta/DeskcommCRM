/**
 * O SELETOR DE FILA POR TIME — o que ele mostra, e quando ele NÃO existe.
 *
 * Duas coisas que só um teste de tela alcança:
 *
 *  1. Numa instalação sem setor nenhum, o seletor não é desenhado. A barra do
 *     inbox já tem busca, não-lidos, número e etiqueta numa coluna de 280px;
 *     um controle a mais que responde sempre a mesma coisa é imposto cobrado de
 *     quem não usa a feature.
 *  2. "Fila geral" e "Meus times" são OPÇÕES, e não a ausência do filtro. Sem
 *     elas não haveria como pedir "o que ninguém encaminhou" — a ausência do
 *     parâmetro significa "não filtre", que é outra pergunta.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { TimeDoInbox } from "@/hooks/inbox/useTimesDoInbox";

const timesRef: { current: TimeDoInbox[] | undefined } = { current: [] };

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "agent", visibility_mode: "all" } }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: undefined }),
}));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({
  useTimesDoInbox: () => ({ data: timesRef.current }),
}));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

function time(over: Partial<TimeDoInbox> = {}): TimeDoInbox {
  return {
    id: "t-1",
    name: "Financeiro",
    slug: "financeiro",
    description: "",
    aberto_agora: true,
    horario_invalido: false,
    archived: false,
    pode_iniciar: true,
    ...over,
  };
}

/**
 * O jsdom não tem a API de captura de ponteiro, e o `Select` do Radix a usa para
 * abrir. Sem estes três stubs o teste falha com `hasPointerCapture is not a
 * function` — um defeito do AMBIENTE, que se lê como defeito do componente.
 */
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  timesRef.current = [];
});

describe("o seletor de fila por time", () => {
  it("não existe numa organização sem times", () => {
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} />);
    expect(screen.queryByLabelText("Filtrar por time")).toBeNull();
  });

  it("continua não existindo quando o único time está arquivado", () => {
    // Arquivado não recebe conversa nova: oferecê-lo como fila seria oferecer um
    // setor que ninguém mais atende.
    timesRef.current = [time({ archived: true })];
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} />);
    expect(screen.queryByLabelText("Filtrar por time")).toBeNull();
  });

  it("aparece com time cadastrado e oferece as duas filas que não são time", async () => {
    timesRef.current = [time(), time({ id: "t-2", name: "Suporte", aberto_agora: false })];
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} />);
    const gatilho = screen.getByLabelText("Filtrar por time");
    await userEvent.click(gatilho);
    expect(screen.getByText("Meus times")).toBeTruthy();
    expect(screen.getByText("Fila geral (sem time)")).toBeTruthy();
    expect(screen.getByText("Financeiro")).toBeTruthy();
    // O estado do setor aparece na PRÓPRIA linha: quem escolhe uma fila precisa
    // saber que está entrando na fila de um setor que não está atendendo.
    expect(screen.getByText("Suporte")).toBeTruthy();
    expect(screen.getAllByText(/fechado agora/).length).toBeGreaterThan(0);
  });

  it("escolher um time propaga `team_id` para quem é dono do estado", async () => {
    // É a metade da cadeia que o typecheck não pega: com a opção na tela e sem
    // esta propagação, o seletor mudaria de rótulo e a lista continuaria inteira.
    timesRef.current = [time()];
    const onChange = vi.fn();
    render(<InboxFilters aberto value={VALUE} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Filtrar por time"));
    await userEvent.click(screen.getByText("Financeiro"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ team_id: "t-1" }));
  });

  it("voltar para `Todas as filas` tira o filtro — e não manda a string 'all'", async () => {
    timesRef.current = [time()];
    const onChange = vi.fn();
    render(<InboxFilters aberto value={{ ...VALUE, team_id: "t-1" }} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Filtrar por time"));
    await userEvent.click(screen.getAllByText("Todas as filas")[0]!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ team_id: undefined }));
  });
});
