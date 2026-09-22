/**
 * O CARD NASCE QUANDO A CONVERSA É COMERCIAL — o classificador (Jev).
 *
 * Consome `message.received` (emitido pelo gatilho `trg_messages_emit_event`
 * em TODO canal). Dentro de uma requisição (o dreno que corre no POST do
 * webhook) ele é ADIADO para o worker — o handler declara `foraDaRequisicao` —,
 * e o canal não espera o Jev. No worker, o dispatcher roda os consumidores de
 * um evento em série, e este é registrado depois dos outros
 * (lib/event-log/register-handlers.ts), para não atrasar push e automações.
 * Só age quando a
 * organização ligou `settings.crm.nascimento_do_card.modo = 'classificador'`;
 * no modo de sempre quem abre o card é o ingest, e aqui é um `skipped` barato.
 *
 * A ORDEM é o pedido do dono, e é o que economiza o Jev:
 *   1. o contato JÁ TEM card aberto? → para. Nenhuma chamada.
 *   2. não tem → o Jev lê as últimas falas e responde "é comercial?".
 *   3. passou do limiar → o card nasce por `garantirLeadDaConversa` (a mesma
 *      função do ingest: funil de entrada, primeira etapa, trava por contato) e
 *      a linha do tempo diz por quê. Dali em diante o passo 1 encerra tudo.
 *
 * Quando o classificador NÃO consegue decidir, o card nasce assim mesmo, com a
 * causa na linha do tempo (decisão A do plano 2026-09-22). Card a mais se
 * arquiva; card a menos é venda que some sem ninguém ver. O TEXTO da causa mora
 * em `lib/leads/nascimento-do-lead.ts`; daqui sai só o CÓDIGO
 * (`CausaSemClassificacao`), para a frase da linha do tempo não divergir dele.
 *
 * Quando o Jev diz "comercial" e o card NÃO nasce, o motivo não some: falha de
 * escrita LANÇA (o drain aplica backoff e, esgotadas as tentativas, avisa do
 * evento morto); falta de funil ou de etapa vira aviso no log, porque é
 * configuração que alguém precisa ver; corrida legítima (`ja_existe`,
 * `contato_bloqueado`) segue, com o motivo no log.
 *
 * Toda chamada, com sucesso ou falha, vira uma linha em `llm_calls`
 * (`purpose = commercial_classify`): é o que aparece em IA › Execuções.
 *
 * O TETO DE ORÇAMENTO da organização NÃO é consultado antes de chamar o Jev, de
 * propósito: a chamada custa ≈0,003 centavo, e barrar no teto derrubaria cards
 * ou os jogaria todos em "sem classificar". O gasto aparece assim mesmo — o
 * gatilho `trg_llm_calls_budget` soma cada linha. E a chave da INSTALAÇÃO
 * (`OPENROUTER_API_KEY`) paga pelas organizações que não cadastraram a sua
 * (`lib/classificador-comercial/chave.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { dadosViaSupabase, type DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import { perguntarAoJev, type FalhaDoJev } from "@/lib/classificador-comercial/jev";
import {
  decidir,
  LIMITE_DE_MENSAGENS,
  MODELO_DO_JEV,
  montarEstado,
  ROTULO_DO_ASSUNTO,
} from "@/lib/classificador-comercial/perguntas";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  garantirLeadDaConversa,
  type CausaSemClassificacao,
  type DadosDoNascimento,
  type MotivoSemLead,
  type NascimentoDoLead,
  type OrigemDoNascimento,
} from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { createAdminClient } from "@/lib/supabase/admin";

export const ESPERA_POR_TRANSCRICAO_MS = 15_000;
/** O mesmo teto que o drain do agente usa para esperar a mídia virar texto. */
export const TETO_ESPERA_TRANSCRICAO_MS = 120_000;
export const ESPERA_APOS_FALHA_TEMPORARIA_MS = 60_000;
/** O `retry` do dispatcher não conta tentativa: o teto é pela IDADE do evento. */
export const TETO_DE_FALHA_TEMPORARIA_MS = 10 * 60_000;

/** Por que o card de uma conversa comercial não nasceu — `erro` nunca chega aqui: ele LANÇA. */
export type MotivoDoCardQueNaoNasceu = Exclude<MotivoSemLead, "erro">;

