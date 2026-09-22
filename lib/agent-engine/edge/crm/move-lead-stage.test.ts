import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { LEAD_STAGES } from '../../agent/lead-state';
import { PASSOS_DE_AVANCO_COMERCIAL } from '@/lib/leads/nascimento-do-lead';
import { logger } from '@/lib/logger';

import { MIRROR_WARN_ONLY, mirrorLeadStageToCrm } from './move-lead-stage';

const cfg = { supabase: {} as never };
const db = {} as never;

describe('mirrorLeadStageToCrm', () => {
  it('move o card quando o pipeline declara destino para o passo', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: true, motivo: 'movido', leadId: 'lead-1', stageName: 'Negociação',
    });

    const r = await mirrorLeadStageToCrm(
      db, cfg as never,
      { tenantId: 'org-1', leadId: 'contato-1', toStage: 'negotiating' },
      { sync },
    );

    expect(r).toEqual({ ok: true });
    // O `leadId` do engine É o contact_id do CRM — trocar isso move o card errado.
    expect(sync).toHaveBeenCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'negotiating',
    });
  });

  it('estágio já ocupado é sucesso, não falha', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'ja_esta_la' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toEqual({ ok: true });
  });

  it.each(['sem_mapeamento', 'sem_negocio', 'ambiguo'])(
    'motivo %s vira not_configured (warn-only, sem item de inbox)',
    async (motivo) => {
      const sync = vi.fn().mockResolvedValue({ moveu: false, motivo });
      const r = await mirrorLeadStageToCrm(
        db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'qualified' }, { sync },
      );
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ reason: 'not_configured' });
    },
  );

  it('banco fora vira crm_unavailable — indisponibilidade NÃO pode virar estado normal', async () => {
    // O defeito que este teste fixa: o supabase-js não lança em falha de rede,
    // então o motor devolvia "sem_negocio" e o card parado parecia rotina.
    const sync = vi.fn().mockResolvedValue({
      moveu: false, motivo: 'indisponivel', detalhe: 'TypeError: fetch failed',
    });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_unavailable' });
    expect(MIRROR_WARN_ONLY.has('crm_unavailable')).toBe(false); // abre inbox
  });

  it('falha de escrita vira crm_error, nunca sucesso', async () => {
    const sync = vi.fn().mockResolvedValue({
      moveu: false, motivo: 'falha_de_escrita', detalhe: 'deadlock detected',
    });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
    expect(MIRROR_WARN_ONLY.has('crm_error')).toBe(false); // abre inbox
  });

  it('humano moveu o card antes: rótulo próprio, warn-only (sem inbox) e não é not_configured', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'conflito_humano' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'human_conflict' });
    expect(MIRROR_WARN_ONLY.has('human_conflict')).toBe(true); // sem ruído de inbox
  });

  it('motivo desconhecido não vira warn-only silencioso', async () => {
    const sync = vi.fn().mockResolvedValue({ moveu: false, motivo: 'inventado' });
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
  });

  it('erro da sincronização vira crm_error e NUNCA lança', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('supabase fora'));
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { tenantId: 'o', leadId: 'c', toStage: 'won' }, { sync },
    );
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
  });
});

/**
 * Decisão do dono (2026-09-22): com "Só conversas comerciais" ligada, o card
 * também nasce quando o AGENTE avança a conversa no funil e o contato ainda
 * não tem card — o classificador pode ter dito "ainda não", e o agente, que
 * conversou, viu o avanço.
 */
