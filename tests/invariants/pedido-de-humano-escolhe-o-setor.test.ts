import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O TURNO INTEIRO, CONTRA POSTGRES DE VERDADE: quem pede um atendente entra na
 * fila do SETOR CERTO — e a escolha do setor nunca atrasa nem derruba a passagem.
 *
 * ## O defeito, medido em produção (2026-10-02, protocolo 20261002000072)
 *
 * Um lead chegou do site de comparação de planos com a mensagem pronta
 * "…quero falar com um atendente…", plano e endereço já escolhidos. A detecção
 * determinística casou, a conversa foi passada SEM TIME, e o rodízio a entregou
 * a um atendente do Suporte, que precisou transferi-la à mão para o Comercial.
 * Em 7 dias: 20 passagens por este desvio, 16 com troca manual de time.
 *
 * Quem escolhia o setor era só a ferramenta `request_human_handoff` — que o
 * desvio, por rodar antes do modelo, nunca alcança.
 *
 * ## Por que banco de verdade
 *
 * O unit de `human-handoff.test.ts` prova a ordem das queries num pool falso. Ele
 * não prova que o DESVIO injeta o resolvedor, nem que o que chega ao modelo é a
 * conversa real, nem que `conversations.team_id` fica gravado. E a ordem que
 * importa — o aviso sai e a trava arma ANTES de qualquer modelo — só se mede
 * olhando o banco de dentro do envio e de dentro da chamada de modelo.
 *
 * ## Harness
 *
 * O mesmo de `handoff-avisa-o-lead.test.ts`. O modelo de mentira aqui é ATOR em
 * metade dos casos (responde o setor) e continua CONTROLE na outra (organização
 * sem times não pode chamá-lo).
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

const ORG = "eeee0000-0000-4000-8000-0000000000a1";
const CONTACT = "eeee0000-0000-4000-8000-0000000000a2";
const SESSION = "eeee0000-0000-4000-8000-0000000000a3";
const CONV = "eeee0000-0000-4000-8000-0000000000a4";
const TIME_COMERCIAL = "eeee0000-0000-4000-8000-0000000000b1";
const TIME_SUPORTE = "eeee0000-0000-4000-8000-0000000000b2";

/** A mensagem pronta do site de comparação, com dados inventados. */
const PEDIDO_COMERCIAL =
  "Vim do Melhor Plano e quero falar com um atendente da operadora\n" +
  "*Plano:* Internet 500 MEGA\n*Preço*: R$ 97,00\n*Endereço de instalação*: Rua das Flores, 10";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

interface ChamadaDeModelo {
  prompt: string;
  /** `contacts.force_human` NO INSTANTE da chamada — a prova de que a trava veio antes. */
  forceHumanNaChamada: boolean;
  /** Quantos envios ao lead já tinham saído — a prova de que o aviso veio antes. */
  enviosAntes: number;
}

