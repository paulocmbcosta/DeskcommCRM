/**
 * Espelho do avanço de funil no kanban do CRM — LIGADO. O harness (lead_state) é
 * a fonte da verdade do funil do agente; quando o agente avança um passo, o card
 * do tenant anda junto no board, traduzido pelo `crm_stages.agent_stage_hint`.
 *
 * ⚠️ Este arquivo NÃO decide qual negócio do contato se move: ele DELEGA para
 * `sincronizaEstagioDoAgente`, que reusa o `resolveActiveLeadForContact` da wave
 * 4. Um segundo resolvedor aqui seriam duas fontes que começam iguais e divergem
 * no primeiro ajuste.
 *
 * Cada não-movimento vira o rótulo que diz a verdade sobre ele (ver MIRROR_WARN_ONLY):
 * configuração e conflito com humano são estado normal; banco fora e escrita
 * falha são incidente e abrem item de inbox no caller.
 *
 * ⚠️ O CARD PODE NASCER AQUI (decisão do dono, 2026-09-22). Com a regra "Só
 * conversas comerciais" ligada (`settings.crm.nascimento_do_card.modo =
 * 'classificador'`), o contato pode chegar a um avanço comercial do agente
 * sem card — o classificador leu "ainda não", e o agente, que conversou, viu
 * o avanço. Então, se o contato não tem negócio aberto e o passo é avanço
 * comercial (`PASSOS_DE_AVANCO_COMERCIAL`), o card nasce pela MESMA
 * `garantirLeadDaConversa` (funil de entrada, trava por contato), com a origem
 * `agente`, e a sincronização roda de novo para ele ir à etapa mapeada.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { sincronizaEstagioDoAgente, type ResultadoDaSincronizacao } from '@/lib/leads/agent-stage-sync';
import { lerNascimentoDoCard } from '@/lib/leads/modo-de-nascimento';
import { ehAvancoComercial, garantirLeadDaConversa } from '@/lib/leads/nascimento-do-lead';
import { logger } from '@/lib/logger';
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { LeadStage } from '../../agent/lead-state';

export type MirrorReason =
  | 'not_configured'
  | 'human_conflict'
  /**
   * O negócio está num funil que este agente não cuida (spec 17 passo 3).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, de propósito. É estado legítimo do produto —
   * mas no dia 1 de cada agente ele é 100% dos movimentos, e um veto silencioso
   * em massa se lê como "a IA parou de funcionar". O aviso é o que transforma
   * uma proteção num fato compreensível.
   */
  | 'fora_do_escopo'
  | 'crm_error'
  | 'crm_unavailable';

export type MirrorResult = { ok: true } | { ok: false; reason: MirrorReason; detail: string };

/**
 * Os não-movimentos que são ESTADO LEGÍTIMO do produto: warn no log do run, sem
 * item de inbox. O que fica de fora (crm_error, crm_unavailable) é incidente de
 * verdade — o funil parou e alguém precisa saber. Um rótulo honesto de cada lado
 * é o que impede o inbox de virar ruído que o usuário aprende a ignorar.
 */
export const MIRROR_WARN_ONLY: ReadonlySet<MirrorReason> = new Set<MirrorReason>([
  'not_configured',
  'human_conflict',
]);

/** Injetável só para teste — em produção é sempre a implementação real. */
interface Deps {
  sync?: typeof sincronizaEstagioDoAgente;
  lerRegra?: typeof lerNascimentoDoCard;
  garantir?: typeof garantirLeadDaConversa;
}

type EntradaDoEspelho = {
  tenantId: string;
  leadId: string;
  toStage: LeadStage;
  reason?: string;
  /** A conversa do turno. Sem ela, vale a 1:1 mais recente do contato na organização. */
  conversationId?: string;
};

