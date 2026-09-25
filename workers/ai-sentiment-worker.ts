/**
 * ai-sentiment-worker — como o cliente está com o ATENDIMENTO (não com a frase).
 *
 * Consome `message.received`. A cada mensagem do cliente, o Jev (TypeSafe, pela
 * OpenRouter) lê o atendimento em aberto INTEIRO — do início do atendimento
 * vigente até agora — e responde uma pergunta `score`: o nível de satisfação
 * do cliente. A nota (0..1) vai para a conversa (`sentimento_atual` /
 * `sentimento_minimo`, migration 0280) e para a mensagem que disparou a leitura
 * (`messages.metadata.sentiment_score`, com `sentiment_escopo = 'atendimento'`:
 * é a leitura do atendimento NAQUELE momento, e é o que desenha a evolução na
 * tela). O porquê de cada escolha — atendimento inteiro, Jev, a escala — está no
 * topo de `lib/sentimento/avaliacao-do-atendimento.ts`.
 *
 * Até a 1.45 este worker classificava UMA mensagem por vez com um modelo de
 * conversa (`generateObject`), e a nota da conversa era a da última frase: dez
 * reclamações e um "ok, obrigado" viravam "satisfeito".
 *
 * Economia:
 *  - rajada: se já chegou mensagem MAIS NOVA do cliente nesta conversa, esta
 *    leitura é pulada — a da mais nova lê o atendimento inteiro, inclusive esta;
 *  - áudio ainda virando texto: espera (até 2 min) em vez de avaliar sem ele.
 *
 * Princípios (CLAUDE.md):
 *  - service role ignora RLS → TODA consulta filtra `organization_id` vindo da
 *    linha do `event_log`, nunca do payload externo;
 *  - nunca derruba o caminho do bot: falha vira `skipped` (ou `retry` para
 *    falha temporária do Jev, com teto pela idade do evento);
 *  - sem chave da OpenRouter (nem da organização, nem da instalação) — ela é
 *    opcional no `install.sh` —, a MESMA pergunta vai ao modelo de conversa da
 *    organização (o escolhido em IA › Provedores para "Medir o clima do
 *    atendimento"): mais caro e mais lento, mas ninguém perde a avaliação ao
 *    atualizar. Sem chave de IA nenhuma, `skipped` com `sem_chave_de_ia`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { z } from "zod";

import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";
import { resolverAgenteDaConversa } from "@/lib/ai/agents/agente-da-conversa";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { computeCost } from "@/lib/ai/cost";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logInvocation } from "@/lib/ai/log-invocation";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { dadosViaSupabase, type DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import type { EstadoDoJev } from "@/lib/classificador-comercial/perguntas";
import { consultarSystemOne, type FalhaDoJev } from "@/lib/classificador-comercial/jev";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import {
  LIMITE_DE_FALAS_DO_ATENDIMENTO,
  lerRespostaDeSatisfacao,
  MODELO_DO_JEV,
  montarEstadoDoAtendimento,
  NIVEIS_DE_SATISFACAO,
  notaDoScore,
  PERGUNTAS_DE_SATISFACAO,
  promptDoModeloDeConversa,
  SISTEMA_DO_MODELO_DE_CONVERSA,
} from "@/lib/sentimento/avaliacao-do-atendimento";
import { createAdminClient } from "@/lib/supabase/admin";

const DEFAULT_SENTIMENT_THRESHOLD = 0.3;
/** Roda também no dreno da requisição (webhook): o teto é o mesmo que o classificador antigo tinha. */
export const TEMPO_LIMITE_DO_JEV_MS = 5_000;
export const ESPERA_POR_TRANSCRICAO_MS = 15_000;
export const TETO_ESPERA_TRANSCRICAO_MS = 120_000;
export const ESPERA_APOS_FALHA_TEMPORARIA_MS = 60_000;
/** O `retry` do dispatcher não conta tentativa: o teto é pela IDADE do evento. */
export const TETO_DE_FALHA_TEMPORARIA_MS = 10 * 60_000;

