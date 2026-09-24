import { createAdminClient } from "@/lib/supabase/admin";
/**
 * Core handlers para /api/v1/conversations.
 *
 * Reusados pelo Route Handler REST e por MCP tools (S-13.03/04).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";

import { aplicarNaFilaDoTime } from "./_na-fila";
import type {
  ListConversationsQuery,
  PatchConversationInput,
} from "@/lib/schemas";
import type { Conversation } from "@/lib/types/messaging";
import { normalizarTermoDeBusca } from "@/lib/inbox/termo-de-busca";

import { MEUS_TIMES, aplicarPredicadoDeTime, predicadoDeTime } from "./_filtro-de-time";

/**
 * Prepara o termo digitado para viajar dentro de um `or=` do PostgREST.
 *
 * Exportada para ser testável: o defeito que ela impede é de SINTAXE, e sintaxe
 * se verifica sem subir banco. O comportamento contra o PostgREST de verdade
 * está em `tests/e2e/`.
 */
export function termoSeguroParaOr(bruto: string): string {
  return bruto
    .trim()
    // curingas do `ilike` (Postgres)
    .replace(/[%_]/g, (m) => `\\${m}`)
    // gramática do `or=` (PostgREST) — viram o próprio curinga
    .replace(/[,()]/g, "*");
}

type SB = SupabaseClient;

/**
 * Quantos contatos a busca do Inbox casa antes de cortar.
 *
 * Não é um número estético: os ids viajam DENTRO da querystring do PostgREST
 * (`contact_id.in.(<uuid>,<uuid>,…)`), e requisição GET tem teto no gateway.
 */
const TETO_DE_CONTATOS_NA_BUSCA = 120;

/**
 * O orçamento de bytes que a lista de ids pode ocupar na URL.
 *
 * O muro real é 8.192 B na linha de requisição (Kong e nginx, ambos no default),
 * e a URL leva mais coisa além dos ids: caminho, `select` com todas as
 * `SELECT_COLS`, o filtro de organização, o `order`, o `limit` e o próprio
 * `ilike` do termo. Medido neste arquivo, com 1 id a URL já tem 892 B — então o
 * que sobra para os ids é o resto, e 5.000 B deixa folga confortável para o
 * termo de busca crescer sem que ninguém precise voltar aqui.
 *
 * Cortar por BYTES e não por quantidade é o que faz esta guarda sobreviver a
 * uma coluna nova em `SELECT_COLS` ou a um formato de id diferente.
 */
const ORCAMENTO_DE_IDS_NA_URL = 5_000;

/**
 * Corta a lista de ids no que cabe no orçamento da URL.
 *
 * Devolver menos contatos torna a busca INCOMPLETA — o que é ruim — mas devolver
 * todos torna a tela QUEBRADA, com `414` virando `500` na cara do operador. Entre
 * uma lista pobre e uma tela que não abre, a lista pobre ganha; e a diferença
 * aparece porque a busca por conteúdo (`last_message_preview`) continua rodando
 * ao lado, sem depender desta lista.
 */
function idsQueCabemNaURL(ids: string[]): string[] {
  const cabem: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    // +1 pela vírgula que separa; o último sobra do lado seguro.
    const custo = id.length + 1;
    if (bytes + custo > ORCAMENTO_DE_IDS_NA_URL) break;
    cabem.push(id);
    bytes += custo;
  }
  return cabem;
}

/** O mesmo predicado de busca para a lista paginada e as contagens exatas. */
export async function filtroDaBuscaDeConversas(
  supabase: SB,
  organizationId: string,
  search: string,
): Promise<{ tipo: "or" | "ilike"; valor: string }> {
  // O termo passa pelos dois parsers: texto digitado e gramática do PostgREST.
  const s = termoSeguroParaOr(normalizarTermoDeBusca(search));
  const somenteDigitos = s.replace(/\D/g, "");
  const pareceTelefone = somenteDigitos.length >= 4;
  const camposDoContato = [
    `display_name.ilike.*${s}*`,
    `name.ilike.*${s}*`,
    ...(pareceTelefone ? [`phone_number.ilike.*${somenteDigitos}*`] : []),
  ].join(",");

  const { data: contatos } = await supabase
    .from("contacts")
    .select("id")
    // Esta função também é chamada pelo handler com service role.
    .eq("organization_id", organizationId)
    .eq("is_anonymized", false)
    .or(camposDoContato)
    .limit(TETO_DE_CONTATOS_NA_BUSCA);

  const ids = idsQueCabemNaURL((contatos ?? []).map((c) => c.id));
  const porProtocolo = pareceTelefone ? [`protocol.ilike.*${somenteDigitos}*`] : [];
  if (ids.length > 0) {
    return {
      tipo: "or",
      valor: [`last_message_preview.ilike.*${s}*`, `contact_id.in.(${ids.join(",")})`, ...porProtocolo].join(","),
    };
  }
  if (porProtocolo.length > 0) {
    return { tipo: "or", valor: [`last_message_preview.ilike.*${s}*`, ...porProtocolo].join(",") };
  }
  // `contact_id.in.()` é inválido; sem contato casado, busca só o preview.
  return { tipo: "ilike", valor: `%${s}%` };
}

