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
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  ASSUNTO_MINIMO_NO_JEV,
  CONFIANCA_MINIMA_DO_SETOR,
  CONFIANCA_MINIMA_DO_SETOR_NO_JEV,
  escolherSetorDoPedido,
  lerRespostaDoJev,
  lerVereditoDoSetor,
  montarPromptDoSetor,
  perguntasDoJev,
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

  it('áudio e imagem chegam sem a moldura do agente — só o que o cliente disse', () => {
    // `frameMediaBody` embrulha o derivado numa instrução para o AGENTE. Para o
    // classificador ela comia metade dos 500 caracteres e trazia uma ordem
    // ("NUNCA responda…") para dentro do bloco de conversa.
    const audio =
      '[Mídia do cliente: ele enviou um áudio e o sistema já processou o conteúdo pra você. ' +
      'Trate o texto abaixo como se você mesma tivesse visto/ouvido — NUNCA responda que não ' +
      'consegue ver/ouvir mídia. Comente ou use o conteúdo naturalmente.]\n' +
      'Conteúdo: quero falar com um atendente, minha internet caiu';
    const p = montarPromptDoSetor(SETORES, [{ direction: 'inbound', body: audio }]);
    expect(p).toContain('cliente: Conteúdo: quero falar com um atendente, minha internet caiu');
    expect(p).not.toContain('NUNCA responda');
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
      // Um endpoint compatível com OpenAI pode ECOAR o prompt na mensagem de erro
      // — e o prompt é a conversa do cliente. O log leva só a classe do erro.
      runModelCall: vi.fn(async () => {
        throw new Error('invalid request: "cliente: Vim do site e quero falar com um atendente"');
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

/**
 * PELO JEV, QUANDO HÁ CHAVE DA OPENROUTER — e o modelo do agente como reserva.
 *
 * Medido na VPS de produção em 2026-10-02, com 20 conversas sintéticas e os seis
 * times da Totus. UMA pergunta só (`choice` com a opção `none`) errava o caso
 * que motivou o conserto: o texto pronto do site de comparação caía em `none`
 * 8 de 8 — o Jev lê ao pé da letra, e a mensagem diz mesmo "quero falar com um
 * atendente". DUAS perguntas — "há assunto além do pedido?" (noul) e "qual
 * setor?" (choice, sem `none`) — fizeram 20 de 20, p50 de 0,26 s, e a primeira
 * separa sozinha quem não disse o assunto (0,03 e 0,04 contra 0,80 ou mais).
 */
describe('perguntasDoJev', () => {
  it('são DUAS perguntas: há assunto (noul) e qual setor (choice sem none)', () => {
    const p = perguntasDoJev(SETORES) as {
      tem_assunto: { type: string };
      setor: { type: string; criteria: Record<string, string> };
    };
    expect(p.tem_assunto.type).toBe('noul');
    expect(p.setor.type).toBe('choice');
    expect(Object.keys(p.setor.criteria)).toEqual(['comercial', 'suporte-tecnico']);
    expect(p.setor.criteria, 'none dentro do choice rouba a probabilidade do setor certo').not.toHaveProperty('none');
    expect(p.setor.criteria.comercial).toContain('Quem quer contratar internet');
  });

  it('setor sem "quando usar" entra com o nome', () => {
    const p = perguntasDoJev([{ id: 'x', slug: 'provisionamento', name: 'Provisionamento', description: '' }]) as {
      setor: { criteria: Record<string, string> };
    };
    expect(p.setor.criteria.provisionamento).toBe('Provisionamento');
  });
});

const corpoDoJev = (temAssunto: number, choice: string, confidence: number) => ({
  model: 'typesafe/jev-1.13-20260917',
  answers: { tem_assunto: { noul: temAssunto }, setor: { choice, confidence } },
  usage: { input_tokens: 320, cost: 0.00002 },
});

describe('lerRespostaDoJev', () => {
  it('assunto presente e setor confiante: o slug', () => {
    expect(lerRespostaDoJev(corpoDoJev(0.9, 'comercial', 0.69), SETORES)).toMatchObject({
      tipo: 'setor',
      slug: 'comercial',
    });
  });

  it('sem assunto: fila geral, mesmo com um setor "confiante" (o choice sempre escolhe algum)', () => {
    // Medido: "quero falar com um atendente" sozinho → suporte-tecnico 0.58, assunto 0.03.
    expect(lerRespostaDoJev(corpoDoJev(ASSUNTO_MINIMO_NO_JEV - 0.01, 'suporte-tecnico', 0.99), SETORES)).toEqual({
      tipo: 'sem_escolha',
    });
  });

  it('setor abaixo do piso: fila geral', () => {
    expect(
      lerRespostaDoJev(corpoDoJev(0.9, 'comercial', CONFIANCA_MINIMA_DO_SETOR_NO_JEV - 0.01), SETORES),
    ).toEqual({ tipo: 'sem_escolha' });
  });

  it('slug fora da lista ou corpo fora do formato: contrato quebrado (cai para a reserva)', () => {
    expect(lerRespostaDoJev(corpoDoJev(0.9, 'financeiro', 0.99), SETORES)).toEqual({ tipo: 'contrato' });
    expect(lerRespostaDoJev({ answers: {} }, SETORES)).toEqual({ tipo: 'contrato' });
    expect(lerRespostaDoJev(null, SETORES)).toEqual({ tipo: 'contrato' });
  });
});

describe('escolherSetorDoPedido · pelo Jev', () => {
  const comChave = { chaveDoJev: async () => 'sk-or-chave-de-teste-123456' };
  const jevQueResponde = (corpo: unknown) =>
    vi.fn(async () => ({ ok: true as const, corpo, status: 200, latenciaMs: 260 }));
  const jevQueFalha = (tipo: 'temporaria' | 'conta' | 'contrato', status: number | null) =>
    vi.fn(async () => ({ ok: false as const, falha: { tipo, status, detalhe: 'detalhe redigido' }, latenciaMs: 5000 }));

  it('com chave, quem escolhe é o Jev — e o modelo do agente nem é chamado', async () => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"suporte-tecnico","confidence":0.99}');
    const consultarJev = jevQueResponde(corpoDoJev(0.9, 'comercial', 0.69));
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
      consultarJev: consultarJev as never,
      ...comChave,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
    expect(consultarJev).toHaveBeenCalledTimes(1);
    expect(runModelCall, 'pagou duas classificações pela mesma conversa').not.toHaveBeenCalled();
  });

  it('o Jev recebe a conversa como estado e as duas perguntas, no modelo fixado', async () => {
    const { pool } = poolFalso();
    const consultarJev = jevQueResponde(corpoDoJev(0.9, 'comercial', 0.69));
    await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      consultarJev: consultarJev as never,
      ...comChave,
    });
    const e = (consultarJev.mock.calls[0] as unknown[])[0] as {
      apiKey: string;
      modelo: string;
      estado: { conversa: Array<{ quem: string; texto: string }> };
      perguntas: Record<string, unknown>;
    };
    expect(e.modelo).toBe('typesafe/jev-1.13');
    expect(e.estado.conversa[0]).toEqual({ quem: 'cliente', texto: FALAS[0]!.body });
    expect(Object.keys(e.perguntas)).toEqual(['tem_assunto', 'setor']);
  });

  it('Jev diz que não há assunto: fila geral, SEM consultar a reserva', async () => {
    // A resposta do Jev é resposta. Reserva é para quando ele não respondeu.
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.99}');
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
      consultarJev: jevQueResponde(corpoDoJev(0.03, 'suporte-tecnico', 0.58)) as never,
      ...comChave,
    });
    expect(r).toBeNull();
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it.each([
    ['temporaria', 503],
    ['conta', 402],
    ['contrato', 400],
  ] as const)('Jev falhou (%s): a reserva é o modelo do agente', async (tipo, status) => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
      consultarJev: jevQueFalha(tipo, status) as never,
      ...comChave,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
    expect(runModelCall).toHaveBeenCalledTimes(1);
  });

  it('Jev devolveu um setor que não existe: contrato quebrado, vale a reserva', async () => {
    const { pool } = poolFalso();
    const runModelCall = modeloQueResponde('{"setor":"comercial","confidence":0.92}');
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: runModelCall as never,
      consultarJev: jevQueResponde(corpoDoJev(0.9, 'financeiro', 0.99)) as never,
      ...comChave,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
  });

  it('sem chave da OpenRouter: o Jev nem é chamado, e a reserva escolhe', async () => {
    const { pool } = poolFalso();
    const consultarJev = jevQueResponde(corpoDoJev(0.9, 'suporte-tecnico', 0.99));
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: modeloQueResponde('{"setor":"comercial","confidence":0.92}') as never,
      consultarJev: consultarJev as never,
      chaveDoJev: async () => null,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
    expect(consultarJev).not.toHaveBeenCalled();
  });

  it('a chamada do Jev vira linha em llm_calls — sem chave e sem texto do cliente', async () => {
    const { pool, query } = poolFalso();
    await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      consultarJev: jevQueResponde(corpoDoJev(0.9, 'comercial', 0.69)) as never,
      ...comChave,
    });
    const insert = query.mock.calls.find(([sql]) => /insert into llm_calls/i.test(String(sql))) as
      | [string, unknown[]]
      | undefined;
    expect(insert, 'a chamada do Jev não apareceria em IA › Execuções').toBeDefined();
    const params = insert![1];
    expect(params).toContain(ORG);
    expect(params).toContain('handoff_team_classify');
    expect(params).toContain('openrouter');
    expect(params).toContain('typesafe/jev-1.13-20260917');
    const tudo = JSON.stringify(params);
    expect(tudo).not.toContain('sk-or-chave');
    expect(tudo).not.toContain('Vim do site');
  });

  it('a falha do Jev também vira linha, como erro', async () => {
    const { pool, query } = poolFalso();
    await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      runModelCall: modeloQueResponde('{"setor":"none","confidence":0.9}') as never,
      consultarJev: jevQueFalha('temporaria', 503) as never,
      ...comChave,
    });
    const insert = query.mock.calls.find(([sql]) => /insert into llm_calls/i.test(String(sql))) as
      | [string, unknown[]]
      | undefined;
    expect(insert?.[1]).toContain('erro');
    expect(insert?.[1]).toContain(503);
  });

  it('registro que falha não derruba a escolha', async () => {
    const { pool, query } = poolFalso();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) => {
      if (/insert into llm_calls/i.test(sql)) throw new Error('tabela travada');
      return original(sql);
    });
    const r = await escolherSetorDoPedido(pool, {} as never, entrada(), {
      log: logFalso() as never,
      consultarJev: jevQueResponde(corpoDoJev(0.9, 'comercial', 0.69)) as never,
      ...comChave,
    });
    expect(r).toEqual({ id: TIME_COMERCIAL, name: 'Comercial' });
  });
});

