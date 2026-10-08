/**
 * OS SELETORES QUE O FUNIL GANHOU — atendente, caixa de entrada, período e assunto.
 *
 * O que este arquivo prende é o que não aparece em typecheck nem numa olhada na
 * tela com dados "normais":
 *   · em que ABA cada seletor existe (um seletor numa aba onde o filtro não
 *     vale é um controle que não faz nada);
 *   · que a escolha chega a quem é dono do estado, com o campo certo;
 *   · que um filtro ligado nunca fica sem linha no seletor (o "órfão").
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { OpcoesDosFiltros } from "@/lib/inbox/opcoes-dos-filtros";
import { hojeComoData } from "@/lib/inbox/periodo";

const authRef: { current: { role: string; userId: string } } = {
  current: { role: "manager", userId: "u-eu" },
};

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", role: authRef.current.role, visibility_mode: "all" },
    user: { id: authRef.current.userId },
  }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({ useTimesDoInbox: () => ({ data: [] }) }));

const ANA = "22222222-2222-4222-8222-222222222222";
const ZAP_1 = "11111111-1111-4111-8111-111111111111";
const ZAP_2 = "11111111-1111-4111-8111-111111111112";
const FONE = "11111111-1111-4111-8111-111111111113";
const ASSUNTO = "33333333-3333-4333-8333-333333333333";

const OPCOES: OpcoesDosFiltros = {
  atendentes: [
    { user_id: "u-eu", nome: "Quem Olha", ativo: true },
    { user_id: ANA, nome: "Ana", ativo: true },
    { user_id: "u-zeca", nome: "Zeca", ativo: false },
  ],
  caixas: [
    { id: ZAP_1, meio: "whatsapp", nome: "Comercial", numero: "5511999990001" },
    { id: ZAP_2, meio: "whatsapp", nome: "Suporte", numero: "5511999990002" },
    { id: FONE, meio: "phone", nome: "Tronco", numero: "551136861503" },
  ],
  assuntos: [
    {
      time_id: "t-fin",
      time: "Financeiro",
      assuntos: [
        { id: ASSUNTO, nome: "Segunda via", arquivado: false },
        { id: "a-velho", nome: "Cancelamento", arquivado: true },
      ],
    },
  ],
};

const valor = (over: Partial<InboxFiltersValue> = {}): InboxFiltersValue => ({
  tab: "all",
  search: "",
  onlyUnread: false,
  ...over,
});

/** `null` = as opções ainda não chegaram (um `undefined` aqui cairia no valor padrão). */
function montar(over: Partial<InboxFiltersValue> = {}, opcoes: OpcoesDosFiltros | null = OPCOES) {
  const onChange = vi.fn();
  render(<InboxFilters aberto value={valor(over)} onChange={onChange} opcoes={opcoes ?? undefined} />);
  return onChange;
}

// O Select do Radix usa APIs de ponteiro e de rolagem que o jsdom não tem.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  authRef.current = { role: "manager", userId: "u-eu" };
});

describe("o seletor de ATENDENTE", () => {
  it.each(["all", "closed"] as const)("existe em %s", (tab) => {
    montar({ tab });
    expect(screen.getByLabelText("Filtrar por atendente")).toBeTruthy();
  });

  it.each(["mine", "unassigned", "ai"] as const)(
    "NÃO existe em %s — Minhas já é \"eu\", e Fila e Automático não têm atendente",
    (tab) => {
      montar({ tab });
      expect(screen.queryByLabelText("Filtrar por atendente")).toBeNull();
    },
  );

  it("⭐ oferece Eu, Sem atendente e os colegas — quem saiu continua, marcado", async () => {
    montar();
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    expect(screen.getByText("Eu")).toBeTruthy();
    expect(screen.getByText("Sem atendente")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getByText("Zeca")).toBeTruthy();
    expect(screen.getByText(/saiu/)).toBeTruthy();
    // Quem está olhando não aparece duas vezes: já é o "Eu".
    expect(screen.queryByText("Quem Olha")).toBeNull();
  });

  it("escolher um colega propaga `assigned_to` com o id dele", async () => {
    const onChange = montar();
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    await userEvent.click(screen.getByText("Ana"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assigned_to: ANA }));
  });

  it("\"Eu\" e \"Sem atendente\" propagam os valores que a API entende", async () => {
    const onChange = montar();
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    await userEvent.click(screen.getByText("Eu"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ assigned_to: "me" }));
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    await userEvent.click(screen.getByText("Sem atendente"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ assigned_to: "unassigned" }));
  });

  it("voltar para \"Todos os atendentes\" tira o filtro — e não manda a string 'all'", async () => {
    const onChange = montar({ assigned_to: ANA });
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    await userEvent.click(screen.getAllByText("Todos os atendentes")[0]!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assigned_to: undefined }));
  });

  it("o observador não atende: para ele não existe \"Eu\", e ele se vê pelo nome", async () => {
    authRef.current = { role: "viewer", userId: "u-eu" };
    montar();
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    expect(screen.queryByText("Eu")).toBeNull();
    expect(screen.getByText("Sem atendente")).toBeTruthy();
  });

  it("quem não vê colegas recebe a lista vazia do servidor: sobram Eu e Sem atendente", async () => {
    montar({}, { ...OPCOES, atendentes: [] });
    await userEvent.click(screen.getByLabelText("Filtrar por atendente"));
    expect(screen.getByText("Eu")).toBeTruthy();
    expect(screen.getByText("Sem atendente")).toBeTruthy();
    expect(screen.queryByText("Ana")).toBeNull();
  });

  it("⭐ atendente escolhido que saiu da lista NÃO some: aparece como removido", () => {
    // Sem a linha órfã o seletor mostraria "Todos os atendentes" com o filtro
    // AINDA aplicado — a lista num subconjunto e nada dizendo por quê.
    montar({ assigned_to: "99999999-9999-4999-8999-999999999999" });
    expect(screen.getByLabelText("Filtrar por atendente").textContent).toContain("Atendente removido");
  });

  it("enquanto as opções não chegam, o nome ainda não é conhecido — e \"removido\" seria mentira", () => {
    montar({ assigned_to: ANA }, null);
    const gatilho = screen.getByLabelText("Filtrar por atendente").textContent ?? "";
    expect(gatilho).toContain("Carregando…");
    expect(gatilho).not.toContain("removido");
  });
});