describe('mirrorLeadStageToCrm — o agente avançou e o contato não tem card', () => {
  const semNegocio = { moveu: false, motivo: 'sem_negocio' };
  const modoClassificador = async () => ({ modo: 'classificador' as const, limiar: 0.7 });
  const modoDeSempre = async () => ({ modo: 'toda_conversa' as const, limiar: 0.7 });
  const criado = { criado: true, leadId: 'lead-9', pipelineId: 'p', stageId: 's' };
  const entrada = { tenantId: 'org-1', leadId: 'contato-1', toStage: 'qualified' as const, conversationId: 'conv-1' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('só avanço comercial cria: qualifying, qualified, negotiating e won — todos passos do agente', () => {
    expect([...PASSOS_DE_AVANCO_COMERCIAL].sort()).toEqual(['negotiating', 'qualified', 'qualifying', 'won']);
    for (const passo of PASSOS_DE_AVANCO_COMERCIAL) expect(LEAD_STAGES).toContain(passo);
  });

  it('modo classificador + passo qualified: o card nasce com a origem do agente e a sincronização roda de novo', async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce(semNegocio)
      .mockResolvedValueOnce({ moveu: true, motivo: 'movido', leadId: 'lead-9', stageName: 'Qualificado' });
    const garantir = vi.fn().mockResolvedValue(criado);

    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra: modoClassificador, garantir });

    expect(r).toEqual({ ok: true });
    expect(garantir).toHaveBeenCalledWith(
      cfg.supabase,
      { organizationId: 'org-1', contactId: 'contato-1', conversationId: 'conv-1', nomeDoContato: null },
      { tipo: 'agente', passo: 'qualified' },
    );
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(cfg.supabase, {
      organizationId: 'org-1', contactId: 'contato-1', passo: 'qualified',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ organization_id: 'org-1', lead_id: 'lead-9', passo: 'qualified' }),
    );
  });

  it('sem etapa mapeada para o passo depois de nascer: ok — o card fica na primeira etapa, como sempre', async () => {
    const sync = vi.fn().mockResolvedValueOnce(semNegocio).mockResolvedValueOnce({ moveu: false, motivo: 'sem_mapeamento' });
    const garantir = vi.fn().mockResolvedValue(criado);
    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra: modoClassificador, garantir });
    expect(r).toEqual({ ok: true });
  });

  it.each(['new', 'contacted', 'lost'] as const)('passo %s não cria — não é avanço comercial', async (toStage) => {
    const sync = vi.fn().mockResolvedValue(semNegocio);
    const garantir = vi.fn();
    const r = await mirrorLeadStageToCrm(
      db, cfg as never, { ...entrada, toStage }, { sync, lerRegra: modoClassificador, garantir },
    );
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(garantir).not.toHaveBeenCalled();
  });

  it('modo de sempre (toda_conversa): não cria — segue o warn de hoje', async () => {
    const sync = vi.fn().mockResolvedValue(semNegocio);
    const garantir = vi.fn();
    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra: modoDeSempre, garantir });
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(garantir).not.toHaveBeenCalled();
  });

  it('falha ao ler a regra: não cria, não quebra o turno, e segue o warn de hoje', async () => {
    const sync = vi.fn().mockResolvedValue(semNegocio);
    const garantir = vi.fn();
    const lerRegra = vi.fn().mockRejectedValue(new Error('organização inexistente: org-1'));
    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra, garantir });
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(garantir).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('garantir diz ja_existe (corrida com o classificador): ressincroniza normal', async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce(semNegocio)
      .mockResolvedValueOnce({ moveu: true, motivo: 'movido', leadId: 'lead-do-classificador', stageName: 'Qualificado' });
    const garantir = vi.fn().mockResolvedValue({ criado: false, motivo: 'ja_existe' });
    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra: modoClassificador, garantir });
    expect(r).toEqual({ ok: true });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('garantir com erro de escrita: incidente (crm_error), que o caller leva à Central', async () => {
    const sync = vi.fn().mockResolvedValue(semNegocio);
    const garantir = vi.fn().mockResolvedValue({ criado: false, motivo: 'erro', detalhe: 'deadlock detected' });
    const r = await mirrorLeadStageToCrm(db, cfg as never, entrada, { sync, lerRegra: modoClassificador, garantir });
    expect(r).toMatchObject({ ok: false, reason: 'crm_error' });
    expect(MIRROR_WARN_ONLY.has('crm_error')).toBe(false);
  });

  it('sem conversationId: usa a conversa 1:1 mais recente do contato NA organização', async () => {
    const filtros: unknown[][] = [];
    const cadeia: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) {
      cadeia[m] = (...args: unknown[]) => {
        filtros.push([m, ...args]);
        return cadeia;
      };
    }
    cadeia.maybeSingle = async () => ({ data: { id: 'conv-recente' }, error: null });
    const supabase = { from: (tabela: string) => (filtros.push(['from', tabela]), cadeia) };
    const sync = vi.fn().mockResolvedValueOnce(semNegocio).mockResolvedValueOnce({ moveu: false, motivo: 'sem_mapeamento' });
    const garantir = vi.fn().mockResolvedValue(criado);
    const { conversationId: _semConversa, ...semConversa } = entrada;

    await mirrorLeadStageToCrm(db, { supabase } as never, semConversa, { sync, lerRegra: modoClassificador, garantir });

    expect(filtros).toContainEqual(['from', 'conversations']);
    expect(filtros).toContainEqual(['eq', 'organization_id', 'org-1']);
    expect(filtros).toContainEqual(['eq', 'contact_id', 'contato-1']);
    expect(filtros).toContainEqual(['eq', 'is_group', false]);
    expect(garantir).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ conversationId: 'conv-recente' }),
      { tipo: 'agente', passo: 'qualified' },
    );
  });
});