let enviados: Array<{ body: string; modelosAntes: number }> = [];
let chamadasDeModelo: ChamadaDeModelo[] = [];
/** O que o modelo de mentira responde. `null` = lança, como um provedor fora do ar. */
let respostaDoModelo: string | null = null;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function modeloDeMentira() {
  return async (opcoes: { prompt: unknown }) => {
    const { rows } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where id = $1",
      [CONTACT],
    );
    chamadasDeModelo.push({
      prompt: JSON.stringify(opcoes.prompt),
      forceHumanNaChamada: rows[0]?.force_human === true,
      enviosAntes: enviados.length,
    });
    if (respostaDoModelo === null) throw new Error("provedor fora do ar");
    return {
      content: [{ type: "text" as const, text: respostaDoModelo }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function montaHandler() {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
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
    registry: m.createFakeRegistry(modeloDeMentira() as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push({ body: i.body, modelosAntes: chamadasDeModelo.length });
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
    // Terça, 15h BRT: dentro da janela anti-ban. Sem isto o gate de horário
    // vetaria o aviso e o arquivo mediria o motivo errado.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

/** Grava um inbound e roda UM turno completo por cima dele. */
async function rodaTurnoCom(texto: string): Promise<void> {
  const msgId = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device', now())`,
    [msgId, ORG, CONV, SESSION, CONTACT, texto],
  );
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msgId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "setor", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, pool, { workerId: "setor" });
    await m.queue.completeJob(pool, claimed!.id, "setor");
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "setor", err);
    throw err;
  }
}

async function conversa() {
  const { rows } = await pool.query<{
    team_id: string | null;
    status: string;
    silencio: string | null;
    motivo: string | null;
  }>(
    `select team_id, status, bot_silenced_until::text as silencio, last_handoff_reason as motivo
       from conversations where id = $1`,
    [CONV],
  );
  return rows[0]!;
}

async function cadastraTimes(): Promise<void> {
  await pool.query(
    `insert into attendance_teams (id, organization_id, name, slug, description) values
       ($1,$3,'Comercial','comercial','Quem quer contratar internet, trocar de plano ou agendar a instalação.'),
       ($2,$3,'Suporte Técnico','suporte-tecnico','Internet sem sinal, lenta ou caindo.')`,
    [TIME_COMERCIAL, TIME_SUPORTE, ORG],
  );
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
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'pedido-escolhe-setor','Pedido Escolhe Setor','Pedido Escolhe Setor') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pedido-escolhe-setor-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
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

beforeEach(async () => {
  enviados = [];
  chamadasDeModelo = [];
  respostaDoModelo = '{"setor":"comercial","confidence":0.93}';
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from attendance_teams where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number, force_human)
     values ($1,$2,'Lead que pede humano','+5511900000888', false)`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

describe("pedido de atendente numa organização COM times", () => {
  beforeEach(cadastraTimes);

  it("a conversa entra na fila do setor que o assunto pede", async () => {
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    const c = await conversa();
    expect(c.motivo, "o desvio determinístico não rodou — o teste mediu outra coisa").toBe(
      "requested_human",
    );
    expect(c.team_id, "o defeito original: pedido de humano passado SEM time").toBe(TIME_COMERCIAL);
  });

  it("o classificador leu a conversa REAL e os setores da organização", async () => {
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect(chamadasDeModelo).toHaveLength(1);
    const prompt = chamadasDeModelo[0]!.prompt;
    expect(prompt).toContain("500 MEGA");
    expect(prompt).toContain("comercial");
    expect(prompt).toContain("Internet sem sinal");
  });

  it("o aviso ao lead saiu ANTES de qualquer modelo ser chamado", async () => {
    // A escalação não pode esperar um provedor: quem pede um atendente ouve na
    // hora, e o setor se decide depois.
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.modelosAntes, "o aviso esperou o classificador").toBe(0);
    expect(chamadasDeModelo[0]!.enviosAntes).toBe(1);
  });

  it("o modelo só é chamado com a IA já fora da conversa", async () => {
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect(
      chamadasDeModelo[0]!.forceHumanNaChamada,
      "o setor foi escolhido antes da trava — um modelo lento seguraria a passagem",
    ).toBe(true);
  });

  it("o rodízio é pedido DEPOIS de o time estar gravado", async () => {
    // O pedido que nasce com a conversa fica pendente (aqui não há cron). O que
    // importa é que, depois da passagem, existe um pedido aberto e a conversa
    // que ele aponta JÁ tem time: o cron que o atender filtra pelo setor.
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    const { rows } = await pool.query<{ status: string }>(
      `select status from event_log
        where organization_id = $1 and event_type = 'conversation.routing_requested'
          and payload->>'conversation_id' = $2 and status = 'pending'`,
      [ORG, CONV],
    );
    expect(rows.length, "nenhum pedido de rodízio aberto — a conversa não seria distribuída").toBeGreaterThan(0);
    expect((await conversa()).team_id).toBe(TIME_COMERCIAL);
  });

  it("a Central conta que o setor foi escolhido automaticamente", async () => {
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    const { rows } = await pool.query<{ body: string }>(
      "select body from agent_inbox_items where organization_id = $1 and kind = 'handoff'",
      [ORG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain("Setor escolhido automaticamente: Comercial");
  });

  it("modelo fora do ar: a passagem acontece inteira, só que sem time", async () => {
    respostaDoModelo = null;
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    const c = await conversa();
    expect(c.status).toBe("pending");
    expect(c.silencio).toBe("infinity");
    expect(c.motivo).toBe("requested_human");
    expect(c.team_id, "falha do classificador gravou um time").toBeNull();
    expect(enviados, "o lead ficou sem aviso porque o classificador falhou").toHaveLength(1);
  });

  it("setor que não existe na organização não é gravado", async () => {
    respostaDoModelo = '{"setor":"financeiro","confidence":0.99}';
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect((await conversa()).team_id).toBeNull();
  });

  it("confiança baixa: fila geral", async () => {
    respostaDoModelo = '{"setor":"comercial","confidence":0.3}';
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect((await conversa()).team_id).toBeNull();
  });

  it("time ARQUIVADO não recebe a conversa, mesmo que o modelo o escolha", async () => {
    await pool.query("update attendance_teams set archived_at = now() where id = $1", [TIME_COMERCIAL]);
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    expect((await conversa()).team_id).toBeNull();
  });
});

describe("pedido de atendente numa organização SEM times", () => {
  it("nenhum modelo é chamado: o desvio segue sem gastar token", async () => {
    await rodaTurnoCom(PEDIDO_COMERCIAL);
    const c = await conversa();
    expect(c.motivo).toBe("requested_human");
    expect(c.team_id).toBeNull();
    expect(chamadasDeModelo, "classificou setor onde não há setor para escolher").toHaveLength(0);
  });
});

describe("suspeita de opt-out, mesmo com times", () => {
  beforeEach(cadastraTimes);

  it("não escolhe setor: quem confirma bloqueio não é uma fila de atendimento", async () => {
    await rodaTurnoCom("não quero mais receber mensagens de vocês");
    const c = await conversa();
    expect(c.motivo).toBe("suspected_optout");
    expect(c.team_id).toBeNull();
    expect(chamadasDeModelo).toHaveLength(0);
  });
});
