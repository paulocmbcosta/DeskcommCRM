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
const upload = vi.fn(async () => ({ error: null }));
let recusas = 0;
let provider = "meta_cloud";
const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("from contacts")) return { rows: [{ phone_number: "+5561993040271", provider }] };
    if (sql.includes("api_audit_log")) return { rows: [{ n: recusas }] };
    return { rows: [] };
  }),
};
const saida = { vagas: vi.fn(() => 3), enviar: vi.fn(async () => ({ ok: true as const, outcome: { kind: "sent" as const, idempotencyKey: "k", messageId: "m" } })) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const montar = (toolIds: string[] = ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) =>
  montarFerramentasDoConector({
    pool: pool as never,
    supabase: { storage: { from: () => ({ upload }) } } as never,
    log,
    tenantId: "org-1",
    leadId: "lead-1",
    conversationId: "00000000-0000-4000-8000-0000000000c1",
    channelSessionId: "sess-1",
    toolIds,
    agentId: "agente-1",
    saida,
    agora: () => new Date("2026-09-22T15:00:00Z"),
  });
const rodar = async (nome: string, args: object = {}) => {
  const { tools } = await montar();
  return (await tools[nome]!.execute!(args as never, { toolCallId: "t", messages: [] } as never)) as Record<string, unknown>;
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

beforeEach(() => {
  vi.clearAllMocks();
  recusas = 0;
  provider = "meta_cloud";
  conectorDoAgente.mockResolvedValue({ id: "ixc", agente: { consultar, enviarCobranca } });
  lerCredencial.mockResolvedValue({ baseUrl: "https://erp", token: "t", status: "ativa" });
  lerLimite.mockResolvedValue(60);
  saida.vagas.mockReturnValue(3);
});

describe("montagem", () => {
  it("sem as capacidades ligadas: nada entra, nada é lido", async () => {
    expect(Object.keys((await montar([])).tools)).toEqual([]);
    expect(conectorDoAgente).not.toHaveBeenCalled();
  });

  it("ligadas sem conector na organização: não entram, e voltam como ausentes", async () => {
    conectorDoAgente.mockResolvedValue(null);
    const r = await montar();
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

  it("passa ao conector o estado do telefone NESTE canal (sim/nao/desconhecido)", async () => {
    consultar.mockResolvedValue({ estado: "precisa_cpf_e_nascimento" });
    provider = "site_widget";
    await rodar("crm_consultar_cliente_erp");
    expect(consultar).toHaveBeenCalledWith(expect.objectContaining({ identidadeDoTelefone: "nao", telefone: "+5561993040271" }));
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
  });

  it("veto da saída (opt-out) volta ao modelo com o código", async () => {
    saida.enviar.mockResolvedValueOnce({ ok: false, code: "contato_bloqueado", message: "opt-out" } as never);
    enviarCobranca.mockImplementation(async (p: { portas: { enviar: (m: object) => Promise<void> } }) => {
      await p.portas.enviar({ type: "image", body: "x" });
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
});
