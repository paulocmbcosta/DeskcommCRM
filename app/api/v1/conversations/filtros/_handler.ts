/**
 * AS OPÇÕES DOS FILTROS DO INBOX — o que o funil precisa para montar os
 * seletores de atendente, caixa de entrada e assunto, numa leitura só.
 *
 * Por que uma rota nova, e não as que já listam coisa parecida:
 *   · `GET /team/assignable` exige `agent` (o observador enxerga a organização
 *     inteira e ficaria sem o filtro) e não traz quem saiu — que continua dono
 *     de histórico;
 *   · `GET /channel-sessions` serve seletores de "por onde ENVIAR", e por isso
 *     deixa o telefone de fora de propósito; aqui a pergunta é "por onde a
 *     conversa CHEGOU", e o telefone é uma das respostas;
 *   · `GET /atendimentos/assuntos` serve a janela de encerramento: só `agent`+,
 *     só o que ainda dá para escolher. O filtro precisa também do arquivado,
 *     que nomeia atendimento antigo.
 *
 * ─── Os dois clients ────────────────────────────────────────────────────────
 * Caixas e assuntos saem do client do USUÁRIO, sob RLS. Os membros, não: a RLS
 * de `user_organizations` mostra a um atendente só o próprio vínculo, então a
 * lista sai do client de service role — que passa por cima da RLS. Ali o
 * `organization_id` da sessão é a ÚNICA barreira (anti-pattern 10 do CLAUDE.md),
 * e `_handler.test.ts` mede que ela está em toda leitura.
 *
 * LGPD: do usuário sai só o nome de exibição (`nomesDeExibicao`: o nome
 * cadastrado ou, na falta dele, o que vem antes do `@`) — o mesmo que o card
 * de Fechadas já mostra. Nunca o e-mail inteiro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_VISIBILITY_MODE, type Role, type VisibilityMode } from "@/lib/auth/types";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { meioDoCanal } from "@/lib/channels/capabilities";
import { podeVerColegas } from "@/lib/inbox/abas";
import type {
  AssuntosDoTime,
  AtendenteDoFiltro,
  CaixaDeEntrada,
  OpcoesDosFiltros,
} from "@/lib/inbox/opcoes-dos-filtros";

export interface PedidoDasOpcoes {
  /** Client do usuário (anon key + JWT): tudo o que ele lê passa pela RLS. */
  db: SupabaseClient;
  /** Client de service role, ou `null` num self-host sem a chave. */
  admin: SupabaseClient | null;
  /** A organização da SESSÃO — nunca de query nem de corpo. */
  orgId: string;
  role: Role;
  /** Injetado para o teste; na rota é `nomesDeExibicao`. */
  nomes: (userIds: string[]) => Promise<Map<string, string | null>>;
}

const porNome = (a: string | null, b: string | null) =>
  // Sem nome vai para o fim: "(sem nome)" no meio da lista parece um colega.
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b, "pt-BR");

/** O modo de visibilidade da organização — só lido para quem ele decide alguma coisa. */
async function modoDeVisibilidade(db: SupabaseClient, orgId: string): Promise<VisibilityMode> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", orgId).limit(1);
  if (error) throw new Error(error.message);
  const settings = (data?.[0] as { settings?: { visibility_mode?: VisibilityMode } | null } | undefined)
    ?.settings;
  return settings?.visibility_mode ?? DEFAULT_VISIBILITY_MODE;
}

