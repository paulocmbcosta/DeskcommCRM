/**
 * Ingestão do chat do site: mensagem do visitante → contato, conversa, mensagem.
 *
 * Mesmo esqueleto dos outros três ingests, com uma diferença de origem: lá o
 * evento chega de uma plataforma que já autenticou quem fala (o WhatsApp sabe de
 * quem é o número). Aqui quem fala é um navegador anônimo, e TUDO o que ele
 * declara — nome, e-mail, telefone — é afirmação sem prova. As três decisões
 * abaixo saem disso.
 *
 * ─── 1. A thread é a identidade ─────────────────────────────────────────────
 *
 * `conversations.provider_conversation_id` guarda o SHA-256 do token do
 * visitante. Token conhecido = a mesma pessoa, ponto; não se pergunta de novo
 * "quem é?" pelo nome ou pelo telefone que ela digitou. É a regra que o canal
 * intermediado aprendeu em produção ("a thread é a prova de identidade, e vem
 * antes da âncora"), aplicada onde ela é ainda mais necessária.
 *
 * ─── 2. Visitante novo é SEMPRE contato novo ────────────────────────────────
 *
 * Telefone digitado num formulário aberto não é identidade. Se o ingest
 * procurasse um contato existente por ele, qualquer um viraria "o cliente
 * fulano" escrevendo o número do fulano — e o atendente, vendo a ficha
 * verdadeira ao lado (histórico, fatura do ERP pelo conector), entregaria dado
 * a quem não é o dono. Então: contato novo, sempre. Se o telefone declarado JÁ
 * pertence a alguém, ele vai para `source_metadata` como "informado, não
 * verificado" e a fusão fica com o humano, que tem contexto para decidir
 * (`fn_merge_contacts`, pela tela de duplicados).
 *
 * Telefone LIVRE é gravado em `phone_number`: não há ficha alheia para expor, e
 * é o que permite ao follow-up alcançar o visitante depois que ele fecha a aba.
 *
 * ─── 3. Os efeitos de negócio são os MESMOS ─────────────────────────────────
 *
 * Opt-out, nascimento do lead e despacho do agente são de
 * `aplicarEfeitosPosEntrada` — regra do produto, não do transporte. Foi a cópia
 * privada desses três dentro de um ingest que deixou dois canais sem lead e sem
 * agente por semanas; este já nasce delegando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

import type { MeioDeCanal } from "../capabilities";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

import type { CanalPublico } from "./canal";
import { gerarTokenDoVisitante, threadDoVisitante } from "./identidade";
import { paraMensagemDoWidget, type MensagemDoWidget } from "./leitura";

/** O meio da conversa — valor de `conversations.channel` (migration 0272). */
export const MEIO_CHAT_DO_SITE: MeioDeCanal = "site_chat";

/** Rótulo de origem para `event_log`/auditoria. Não é decisão: ninguém ramifica por ele. */
const ORIGEM = "site_chat";

export interface VisitanteDeclarado {
  nome?: string | null;
  email?: string | null;
  telefone?: string | null;
}

export interface PaginaDoVisitante {
  url?: string | null;
  titulo?: string | null;
  utm?: Record<string, string>;
}

export interface EntradaDoVisitante {
  canal: CanalPublico;
  /** Token apresentado, JÁ com a forma conferida pela rota. `null` = visitante novo. */
  token: string | null;
  /** UUID gerado pelo widget — a chave de idempotência do envio. */
  clientMessageId: string;
  texto: string;
  visitante?: VisitanteDeclarado;
  pagina?: PaginaDoVisitante;
  requestId?: string;
}

export type DesfechoDaEntrada =
  | {
      status: "ingested" | "duplicate";
      conversationId: string;
      /** Só na PRIMEIRA mensagem: é a única vez que o token existe em claro fora do navegador. */
      tokenNovo: string | null;
      mensagem: MensagemDoWidget | null;
    }
  /** O token não abre conversa nenhuma deste widget (apagada, anonimizada, de outro canal). */
  | { status: "token_desconhecido" };

const COLUNAS_DA_MENSAGEM =
  "id, direction, type, body, media_mime, media_storage_path, external_id, metadata, created_at";

