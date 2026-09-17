/**
 * `crm_list_teams` contra o handler REAL — o agente descobrindo os setores.
 *
 * O que está preso aqui, e por quê:
 *
 *  - **time fechado não consulta elegíveis.** Não é só economia de query: um
 *    `eligible_count` > 0 num setor fora do horário é promessa de atendimento
 *    imediato que ninguém vai cumprir. A prova é por AUSÊNCIA de consulta às
 *    tabelas de disponibilidade, medida no stub — declarar zero no retorno
 *    passaria igual mesmo se a consulta tivesse acontecido;
 *  - **`total_count` conta o catálogo inteiro, não a lista filtrada.** Derivá-lo
 *    do array visível faria `only_open: true` numa org com todos os times
 *    fechados parecer "esta empresa não tem setor nenhum" — e o `next_action`
 *    mandaria o modelo transferir sem time, que é outra decisão;
 *  - **org sem time devolve o caminho de saída**, em vez de uma lista vazia que
 *    o modelo teria de interpretar sozinho.
 *
 * O cenário fechado usa agenda ILEGÍVEL de propósito (`America/Asunción`, o caso
 * real que originou `lerAgenda`): fecha sem depender do relógio de quem roda o
 * teste — e é o mesmo estado que a tela mostra como `horario_invalido`.
 */
import { describe, expect, it } from "vitest";

import type { McpContext } from "@/lib/mcp/types";

import { crmListTeams } from "./times";

const ORG = "22222222-2222-4222-8222-222222222222";
const SUPORTE = "11111111-1111-4111-8111-111111111111";
const FINANCEIRO = "33333333-3333-4333-8333-333333333333";
const ANA = "44444444-4444-4444-8444-444444444444";
const BRUNO = "55555555-5555-4555-8555-555555555555";

interface TimeNoBanco {
  id: string;
  name: string;
  slug: string;
  description: string;
  schedule: unknown;
  membros: string[];
}

/** Aberto 24/7: `windows` vazio é ausência de restrição, não ausência de horário. */
const TIME_SUPORTE: TimeNoBanco = {
  id: SUPORTE,
  name: "Suporte",
  slug: "suporte",
  description: "Problemas com pedido já feito.",
  schedule: {},
  membros: [ANA, BRUNO],
};

/** Fechado porque a agenda gravada não é legível — o parser recusa o acento. */
const TIME_FINANCEIRO: TimeNoBanco = {
  id: FINANCEIRO,
  name: "Financeiro",
  slug: "financeiro",
  description: "Cobrança, boleto e reembolso.",
  schedule: { timezone: "America/Asunción", windows: [] },
  membros: [ANA],
};

interface Consulta {
  tabela: string;
  terminal: "maybeSingle" | "then";
  /** Os `.eq()` da cadeia. Sem eles o stub responderia a pergunta errada em silêncio. */
  filtros: Record<string, unknown>;
}

/**
 * Stub de Supabase que REGISTRA cada consulta resolvida — tabela, terminal e os
 * `.eq()` da cadeia. O registro é o instrumento: a asserção "não consultou
 * elegíveis" só vale se houver como ver a consulta acontecendo no caso em que
 * ela deve acontecer, e os filtros são o que impede o stub de responder por um
 * time quando o código pediu outro.
 */
function cenario(times: TimeNoBanco[]): { ctx: McpContext; consultas: Consulta[] } {
  const consultas: Consulta[] = [];

  const resolver = (q: Consulta): { data?: unknown; error: null } => {
    // Registra no TERMINAL, não no `from`: é o terminal que distingue a listagem
    // do catálogo (`then`) da leitura de UM time pelo roteamento (`maybeSingle`).
    consultas.push(q);
    if (q.tabela === "attendance_teams") {
      // `carregarTimes` lista (then); `loadEligibleAttendants` lê UM (maybeSingle).
      if (q.terminal === "then") {
        return {
          data: times.map(({ membros: _membros, ...t }) => ({ ...t, archived_at: null })),
          error: null,
        };
      }
      const alvo = times.find((t) => t.id === q.filtros.id);
      return {
        data: alvo ? { id: alvo.id, schedule: alvo.schedule, archived_at: null } : null,
        error: null,
      };
    }
    if (q.tabela === "attendance_team_members") {
      const doTime = q.filtros.team_id
        ? times.filter((t) => t.id === q.filtros.team_id)
        : times;
      return {
        data: doTime.flatMap((t) => t.membros.map((user_id) => ({ team_id: t.id, user_id }))),
        error: null,
      };
    }
    if (q.tabela === "user_organizations") {
      return { data: [{ user_id: ANA }, { user_id: BRUNO }], error: null };
    }
    if (q.tabela === "attendant_availability") {
      return {
        data: [
          { user_id: ANA, capacity: 5, schedule: {} },
          // Bruno está no time e disponível, mas com a capacidade estourada.
          { user_id: BRUNO, capacity: 1, schedule: {} },
        ],
        error: null,
      };
    }
    if (q.tabela === "conversations") {
      return { data: [{ assigned_to_user_id: BRUNO }], error: null };
    }
    return { data: [], error: null };
  };

  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;
        return chain;
      },
      is: () => chain,
      in: () => chain,
      order: () => chain,
      maybeSingle: () => Promise.resolve(resolver({ tabela, terminal: "maybeSingle", filtros })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolver({ tabela, terminal: "then", filtros })).then(res),
    };
    return chain;
  };

  const ctx = {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: { from },
  } as unknown as McpContext;

  return { ctx, consultas };
}

