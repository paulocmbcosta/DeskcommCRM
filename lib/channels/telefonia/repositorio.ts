/**
 * O banco da telefonia, do lado do worker (spec 20 §4–§5) — toda leitura e
 * escrita que o controlador de chamadas faz, num lugar só.
 *
 * Pool `pg` direto (o mesmo do resto do worker): as consultas são poucas,
 * quentes e cruzam tabelas; e o worker não tem sessão de usuário — toda query
 * filtra `organization_id` explicitamente, que vem SEMPRE do tronco (resolvido
 * pelo endpoint do Asterisk, nunca de dado que o chamador controla).
 */
import type pg from "pg";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";
import { isWithinSchedule } from "@/lib/routing/eligibility";
import { lerAgenda } from "@/lib/times/agenda";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { CandidatoAoToque } from "@/lib/telefonia/distribuicao";

import { CHANNEL_PROVIDER_SIP_TRUNK, MEIO_TELEFONE } from "../capabilities";
import type { TroncoSip, TransporteSip } from "./pjsip";

export const PROVIDER = CHANNEL_PROVIDER_SIP_TRUNK;
/** O meio da conversa de telefone (`conversations.channel`) — definido em `capabilities.ts`. */
export { MEIO_TELEFONE };

export interface TroncoDoBanco extends TroncoSip {
  organizationId: string;
  /** O número, em E.164 — o que a operadora mostra na bina de quem recebe. */
  numero: string | null;
  nome: string | null;
  teamId: string | null;
}

interface LinhaDoTronco {
  id: string;
  organization_id: string;
  phone_number: string | null;
  display_name: string | null;
  sip_server: string;
  sip_port: number | null;
  sip_transport: string | null;
  sip_username: string;
  senha: string | null;
  sip_team_id: string | null;
}

function paraTronco(r: LinhaDoTronco): TroncoDoBanco | null {
  // Senha que não decifra (chave trocada, linha corrompida) não vira tronco:
  // registrar com senha vazia só gera "Rejected" e esconde a causa.
  if (!r.senha) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    numero: r.phone_number,
    nome: r.display_name,
    servidor: r.sip_server,
    porta: r.sip_port ?? 5060,
    transporte: (r.sip_transport === "tcp" ? "tcp" : "udp") as TransporteSip,
    usuario: r.sip_username,
    senha: r.senha,
    teamId: r.sip_team_id,
  };
}

const SELECT_TRONCO = `
  select id, organization_id, phone_number, display_name, sip_server, sip_port,
         sip_transport, sip_username, sip_team_id,
         case when sip_password_encrypted is null then null
              else public.fn_decrypt_oauth(sip_password_encrypted) end as senha
    from channel_sessions
   where provider = $1 and archived_at is null`;

/** Todos os troncos ativos da instalação — o conjunto que o Asterisk deve ter. */
export async function troncosAtivos(db: Queryable): Promise<{ troncos: TroncoDoBanco[]; ilegiveis: string[] }> {
  const { rows } = await db.query<LinhaDoTronco>(SELECT_TRONCO, [PROVIDER]);
  const troncos: TroncoDoBanco[] = [];
  const ilegiveis: string[] = [];
  for (const r of rows) {
    const t = paraTronco(r);
    if (t) troncos.push(t);
    else ilegiveis.push(r.id);
  }
  return { troncos, ilegiveis };
}

export async function troncoPorId(db: Queryable, id: string): Promise<TroncoDoBanco | null> {
  const { rows } = await db.query<LinhaDoTronco>(`${SELECT_TRONCO} and id = $2`, [PROVIDER, id]);
  return rows[0] ? paraTronco(rows[0]) : null;
}

