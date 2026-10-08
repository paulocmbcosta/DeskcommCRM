/**
 * G4-02 — Inbox com escopo (acceptance 1 e 4). Prova que a visão 'Todas' é
 * ocultada para `agent` em modo own* e visível para manager/admin/viewer, e que
 * as contagens por visão são renderizadas a partir do hook RLS-scoped
 * (useConversationCounts → /api/v1/conversations/counts, client user-scoped).
 *
 * A garantia REAL de escopo (agent forçando ?filter=all não vaza) é da RLS —
 * provada em tests/invariants/gov-5b-inbox-scope-counts.test.ts (contagem sob a
 * role agent = escopo, não total da org). Aqui é a superfície de UI.
 *
 * O segundo bloco cobre o SELETOR DE NÚMERO, que ganhou comportamento quando o
 * canal excluído sumiu da listagem: o alternador some com o penúltimo número, e
 * some junto com ele o único controle capaz de desfazer um filtro que continua
 * valendo — inbox filtrado, às vezes vazio, sem nada na tela dizendo por quê.
 *
 * As ABAS saíram do `InboxFilters` para o trilho `InboxAbas` (a faixa horizontal
 * tomava a altura da lista), e os SELETORES passaram a viver recolhidos atrás do
 * funil. Os casos abaixo medem a MESMA coisa de antes, no componente que hoje a
 * desenha: as abas no trilho, os seletores com o painel aberto (`aberto`). O
 * bloco do fim prova o que o recolhimento não pode fazer — esconder um filtro
 * que está valendo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InboxAbas } from "@/components/inbox/InboxAbas";
import { InboxFilters, visibleInboxTabs, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";
import type { CaixaDeEntrada, OpcoesDosFiltros } from "@/lib/inbox/opcoes-dos-filtros";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
/**
 * As caixas de entrada que o funil recebe por prop (`opcoes`, lidas no
 * `InboxLayout` de `GET /conversations/filtros`). `undefined` = a leitura ainda
 * não chegou (ou falhou) — não é "zero caixas".
 */
const caixasRef: { current: CaixaDeEntrada[] | undefined } = { current: [] };
/** O `opcoes` que o `InboxLayout` entregaria para as caixas de agora. */
const opcoes = (): OpcoesDosFiltros | undefined =>
  caixasRef.current === undefined
    ? undefined
    : { atendentes: [], caixas: caixasRef.current, assuntos: [] };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
/** `undefined` = vocabulário ainda carregando — não é "zero etiquetas". */
const tagsRef: { current: string[] | undefined } = { current: [] };
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: tagsRef.current }),
}));
/**
 * As contagens que o trilho recebe por prop. Ele deixou de chamar
 * `useConversationCounts` por conta própria: lia com os PRÓPRIOS parâmetros, e o
 * selo de "Todas" discordava da lista que o `InboxLayout` montava com outros.
 */
const CONTAGENS = { unassigned: 3, mine: 2, all: 5 };

// O seletor de fila por TIME (migration 0263) lê o catálogo por react-query, e
// este arquivo renderiza `InboxFilters` sem QueryClientProvider. Sem o dublê, o
// hook levanta "No QueryClient set" e o teste morre por um motivo que não é o
// dele. Org sem time nenhum: o seletor nem chega a ser desenhado.
vi.mock("@/hooks/inbox/useTimesDoInbox", () => ({
  useTimesDoInbox: () => ({ data: [] }),
}));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

function setOrg(role: ActiveOrg["role"], visibility_mode: ActiveOrg["visibility_mode"]) {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role, visibility_mode };
}

function canal(over: Partial<CaixaDeEntrada> = {}): CaixaDeEntrada {
  return { id: "canal-1", meio: "whatsapp", nome: "Vendas", numero: "5511999999999", ...over };
}

const SELETOR = "Filtrar por caixa de entrada";

beforeEach(() => {
  setOrg("agent", "own_and_unassigned");
  caixasRef.current = [];
});
afterEach(cleanup);

