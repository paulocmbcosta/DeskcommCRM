/**
 * MCP write tool — crm_start_conversation_and_send (Spec 11 §3.2, lacuna do
 * cold-start externo).
 *
 * A LACUNA QUE ISTO FECHA. `crm_send_whatsapp_message` só manda mensagem para
 * um `conversation_id` que JÁ EXISTE — não abre conversa nova. O único
 * caminho que abria conversa com um contato NOVO era `POST /api/v1/contacts`
 * (`createContactHandler`), que (a) é cookie-session-only — uma automação
 * externa com chave `dsk_...` não passa por ali — e (b) escolhe a sessão do
 * canal sozinha (`sessaoProntaParaEnvio`, "WORKING primeiro; senão qualquer
 * uma"): o chamador não tinha como dizer POR QUAL número sair. Uma automação
 * de prospecção fria (ex.: n8n captando lead novo) que precise abrir a
 * conversa NUM canal específico não tinha ferramenta MCP para isso.
 *
 * DOUTRINA DIRC (Referenciar, não duplicar) — esta tool não reimplementa nada.
 * A composição "abrir a conversa + enviar" que morava aqui hoje vive em
 * `lib/messaging/iniciar-conversa.ts`, extraída quando a TELA passou a precisar
 * do mesmo ato (o diálogo "Chamar no WhatsApp"). Continua sendo, por baixo:
 *   - `openSharedContactConversation`, o MESMO helper que
 *     `POST /api/v1/conversations/open-with-contact` usa: acha o contato pelas
 *     grafias do telefone (`encontrarContatoPorTelefone`) ou cria um novo
 *     (`fn_upsert_wa_contact`), e abre/reabre a conversa 1:1 na sessão indicada
 *     via `ensureConversation` → `beginServiceAtOrigin` → `fn_service_begin` —
 *     a RPC cujo comentário de migration diz "nova iniciativa autorizada
 *     (humano/MCP/regra), chamada NA ORIGEM".
 *   - `sendMessageHandler` (app/api/v1/messages/_handler.ts), o MESMO handler
 *     que `crm_send_whatsapp_message` chama — nenhum código de envio novo,
 *     mesmas guardas (bloqueio, mídia, template, boundary de atendimento).
 *
 * O helper devolve o desfecho do envio em vez de lançar, porque a tela precisa
 * das duas notícias (a conversa existe; a mensagem não saiu). Aqui o contrato é
 * outro e continua o de sempre: conversa aberta sem mensagem é FALHA, e o
 * handler relança — a automação que chama precisa distinguir para decidir o
 * retry.
 *
 * Idempotência: mesmo padrão de `crm_send_whatsapp_message` (tabela
 * `idempotency_keys`, TTL 24h) — a chave cobre o PAR abrir-conversa+enviar,
 * não só o envio, porque um retry não pode abrir uma segunda conversa.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { iniciarConversaEEnviar } from "@/lib/messaging/iniciar-conversa";

import type { McpToolDefinition } from "../types";

const ENDPOINT_TAG = "mcp:crm_start_conversation_and_send";

const inputShape = {
  /** O ganho central desta tool: quem chama ESCOLHE o canal, sem auto-seleção. */
  channel_session_id: z
    .string()
    .uuid()
    .describe("Sessão de canal de onde a mensagem sai. Obrigatório — esta tool existe para deixar o chamador escolher, ao contrário da criação de contato pela tela, que pega qualquer canal WORKING."),
  contact_id: z.string().uuid().optional(),
  phone_number: z
    .string()
    .min(8)
    .max(32)
    .optional()
    .describe("Usado para achar um contato existente pelas grafias do número, ou criar um novo se nenhum bater."),
  name: z.string().trim().min(1).max(200).optional().describe("Nome do contato, usado só se um novo cadastro for criado."),
  body: z.string().min(1).max(4096).optional(),
  media_url: z.string().url().optional(),
  media_mime: z.string().optional(),
  type: z
    .enum([
      "text",
      "image",
      "audio",
      "document",
      "sticker",
      "video",
      "location",
      "contact",
      // `template` faltava, e a ausência anulava o caso de uso que o cabeçalho
      // desta tool declara servir. Prospecção fria é falar com quem NUNCA
      // escreveu — e num canal com hetero-restrição essa é exatamente a
      // situação em que só modelo aprovado sai (131047). Sem este valor, a
      // automação de prospecção funcionava só no canal que não precisa dela.
      "template",
    ])
    .optional()
    .default("text"),
  template_name: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Só em type=template. Nome exato aprovado na plataforma."),
  template_language: z
    .string()
    .min(2)
    .max(16)
    .optional()
    .describe("Só em type=template. `pt_BR` e `pt` são modelos DISTINTOS."),
  template_values: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Só em type=template. Valor por slot, chaveado como `slotKey` monta " +
        "(corpo sem prefixo: '1'; cabeçalho: 'header:1'; botão: 'button0:1'). " +
        "Peça os slots a GET /api/v1/channels/modelos em vez de montar a chave.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Chave para deduplicação (24h TTL). Recomendado run_id+step."),
};

