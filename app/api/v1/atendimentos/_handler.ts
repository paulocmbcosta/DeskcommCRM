/**
 * ATENDIMENTOS ENCERRADOS — a lista que a aba "Fechadas" do inbox mostra.
 *
 * A aba listava CONVERSAS com status fechado. Só que a conversa é uma por
 * cliente e canal (0266): quando o cliente volta, ela reabre, e o atendimento
 * que acabou de ser encerrado SUMIA da aba — justo a pergunta que um gestor faz
 * no fim do dia ("o que foi encerrado hoje?") ficava sem resposta para todo
 * cliente que voltou. A unidade da aba Fechadas é o ATENDIMENTO.
 *
 * Client do USUÁRIO, sempre: a policy de `atendimentos` herda o escopo da
 * conversa, e o `conversations!inner` aplica a RLS de `conversations` de novo.
 * Organização vinda da sessão; nenhum filtro vem do corpo.
 *
 * Os filtros auxiliares são OS MESMOS da lista de conversas (número, etiqueta,
 * time, não lidas) — e a contagem do badge (`conversations/counts`) aplica a
 * mesma régua, porque badge que conta o que a aba não mostra manda procurar
 * trabalho que não existe. Duas diferenças de significado, ditas aqui:
 *   · o TIME é o do FECHAMENTO (`atendimentos.team_id`), não o de agora — depois
 *     que o cliente volta a conversa começa sem time (0269), e filtrar pelo time
 *     atual esconderia o que o Financeiro encerrou;
 *   · número, etiqueta e não lidas são da CONVERSA, que é onde esses dados moram.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  aplicarPredicadoDeTime,
  predicadoDeTime,
  type ConsultaFiltravel,
} from "@/app/api/v1/conversations/_filtro-de-time";
import { termoSeguroParaOr } from "@/app/api/v1/conversations/_handler";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { AtendimentoResumo } from "@/lib/inbox/eventos-da-conversa";
import { rotuloDoCanal } from "@/lib/inbox/rotulo-do-canal";
import { buscaValeConsulta, normalizarTermoDeBusca } from "@/lib/inbox/termo-de-busca";
import { conversationTagSchema, filtroDeTimeSchema } from "@/lib/schemas";

export const listarFechadosSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && buscaValeConsulta(v) ? v : undefined)),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  team_id: filtroDeTimeSchema.optional(),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export type ListarFechadosQuery = z.infer<typeof listarFechadosSchema>;

/** O atendimento encerrado como o card da aba Fechadas o lê. */
export interface AtendimentoFechado extends AtendimentoResumo {
  contact_id: string | null;
  contato: string;
  telefone: string | null;
  avatar_storage_path: string | null;
  anonimizado: boolean;
  /** O cliente VOLTOU depois deste atendimento: a conversa está aberta de novo. */
  conversa_em_andamento: boolean;
}

export const COLUNAS_DO_FECHADO = `
  id, conversation_id, protocol, started_at, closed_at, closed_status, closed_by_name,
  assigned_to_user_name, team_id,
  conversations!inner (
    id, status, contact_id, channel_session_id, tags, unread_count_for_assignee,
    channel_sessions:channel_session_id (phone_number, display_name),
    contacts:contact_id (id, display_name, name, phone_number, is_anonymized, avatar_storage_path)
  )`;

const TERMINAIS = new Set(["closed", "resolved", "archived"]);
/** Os ids viajam na URL do PostgREST; o muro é de bytes (ver `conversations/_handler.ts`). */
const ORCAMENTO_DE_IDS_NA_URL = 5_000;
const TETO_DE_CONTATOS_NA_BUSCA = 120;

interface Linha {
  id: string;
  conversation_id: string;
  protocol: string;
  started_at: string;
  closed_at: string | null;
  closed_status: string | null;
  closed_by_name: string | null;
  assigned_to_user_name: string | null;
  team_id: string | null;
  conversations: {
    status: string;
    contact_id: string | null;
    channel_sessions: { phone_number: string | null; display_name: string | null } | null;
    contacts: {
      id: string;
      display_name: string | null;
      name: string | null;
      phone_number: string | null;
      is_anonymized: boolean | null;
      avatar_storage_path: string | null;
    } | null;
  } | null;
}

interface Cursor {
  closed_at: string;
  id: string;
}
const codificar = (c: Cursor) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
function decodificar(bruto: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Partial<Cursor>;
    return typeof c.closed_at === "string" && typeof c.id === "string" ? { closed_at: c.closed_at, id: c.id } : null;
  } catch {
    return null;
  }
}

function cabemNaUrl(ids: string[]): string[] {
  const cabem: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    if (bytes + id.length + 1 > ORCAMENTO_DE_IDS_NA_URL) break;
    cabem.push(id);
    bytes += id.length + 1;
  }
  return cabem;
}

/**
 * As conversas cujo CONTATO casa com o termo. Dois passos (contatos → conversas)
 * porque o `or=` do PostgREST não cruza tabela: o predicado final precisa ser
 * todo de colunas de `atendimentos` (`protocol` OU `conversation_id`).
 */
