// tests/unit/classificador-comercial-worker.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import type { FalhaDoJev, ResultadoDoJev } from "@/lib/classificador-comercial/jev";

const { processarClassificacao, registrarNoLlmCalls, codigoDeErroDaFalha } = await import(
  "@/workers/classificador-comercial"
);
const { classificadorComercialHandler } = await import("@/workers/classificador-comercial.handler");

const AGORA = new Date("2026-09-22T15:00:00Z");

function evento(over: Partial<EventRow> = {}, payload: Record<string, unknown> = {}): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { message_id: "msg-1", conversation_id: "conv-1", contact_id: "contato-1", direction: "inbound", ...payload },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(AGORA.getTime() - 5_000).toISOString(),
    ...over,
  };
}

const RESPOSTA_SIM: ResultadoDoJev = {
  ok: true,
  latenciaMs: 180,
  resposta: {
    comercial: 0.93,
    assunto: "mudanca_de_plano",
    confiancaDoAssunto: 0.8,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 700,
    custoEmCentavos: 0.00294,
  },
};
const RESPOSTA_NAO: ResultadoDoJev = {
  ok: true,
  latenciaMs: 150,
  resposta: {
    comercial: 0.08,
    assunto: "suporte",
    confiancaDoAssunto: 0.9,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 650,
    custoEmCentavos: 0.00273,
  },
};

let dados: DadosDoClassificador;
let perguntar: ReturnType<typeof vi.fn>;
let garantir: ReturnType<typeof vi.fn>;
let chave: ReturnType<typeof vi.fn>;
let registrarChamada: ReturnType<typeof vi.fn>;

function deps() {
  return {
    admin: {} as never,
    dados,
    chave: chave as never,
    perguntar: perguntar as never,
    garantir: garantir as never,
    registrarChamada: registrarChamada as never,
    agora: () => AGORA,
  };
}

beforeEach(() => {
  dados = {
    regra: async () => ({ modo: "classificador", limiar: 0.7 }),
    temCardAberto: async () => false,
    contatoBloqueado: async () => false,
    mensagem: async () => ({ type: "text", media_derived_status: null }),
    ultimasMensagens: async () => [{ direcao: "inbound", texto: "quero mudar meu plano para 500 mega" }],
  };
  perguntar = vi.fn(async () => RESPOSTA_SIM);
  garantir = vi.fn(async () => ({ criado: true, leadId: "lead-1", pipelineId: "p", stageId: "s" }));
  chave = vi.fn(async () => ({ apiKey: "sk-or-teste", origem: "organizacao" }));
  registrarChamada = vi.fn();
});