/**
 * `loadEligibleAttendants` ENTROU? A resposta não está nas tabelas de
 * disponibilidade: com um time fechado ela sai antes de chegar nelas, e uma
 * asserção sobre `attendant_availability` fica verde nos dois mundos — medido,
 * com a guarda removida à força. O sinal honesto é a leitura de UM time
 * (`maybeSingle`), que só o roteamento faz; o catálogo lista (`then`).
 */
function consultouElegiveisDe(consultas: Consulta[]): number {
  return consultas.filter((q) => q.tabela === "attendance_teams" && q.terminal === "maybeSingle").length;
}

interface Saida {
  teams: Array<{ slug: string; name: string; when_to_use: string; open_now: boolean; eligible_count: number }>;
  open_count: number;
  total_count: number;
  next_action: string;
}

describe("crm_list_teams", () => {
  it("time fechado devolve eligible_count 0 SEM consultar elegíveis", async () => {
    const { ctx, consultas } = cenario([TIME_FINANCEIRO]);

    const saida = (await crmListTeams.handler({ only_open: false }, ctx)) as Saida;

    expect(saida.teams).toEqual([
      {
        slug: "financeiro",
        name: "Financeiro",
        when_to_use: "Cobrança, boleto e reembolso.",
        open_now: false,
        eligible_count: 0,
      },
    ]);
    // A prova é a ausência da chamada, não o zero do retorno.
    expect(
      consultouElegiveisDe(consultas),
      "elegíveis consultados para um time fechado",
    ).toBe(0);
  });

  it("CONTROLE: time aberto consulta os elegíveis e conta quem tem folga", async () => {
    // Sem este controle, o caso acima passaria mesmo se a tool NUNCA consultasse
    // elegíveis — verde por instrumento morto, indistinguível de verde correto.
    const { ctx, consultas } = cenario([TIME_SUPORTE]);

    const saida = (await crmListTeams.handler({ only_open: false }, ctx)) as Saida;

    expect(consultouElegiveisDe(consultas)).toBe(1);
    expect(consultas.map((q) => q.tabela)).toContain("attendant_availability");
    // Ana livre conta; Bruno, no mesmo time e disponível, está sem folga (1 de 1).
    expect(saida.teams[0]?.eligible_count).toBe(1);
    expect(saida.teams[0]?.open_now).toBe(true);
    expect(saida.open_count).toBe(1);
    expect(saida.next_action).toContain("Escolha o time pelo assunto");
  });

  it("only_open esconde os fechados, mas total_count continua contando todos", async () => {
    const { ctx } = cenario([TIME_SUPORTE, TIME_FINANCEIRO]);

    const saida = (await crmListTeams.handler({ only_open: true }, ctx)) as Saida;

    expect(saida.teams.map((t) => t.slug)).toEqual(["suporte"]);
    expect(saida.total_count, "o total é do catálogo, não da lista filtrada").toBe(2);
    expect(saida.open_count).toBe(1);
  });

  it("org sem time nenhum manda transferir sem o parâmetro team", async () => {
    const { ctx } = cenario([]);

    const saida = (await crmListTeams.handler({ only_open: false }, ctx)) as Saida;

    expect(saida.teams).toEqual([]);
    expect(saida.total_count).toBe(0);
    expect(saida.open_count).toBe(0);
    expect(saida.next_action).toContain("sem o parâmetro team");
  });

  it("todos fechados: o próximo passo avisa do prazo em vez de prometer atendimento", async () => {
    const { ctx } = cenario([TIME_FINANCEIRO]);

    const saida = (await crmListTeams.handler({ only_open: false }, ctx)) as Saida;

    expect(saida.open_count).toBe(0);
    expect(saida.total_count).toBe(1);
    expect(saida.next_action).toContain("prazo real");
  });
});