const SELECT_COLS = `
  id, organization_id, contact_id, channel_session_id, channel, status,
  status_changed_at, service_revision, service_closed_at, service_started_at, current_demanda_id, assigned_to_user_id, assigned_to_user_name, assignee_kind, assigned_at, last_inbound_at,
  last_outbound_at, last_message_at, last_message_preview,
  unread_count_for_assignee, is_group, group_chat_id, tags, metadata,
  snooze_until, created_at, updated_at, team_id, protocol,
  bot_silenced_until, last_handoff_at, espera_desde,
  comando_da_conversa,
  contacts:contact_id (id, display_name, name, phone_number, email, is_anonymized, tags, is_blocked, avatar_storage_path, force_human),
  channel_sessions:channel_session_id (phone_number, display_name, provider)
`;

interface CursorPayload {
  sort: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload & { last_message_at?: string | null };
    if (typeof parsed.id !== "string") return null;
    // `last_message_at` é o nome legado do campo de ordenação (cursores em voo
    // durante deploy); `sort` é o genérico atual (default OU fila).
    const sort = parsed.sort ?? parsed.last_message_at ?? null;
    return { sort, id: parsed.id };
  } catch {
    return null;
  }
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListConversationsResult {
  conversations: Conversation[];
  cursor: string | null;
  has_more: boolean;
}

