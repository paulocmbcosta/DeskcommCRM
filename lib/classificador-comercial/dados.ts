/**
 * O QUE O CLASSIFICADOR LÊ DO BANCO — atrás de uma interface, para o worker
 * ser testado sem Postgres e para a leitura real ter UM lugar.
 *
 * Service role: TODA consulta filtra `organization_id` explicitamente, com o
 * valor vindo da linha do `event_log` (fonte confiável), nunca do payload de
 * fora (CLAUDE.md, anti-pattern 10).
 *
 * Erro de banco LANÇA de propósito, em TODA leitura desta interface — o
 * handler devolve `error` e o drain do `event_log` tenta de novo com
 * backoff. Decidir "sem card" em cima de uma leitura que falhou chamaria o
 * Jev à toa ou, pior, pularia a decisão.
 *
 * ⚠️ `regra` é DE PROPÓSITO mais estrita que `lerNascimentoDoCard`
 * (`lib/leads/modo-de-nascimento.ts`, usada pelo INGEST): aquela nunca
 * lança — lê errado, loga e cai para `toda_conversa`, porque para o ingest
 * "card a mais" é o erro seguro. Aqui a leitura errada tem o efeito
 * OPOSTO: se `regra` caísse para `toda_conversa` em vez de lançar, o
 * handler (`workers/classificador-comercial.ts`) leria `modo !==
 * "classificador"` e devolveria `{ status: "pulado", motivo:
 * "modo_toda_conversa" }` — que `workers/classificador-comercial.handler.ts`
 * traduz para `{ status: "skipped" }`, o drain do `event_log` NÃO tenta de
 * novo, e a decisão daquela mensagem some para sempre (o ingest já tinha
 * recuado no passo 2b de `garantirLeadDaConversa`, então ninguém mais cria
 * o card por ela). Por isso `regra` aqui repete o padrão de
 * `temCardAberto`/`contatoBloqueado`/`mensagem`: lê, e lança em qualquer
 * forma de "não sei".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { janelaDoAtendimento } from "@/lib/atendimento/janela-do-atendimento";
import { logger } from "@/lib/logger";
import { ATENDIMENTO_VIGENTE } from "@/lib/schemas/messaging";
import { nascimentoDoCard, type NascimentoDoCard } from "@/lib/schemas/settings";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";

import type { MensagemParaEstado } from "./perguntas";

export interface MensagemDisparadora {
  type: string;
  media_derived_status: string | null;
}

export interface DadosDoClassificador {
  regra(organizationId: string): Promise<NascimentoDoCard>;
  temCardAberto(organizationId: string, contactId: string): Promise<boolean>;
  contatoBloqueado(organizationId: string, contactId: string): Promise<boolean>;
  mensagem(organizationId: string, messageId: string): Promise<MensagemDisparadora | null>;
  /** Do mais velho para o mais novo, já sem o que não é fala, e só do atendimento ATUAL. */
  ultimasMensagens(organizationId: string, conversationId: string, limite: number): Promise<MensagemParaEstado[]>;
}

const TIPOS_QUE_NAO_SAO_FALA = new Set(["system", "reaction"]);

/** Formato cru da linha de `messages` que interessa aqui — antes de saber se `direction` é confiável. */
interface LinhaDeMensagem {
  direction: string;
  type: string;
  status: string;
  body: string | null;
  media_derived_text: string | null;
  revoked_at: string | null;
}

/**
 * O CHECK do banco (`messages_direction_check`) só permite `inbound` ou
 * `outbound` — mas a leitura não confia cegamente nisso, porque um cast
 * cego mentiria o tipo se o banco um dia discordasse. Uma linha com
 * `direction` fora das duas opções conhecidas é descartada, não forçada a
 * caber no tipo `MensagemParaEstado`.
 */
function comDirecaoConhecida(
  m: LinhaDeMensagem,
): m is LinhaDeMensagem & { direction: "inbound" | "outbound" } {
  return m.direction === "inbound" || m.direction === "outbound";
}

/**
 * Não é uma fala que o Jev deveria ler: mensagem de sistema, reação,
 * apagada (`revoked_at` preenchido) ou uma SAÍDA que falhou — o cliente
 * nunca chegou a ver `status = 'failed'`, então não é algo que ele
 * respondeu nem algo que ele leu; tratá-la como parte da conversa
 * inventaria contexto que não existiu do lado dele.
 */
