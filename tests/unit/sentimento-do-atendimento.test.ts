/**
 * O SENTIMENTO É DO ATENDIMENTO, NÃO DA ÚLTIMA FRASE.
 *
 * ## O defeito medido (dono, produção, 2026-09-25)
 *
 * O worker classificava cada mensagem SOZINHA, com um modelo de conversa, e a
 * nota da conversa era a da última: dez mensagens de reclamação deixavam o
 * atendimento "insatisfeito", e um "ok, obrigado" na décima primeira o
 * devolvia a "satisfeito".
 *
 * ## O que estes testes cobram
 *
 *  - o Jev recebe o ATENDIMENTO INTEIRO (as reclamações E o "ok"), não só a
 *    mensagem que disparou — é isso que impede a nota de virar com uma frase;
 *  - a pergunta manda pesar o histórico;
 *  - a escala de 5 níveis cai nas faixas da tela;
 *  - rajada, áudio, chave ausente e falha temporária têm desfecho declarado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));

import { logInvocation } from "@/lib/ai/log-invocation";
import type { MensagemParaEstado } from "@/lib/classificador-comercial/perguntas";
import type { EntradaDoSystemOne, ResultadoDoSystemOne } from "@/lib/classificador-comercial/jev";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { faixaDoSentimento } from "@/lib/inbox/sentimento";
import {
  LIMITE_DE_FALAS_DO_ATENDIMENTO,
  lerRespostaDeSatisfacao,
  montarEstadoDoAtendimento,
  NIVEIS_DE_SATISFACAO,
  notaDoScore,
  PERGUNTAS_DE_SATISFACAO,
} from "@/lib/sentimento/avaliacao-do-atendimento";
import { processSentiment, type DependenciasDoSentimento } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const OUTRA = "44444444-4444-4444-8444-444444444444";

/** Dez reclamações e um "ok" no fim — o caso que o dono mediu. */
const ATENDIMENTO_RUIM: MensagemParaEstado[] = [
  ...Array.from({ length: 10 }, (_, i) => [
    { direcao: "inbound" as const, texto: `Já é a ${i + 1}ª vez que peço e ninguém resolve minha internet` },
    { direcao: "outbound" as const, texto: "Vou verificar, um momento." },
  ]).flat(),
  { direcao: "inbound", texto: "ok, obrigado" },
];

describe("a pergunta que vai ao Jev", () => {
  it("é uma pergunta `score` só, com cinco níveis do pior ao melhor", () => {
    expect(Object.keys(PERGUNTAS_DE_SATISFACAO)).toEqual(["satisfacao"]);
    expect(PERGUNTAS_DE_SATISFACAO.satisfacao.type).toBe("score");
    expect(PERGUNTAS_DE_SATISFACAO.satisfacao.criteria).toHaveLength(5);
    expect(NIVEIS_DE_SATISFACAO[0]).toMatch(/^Muito insatisfeito/);
    expect(NIVEIS_DE_SATISFACAO[2]).toMatch(/^Neutro/);
    expect(NIVEIS_DE_SATISFACAO[4]).toMatch(/^Muito satisfeito/);
  });

  it("manda pesar o atendimento inteiro — um 'ok' no fim não apaga reclamação sem solução", () => {
    const i = PERGUNTAS_DE_SATISFACAO.satisfacao.instructions;
    expect(i).toMatch(/INTEIRA/);
    expect(i).toMatch(/NÃO apaga reclamações anteriores/);
  });

  it("descrever um defeito sem reclamar do atendimento é neutro (o falso alarme do classificador antigo)", () => {
    expect(NIVEIS_DE_SATISFACAO[2]).toMatch(/descrever um defeito/);
  });
});

describe("a escala na régua da tela", () => {
  it("cada nível puro cai na faixa de mesmo nome", () => {
    expect(faixaDoSentimento(notaDoScore(0))).toBe("critico");
    expect(faixaDoSentimento(notaDoScore(1))).toBe("insatisfeito");
    expect(faixaDoSentimento(notaDoScore(2))).toBe("neutro");
    expect(faixaDoSentimento(notaDoScore(3))).toBe("satisfeito");
    expect(faixaDoSentimento(notaDoScore(4))).toBe("satisfeito");
  });

  it("normaliza para 0..1 com 3 casas, e prende fora da faixa", () => {
    expect(notaDoScore(1.05)).toBe(0.263);
    expect(notaDoScore(-1)).toBe(0);
    expect(notaDoScore(9)).toBe(1);
  });
});