describe("processarClassificacao — quando NÃO chama o Jev", () => {
  it("organização no modo de sempre: pula, sem chamar o Jev", async () => {
    dados.regra = async () => ({ modo: "toda_conversa", limiar: 0.7 });
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "modo_toda_conversa" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("contato que JÁ TEM CARD: pula, sem chamar o Jev (o pedido do dono)", async () => {
    dados.temCardAberto = async () => true;
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "ja_tem_card" });
    expect(perguntar).not.toHaveBeenCalled();
    expect(chave).not.toHaveBeenCalled();
  });

  it("mensagem nossa (saída) não é classificada", async () => {
    expect(await processarClassificacao(evento({}, { direction: "outbound" }), deps())).toEqual({
      status: "pulado",
      motivo: "nao_e_entrada",
    });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("contato bloqueado (pediu para sair): pula", async () => {
    dados.contatoBloqueado = async () => true;
    expect((await processarClassificacao(evento(), deps())).status).toBe("pulado");
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("sem nenhuma fala do cliente: pula", async () => {
    dados.ultimasMensagens = async () => [{ direcao: "outbound", texto: "Promoção!" }];
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "sem_texto_do_cliente" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("áudio ainda sendo transcrito: espera e tenta de novo em 15 s", async () => {
    dados.mensagem = async () => ({ type: "audio", media_derived_status: "pending" });
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({ status: "tentar_de_novo", em: new Date(AGORA.getTime() + 15_000), motivo: "aguardando_transcricao" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("áudio que passou de 2 min sem transcrição: classifica com o que houver", async () => {
    dados.mensagem = async () => ({ type: "audio", media_derived_status: "pending" });
    const velho = evento({ created_at: new Date(AGORA.getTime() - 121_000).toISOString() });
    expect((await processarClassificacao(velho, deps())).status).toBe("classificado");
  });
});

describe("processarClassificacao — a decisão", () => {
  it("comercial acima do limiar: cria o card com a origem do classificador", async () => {
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({ status: "classificado", criouCard: true, assunto: "mudanca_de_plano", probabilidade: 0.93 });
    expect(garantir).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: "org-1", contactId: "contato-1", conversationId: "conv-1", nomeDoContato: null },
      { tipo: "classificador", assunto: "mudanca_de_plano", rotuloDoAssunto: "mudança de plano", probabilidade: 0.93, modelo: "jev-1.13.0" },
    );
  });

  it("não comercial: não cria card", async () => {
    perguntar.mockResolvedValue(RESPOSTA_NAO);
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "classificado",
      criouCard: false,
      assunto: "suporte",
      probabilidade: 0.08,
    });
    expect(garantir).not.toHaveBeenCalled();
  });

  it("respeita o limiar da organização", async () => {
    dados.regra = async () => ({ modo: "classificador", limiar: 0.95 });
    expect((await processarClassificacao(evento(), deps())).status).toBe("classificado");
    expect(garantir).not.toHaveBeenCalled();
  });

  it("registra a chamada em llm_calls, com tokens e latência", async () => {
    await processarClassificacao(evento(), deps());
    expect(registrarChamada).toHaveBeenCalledWith({
      organizationId: "org-1",
      contactId: "contato-1",
      modelo: "jev-1.13.0",
      tokensDeEntrada: 700,
      custoEmCentavos: 0.00294,
      latenciaMs: 180,
      falha: null,
    });
  });
});

describe("processarClassificacao — quando o classificador falha (decisão A)", () => {
  it("sem chave: o card nasce sem classificar, e o Jev não é chamado", async () => {
    chave.mockResolvedValue(null);
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "card_sem_classificar",
      causa: "sem_chave",
      criouCard: true,
    });
    expect(perguntar).not.toHaveBeenCalled();
    expect(garantir).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      tipo: "sem_classificacao",
      causa: "sem_chave",
    });
  });

  it("falha temporária recente: tenta de novo em 60 s, sem criar card", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 8000, falha: { tipo: "temporaria", status: 529, detalhe: "" } });
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "tentar_de_novo",
      em: new Date(AGORA.getTime() + 60_000),
      motivo: "jev_529",
    });
    expect(garantir).not.toHaveBeenCalled();
    expect(registrarChamada).toHaveBeenCalledWith(expect.objectContaining({ falha: expect.objectContaining({ tipo: "temporaria" }) }));
  });

  it("falha temporária há mais de 10 min: o card nasce sem classificar", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 8000, falha: { tipo: "temporaria", status: null, detalhe: "TimeoutError" } });
    const velho = evento({ created_at: new Date(AGORA.getTime() - 11 * 60_000).toISOString() });
    const r = await processarClassificacao(velho, deps());
    expect(r).toEqual({
      status: "card_sem_classificar",
      causa: "temporaria",
      criouCard: true,
    });
  });

  it("chave recusada ou sem saldo: o card nasce sem classificar, na hora", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 90, falha: { tipo: "conta", status: 402, detalhe: "Insufficient credits" } });
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({
      status: "card_sem_classificar",
      causa: "conta",
      criouCard: true,
    });
  });
});

describe("classificadorComercialHandler", () => {
  it("consome message.received com chave estável", () => {
    expect(classificadorComercialHandler.key).toBe("classificador-comercial.v1");
    expect(classificadorComercialHandler.events).toEqual(["message.received"]);
  });
});