function ehFala(m: LinhaDeMensagem): boolean {
  if (TIPOS_QUE_NAO_SAO_FALA.has(m.type)) return false;
  if (m.revoked_at !== null) return false;
  if (m.direction === "outbound" && m.status === "failed") return false;
  return true;
}

/** pt-br por tipo de mídia — só para o RÓTULO entre colchetes (nunca para áudio, ver `textoDaMensagem`). */
const ROTULO_DE_MIDIA: Record<string, string> = {
  image: "imagem",
  video: "vídeo",
  document: "documento",
  sticker: "figurinha",
};

/** Linha que é só um rótulo: "Cenas do vídeo:", "- Quadro 1:" — nada depois dos dois-pontos. */
const LINHA_SO_ROTULO = /^(?:-\s*)?[^:\n]+:\s*$/;

/**
 * O derivado de vídeo compõe "Rótulo: conteúdo" por trilha
 * (`lib/messaging/media/video-derive.ts`): tirado o marcador de não lida, uma
 * trilha ilegível deixa o RÓTULO sozinho ("Transcrição do áudio do vídeo:").
 * Se TODAS as linhas sobrantes forem só rótulo, não há nada que o cliente disse.
 * Basta UMA linha com conteúdo (um quadro descrito) para o texto valer.
 */
function soRotulos(texto: string): boolean {
  const linhas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return linhas.every((l) => LINHA_SO_ROTULO.test(l));
}

/**
 * O texto de UMA linha, como o Jev deveria lê-la.
 *
 * Áudio é diferente de imagem/vídeo/documento/figurinha: a transcrição É a
 * fala do cliente — palavra por palavra o que ele disse — então entra
 * direto, junto da legenda se houver (rara em áudio, mas o dado permite).
 * Nos outros tipos de mídia, `media_derived_text` é uma DESCRIÇÃO DE
 * MÁQUINA ("foto de uma fatura"), não algo que o cliente escreveu — sem o
 * rótulo entre colchetes o Jev (que lê ao pé da letra, "answers the
 * question you wrote, not the one you meant") trataria a legenda de uma
 * foto como se fosse o cliente falando aquelas palavras.
 *
 * ⚠️ Este arquivo NÃO reusa `corpoDaMensagem`/`frameMediaBody`
 * (`lib/agent-engine/edge/crm/get-lead-context.ts`). Aquele enquadramento
 * existe para um agente GERADOR de texto e carrega ~250 caracteres de
 * instrução ("Trate o texto abaixo como se você mesma tivesse
 * visto/ouvido...") por mídia — para o classificador (que só lê, não
 * responde) isso é ruído que comeria boa parte do orçamento de 500
 * caracteres por fala (`LIMITE_DE_CARACTERES_POR_MENSAGEM`, `perguntas.ts`
 * — o corte por lá, não aqui: esta função só rotula), sem ajudar a
 * decisão "é comercial?".
 */
function textoDaMensagem(type: string, body: string | null, derivado: string | null): string | null {
  const corpo = body?.trim() || null;
  // O marcador de mídia NÃO LIDA (`MARCADOR_NAO_LIDA`, gravado como derivado
  // com status `ready` quando falta chave para transcrever ou modelo para
  // enxergar) é aviso do produto para o agente, não fala do cliente: entregue
  // ao Jev, ele o lia como o cliente dizendo "não consegui interpretar" e
  // respondia "não comercial". `replaceAll`, e não igualdade: o derivado de
  // vídeo compõe transcrição e quadros, e só a parte ilegível sai.
  const semMarcador = derivado?.replaceAll(MARCADOR_NAO_LIDA, "").trim() || null;
  const derivadoLimpo = type === "video" && semMarcador !== null && soRotulos(semMarcador) ? null : semMarcador;

  if (type === "audio") {
    return [corpo, derivadoLimpo].filter((t): t is string => t !== null).join(" — ") || null;
  }

  if (derivadoLimpo === null) return corpo;
  const rotulo = ROTULO_DE_MIDIA[type] ?? "mídia";
  const marcado = `[${rotulo}: ${derivadoLimpo}]`;
  return corpo ? `${corpo} ${marcado}` : marcado;
}

