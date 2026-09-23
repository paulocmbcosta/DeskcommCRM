import * as fs from "node:fs";
import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const runBeforeSendMock = vi.fn();
vi.mock("@/lib/agent-engine/guardrails/before-send", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent-engine/guardrails/before-send")>();
  return { ...real, runBeforeSend: (...a: unknown[]) => runBeforeSendMock(...(a as [never])) };
});

import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { FERRAMENTAS_DE_ENVIO } from "@/lib/agent-engine/edge/llm/fila-de-envio";
import {
  montarPortaDeEnvioDoConector,
  resultadoDoEnvioNoTurno,
  type DepsDaPortaDeEnvioDoConector,
} from "@/lib/agent-engine/agent/inbound-turn";
import { applyPreviewPolicy } from "@/lib/agent-engine/agent/preview";

/**
 * A LIGAÇÃO das ferramentas do conector no turno — o que nenhum teste das peças toca.
 *
 * `montarPortaDeEnvioDoConector` e `resultadoDoEnvioNoTurno` (inbound-turn.ts) foram
 * extraídas de um objeto anônimo montado inline exatamente para poder ser exercitadas
 * aqui, com `runBeforeSend` mockado (a cadeia de gates já tem os próprios testes; o
 * que FALTAVA testar era o que a PORTA faz com o veredito dela — achado crítico da
 * revisão de qualidade: `failed`/`unavailable` viravam sucesso).
 *
 * O que fica textual (varredura do arquivo) é só a fiação que exigiria rodar o turno
 * inteiro contra Postgres para exercitar de verdade — isso é o e2e
 * (`tests/e2e/conector-ixc-no-painel.spec.ts`).
 */
const TURNO = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("resultadoDoEnvioNoTurno — um caso por kind de ChannelSendResult (item crítico da revisão)", () => {
  it.each([
    ["sent", { kind: "sent", idempotencyKey: "k", messageId: "m" }],
    ["already_sent", { kind: "already_sent", idempotencyKey: "k", messageId: "m" }],
    ["queued", { kind: "queued", idempotencyKey: "k", messageId: null }],
  ] as const)("%s conta como sucesso — a cobrança pode seguir para a próxima mensagem", (_nome, outcome) => {
    expect(resultadoDoEnvioNoTurno(outcome as ChannelSendResult)).toEqual({ ok: true });
  });

  it("blocked: contato_bloqueado", () => {
    expect(resultadoDoEnvioNoTurno({ kind: "blocked", idempotencyKey: "k" })).toMatchObject({
      ok: false,
      code: "contato_bloqueado",
    });
  });

  it("failed: envio_falhou — NUNCA 'enviada' (era o achado crítico: canal fora do ar virava sucesso)", () => {
    expect(resultadoDoEnvioNoTurno({ kind: "failed", idempotencyKey: "k", messageId: null })).toMatchObject({
      ok: false,
      code: "envio_falhou",
    });
  });

  it("unavailable: envio_indisponivel — também nunca 'enviada'", () => {
    expect(resultadoDoEnvioNoTurno({ kind: "unavailable", reason: "timeout" })).toMatchObject({
      ok: false,
      code: "envio_indisponivel",
    });
  });
});

function montarDeps(overrides: Partial<DepsDaPortaDeEnvioDoConector> = {}) {
  let seq = 0;
  const outcomes: ChannelSendResult[] = [];
  const pacingVetos: Array<{ code: string; nextAllowedAt: Date }> = [];
  const erros: Error[] = [];
  const enviosNoCanal: unknown[] = [];
  const deps: DepsDaPortaDeEnvioDoConector = {
    pool: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: "org-1",
    leadId: "lead-1",
    conversationId: "conv-1",
    channelSessionId: "sess-1",
    jobId: () => "job-1",
    jobClaim: () => undefined,
    agentOperation: undefined,
    optedOutThisTurn: false,
    lgpd: undefined,
    disclosureMode: undefined,
    sleep: undefined,
    now: () => new Date("2026-09-23T12:00:00Z"),
    maxSendsPerTurn: 3,
    seqAtual: () => seq,
    avancarSeq: () => {
      seq += 1;
      return seq;
    },
    enviarNoCanal: async (envio) => {
      enviosNoCanal.push(envio);
      return { kind: "sent", idempotencyKey: "k", messageId: "m" };
    },
    registrarOutcome: (o) => outcomes.push(o),
    registrarPacingCapVeto: (v) => pacingVetos.push(v),
    noteRunError: (e) => erros.push(e),
    ...overrides,
  };
  return { deps, outcomes, pacingVetos, erros, enviosNoCanal, seqAtual: () => seq };
}

