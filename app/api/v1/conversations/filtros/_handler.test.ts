/**
 * AS OPÇÕES DOS FILTROS DO INBOX — atendentes, caixas de entrada e assuntos.
 *
 * Três coisas que este arquivo prende, e nenhuma aparece numa tela até alguém
 * reclamar:
 *
 *   1. ISOLAMENTO. A lista de membros é lida com o client de service role (a RLS
 *      de `user_organizations` mostra ao atendente só o próprio vínculo), que
 *      passa por cima da RLS: o `organization_id` da sessão é a ÚNICA barreira.
 *      A suíte de invariantes fala com o Postgres, não com rotas — é aqui que
 *      essa barreira é medida.
 *   2. QUEM VÊ NOMES. Quem não enxerga conversa de colega não recebe a lista de
 *      colegas, e a decisão é do servidor.
 *   3. MEIO, NÃO PROVIDER. A resposta diz "whatsapp", nunca o transporte.
 */
import { describe, expect, it, vi } from "vitest";

import type * as Capacidades from "@/lib/channels/capabilities";

/**
 * O handler pergunta o MEIO a `meioDoCanal` e nunca olha o transporte — então o
 * teste também não precisa (nem pode: `pnpm lint:channels`) nomear transporte
 * nenhum. Os quatro "transportes" abaixo são de mentira; o mapa de verdade tem o
 * seu próprio teste, em `lib/channels/`.
 */
const MEIO_DE_MENTIRA: Record<string, string> = {
  "t-zap-a": "whatsapp",
  "t-zap-b": "whatsapp",
  "t-site": "site_chat",
  "t-fone": "phone",
};
vi.mock("@/lib/channels/capabilities", async (original) => ({
  ...(await original<typeof Capacidades>()),
  meioDoCanal: (transporte: string | null | undefined) => MEIO_DE_MENTIRA[transporte ?? ""] ?? null,
}));

const { carregarOpcoesDosFiltros } = await import("./_handler");

interface Chamada {
  cliente: string;
  tabela: string;
  metodo: string;
  args: unknown[];
}

const ORG = "org-da-sessao";

/** Dois clientes (usuário e service role) sobre o mesmo registro de chamadas. */
function bancos(respostas: Record<string, unknown[]>, erros: Record<string, string> = {}) {
  const chamadas: Chamada[] = [];
  const cliente = (nome: string) =>
    ({
      from: (tabela: string) => {
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) =>
                  ok(
                    erros[tabela]
                      ? { data: null, error: { message: erros[tabela] } }
                      : { data: respostas[tabela] ?? [], error: null },
                  );
              }
              return (...args: unknown[]) => {
                chamadas.push({ cliente: nome, tabela, metodo: String(prop), args });
                return proxy;
              };
            },
          },
        );
        return proxy;
      },
    }) as never;
  return { db: cliente("usuario"), admin: cliente("admin"), chamadas };
}

const NOMES: Record<string, string | null> = { ana: "Ana", bruno: "Bruno", carla: "Carla", zeca: "Zeca" };
const nomes = async (ids: string[]) => new Map(ids.map((id) => [id, NOMES[id] ?? null] as const));