describe("o estado: o atendimento, não a frase", () => {
  it("leva todas as falas do atendimento, na ordem, rotuladas", () => {
    const e = montarEstadoDoAtendimento(ATENDIMENTO_RUIM);
    expect(e?.conversa).toHaveLength(21);
    expect(e?.conversa[0]).toEqual({ quem: "cliente", texto: "Já é a 1ª vez que peço e ninguém resolve minha internet" });
    expect(e?.conversa.at(-1)).toEqual({ quem: "cliente", texto: "ok, obrigado" });
  });

  it("atendimento longo perde as falas MAIS ANTIGAS, nunca as recentes", () => {
    const muitas: MensagemParaEstado[] = Array.from({ length: 80 }, (_, i) => ({ direcao: "inbound", texto: `fala ${i}` }));
    const e = montarEstadoDoAtendimento(muitas);
    expect(e?.conversa).toHaveLength(LIMITE_DE_FALAS_DO_ATENDIMENTO);
    expect(e?.conversa.at(-1)?.texto).toBe("fala 79");
  });

  it("sem fala do cliente com texto não há o que avaliar", () => {
    expect(montarEstadoDoAtendimento([{ direcao: "outbound", texto: "Promoção!" }, { direcao: "inbound", texto: null }])).toBeNull();
  });
});

describe("a resposta do Jev", () => {
  it("traduz score, confiança e custo real", () => {
    const r = lerRespostaDeSatisfacao(
      { model: "typesafe/jev-1.13-x", answers: { satisfacao: { score: 0.4, confidence: 0.9 } }, usage: { input_tokens: 500, cost: 0.00002 } },
      "typesafe/jev-1.13",
    );
    expect(r).toEqual({
      ok: true,
      avaliacao: { nota: 0.1, confianca: 0.9, modelo: "typesafe/jev-1.13-x", tokensDeEntrada: 500, custoEmCentavos: 0.002 },
    });
  });

  it("score ausente ou fora da escala reprova — nota inventada é pior que nota nenhuma", () => {
    expect(lerRespostaDeSatisfacao({ answers: {} }, "m").ok).toBe(false);
    expect(lerRespostaDeSatisfacao({ answers: { satisfacao: { score: 7 } } }, "m").ok).toBe(false);
  });
});

// ── O worker ────────────────────────────────────────────────────────────────

type Linha = Record<string, unknown>;