export type ResultadoDaClassificacao =
  | { status: "pulado"; motivo: string }
  | { status: "tentar_de_novo"; em: Date; motivo: string }
  /** `criouCard: false` aqui é SÓ "não comercial"; comercial sem card é o status abaixo. */
  | { status: "classificado"; criouCard: boolean; assunto: string; probabilidade: number }
  | { status: "comercial_sem_card"; motivo: MotivoDoCardQueNaoNasceu; assunto: string; probabilidade: number }
  | {
      status: "card_sem_classificar";
      causa: CausaSemClassificacao;
      criouCard: boolean;
      /** Só quando `criouCard` é false. */
      motivo?: MotivoDoCardQueNaoNasceu;
    };

export interface LinhaDeChamada {
  organizationId: string;
  contactId: string;
  modelo: string;
  /** `null` = o provedor não disse (e aí o custo também é desconhecido). */
  tokensDeEntrada: number | null;
  /** O custo que a própria resposta traz (`RespostaDoJev.custoEmCentavos`); `null` = desconhecido. */
  custoEmCentavos: number | null;
  latenciaMs: number;
  falha: FalhaDoJev | null;
}

export interface DependenciasDoClassificador {
  admin: SupabaseClient;
  dados: DadosDoClassificador;
  chave: typeof chaveDaOpenRouter;
  perguntar: typeof perguntarAoJev;
  garantir: typeof garantirLeadDaConversa;
  registrarChamada: (linha: LinhaDeChamada) => void;
  agora: () => Date;
  baseUrl?: string;
}

/**
 * A falha do Jev no vocabulário de `llm_calls.error_code` — o MESMO de
 * `normalizarErro` (lib/agent-engine/edge/llm/run-model-call.ts), porque é por
 * ele que IA › Execuções diz "o que fazer" (`O_QUE_FAZER`,
 * app/api/v1/ai/runs/route.ts). Gravar o `tipo` cru (`conta`, `temporaria`)
 * repetiria o defeito do `erro_legado`: a tela mostrava o erro e nenhuma linha
 * de conserto (tests/unit/log-invocation-classifica-erro.test.ts).
 *
 * A classificação já vem pronta de `perguntarAoJev` — aqui só se traduz, sem
 * regex sobre o texto do provedor.
 */
export function codigoDeErroDaFalha(falha: FalhaDoJev): string {
  if (falha.tipo === "conta") return falha.status === 402 ? "limite_ou_saldo" : "credencial_recusada";
  if (falha.tipo === "temporaria") return falha.status === 429 ? "limite_ou_saldo" : "provedor_indisponivel";
  return falha.status === 404 ? "modelo_inexistente" : "erro_desconhecido";
}

/** Fire-and-forget: a telemetria não derruba a decisão que ela descreve. */
export function registrarNoLlmCalls(admin: SupabaseClient) {
  return (l: LinhaDeChamada): void => {
    void (async () => {
      try {
        const { error } = await admin.from("llm_calls").insert({
          organization_id: l.organizationId,
          contact_id: l.contactId,
          purpose: "commercial_classify",
          provider: "openrouter",
          model: l.modelo,
          // `input_tokens` é NOT NULL (default 0); quem diz "não sei" é `cost_cents`,
          // que fica `null` quando o custo é desconhecido ou a chamada falhou —
          // a coluna manda: "null = preço desconhecido — nunca inventar 0".
          input_tokens: l.tokensDeEntrada ?? 0,
          output_tokens: 0,
          cost_cents: l.falha ? null : l.custoEmCentavos,
          latency_ms: l.latenciaMs,
          status: l.falha ? "erro" : "ok",
          error_code: l.falha ? codigoDeErroDaFalha(l.falha) : null,
          // Já redigido e cortado em `perguntarAoJev` (sem chave, sem trecho da
          // conversa): é o texto que a coluna aceita — "NUNCA prompt, resposta ou chave".
          error_message: l.falha?.detalhe ?? null,
          http_status: l.falha?.status ?? null,
        });
        if (error) {
          logger.warn("classificador-comercial: llm_calls não gravou", {
            organization_id: l.organizationId,
            codigo: error.code || "rede",
            error: error.message.slice(0, 120),
          });
        }
      } catch (erro) {
        logger.warn("classificador-comercial: llm_calls não gravou", {
          organization_id: l.organizationId,
          erro: erro instanceof Error ? erro.name : typeof erro,
        });
      }
    })();
  };
}