/** Mesma régua de `get-lead-context.ts`: a 1:1 mais recente do contato; grupo nunca. */
async function conversaMaisRecente(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('conversations')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('contact_id', contactId)
    .eq('is_group', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * O agente avançou e o contato não tem card: nasce um, se a regra manda.
 *
 * `null` = não é caso de nascer aqui (passo não comercial, regra de sempre, ou
 * a regra não pôde ser lida) — quem chama segue com o warn de hoje.
 *
 * ⚠️ AQUI A LEITURA DA REGRA FALHA FECHADA — não cria. `lerNascimentoDoCard`
 * (lib/leads/modo-de-nascimento.ts) NUNCA lança: em erro ele loga e devolve
 * `toda_conversa`, que neste ponto significa exatamente "não crie". O `catch`
 * abaixo cobre o resto — a busca da conversa (`conversaMaisRecente`) e
 * qualquer imprevisto —, e a escolha é a mesma: não criar.
 *
 * É o oposto do worker do classificador, onde a mesma leitura LANÇA para o
 * drain tentar de novo (`lib/classificador-comercial/dados.ts`): lá o evento
 * volta à fila; aqui não há fila — é o turno do agente, e lançar derrubaria o
 * turno (o espelho NUNCA reverte o harness nem falha o job). Não criar é o
 * comportamento de antes da decisão existir, e não perde o card: a próxima
 * mensagem do cliente passa pelo classificador, e o próximo avanço do agente
 * pergunta de novo.
 *
 * ⚠️ A RESSINCRONIZAÇÃO NÃO PASSA `escopoDeFunis`, como o caminho legado deste
 * espelho: o card nasce no funil de ENTRADA da organização, mesmo que este
 * assistente não cuide dele — e aí o movimento seguinte pode ser vetado por
 * escopo. A spec 17 (c) fala em criar "dentro do escopo marcado"; a
 * divergência fica registrada aqui, e o efeito é conservador (o card existe e
 * aparece; quem não pode mexer nele é o agente).
 */
async function nascerPeloAgente(
  admin: SupabaseClient,
  input: EntradaDoEspelho,
  deps: Required<Deps>,
): Promise<MirrorResult | null> {
  const passo = input.toStage;
  if (!ehAvancoComercial(passo)) return null;

  let conversationId: string | null;
  try {
    const regra = await deps.lerRegra(admin, input.tenantId);
    if (regra.modo !== 'classificador') return null;
    conversationId = input.conversationId ?? (await conversaMaisRecente(admin, input.tenantId, input.leadId));
  } catch (err) {
    logger.warn('[move-lead-stage] regra do card ilegível — o agente não abre card neste avanço', {
      organization_id: input.tenantId,
      contact_id: input.leadId,
      passo,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return null;
  }
  if (!conversationId) return null;

  const nascimento = await deps.garantir(
    admin,
    { organizationId: input.tenantId, contactId: input.leadId, conversationId, nomeDoContato: null },
    { tipo: 'agente', passo },
  );
  if (!nascimento.criado) {
    // Incidente: o caller abre item na Central para `crm_error`.
    if (nascimento.motivo === 'erro') {
      return { ok: false, reason: 'crm_error', detail: `o card não nasceu: ${nascimento.detalhe ?? 'erro'}` };
    }
    // `ja_existe`: corrida — o classificador (ou uma segunda chamada) criou o
    // card no meio. Não é falha: ressincroniza como sempre.
    if (nascimento.motivo === 'ja_existe') {
      return traduzir(await deps.sync(admin, sincronizacao(input)), input);
    }
    // Opt-out, funil de entrada sem funil/etapa: estado do produto, não incidente.
    return {
      ok: false,
      reason: 'not_configured',
      detail: `o contato não tem negócio aberto e o card não pôde nascer (${nascimento.motivo})`,
    };
  }

  logger.info('[move-lead-stage] o agente abriu o card do contato', {
    organization_id: input.tenantId,
    conversation_id: conversationId,
    lead_id: nascimento.leadId,
    passo,
  });
  // O card nasceu na primeira etapa do funil de entrada; agora vai para a
  // etapa mapeada ao passo, se houver. Sem mapeamento ele fica onde nasceu,
  // como qualquer card — e isso é sucesso.
  const r = await deps.sync(admin, sincronizacao(input));
  if (r.motivo === 'sem_mapeamento') return { ok: true };
  return traduzir(r, input);
}

function sincronizacao(input: EntradaDoEspelho) {
  // `input.leadId` é o contact_id do CRM: o funil do agente é por CONTATO
  // (lead_state.contact_id) e quem resolve "qual negócio deste contato" é o
  // `resolveActiveLeadForContact` lá dentro — não aqui.
  return { organizationId: input.tenantId, contactId: input.leadId, passo: input.toStage };
}

export async function mirrorLeadStageToCrm(
  _db: Queryable,
  cfg: CrmEdgeConfig,
  input: EntradaDoEspelho,
  deps: Deps = {},
): Promise<MirrorResult> {
  const todas: Required<Deps> = {
    sync: deps.sync ?? sincronizaEstagioDoAgente,
    lerRegra: deps.lerRegra ?? lerNascimentoDoCard,
    garantir: deps.garantir ?? garantirLeadDaConversa,
  };
  try {
    const r = await todas.sync(cfg.supabase, sincronizacao(input));
    if (r.motivo === 'sem_negocio') {
      const nascido = await nascerPeloAgente(cfg.supabase, input, todas);
      if (nascido) return nascido;
    }
    return traduzir(r, input);
  } catch (err) {
    return {
      ok: false,
      reason: 'crm_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function traduzir(r: ResultadoDaSincronizacao, input: EntradaDoEspelho): MirrorResult {
  if (r.moveu || r.motivo === 'ja_esta_la') return { ok: true };

  // Cada motivo vira o rótulo que DIZ A VERDADE sobre ele. Os três primeiros
  // são configuração/estado normal (warn-only, sem inbox); `conflito_humano`
  // também não é incidente — o humano venceu a corrida e a decisão dele vale —
  // mas chamá-lo de `not_configured` mentiria sobre a causa para quem lê o log.
  // Banco fora e escrita falha SÃO incidentes: viram item de inbox no caller.
  const traduz: Record<string, { reason: MirrorReason; detail: string }> = {
    sem_mapeamento: {
      reason: 'not_configured',
      detail: `nenhum estágio do pipeline declara agent_stage_hint = "${input.toStage}"`,
    },
    sem_negocio: { reason: 'not_configured', detail: 'o contato não tem negócio aberto para mover' },
    // O detalhe vem do sync (distingue "nenhum funil liberado" de "funil de
    // outro time") e é o que o aviso na Central mostra ao dono.
    fora_do_escopo: {
      reason: 'fora_do_escopo',
      detail: 'este assistente não cuida do funil onde o negócio está',
    },
    ambiguo: {
      reason: 'not_configured',
      detail: 'o contato tem mais de um negócio aberto — nenhum foi movido',
    },
    conflito_humano: {
      reason: 'human_conflict',
      detail: 'um humano moveu o card durante a operação — a decisão dele prevalece',
    },
    falha_de_escrita: {
      reason: 'crm_error',
      detail: `o UPDATE do card falhou: ${r.detalhe ?? 'sem detalhe'}`,
    },
    indisponivel: {
      reason: 'crm_unavailable',
      detail: `o banco do CRM não respondeu: ${r.detalhe ?? 'sem detalhe'}`,
    },
  };
  const t = traduz[r.motivo];
  // O `detalhe` do sync VENCE o texto genérico da tabela quando existe: ele
  // sabe QUAL dos dois casos de escopo aconteceu, e o dono precisa dessa
  // diferença para saber se marca um funil ou não faz nada.
  if (t && r.detalhe) return { ok: false, reason: t.reason, detail: r.detalhe };
  // Motivo desconhecido NÃO pode virar warn-only silencioso: rótulo novo sem
  // tradução aqui é bug de programação, e o inbox é onde ele aparece.
  if (!t) return { ok: false, reason: 'crm_error', detail: `motivo não traduzido: ${r.motivo}` };
  return { ok: false, ...t };
}