describe("o seletor de CAIXA DE ENTRADA", () => {
  it("⭐ mostra cada meio; os números aparecem só no meio que tem mais de um", async () => {
    montar();
    await userEvent.click(screen.getByLabelText("Filtrar por caixa de entrada"));
    expect(screen.getByText("WhatsApp")).toBeTruthy();
    expect(screen.getByText("Telefone")).toBeTruthy();
    expect(screen.getByText(/Comercial/)).toBeTruthy();
    expect(screen.getByText(/Suporte/)).toBeTruthy();
    // O telefone tem UM número: meio e número são a mesma lista.
    expect(screen.queryByText(/Tronco/)).toBeNull();
    // Meio que a organização não tem não é oferecido.
    expect(screen.queryByText("Chat do site")).toBeNull();
  });

  it("escolher o MEIO grava `channel` e apaga o número", async () => {
    const onChange = montar({ channel_session_id: ZAP_1 });
    await userEvent.click(screen.getByLabelText("Filtrar por caixa de entrada"));
    await userEvent.click(screen.getByText("Telefone"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "phone", channel_session_id: undefined }),
    );
  });

  it("escolher um NÚMERO grava `channel_session_id` e apaga o meio", async () => {
    const onChange = montar({ channel: "phone" });
    await userEvent.click(screen.getByLabelText("Filtrar por caixa de entrada"));
    await userEvent.click(screen.getByText(/Suporte/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ channel: undefined, channel_session_id: ZAP_2 }),
    );
  });

  it("\"Todas as caixas\" tira os dois", async () => {
    const onChange = montar({ channel: "phone" });
    await userEvent.click(screen.getByLabelText("Filtrar por caixa de entrada"));
    await userEvent.click(screen.getAllByText("Todas as caixas")[0]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ channel: undefined, channel_session_id: undefined }),
    );
  });

  it("com uma caixa só e nenhum filtro de caixa, o seletor não existe", () => {
    montar({}, { ...OPCOES, caixas: [OPCOES.caixas[0]!] });
    expect(screen.queryByLabelText("Filtrar por caixa de entrada")).toBeNull();
  });

  it("dois números do MESMO meio já bastam para ele existir", () => {
    montar({}, { ...OPCOES, caixas: OPCOES.caixas.slice(0, 2) });
    expect(screen.getByLabelText("Filtrar por caixa de entrada")).toBeTruthy();
  });

  it("⭐ com filtro de caixa ligado ele existe mesmo sem opções — é por onde se tira o filtro", () => {
    montar({ channel: "site_chat" }, { ...OPCOES, caixas: [] });
    // E mostra o meio escolhido, embora a organização não tenha mais número dele.
    expect(screen.getByLabelText("Filtrar por caixa de entrada").textContent).toContain("Chat do site");
  });

  it("número escolhido que foi removido aparece como removido", () => {
    montar({ channel_session_id: "99999999-9999-4999-8999-999999999999" });
    expect(screen.getByLabelText("Filtrar por caixa de entrada").textContent).toContain("Número removido");
  });

  it("o número do meio que tem um só continua tendo linha quando é ELE o filtro", () => {
    // Vindo de um link antigo: `channel_session_id` do único tronco de telefone.
    montar({ channel_session_id: FONE });
    expect(screen.getByLabelText("Filtrar por caixa de entrada").textContent).toContain("Tronco");
  });
});