const MEMBROS = [
  { user_id: "bruno", role: "agent", revoked_at: null },
  { user_id: "ana", role: "manager", revoked_at: null },
  { user_id: "olheiro", role: "viewer", revoked_at: null },
  { user_id: "zeca", role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
  // Saiu e voltou: dois vínculos, um revogado e um ativo.
  { user_id: "carla", role: "agent", revoked_at: "2026-08-01T00:00:00Z" },
  { user_id: "carla", role: "agent", revoked_at: null },
];

const base = {
  user_organizations: MEMBROS,
  channel_sessions: [
    { id: "s1", display_name: "Comercial", phone_number: "5511999990001", provider: "t-zap-a" },
    { id: "s2", display_name: "Suporte", phone_number: "5511999990002", provider: "t-zap-b" },
    { id: "s3", display_name: "Site", phone_number: null, provider: "t-site" },
    { id: "s4", display_name: "Tronco", phone_number: "551136861503", provider: "t-fone" },
    // Uma linha SEM meio (a voz que acontece à margem da conversa): mora na
    // mesma tabela e não tem conversa própria.
    { id: "s5", display_name: "Voz", phone_number: null, provider: "t-sem-conversa" },
  ],
  attendance_teams: [
    { id: "t-sup", name: "Suporte" },
    { id: "t-fin", name: "Financeiro" },
    { id: "t-vazio", name: "Comercial" },
  ],
  atendimento_assuntos: [
    { id: "a1", name: "Segunda via", team_id: "t-fin", archived_at: null },
    { id: "a2", name: "Cancelamento", team_id: "t-fin", archived_at: "2026-09-20T00:00:00Z" },
    { id: "a3", name: "Sem internet", team_id: "t-sup", archived_at: null },
  ],
  organizations: [{ settings: { visibility_mode: "own_and_unassigned" } }],
};

async function carregar(role: "viewer" | "agent" | "manager" | "admin", respostas: Record<string, unknown[]> = base, opts: { semAdmin?: boolean } = {}) {
  const b = bancos(respostas);
  const opcoes = await carregarOpcoesDosFiltros({
    db: b.db,
    admin: opts.semAdmin ? null : b.admin,
    orgId: ORG,
    role,
    nomes,
  });
  return { opcoes, chamadas: b.chamadas };
}

const eqs = (c: Chamada[], tabela: string) =>
  c.filter((x) => x.tabela === tabela && x.metodo === "eq").map((x) => x.args.join(":"));

describe("⛔ toda leitura leva a organização da SESSÃO", () => {
  it.each(["user_organizations", "channel_sessions", "attendance_teams", "atendimento_assuntos"])(
    "`%s` é filtrada por `organization_id`",
    async (tabela) => {
      const { chamadas } = await carregar("manager");
      expect(chamadas.some((x) => x.tabela === tabela), `${tabela} nem foi lida`).toBe(true);
      expect(eqs(chamadas, tabela)).toContain(`organization_id:${ORG}`);
    },
  );

  it("os membros são lidos com o client de service role — a RLS mostra ao atendente só o próprio vínculo", async () => {
    const { chamadas } = await carregar("manager");
    const leitores = new Set(chamadas.filter((x) => x.tabela === "user_organizations").map((x) => x.cliente));
    expect([...leitores]).toEqual(["admin"]);
  });

  it("caixas e assuntos são lidos com o client do USUÁRIO, sob RLS", async () => {
    const { chamadas } = await carregar("manager");
    for (const tabela of ["channel_sessions", "attendance_teams", "atendimento_assuntos"]) {
      const leitores = new Set(chamadas.filter((x) => x.tabela === tabela).map((x) => x.cliente));
      expect([...leitores], tabela).toEqual(["usuario"]);
    }
  });
});

describe("os atendentes", () => {
  it("⭐ ativos por nome, depois quem saiu; observador não atende e não entra", async () => {
    const { opcoes } = await carregar("manager");
    expect(opcoes.atendentes).toEqual([
      { user_id: "ana", nome: "Ana", ativo: true },
      { user_id: "bruno", nome: "Bruno", ativo: true },
      { user_id: "carla", nome: "Carla", ativo: true },
      { user_id: "zeca", nome: "Zeca", ativo: false },
    ]);
  });

  it("quem saiu e voltou aparece UMA vez, como ativo", async () => {
    const { opcoes } = await carregar("admin");
    expect(opcoes.atendentes.filter((a) => a.user_id === "carla")).toEqual([
      { user_id: "carla", nome: "Carla", ativo: true },
    ]);
  });

  it("o observador (`viewer`) enxerga a organização inteira: recebe a lista", async () => {
    const { opcoes } = await carregar("viewer");
    expect(opcoes.atendentes.map((a) => a.user_id)).toEqual(["ana", "bruno", "carla", "zeca"]);
  });

  it("⛔ atendente que NÃO vê conversa de colega recebe a lista vazia — e a tabela nem é lida", async () => {
    const { opcoes, chamadas } = await carregar("agent");
    expect(opcoes.atendentes).toEqual([]);
    expect(chamadas.some((x) => x.tabela === "user_organizations")).toBe(false);
    // O resto do painel continua servindo a ele.
    expect(opcoes.caixas.length).toBeGreaterThan(0);
  });

  it.each(["all", "own_and_team"])("atendente no modo `%s` vê colegas: recebe a lista", async (modo) => {
    const { opcoes } = await carregar("agent", { ...base, organizations: [{ settings: { visibility_mode: modo } }] });
    expect(opcoes.atendentes.length).toBe(4);
  });

  it("o modo só é lido para o papel em que ele decide alguma coisa", async () => {
    const { chamadas } = await carregar("manager");
    expect(chamadas.some((x) => x.tabela === "organizations")).toBe(false);
  });

  it("sem service role: degrada para o client do usuário, ainda filtrando a organização", async () => {
    const { chamadas } = await carregar("manager", base, { semAdmin: true });
    expect(new Set(chamadas.filter((x) => x.tabela === "user_organizations").map((x) => x.cliente))).toEqual(
      new Set(["usuario"]),
    );
    expect(eqs(chamadas, "user_organizations")).toContain(`organization_id:${ORG}`);
  });
});

describe("as caixas de entrada", () => {
  it("⭐ cada número com o seu MEIO; a linha que não tem conversa própria fica de fora", async () => {
    const { opcoes } = await carregar("manager");
    expect(opcoes.caixas).toEqual([
      { id: "s1", meio: "whatsapp", nome: "Comercial", numero: "5511999990001" },
      { id: "s2", meio: "whatsapp", nome: "Suporte", numero: "5511999990002" },
      { id: "s3", meio: "site_chat", nome: "Site", numero: null },
      { id: "s4", meio: "phone", nome: "Tronco", numero: "551136861503" },
    ]);
  });

  it("⛔ a resposta não carrega o transporte — nem a chave, nem o valor", async () => {
    const { opcoes } = await carregar("manager");
    expect(JSON.stringify(opcoes)).not.toMatch(/provider|t-zap|t-site|t-fone|t-sem-conversa/);
  });
});

describe("os assuntos", () => {
  it("⭐ agrupados por time, em ordem; arquivado continua, marcado; time sem assunto não aparece", async () => {
    const { opcoes } = await carregar("manager");
    expect(opcoes.assuntos).toEqual([
      {
        time_id: "t-fin",
        time: "Financeiro",
        assuntos: [
          { id: "a2", nome: "Cancelamento", arquivado: true },
          { id: "a1", nome: "Segunda via", arquivado: false },
        ],
      },
      { time_id: "t-sup", time: "Suporte", assuntos: [{ id: "a3", nome: "Sem internet", arquivado: false }] },
    ]);
  });
});

describe("falha de leitura não vira lista vazia", () => {
  it("erro numa tabela é lançado: seletor vazio por erro pareceria organização sem dados", async () => {
    const b = bancos(base, { atendimento_assuntos: "boom" });
    await expect(
      carregarOpcoesDosFiltros({ db: b.db, admin: b.admin, orgId: ORG, role: "manager", nomes }),
    ).rejects.toThrow();
  });
});
