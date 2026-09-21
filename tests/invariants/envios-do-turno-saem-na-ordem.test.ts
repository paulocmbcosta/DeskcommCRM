import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as AgentConfig from "@/lib/agent-engine/agent/agent-config";
import type * as Preview from "@/lib/agent-engine/agent/preview";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Fronteira from "@/lib/atendimento/fronteira-server";
import type * as TurnKnobs from "@/lib/agent-engine/agent/turn-knobs";
import type * as Env from "@/lib/agent-engine/env";
import type * as SupabaseJs from "@supabase/supabase-js";

import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";

/**
 * O TURNO COMPLETO com duas `send_message` no MESMO step — defeito medido em
 * 21/09/2026: o AI SDK executa as tool calls de um step em paralelo, e a ordem de
 * saída era a de CONCLUSÃO. "Pra te ajudar a escolher…" saía antes de "Oi, Carla!".
 *
 * Dois caminhos, porque são duas corridas diferentes:
 *
 *  • TURNO REAL, dentro de `withServiceJob` — como o worker o roda
 *    (`workers/agent-worker/main.ts`). Aqui a cadeia `before_send` segura um
 *    advisory lock por número, então os envios já saíam um de cada vez; a corrida
 *    era por QUEM pega o lock primeiro, e antes dele cada chamada passa pela guarda
 *    de fronteira (`guardServiceTools`), que consulta o banco. O banco da guarda
 *    deste teste atrasa a PRIMEIRA consulta depois da resposta do modelo — a da 1ª
 *    mensagem, porque a guarda chama o banco na ordem das tool calls. Sem
 *    `withServiceJob` a guarda é no-op e a corrida não existe: um teste fora dele
 *    ficaria verde com a fila no lugar errado.
 *
 *  • PRÉVIA do botão Testar — onde o defeito foi medido. Sem lock nem guarda; a
 *    única espera de cada envio é a camada semântica de promessa, e o classificador
 *    falso deste teste demora mais para a 1ª mensagem.
 *
 * Harness de `limite-de-envios-por-turno.test.ts` (turno real) e de
 * `autonomia-preview-core.test.ts` (prévia): `createInboundTurnHandler` e
 * `runAgentPreview` reais, modelo falso via `createFakeRegistry`, canal que CAPTURA.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
const MSG = "eeeeeeee-0000-4000-8000-000000000005";

const SAUDACAO = "Oi, Carla! Eu sou a Bia, da loja.";
const PERGUNTA = "Pra te ajudar a escolher: quantas pessoas usam a internet aí?";

/** Bem acima de qualquer ida ao banco local: a corrida tem de ter dono conhecido. */
const ATRASO_MS = 300;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  runAgentPreview: typeof InboundTurn.runAgentPreview;
  loadAgentVersionConfig: typeof AgentConfig.loadAgentVersionConfig;
  preview: typeof Preview;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  withServiceJob: typeof Fronteira.withServiceJob;
  turnKnobsFromEnv: typeof TurnKnobs.turnKnobsFromEnv;
  loadEnv: typeof Env.loadEnv;
  createClient: typeof SupabaseJs.createClient;
};
let m: Modules;

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface OpcoesDoModelo {
  prompt?: unknown;
  tools?: Array<{ type: string; name: string }>;
}

/**
 * Modelo falso: no 1º step com ferramentas, as DUAS mensagens numa resposta só (o
 * que o Sonnet fez na medição); depois, encerra. Chamada sem ferramenta é o
 * classificador de promessa (quando a prévia o liga) ou o fechamento do turno.
 */