describe("llm_calls — a linha que IA › Execuções lê", () => {
  /**
   * Os códigos que a tela sabe explicar: as chaves de `O_QUE_FAZER`, lidas da
   * própria rota. Código fora dessa lista é erro sem linha de conserto — o
   * defeito do `erro_legado` (tests/unit/log-invocation-classifica-erro.test.ts).
   */
  function codigosQueATelaExplica(): Set<string> {
    const rota = readFileSync(join(process.cwd(), "app/api/v1/ai/runs/route.ts"), "utf8");
    const bloco = /const O_QUE_FAZER[^{]*\{([\s\S]*?)\n\};/.exec(rota)?.[1] ?? "";
    return new Set(Array.from(bloco.matchAll(/^\s{2}([a-z_]+):/gm), (m) => m[1]!));
  }

  function adminFalso() {
    const linhas: Array<Record<string, unknown>> = [];
    const admin = {
      from: (tabela: string) => ({
        insert: async (linha: Record<string, unknown>) => {
          linhas.push({ tabela, ...linha });
          return { error: null };
        },
      }),
    };
    return { admin: admin as never, linhas };
  }

  it("sucesso: purpose commercial_classify, custo e tokens da resposta, sem erro", async () => {
    const { admin, linhas } = adminFalso();
    registrarNoLlmCalls(admin)({
      organizationId: "org-1",
      contactId: "contato-1",
      modelo: "jev-1.13.0",
      tokensDeEntrada: 700,
      custoEmCentavos: 0.00294,
      latenciaMs: 180,
      falha: null,
    });
    await vi.waitFor(() => expect(linhas).toHaveLength(1));
    expect(linhas[0]).toMatchObject({
      tabela: "llm_calls",
      organization_id: "org-1",
      contact_id: "contato-1",
      purpose: "commercial_classify",
      provider: "openrouter",
      model: "jev-1.13.0",
      input_tokens: 700,
      output_tokens: 0,
      cost_cents: 0.00294,
      latency_ms: 180,
      status: "ok",
      error_code: null,
      error_message: null,
      http_status: null,
    });
  });

  it("falha: custo null (nunca 0), tokens 0 e o código no vocabulário da tela", async () => {
    const { admin, linhas } = adminFalso();
    registrarNoLlmCalls(admin)({
      organizationId: "org-1",
      contactId: "contato-1",
      modelo: "typesafe/jev-1.13",
      tokensDeEntrada: null,
      custoEmCentavos: null,
      latenciaMs: 90,
      falha: { tipo: "conta", status: 402, detalhe: "Insufficient credits" },
    });
    await vi.waitFor(() => expect(linhas).toHaveLength(1));
    expect(linhas[0]).toMatchObject({
      status: "erro",
      cost_cents: null,
      input_tokens: 0,
      error_code: "limite_ou_saldo",
      error_message: "Insufficient credits",
      http_status: 402,
    });
  });

  it("toda falha do Jev vira um código que a tela sabe explicar", () => {
    const explicados = codigosQueATelaExplica();
    expect(explicados.size, "a leitura de O_QUE_FAZER achou os códigos").toBeGreaterThanOrEqual(5);
    const falhas: Array<[FalhaDoJev, string]> = [
      [{ tipo: "conta", status: 401, detalhe: "" }, "credencial_recusada"],
      [{ tipo: "conta", status: 403, detalhe: "" }, "credencial_recusada"],
      [{ tipo: "conta", status: null, detalhe: "chave malformada" }, "credencial_recusada"],
      [{ tipo: "conta", status: 402, detalhe: "" }, "limite_ou_saldo"],
      [{ tipo: "temporaria", status: 429, detalhe: "" }, "limite_ou_saldo"],
      [{ tipo: "temporaria", status: 529, detalhe: "" }, "provedor_indisponivel"],
      [{ tipo: "temporaria", status: null, detalhe: "TimeoutError" }, "provedor_indisponivel"],
      [{ tipo: "contrato", status: 404, detalhe: "" }, "modelo_inexistente"],
      [{ tipo: "contrato", status: 200, detalhe: "resposta fora do formato esperado" }, "erro_desconhecido"],
    ];
    for (const [falha, esperado] of falhas) {
      const codigo = codigoDeErroDaFalha(falha);
      expect(codigo, `${falha.tipo}/${falha.status}`).toBe(esperado);
      expect(explicados.has(codigo), `${codigo} sem linha em O_QUE_FAZER`).toBe(true);
    }
  });
});
