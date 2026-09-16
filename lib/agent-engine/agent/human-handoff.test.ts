/**
 * O HANDOFF NATIVO ESCOLHE O SETOR — e recusa o slug errado ANTES de mutar.
 *
 * ## O defeito que este arquivo fecha
 *
 * A feature de Times entregou as tabelas, o roteamento por time, o catálogo e a
 * tool `crm_list_teams`. Mas a tool MCP `crm_request_human_handoff` — a que
 * recebeu o campo `team` — está em `BLOCKED_TOOL_IDS`
 * (`lib/agent-engine/edge/crm/mcp-tools.ts`): a ponte do turno a REMOVE, e o
 * harness monta no lugar dela a tool NATIVA `request_human_handoff`, cujo
 * schema aceitava só `reason`.
 *
 * O resultado, no produto: o agente descobre os setores, lê o "quando usar" de
 * cada um, e não tem como escolher. Toda conversa vai para a fila geral.
 *
 * ## Por que gravar `conversations.team_id` basta
 *
 * `performHumanHandoff` NÃO chama o roteamento G5 — não há `loadEligibleAttendants`,
 * `selectRoundRobin` nem `getQueuePosition` neste caminho. Ele marca a conversa
 * para humano; quem escolhe o atendente depois é o cron (`lib/routing/worker.ts`),
 * que já lê `conversations.team_id`. A coluna é a feature inteira deste lado.
 *
 * ## Por que o POOL é o espião, e não um mock de módulo
 *
 * `applyRequestHumanHandoff` chama `performHumanHandoff` no MESMO módulo: a
 * chamada é uma referência de escopo, que `vi.mock` não intercepta. Então a
 * prova é feita onde o efeito realmente acontece — no `db.query`, que é um
 * `vi.fn`. É o idioma que `tests/unit/handoff-por-orcamento.test.ts` já usa
 * para medir a ORDEM desta mesma passagem (`set force_human = true`), e é mais
 * forte que contar chamadas: pega o efeito, não o intermediário.
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { applyRequestHumanHandoff } from './human-handoff';

const ORG = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const CONVERSA = '33333333-3333-4333-8333-333333333333';
const TIME_FINANCEIRO = '44444444-4444-4444-8444-444444444444';
const TIME_SUPORTE = '55555555-5555-4555-8555-555555555555';

const TIMES = [
  { id: TIME_FINANCEIRO, slug: 'financeiro', name: 'Financeiro' },
  { id: TIME_SUPORTE, slug: 'suporte', name: 'Suporte técnico' },
];

const IDS = { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA };

/**
 * Pool falso que ROTEIA por conteúdo da SQL e grava tudo que passou. O default
 * `{ rows: [], rowCount: 0 }` serve a todo o resto do caminho: os quatro efeitos
 * de `performHumanHandoff`, o cancelamento de crons, a atividade (que roda em
 * try/catch) e `expectativaDeAtendimento` (que degrada sozinha em erro).
 */
function poolFalso(times: Array<{ id: string; slug: string; name: string }> = TIMES) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/from attendance_teams/i.test(sql)) return { rows: times, rowCount: times.length };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas, query };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function opts() {
  return { conversationSummary: 'resumo qualquer', log: logFalso() };
}

/** As mutações do caminho — o que NÃO pode ter acontecido numa recusa. */
function mutacoes(chamadas: Array<{ sql: string }>): string[] {
  return chamadas
    .map((c) => c.sql.trim())
    .filter((sql) => /^(insert|update|delete)/i.test(sql));
}