describe("visibleInboxTabs (lógica pura de visões)", () => {
  it("agent em own_and_unassigned NÃO vê 'all'", () => {
    expect(visibleInboxTabs("agent", "own_and_unassigned")).not.toContain("all");
  });
  it("agent em 'own' NÃO vê 'all'", () => {
    expect(visibleInboxTabs("agent", "own")).not.toContain("all");
  });
  it("agent em 'all' VÊ 'all'", () => {
    expect(visibleInboxTabs("agent", "all")).toContain("all");
  });
  it("agent em 'own_and_team' VÊ 'all' — é onde mora a conversa do colega de time", () => {
    expect(visibleInboxTabs("agent", "own_and_team")).toContain("all");
  });
  it("agent em 'own_and_team_queue' NÃO vê 'all'", () => {
    expect(visibleInboxTabs("agent", "own_and_team_queue")).not.toContain("all");
  });
  it("manager sempre vê 'all' (org-wide read)", () => {
    expect(visibleInboxTabs("manager", "own")).toContain("all");
  });
  it("viewer sempre vê 'all' (org-wide read)", () => {
    expect(visibleInboxTabs("viewer", "own")).toContain("all");
  });
  it("admin sempre vê 'all'", () => {
    expect(visibleInboxTabs("admin", "own")).toContain("all");
  });
  it("as 3 visões nomeadas existem (Minhas/Fila/Todas) para manager", () => {
    const tabs = visibleInboxTabs("manager", "own_and_unassigned");
    expect(tabs).toEqual(expect.arrayContaining(["mine", "unassigned", "all"]));
  });

  // A aba Telefone (migration 0295) lista LIGAÇÕES, e só existe onde há telefone.
  const PAPEIS = ["viewer", "agent", "manager", "admin"] as const;

  it.each(PAPEIS)("sem telefonia na organização, %s NÃO vê 'phone'", (papel) => {
    // Sem a opção e com ela desligada: os dois são "não há telefone aqui".
    expect(visibleInboxTabs(papel, "all")).not.toContain("phone");
    expect(visibleInboxTabs(papel, "all", { telefone: false })).not.toContain("phone");
  });

  it.each(PAPEIS)("com telefonia, %s VÊ 'phone' — inclusive quem não tem ramal", (papel) => {
    expect(visibleInboxTabs(papel, "own", { telefone: true })).toContain("phone");
  });

  it("a aba Telefone não muda a regra de 'Todas', e entra por último", () => {
    expect(visibleInboxTabs("agent", "own", { telefone: true })).not.toContain("all");
    expect(visibleInboxTabs("manager", "own", { telefone: true })).toEqual([
      ...visibleInboxTabs("manager", "own"),
      "phone",
    ]);
  });
});

describe("InboxAbas render — 3 visões + escopo", () => {
  it("agent em modo own*: mostra Minhas e Fila, esconde Todas", () => {
    setOrg("agent", "own_and_unassigned");
    render(<InboxAbas value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Minhas/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Fila/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Todas/ })).not.toBeInTheDocument();
  });

  it("manager: mostra Todas", () => {
    setOrg("manager", "own_and_unassigned");
    render(<InboxAbas value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Todas/ })).toBeInTheDocument();
  });

  it("contagens por visão são renderizadas (Fila=3, Minhas=2)", () => {
    setOrg("manager", "all");
    render(<InboxAbas value={VALUE} onChange={() => {}} contagens={CONTAGENS} />);
    expect(screen.getByRole("tab", { name: /Fila/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /Minhas/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /Todas/ })).toHaveTextContent("5");
  });

  it("com a telefonia ligada, o trilho ganha a aba Telefone com o selo de quem espera", () => {
    setOrg("agent", "own_and_unassigned");
    render(
      <InboxAbas
        value={VALUE}
        onChange={() => {}}
        contagens={CONTAGENS}
        telefone={{ ativa: true, esperando: 3 }}
      />,
    );
    expect(screen.getByRole("tab", { name: "Telefone" })).toHaveTextContent("3");
    // As outras seguem como estavam: a aba nova não desloca nem esconde nenhuma.
    expect(screen.getByRole("tab", { name: /Fila/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /Minhas/ })).toHaveTextContent("2");
    expect(screen.queryByRole("tab", { name: /Todas/ })).not.toBeInTheDocument();
  });

  it("ninguém esperando: a aba Telefone aparece sem selo", () => {
    setOrg("manager", "all");
    render(<InboxAbas value={VALUE} onChange={() => {}} telefone={{ ativa: true, esperando: 0 }} />);
    expect(screen.getByRole("tab", { name: "Telefone" })).toHaveTextContent("");
  });

  it("sem a prop, ou com a telefonia desligada, a aba Telefone NÃO aparece", () => {
    setOrg("manager", "all");
    render(<InboxAbas value={VALUE} onChange={() => {}} />);
    expect(screen.queryByRole("tab", { name: "Telefone" })).not.toBeInTheDocument();
    cleanup();
    // `esperando` com a telefonia desligada não desenha aba nenhuma: o selo é
    // da aba, e sem aba não há onde ele aparecer.
    render(<InboxAbas value={VALUE} onChange={() => {}} telefone={{ ativa: false, esperando: 2 }} />);
    expect(screen.queryByRole("tab", { name: "Telefone" })).not.toBeInTheDocument();
  });
});

