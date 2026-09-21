import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O turno COMPLETO entrega ao modelo a ferramenta de transferência com o catálogo
 * de setores lido do banco — defeito medido em produção: sem o catálogo, o modelo
 * não consultou `crm_list_teams` e passou `team: "fornecedores"`, que não existe.
 *
 * O que só este arquivo prova: o caminho real do banco até o que o MODELO recebe —
 * `attendance_teams` (com um setor arquivado, que não pode aparecer) → a query do
 * validador → o JSON Schema e a descrição que chegam ao provider. O modelo falso
 * captura as ferramentas do request, como um provider as veria.
 *
 * Harness de `limite-de-envios-por-turno.test.ts`.
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
  max: 2,
});

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

interface FerramentaVista {
  type: string;
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { enum?: string[]; type?: string }> };
}

interface Cenario {
  org: string;
  contato: string;
  sessao: string;
  conversa: string;
  mensagem: string;
}

async function semeiaCenario(slug: string): Promise<Cenario> {
  const c: Cenario = {
    org: randomUUID(),
    contato: randomUUID(),
    sessao: randomUUID(),
    conversa: randomUUID(),
    mensagem: randomUUID(),
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2,$3,$4)`,
    [c.org, slug, slug, slug],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Lead',$3)`,
    [c.contato, c.org, `+55119${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,$3,'WORKING','\\x00'::bytea)`,
    [c.sessao, c.org, `${slug}-session`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [c.conversa, c.org, c.contato, c.sessao],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Quero vender meu produto para vocês','external_device', now())`,
    [c.mensagem, c.org, c.conversa, c.sessao, c.contato],
  );
  return c;
}

/** Roda um turno e devolve a ferramenta de transferência como o provider a recebeu. */
async function transferenciaVistaPeloModelo(c: Cenario): Promise<FerramentaVista> {
  let vistas: FerramentaVista[] | null = null;
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 4,
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
    registry: m.createFakeRegistry((async (o: { tools?: FerramentaVista[] }) => {
      if (o.tools?.length && vistas === null) vistas = o.tools;
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }) as never),
    channel: () =>
      ({
        channel: "captura",
        send: async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }),
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });

  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, c.org, {
    kind: "inbound_turn",
    leadId: c.contato,
    payload: {
      conversation_id: c.conversa,
      contact_id: c.contato,
      channel_session_id: c.sessao,
      inbound_message_id: c.mensagem,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "setores", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  await handler(claimed!, pool, { workerId: "setores" });
  await m.queue.completeJob(pool, claimed!.id, "setores");

  const transferencia = (vistas ?? ([] as FerramentaVista[])).find(
    (t) => t.name === "request_human_handoff",
  );
  expect(transferencia, "a ferramenta de transferência não chegou ao modelo").toBeDefined();
  return transferencia!;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
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

describe("a ferramenta de transferência que o modelo recebe", () => {
  it("organização SEM setores: a ferramenta de sempre, sem enum", async () => {
    const c = await semeiaCenario("sem-setores");
    const t = await transferenciaVistaPeloModelo(c);
    expect(t.inputSchema.properties?.team?.enum).toBeUndefined();
    expect(t.description).toContain("consulte crm_list_teams");
  });

  it("organização COM setores: enum dos slugs ativos e o 'quando usar' na descrição", async () => {
    const c = await semeiaCenario("com-setores");
    // Os cinco setores da medição, e um arquivado que NÃO pode aparecer.
    const setores: Array<[string, string, string, boolean]> = [
      ["comercial", "Comercial", "Planos, preços e contratação.", false],
      ["cobranca", "Cobrança", "Boleto, 2ª via, pagamento em atraso.", false],
      ["suporte-tecnico", "Suporte técnico", "Internet lenta ou sem conexão.", false],
      ["cancelamentos", "Cancelamentos", "Pedido de cancelamento do plano.", false],
      [
        "fornecedores-e-parceiros",
        "Fornecedores e parceiros",
        "Quem quer vender para a empresa ou propor parceria.",
        false,
      ],
      ["antigo", "Setor antigo", "Não existe mais.", true],
    ];
    for (const [slug, name, description, arquivado] of setores) {
      await pool.query(
        `insert into attendance_teams (organization_id, name, slug, description, archived_at)
         values ($1,$2,$3,$4, case when $5::boolean then now() else null end)`,
        [c.org, name, slug, description, arquivado],
      );
    }

    const t = await transferenciaVistaPeloModelo(c);

    // Ordenado por nome — a ordem é contrato do prefixo cacheado.
    expect(t.inputSchema.properties?.team?.enum).toEqual([
      "cancelamentos",
      "cobranca",
      "comercial",
      "fornecedores-e-parceiros",
      "suporte-tecnico",
    ]);
    expect(t.description).toContain(
      "- fornecedores-e-parceiros — Fornecedores e parceiros — Quem quer vender para a empresa ou propor parceria.",
    );
    expect(t.description).not.toContain("antigo");
    // Nada volátil no prefixo: disponibilidade continua em crm_list_teams.
    expect(t.description).not.toMatch(/aberto agora|open_now|eligible_count/i);
  });
});