export async function listConversationsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  q: ListConversationsQuery,
): Promise<ListConversationsResult> {
  // Fila (assigned_to=unassigned): ordena por TEMPO DE ESPERA — quem espera há
  // mais tempo primeiro. `last_inbound_at` = última mensagem do cliente = "há
  // quanto tempo aguarda resposta" (não `created_at`, que pode ser uma conversa
  // antiga reaberta). Demais visões: por atividade recente (last_message_at desc).
  // A Fila deixou de se identificar por `assigned_to=unassigned` — ela agora pede
  // `comando`. Sem esta linha o `isQueue` ficaria PARA SEMPRE falso na aba Fila e
  // a ordenação por tempo de espera sumiria **sem nenhum sintoma na tela**: a
  // lista continuaria populada, só que ordenada por atividade recente, e quem
  // espera desde ontem afundaria embaixo de quem escreveu agora.
  const isQueue = q.comando?.includes("aguardando") ?? q.assigned_to === "unassigned";
  // "Mais tempo esperando" (migration 0279): a PRIMEIRA mensagem sem resposta,
  // mais antiga primeiro; quem não espera ninguém (null) vai para o fim.
  const porEspera = q.ordem === "espera";
  const sortCol = porEspera ? "espera_desde" : isQueue ? "last_inbound_at" : "last_message_at";
  const asc = porEspera || isQueue;

  let query = supabase
    .from("conversations")
    .select(SELECT_COLS)
    .eq("organization_id", ctx.organization_id)
    .order(sortCol, { ascending: asc, nullsFirst: false })
    .order("id", { ascending: asc })
    .limit(q.limit + 1);

  // `.in` e não `.eq`: o filtro agora chega como LISTA (um valor vira lista de um,
  // e o SQL resultante é equivalente). É o que deixa a aba Fila pedir os dois
  // estados de espera numa consulta só, em vez de filtrar em memória o que a
  // página já truncou.
  if (q.status && q.status.length > 0) query = query.in("status", q.status);
  // O filtro de QUEM MANDA (migration 0203). Vai no banco, e não em memória, para
  // o cursor de paginação continuar valendo: filtrar depois de paginar devolveria
  // páginas curtas e um "carregar mais" que às vezes não traz nada.
  if (q.comando && q.comando.length > 0) {
    query = query.in("comando_da_conversa", q.comando);
  }
  // Depois do `status` de propósito: pedir um status terminal E `exclude_finished`
  // é contradição, e a resposta certa para uma contradição é lista vazia — não
  // um dos dois lados escolhido em silêncio.
  if (q.exclude_finished) {
    query = query.not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
  }
  if (q.channel_session_id) query = query.eq("channel_session_id", q.channel_session_id);
  if (q.tag) query = query.contains("tags", [q.tag]); // tags @> array[tag] (GIN)

  // O TIME (migration 0263) — o SETOR que espera pela conversa, não a pessoa.
  //
  // No banco, e no mesmo ponto dos outros filtros auxiliares, pela razão de
  // sempre: filtrar depois de paginar devolveria páginas curtas e um "carregar
  // mais" que às vezes não traz nada.
  //
  // A régua mora em `_filtro-de-time.ts` porque a contagem do badge aplica a
  // MESMA — e quando cada lado monta o predicado por conta própria, a aba passa
  // a contar o que a lista não mostra.
  if (q.team_id === MEUS_TIMES && ctx.actor.type !== "user") {
    // Um ator de máquina não tem "meus times". Recusar é a única saída honesta:
    // responder a fila geral seria uma lista plausível para uma pergunta que
    // não foi feita. Mesma decisão de `assigned_to=me`, logo abaixo.
    throw new ApiError(
      400,
      "invalid_request",
      undefined,
      ctx.requestId,
      '"team_id=mine" requer ator humano.',
    );
  }
  if (q.team_id) {
    query = aplicarPredicadoDeTime(
      query,
      await predicadoDeTime(
        supabase,
        ctx.organization_id,
        ctx.actor.type === "user" ? ctx.actor.id : null,
        q.team_id,
      ),
    );
  }

  // No BANCO, e não em memória: filtrar depois de paginar devolveria páginas curtas —
  // e, quando a página inteira estivesse lida, uma lista vazia que a tela apresentava
  // como caixa vazia, sem sequer oferecer "Carregar mais".
  //
  // ⛔ Compõe sobre `query`, que JÁ tem `.eq("organization_id", ctx.organization_id)`.
  // Este handler usa o admin client, que passa por cima da RLS: esse filtro é a Única
  // barreira. Consulta nova só para os não lidos nasceria sem barreira nenhuma.
  if (q.unread) query = query.gt("unread_count_for_assignee", 0);
  // Na fila do time: mesma régua da contagem do chip (`_na-fila.ts`). Compõe
  // sobre `query`, que já tem o `organization_id` — a única barreira aqui.
  if (q.na_fila) query = aplicarNaFilaDoTime(query, new Date());

  if (q.assigned_to === "me") {
    if (ctx.actor.type !== "user") {
      throw new ApiError(
        400,
        "invalid_request",
        undefined,
        ctx.requestId,
        '"assigned_to=me" requer ator humano.',
      );
    }
    query = query.eq("assigned_to_user_id", ctx.actor.id);
  } else if (q.assigned_to === "unassigned") {
    query = query.is("assigned_to_user_id", null);
  } else if (q.assigned_to) {
    query = query.eq("assigned_to_user_id", q.assigned_to);
  }

  if (q.search) {
    const busca = await filtroDaBuscaDeConversas(supabase, ctx.organization_id, q.search);
    query = busca.tipo === "or"
      ? query.or(busca.valor)
      : query.ilike("last_message_preview", busca.valor);
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      throw new ApiError(
        400,
        "invalid_cursor",
        undefined,
        ctx.requestId,
        traduzir("Cursor inválido.", ctx.idioma ?? "pt-BR"),
      );
    }
    const op = asc ? "gt" : "lt";
    if (c.sort) {
      // `nullsFirst: false` põe as linhas SEM valor depois de todas as com valor
      // — então elas continuam "à frente" de qualquer cursor com valor, e o
      // `.or` tem de incluí-las. Sem o `is.null`, em "Mais tempo esperando" a
      // paginação terminava junto com quem espera, e toda conversa já respondida
      // (`espera_desde` nulo — a maior parte da caixa) sumia da lista.
      query = query.or(
        `${sortCol}.${op}.${c.sort},and(${sortCol}.eq.${c.sort},id.${op}.${c.id}),${sortCol}.is.null`,
      );
    } else {
      // Página já na região de sort NULL (nulls last): pagina só por id.
      query = query.is(sortCol, null);
      query = asc ? query.gt("id", c.id) : query.lt("id", c.id);
    }
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = (data ?? []) as unknown as Conversation[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last
      ? encodeCursor({ sort: (last[sortCol] as string | null) ?? null, id: last.id })
      : null;

  return { conversations: page, cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export async function getConversationHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .select(SELECT_COLS)
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Conversa não encontrada.", ctx.idioma ?? "pt-BR"),
    );
  }
  return data as unknown as Conversation;
}