describe("InboxFilters — seletor de caixa de entrada e o filtro órfão", () => {
  it("um número só: não há o que alternar, o seletor não aparece", () => {
    setOrg("manager", "all");
    caixasRef.current = [canal()];
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} opcoes={opcoes()} />);
    expect(screen.queryByLabelText(SELETOR)).not.toBeInTheDocument();
  });

  it("dois números: o seletor aparece com os dois", () => {
    setOrg("manager", "all");
    caixasRef.current = [canal(), canal({ id: "canal-2", nome: "Suporte" })];
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} opcoes={opcoes()} />);
    expect(screen.getByLabelText(SELETOR)).toBeInTheDocument();
  });

  /**
   * ⭐ O caso que o canal excluído criou: sobrou UM número, o filtro aponta para
   * o que sumiu. Pela regra dos "2+" o seletor sumiria levando junto o único
   * jeito de voltar para "Todos os números" — e o inbox seguiria filtrado,
   * possivelmente vazio, sem nada na tela explicando.
   */
  it("filtro aponta para número que saiu da lista: o seletor FICA e nomeia o número removido", () => {
    setOrg("manager", "all");
    caixasRef.current = [canal()];
    render(
      <InboxFilters
        aberto
        value={{ ...VALUE, channel_session_id: "canal-excluido" }}
        onChange={() => {}}
        opcoes={opcoes()}
      />,
    );
    const seletor = screen.getByLabelText(SELETOR);
    expect(seletor).toBeInTheDocument();
    expect(seletor).toHaveTextContent("Número removido");
  });

  /**
   * O MESMO tratamento, agora para a etiqueta.
   *
   * O canal já tinha: filtro apontando para algo fora da lista mantinha o seletor
   * e nomeava o removido. A etiqueta não tinha — o seletor inteiro sumia com o
   * filtro AINDA APLICADO, e a lista ficava num subconjunto, às vezes vazio, sem
   * nada na tela dizendo que havia filtro nem como tirá-lo.
   */
  it("etiqueta fora do vocabulário: o seletor FICA e oferece a etiqueta órfã", () => {
    setOrg("manager", "all");
    tagsRef.current = [];
    render(
      <InboxFilters aberto value={{ ...VALUE, tag: "etiqueta-orfa" }} onChange={() => {}} />,
    );
    const seletor = screen.getByLabelText("Filtrar por tag");
    expect(seletor).toBeInTheDocument();
    expect(seletor).toHaveTextContent("etiqueta-orfa");
  });

  it("CONTROLE: sem vocabulário e SEM filtro, o seletor de tag não aparece", () => {
    // Sem este caso, mostrar o seletor SEMPRE passaria no de cima — e a barra
    // ganharia um controle vazio em toda instalação que nunca usou etiqueta.
    setOrg("manager", "all");
    tagsRef.current = [];
    render(<InboxFilters aberto value={VALUE} onChange={() => {}} />);
    expect(screen.queryByLabelText("Filtrar por tag")).not.toBeInTheDocument();
  });

  it("filtro que casa com a lista: nada de 'Número removido'", () => {
    setOrg("manager", "all");
    caixasRef.current = [canal(), canal({ id: "canal-2", nome: "Suporte" })];
    render(
      <InboxFilters
        aberto
        value={{ ...VALUE, channel_session_id: "canal-2" }}
        onChange={() => {}}
        opcoes={opcoes()}
      />,
    );
    const seletor = screen.getByLabelText(SELETOR);
    expect(seletor).toHaveTextContent("Suporte");
    expect(seletor).not.toHaveTextContent("Número removido");
  });

  /**
   * Listagem que ainda não chegou (ou que falhou) é `undefined`, não lista vazia.
   * Chamar de "removido" um número que talvez esteja lá é a mesma família de
   * mentira que a tela de conexões cometia ao renderizar "primeira instalação"
   * quando a listagem falhava.
   */
  it("listagem ainda carregando: não afirma que o número foi removido", () => {
    setOrg("manager", "all");
    caixasRef.current = undefined;
    render(
      <InboxFilters
        aberto
        value={{ ...VALUE, channel_session_id: "canal-1" }}
        onChange={() => {}}
        opcoes={opcoes()}
      />,
    );
    expect(screen.queryByText("Número removido")).not.toBeInTheDocument();
  });
});

describe("InboxFilters — recolher os seletores não esconde filtro ligado", () => {
  it("fechado por padrão: os seletores não estão na tela", () => {
    setOrg("manager", "all");
    caixasRef.current = [canal({ id: "canal-1" }), canal({ id: "canal-2" })];
    render(<InboxFilters value={VALUE} onChange={() => {}} opcoes={opcoes()} />);
    expect(screen.queryByTestId("inbox-filtros-auxiliares")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filtros" })).toHaveAttribute("aria-expanded", "false");
  });

  it("com filtro valendo e o painel FECHADO, o funil diz quantos são", () => {
    // O recolhimento só é honesto se o estado continuar visível: sem o número,
    // a lista encolheria por um filtro que ninguém vê.
    setOrg("manager", "all");
    // FECHADO, o funil nem leu as opções ainda (`opcoes` ausente): o número sai
    // dos filtros LIGADOS, e não da lista do que dá para escolher.
    render(
      <InboxFilters value={{ ...VALUE, channel_session_id: "canal-2", tag: "vip" }} onChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Filtros" })).toHaveTextContent("2");
  });

  it("sem filtro nenhum, o funil não mostra número", () => {
    setOrg("manager", "all");
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Filtros" })).toHaveTextContent("");
  });
});
