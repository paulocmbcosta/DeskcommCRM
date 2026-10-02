/**
 * QUEM PEDE UM ATENDENTE VAI PARA O SETOR CERTO — a parte pura e a casca do
 * classificador de setor.
 *
 * ## O defeito que este arquivo fecha (medido em produção, 2026-10-02)
 *
 * O desvio determinístico de "falar com um atendente" passava a conversa sem
 * time, e o rodízio a entregava a qualquer atendente disponível: um lead
 * comercial com plano e endereço escolhidos caiu no Suporte. Em 7 dias, 16 de 20
 * passagens pelo desvio precisaram de troca manual de time.
 *
 * ## O que NÃO pode acontecer, e é o que a maioria dos casos abaixo vigia
 *
 * A escolha do setor é um extra da passagem, nunca uma condição dela. Modelo
 * fora do ar, resposta torta, slug inventado, demora: tudo isso devolve `null`
 * — a fila geral de antes — e nada lança.
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  CONFIANCA_MINIMA_DO_SETOR,
  escolherSetorDoPedido,
  lerVereditoDoSetor,
  montarPromptDoSetor,
} from './setor-do-pedido';

const ORG = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const TIME_COMERCIAL = '44444444-4444-4444-8444-444444444444';
const TIME_SUPORTE = '55555555-5555-4555-8555-555555555555';

const SETORES = [
  {
    id: TIME_COMERCIAL,
    slug: 'comercial',
    name: 'Comercial',
    description: 'Quem quer contratar internet, trocar de plano ou agendar a instalação.',
  },
  {
    id: TIME_SUPORTE,
    slug: 'suporte-tecnico',
    name: 'Suporte Técnico',
    description: 'Internet sem sinal, lenta ou caindo.',
  },
];

const FALAS = [
  {
    direction: 'inbound' as const,
    body: 'Vim do site e quero falar com um atendente. Plano: 500 MEGA. Endereço: Quadra 1.',
  },
];

function poolFalso(times: typeof SETORES = SETORES) {
  const query = vi.fn(async (sql: string) => {
    if (/from attendance_teams/i.test(sql)) return { rows: times, rowCount: times.length };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** `runModelCall` de mentira: devolve o texto dado e grava o que recebeu. */
function modeloQueResponde(texto: string) {
  return vi.fn(async () => ({ result: { text: texto } }));
}

function entrada() {
  return { tenantId: ORG, leadId: LEAD, jobId: null, falas: FALAS };
}

describe('montarPromptDoSetor', () => {
  it('lista cada setor com o slug e o "quando usar", e oferece a saída none', () => {
    const p = montarPromptDoSetor(SETORES, FALAS);
    expect(p).toContain('comercial');
    expect(p).toContain('Quem quer contratar internet');
    expect(p).toContain('suporte-tecnico');
    expect(p).toContain('none');
  });

  it('leva a fala do cliente, rotulada', () => {
    const p = montarPromptDoSetor(SETORES, FALAS);
    expect(p).toContain('cliente: Vim do site e quero falar com um atendente');
  });

  it('setor sem descrição entra só com o nome — não some da lista', () => {
    const p = montarPromptDoSetor(
      [...SETORES, { id: 'x', slug: 'provisionamento', name: 'Provisionamento', description: '' }],
      FALAS,
    );
    expect(p).toMatch(/- provisionamento: Provisionamento\n/u);
  });

  it('só as últimas 12 falas entram, e cada uma cortada em 500 caracteres', () => {
    const muitas = Array.from({ length: 20 }, (_, i) => ({
      direction: 'inbound' as const,
      body: `fala-${i} ${'x'.repeat(600)}`,
    }));
    const p = montarPromptDoSetor(SETORES, muitas);
    expect(p).not.toContain('fala-7 ');
    expect(p).toContain('fala-8 ');
    expect(p).toContain('fala-19 ');
    expect(p).not.toContain('x'.repeat(501));
  });

  it('pede a razão ANTES do setor — sem ela o modelo decide pela superfície', () => {
    // Medido: sem o `porque`, o gpt-5-mini mandou o texto pronto do site de
    // comparação (plano, preço e endereço preenchidos) para `none` em 6 de 8.
    const p = montarPromptDoSetor(SETORES, FALAS);
    const instrucao = p.slice(p.lastIndexOf('Responda SOMENTE JSON'));
    expect(instrucao.indexOf('"porque"')).toBeGreaterThan(-1);
    expect(instrucao.indexOf('"porque"')).toBeLessThan(instrucao.indexOf('"setor"'));
  });

  it('a razão do modelo não atrapalha a leitura do veredito', () => {
    expect(
      lerVereditoDoSetor('{"porque":"quer contratar","setor":"comercial","confidence":0.9}', SETORES),
    ).toEqual({ slug: 'comercial', confianca: 0.9 });
  });

  it('fala vazia (mídia sem texto) não vira linha', () => {
    const p = montarPromptDoSetor(SETORES, [{ direction: 'inbound', body: '   ' }, ...FALAS]);
    expect(p).not.toMatch(/cliente: \n/u);
  });
});

