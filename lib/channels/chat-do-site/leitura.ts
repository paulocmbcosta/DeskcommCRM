/**
 * O que o navegador do visitante LÊ — a outra metade do transporte deste canal.
 *
 * Nos canais de WhatsApp, "entregar" é um POST para a API de alguém. Aqui é
 * isto: o widget pergunta "o que há de novo?" e esta função responde. Duas
 * consequências que não são detalhe:
 *
 * ─── É aqui que `sent` vira `delivered` ─────────────────────────────────────
 *
 * O adapter marca `sent` ("está na caixa de saída"). Só quando a mensagem é de
 * fato ENTREGUE a um navegador ela vira `delivered`. É o laço de retorno do
 * canal (invariante 7 do sistema vivo): um tique só, parado, diz ao atendente
 * que o visitante fechou a aba e ninguém leu — e ele troca de canal em vez de
 * esperar resposta de quem não está mais lá.
 *
 * ─── O recorte do que o visitante pode ver ──────────────────────────────────
 *
 * Esta é uma rota ANÔNIMA devolvendo conteúdo de atendimento, então o recorte é
 * lista branca, não lista negra:
 *   - só a conversa do token apresentado (quem chama já resolveu isso);
 *   - só tipos que o widget sabe desenhar (`TIPOS_VISIVEIS`) — `system` e
 *     `reaction` ficam de fora, e tipo novo nasce invisível até alguém decidir;
 *   - nada apagado (`revoked_at`);
 *   - saída que FALHOU ou ainda está na fila não aparece: mostrar ao visitante
 *     uma mensagem que o CRM considera não enviada criaria duas verdades.
 * Nota interna nem está nesta tabela (`conversation_notes`) — não tem como
 * vazar por aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TIPOS_VISIVEIS = ["text", "image", "video", "audio", "document", "sticker"] as const;
/** Saída só aparece depois de sair. Entrada do próprio visitante aparece sempre. */
const STATUS_DE_SAIDA_VISIVEIS = ["sent", "delivered", "read"] as const;

/** Por quanto tempo vale o link de um anexo entregue ao widget. */
const VALIDADE_DO_LINK_DE_MIDIA_S = 60 * 60;

const BUCKET = "whatsapp-media";

/** Quanto a leitura recua atrás do cursor do widget. Ver `lerMensagensDoVisitante`. */
const SOBREPOSICAO_DO_CURSOR_MS = 10 * 60 * 1000;

/** Quantas mensagens cabem numa resposta. O widget pede de novo a partir do cursor. */
export const MAXIMO_POR_LEITURA = 100;

export interface MensagemDoWidget {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  media: { url: string; mime: string | null; filename: string | null } | null;
  /** O `client_message_id` que o widget mandou — é como ele reconhece a própria mensagem. */
  client_id: string | null;
  created_at: string;
}

interface LinhaDeMensagem {
  id: string;
  direction: string;
  type: string;
  body: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const COLUNAS =
  "id, direction, type, body, media_mime, media_storage_path, external_id, metadata, status, created_at";

const PREFIXO_DO_ID_DE_ENTRADA = "site:";

export function paraMensagemDoWidget(l: LinhaDeMensagem, urlDaMidia: string | null): MensagemDoWidget {
  const meta = l.metadata ?? {};
  const nomeDoArquivo =
    typeof meta.filename === "string" ? meta.filename : typeof meta.media_filename === "string" ? meta.media_filename : null;
  return {
    id: l.id,
    direction: l.direction === "inbound" ? "inbound" : "outbound",
    type: l.type,
    body: l.body,
    media: urlDaMidia ? { url: urlDaMidia, mime: l.media_mime, filename: nomeDoArquivo } : null,
    client_id:
      l.direction === "inbound" && l.external_id?.startsWith(PREFIXO_DO_ID_DE_ENTRADA)
        ? l.external_id.slice(PREFIXO_DO_ID_DE_ENTRADA.length)
        : null,
    created_at: l.created_at,
  };
}

export async function lerMensagensDoVisitante(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    /** ISO-8601 da última mensagem que o widget já tem. Ausente = histórico recente. */
    depoisDe: string | null;
  },
): Promise<MensagemDoWidget[]> {
  let consulta = admin
    .from("messages")
    .select(COLUNAS)
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .in("type", [...TIPOS_VISIVEIS])
    .is("revoked_at", null);

  // Com cursor, a janela começa ANTES dele — de propósito.
  //
  // O handler de envio grava a saída como `queued` e só depois a promove a
  // `sent`; enquanto está `queued` ela é invisível aqui. Se o visitante escreve
  // nesse intervalo, o cursor do widget passa à frente do `created_at` da
  // resposta, e um `created_at > cursor` exato nunca mais a devolveria — a
  // resposta do atendente sumiria para sempre, sem erro em lugar nenhum. A
  // sobreposição relê os últimos minutos e o widget descarta o que já tem (ele
  // deduplica por `id`).
  if (input.depoisDe) {
    const desde = new Date(new Date(input.depoisDe).getTime() - SOBREPOSICAO_DO_CURSOR_MS);
    if (!Number.isNaN(desde.getTime())) consulta = consulta.gt("created_at", desde.toISOString());
  }

  // Sempre as MAIS RECENTES (desc + inverte), com ou sem cursor. Pedir asc faria
  // uma janela cheia de mensagens já vistas ocupar a página inteira e deixar a
  // nova de fora.
  consulta = consulta.order("created_at", { ascending: false });

  const { data, error } = await consulta.limit(MAXIMO_POR_LEITURA);
  if (error) throw new Error(`site_chat_read_failed: ${error.message}`);

  const linhas = ((data ?? []) as Array<LinhaDeMensagem & { status: string }>).filter(
    (l) => l.direction === "inbound" || (STATUS_DE_SAIDA_VISIVEIS as readonly string[]).includes(l.status),
  );
  linhas.reverse();

  const saida: MensagemDoWidget[] = [];
  for (const l of linhas) {
    let url: string | null = null;
    // Só mídia que NÓS guardamos, por caminho do nosso bucket. `media_url` cru
    // de uma linha qualquer nunca é repassado: no WhatsApp ele aponta para
    // endpoint autenticado de provider, e devolvê-lo a um anônimo seria vazar
    // endereço interno.
    if (l.direction === "outbound" && l.media_storage_path) {
      const { data: assinado } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(l.media_storage_path, VALIDADE_DO_LINK_DE_MIDIA_S);
      url = assinado?.signedUrl ?? null;
    }
    saida.push(paraMensagemDoWidget(l, url));
  }

  const entreguesAgora = linhas.filter((l) => l.direction === "outbound" && l.status === "sent").map((l) => l.id);
  if (entreguesAgora.length > 0) {
    // Best-effort: a mensagem JÁ foi entregue (está no `saida`). Falhar aqui
    // deixa o tique atrasado, e a próxima leitura conserta.
    await admin
      .from("messages")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .eq("status", "sent")
      .in("id", entreguesAgora);
  }

  return saida;
}
