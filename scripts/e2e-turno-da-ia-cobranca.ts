/**
 * Roda UM turno da IA numa conversa — o motor REAL (ferramentas, cadeia de envio,
 * ledger, `sendMessageHandler`, Storage, canal WAHA do rig), com SÓ o modelo
 * trocado por um roteiro. É o que a spec e2e do conector usa para provar pela tela
 * que a IA manda a cobrança sem worker nem chave de IA no CI.
 *
 * O roteiro: consulta o cliente; se identificado, pede a cobrança; escreve uma
 * frase conforme o que a ferramenta respondeu. Mesmo recorte de
 * `lib/agent-engine/agent/preview-fixture.ts` para as chamadas internas (memória,
 * compactação), que não têm ferramentas.
 *
 * Uso: npx tsx scripts/e2e-turno-da-ia-cobranca.ts <org> <conversa>
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

import { carregarEnvLocal } from "./lib/env-de-teste";

// `lib/env.ts` valida o ambiente AO SER IMPORTADO — por isso os imports de
// módulo do app, abaixo, são todos DINÂMICOS (dentro de `main()`), depois desta
// linha rodar.
//
// `carregarEnvLocal()` (não um `readFileSync(".env.local")` à mão) é quem
// publica o arquivo em `process.env`: ela faz `process.env` VENCER e tolera o
// arquivo ausente. Ler o disco direto era o padrão que
// `tests/unit/seed-nao-le-env-local-do-disco.test.ts` existe pra proibir —
// congela o defeito medido em 2026-08-06: seeds que liam `.env.local` sozinhos
// ignoravam o `.env.e2e` que o `webServer` do Playwright injeta em
// `process.env`, e escreveram organização de teste em PRODUÇÃO por meses com a
// suíte verde.
carregarEnvLocal();

const USO = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

async function main(): Promise<void> {
  const [org, conversa] = process.argv.slice(2);
  if (!org || !conversa) throw new Error("uso: e2e-turno-da-ia-cobranca.ts <org> <conversa>");
  const { credenciaisSupabaseDeTeste } = await import("./lib/env-de-teste");
  const cred = credenciaisSupabaseDeTeste();
  const pool = new pg.Pool({ connectionString: cred.dbUrl });
  const { createClient } = await import("@supabase/supabase-js");
  const { createInboundTurnHandler } = await import("@/lib/agent-engine/agent/inbound-turn");
  const { createFakeRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
  const queue = await import("@/lib/agent-engine/queue/queue");
  const { withServiceJob } = await import("@/lib/atendimento/fronteira-server");
  const { createLogger } = await import("@/lib/agent-engine/obs/logger");
  const { seedPlatformPlaybook } = await import("@/lib/agent-engine/agent/playbook-seed");

  const WORKER_ID = "e2e-cobranca";

  // O e2e não sobe o `worker` — quem semeia a camada `platform` do playbook no
  // boot dele (`workers/agent-worker/main.ts`) nunca roda aqui. Sem isto o
  // PRIMEIRO turno de todo self-host morre com "ponteiro da camada plataforma
  // ausente" (é exatamente o bug que `seedPlatformPlaybook` existe pra evitar em
  // produção); reproduzimos o mesmo bootstrap idempotente que outras specs
  // fazem (`tests/e2e/autonomia-assistida.spec.ts`), sem mover ponteiro existente.
  await seedPlatformPlaybook(pool);

  const registry = createFakeRegistry(async (options) => {
    const fim = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage: USO, warnings: [] });
    if (!options.tools?.length) {
      const texto = JSON.stringify(options.prompt);
      return fim(
        JSON.stringify(
          texto.includes("Turno interno de memória")
            ? { notes: [] }
            : texto.includes("Compacte a conversa")
              ? { commitments: [], objections: [], personal_data: [], stage: null, rolling_summary: "Cobrança pela IA." }
              : { commitments: [], objections: [], next_action: null, rolling_summary: "Cobrança pela IA.", declaracao: { promessas: [] } },
        ),
      );
    }
    const resultados = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content) as Array<{ toolName?: string; output?: { value?: unknown } }>;
    const visto = (nome: string) => resultados.find((r) => r.toolName === nome)?.output?.value as Record<string, unknown> | undefined;
    const chamar = (toolName: string, input: object) => ({
      content: [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    });
    const consulta = visto("crm_consultar_cliente_erp");
    if (!consulta) return chamar("crm_consultar_cliente_erp", {});
    // Diagnóstico de propósito, não debug esquecido: quando o turno não envia a
    // cobrança, é ESTE stderr (com `stdio: "inherit"` no processo pai) que diz
    // se a causa foi o conector (estado devolvido aqui) ou o motor (veto de
    // gate, elegibilidade — esses o motor já loga sozinho). Sem isto, "não
    // enviou" não tem como virar "não enviou PORQUE X" sem reabrir o código.
    console.error("[roteiro] consulta =", JSON.stringify(consulta));
    const envio = visto("crm_enviar_cobranca_erp");
    if (envio) console.error("[roteiro] envio =", JSON.stringify(envio));
    if (consulta.estado === "identificado" && !envio) return chamar("crm_enviar_cobranca_erp", {});
    if (!visto("send_message")) {
      const corpo =
        envio?.estado === "enviada"
          ? "Prontinho! Te mandei o Pix da fatura."
          : envio?.estado === "encaminhar_para_cobranca"
            ? "Sua fatura foi encaminhada ao nosso setor de cobrança. Já vou te passar para eles."
            : "Vou te passar para uma pessoa da equipe.";
      return chamar("send_message", { body: corpo });
    }
    return fim("fim");
  });

  // Cinto de segurança do ambiente PERSISTENTE (não é reiniciado entre sessões de
  // teste): `claimJobs` tem teto de concorrência GLOBAL por `status='running'`
  // (queue.ts) — um job desta MESMA ferramenta que ficou 'running' de uma
  // execução anterior interrompida (crash, Ctrl-C) esgota o teto pra sempre e
  // NENHUM job novo é reivindicado, em silêncio. Como nenhum worker de produção
  // roda durante o e2e (a app sob teste é só `next start`; quem drena
  // `job_queue` é o serviço `worker`, separado, que não sobe aqui), um job
  // 'running' com este `locked_by` só pode ser lixo de uma rodada anterior deste
  // MESMO script — nunca trabalho concorrente legítimo.
  await pool.query(`update job_queue set status='failed', locked_by=null, locked_at=null where status='running' and locked_by=$1`, [WORKER_ID]);

  const { rows: alvo } = await pool.query<{ contact_id: string; channel_session_id: string; msg: string }>(
    `select c.contact_id, c.channel_session_id,
            (select m.id from messages m where m.conversation_id = c.id and m.direction = 'inbound' order by m.sent_at desc limit 1) as msg
       from conversations c where c.id = $1 and c.organization_id = $2`,
    [conversa, org],
  );
  const linha = alvo[0];
  if (!linha) throw new Error("conversa não encontrada");
  const fronteira = (
    await pool.query("select fn_service_boundary($1,$2)-'status'-'demanda_fechada_em'-'service_started_at' as b", [org, conversa])
  ).rows[0].b;

  const handler = createInboundTurnHandler({
    crmCfg: { supabase: createClient(cred.url, cred.serviceRole, { auth: { persistSession: false } }) },
    llmCfg: { anthropicApiKey: "e2e-roteiro" },
    knobs: {
      historyLimit: 10,
      maxContextTokens: 4000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      queuedRetryDelayMs: 1000,
      breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 },
    },
    log: createLogger(),
    registry,
    sleep: async () => {},
  });

  const { job } = await queue.enqueueJob(pool, org, {
    kind: "inbound_turn",
    leadId: linha.contact_id,
    payload: {
      conversation_id: conversa,
      contact_id: linha.contact_id,
      channel_session_id: linha.channel_session_id,
      inbound_message_id: linha.msg,
      crm_event_id: randomUUID(),
      service_boundary: fronteira,
    },
    maxAttempts: 1,
  });
  const [claimed] = await queue.claimJobs(pool, { workerId: WORKER_ID, maxConcurrency: 1 });
  if (claimed?.id !== job.id) throw new Error(`outro job foi reivindicado antes do turno da cobrança (claimado: ${claimed?.id ?? "nenhum"}, esperado: ${job.id})`);
  await withServiceJob(pool, claimed, () => handler(claimed, pool, { workerId: WORKER_ID }));
  await queue.completeJob(pool, claimed.id, WORKER_ID);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
