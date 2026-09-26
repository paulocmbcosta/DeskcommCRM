/**
 * A ASSISTENTE DECIDE SE A ESPERA CONTA — consumidor de `message.received`.
 *
 * O trigger (0279/0285) liga a espera na hora; aqui a Assistente (o Jev por
 * baixo) só pode DISPENSAR (decisão A do plano 2026-09-26). Toda saída que
 * não seja "dispensada" deixa a espera contando, como antes da feature.
 *
 * Ordem, do mais barato ao mais caro: é entrada? a conversa espera gente
 * (humano/aguardando) e ainda espera? um humano já mandou contar? → só então
 * transcrição, chave e Jev. A dispensa é um UPDATE condicional
 * (`lib/espera/dados.ts`): se o cliente escreveu ou alguém respondeu enquanto
 * o Jev pensava, não grava nada — o evento da mensagem nova decide de novo.
 *
 * Custo: toda chamada vira linha em `llm_calls` com `purpose = wait_classify`
 * (IA › Execuções). Sem chave da OpenRouter a feature não roda (decisão G).
 */
import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { dadosViaSupabase, type DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import { consultarSystemOne, type FalhaDoJev } from "@/lib/classificador-comercial/jev";
import { dadosDaEsperaViaSupabase, type DadosDaEspera } from "@/lib/espera/dados";
import { decidirDispensa, lerRespostaDaEspera, MODELO_DO_JEV, montarEstadoDaEspera, PERGUNTAS_DA_ESPERA } from "@/lib/espera/pede-resposta";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ESPERA_APOS_FALHA_TEMPORARIA_MS,
  ESPERA_POR_TRANSCRICAO_MS,
  registrarNoLlmCalls,
  TETO_DE_FALHA_TEMPORARIA_MS,
  TETO_ESPERA_TRANSCRICAO_MS,
  type LinhaDeChamada,
} from "@/workers/classificador-comercial";

export const TEMPO_LIMITE_DA_ESPERA_MS = 5_000;
const COMANDOS_QUE_ESPERAM_GENTE: ReadonlySet<string> = new Set(["humano", "aguardando"]);

export type ResultadoDaEspera =
  | { status: "pulado"; motivo: string }
  | { status: "tentar_de_novo"; em: Date; motivo: string }
  | { status: "pede_resposta"; probabilidade: number }
  | { status: "dispensada"; probabilidade: number };

export interface DependenciasDaEspera {
  espera: DadosDaEspera;
  mensagens: Pick<DadosDoClassificador, "mensagem" | "ultimasMensagens" | "derivacaoPendente">;
  chave: (org: string) => ReturnType<typeof chaveDaOpenRouter>;
  consultar: typeof consultarSystemOne;
  registrarChamada: (linha: LinhaDeChamada) => void;
  agora: () => Date;
  baseUrl?: string;
}