/** Espelha o estado do registro na linha do canal — o que a tela de Conexões mostra. */
export async function gravarEstadoDoTronco(
  db: Queryable,
  id: string,
  status: "STARTING" | "WORKING" | "FAILED" | "STOPPED",
  motivo: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update channel_sessions
        set status = $3, status_reason = $4, updated_at = now()
      where id = $1 and provider = $2
        and (status is distinct from $3 or status_reason is distinct from $4)`,
    [id, PROVIDER, status, motivo],
  );
  return (rowCount ?? 0) > 0;
}

async function fusoDaOrg(db: Queryable, organizationId: string): Promise<string> {
  const { rows } = await db.query<{ timezone: string | null }>(
    "select timezone from organizations where id = $1",
    [organizationId],
  );
  const tz = rows[0]?.timezone?.trim() ?? "";
  return tz && fusoValido(tz) ? tz : FUSO_PADRAO;
}

/**
 * Quem do time pode receber uma ligação AGORA, com a contagem do dia.
 *
 * A contagem é de ligações RECEBIDAS e atendidas: quem liga muito para fora
 * não pode passar a receber menos por isso — a regra do dono é sobre dividir o
 * que CHEGA.
 *
 * As mesmas peças do roteamento de conversa (`lib/routing/eligibles.ts`) —
 * membro ativo com papel de atendimento, disponível (pausa e heartbeat vencido
 * zeram `is_available`), dentro do horário do time e do próprio — MENOS o teto
 * de conversas: decisão do dono (spec 20 §2.6), conversa de texto aberta não
 * impede atender o telefone. E MAIS "não está em outra ligação", de qualquer
 * canal de voz: quem está falando no WhatsApp também está ocupado.
 */
export async function disponiveisNoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<CandidatoAoToque[]> {
  const { rows: times } = await db.query<{ schedule: unknown; archived_at: string | null }>(
    "select schedule, archived_at from attendance_teams where id = $1 and organization_id = $2",
    [teamId, organizationId],
  );
  const time = times[0];
  if (!time || time.archived_at) return [];
  const { agenda: agendaDoTime, valida } = lerAgenda(time.schedule);
  if (!valida || !isWithinSchedule(agendaDoTime, agora)) return [];

  const fuso = await fusoDaOrg(db, organizationId);
  const { rows } = await db.query<{
    user_id: string;
    schedule: unknown;
    atendidas_hoje: string;
    ultima_atendida: string | null;
  }>(
    `select m.user_id, a.schedule,
            (select count(*) from voice_calls v
              where v.organization_id = $1 and v.owner_user_id = m.user_id and v.direction = 'inbound'
                and v.answered_at >= (date_trunc('day', now() at time zone $3) at time zone $3)) as atendidas_hoje,
            (select max(v.answered_at) from voice_calls v
              where v.organization_id = $1 and v.owner_user_id = m.user_id
                and v.direction = 'inbound') as ultima_atendida
       from attendance_team_members m
       join user_organizations uo
         on uo.user_id = m.user_id and uo.organization_id = $1
        and uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin')
       join attendant_availability a
         on a.user_id = m.user_id and a.organization_id = $1 and a.is_available = true
      where m.organization_id = $1 and m.team_id = $2
        and not exists (
          select 1 from voice_calls v
           where v.organization_id = $1 and v.status <> 'ended'
             and (v.owner_user_id = m.user_id or v.ringing_user_id = m.user_id)
             and v.started_at > now() - interval '4 hours'
        )`,
    [organizationId, teamId, fuso],
  );

  return rows
    .filter((r) => {
      const { agenda, valida: ok } = lerAgenda(r.schedule);
      return ok && isWithinSchedule(agenda, agora);
    })
    .map((r) => ({
      userId: r.user_id,
      atendidasHoje: Number(r.atendidas_hoje),
      ultimaAtendidaEm: r.ultima_atendida ? new Date(r.ultima_atendida) : null,
    }));
}

/** Contato pelo número (as duas grafias do nono dígito); cria se não existe. */
export async function acharOuCriarContato(
  db: Queryable,
  organizationId: string,
  e164: string,
  nome: string | null,
): Promise<string> {
  const variantes = phoneLookupVariants(e164);
  const achado = await db.query<{ id: string }>(
    `select id from contacts
      where organization_id = $1 and phone_number = any($2::text[]) and is_merged_into is null
      order by created_at asc limit 1`,
    [organizationId, variantes],
  );
  if (achado.rows[0]) return achado.rows[0].id;

  const nomeLimpo = (nome ?? "").trim().slice(0, 120) || e164;
  // `on conflict do nothing` + releitura: duas ligações simultâneas do mesmo
  // número desconhecido não criam dois contatos (índice único por telefone).
  const criado = await db.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number, source, source_metadata)
     values ($1, $2, $3, 'phone_call', '{}'::jsonb)
     on conflict do nothing
     returning id`,
    [organizationId, nomeLimpo, variantes.reduce((a, b) => (b.length > a.length ? b : a), e164)],
  );
  if (criado.rows[0]) return criado.rows[0].id;
  const relido = await db.query<{ id: string }>(
    `select id from contacts
      where organization_id = $1 and phone_number = any($2::text[]) and is_merged_into is null
      order by created_at asc limit 1`,
    [organizationId, variantes],
  );
  if (!relido.rows[0]) throw new Error("telefonia_contato_nao_criado");
  return relido.rows[0].id;
}