/**
 * O SÍTIO DE CHAMADA, lido do fonte. Os casos acima injetam `model` e
 * `llmOverride` à mão, e o invariante de banco não tem agente publicado — então
 * apagar o `...argsAux(undefined)` do desvio deixava tudo verde, e a reserva
 * passaria a sair com o modelo PADRÃO da organização no provider que ela tiver:
 * a forma exata do defeito que `aux-model-args.ts` existe para impedir.
 */
describe('o desvio de pedido de humano, em inbound-turn.ts', () => {
  const fonte = readFileSync(path.join(__dirname, 'inbound-turn.ts'), 'utf8');
  const inicio = fonte.indexOf('await escolherSetorDoPedido(');
  const chamada = fonte.slice(inicio, fonte.indexOf('const aviso = await avisarLeadDaEscalacao', inicio));

  it('chama o classificador uma vez só, e ANTES do aviso ao lead', () => {
    expect(inicio, 'o desvio não pergunta o setor').toBeGreaterThan(-1);
    expect(fonte.split('await escolherSetorDoPedido(').length - 1).toBe(1);
    expect(chamada.length, 'o aviso ao lead veio antes da escolha do setor').toBeGreaterThan(0);
    expect(chamada.length).toBeLessThan(1500);
  });

  it('empresta à reserva o modelo E o provider do agente publicado', () => {
    expect(chamada).toContain('...argsAux(undefined)');
  });
});