async function conversasDoTermo(db: SupabaseClient, org: string, termo: string): Promise<string[]> {
  const s = termoSeguroParaOr(normalizarTermoDeBusca(termo));
  const digitos = s.replace(/\D/g, "");
  const campos = [
    `display_name.ilike.*${s}*`,
    `name.ilike.*${s}*`,
    ...(digitos.length >= 4 ? [`phone_number.ilike.*${digitos}*`] : []),
  ].join(",");
  const { data: contatos } = await db
    .from("contacts")
    .select("id")
    .eq("organization_id", org)
    // Anonimizar é direito do titular: voltar a achá-lo pelo nome antigo seria vazamento.
    .eq("is_anonymized", false)
    .or(campos)
    .limit(TETO_DE_CONTATOS_NA_BUSCA);
  const idsDeContato = cabemNaUrl((contatos ?? []).map((c) => (c as { id: string }).id));
  if (idsDeContato.length === 0) return [];
  const { data: conversas } = await db
    .from("conversations")
    .select("id")
    .eq("organization_id", org)
    .in("contact_id", idsDeContato)
    .limit(TETO_DE_CONTATOS_NA_BUSCA);
  return cabemNaUrl((conversas ?? []).map((c) => (c as { id: string }).id));
}

export type ResultadoDosFechados =
  | { ok: true; data: AtendimentoFechado[]; cursor: string | null; has_more: boolean }
  | { ok: false; motivo: "cursor_invalido" | "erro_de_leitura" };

export async function listarAtendimentosFechados(
  db: SupabaseClient,
  ctx: { organizationId: string; userId: string; t: (texto: string) => string },
  q: ListarFechadosQuery,
): Promise<ResultadoDosFechados> {
  let consulta = db
    .from("atendimentos")
    .select(COLUNAS_DO_FECHADO)
    .eq("organization_id", ctx.organizationId)
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.channel_session_id) consulta = consulta.eq("conversations.channel_session_id", q.channel_session_id);
  if (q.tag) consulta = consulta.contains("conversations.tags", [q.tag]);
  if (q.unread) consulta = consulta.gt("conversations.unread_count_for_assignee", 0);
  if (q.team_id) {
    // O cast tira do compilador uma conta que ele não termina: o builder tipado
    // pelo `select` com embed, passado a um genérico, estoura a profundidade de
    // instanciação (TS2589). A régua aplicada é a MESMA — `aplicarPredicadoDeTime`
    // só chama `eq`/`is`/`or` sobre a coluna `team_id`, que existe aqui também.
    const predicado = await predicadoDeTime(db, ctx.organizationId, ctx.userId, q.team_id);
    consulta = aplicarPredicadoDeTime(consulta as unknown as ConsultaFiltravel, predicado) as unknown as typeof consulta;
  }

  if (q.search) {
    const digitos = q.search.replace(/\D/g, "");
    const conversas = await conversasDoTermo(db, ctx.organizationId, q.search);
    const partes = [
      ...(digitos.length >= 4 ? [`protocol.ilike.*${digitos}*`] : []),
      ...(conversas.length > 0 ? [`conversation_id.in.(${conversas.join(",")})`] : []),
    ];
    // Nada casou: a resposta honesta é lista vazia, não a lista inteira — e um
    // `or=()` vazio é sintaxe inválida no PostgREST.
    if (partes.length === 0) return { ok: true, data: [], cursor: null, has_more: false };
    consulta = consulta.or(partes.join(","));
  }

  if (q.cursor) {
    const c = decodificar(q.cursor);
    if (!c) return { ok: false, motivo: "cursor_invalido" };
    consulta = consulta.or(`closed_at.lt.${c.closed_at},and(closed_at.eq.${c.closed_at},id.lt.${c.id})`);
  }

  const { data, error } = await consulta;
  if (error) return { ok: false, motivo: "erro_de_leitura" };

  const linhas = (data ?? []) as unknown as Linha[];
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1];

  return {
    ok: true,
    has_more: temMais,
    cursor: temMais && ultima?.closed_at ? codificar({ closed_at: ultima.closed_at, id: ultima.id }) : null,
    data: pagina.map((a) => {
      const contato = a.conversations?.contacts ?? null;
      return {
        id: a.id,
        conversation_id: a.conversation_id,
        protocol: a.protocol,
        started_at: a.started_at,
        closed_at: a.closed_at,
        closed_status: a.closed_status,
        closed_by_name: a.closed_by_name,
        assigned_to_user_name: a.assigned_to_user_name,
        team_id: a.team_id,
        canal: rotuloDoCanal(a.conversations?.channel_sessions ?? null),
        contact_id: contato?.id ?? a.conversations?.contact_id ?? null,
        contato: rotuloDoContato(contato, ctx.t),
        telefone: contato?.phone_number ?? null,
        avatar_storage_path: contato?.is_anonymized ? null : (contato?.avatar_storage_path ?? null),
        anonimizado: Boolean(contato?.is_anonymized),
        conversa_em_andamento: !TERMINAIS.has(a.conversations?.status ?? ""),
      };
    }),
  };
}