describe('applyRequestHumanHandoff · destino de time', () => {
  it('team válido grava conversations.team_id (com a org no WHERE)', async () => {
    const { pool, chamadas } = poolFalso();

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), { team: 'financeiro' });

    expect(res.ok).toBe(true);

    const update = chamadas.find((c) => /update conversations set team_id/i.test(c.sql));
    expect(
      update,
      'sem esta gravação o agente escolhe o setor e a conversa cai na fila geral assim mesmo',
    ).toBeDefined();
    expect(update?.params).toEqual([TIME_FINANCEIRO, CONVERSA, ORG]);

    // Service role bypassa RLS: a org no WHERE é o que impede escrever na
    // conversa de outro tenant (anti-pattern nº 10).
    expect(update?.sql).toMatch(/organization_id\s*=\s*\$3/u);

    // E a passagem em si aconteceu — o time é DESTINO, não substituto do handoff.
    expect(chamadas.some((c) => /set force_human = true/i.test(c.sql))).toBe(true);
  });

  it('team INVÁLIDO não muta NADA — a passagem nem começa', async () => {
    // ⚠️ O caso central. Uma asserção sobre a RESPOSTA passa com a ordem errada:
    // resolver o slug depois de `performHumanHandoff` devolveria o mesmo erro,
    // com `force_human = true` já gravado — o lead calado, esperando um
    // atendente que ninguém escolheu, e sem o agente poder falar com ele.
    const { pool, chamadas, query } = poolFalso();

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), { team: 'finaceiro' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('esperava recusa');
    expect(res.error.code).toBe('invalid_payload');

    // A primeira linha de `performHumanHandoff` é esta — se ela não rodou, ele
    // não foi chamado.
    expect(
      query,
      'performHumanHandoff rodou com slug inválido — a ordem está invertida',
    ).not.toHaveBeenCalledWith(
      expect.stringContaining('set force_human = true'),
      expect.anything(),
    );

    // E nenhuma outra: nem silêncio da conversa, nem cancelamento de crons, nem
    // item na Central, nem o próprio team_id.
    expect(mutacoes(chamadas)).toEqual([]);
    expect(chamadas.every((c) => /from attendance_teams/i.test(c.sql))).toBe(true);
  });

  it('a recusa ENSINA: lista os slugs válidos para a chamada seguinte', async () => {
    const { pool } = poolFalso();

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), { team: 'finaceiro' });

    if (res.ok) throw new Error('esperava recusa');
    expect(res.error.message).toContain('finaceiro');
    expect(res.error.message).toContain('financeiro');
    expect(res.error.message).toContain('suporte');
    // Sem isto o modelo repete o mesmo chute, e o cliente espera mais um turno.
    expect(res.error.message, 'a recusa precisa dizer que nada foi alterado').toMatch(
      /nada foi alterado/iu,
    );
  });

  it('organização SEM times: a recusa manda chamar sem o campo', async () => {
    const { pool, chamadas } = poolFalso([]);

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), { team: 'financeiro' });

    if (res.ok) throw new Error('esperava recusa');
    expect(res.error.message).toMatch(/sem o campo team/iu);
    expect(mutacoes(chamadas)).toEqual([]);
  });

  it('SEM team: comportamento idêntico ao de antes — nem consulta os times', async () => {
    const { pool, chamadas } = poolFalso();

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), { reason: 'quer falar com alguém' });

    expect(res.ok).toBe(true);
    expect(
      chamadas.some((c) => /attendance_teams/i.test(c.sql)),
      'consulta a times num caminho que não pediu time',
    ).toBe(false);
    expect(chamadas.some((c) => /set team_id/i.test(c.sql))).toBe(false);
    // A passagem continua acontecendo, com o reason do modelo.
    const contato = chamadas.find((c) => /set force_human = true/i.test(c.sql));
    expect(contato?.params).toEqual([ORG, LEAD]);
  });

  it('a whitelist continua fechada: campo estranho é erro de ensino, não exceção', async () => {
    const { pool, chamadas } = poolFalso();

    const res = await applyRequestHumanHandoff(pool, IDS, opts(), {
      team: 'financeiro',
      organization_id: 'org-forjada',
    });

    if (res.ok) throw new Error('esperava recusa');
    expect(res.error.code).toBe('invalid_payload');
    expect(mutacoes(chamadas)).toEqual([]);
  });
});