function modeloDasDuasMensagens(opts: { aoEmitir?: () => void; classificadorLento?: boolean }) {
  let emitiu = false;
  return async (o: OpcoesDoModelo) => {
    const texto = JSON.stringify(o.prompt ?? "");
    if (texto.includes("Mensagem candidata")) {
      // A camada semântica: mais lenta para a 1ª mensagem, como na medição.
      if (opts.classificadorLento && texto.includes("Oi, Carla")) await dorme(ATRASO_MS);
      return {
        content: [{ type: "text" as const, text: '{"isPromise": false, "suspectPhrase": null}' }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    const temEnvio = o.tools?.some((t) => t.name === "send_message") ?? false;
    if (temEnvio && !emitiu) {
      emitiu = true;
      opts.aoEmitir?.();
      return {
        content: [SAUDACAO, PERGUNTA].map((body, i) => ({
          type: "tool-call" as const,
          toolCallId: `c${i + 1}`,
          toolName: "send_message",
          input: JSON.stringify({ body }),
        })),
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    runAgentPreview: (await import("@/lib/agent-engine/agent/inbound-turn")).runAgentPreview,
    loadAgentVersionConfig: (await import("@/lib/agent-engine/agent/agent-config"))
      .loadAgentVersionConfig,
    preview: await import("@/lib/agent-engine/agent/preview"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    withServiceJob: (await import("@/lib/atendimento/fronteira-server")).withServiceJob,
    turnKnobsFromEnv: (await import("@/lib/agent-engine/agent/turn-knobs")).turnKnobsFromEnv,
    loadEnv: (await import("@/lib/agent-engine/env")).loadEnv,
    createClient: (await import("@supabase/supabase-js")).createClient,
  };

  seedGov();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'envios-em-ordem','Envios em Ordem','Envios em Ordem') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Carla','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'envios-em-ordem-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi, quero saber dos planos','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

describe("turno real (withServiceJob, como o worker) — duas mensagens no mesmo step", () => {
  let enviados: string[] = [];
  beforeEach(() => {
    enviados = [];
  });

  it("saem na ordem da resposta, mesmo com a 1ª atrasada antes do lock", async () => {
    // O banco da GUARDA de fronteira: o mesmo pool, com a 1ª consulta depois da
    // resposta do modelo atrasada. Só as consultas da guarda passam por ele — é o
    // `db` do escopo de `withServiceJob`, como no worker.
    let armado = false;
    const bancoDaGuarda: Queue.Queryable = {
      query: (async (texto: string, valores?: unknown[]) => {
        if (armado) {
          armado = false;
          await dorme(ATRASO_MS);
        }
        return pool.query(texto, valores);
      }) as Queue.Queryable["query"],
    };

    const handler = m.createInboundTurnHandler({
      crmCfg: { supabase: {} as never },
      llmCfg: { anthropicApiKey: "fake" } as never,
      knobs: {
        historyLimit: 10,
        maxContextTokens: 1000,
        notesIndexMaxTokens: 500,
        maxSteps: 6,
        queuedRetryDelayMs: 1000,
        breaker: {
          exactFailureWarn: 2,
          exactFailureBlock: 5,
          sameToolFailureWarn: 3,
          sameToolFailureHalt: 8,
          noProgressWarn: 3,
          noProgressBlock: 5,
        },
      },
      log: m.createLogger(),
      registry: m.createFakeRegistry(
        modeloDasDuasMensagens({ aoEmitir: () => (armado = true) }) as never,
      ),
      channel: () =>
        ({
          channel: "captura",
          send: async (i: { body: string }) => {
            enviados.push(i.body);
            return {
              kind: "sent" as const,
              idempotencyKey: `k${enviados.length}`,
              messageId: `m${enviados.length}`,
            };
          },
          sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
          capabilities: () => ({ freeform: true, media: true, audio: true }),
          costPerMessage: () => ({ currency: "BRL", cents: 0 }),
        }) as never,
      // Terça, 15h BRT: dentro da janela anti-ban — sem isto o `pacing` vetaria
      // por horário e o teste mediria o motivo errado.
      clock: () => new Date("2026-07-28T18:00:00Z"),
      sleep: async () => {},
    });

    const fronteira = (
      await pool.query(
        "select fn_service_boundary($1,$2)-'status'-'demanda_fechada_em'-'service_started_at' as b",
        [ORG, CONV],
      )
    ).rows[0].b;
    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTACT,
      payload: {
        conversation_id: CONV,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        inbound_message_id: MSG,
        crm_event_id: randomUUID(),
        service_boundary: fronteira,
      },
      maxAttempts: 1,
    });
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "envios-em-ordem", maxConcurrency: 1 });
    expect(claimed?.id).toBe(job.id);

    await m.withServiceJob(bancoDaGuarda, claimed!, () =>
      handler(claimed!, pool, { workerId: "envios-em-ordem" }),
    );
    await m.queue.completeJob(pool, claimed!.id, "envios-em-ordem");

    // Guarda de vacuidade: o atraso foi consumido — senão a corrida nem aconteceu.
    expect(armado).toBe(false);
    expect(enviados).toEqual([SAUDACAO, PERGUNTA]);
  });
});

describe("prévia do botão Testar — onde o defeito foi medido", () => {
  it("as candidatas saem na ordem da resposta, mesmo com o classificador lento na 1ª", async () => {
    const f = await replyFixture(pool);
    const agent = (await m.loadAgentVersionConfig(pool, f.org, f.agent, f.version))!;
    const result = m.preview.newPreviewResult();
    const preview: Preview.TurnPreview = {
      kind: "sandbox",
      organizationId: f.org,
      runId: randomUUID(),
      agent,
      contactId: null,
      channelId: f.channel,
      context: m.preview.scenarioContext([
        {
          direction: "inbound",
          body: "Oi, quero saber dos planos",
          sent_at: "2026-09-21T14:00:00Z",
        },
      ]),
      result,
    };

    // Knobs do ambiente, como `autonomia-preview-core.test.ts`: a prévia é o
    // caminho do botão Testar, com a configuração que o app de fato carrega.
    const knobs = m.turnKnobsFromEnv(
      m.loadEnv({
        NODE_ENV: "test",
        SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "test-key",
      }),
    );
    delete knobs.stageClassifier;
    delete knobs.jailbreak;
    // A camada semântica de promessa LIGADA: é a espera por envio que a prévia
    // tem, e a que embaralhou a medição.
    knobs.promiseSemantic = { enabled: true };

    await m.runAgentPreview(
      {
        crmCfg: { supabase: m.createClient("http://127.0.0.1:1", "test-key") },
        llmCfg: { anthropicApiKey: "fake-local" },
        knobs,
        log: m.createLogger(),
        clock: () => new Date("2026-09-21T15:00:00Z"),
        embed: async () => ({
          embedding: Array(1536).fill(0.1),
          promptTokens: 0,
          model: "text-embedding-3-small",
        }),
        registry: m.createFakeRegistry(
          modeloDasDuasMensagens({ classificadorLento: true }) as never,
        ),
      },
      pool,
      preview,
    );

    expect(result.candidates.map((c) => c.body)).toEqual([SAUDACAO, PERGUNTA]);
  });
});
