/**
 * A ASSISTENTE DECIDE SE A ESPERA CONTA — consumidor de `message.received`.
 *
 * O trigger (0279/0285) liga a espera na hora; aqui a Assistente (o Jev por
 * baixo) só pode DISPENSAR (decisão A do plano 2026-09-26). Toda saída que
 * não seja "dispensada" deixa a espera contando, como antes da feature.
 *
 * Ordem, do mais barato ao mais caro: é entrada? a conversa espera gente
 * (humano/aguardando) e ainda espera? um humano já mandou contar? há chave?
 * → só então transcrição e Jev. A dispensa é a RPC `fn_dispensar_espera`
 * (`lib/espera/dados.ts`, migration 0285): se o cliente escreveu — mesmo no
 * mesmo segundo — ou alguém respondeu enquanto o Jev pensava, não grava nada;
 * o evento da mensagem nova decide de novo.
 *
 * Custo: toda chamada vira linha em `llm_calls` com `purpose = wait_classify`
 * (IA › Execuções). Sem chave da OpenRouter a feature não roda (decisão G).
 *
 * LAÇO DE RETORNO (invariante 7 do Sistema Vivo) — o erro da Assistente é
 * medido, não suposto. Toda dispensa grava `espera_dispensada` e toda religada
 * humana (`app/api/v1/conversations/[id]/manter-espera/route.ts`) grava
 * `espera_mantida`, os dois em `conversation_events`. A proporção entre os dois
 * é a taxa de erro observável:
 *
 *   select date_trunc('day', created_at) dia,
 *          count(*) filter (where type = 'espera_dispensada') dispensadas,
 *          count(*) filter (where type = 'espera_mantida')    religadas
 *     from conversation_events
 *    where organization_id = :org and type in ('espera_dispensada', 'espera_mantida')
 *    group by 1 order by 1 desc;
 *
 * Religadas/dispensadas alto (a Assistente erra para o lado de dispensar quem
 * ainda esperava resposta) ⇒ baixe `LIMIAR_PARA_DISPENSAR` em
 * `lib/espera/pede-resposta.ts` (hoje ≤ 0,15) ou reescreva
 * `PERGUNTAS_DA_ESPERA` — o prompt que decide. Zero religada por muito tempo
 * não é sinal de acerto: pode ser ninguém percebendo a dispensa errada; olhe
 * também os dias sem nenhuma linha de nenhum dos dois tipos.
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
    registrarChamada: registrarNoLlmCalls(admin, { purpose: "wait_classify" }),
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

type ChaveDoJev = Awaited<ReturnType<typeof chaveDaOpenRouter>>;

/**
 * A chave da OpenRouter deste EVENTO, resolvida uma vez só.
 *
 * O dispatcher chama `foraDaRequisicao` e `handle` com o MESMO objeto `row`
 * (lib/event-log/dispatcher.ts) — a mesma convenção de `REGRA_DO_EVENTO` em
 * workers/classificador-comercial.ts. Sem isto, todo evento adiado decifrava
 * a credencial duas vezes. `null` (sem chave) também fica guardado.
 */
const CHAVE_DO_EVENTO = new WeakMap<EventRow, ChaveDoJev>();

async function chaveDoEvento(event: EventRow, chave: DependenciasDaEspera["chave"]): Promise<ChaveDoJev> {
  if (CHAVE_DO_EVENTO.has(event)) return CHAVE_DO_EVENTO.get(event) ?? null;
  const resolvida = await chave(event.organization_id);
  CHAVE_DO_EVENTO.set(event, resolvida);
  return resolvida;
}

function dependenciasDoPredicado(): Pick<DependenciasDaEspera, "espera" | "chave"> {
  const admin = createAdminClient();
  return { espera: dadosDaEsperaViaSupabase(admin), chave: (org) => chaveDaOpenRouter(admin, org) };
}

/**
 * Predicado `foraDaRequisicao`: só adia (paga o Jev fora do webhook) a conversa
 * que o worker PODE dispensar — espera gente, ainda espera, sem trava humana e
 * com chave da OpenRouter (sem chave a feature não roda, decisão G). Adiar as
 * outras só devolveria à fila um evento que termina em `skipped`.
 *
 * ⚠️ FALHA LÊ COMO `false`, a convenção do classificador
 * (`ehOrganizacaoComClassificador`) e o contrato do dispatcher: na dúvida,
 * roda na requisição, onde o handler lê de novo e, se o banco seguir fora,
 * LANÇA para o drain tentar com backoff.
 */
export async function esperaPodeSerDispensada(
  event: EventRow,
  deps: Pick<DependenciasDaEspera, "espera" | "chave"> = dependenciasDoPredicado(),
): Promise<boolean> {
  const conversationId = texto(event.payload?.conversation_id);
  if (event.payload?.direction !== "inbound" || !conversationId) return false;
  try {
    const c = await deps.espera.conversa(event.organization_id, conversationId);
    if (!c?.espera_desde || c.espera_mantida_em || !COMANDOS_QUE_ESPERAM_GENTE.has(c.comando_da_conversa ?? "")) return false;
    return (await chaveDoEvento(event, deps.chave)) !== null;
  } catch (err) {
    logger.warn("espera-da-assistente: conversa ilegível ao decidir o adiamento — roda na requisição", {
      organization_id: event.organization_id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
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

  const chave = await chaveDoEvento(event, deps.chave);
  if (!chave) return { status: "pulado", motivo: "sem_chave" };

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

  const dispensou = await deps.espera.dispensar(
    org,
    conversationId,
    { espera_desde: c.espera_desde, last_inbound_at: c.last_inbound_at, mensagem_id: messageId },
    { probabilidade, ate: c.last_inbound_at, modelo: leitura.modelo },
  );
  if (!dispensou) return { status: "pulado", motivo: "conversa_mudou" };
  return { status: "dispensada", probabilidade };
}