function dependenciasReais(): DependenciasDaEspera {
  const admin = createAdminClient();
  return {
    espera: dadosDaEsperaViaSupabase(admin),
    mensagens: dadosViaSupabase(admin),
    chave: (org) => chaveDaOpenRouter(admin, org),
    consultar: consultarSystemOne,
    registrarChamada: registrarNoLlmCalls(admin, "wait_classify"),
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Predicado `foraDaRequisicao`: só adia (paga o Jev fora do webhook) quem pode ser dispensado. Falha ⇒ adia. */
export async function esperaPodeSerDispensada(
  event: EventRow,
  espera: Pick<DadosDaEspera, "conversa"> = dadosDaEsperaViaSupabase(createAdminClient()),
): Promise<boolean> {
  const conversationId = texto(event.payload?.conversation_id);
  if (event.payload?.direction !== "inbound" || !conversationId) return false;
  try {
    const c = await espera.conversa(event.organization_id, conversationId);
    return Boolean(c?.espera_desde && !c.espera_mantida_em && COMANDOS_QUE_ESPERAM_GENTE.has(c.comando_da_conversa ?? ""));
  } catch {
    return true;
  }
}

export async function processarEspera(event: EventRow, deps: DependenciasDaEspera = dependenciasReais()): Promise<ResultadoDaEspera> {
  const p = event.payload ?? {};
  if (p.direction !== "inbound") return { status: "pulado", motivo: "nao_e_entrada" };
  const messageId = texto(p.message_id) ?? event.entity_id;
  const conversationId = texto(p.conversation_id);
  const contactId = texto(p.contact_id);
  if (!messageId || !conversationId || !contactId) return { status: "pulado", motivo: "payload_incompleto" };
  const org = event.organization_id;

  const c = await deps.espera.conversa(org, conversationId);
  if (!c || !c.espera_desde || !c.last_inbound_at) return { status: "pulado", motivo: "sem_espera" };
  if (!COMANDOS_QUE_ESPERAM_GENTE.has(c.comando_da_conversa ?? "")) return { status: "pulado", motivo: "automatico" };
  if (c.espera_mantida_em) return { status: "pulado", motivo: "mantida_por_humano" };

  const agora = deps.agora().getTime();
  const idadeMs = event.created_at ? agora - new Date(event.created_at).getTime() : Number.POSITIVE_INFINITY;

  const disparadora = await deps.mensagens.mensagem(org, messageId);
  const aguardandoTexto =
    disparadora && TIPOS_DERIVAVEIS.has(disparadora.type) && !DERIVACAO_TERMINADA.has(disparadora.media_derived_status ?? "");
  if (aguardandoTexto && idadeMs < TETO_ESPERA_TRANSCRICAO_MS) {
    return { status: "tentar_de_novo", em: new Date(agora + ESPERA_POR_TRANSCRICAO_MS), motivo: "aguardando_transcricao" };
  }

  const estado = montarEstadoDaEspera(await deps.mensagens.ultimasMensagens(org, conversationId, 40));
  if (!estado) return { status: "pulado", motivo: "sem_texto_para_ler" };

  const chave = await deps.chave(org);
  if (!chave) return { status: "pulado", motivo: "sem_chave" };

  const atribuicao = cabecalhosDeAtribuicaoOpenRouter();
  const r = await deps.consultar({
    apiKey: chave.apiKey,
    estado,
    perguntas: PERGUNTAS_DA_ESPERA,
    modelo: MODELO_DO_JEV,
    tempoLimiteMs: TEMPO_LIMITE_DA_ESPERA_MS,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(atribuicao ? { cabecalhosExtras: atribuicao } : {}),
  });
  const lida = r.ok ? lerRespostaDaEspera(r.corpo, MODELO_DO_JEV) : null;
  const falha: FalhaDoJev | null = !r.ok
    ? r.falha
    : lida && !lida.ok
      ? { tipo: "contrato", status: r.status, detalhe: lida.detalhe }
      : null;
  const leitura = lida?.ok ? lida.leitura : null;
  deps.registrarChamada({
    organizationId: org,
    contactId,
    modelo: leitura?.modelo ?? MODELO_DO_JEV,
    tokensDeEntrada: leitura?.tokensDeEntrada ?? null,
    custoEmCentavos: leitura?.custoEmCentavos ?? null,
    latenciaMs: r.latenciaMs,
    falha,
  });

  if (!leitura) {
    if (falha?.tipo === "temporaria" && idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
      return { status: "tentar_de_novo", em: new Date(agora + ESPERA_APOS_FALHA_TEMPORARIA_MS), motivo: `jev_${falha.status ?? "rede"}` };
    }
    logger.warn("espera-da-assistente: o Jev não decidiu — a espera conta", {
      organization_id: org,
      conversation_id: conversationId,
      tipo: falha?.tipo ?? "desconhecido",
    });
    return { status: "pulado", motivo: `jev_falhou:${falha?.tipo ?? "desconhecido"}` };
  }

  const probabilidade = Number(leitura.pedeResposta.toFixed(3));
  if (!decidirDispensa(leitura.pedeResposta)) return { status: "pede_resposta", probabilidade };

  const dispensou = await deps.espera.dispensar(org, conversationId, { espera_desde: c.espera_desde, last_inbound_at: c.last_inbound_at });
  if (!dispensou) return { status: "pulado", motivo: "conversa_mudou" };
  await deps.espera.registrarEvento(org, conversationId, { probabilidade, ate: c.last_inbound_at, modelo: leitura.modelo });
  return { status: "dispensada", probabilidade };
}