export async function ingerirMensagemDoVisitante(
  admin: SupabaseClient,
  entrada: EntradaDoVisitante,
): Promise<DesfechoDaEntrada> {
  const { canal } = entrada;
  const organizationId = canal.organizationId;

  let conversa: { id: string; contact_id: string } | null = null;
  let tokenNovo: string | null = null;

  if (entrada.token) {
    conversa = await conversaDoVisitante(admin, canal, entrada.token);
    if (!conversa) return { status: "token_desconhecido" };
  } else {
    tokenNovo = gerarTokenDoVisitante();
    const thread = threadDoVisitante(tokenNovo);
    const contactId = await criarContato(admin, organizationId, thread, entrada);
    const conversationId = await criarConversa(admin, {
      organizationId,
      contactId,
      channelSessionId: canal.id,
      thread,
      pagina: entrada.pagina,
    });
    conversa = { id: conversationId, contact_id: contactId };
  }

  // Namespaced pelo canal: `unique (organization_id, external_id)` é da
  // organização inteira, e o id vem do navegador. Sem o prefixo, um visitante
  // poderia escolher um id igual ao de uma mensagem de OUTRO canal e fazer a
  // dele ser lida como reentrega.
  const externalId = `site:${entrada.clientMessageId}`;

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversa.id,
      contact_id: conversa.contact_id,
      channel_session_id: canal.id,
      external_id: externalId,
      direction: "inbound",
      type: "text",
      body: entrada.texto,
      // Veio de fora do CRM — o mesmo carimbo dos outros ingests. O default da
      // coluna (`'crm'`) mentiria aqui, e os painéis de atrito contam por ele.
      sent_via: "external_device",
      status: "delivered",
      metadata: entrada.pagina?.url ? { site_chat_pagina: entrada.pagina.url } : {},
    })
    .select(COLUNAS_DA_MENSAGEM)
    .maybeSingle();

  // 23505 = reenvio do MESMO `client_message_id` (o widget tenta de novo quando
  // a resposta se perde). Desfecho esperado, não erro — e não devolve o corpo da
  // linha que já existe: ela pode ser de outra conversa.
  if (error?.code === "23505") {
    return { status: "duplicate", conversationId: conversa.id, tokenNovo, mensagem: null };
  }
  if (error || !data) {
    throw new Error(`site_chat_ingest_insert_failed: ${error?.message ?? "sem linha"}`);
  }

  const linha = data as Parameters<typeof paraMensagemDoWidget>[0];

  await marcarConversaComMensagem(admin, {
    organizationId,
    conversationId: conversa.id,
    direction: "inbound",
    preview: entrada.texto.slice(0, 200),
    // A hora do SERVIDOR, não a do navegador: o relógio do visitante é dado de
    // fora, e `last_inbound_at` ordena a fila e alimenta SLA.
    at: linha.created_at,
    canal: ORIGEM,
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId,
    contactId: conversa.contact_id,
    conversationId: conversa.id,
    messageId: linha.id,
    channelSessionId: canal.id,
    texto: entrada.texto,
    nomeDoContato: limpar(entrada.visitante?.nome, 120),
    requestId: entrada.requestId,
    origem: ORIGEM,
  });

  return {
    status: "ingested",
    conversationId: conversa.id,
    tokenNovo,
    mensagem: paraMensagemDoWidget(linha, null),
  };
}

/**
 * Token → conversa DESTE widget.
 *
 * Os três filtros são a autorização inteira da rota pública: organização (da
 * chave do widget, nunca do corpo), canal (o token de um widget não abre
 * conversa de outro, mesmo dentro da mesma organização) e a thread (o hash do
 * segredo). Conversa anonimizada pela LGPD perde a thread junto com o contato —
 * ver `lib/lgpd/` —, então o token dela cai aqui como desconhecido.
 */
export async function conversaDoVisitante(
  admin: SupabaseClient,
  canal: CanalPublico,
  token: string,
): Promise<{ id: string; contact_id: string } | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", canal.organizationId)
    .eq("channel_session_id", canal.id)
    .eq("provider_conversation_id", threadDoVisitante(token))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`site_chat_thread_lookup_failed: ${error.message}`);
  const row = data as { id: string; contact_id: string | null } | null;
  return row?.contact_id ? { id: row.id, contact_id: row.contact_id } : null;
}

function limpar(valor: string | null | undefined, max: number): string | null {
  const v = (valor ?? "").trim().slice(0, max);
  return v.length > 0 ? v : null;
}