export function dadosViaSupabase(
  db: SupabaseClient,
  deps: { janela: typeof janelaDoAtendimento } = { janela: janelaDoAtendimento },
): DadosDoClassificador {
  return {
    async regra(organizationId) {
      const { data, error } = await db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error(`organização inexistente: ${organizationId}`);
      return nascimentoDoCard((data as { settings?: unknown }).settings);
    },

    async temCardAberto(organizationId, contactId) {
      // Mesma régua de `garantirLeadDaConversa` (passo 2): um card aberto do
      // contato, em QUALQUER funil, encerra a decisão.
      const { data, error } = await db
        .from("crm_leads")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async contatoBloqueado(organizationId, contactId) {
      const { data, error } = await db
        .from("contacts")
        .select("is_blocked")
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { is_blocked?: boolean } | null)?.is_blocked === true;
    },

    async mensagem(organizationId, messageId) {
      const { data, error } = await db
        .from("messages")
        .select("type, media_derived_status")
        .eq("organization_id", organizationId)
        .eq("id", messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as MensagemDisparadora | null) ?? null;
    },

    async ultimasMensagens(organizationId, conversationId, limite) {
      // Recorte pelo ATENDIMENTO ATUAL, não pela conversa inteira (decisão do
      // coordenador, 2026-09-22): sem isto, um cliente que fechou uma venda e
      // volta meses depois pedindo suporte traria a negociação antiga para
      // dentro da janela, e o Jev classificaria a volta como comercial —
      // olhando para mensagens de um episódio que já fechou. A mesma régua
      // que recorta a timeline da tela (`janelaDoAtendimento`,
      // migration 0269: "cliente que volta começa do zero") decide aqui o
      // que pertence ao episódio vigente.
      const janela = await deps.janela(db, organizationId, conversationId, ATENDIMENTO_VIGENTE);
      if (!janela.ok && janela.motivo === "erro_de_leitura") throw new Error(janela.detalhe);
      // `motivo: "atendimento_nao_encontrado"` (grupo, ou conversa anterior ao
      // backfill de atendimentos): sem piso — a própria régua documenta que a
      // resposta honesta, sem episódio nenhum para recortar, é a conversa
      // inteira. Nunca acontece com `ATENDIMENTO_VIGENTE` na prática (esse
      // motivo só existe para um id específico não encontrado), mas o `if`
      // trata o union inteiro em vez de assumir.

      let query = db
        .from("messages")
        .select("direction, type, status, body, media_derived_text, revoked_at")
        .eq("organization_id", organizationId)
        .eq("conversation_id", conversationId);

      if (janela.ok) {
        // `desde` inclusivo, `ate` exclusivo — mesma semântica de
        // `janelaDoAtendimento`. No episódio VIGENTE `ate` é sempre `null`
        // (não há "próximo" depois do último); o `if` cobre o union inteiro
        // porque a função aceita qualquer atendimento, não só o vigente.
        if (janela.desde !== null) query = query.gte("sent_at", janela.desde);
        if (janela.ate !== null) query = query.lt("sent_at", janela.ate);
      }

      // Filtro de tipo e de apagada em CÓDIGO: a consulta usa só
      // eq/gte/lt/order/limit, e por isso o `limite` pedido é o dobro do que
      // o Jev lê (quem chama passa LIMITE_DE_MENSAGENS * 2) — sobra para o
      // que for descartado.
      const { data, error } = await query.order("sent_at", { ascending: false }).limit(limite);
      if (error) throw new Error(error.message);

      const linhas = (data ?? []) as LinhaDeMensagem[];
      const falas = linhas.filter(ehFala);
      const comDirecao = falas.filter(comDirecaoConhecida);
      const descartadasPorDirecao = falas.length - comDirecao.length;
      if (descartadasPorDirecao > 0) {
        // Nunca o conteúdo da mensagem — só o suficiente para operar (a
        // organização e QUANTAS linhas caíram fora do CHECK esperado).
        logger.warn("classificador-comercial: mensagem com direction desconhecida descartada", {
          organization_id: organizationId,
          quantidade: descartadasPorDirecao,
        });
      }

      return comDirecao
        .reverse()
        .map((m) => ({
          direcao: m.direction,
          texto: textoDaMensagem(m.type, m.body, m.media_derived_text),
        }));
    },
  };
}