describe("PERÍODO e ASSUNTO só existem em Fechadas", () => {
  it.each(["all", "mine", "unassigned", "ai"] as const)("em %s não existem", (tab) => {
    montar({ tab });
    expect(screen.queryByLabelText("Filtrar por período")).toBeNull();
    expect(screen.queryByLabelText("Filtrar por assunto")).toBeNull();
  });

  it("em Fechadas existem os dois", () => {
    montar({ tab: "closed" });
    expect(screen.getByLabelText("Filtrar por período")).toBeTruthy();
    expect(screen.getByLabelText("Filtrar por assunto")).toBeTruthy();
  });

  it("escolher \"Hoje\" grava a ESCOLHA, não as datas — o link tem de valer amanhã", async () => {
    const onChange = montar({ tab: "closed" });
    await userEvent.click(screen.getByLabelText("Filtrar por período"));
    await userEvent.click(screen.getByText("Hoje"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ periodo: "hoje", de: undefined, ate: undefined }),
    );
  });

  it("⭐ \"Escolher datas…\" nasce com hoje nas duas pontas — nunca com uma data só", async () => {
    const onChange = montar({ tab: "closed" });
    await userEvent.click(screen.getByLabelText("Filtrar por período"));
    await userEvent.click(screen.getByText("Escolher datas…"));
    const hoje = hojeComoData();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ periodo: undefined, de: hoje, ate: hoje }),
    );
  });

  it("os dois campos de data só aparecem com datas escolhidas", () => {
    montar({ tab: "closed", periodo: "hoje" });
    expect(screen.queryByLabelText("De")).toBeNull();
    cleanup();
    montar({ tab: "closed", de: "2026-10-01", ate: "2026-10-03" });
    expect((screen.getByLabelText("De") as HTMLInputElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("Até") as HTMLInputElement).value).toBe("2026-10-03");
  });

  it("mexer no começo para depois do fim PUXA o fim junto", () => {
    const onChange = montar({ tab: "closed", de: "2026-10-01", ate: "2026-10-03" });
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "2026-10-05" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ de: "2026-10-05", ate: "2026-10-05" }));
  });

  it("mexer no fim para antes do começo puxa o começo", () => {
    const onChange = montar({ tab: "closed", de: "2026-10-03", ate: "2026-10-05" });
    fireEvent.change(screen.getByLabelText("Até"), { target: { value: "2026-10-01" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ de: "2026-10-01", ate: "2026-10-01" }));
  });

  it("apagar uma data no campo não produz meio período", () => {
    const onChange = montar({ tab: "closed", de: "2026-10-01", ate: "2026-10-03" });
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("\"Qualquer data\" limpa a escolha e as datas", async () => {
    const onChange = montar({ tab: "closed", de: "2026-10-01", ate: "2026-10-03" });
    await userEvent.click(screen.getByLabelText("Filtrar por período"));
    await userEvent.click(screen.getAllByText("Qualquer data")[0]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ periodo: undefined, de: undefined, ate: undefined }),
    );
  });

  it("o assunto vem agrupado por time, e o arquivado continua, marcado", async () => {
    const onChange = montar({ tab: "closed" });
    await userEvent.click(screen.getByLabelText("Filtrar por assunto"));
    expect(screen.getByText("Financeiro")).toBeTruthy();
    expect(screen.getByText("Cancelamento")).toBeTruthy();
    expect(screen.getByText(/arquivado/)).toBeTruthy();
    await userEvent.click(screen.getByText("Segunda via"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assunto_id: ASSUNTO }));
  });

  it("organização sem assunto cadastrado não ganha um seletor que leva a uma lista vazia", () => {
    montar({ tab: "closed" }, { ...OPCOES, assuntos: [] });
    expect(screen.queryByLabelText("Filtrar por assunto")).toBeNull();
    // O período não depende de cadastro nenhum.
    expect(screen.getByLabelText("Filtrar por período")).toBeTruthy();
  });
});

describe("o número no funil", () => {
  const selo = () => screen.getByTestId("inbox-abrir-filtros").textContent ?? "";

  it("conta os filtros do funil que valem NESTA aba", () => {
    montar({ tab: "closed", assigned_to: "me", channel: "phone", periodo: "hoje", assunto_id: ASSUNTO });
    expect(selo()).toBe("4");
  });

  it("⭐ o período ligado não conta em Todas: ali ele não é aplicado", () => {
    montar({ tab: "all", periodo: "hoje", assunto_id: ASSUNTO });
    expect(selo()).toBe("");
  });

  it("o atendente ligado não conta em Minhas", () => {
    montar({ tab: "mine", assigned_to: ANA });
    expect(selo()).toBe("");
  });

  it("CONTROLE: sem filtro, sem número", () => {
    montar();
    expect(selo()).toBe("");
  });
});
