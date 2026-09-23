// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FERRAMENTAS_DE_ENVIO,
  criarFilaDeEnvio,
  serializarEnvios,
} from "@/lib/agent-engine/edge/llm/fila-de-envio";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { guardServiceTools, withServiceBoundary } from "@/lib/atendimento/fronteira-server";

/**
 * As mensagens de UMA resposta saem na ordem em que o modelo as escreveu.
 *
 * Defeito medido em 21/09/2026: o modelo emitiu quatro `send_message` num step só,
 * o AI SDK executou os quatro em paralelo, e a ordem de saída foi a de CONCLUSÃO —
 * "Pra te ajudar a escolher…" chegava antes de "Oi, Carla! Eu sou a Bia…".
 *
 * Este arquivo roda pelo `generateText` DE VERDADE (só o modelo é falso): é o SDK
 * quem decide paralelizar, então é por ele que a prova tem de passar. Os casos de
 * controle mostram o defeito acontecendo — sem eles, um SDK que um dia passasse a
 * executar em série deixaria os casos da fila verdes sem provar nada.
 *
 * O turno inteiro (canal falso, cadeia `before_send` real, `withServiceJob` como no
 * worker, e a prévia do botão Testar) está em
 * `tests/invariants/envios-do-turno-saem-na-ordem.test.ts`, que precisa de banco.
 */

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const SAUDACAO = "Oi, Carla! Eu sou a Bia, da loja.";
const PERGUNTA = "Pra te ajudar a escolher: quantas pessoas usam a internet aí?";

/**
 * Modelo que, como o Sonnet medido, emite TODAS as chamadas num step só; no 2º,
 * encerra. `aoEmitir` roda no instante em que a resposta com as chamadas sai —
 * é o gancho para armar uma latência que só as execuções vão pegar.
 */
function modeloQueEmiteNumStep(
  chamadas: Array<{ toolName: string; input: object }>,
  aoEmitir?: () => void,
) {
  let passo = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      passo += 1;
      if (passo === 1) {
        aoEmitir?.();
        return {
          content: chamadas.map((c, i) => ({
            type: "tool-call" as const,
            toolCallId: `c${i + 1}`,
            toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USO,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "fim" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    },
  });
}

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * O canal falso registra a ordem em que cada corpo SAIU. Antes dele, a "cadeia":
 * um atraso por corpo — o gate com I/O lento que, na medição, a 1ª mensagem pegou
 * e as outras não.
 */
function ferramentasDoTurno(
  canal: string[],
  atraso: (corpo: string) => number,
  falhaEm?: string,
): ToolSet {
  return {
    send_message: tool({
      inputSchema: z.object({ body: z.string() }),
      execute: async ({ body }) => {
        await dorme(atraso(body));
        if (body === falhaEm) throw new Error("adapter do canal explodiu");
        canal.push(body);
        return { ok: true };
      },
    }),
    send_template: tool({
      inputSchema: z.object({ template_name: z.string() }),
      execute: async ({ template_name }) => {
        await dorme(atraso(template_name));
        canal.push(`template:${template_name}`);
        return { ok: true };
      },
    }),
    search_knowledge: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async () => ({ ok: true, results: [] }),
    }),
  };
}

async function rodaTurno(
  tools: ToolSet,
  chamadas: Array<{ toolName: string; input: object }>,
  aoEmitir?: () => void,
) {
  return generateText({
    model: modeloQueEmiteNumStep(chamadas, aoEmitir),
    prompt: "oi",
    tools,
    stopWhen: stepCountIs(3),
  });
}

const DUAS_MENSAGENS = [
  { toolName: "send_message", input: { body: SAUDACAO } },
  { toolName: "send_message", input: { body: PERGUNTA } },
];
/** A 1ª demora mais na cadeia — é o que aconteceu na medição. */
const PRIMEIRA_LENTA = (corpo: string) => (corpo === SAUDACAO ? 80 : 0);

describe("controle — o defeito existe com as ferramentas cruas", () => {
  it("o SDK executa as duas em paralelo, e a mais rápida ultrapassa a primeira", async () => {
    const canal: string[] = [];
    await rodaTurno(ferramentasDoTurno(canal, PRIMEIRA_LENTA), DUAS_MENSAGENS);
    // Se isto um dia falhar, o SDK passou a executar em série: a fila continua
    // inofensiva, mas os casos abaixo deixam de provar alguma coisa.
    expect(canal).toEqual([PERGUNTA, SAUDACAO]);
  });
});