const FORMA_DE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function criarContato(
  admin: SupabaseClient,
  organizationId: string,
  thread: string,
  entrada: EntradaDoVisitante,
): Promise<string> {
  const nome = limpar(entrada.visitante?.nome, 120);
  const emailBruto = limpar(entrada.visitante?.email, 254)?.toLowerCase() ?? null;
  const email = emailBruto && FORMA_DE_EMAIL.test(emailBruto) ? emailBruto : null;
  const telefoneBruto = limpar(entrada.visitante?.telefone, 32);
  const telefone = telefoneBruto ? normalizePhoneBR(telefoneBruto) : null;

  // Sem nome, o inbox mostraria "Sem nome" para todo visitante anônimo — dez
  // conversas iguais na lista. Quatro caracteres da thread bastam para o
  // atendente dizer "o visitante 7F3A" ao colega; não são segredo (é o hash, não
  // o token) e não identificam ninguém fora do CRM.
  const apelido = nome ?? `Visitante ${thread.slice(-4).toUpperCase()}`;

  const metadados: Record<string, unknown> = {
    site_chat: {
      canal_id: entrada.canal.id,
      pagina: limpar(entrada.pagina?.url, 500),
      titulo_da_pagina: limpar(entrada.pagina?.titulo, 200),
      ...(entrada.pagina?.utm && Object.keys(entrada.pagina.utm).length > 0 ? { utm: entrada.pagina.utm } : {}),
    },
  };

  // Tentativas em ordem de "o que dá para gravar": com tudo; sem o telefone que
  // já é de outro; sem o e-mail que já é de outro. O índice único é a autoridade
  // — consultar antes e inserir depois seria o check-then-act que o banco já
  // resolve melhor.
  let usarTelefone = telefone;
  let usarEmail = email;

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const { data, error } = await admin
      .from("contacts")
      .insert({
        organization_id: organizationId,
        name: nome,
        display_name: apelido,
        email: usarEmail,
        phone_number: usarTelefone,
        source: ORIGEM,
        source_metadata: {
          ...metadados,
          ...(telefone && !usarTelefone ? { telefone_informado_nao_verificado: telefone } : {}),
          ...(email && !usarEmail ? { email_informado_nao_verificado: email } : {}),
        },
      })
      .select("id")
      .single();

    if (!error && data) return (data as { id: string }).id;

    if (error?.code === "23505") {
      const detalhe = `${error.message} ${error.details ?? ""}`;
      if (usarTelefone && detalhe.includes("phone")) {
        usarTelefone = null;
        continue;
      }
      if (usarEmail && detalhe.includes("email")) {
        usarEmail = null;
        continue;
      }
      // Violação única que não sabemos nomear: solta os dois de uma vez em vez
      // de desistir do visitante por causa de um dado opcional.
      if (usarTelefone || usarEmail) {
        usarTelefone = null;
        usarEmail = null;
        continue;
      }
    }
    throw new Error(`site_chat_contact_insert_failed: ${error?.message ?? "sem linha"}`);
  }
  throw new Error("site_chat_contact_insert_failed: tentativas esgotadas");
}

async function criarConversa(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    channelSessionId: string;
    thread: string;
    pagina?: PaginaDoVisitante;
  },
): Promise<string> {
  // INSERT direto, e não `fn_upsert_wa_conversation`: aquela RPC grava
  // `channel = 'whatsapp'` fixo, e não há o que "upsertar" — o contato acabou de
  // nascer, então a conversa 1:1 dele neste canal não tem como existir.
  const { data, error } = await admin
    .from("conversations")
    .insert({
      organization_id: input.organizationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      channel: MEIO_CHAT_DO_SITE,
      status: "open",
      is_group: false,
      unread_count_for_assignee: 0,
      provider_conversation_id: input.thread,
      metadata: input.pagina?.url ? { site_chat: { pagina_de_entrada: input.pagina.url.slice(0, 500) } } : {},
    })
    .select("id")
    .single();
  if (error || !data) {
    logger.error("[site-chat] conversa não criada", {
      organization_id: input.organizationId,
      detail: error?.message.slice(0, 160),
    });
    throw new Error(`site_chat_conversation_insert_failed: ${error?.message ?? "sem linha"}`);
  }
  return (data as { id: string }).id;
}