/** A conversa de telefone do contato NESTE número — uma só, reaberta a cada ligação. */
export async function acharOuCriarConversa(
  db: Queryable,
  organizationId: string,
  contactId: string,
  troncoId: string,
  teamId: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into conversations
       (organization_id, contact_id, channel_session_id, channel, status, is_group,
        unread_count_for_assignee, team_id)
     values ($1, $2, $3, $4, 'open', false, 0, $5)
     on conflict (organization_id, contact_id, channel_session_id) where is_group = false do nothing
     returning id`,
    [organizationId, contactId, troncoId, MEIO_TELEFONE, teamId],
  );
  if (rows[0]) return rows[0].id;
  const existente = await db.query<{ id: string }>(
    `select id from conversations
      where organization_id = $1 and contact_id = $2 and channel_session_id = $3 and is_group = false
      order by created_at asc limit 1`,
    [organizationId, contactId, troncoId],
  );
  if (!existente.rows[0]) throw new Error("telefonia_conversa_nao_criada");
  return existente.rows[0].id;
}

export interface NovaLigacao {
  organizationId: string;
  troncoId: string;
  sipCallRef: string;
  direcao: "inbound" | "outbound";
  numeroDoOutroLado: string;
  contactId: string | null;
  conversationId: string | null;
  teamId: string | null;
  status: "starting" | "ringing";
}

export async function criarLigacao(db: Queryable, l: NovaLigacao): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into voice_calls
       (organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction,
        peer_phone, status, conversation_id, team_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (organization_id, sip_call_ref) where sip_call_ref is not null do update
       set updated_at = now()
     returning id`,
    [
      l.organizationId,
      l.troncoId,
      l.contactId,
      PROVIDER,
      l.sipCallRef,
      l.direcao,
      l.numeroDoOutroLado,
      l.status,
      l.conversationId,
      l.teamId,
    ],
  );
  return rows[0]!.id;
}

export interface LigacaoDoBanco {
  id: string;
  organization_id: string;
  channel_session_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  direction: "inbound" | "outbound";
  peer_phone: string;
  status: string;
  owner_user_id: string | null;
  created_by: string | null;
  team_id: string | null;
  started_at: string;
  answered_at: string | null;
  provider: string;
  sip_call_ref: string | null;
}

export async function ligacaoPorId(db: Queryable, id: string): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select id, organization_id, channel_session_id, contact_id, conversation_id, direction,
            peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
            provider, sip_call_ref
       from voice_calls where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Ligações de telefone que o banco acha que ainda estão vivas (para `recuperar()`). */