describe('lerVereditoDoSetor', () => {
  it('extrai setor e confiança do JSON, mesmo cercado de texto', () => {
    expect(lerVereditoDoSetor('ok\n{"setor":"comercial","confidence":0.9}\n', SETORES)).toEqual({
      slug: 'comercial',
      confianca: 0.9,
    });
  });

  it('none vira slug nulo', () => {
    expect(lerVereditoDoSetor('{"setor":"none","confidence":0.3}', SETORES).slug).toBeNull();
  });

  it('setor que não existe na organização é recusado (o modelo inventou)', () => {
    expect(lerVereditoDoSetor('{"setor":"financeiro","confidence":0.99}', SETORES)).toEqual({
      slug: null,
      confianca: 0,
    });
  });

  it('saída que não é JSON vira veredito nulo, sem lançar', () => {
    expect(lerVereditoDoSetor('não sei dizer', SETORES)).toEqual({ slug: null, confianca: 0 });
  });

  it('confiança ausente ou não numérica vale zero', () => {
    expect(lerVereditoDoSetor('{"setor":"comercial"}', SETORES).confianca).toBe(0);
    expect(lerVereditoDoSetor('{"setor":"comercial","confidence":"alta"}', SETORES).confianca).toBe(0);
  });
});

describe('escolherSetorDoPedido', () => {
  it('devolve o time que o modelo escolheu', async () => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
  });

  it('chama o seam com o purpose do ponto registrado e sem ferramentas', async () => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    await escolherSetorDoPedido(
      pool,
      {} as never,
      { ...entrada(), model: 'modelo-do-agente', llmOverride: { provider: 'openai', credentialId: null } },
      { log: logFalso() as never, runModelCall: runModelCall as never },
    );
    const input = (runModelCall.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(input.purpose).toBe('handoff_team_classify');
    expect(input.tenantId).toBe(ORG);
    expect(input.model).toBe('modelo-do-agente');
    expect(input.llmOverride).toEqual({ provider: 'openai', credentialId: null });
    expect(input.tools).toBeUndefined();
  });

  it('organização sem time: nem chama o modelo', async () => {
    const { pool } = poolFalso([]);
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
    });
    expect(r).toBeNull();
    expect(runModelCall, 'gastou token numa organização que não tem setores').not.toHaveBeenCalled();
  });

  it('confiança abaixo do piso: fila geral', async () => {
    const { pool } = poolFalso();
    const abaixo = CONFIANCA_MINIMA_DO_SETOR - 0.01;
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: modeloQueResponde(`{"setor":"comercial","confidence":${abaixo}}`) as never,
    });
    expect(r).toBeNull();
  });

  it('none: fila geral', async () => {
    const { pool } = poolFalso();
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: modeloQueResponde('{"setor":"none","confidence":0.9}') as never,
    });
    expect(r).toBeNull();
  });

  it('modelo que falha NÃO lança — devolve null e avisa no log sem o texto do cliente', async () => {
    const { pool } = poolFalso();
    const log = logFalso();
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: log as never,
      runModelCall: vi.fn(async () => {
        throw new Error('provedor fora do ar');
      }) as never,
    });
    expect(r).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Vim do site');
  });

  it('leitura dos times que falha NÃO lança', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('conexão caiu');
      }),
    } as unknown as pg.Pool;
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: modeloQueResponde('{"setor":"comercial","confidence":0.92}') as never,
    });
    expect(r).toBeNull();
  });

  it('modelo que não responde a tempo: desiste e devolve null', async () => {
    const { pool } = poolFalso();
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: vi.fn(() => new Promise(() => {})) as never,
      tempoLimiteMs: 20,
    });
    expect(r).toBeNull();
  });

  it('conversa sem nenhuma fala do cliente com texto: nem chama o modelo', async () => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    const r = await escolherSetorDoPedido(
      pool,
      {} as never,
      { ...entrada(), falas: [{ direction: 'outbound', body: 'Olá!' }] },
      { log: logFalso() as never, runModelCall: runModelCall as never },
    );
    expect(r).toBeNull();
    expect(runModelCall).not.toHaveBeenCalled();
  });
});
