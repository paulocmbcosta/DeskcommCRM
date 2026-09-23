import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { evaluateBeforeSend, runBeforeSend, type Gate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { hashNormalized, normalizeCopy } from "@/lib/agent-engine/spinning/engine";

/**
 * A cobrança é texto do SISTEMA, conferido no ERP — não do modelo. A legenda
 * "Valor: R$ 129,90" cairia no piso de preço da tabela de promessas, e a mesma
 * legenda para o 3º cliente do número cairia no anti-repetição (a janela cruza
 * clientes). `conteudoDoSistema` desarma SÓ esses dois, com `skipped` no trace;
 * opt-out, LGPD, ritmo, janela e aviso de IA continuam valendo.
 */
const COMERCIAL = new Date("2026-07-28T13:00:00Z");
const LEGENDA = "Segue o Pix da sua fatura.\n\nVencimento: 14/07/2026\nValor: R$ 129,90";
const copia = { normalizedText: normalizeCopy(LEGENDA), normalizedHash: hashNormalized(normalizeCopy(LEGENDA)) };

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: COMERCIAL,
    body: LEGENDA,
    optedOut: false,
    provider: "meta_cloud",
    messagingWindow: { lastInboundAt: new Date(COMERCIAL.getTime() - 60_000) },
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null, rng: () => 0 },
    spinning: { knobs: SPINNING_DEFAULTS, window: [copia, copia, copia] },
    promise: { table: { minPriceCents: 20_000 } },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  } as GateContext;
}

describe("conteudoDoSistema", () => {
  it("controle: SEM a opção, a legenda da cobrança é vetada (repetição ou piso de preço)", () => {
    expect(evaluateBeforeSend(ctx()).veto).not.toBeNull();
  });

  it("COM a opção, spinning e promise saem skipped com o motivo, e nada veta", () => {
    const r = evaluateBeforeSend(ctx({ conteudoDoSistema: true }));
    expect(r.veto).toBeNull();
    expect(r.trace).toContainEqual({ gate: "spinning", verdict: "skipped", code: "conteudo_do_sistema" });
    expect(r.trace).toContainEqual({ gate: "promise", verdict: "skipped", code: "conteudo_do_sistema" });
  });

  it("opt-out continua vetando conteúdo do sistema", () => {
    const r = evaluateBeforeSend(ctx({ conteudoDoSistema: true, optedOut: true }));
    expect(r.veto?.code).toBe("contato_bloqueado");
  });

  it("no runner: a legenda do sistema NÃO entra na janela de cópias que julga os outros", async () => {
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rows: [{ id: "t" }] }) } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await runBeforeSend({
      pool, log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: LEGENDA, conteudoDoSistema: true, optedOutThisTurn: false, crmDailyLimit: null,
      now: COMERCIAL, rng: () => 0, sleep: async () => {}, gates: [],
      send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
    });
    expect(r.status).toBe("sent");
    const sqls = client.query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.includes("insert into outbound_copies"))).toBe(false);
  });
});

/**
 * A 2ª mensagem da cobrança é o CÓDIGO (linha digitável / copia-e-cola do Pix),
 * puro. `isFirstOutbound` é por CONTATO, não por mensagem: se a 1ª (a legenda,
 * que pode levar o aviso de IA) saiu `queued`, o ledger não a conta `accepted` e
 * a 2ª ainda é vista como "1º outbound" pelo disclosureGate — que prependaria o
 * aviso ao código e corromperia o BR Code. `corpoImutavel` existe para isto.
 */
describe("corpoImutavel", () => {
  const comDisclosure = (overrides: Partial<GateContext> = {}) =>
    ctx({
      // Janela de spinning VAZIA: o que estes testes exercitam é o disclosure, e a
      // LEGENDA já entra pré-carregada 3x no `window` do `ctx()` base (para o
      // describe de `conteudoDoSistema` acima) — sem isto o spinning vetaria antes
      // do disclosure sequer rodar.
      spinning: { knobs: SPINNING_DEFAULTS, window: [] },
      // Tabela de preço NULA pelo mesmo motivo: o describe de `conteudoDoSistema`
      // acima arma um piso de R$ 200 pra testar QUELE gate — não este.
      promise: { table: null },
      disclosure: { template: "Olá! Sou a assistente virtual.", isFirstOutbound: true, mode: "inject" },
      ...overrides,
    });

  it("controle: sem a flag, o disclosure EMENDA o corpo normalmente (a legenda pode levar o aviso)", () => {
    const r = evaluateBeforeSend(comDisclosure());
    expect(r.veto).toBeNull();
    expect(r.body.startsWith("Olá! Sou a assistente virtual.")).toBe(true);
  });

  it("com a flag: o disclosure sai skipped e o código não é tocado", () => {
    const r = evaluateBeforeSend(comDisclosure({ corpoImutavel: true }));
    expect(r.veto).toBeNull();
    expect(r.body).toBe(LEGENDA);
    expect(r.trace).toContainEqual({ gate: "disclosure", verdict: "skipped", code: "corpo_imutavel" });
  });

  it("rede de segurança: o runner recusa amendBody de QUALQUER gate quando a flag está ligada", () => {
    const gateQueSempreEmenda: Gate = {
      name: "fake_amend",
      evaluate: () => ({ pass: true, amendBody: "CORROMPIDO" }),
    };
    const r = evaluateBeforeSend(comDisclosure({ corpoImutavel: true }), [gateQueSempreEmenda]);
    expect(r.body).toBe(LEGENDA);
  });

  it("controle: a mesma rede NÃO existe sem a flag (o gate fake emenda de verdade)", () => {
    const gateQueSempreEmenda: Gate = {
      name: "fake_amend",
      evaluate: () => ({ pass: true, amendBody: "MUDOU" }),
    };
    const r = evaluateBeforeSend(comDisclosure(), [gateQueSempreEmenda]);
    expect(r.body).toBe("MUDOU");
  });
});