/**
 * ESTE evento vai pagar a espera do Jev? — o predicado `foraDaRequisicao` do
 * handler (lib/event-log/dispatcher.ts).
 *
 * Só a organização que LIGOU a regra tem evento adiado para o worker. Para
 * todas as outras — a base instalada inteira, enquanto ninguém liga a regra —
 * o handler devolve `skipped` em uma leitura, e adiar seria devolver à fila,
 * a cada webhook, um evento que terminaria ali mesmo.
 *
 * ⚠️ FALHA LÊ COMO `false`, ao contrário do worker, onde a mesma leitura LANÇA
 * para o drain tentar de novo: aqui não há decisão de card em jogo — só "adia
 * ou não". Na dúvida, roda na requisição, que é o caminho de antes do
 * adiamento existir; a decisão sobre o card continua inteira lá dentro.
 */
export async function ehOrganizacaoComClassificador(
  event: EventRow,
  dados: Pick<DadosDoClassificador, "regra"> = dadosViaSupabase(createAdminClient()),
): Promise<boolean> {
  try {
    const regra = await dados.regra(event.organization_id);
    return regra.modo === "classificador";
  } catch (err) {
    logger.warn("classificador-comercial: regra ilegível ao decidir o adiamento — roda na requisição", {
      organization_id: event.organization_id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
  }
}

function dependenciasReais(): DependenciasDoClassificador {
  const admin = createAdminClient();
  return {
    admin,
    dados: dadosViaSupabase(admin),
    chave: chaveDaOpenRouter,
    perguntar: perguntarAoJev,
    garantir: garantirLeadDaConversa,
    registrarChamada: registrarNoLlmCalls(admin),
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Só é chamada quando não há mais o que esperar: a `temporaria` aqui já passou do teto de 10 min. */
function causaDaFalha(falha: FalhaDoJev): CausaSemClassificacao {
  if (falha.tipo === "conta") return "conta";
  if (falha.tipo === "temporaria") return "temporaria";
  return "formato";
}

/** Falta de configuração: a conversa merecia card e a organização não tem onde pô-lo. */
const MOTIVOS_DE_CONFIGURACAO: ReadonlySet<MotivoSemLead> = new Set(["sem_funil_de_entrada", "sem_etapa"]);

/**
 * O desfecho depois de `erro` ter lançado. Escrito por extenso: `Exclude<…,
 * { motivo: "erro" }>` não remove nada, porque o membro da união tem
 * `motivo: MotivoSemLead`, e não só `"erro"`.
 */
type NascimentoSemErro =
  | Extract<NascimentoDoLead, { criado: true }>
  | { criado: false; motivo: MotivoDoCardQueNaoNasceu };

/**
 * `garantirLeadDaConversa` e o desfecho dele no log — os DOIS lados, como o
 * ingest (lib/channels/pos-entrada.ts): sem a linha do "não criou", "já
 * existia" e "a organização não tem funil" têm a mesma cara.
 *
 * `erro` LANÇA: devolver "ok" deixaria o drain descartar a única pista de que
 * uma conversa comercial ficou sem card. Lançando, o handler devolve `error`, o
 * drain aplica backoff e, esgotadas as tentativas, avisa do evento morto.
 */
async function nascerCard(
  deps: DependenciasDoClassificador,
  dados: DadosDoNascimento,
  origem: Exclude<OrigemDoNascimento, { tipo: "ingest" }>,
  contexto: Record<string, unknown>,
): Promise<NascimentoSemErro> {
  const nascimento = await deps.garantir(deps.admin, dados, origem);
  const base = {
    organization_id: dados.organizationId,
    conversation_id: dados.conversationId,
    origem: origem.tipo,
    ...contexto,
  };
  if (nascimento.criado) {
    // Card sem classificar é aviso mesmo quando nasce: o classificador falhou.
    const nivel = origem.tipo === "sem_classificacao" ? "warn" : "info";
    logger[nivel]("classificador-comercial: card criado", { ...base, lead_id: nascimento.leadId });
    return nascimento;
  }
  if (nascimento.motivo === "erro") {
    throw new Error(`nascimento do card falhou: ${nascimento.detalhe ?? "erro"}`);
  }
  const motivo = nascimento.motivo;
  if (MOTIVOS_DE_CONFIGURACAO.has(motivo)) {
    logger.warn("classificador-comercial: card não nasceu — falta configurar o funil de entrada", { ...base, motivo });
  } else {
    logger.info("classificador-comercial: card não nasceu", { ...base, motivo });
  }
  return { criado: false, motivo };
}

async function criarSemClassificar(
  deps: DependenciasDoClassificador,
  dados: DadosDoNascimento,
  causa: CausaSemClassificacao,
): Promise<ResultadoDaClassificacao> {
  const nascimento = await nascerCard(deps, dados, { tipo: "sem_classificacao", causa }, { causa });
  return nascimento.criado
    ? { status: "card_sem_classificar", causa, criouCard: true }
    : { status: "card_sem_classificar", causa, criouCard: false, motivo: nascimento.motivo };
}

export async function processarClassificacao(
  event: EventRow,
  deps: DependenciasDoClassificador = dependenciasReais(),
): Promise<ResultadoDaClassificacao> {
  const p = event.payload ?? {};
  if (p.direction !== "inbound") return { status: "pulado", motivo: "nao_e_entrada" };
  const messageId = texto(p.message_id) ?? event.entity_id;
  const conversationId = texto(p.conversation_id);
  const contactId = texto(p.contact_id);
  if (!messageId || !conversationId || !contactId) return { status: "pulado", motivo: "payload_incompleto" };
  const org = event.organization_id;

  // 1 · a regra. No modo de sempre, o ingest já cuidou do card.
  const regra = await deps.dados.regra(org);
  if (regra.modo !== "classificador") return { status: "pulado", motivo: "modo_toda_conversa" };

  // 2 · JÁ TEM CARD? Então não há o que decidir — e o Jev não é chamado.
  if (await deps.dados.temCardAberto(org, contactId)) return { status: "pulado", motivo: "ja_tem_card" };
  if (await deps.dados.contatoBloqueado(org, contactId)) return { status: "pulado", motivo: "contato_bloqueado" };

  const agora = deps.agora().getTime();
  // Idade DESCONHECIDA conta como VENCIDA: com 0, um evento sem `created_at`
  // repetiria o `retry` para sempre — o drain não conta tentativa de `retry` —
  // e chamaria o Jev a cada 60 s. Vencido, a transcrição não é esperada e a
  // falha temporária cai na decisão A na hora. (`created_at` inválido dá NaN,
  // que também reprova os dois `<` abaixo: vencido do mesmo jeito.)
  const idadeMs = event.created_at ? agora - new Date(event.created_at).getTime() : Number.POSITIVE_INFINITY;

  // 3 · áudio ainda virando texto: esperar, senão o Jev lê uma conversa vazia.
  const disparadora = await deps.dados.mensagem(org, messageId);
  if (
    disparadora &&
    TIPOS_DERIVAVEIS.has(disparadora.type) &&
    !DERIVACAO_TERMINADA.has(disparadora.media_derived_status ?? "") &&
    idadeMs < TETO_ESPERA_TRANSCRICAO_MS
  ) {
    return { status: "tentar_de_novo", em: new Date(agora + ESPERA_POR_TRANSCRICAO_MS), motivo: "aguardando_transcricao" };
  }

  // 4 · o que o Jev lê.
  const estado = montarEstado(await deps.dados.ultimasMensagens(org, conversationId, LIMITE_DE_MENSAGENS * 2));
  const dadosDoCard: DadosDoNascimento = { organizationId: org, contactId, conversationId, nomeDoContato: null };
  if (!estado) {
    // Nenhuma fala do cliente com texto. Se quem disparou foi MÍDIA do cliente,
    // ele falou e não há o que ler — áudio sem transcrição, imagem que ninguém
    // descreveu. Pular aqui era a conversa nunca virar card, em silêncio, a
    // cada mensagem: decisão A, o card nasce e diz por quê.
    if (disparadora && TIPOS_DERIVAVEIS.has(disparadora.type)) {
      // ⚠️ MAS SÓ QUANDO NÃO HÁ MAIS O QUE ESPERAR. Passar dos 2 min do passo 3
      // não significa que a derivação morreu: Whisper com 5xx, ou a fila de
      // mídia atrasada depois de uma queda, entregam a transcrição minutos
      // depois — e o card teria nascido "sem classificar" por pressa nossa.
      // Enquanto a derivação está PEDIDA e não terminou, espera-se, com o teto
      // de falha temporária (10 min) como limite final; aí vale a decisão A.
      //
      // Status NULO é outro caso: a derivação nunca foi pedida (vídeo com a
      // descrição desligada, mídia sem storage) e não vai chegar nunca — esse
      // segue pelo teto de idade do passo 3, sem esperar os 10 minutos.
      const derivacaoPedida = disparadora.media_derived_status !== null;
      const terminou = DERIVACAO_TERMINADA.has(disparadora.media_derived_status ?? "");
      if (derivacaoPedida && !terminou && idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
        return {
          status: "tentar_de_novo",
          em: new Date(agora + ESPERA_POR_TRANSCRICAO_MS),
          motivo: "aguardando_transcricao",
        };
      }
      return criarSemClassificar(deps, dadosDoCard, "midia_sem_texto");
    }
    // Sem mídia do cliente (ex.: só o atendente falou — campanha, aviso): não
    // há conversa a classificar.
    return { status: "pulado", motivo: "sem_texto_do_cliente" };
  }

  const chave = await deps.chave(deps.admin, org);
  if (!chave) return criarSemClassificar(deps, dadosDoCard, "sem_chave");

  // 5 · a pergunta.
  const atribuicao = cabecalhosDeAtribuicaoOpenRouter();
  const r = await deps.perguntar({
    apiKey: chave.apiKey,
    estado,
    modelo: MODELO_DO_JEV,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(atribuicao ? { cabecalhosExtras: atribuicao } : {}),
  });
  deps.registrarChamada({
    organizationId: org,
    contactId,
    modelo: r.ok ? r.resposta.modelo : MODELO_DO_JEV,
    tokensDeEntrada: r.ok ? r.resposta.tokensDeEntrada : null,
    custoEmCentavos: r.ok ? r.resposta.custoEmCentavos : null,
    latenciaMs: r.latenciaMs,
    falha: r.ok ? null : r.falha,
  });

  if (!r.ok) {
    if (r.falha.tipo === "temporaria" && idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
      return {
        status: "tentar_de_novo",
        em: new Date(agora + ESPERA_APOS_FALHA_TEMPORARIA_MS),
        motivo: `jev_${r.falha.status ?? "rede"}`,
      };
    }
    logger.error("classificador-comercial: o Jev não decidiu", {
      organization_id: org,
      conversation_id: conversationId,
      tipo: r.falha.tipo,
      status: r.falha.status,
    });
    return criarSemClassificar(deps, dadosDoCard, causaDaFalha(r.falha));
  }

  // 6 · a decisão.
  const decisao = decidir(r.resposta, regra.limiar);
  logger.info("classificador-comercial: conversa classificada", {
    organization_id: org,
    conversation_id: conversationId,
    assunto: decisao.assunto,
    // O que o Jev devolveu de fato. Se ele passar a responder fora da lista, todo
    // card sai "sem assunto definido" — e é aqui que isso aparece. Cortado: é
    // texto do provedor, e o log não é lugar para o que ele resolver mandar.
    assunto_recebido: r.resposta.assunto?.slice(0, 40) ?? null,
    probabilidade: Number(decisao.probabilidade.toFixed(3)),
    limiar: regra.limiar,
    criar: decisao.criar,
  });
  if (!decisao.criar) {
    return { status: "classificado", criouCard: false, assunto: decisao.assunto, probabilidade: decisao.probabilidade };
  }

  const nascimento = await nascerCard(
    deps,
    dadosDoCard,
    {
      tipo: "classificador",
      assunto: decisao.assunto,
      rotuloDoAssunto: ROTULO_DO_ASSUNTO[decisao.assunto],
      probabilidade: decisao.probabilidade,
      modelo: r.resposta.modelo,
    },
    { assunto: decisao.assunto },
  );
  if (!nascimento.criado) {
    return {
      status: "comercial_sem_card",
      motivo: nascimento.motivo,
      assunto: decisao.assunto,
      probabilidade: decisao.probabilidade,
    };
  }
  return { status: "classificado", criouCard: true, assunto: decisao.assunto, probabilidade: decisao.probabilidade };
}