export interface SentimentResult {
  skipped: boolean;
  reason?: string;
  sentiment_score?: number;
  /** Presente = devolver ao dreno para tentar de novo nesta hora. */
  retryAt?: Date;
}

export interface DependenciasDoSentimento {
  admin: SupabaseClient;
  dados: Pick<DadosDoClassificador, "ultimasMensagens">;
  chave: typeof chaveDaOpenRouter;
  consultar: typeof consultarSystemOne;
  /** Só sem chave da OpenRouter: o modelo de conversa escolhido no painel para este ponto. */
  modeloDoPonto: typeof resolverModeloDoPonto;
  gerarObjeto: typeof generateObject;
  agora: () => Date;
  baseUrl?: string;
}

function dependenciasReais(): DependenciasDoSentimento {
  const admin = createAdminClient();
  return {
    admin,
    dados: dadosViaSupabase(admin),
    chave: chaveDaOpenRouter,
    consultar: consultarSystemOne,
    modeloDoPonto: resolverModeloDoPonto,
    gerarObjeto: generateObject,
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

interface LinhaDaMensagem {
  id: string;
  direction: string;
  type: string | null;
  media_derived_status: string | null;
  conversation_id: string | null;
  sent_at: string | null;
  created_at: string | null;
}

export async function processSentiment(
  event: EventRow,
  depsDados?: DependenciasDoSentimento,
): Promise<SentimentResult> {
  try {
    const deps = depsDados ?? dependenciasReais();
    const admin = deps.admin;
    const org = event.organization_id;

    const messageId = (event.payload?.["message_id"] as string | undefined) ?? event.entity_id ?? null;
    if (!messageId) return { skipped: true, reason: "missing_message_id" };

    // ── A mensagem que disparou (filtro de org programático) ─────────────
    const { data: lida, error: msgErr } = await admin
      .from("messages")
      .select("id, direction, type, media_derived_status, conversation_id, sent_at, created_at")
      .eq("id", messageId)
      .eq("organization_id", org)
      .maybeSingle();
    const message = lida as LinhaDaMensagem | null;
    if (msgErr || !message) return { skipped: true, reason: "message_not_found" };
    if (message.direction !== "inbound") return { skipped: true, reason: "not_inbound" };

    const conversationId =
      (event.payload?.["conversation_id"] as string | undefined) ?? message.conversation_id ?? null;
    if (!conversationId) return { skipped: true, reason: "missing_conversation_id" };
    const quando = message.sent_at ?? message.created_at ?? deps.agora().toISOString();

    // ── Rajada: uma mensagem mais nova do cliente já vai ler tudo isto ───
    const { data: maisNova } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", org)
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .gt("sent_at", quando)
      .neq("id", messageId)
      .limit(1)
      .maybeSingle();
    if (maisNova) return { skipped: true, reason: "coberta_por_mensagem_mais_nova" };

    // ── Elegibilidade da IA ──────────────────────────────────────────────
    // Numa conversa que o gate `allowlist` barra, a IA não fala com o cliente —
    // e esta avaliação existe para a equipe E para orientar o agente. Mantido
    // como estava: pula cedo, sem custo. Fail-closed.
    try {
      const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: org,
        conversationId,
        agora: deps.agora(),
        ttlMs: ttlDaAutorizacaoMs(process.env),
      });
      if (elegib !== null && elegib.bloqueioPorAllowlist) return { skipped: true, reason: "nao_elegivel_para_ia" };
    } catch {
      return { skipped: true, reason: "elegibilidade_indeterminada" };
    }

    const agoraMs = deps.agora().getTime();
    // Idade desconhecida conta como vencida: `retry` não conta tentativa, e um
    // evento sem `created_at` repetiria para sempre.
    const idadeMs = event.created_at ? agoraMs - new Date(event.created_at).getTime() : Number.POSITIVE_INFINITY;

    // ── Áudio ainda virando texto: esperar, senão a fala dele fica de fora ─
    if (
      message.type !== null &&
      TIPOS_DERIVAVEIS.has(message.type) &&
      !DERIVACAO_TERMINADA.has(message.media_derived_status ?? "") &&
      idadeMs < TETO_ESPERA_TRANSCRICAO_MS
    ) {
      return {
        skipped: true,
        reason: "aguardando_transcricao",
        retryAt: new Date(agoraMs + ESPERA_POR_TRANSCRICAO_MS),
      };
    }

    // ── Qual agente atende ESTA conversa? (o limiar é dele — issue #486) ──
    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel_session_id, active_ai_agent_id")
      .eq("id", conversationId)
      .eq("organization_id", org)
      .maybeSingle();

    let versoesPublicadasNaSessao: string[] | null = null;
    if (conversa?.channel_session_id) {
      const { data: versoes } = await admin
        .from("ai_agent_versions")
        .select("id, channel_session_id, status")
        .eq("organization_id", org)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos } = await admin
      .from("ai_agents")
      .select("id, config, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at")
      .eq("organization_id", org)
      .is("archived_at", null);

    const { agente: agent, motivo: motivoDoAgente } = resolverAgenteDaConversa(
      candidatos ?? [],
      conversa
        ? {
            active_ai_agent_id: conversa.active_ai_agent_id as string | null,
            versoesPublicadasNaSessao,
          }
        : null,
    );

    // Sem agente resolvido, o padrão do PRODUTO — nunca o limiar do vizinho.
    const agentConfig = (agent?.config as Record<string, unknown> | null) ?? {};
    const threshold =
      typeof agentConfig["sentiment_threshold"] === "number"
        ? agentConfig["sentiment_threshold"]
        : DEFAULT_SENTIMENT_THRESHOLD;

    // ── O que o Jev lê: o atendimento vigente inteiro ────────────────────
    const estado = montarEstadoDoAtendimento(
      await deps.dados.ultimasMensagens(org, conversationId, LIMITE_DE_FALAS_DO_ATENDIMENTO * 2),
    );
    if (!estado) return { skipped: true, reason: "sem_texto_do_cliente" };

    const contexto: ContextoDaAvaliacao = {
      org,
      conversationId,
      messageId,
      agentId: agent?.id ?? null,
      idadeMs,
      agoraMs,
    };
    const chave = await deps.chave(admin, org);
    const desfecho = chave
      ? await avaliarComJev(deps, contexto, estado, chave.apiKey)
      : await avaliarComModeloDeConversa(deps, contexto, estado);
    if (desfecho.tipo === "pular") {
      return { skipped: true, reason: desfecho.reason, ...(desfecho.retryAt ? { retryAt: desfecho.retryAt } : {}) };
    }
    const { nota, latenciaMs } = desfecho;

    // ── A leitura na mensagem que a disparou ─────────────────────────────
    // MERGE NO BANCO (migration 0276): entre ler e gravar passam os segundos do
    // Jev, e regravar a cópia lida apagaria a reação que alguém deu no meio.
    const { error: updateErr } = await admin.rpc("fn_mesclar_metadata_da_mensagem" as never, {
      p_org: org,
      p_id: messageId,
      p_patch: {
        sentiment_score: nota,
        sentiment_escopo: "atendimento",
        sentiment_latency_ms: latenciaMs,
        sentiment_motor: desfecho.motor,
      },
    } as never);
    if (updateErr) {
      logger.warn("[ai-sentiment-worker] metadata da mensagem não gravado", {
        message_id: messageId,
        error: updateErr.message.slice(0, 160),
      });
    }

    // ── A nota na conversa (migration 0280) ──────────────────────────────
    // `p_em` é a hora da mensagem que disparou: leitura que chega fora de ordem
    // (a de uma mensagem mais velha) não sobrescreve a atual, e a pior do
    // atendimento fica em `sentimento_minimo`.
    const { error: convErr } = await admin.rpc("fn_registrar_sentimento_da_conversa" as never, {
      p_org: org,
      p_conversation: conversationId,
      p_score: nota,
      p_em: quando,
    } as never);
    if (convErr) {
      logger.warn("[ai-sentiment-worker] sentimento da conversa não gravado", {
        message_id: messageId,
        error: convErr.message.slice(0, 160),
      });
    }

    // ── Abaixo do limite do agente: vira linha do tempo ──────────────────
    if (nota < threshold) {
      const { error: emitErr } = await admin.rpc(
        "emit_event" as never,
        {
          p_event_type: "ai.sentiment_alert",
          p_entity_kind: "message",
          p_entity_id: messageId,
          p_payload: { message_id: messageId, conversation_id: conversationId, sentiment_score: nota },
          // `agent_id` e `motivo` viajam com o alerta porque o limiar é o número
          // que decidiu emiti-lo (issue #486).
          p_metadata: {
            source: "ai-sentiment-worker",
            escopo: "atendimento",
            motor: desfecho.motor,
            threshold,
            agent_id: agent?.id ?? null,
            agente_resolvido_por: motivoDoAgente,
          },
          p_organization_id: org,
        } as never,
      );
      if (emitErr) {
        logger.warn("[ai-sentiment-worker] ai.sentiment_alert não emitido", {
          message_id: messageId,
          error: emitErr.message.slice(0, 160),
        });
      }
    }

    return { skipped: false, sentiment_score: nota };
  } catch (err) {
    // NUNCA lança — não pode derrubar o caminho do bot.
    logger.warn("[ai-sentiment-worker] avaliação do atendimento falhou", {
      event_id: event.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return { skipped: true, reason: "classify_failed" };
  }
}

// ── Os dois motores ─────────────────────────────────────────────────────────

interface ContextoDaAvaliacao {
  org: string;
  conversationId: string;
  messageId: string;
  agentId: string | null;
  idadeMs: number;
  agoraMs: number;
}

type Desfecho =
  | { tipo: "nota"; nota: number; latenciaMs: number; motor: "jev" | "modelo_de_conversa" }
  | { tipo: "pular"; reason: string; retryAt?: Date };

/** Com chave da OpenRouter: o Jev, pergunta `score` (ver `avaliacao-do-atendimento.ts`). */
async function avaliarComJev(
  deps: DependenciasDoSentimento,
  c: ContextoDaAvaliacao,
  estado: EstadoDoJev,
  apiKey: string,
): Promise<Desfecho> {
  const atribuicao = cabecalhosDeAtribuicaoOpenRouter();
  const r = await deps.consultar({
    apiKey,
    estado,
    perguntas: PERGUNTAS_DE_SATISFACAO,
    modelo: MODELO_DO_JEV,
    tempoLimiteMs: TEMPO_LIMITE_DO_JEV_MS,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(atribuicao ? { cabecalhosExtras: atribuicao } : {}),
  });

  const leitura = r.ok ? lerRespostaDeSatisfacao(r.corpo, MODELO_DO_JEV) : null;
  const falha: FalhaDoJev | null = !r.ok
    ? r.falha
    : leitura && !leitura.ok
      ? { tipo: "contrato", status: r.status, detalhe: leitura.detalhe }
      : null;
  const avaliacao = leitura?.ok ? leitura.avaliacao : null;

  // Toda chamada, com sucesso ou falha, vira linha em `llm_calls` — é o que
  // IA › Execuções mostra, e o custo entra no teto da organização.
  logInvocation({
    organization_id: c.org,
    agent_id: c.agentId,
    conversation_id: c.conversationId,
    message_id: c.messageId,
    invocation_kind: "sentiment_classify",
    model: avaliacao?.modelo ?? MODELO_DO_JEV,
    prompt_tokens: avaliacao?.tokensDeEntrada ?? 0,
    completion_tokens: 0,
    latency_ms: r.latenciaMs,
    cost_cents: avaliacao?.custoEmCentavos ?? 0,
    finish_reason: falha ? "error" : null,
    error_payload: falha ? { message: falha.detalhe, ...(falha.status !== null ? { status: falha.status } : {}) } : null,
  });

  if (avaliacao) return { tipo: "nota", nota: avaliacao.nota, latenciaMs: r.latenciaMs, motor: "jev" };

  if (falha?.tipo === "temporaria" && c.idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
    return {
      tipo: "pular",
      reason: `jev_${falha.status ?? "rede"}`,
      retryAt: new Date(c.agoraMs + ESPERA_APOS_FALHA_TEMPORARIA_MS),
    };
  }
  logger.warn("[ai-sentiment-worker] o Jev não avaliou o atendimento", {
    organization_id: c.org,
    conversation_id: c.conversationId,
    tipo: falha?.tipo ?? "desconhecido",
    status: falha?.status ?? null,
  });
  return { tipo: "pular", reason: `jev_falhou:${falha?.tipo ?? "desconhecido"}` };
}

// As descrições viram o JSON Schema da ferramenta que o modelo recebe: sem
// elas o limite existia só no validador e o modelo escrevia 300 caracteres
// (medido na versão anterior deste worker). `justificativa` é descartada —
// existe para o modelo raciocinar antes de escolher o nível.
const avaliacaoDoModeloSchema = z.object({
  justificativa: z.string().max(280).describe("Justificativa curta do nível, em NO MÁXIMO 100 caracteres"),
  nivel: z
    .number()
    .int()
    .min(0)
    .max(NIVEIS_DE_SATISFACAO.length - 1)
    .describe("0 = muito insatisfeito, 2 = neutro, 4 = muito satisfeito"),
});

/** Sem chave da OpenRouter: a mesma pergunta, ao modelo de conversa da organização. */
async function avaliarComModeloDeConversa(
  deps: DependenciasDoSentimento,
  c: ContextoDaAvaliacao,
  estado: EstadoDoJev,
): Promise<Desfecho> {
  const resolvido = await deps.modeloDoPonto("sentiment_classify", c.org, DEFAULT_CLASSIFIER_MODEL);
  if (!resolvido) return { tipo: "pular", reason: "sem_chave_de_ia" };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEMPO_LIMITE_DO_JEV_MS);
  const inicio = Date.now();
  let entrada = 0;
  let saida = 0;
  try {
    const gerado = await deps.gerarObjeto({
      model: resolvido.model,
      schema: avaliacaoDoModeloSchema,
      system: SISTEMA_DO_MODELO_DE_CONVERSA,
      prompt: promptDoModeloDeConversa(estado),
      temperature: 0,
      // Modo ferramenta custa mais que texto puro; 256 dá folga sem cheque em branco.
      maxOutputTokens: 256,
      abortSignal: abort.signal,
    });
    const uso = gerado.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    entrada = uso?.inputTokens ?? 0;
    saida = uso?.outputTokens ?? 0;
    const latenciaMs = Date.now() - inicio;
    logInvocation({
      organization_id: c.org,
      agent_id: c.agentId,
      conversation_id: c.conversationId,
      message_id: c.messageId,
      invocation_kind: "sentiment_classify",
      model: resolvido.modelId,
      prompt_tokens: entrada,
      completion_tokens: saida,
      latency_ms: latenciaMs,
      // Preço ilegível não pode jogar fora uma nota que já chegou.
      cost_cents: await computeCost({ model: resolvido.modelId, promptTokens: entrada, completionTokens: saida }).catch(
        () => 0,
      ),
      finish_reason: null,
    });
    return { tipo: "nota", nota: notaDoScore(gerado.object.nivel), latenciaMs, motor: "modelo_de_conversa" };
  } catch (err) {
    logInvocation({
      organization_id: c.org,
      agent_id: c.agentId,
      conversation_id: c.conversationId,
      message_id: c.messageId,
      invocation_kind: "sentiment_classify",
      model: resolvido.modelId,
      prompt_tokens: entrada,
      completion_tokens: saida,
      latency_ms: Date.now() - inicio,
      cost_cents: 0,
      finish_reason: "error",
      error_payload: { message: err instanceof Error ? err.message : String(err) },
    });
    return { tipo: "pular", reason: "modelo_de_conversa_falhou" };
  } finally {
    clearTimeout(timer);
  }
}