function fazerAdmin(tabelas: Record<string, Linha[]>, rpcs: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const resolver = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_a, prop: string) => {
          if (prop === "maybeSingle") return () => Promise.resolve({ data: resolver()[0] ?? null, error: null });
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve({ data: resolver(), error: null }).then(ok);
          return (...args: unknown[]) => {
            const [col, val] = args as [string, unknown];
            if (prop === "eq") filtros.push((l) => l[col] === val);
            if (prop === "neq") filtros.push((l) => l[col] !== val);
            if (prop === "is") filtros.push((l) => (l[col] ?? null) === val);
            if (prop === "gt") filtros.push((l) => l[col] != null && (l[col] as never) > (val as never));
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

const AGORA = new Date("2026-09-25T15:00:00.000Z");

function mensagem(extra: Linha = {}): Linha {
  return {
    id: MSG,
    organization_id: ORG,
    conversation_id: CONV,
    direction: "inbound",
    type: "text",
    media_derived_status: null,
    sent_at: "2026-09-25T14:59:00.000Z",
    created_at: "2026-09-25T14:59:00.000Z",
    ...extra,
  };
}

function evento(idadeMs = 1_000): EventRow {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG,
    entity_id: MSG,
    created_at: new Date(AGORA.getTime() - idadeMs).toISOString(),
    payload: { message_id: MSG, conversation_id: CONV },
  } as unknown as EventRow;
}

interface Montagem {
  mensagens?: Linha[];
  resposta?: ResultadoDoSystemOne;
  semChave?: boolean;
  /** Sem chave da OpenRouter E sem chave de IA nenhuma. */
  semIa?: boolean;
  nivelDoModelo?: number;
  historico?: MensagemParaEstado[];
}

function montar(m: Montagem = {}) {
  const rpcs: Linha[] = [];
  const pedidos: EntradaDoSystemOne[] = [];
  const pedidosAoModelo: Array<{ system?: string; prompt?: unknown }> = [];
  const deps: DependenciasDoSentimento = {
    admin: fazerAdmin(
      {
        messages: m.mensagens ?? [mensagem()],
        conversations: [{ id: CONV, organization_id: ORG, channel_session_id: null, active_ai_agent_id: null }],
        ai_agents: [],
        ai_agent_versions: [],
      },
      rpcs,
    ) as unknown as DependenciasDoSentimento["admin"],
    dados: { ultimasMensagens: async () => m.historico ?? ATENDIMENTO_RUIM },
    chave: async () => (m.semChave ? null : { apiKey: "sk-or-teste-0000", origem: "instalacao" as const }),
    consultar: async (entrada) => {
      pedidos.push(entrada);
      return (
        m.resposta ?? {
          ok: true,
          corpo: { answers: { satisfacao: { type: "score", score: 0.8 } }, usage: { input_tokens: 700 } },
          status: 200,
          latenciaMs: 280,
        }
      );
    },
    modeloDoPonto: async () =>
      m.semIa ? null : ({ model: "modelo-dublê", modelId: "anthropic/claude-haiku-4-5" } as never),
    gerarObjeto: (async (args: { system?: string; prompt?: unknown }) => {
      pedidosAoModelo.push(args);
      return { object: { justificativa: "reclama há dez mensagens", nivel: m.nivelDoModelo ?? 1 }, usage: { inputTokens: 900, outputTokens: 20 } };
    }) as unknown as DependenciasDoSentimento["gerarObjeto"],
    agora: () => AGORA,
  };
  return { deps, rpcs, pedidos, pedidosAoModelo };
}

beforeEach(() => vi.clearAllMocks());

describe("processSentiment — avalia o atendimento", () => {
  it("manda ao Jev o atendimento inteiro e grava a nota dele na conversa e na mensagem", async () => {
    const { deps, rpcs, pedidos } = montar();
    const r = await processSentiment(evento(), deps);

    expect(r).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.perguntas).toBe(PERGUNTAS_DE_SATISFACAO);
    const conversa = (pedidos[0]?.estado as { conversa: Array<{ texto: string }> }).conversa;
    // As reclamações vão junto com o "ok" — é o que impede a nota de virar por uma frase.
    expect(conversa).toHaveLength(21);
    expect(conversa[0]?.texto).toMatch(/ninguém resolve/);

    const naConversa = rpcs.find((x) => x["nome"] === "fn_registrar_sentimento_da_conversa");
    expect(naConversa).toMatchObject({ p_org: ORG, p_conversation: CONV, p_score: 0.2, p_em: "2026-09-25T14:59:00.000Z" });
    const naMensagem = rpcs.find((x) => x["nome"] === "fn_mesclar_metadata_da_mensagem");
    expect(naMensagem?.["p_patch"]).toMatchObject({ sentiment_score: 0.2, sentiment_escopo: "atendimento" });
    // 0,2 < 0,3 (padrão): a linha do tempo recebe o alerta.
    expect(rpcs.some((x) => x["p_event_type"] === "ai.sentiment_alert")).toBe(true);
  });

  it("toda chamada vira linha de telemetria (IA › Execuções), com o modelo do Jev", async () => {
    const { deps } = montar();
    await processSentiment(evento(), deps);
    expect(vi.mocked(logInvocation)).toHaveBeenCalledWith(
      expect.objectContaining({ invocation_kind: "sentiment_classify", model: "typesafe/jev-1.13", prompt_tokens: 700, conversation_id: CONV }),
    );
  });

  it("rajada: mensagem mais nova do cliente já vai avaliar tudo — esta não chama o Jev", async () => {
    const { deps, pedidos } = montar({
      mensagens: [mensagem(), mensagem({ id: OUTRA, sent_at: "2026-09-25T14:59:30.000Z" })],
    });
    expect(await processSentiment(evento(), deps)).toMatchObject({ skipped: true, reason: "coberta_por_mensagem_mais_nova" });
    expect(pedidos).toHaveLength(0);
  });

  it("áudio ainda sem transcrição: espera, em vez de avaliar sem a fala", async () => {
    const { deps, pedidos } = montar({ mensagens: [mensagem({ type: "audio" })] });
    const r = await processSentiment(evento(), deps);
    expect(r.reason).toBe("aguardando_transcricao");
    expect(r.retryAt).toBeInstanceOf(Date);
    expect(pedidos).toHaveLength(0);
  });

  it("áudio que passou do teto de espera é avaliado com o que houver", async () => {
    const { deps, pedidos } = montar({ mensagens: [mensagem({ type: "audio" })] });
    await processSentiment(evento(5 * 60_000), deps);
    expect(pedidos).toHaveLength(1);
  });

  it("sem chave da OpenRouter: a MESMA pergunta, sobre o atendimento inteiro, vai ao modelo de conversa", async () => {
    const { deps, rpcs, pedidos, pedidosAoModelo } = montar({ semChave: true, nivelDoModelo: 1 });
    const r = await processSentiment(evento(), deps);

    expect(r).toEqual({ skipped: false, sentiment_score: 0.25 });
    expect(pedidos).toHaveLength(0);
    expect(pedidosAoModelo).toHaveLength(1);
    expect(pedidosAoModelo[0]?.system).toMatch(/NÃO apaga reclamações anteriores/);
    expect(pedidosAoModelo[0]?.system).toMatch(/0 = Muito insatisfeito/);
    const linhas = String(pedidosAoModelo[0]?.prompt).split("\n");
    expect(linhas).toHaveLength(21);
    expect(linhas[0]).toMatch(/^Cliente: Já é a 1ª vez/);
    expect(linhas.at(-1)).toBe("Cliente: ok, obrigado");
    const naMensagem = rpcs.find((x) => x["nome"] === "fn_mesclar_metadata_da_mensagem");
    expect(naMensagem?.["p_patch"]).toMatchObject({ sentiment_score: 0.25, sentiment_motor: "modelo_de_conversa" });
  });

  it("sem chave de IA nenhuma: pula, com o motivo — e não grava nota nenhuma", async () => {
    const { deps, rpcs } = montar({ semChave: true, semIa: true });
    expect(await processSentiment(evento(), deps)).toMatchObject({ skipped: true, reason: "sem_chave_de_ia" });
    expect(rpcs).toHaveLength(0);
  });

  it("falha temporária do Jev: tenta de novo; passado o teto, desiste sem nota", async () => {
    const resposta: ResultadoDoSystemOne = { ok: false, latenciaMs: 5000, falha: { tipo: "temporaria", status: 503, detalhe: "x" } };
    const cedo = montar({ resposta });
    const r1 = await processSentiment(evento(), cedo.deps);
    expect(r1.retryAt).toBeInstanceOf(Date);

    const tarde = montar({ resposta });
    const r2 = await processSentiment(evento(20 * 60_000), tarde.deps);
    expect(r2).toMatchObject({ skipped: true, reason: "jev_falhou:temporaria" });
    expect(r2.retryAt).toBeUndefined();
    expect(tarde.rpcs.some((x) => x["nome"] === "fn_registrar_sentimento_da_conversa")).toBe(false);
  });

  it("resposta fora do formato: telemetria de erro, sem nota", async () => {
    const { deps, rpcs } = montar({ resposta: { ok: true, corpo: { answers: {} }, status: 200, latenciaMs: 10 } });
    expect(await processSentiment(evento(), deps)).toMatchObject({ skipped: true, reason: "jev_falhou:contrato" });
    expect(vi.mocked(logInvocation)).toHaveBeenCalledWith(expect.objectContaining({ finish_reason: "error" }));
    expect(rpcs).toHaveLength(0);
  });

  it("mensagem de saída não dispara avaliação", async () => {
    const { deps, pedidos } = montar({ mensagens: [mensagem({ direction: "outbound" })] });
    expect(await processSentiment(evento(), deps)).toMatchObject({ skipped: true, reason: "not_inbound" });
    expect(pedidos).toHaveLength(0);
  });
});