describe("com a fila, a ordem de saída é a da resposta do modelo", () => {
  it("a saudação sai antes da pergunta, mesmo tendo demorado mais na cadeia", async () => {
    const canal: string[] = [];
    await rodaTurno(serializarEnvios(ferramentasDoTurno(canal, PRIMEIRA_LENTA)), DUAS_MENSAGENS);
    expect(canal).toEqual([SAUDACAO, PERGUNTA]);
  });

  it("quatro mensagens com latências decrescentes saem na ordem escrita", async () => {
    // O caso medido tinha quatro. Latência decrescente é o pior caso: sem a fila,
    // a ordem de saída seria exatamente a INVERSA da escrita.
    const corpos = ["um", "dois", "três", "quatro"];
    const atrasos: Record<string, number> = { um: 60, dois: 40, "três": 20, quatro: 0 };
    const canal: string[] = [];
    await rodaTurno(
      serializarEnvios(ferramentasDoTurno(canal, (c) => atrasos[c] ?? 0)),
      corpos.map((body) => ({ toolName: "send_message", input: { body } })),
    );
    expect(canal).toEqual(corpos);
  });

  it("send_template e send_message dividem a MESMA fila", async () => {
    // As duas falam com o mesmo cliente: filas separadas deixariam uma ultrapassar
    // a outra, que é o defeito com outro nome.
    const canal: string[] = [];
    await rodaTurno(
      serializarEnvios(ferramentasDoTurno(canal, (c) => (c === "boas_vindas" ? 80 : 0))),
      [
        { toolName: "send_template", input: { template_name: "boas_vindas" } },
        { toolName: "send_message", input: { body: PERGUNTA } },
      ],
    );
    expect(canal).toEqual(["template:boas_vindas", PERGUNTA]);
  });

  it("um envio que falha não trava os seguintes, e o erro dele volta ao modelo", async () => {
    const canal: string[] = [];
    const r = await rodaTurno(
      serializarEnvios(ferramentasDoTurno(canal, PRIMEIRA_LENTA, SAUDACAO)),
      DUAS_MENSAGENS,
    );
    expect(canal).toEqual([PERGUNTA]);
    // O modelo vê o erro da 1ª chamada como antes — a fila não o engole.
    const erros = r.steps[0]!.content.filter((p) => p.type === "tool-error");
    expect(erros).toHaveLength(1);
    expect(erros[0]).toMatchObject({ toolCallId: "c1" });
  });
});

/**
 * A POSIÇÃO DA FILA — a guarda de fronteira que o worker põe em volta de tudo.
 *
 * Em produção o turno roda dentro de `withServiceJob` (workers/agent-worker/main.ts),
 * e `runModelCall` envolve as ferramentas com `guardServiceTools`, que ESPERA uma
 * consulta ao banco antes de chamar o `execute`. Uma fila posta por dentro dessa
 * guarda toma a vez na ordem em que as consultas voltam — o defeito de volta. Os
 * dois casos abaixo usam a guarda de verdade, com um banco falso cuja 1ª consulta
 * depois da resposta do modelo demora (a da 1ª mensagem: a guarda chama o banco
 * na ordem das tool calls).
 */
describe("a fila tem de ficar POR FORA da guarda de fronteira", () => {
  const FRONTEIRA = {
    organization_id: "11111111-1111-4111-8111-111111111111",
    contact_id: "22222222-2222-4222-8222-222222222222",
    conversation_id: "33333333-3333-4333-8333-333333333333",
    service_revision: 1,
    demanda_id: null,
    demanda_revision: null,
  };

  /** Banco falso da guarda: a fronteira confere sempre; a 1ª consulta armada demora. */
  function bancoDaGuarda() {
    let armado = false;
    const db: Queryable = {
      query: (async () => {
        if (armado) {
          armado = false;
          await dorme(80);
        }
        return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }] };
      }) as unknown as Queryable["query"],
    };
    return { db, armar: () => (armado = true) };
  }

  async function turnoGuardado(compor: (t: ToolSet) => ToolSet): Promise<string[]> {
    const canal: string[] = [];
    const { db, armar } = bancoDaGuarda();
    await withServiceBoundary(db, FRONTEIRA, () =>
      rodaTurno(compor(ferramentasDoTurno(canal, () => 0)), DUAS_MENSAGENS, armar),
    );
    return canal;
  }

  it("controle: com a fila POR DENTRO da guarda, a ordem volta a ser a do banco", async () => {
    const canal = await turnoGuardado((t) => guardServiceTools(serializarEnvios(t))!);
    expect(canal).toEqual([PERGUNTA, SAUDACAO]);
  });

  it("com a fila POR FORA (a composição do seam), a ordem é a da resposta", async () => {
    const canal = await turnoGuardado((t) => serializarEnvios(guardServiceTools(t)!));
    expect(canal).toEqual([SAUDACAO, PERGUNTA]);
  });
});