// ---------------------------------------------------------------------------
// update status (claim/close/release)
// ---------------------------------------------------------------------------

export async function patchConversationHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
  input: PatchConversationInput,
): Promise<Conversation> {
  const update: Record<string, unknown> = {};

  /**
   * O ATALHO `status='claimed'` PASSA PELA RPC, e não escreve o dono aqui.
   *
   * Ele gravava `assigned_to_user_id` direto na tabela, e isso deixava TRÊS
   * coisas para trás em relação ao `POST /claim`: nenhum evento em
   * `conversation_assignment_events` (a auditoria de troca de dono simplesmente
   * não existia por este caminho), `assignee_kind` intocado — o que viola a
   * constraint `conversations_assignee_kind_coherence` quando a linha já tinha
   * `assignee_kind='ai'` — e, desde a 0173, o silêncio do automático não sendo
   * ligado, produzindo uma conversa com dono humano e o robô ainda respondendo.
   *
   * É a API pública versionada, alcançável por qualquer bearer agent+: dois
   * caminhos de assumir com efeitos diferentes é o defeito, não a conveniência.
   */
  const assumirPelaRpc =
    input.status === "claimed" && ctx.actor.type === "user" ? ctx.actor.id : null;

  if (assumirPelaRpc !== null) {
    const { error: erroRpc } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: ctx.organization_id,
      p_conversation_id: conversationId,
      p_to_user_id: assumirPelaRpc,
      p_reason: "claim",
      p_expected_assignee: null,
      // Sem lock otimista: este atalho nunca teve um, e passar a exigi-lo faria
      // um cliente da API que hoje funciona começar a receber 409.
      p_enforce_expected: false,
    });
    if (erroRpc) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroRpc.message);
    }
  }

  if (input.status !== undefined) {
    const observed = await getConversationHandler(supabase, ctx, conversationId);
    // COM AUTOR, e `open` CONTINUA o atendimento (migration 0266).
    //
    // Esta porta usa o service role, então `auth.uid()` é nulo dentro do banco e
    // a linha do tempo diria "o sistema fechou". O autor viaja por parâmetro.
    //
    // `p_retomar` só é verdadeiro no `open` pedido por ESTA porta: é o "Reabrir"
    // — alguém decidiu continuar aquele atendimento, e o protocolo não muda.
    // Quando quem tira a conversa do estado terminal é o cliente escrevendo de
    // novo (`fn_service_inbound`), nasce atendimento novo com protocolo novo.
    const { error: statusError } = await createAdminClient().rpc("fn_service_status_com_ator", {
      p_org: ctx.organization_id, p_conversation: conversationId, p_status: input.status,
      p_expected: input.expected_revision ?? observed.service_revision ?? null,
      p_actor: ctx.actor.type === "user" ? ctx.actor.id : null,
      p_retomar: input.status === "open",
    });
    if (statusError) throw new ApiError(statusError.code === "40001" ? 409 : statusError.code === "P0002" ? 404 : 500,
      statusError.code === "40001" ? "conflict" : statusError.code === "P0002" ? "not_found" : "internal_error", undefined, ctx.requestId, statusError.message);
  }
  if (input.tags !== undefined) {
    update.tags = input.tags;
  }

  const query = Object.keys(update).length > 0
    ? supabase.from("conversations").update(update)
    : supabase.from("conversations");
  const { data, error } = await query.select(SELECT_COLS)
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Conversa não encontrada.", ctx.idioma ?? "pt-BR"),
    );
  }

  const conv = data as unknown as Conversation;

  const a = actorAuditPayload(ctx.actor);

  if (input.status !== undefined) {
    const action =
      input.status === "claimed"
        ? "conversation.claimed"
        : input.status === "closed"
          ? "conversation.closed"
          : input.status === "open"
            ? "conversation.reopened"
            : "conversation.released";
    await audit({
      action,
      actorUserId: a.actorUserId,
      organizationId: conv.organization_id,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, status: input.status },
    });
  }
  if (input.tags !== undefined) {
    await audit({
      action: "conversation.tags_changed",
      actorUserId: a.actorUserId,
      organizationId: conv.organization_id,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, tags: input.tags },
    });
  }

  return conv;
}

// ---------------------------------------------------------------------------
// mark read
// ---------------------------------------------------------------------------

export async function markConversationReadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .update({ unread_count_for_assignee: 0 })
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Conversa não encontrada.", ctx.idioma ?? "pt-BR"),
    );
  }
  return data as unknown as Conversation;
}