/** O mock "feliz" de runBeforeSend: chama o `send` de verdade (é ele quem exercita `avancarSeq`/`enviarNoCanal`), como o runner real faria quando todos os gates passam. */
function passarESend(args: { body: string; send: (b: string) => Promise<ChannelSendResult> }) {
  return args.send(args.body).then((outcome) => ({ status: "sent" as const, outcome, trace: [] }));
}

describe("montarPortaDeEnvioDoConector — a porta de saída da cobrança", () => {
  beforeEach(() => {
    runBeforeSendMock.mockReset();
    runBeforeSendMock.mockImplementation(passarESend);
  });

  it("vagas() reflete maxSendsPerTurn - seq", () => {
    const { deps } = montarDeps({ maxSendsPerTurn: 3 });
    const porta = montarPortaDeEnvioDoConector(deps);
    expect(porta.vagas()).toBe(3);
  });

  it("seq avança 1 por mensagem, e a mídia da 1ª (só ela tem arquivo) chega ao canal", async () => {
    const { deps, outcomes, enviosNoCanal, seqAtual } = montarDeps();
    const porta = montarPortaDeEnvioDoConector(deps);
    expect(porta.vagas()).toBe(3);

    const r1 = await porta.enviar({
      type: "image",
      body: "Segue o Pix",
      media_storage_path: "org-1/conv-1/cobranca-x/pix.png",
      media_mime: "image/png",
      media_size_bytes: 42,
    });
    expect(r1).toEqual({ ok: true, outcome: { kind: "sent", idempotencyKey: "k", messageId: "m" } });
    expect(porta.vagas()).toBe(2);

    const r2 = await porta.enviar({ type: "text", body: "000201...", corpoImutavel: true });
    expect(r2).toMatchObject({ ok: true });

    expect(seqAtual()).toBe(2);
    expect(enviosNoCanal).toEqual([
      expect.objectContaining({ seq: 1, body: "Segue o Pix", media: { kind: "image", storagePath: "org-1/conv-1/cobranca-x/pix.png", mime: "image/png", sizeBytes: 42 } }),
      expect.objectContaining({ seq: 2, body: "000201..." }),
    ]);
    expect(enviosNoCanal[1]).not.toHaveProperty("media");
    expect(outcomes).toHaveLength(2);
  });

  it("o document (boleto) vira media.kind='document'", async () => {
    const { deps, enviosNoCanal } = montarDeps();
    const porta = montarPortaDeEnvioDoConector(deps);
    await porta.enviar({ type: "document", body: "Segue o boleto", media_storage_path: "x/y/boleto.pdf", media_mime: "application/pdf", media_size_bytes: 9 });
    expect(enviosNoCanal[0]).toMatchObject({ media: { kind: "document", storagePath: "x/y/boleto.pdf" } });
  });

  it("veto no meio das duas mensagens: a 2ª NÃO alcança o canal, e o código do veto volta ao chamador", async () => {
    const nextAllowedAt = new Date("2026-09-23T13:00:00Z");
    runBeforeSendMock
      .mockImplementationOnce(passarESend)
      .mockImplementationOnce(async () => ({
        status: "vetoed" as const,
        gate: "pacing",
        code: "warmup_cap",
        message: "espera o warm-up",
        nextAllowedAt,
        trace: [],
      }));
    const { deps, enviosNoCanal, pacingVetos } = montarDeps();
    const porta = montarPortaDeEnvioDoConector(deps);
    const r1 = await porta.enviar({ type: "image", body: "legenda" });
    expect(r1).toMatchObject({ ok: true });
    const r2 = await porta.enviar({ type: "text", body: "codigo" });
    expect(r2).toEqual({ ok: false, code: "warmup_cap", message: "espera o warm-up" });
    // Só a 1ª chegou de fato ao canal — a rede de segurança do item 4/crítico:
    // o veto da 2ª não pode ter side effect nenhum no canal.
    expect(enviosNoCanal).toHaveLength(1);
    // Item "menor": o cap de ritmo alimenta `registrarPacingCapVeto` — sem isso o
    // job da cobrança nunca era readiado para quando o cap libera.
    expect(pacingVetos).toEqual([{ code: "warmup_cap", nextAllowedAt }]);
  });

  describe("o desfecho por kind, na PORTA (item crítico da revisão de qualidade)", () => {
    it.each([
      ["sent", { kind: "sent", idempotencyKey: "k", messageId: "m" }, true, false],
      ["already_sent", { kind: "already_sent", idempotencyKey: "k", messageId: "m" }, true, false],
      ["queued", { kind: "queued", idempotencyKey: "k", messageId: null }, true, false],
      ["blocked", { kind: "blocked", idempotencyKey: "k" }, false, false],
      ["failed", { kind: "failed", idempotencyKey: "k", messageId: null }, false, false],
      ["unavailable", { kind: "unavailable", reason: "timeout" }, false, true],
    ] as const)("%s: ok=%s, noteRunError chamado=%s (o job só re-tenta sozinho quando o canal está indisponível)", async (_nome, outcome, ok, chamaNoteRunError) => {
      const { deps, outcomes, erros } = montarDeps({ enviarNoCanal: async () => outcome as ChannelSendResult });
      const porta = montarPortaDeEnvioDoConector(deps);
      const r = await porta.enviar({ type: "text", body: "x" });
      expect(r.ok).toBe(ok);
      // O outcome é registrado (para `outcomes.some(kind==='failed')` no fechamento
      // do turno) INDEPENDENTE do resultado — é o `send_message` fazendo o mesmo.
      expect(outcomes).toEqual([outcome]);
      expect(erros.length > 0).toBe(chamaNoteRunError);
    });
  });

  it("corpoImutavel da mensagem chega ao before-send (o código do Pix não pode ser emendado)", async () => {
    const { deps } = montarDeps();
    const porta = montarPortaDeEnvioDoConector(deps);
    await porta.enviar({ type: "text", body: "codigo-puro", corpoImutavel: true });
    expect(runBeforeSendMock).toHaveBeenCalledWith(expect.objectContaining({ corpoImutavel: true, conteudoDoSistema: true }));
  });

  it("controle: sem corpoImutavel na mensagem, o campo não é passado ao before-send", async () => {
    const { deps } = montarDeps();
    const porta = montarPortaDeEnvioDoConector(deps);
    await porta.enviar({ type: "image", body: "legenda" });
    const args = runBeforeSendMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("corpoImutavel");
  });
});