describe("a fila em si", () => {
  it("a vez é tomada NA CHAMADA, não quando alguma promessa resolve", async () => {
    const fila = criarFilaDeEnvio();
    const ordem: string[] = [];
    const lento = fila(async () => {
      await dorme(40);
      ordem.push("lento");
    });
    const rapido = fila(async () => {
      ordem.push("rápido");
    });
    await Promise.all([lento, rapido]);
    expect(ordem).toEqual(["lento", "rápido"]);
  });

  it("quem chamou recebe o resultado — ou o erro — do SEU trabalho", async () => {
    const fila = criarFilaDeEnvio();
    const falha = fila(async () => {
      throw new Error("boom");
    });
    const depois = fila(async () => 42);
    await expect(falha).rejects.toThrow("boom");
    await expect(depois).resolves.toBe(42);
  });

  it("só as ferramentas de envio entram na fila — leitura segue em paralelo", () => {
    const tools = ferramentasDoTurno([], () => 0);
    const envolvidas = serializarEnvios(tools);
    expect([...FERRAMENTAS_DE_ENVIO].sort()).toEqual([
      "crm_enviar_cobranca_erp",
      "send_message",
      "send_template",
    ]);
    expect(envolvidas.search_knowledge).toBe(tools.search_knowledge);
    expect(envolvidas.send_message).not.toBe(tools.send_message);
    // A descrição e o schema — o que vai ao prefixo cacheado — não mudam.
    expect(envolvidas.send_message!.inputSchema).toBe(tools.send_message!.inputSchema);
  });

  it("turno sem send_template (canal que não exige template) não ganha um", () => {
    const { send_template: _, ...semTemplate } = ferramentasDoTurno([], () => 0);
    expect(Object.keys(serializarEnvios(semTemplate)).sort()).toEqual([
      "search_knowledge",
      "send_message",
    ]);
  });
});

/**
 * FIAÇÃO — o seam aplica a fila, e por fora da guarda.
 *
 * `runModelCall` é a única porta de chamada de modelo: as três conversas do agente
 * (inbound, follow-up, resposta a caso) e a prévia do botão Testar — onde o defeito
 * foi medido, e onde `applyPreviewPolicy` SUBSTITUI o `execute` do `send_message` —
 * passam por ela. É guarda de ligação: o comportamento está provado acima e no
 * invariante de turno.
 */
describe("fiação — `runModelCall` serializa os envios por fora da guarda", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/edge/llm/run-model-call.ts"),
    "utf8",
  );

  it("a guarda é aplicada primeiro, e a fila por cima dela", () => {
    expect(FONTE).toMatch(/const toolsGuardadas = guardServiceTools\(prefix\.tools\);/);
    expect(FONTE).toMatch(/serializarEnvios\(toolsGuardadas\)/);
  });

  it("e é o conjunto com a fila que vai ao `generateText`", () => {
    const chamada = FONTE.slice(FONTE.indexOf("result = await generateText({"));
    expect(chamada).toMatch(/^[\s\S]*?\n\s+tools,\n/);
    expect(chamada.slice(0, 800)).not.toMatch(/guardServiceTools\(/);
  });

  it("o turno não tem uma segunda fila por dentro", () => {
    const TURNO = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    expect(TURNO).not.toMatch(/serializarEnvios\(/);
  });
});

/**
 * A instrução de split não pode empurrar o modelo para várias chamadas.
 *
 * "Prefira várias mensagens curtas a um texto único e longo" foi lido como várias
 * CHAMADAS de `send_message` — o caminho que embaralhava. O motor já divide UM corpo
 * em mensagens (`sendInBubbles`); a instrução tem de pedir esse corpo único.
 */
describe("a instrução de split pede UM send_message", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );
  /** Só os literais de texto — o nome da variável (`splitHint`) não é o que o modelo lê. */
  const instrucao = (() => {
    const i = FONTE.indexOf("const splitHint =");
    const j = FONTE.indexOf(": '';", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const literais = FONTE.slice(i, j).match(/'[^']*'/g) ?? [];
    expect(literais.length).toBeGreaterThan(0);
    return literais.join("");
  })();

  it("pede a resposta inteira numa chamada só, em parágrafos", () => {
    expect(instrucao).toMatch(/ÚNICA chamada de send_message/);
    expect(instrucao).toMatch(/parágrafo/);
  });

  it("não volta a pedir várias mensagens em vez de um texto", () => {
    expect(instrucao).not.toMatch(/Prefira várias mensagens/);
  });

  it("não carrega jargão do motor que o modelo repetiria ao cliente", () => {
    expect(instrucao.toLowerCase()).not.toMatch(/bolha|split|chunk/);
  });
});