async function carregarAtendentes(pedido: PedidoDasOpcoes): Promise<AtendenteDoFiltro[]> {
  // Sem service role a leitura cai no client do usuário: a RLS devolve o que ele
  // pode ver (para um atendente, só ele mesmo) e a lista sai curta, mas nunca
  // de outra organização. Mesma degradação de `team/assignable`.
  const leitor = pedido.admin ?? pedido.db;
  const { data, error } = await leitor
    .from("user_organizations")
    .select("user_id, role, revoked_at")
    .eq("organization_id", pedido.orgId);
  if (error) throw new Error(error.message);

  // Um usuário pode ter mais de um vínculo (saiu e voltou): vale o ativo.
  const porUsuario = new Map<string, boolean>();
  for (const v of (data ?? []) as Array<{ user_id: string; role: string; revoked_at: string | null }>) {
    // O observador não atende: nunca é dono de conversa.
    if (v.role === "viewer") continue;
    porUsuario.set(v.user_id, (porUsuario.get(v.user_id) ?? false) || v.revoked_at === null);
  }
  if (porUsuario.size === 0) return [];

  const nomes = await pedido.nomes([...porUsuario.keys()]);
  return [...porUsuario.entries()]
    .map(([user_id, ativo]) => ({ user_id, nome: nomes.get(user_id) ?? null, ativo }))
    .sort((a, b) => (a.ativo === b.ativo ? porNome(a.nome, b.nome) : a.ativo ? -1 : 1));
}

async function carregarCaixas(db: SupabaseClient, orgId: string): Promise<CaixaDeEntrada[]> {
  const base = () =>
    db
      .from("channel_sessions")
      // `provider` entra no SELECT e NÃO sai na resposta: vira `meio` logo abaixo.
      .select("id, display_name, phone_number, provider")
      .eq("organization_id", orgId);
  // Arquivado é canal que o operador excluiu. A conversa antiga dele continua
  // alcançável pela linha do MEIO; a linha do número some, como em Conexões.
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) throw new Error(error.message ?? "channel_sessions");

  const caixas: CaixaDeEntrada[] = [];
  for (const c of (data ?? []) as unknown as Array<{
    id: string;
    display_name: string | null;
    phone_number: string | null;
    provider: string | null;
  }>) {
    // Sem meio = linha que não tem conversa própria (a voz do WhatsApp): não é
    // caixa de entrada de conversa nenhuma.
    const meio = meioDoCanal(c.provider);
    if (meio) caixas.push({ id: c.id, meio, nome: c.display_name, numero: c.phone_number });
  }
  return caixas;
}

async function carregarAssuntos(db: SupabaseClient, orgId: string): Promise<AssuntosDoTime[]> {
  const [times, assuntos] = await Promise.all([
    // Com os arquivados, os dois: time e assunto arquivados nomeiam o passado.
    db.from("attendance_teams").select("id, name").eq("organization_id", orgId),
    db.from("atendimento_assuntos").select("id, name, team_id, archived_at").eq("organization_id", orgId),
  ]);
  if (times.error) throw new Error(times.error.message);
  if (assuntos.error) throw new Error(assuntos.error.message);

  const porTime = new Map<string, AssuntosDoTime["assuntos"]>();
  for (const a of (assuntos.data ?? []) as Array<{
    id: string;
    name: string;
    team_id: string;
    archived_at: string | null;
  }>) {
    const lista = porTime.get(a.team_id) ?? [];
    lista.push({ id: a.id, nome: a.name, arquivado: a.archived_at !== null });
    porTime.set(a.team_id, lista);
  }
  return ((times.data ?? []) as Array<{ id: string; name: string }>)
    .filter((time) => porTime.has(time.id))
    .map((time) => ({
      time_id: time.id,
      time: time.name,
      assuntos: (porTime.get(time.id) ?? []).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
    }))
    .sort((a, b) => a.time.localeCompare(b.time, "pt-BR"));
}

export async function carregarOpcoesDosFiltros(pedido: PedidoDasOpcoes): Promise<OpcoesDosFiltros> {
  // QUEM VÊ NOMES DE COLEGA é quem enxerga conversa de colega — a mesma pergunta
  // que decide a aba "Todas". Só o `agent` depende do modo; para os outros
  // papéis a leitura de `organizations` seria uma ida ao banco sem efeito.
  const veColegas =
    pedido.role !== "agent" ||
    podeVerColegas(pedido.role, await modoDeVisibilidade(pedido.db, pedido.orgId));

  const [atendentes, caixas, assuntos] = await Promise.all([
    veColegas ? carregarAtendentes(pedido) : Promise.resolve<AtendenteDoFiltro[]>([]),
    carregarCaixas(pedido.db, pedido.orgId),
    carregarAssuntos(pedido.db, pedido.orgId),
  ]);
  return { atendentes, caixas, assuntos };
}