function hashRequest(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export const crmStartConversationAndSend: McpToolDefinition<typeof inputShape> = {
  name: "crm_start_conversation_and_send",
  description:
    "Abre uma conversa NOVA (ou reabre a existente) com um contato — existente via `contact_id`, " +
    "ou novo/achado pelo telefone via `phone_number` — num canal ESPECÍFICO escolhido em " +
    "`channel_session_id`, e envia a primeira mensagem. Use para iniciar contato com um lead que " +
    "ainda não tem conversa (ex.: automação de prospecção). Para responder numa conversa que já " +
    "existe, use `crm_send_whatsapp_message`. Forneça `idempotency_key` para evitar abrir a conversa " +
    "e mandar a mensagem em dobro num retry (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (!input.contact_id && !input.phone_number?.trim()) {
      throw new Error("Informe contact_id ou phone_number.");
    }

    const requestHash = hashRequest({
      channel_session_id: input.channel_session_id,
      contact_id: input.contact_id,
      phone_number: input.phone_number,
      body: input.body,
      media_url: input.media_url,
      type: input.type,
      // Entram no hash porque dois disparos do MESMO modelo com valores
      // diferentes são duas mensagens diferentes. Fora dele, o segundo seria
      // tratado como repetição do primeiro e devolveria a resposta dele —
      // silenciosamente, sem nunca chegar ao cliente.
      template_name: input.template_name,
      template_language: input.template_language,
      template_values: input.template_values,
    });

    if (input.idempotency_key) {
      const { data: cached } = await ctx.supabase
        .from("idempotency_keys")
        .select("response_body")
        .eq("organization_id", ctx.organizationId)
        .eq("endpoint", ENDPOINT_TAG)
        .eq("key", input.idempotency_key)
        .maybeSingle();
      if (cached) {
        return {
          ...(cached.response_body as Record<string, unknown>),
          deduplicated: true,
        };
      }
    }

    // `iniciarConversaEEnviar` é a MESMA composição que estava escrita aqui
    // (abrir com `openSharedContactConversation`, enviar com
    // `sendMessageHandler`), extraída quando a tela passou a precisar dela —
    // ver o cabeçalho de `lib/messaging/iniciar-conversa.ts`. Nada de novo
    // acontece por aqui; o que muda é que existe uma cópia só.
    const resultado = await iniciarConversaEEnviar(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        channel_session_id: input.channel_session_id,
        contact_id: input.contact_id,
        phone_number: input.phone_number,
        name: input.name,
        mensagem: {
          type: input.type,
          body: input.body,
          media_url: input.media_url,
          media_mime: input.media_mime,
          template_name: input.template_name,
          template_language: input.template_language,
          template_values: input.template_values,
        },
      },
    );

    const opened = {
      contact_id: resultado.contact_id,
      conversation_id: resultado.conversation_id,
    };

    // O contrato desta tool sempre foi "deu certo ou lançou", e quem a chama é
    // uma automação que precisa distinguir os dois para decidir o retry. O
    // helper devolve o desfecho em vez de lançar porque a TELA precisa das duas
    // notícias (a conversa existe, a mensagem não saiu); aqui a conversa aberta
    // sem mensagem é falha, e dizer isso é o certo.
    if (!resultado.envio.ok) throw new Error(resultado.envio.motivo);
    const message = resultado.envio.message;

    const response = {
      contact_id: opened.contact_id,
      conversation_id: opened.conversation_id,
      message_id: message.id,
      status: message.status,
      external_id: message.external_id,
      sent_at: message.sent_at,
    };

    if (input.idempotency_key) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await ctx.supabase
        .from("idempotency_keys")
        .insert({
          organization_id: ctx.organizationId,
          endpoint: ENDPOINT_TAG,
          key: input.idempotency_key,
          request_hash: requestHash,
          response_body: response,
          status_code: 200,
          expires_at: expiresAt,
        })
        .then(({ error }) => {
          if (error && error.code !== "23505") {
            console.error(
              "[mcp.start_conversation_and_send] idempotency cache failed",
              error.message,
            );
          }
        });
    }

    return response;
  },
};
