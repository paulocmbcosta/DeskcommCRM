/**
 * Adapter do chat do site — o único cujo transporte somos NÓS.
 *
 * Os três irmãos traduzem um envelope para a API de alguém (um servidor de
 * sessão, a Graph API, um BSP). Aqui não há alguém: a mensagem do atendente é a
 * própria linha de `messages` que o handler acabou de gravar, e o navegador do
 * visitante a busca na rota pública (`lib/channels/chat-do-site/leitura.ts`).
 * "Enviar" é, portanto, não fazer nada — e é exatamente por isso que o adapter
 * precisa existir em vez de um `if` no handler: o handler continua sem saber
 * com quem fala (invariante 1 de `docs/doctrine/restricao-de-canal.md`).
 *
 * Burro como os irmãos: nenhuma regra de negócio mora aqui. Se o visitante está
 * bloqueado, se o horário permite, se a IA pode responder — tudo isso é da
 * cadeia `before_send` e do handler.
 *
 * ─── O que `sent` significa neste canal ─────────────────────────────────────
 *
 * Nos outros canais, `sent` = "a plataforma aceitou". Aqui, `sent` = "está na
 * caixa de saída que o navegador consulta". Quem fecha o laço é a LEITURA: ao
 * entregar a mensagem ao widget, a rota pública a promove a `delivered`. Um
 * tique só, parado, é a informação honesta de que o visitante fechou a aba —
 * e é o sinal que o atendente precisa para saber que ninguém leu.
 */
import { randomUUID } from "node:crypto";

import type { ChannelAdapter, ChannelHealth, OutboundEnvelope, RecipientInput } from "../types";

/**
 * O "destinatário" de uma conversa do site.
 *
 * Constante, e não derivada do contato, porque o contato do site não tem
 * endereço: não há telefone, e o token do visitante nem chega aqui
 * (`RecipientInput` só conhece identidade de WhatsApp). Quem endereça é a
 * CONVERSA — a mensagem é lida pela thread, em `provider_conversation_id`.
 *
 * Devolver `null` diria ao handler "não há como falar com esta pessoa", e ele
 * gravaria `failed / missing_phone_number` numa conversa em que a pessoa acabou
 * de escrever — o mesmo defeito medido no canal intermediado, na outra ponta.
 */
const DESTINATARIO_DO_SITE = "visitante-do-site";

export const siteWidgetAdapter: ChannelAdapter = {
  provider: "site_widget",

  resolveRecipient(input: RecipientInput): string | null {
    // Conversa do site é sempre uma pessoa; grupo aqui é dado inconsistente, e
    // fingir um destinatário esconderia a inconsistência.
    if (input.isGroup) return null;
    return DESTINATARIO_DO_SITE;
  },

  /** Não há credencial: o transporte é o banco que já está respondendo. */
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    // Cartão de contato é vCard — formato de agenda de telefone. O widget não
    // tem o que fazer com ele, e aceitar gravaria "enviado" para algo que o
    // visitante veria como bolha vazia.
    if (envelope.kind === "contact") {
      throw new Error("site_widget_contact_not_supported: o chat do site não envia cartão de contato.");
    }

    // A revalidação de fronteira (atendimento encerrado, aprovação revogada)
    // vale aqui como em qualquer canal: é a última chance de NÃO entregar.
    await envelope.beforeSend?.();

    // Id próprio, no mesmo espaço dos ids da entrada (`site:<uuid>`). Não há eco
    // para casar — nenhum webhook devolve esta mensagem —, mas `external_id`
    // nulo numa linha `sent` é o estado que os painéis leem como "saiu sem
    // confirmação", e esta saiu com.
    return { externalId: `site:${randomUUID()}` };
  },

  /**
   * Sempre de pé — e a resposta não é preguiça, é o que há para dizer.
   *
   * "Saúde", para o cron, é "dá para enviar por este canal AGORA?". Nos outros
   * canais isso depende de alguém de fora (uma sessão pareada, um token válido,
   * o elo com a plataforma). Aqui o transporte é o banco que o próprio cron
   * acabou de consultar para chegar até esta linha: se ele está perguntando, a
   * resposta é sim.
   *
   * Implementado, e não omitido, porque o cron PULA quem não tem o método — sem
   * log e sem contador —, e canal pulado é canal que a Central nunca enxerga. O
   * que este canal tem de realmente frágil não é conexão, é INSTALAÇÃO (o
   * snippet saiu do site?), e isso tem superfície própria: o sinal "Instalado ·
   * exemplo.com" da tela de Conexões, alimentado por `site_widget_seen_at`.
   */
  async checkHealth(): Promise<ChannelHealth> {
    return { reachable: true, status: "WORKING", detail: null };
  },

  codes: {
    notConfigured: "site_widget_not_configured",
    sendFailed: "site_widget_error",
    unknownError: "site_widget_unknown",
  },
};
