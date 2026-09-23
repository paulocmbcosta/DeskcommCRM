// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const conectorDoAgente = vi.fn();
vi.mock("@/lib/conectores/registro", () => ({ conectorDoAgente: (...a: unknown[]) => conectorDoAgente(...a) }));
const lerCredencial = vi.fn();
const lerLimite = vi.fn();
const carimbar = vi.fn();
vi.mock("@/lib/conectores/conexao", () => ({
  lerCredencial: (...a: unknown[]) => lerCredencial(...a),
  lerLimiteDeCobranca: (...a: unknown[]) => lerLimite(...a),
  carimbarEstado: (...a: unknown[]) => carimbar(...a),
}));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

import { FalhaDoConector } from "@/lib/conectores/tipos";
import { montarFerramentasDoConector } from "@/lib/agent-engine/agent/ferramentas-do-conector";

const consultar = vi.fn();
const enviarCobranca = vi.fn();
const upload = vi.fn(async (..._args: unknown[]) => ({ error: null }));
const remove = vi.fn(async (..._args: unknown[]) => ({ error: null }));
let recusas = 0;
const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("api_audit_log")) return { rows: [{ n: recusas }] };
    return { rows: [] };
  }),
};
const saida = { vagas: vi.fn(() => 3), enviar: vi.fn(async () => ({ ok: true as const, outcome: { kind: "sent" as const, idempotencyKey: "k", messageId: "m" } })) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const construir = (
  toolIds: string[] = ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"],
  overrides: Partial<{ telefone: string | null; identidadeDoTelefone: "sim" | "nao" | "desconhecido" }> = {},
) =>
  montarFerramentasDoConector({
    pool: pool as never,
    supabase: { storage: { from: () => ({ upload, remove }) } } as never,
    log,
    tenantId: "org-1",
    leadId: "lead-1",
    conversationId: "00000000-0000-4000-8000-0000000000c1",
    channelSessionId: "sess-1",
    telefone: "+5561993040271",
    identidadeDoTelefone: "sim",
    toolIds,
    agentId: "agente-1",
    saida,
    agora: () => new Date("2026-09-22T15:00:00Z"),
    ...overrides,
  });

const rodarCom = async (tools: Awaited<ReturnType<typeof construir>>["tools"], nome: string, args: object = {}) =>
  (await tools[nome]!.execute!(args as never, { toolCallId: "t", messages: [] } as never)) as Record<string, unknown>;

const rodar = async (nome: string, args: object = {}, toolIds?: string[]) => {
  const { tools } = await construir(toolIds);
  return rodarCom(tools, nome, args);
};

const IDENTIFICADO = {
  estado: "identificado",
  cliente: { primeiroNome: "Maria", situacao: "Bloqueado", motivoDaSituacao: "financeiro em atraso", bloqueado: true, plano: "Fibra 500 Mega", clienteDesde: "2024-03-10", conexao: "offline", temOsAberta: false },
  financeiro: {
    vencidas: [{ vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 }],
    proxima: { vencimento: "2026-10-12", valorCents: 12990, diasDeAtraso: 0 },
    totalVencidoCents: 12990,
    daVez: { vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 },
  },
  auditoria: { vinculou: { verificadoPor: "telefone", cadastros: ["10"] } },
};

/** Igual a IDENTIFICADO, mas a fatura da vez está DENTRO do limite de 60 dias. */
const IDENTIFICADO_DENTRO_DO_LIMITE = {
  ...IDENTIFICADO,
  auditoria: {},
  financeiro: { ...IDENTIFICADO.financeiro, daVez: { vencimento: "2026-08-20", valorCents: 12990, diasDeAtraso: 10 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  recusas = 0;
  conectorDoAgente.mockResolvedValue({ id: "ixc", agente: { consultar, enviarCobranca } });
  lerCredencial.mockResolvedValue({ baseUrl: "https://erp", token: "t", status: "ativa" });
  lerLimite.mockResolvedValue(60);
  saida.vagas.mockReturnValue(3);
});

describe("montagem", () => {
  it("sem as capacidades ligadas: nada entra, nada é lido", async () => {
    expect(Object.keys((await construir([])).tools)).toEqual([]);
    expect(conectorDoAgente).not.toHaveBeenCalled();
  });

  it("ligadas sem conector na organização: não entram, e voltam como ausentes", async () => {
    conectorDoAgente.mockResolvedValue(null);
    const r = await construir();
    expect(Object.keys(r.tools)).toEqual([]);
    expect(r.ausentes).toEqual(["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]);
  });
});

describe("crm_consultar_cliente_erp", () => {
  it("formata para o modelo, sem id, e manda NÃO enviar quando a fatura passa do limite", async () => {
    consultar.mockResolvedValue(IDENTIFICADO);
    const r = await rodar("crm_consultar_cliente_erp");
    expect(r).toMatchObject({ ok: true, estado: "identificado", cliente: { primeiro_nome: "Maria", cliente_desde: "10/03/2024", bloqueado: true } });
    expect(r.financeiro).toMatchObject({ total_vencido: "R$ 129,90", fatura_da_vez: { vencimento: "14/07/2026", valor: "R$ 129,90", dias_de_atraso: 70, vai_para_a_cobranca: true } });
    expect(String(r.orientacao)).toMatch(/NÃO envie/);
    expect(JSON.stringify(r)).not.toMatch(/"10"|cadastro/);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.vinculo_criado", metadata: expect.objectContaining({ ator: "ai_agent", agente_id: "agente-1" }) }));
  });

  it("passa ao conector o telefone e a identidade RESOLVIDOS PELO TURNO — não consulta o banco de novo", async () => {
    consultar.mockResolvedValue({ estado: "precisa_cpf_e_nascimento" });
    const { tools } = await construir(undefined, { telefone: "+5561999999999", identidadeDoTelefone: "nao" });
    await rodarCom(tools, "crm_consultar_cliente_erp");
    expect(consultar).toHaveBeenCalledWith(expect.objectContaining({ identidadeDoTelefone: "nao", telefone: "+5561999999999" }));
    // A ferramenta não faz NENHUMA consulta a `contacts`/`channel_sessions` — o
    // único uso do pool aqui é `api_audit_log` (contador de tentativas, chamado
    // pelo chão de `precisa_cpf_e_nascimento`).
    const sqls = pool.query.mock.calls.map(([s]) => String(s));
    expect(sqls.every((s) => s.includes("api_audit_log"))).toBe(true);
    expect(sqls.some((s) => s.includes("from contacts") || s.includes("channel_sessions"))).toBe(false);
  });

  it("recusa: audita (aguardando) e devolve as tentativas que sobram, sem dizer qual dado errou", async () => {
    consultar.mockResolvedValue({ estado: "nao_conferiu" });
    audit.mockImplementation(async () => {
      recusas += 1;
    });
    const r = await rodar("crm_consultar_cliente_erp", { cpf_cnpj: "52998224725", data_nascimento: "1985-03-13" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.identificacao_recusada", resourceType: "conversation" }));
    expect(r).toMatchObject({ ok: false, estado: "nao_conferiu", tentativas_restantes: 2 });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("52998224725");
  });

  it("3 recusas no atendimento: esgotadas, sem nem consultar", async () => {
    recusas = 3;
    const r = await rodar("crm_consultar_cliente_erp", { cpf_cnpj: "52998224725", data_nascimento: "1985-03-12" });
    expect(r.estado).toBe("tentativas_esgotadas");
    expect(consultar).not.toHaveBeenCalled();
  });

  it("IXC fora: carimba erro na conexão e manda transferir, sem inventar", async () => {
    consultar.mockRejectedValue(new FalhaDoConector("sem_resposta", "x"));
    const r = await rodar("crm_consultar_cliente_erp");
    expect(r.estado).toBe("sistema_indisponivel");
    expect(carimbar).toHaveBeenCalledWith(expect.anything(), "org-1", "ixc", "erro", "sem_resposta");
  });

  describe("bug NOSSO não é o ERP recusando (item 7 da revisão de qualidade)", () => {
    it("erro que NÃO é FalhaDoConector: não carimba o conector, não culpa o sistema de gestão, abre item na Central", async () => {
      consultar.mockRejectedValue(new TypeError("cannot read properties of undefined"));
      const r = await rodar("crm_consultar_cliente_erp");
      expect(r.estado).toBe("sistema_indisponivel");
      expect(String(r.orientacao)).not.toMatch(/sistema de gestão/);
      expect(String(r.orientacao)).toMatch(/erro interno/);
      expect(carimbar).not.toHaveBeenCalled();
      const sqls = pool.query.mock.calls.map(([s]) => String(s));
      expect(sqls.some((s) => s.includes("insert into agent_inbox_items"))).toBe(true);
    });

    it("controle: FalhaDoConector CONTINUA carimbando e citando o sistema de gestão", async () => {
      consultar.mockRejectedValue(new FalhaDoConector("credencial_recusada", "x"));
      const r = await rodar("crm_consultar_cliente_erp");
      expect(String(r.orientacao)).toMatch(/sistema de gestão/);
      expect(carimbar).toHaveBeenCalled();
      const sqls = pool.query.mock.calls.map(([s]) => String(s));
      expect(sqls.some((s) => s.includes("insert into agent_inbox_items"))).toBe(false);
    });
  });

  describe("a orientação respeita o pacote ligado (item 2 da revisão de qualidade)", () => {
    it("só a consulta ligada: orienta dar valor e vencimento e transferir — nunca chamar a ferramenta ausente", async () => {
      consultar.mockResolvedValue(IDENTIFICADO_DENTRO_DO_LIMITE);
      const r = await rodar("crm_consultar_cliente_erp", {}, ["crm_consultar_cliente_erp"]);
      expect(String(r.orientacao)).not.toContain("crm_enviar_cobranca_erp");
      expect(String(r.orientacao)).toMatch(/NÃO tem a ferramenta de enviar cobrança/);
      expect(String(r.orientacao)).toMatch(/R\$ 129,90/);
    });

    it("controle: as duas ligadas — a orientação manda usar a ferramenta de enviar", async () => {
      consultar.mockResolvedValue(IDENTIFICADO_DENTRO_DO_LIMITE);
      const r = await rodar("crm_consultar_cliente_erp", {}, ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]);
      expect(String(r.orientacao)).toContain("crm_enviar_cobranca_erp");
    });
  });

  describe("esgotada não reabre o laço pedindo dado de novo (item 3 da revisão de qualidade)", () => {
    it("3 recusas confirmadas + chamada SEM argumentos que o ERP responde 'precisa_cpf': esgotadas, não pede de novo", async () => {
      recusas = 3;
      consultar.mockResolvedValue({ estado: "precisa_cpf" });
      const r = await rodar("crm_consultar_cliente_erp");
      // Consultou o ERP de verdade (não gateou ANTES) — é o que permite o
      // controle abaixo (humano vinculou) funcionar.
      expect(consultar).toHaveBeenCalledTimes(1);
      expect(r.estado).toBe("tentativas_esgotadas");
    });

    it("controle: 3 recusas confirmadas, mas um HUMANO vinculou o contato entretanto — a mesma chamada sem argumentos volta identificado", async () => {
      recusas = 3;
      consultar.mockResolvedValue(IDENTIFICADO_DENTRO_DO_LIMITE);
      const r = await rodar("crm_consultar_cliente_erp");
      expect(r.estado).toBe("identificado");
    });
  });

  describe("chão em memória quando a auditoria da recusa não confirma (item 9 da revisão de qualidade)", () => {
    it("audit() que nunca reflete no banco não torna o limite ilimitado — o turno conta em memória", async () => {
      consultar.mockResolvedValue({ estado: "nao_conferiu" });
      // O PIOR caso: audit() "funciona" (não lança) mas por algum motivo a leitura
      // de api_audit_log nunca reflete a escrita (ex.: réplica atrasada, RLS,
      // rollback silencioso) — `recusas` (o contador do "banco") fica travado em 0.
      audit.mockImplementation(async () => {});
      const { tools } = await construir();
      const args = { cpf_cnpj: "1", data_nascimento: "1985-01-01" };
      expect(await rodarCom(tools, "crm_consultar_cliente_erp", args)).toMatchObject({ estado: "nao_conferiu", tentativas_restantes: 2 });
      expect(await rodarCom(tools, "crm_consultar_cliente_erp", args)).toMatchObject({ estado: "nao_conferiu", tentativas_restantes: 1 });
      expect((await rodarCom(tools, "crm_consultar_cliente_erp", args)).estado).toBe("tentativas_esgotadas");
      consultar.mockClear();
      // A 4ª nem chega a consultar o ERP: o gate de ENTRADA (com cpf/nascimento
      // no argumento) já barra, usando o chão em memória — o banco (`recusas`)
      // segue em 0 o tempo todo.
      expect((await rodarCom(tools, "crm_consultar_cliente_erp", args)).estado).toBe("tentativas_esgotadas");
      expect(consultar).not.toHaveBeenCalled();
      expect(recusas).toBe(0);
    });
  });
});

describe("crm_enviar_cobranca_erp", () => {
  it("sem 2 vagas no turno: recusa ANTES de ir ao ERP", async () => {
    saida.vagas.mockReturnValue(1);
    const r = await rodar("crm_enviar_cobranca_erp");
    expect(r).toMatchObject({ ok: false, error: { code: "max_sends_per_turn" } });
    expect(enviarCobranca).not.toHaveBeenCalled();
  });

  it("guarda o arquivo no prefixo da conversa, envia pela saída do turno e audita com o agente", async () => {
    enviarCobranca.mockImplementation(async (p: { portas: { guardarArquivo: (a: object) => Promise<string>; enviar: (m: object) => Promise<void> }; forma: string; limiteDeDias: number }) => {
      const caminho = await p.portas.guardarArquivo({ nome: "pix-14-07-2026", extensao: "png", mime: "image/png", conteudo: Buffer.from("x") });
      await p.portas.enviar({ type: "image", body: "Segue o Pix", media_storage_path: caminho, media_mime: "image/png", media_size_bytes: 1 });
      await p.portas.enviar({ type: "text", body: "000201..." });
      return { resultado: "enviada", forma: "pix", fatura: { vencimento: "2026-08-20", valorCents: 12990, diasDeAtraso: 33 }, enviadas: 2, previstas: 2, pixGeradoAgora: true, pixIndisponivel: false, auditoria: { faturaId: "901" } };
    });
    const r = await rodar("crm_enviar_cobranca_erp", { forma: "PIX" });
    expect(enviarCobranca).toHaveBeenCalledWith(expect.objectContaining({ forma: "pix", limiteDeDias: 60 }));
    expect(upload.mock.calls[0]?.[0]).toMatch(/^org-1\/00000000-0000-4000-8000-0000000000c1\/cobranca-[0-9a-f]{8}\/pix-14-07-2026\.png$/);
    expect(saida.enviar).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, estado: "enviada", forma: "pix", fatura: { valor: "R$ 129,90" } });
    expect(JSON.stringify(r)).not.toContain("901");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.fatura_enviada", metadata: expect.objectContaining({ fatura: "901", ator: "ai_agent", pix_gerado_agora: true }) }));
    // Controle do item 5: entrega COMPLETA não remove o arquivo do storage.
    expect(remove).not.toHaveBeenCalled();
  });

  it("veto da saída (opt-out) volta ao modelo com o código", async () => {
    saida.enviar.mockResolvedValueOnce({ ok: false, code: "contato_bloqueado", message: "opt-out" } as never);
    enviarCobranca.mockImplementation(async (p: { portas: { guardarArquivo: (a: object) => Promise<string>; enviar: (m: object) => Promise<void> } }) => {
      const caminho = await p.portas.guardarArquivo({ nome: "pix-x", extensao: "png", mime: "image/png", conteudo: Buffer.from("x") });
      await p.portas.enviar({ type: "image", body: "x", media_storage_path: caminho });
      throw new Error("inalcançável");
    });
    expect(await rodar("crm_enviar_cobranca_erp")).toMatchObject({ ok: false, error: { code: "contato_bloqueado" } });
  });

  it("acima do limite: audita o encaminhamento e manda transferir", async () => {
    enviarCobranca.mockResolvedValue({ resultado: "encaminhar_para_cobranca", fatura: { vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 }, auditoria: { faturaId: "900" } });
    const r = await rodar("crm_enviar_cobranca_erp");
    expect(r).toMatchObject({ ok: false, estado: "encaminhar_para_cobranca" });
    expect(String(r.orientacao)).toMatch(/setor de cobrança/);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.cobranca_encaminhada", metadata: expect.objectContaining({ dias_de_atraso: 70, limite_de_dias: 60 }) }));
  });

  describe("bug NOSSO não é o ERP recusando (item 7 da revisão de qualidade)", () => {
    it("lerLimiteDeCobranca lançando: frase neutra ('gerar a cobrança'), sem carimbar o conector", async () => {
      lerLimite.mockRejectedValue(new Error("boom"));
      const r = await rodar("crm_enviar_cobranca_erp");
      expect(r.estado).toBe("sistema_indisponivel");
      expect(String(r.orientacao)).toMatch(/não consegui gerar a cobrança agora/);
      expect(String(r.orientacao)).not.toMatch(/sistema de gestão/);
      expect(carimbar).not.toHaveBeenCalled();
    });
  });

  describe("arquivo órfão no Storage (item 5 da revisão de qualidade)", () => {
    it("veto da saída DEPOIS do upload: o arquivo sobe e é removido", async () => {
      saida.enviar.mockResolvedValueOnce({ ok: false, code: "contato_bloqueado", message: "opt-out" } as never);
      enviarCobranca.mockImplementation(async (p: { portas: { guardarArquivo: (a: object) => Promise<string>; enviar: (m: object) => Promise<void> } }) => {
        const caminho = await p.portas.guardarArquivo({ nome: "pix-orfao", extensao: "png", mime: "image/png", conteudo: Buffer.from("x") });
        await p.portas.enviar({ type: "image", body: "x", media_storage_path: caminho });
        throw new Error("inalcançável");
      });
      await rodar("crm_enviar_cobranca_erp");
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[0]).toEqual([expect.stringMatching(/pix-orfao\.png$/)]);
    });

    it("resultado de negócio diferente de 'enviada' depois do upload: o arquivo também é removido", async () => {
      enviarCobranca.mockImplementation(async (p: { portas: { guardarArquivo: (a: object) => Promise<string> } }) => {
        await p.portas.guardarArquivo({ nome: "boleto-orfao", extensao: "pdf", mime: "application/pdf", conteudo: Buffer.from("x") });
        return { resultado: "sem_como_cobrar", fatura: { vencimento: "2026-07-14", valorCents: 100, diasDeAtraso: 1 }, auditoria: { faturaId: "1" } };
      });
      await rodar("crm_enviar_cobranca_erp");
      expect(remove.mock.calls[0]?.[0]).toEqual([expect.stringMatching(/boleto-orfao\.pdf$/)]);
    });
  });

  describe("uma cobrança por turno (item 6 da revisão de qualidade)", () => {
    it("a 2ª chamada no MESMO turno é recusada, mesmo com vagas de sobra (teto elevado)", async () => {
      saida.vagas.mockReturnValue(10);
      enviarCobranca.mockResolvedValue({ resultado: "enviada", forma: "pix", fatura: { vencimento: "2026-07-14", valorCents: 100, diasDeAtraso: 1 }, enviadas: 2, previstas: 2, pixGeradoAgora: false, pixIndisponivel: false, auditoria: { faturaId: "1" } });
      const { tools } = await construir();
      const r1 = await rodarCom(tools, "crm_enviar_cobranca_erp");
      expect(r1).toMatchObject({ ok: true, estado: "enviada" });
      const r2 = await rodarCom(tools, "crm_enviar_cobranca_erp");
      expect(r2).toMatchObject({ ok: false, error: { code: "cobranca_ja_tentada_no_turno" } });
      expect(enviarCobranca).toHaveBeenCalledTimes(1);
    });

    it("mesmo latch trava depois de uma tentativa que FALHOU (não é só depois do sucesso)", async () => {
      saida.vagas.mockReturnValue(10);
      enviarCobranca.mockRejectedValue(new Error("boom"));
      const { tools } = await construir();
      await rodarCom(tools, "crm_enviar_cobranca_erp");
      const r2 = await rodarCom(tools, "crm_enviar_cobranca_erp");
      expect(r2).toMatchObject({ ok: false, error: { code: "cobranca_ja_tentada_no_turno" } });
      expect(enviarCobranca).toHaveBeenCalledTimes(1);
    });
  });
});