export async function ligacoesVivas(db: Queryable): Promise<LigacaoDoBanco[]> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select id, organization_id, channel_session_id, contact_id, conversation_id, direction,
            peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
            provider, sip_call_ref
       from voice_calls where provider = $1 and status <> 'ended'`,
    [PROVIDER],
  );
  return rows;
}

/** Tocando para alguém (ou para ninguém, com `null`). */
export async function marcarTocando(db: Queryable, id: string, userId: string | null): Promise<void> {
  await db.query(
    `update voice_calls set status = 'ringing', ringing_user_id = $2, updated_at = now()
      where id = $1 and status <> 'ended'`,
    [id, userId],
  );
}

export async function marcarAtendida(db: Queryable, id: string, userId: string): Promise<void> {
  await db.query(
    `update voice_calls
        set status = 'connected', answered_at = coalesce(answered_at, now()),
            owner_user_id = coalesce(owner_user_id, $2), ringing_user_id = null, updated_at = now()
      where id = $1 and status <> 'ended'`,
    [id, userId],
  );
}

/** Fecha a ligação. Idempotente: a segunda chamada não muda nada e devolve `null`. */
export async function encerrarLigacao(
  db: Queryable,
  id: string,
  motivo: string,
): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `update voice_calls
        set status = 'ended', ended_at = now(), end_reason = $2, ringing_user_id = null,
            duration_ms = case when answered_at is null then null
                               else (extract(epoch from (now() - answered_at)) * 1000)::int end,
            updated_at = now()
      where id = $1 and status <> 'ended'
      returning id, organization_id, channel_session_id, contact_id, conversation_id, direction,
                peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
                provider, sip_call_ref`,
    [id, motivo],
  );
  return rows[0] ?? null;
}

/** A conversa passa a ser de quem atendeu — o mesmo gesto de "assumir". */
export async function atribuirConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<void> {
  await db.query("select 1 from public.fn_conversation_assign($1, $2, $3, 'claim')", [
    organizationId,
    conversationId,
    userId,
  ]);
}

function duracaoLegivel(ms: number | null): string {
  if (!ms || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

export type DesfechoDaLigacao = "atendida" | "perdida" | "sem_resposta" | "recusada_pela_rede";

export function textoDoRegistro(p: {
  direcao: "inbound" | "outbound";
  desfecho: DesfechoDaLigacao;
  duracaoMs: number | null;
  quem: string | null;
}): string {
  const d = duracaoLegivel(p.duracaoMs);
  if (p.direcao === "inbound") {
    if (p.desfecho === "atendida") return `Ligação recebida${p.quem ? `, atendida por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
    return "Ligação recebida não atendida";
  }
  if (p.desfecho === "atendida") return `Ligação feita${p.quem ? ` por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
  if (p.desfecho === "recusada_pela_rede") return "Ligação feita · não completou";
  return "Ligação feita · sem resposta";
}

/**
 * O registro da ligação DENTRO da conversa — a linha que o atendente vê no chat.
 *
 * `type=system`, `sent_via=system`, `direction=outbound`, de propósito: uma
 * mensagem `inbound` emite `message.received`, que acorda o agente de IA e
 * religa o termômetro de espera — e uma ligação não é uma fala a responder por
 * texto. `external_id` com o id da ligação: o mesmo registro não entra duas
 * vezes (índice único por organização).
 */
export async function registrarNaConversa(
  db: Queryable,
  l: LigacaoDoBanco,
  desfecho: DesfechoDaLigacao,
  duracaoMs: number | null,
): Promise<void> {
  if (!l.conversation_id || !l.contact_id) return;
  let quem: string | null = null;
  if (l.owner_user_id) {
    const { rows } = await db.query<{ nome: string | null }>(
      "select coalesce(raw_user_meta_data->>'full_name', email) as nome from auth.users where id = $1",
      [l.owner_user_id],
    );
    quem = rows[0]?.nome ?? null;
  }
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem });
  // Sem `on conflict`: a trava única de `(organization_id, external_id)` é
  // DEFERRABLE, e o Postgres recusa trava deferível como árbitro ("ON CONFLICT
  // does not support deferrable unique constraints") — medido na prova pela
  // tela, onde isso derrubava o fim da ligação inteiro. Conferir antes e tratar
  // o 23505 do reenvio cobre o mesmo caso.
  const externalId = `ligacao:${l.id}`;
  const { rows: ja } = await db.query(
    "select 1 from messages where organization_id = $1 and external_id = $2 limit 1",
    [l.organization_id, externalId],
  );
  if (ja.length > 0) return;
  try {
    await db.query(
    `insert into messages
       (organization_id, conversation_id, contact_id, channel_session_id, external_id,
        direction, type, body, sent_via, status, metadata)
     values ($1, $2, $3, $4, $5, 'outbound', 'system', $6, 'system', 'sent', $7)`,
    [
      l.organization_id,
      l.conversation_id,
      l.contact_id,
      l.channel_session_id,
      externalId,
      texto,
      JSON.stringify({
        voice_call: {
          id: l.id,
          direcao: l.direction,
          desfecho,
          duracao_ms: duracaoMs,
          atendente_id: l.owner_user_id,
          atendente_nome: quem,
        },
      }),
    ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return;
    throw e;
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, l.organization_id, texto],
  );
}

/** Chamada recebida que ninguém atendeu: aviso na Central para alguém retornar. */
export async function avisarPerdida(db: Queryable, l: LigacaoDoBanco): Promise<void> {
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'voice_call_missed', 'warn', $2, $3, $4, $5)`,
    [
      l.organization_id,
      `Ligação perdida de ${l.peer_phone}`,
      "Ninguém atendeu. Ligue de volta pela conversa.",
      l.contact_id ? "contact" : null,
      l.contact_id,
    ],
  );
}

export async function registrarFim(
  db: pg.Pool,
  l: LigacaoDoBanco,
  desfecho: DesfechoDaLigacao,
  motivo: string,
): Promise<void> {
  // Registro, não comando: nasce 'done' (ver o mesmo evento em lib/wacalls/events-bridge.ts).
  await db.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, status, payload)
     values ($1, 'voice_call.ended', 'voice_call', $2, 'done', $3)`,
    [l.organization_id, l.id, JSON.stringify({ canal: "telefone", desfecho, motivo, direcao: l.direction })],
  );
  if (!l.contact_id) return;
  const recebida = l.direction === "inbound";
  await emitAgentActivityForContact({
    pool: db,
    organizationId: l.organization_id,
    contactId: l.contact_id,
    type: desfecho === "atendida" ? "voice_call" : recebida ? "voice_call_missed" : "voice_call_unanswered",
    reason:
      desfecho === "atendida"
        ? recebida
          ? "Ligação telefônica recebida"
          : "Ligação telefônica feita"
        : recebida
          ? "Ligação telefônica perdida"
          : "Ligação telefônica sem resposta",
    sourceModule: "voice_calls",
    sourceId: l.id,
    usuarioId: l.owner_user_id,
    payload: { canal: "telefone", desfecho, motivo },
  });
}