describe("ferramentas do conector no turno — a fiação que só o turno inteiro exercitaria de verdade", () => {
  it("o turno monta a porta com montarPortaDeEnvioDoConector, repassando disclosureMode/lgpd/o cap de ritmo/noteRunError", () => {
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    const trecho = bloco.slice(0, 4000);
    expect(trecho).toContain("saida: montarPortaDeEnvioDoConector({");
    expect(trecho).toContain("disclosureMode: deps.knobs.disclosureMode");
    expect(trecho).toContain("lgpd,");
    expect(trecho).toContain("registrarPacingCapVeto");
    expect(trecho).toContain("noteRunError,");
  });

  it("o telefone e a identidade do canal vêm do turno (get_lead_context + provider já lido) — não de uma consulta nova", () => {
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    const trecho = bloco.slice(0, 1500);
    expect(trecho).toContain("telefone: openingContext.context.contact.phone");
    expect(trecho).toContain("identidadeDoTelefone: identidadeDoTelefone(provider)");
  });

  it("capacidade ligada sem conector vira aviso na Central, com título que a distingue do aviso de tools MCP", () => {
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    const trecho = bloco.slice(0, 6000);
    expect(trecho).toContain("avisarCapacidadesAusentes(");
    expect(trecho).toContain("'O agente atendeu sem o sistema de gestão conectado'");
  });

  it("a cobrança entra na fila de envio (ordem com o send_message)", () => {
    expect(FERRAMENTAS_DE_ENVIO).toContain("crm_enviar_cobranca_erp");
  });

  it("no botão Testar as duas viram proposta: nada é consultado nem enviado", async () => {
    let executou = false;
    const real = { description: "x", inputSchema: {} as never, execute: async () => { executou = true; return {}; } };
    const preview = { kind: "sandbox", contactId: "lead-real", result: { proposals: [] as unknown[], impediments: [], candidates: [] } };
    const tools = applyPreviewPolicy(
      { crm_consultar_cliente_erp: real, crm_enviar_cobranca_erp: real } as never,
      preview as never,
      {} as never,
      () => [],
    ) as unknown as Record<string, { execute: (a: unknown) => Promise<{ status?: string }> }>;
    for (const nome of ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) {
      expect((await tools[nome]!.execute({})).status).toBe("proposal_only");
    }
    expect(executou).toBe(false);
    expect(preview.result.proposals).toHaveLength(2);
  });
});
