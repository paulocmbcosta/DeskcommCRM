/**
 * A FILA DO TELEFONE LIDA DO BANCO (aba Telefone; migration 0295). Server-only.
 * A organização vem SEMPRE de quem chama (a sessão) e entra em TODA consulta —
 * a conexão é a do app, fora da RLS. Nada aqui fala com o Asterisk: a fila que
 * a tela mostra é a que o worker gravou em `voice_calls`.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { esperaMaximaMs } from "@/lib/telefonia/distribuicao";
import {
  faseDaLigacao,
  motivoDaPerdida,
  posicoesNaFila,
  type FilaDoTelefone,
  type LigacaoNaFila,
  type PerdidaRecente,
} from "@/lib/telefonia/fila";

import { PROVIDER } from "./repositorio";

/** Há quanto tempo, no máximo, uma ligação "viva" é levada a sério (a mesma régua do "ocupado" do distribuidor). */
const VIVA_HA_NO_MAXIMO = "4 hours";
/** A janela das perdidas recentes (D11 do desenho) e o teto de linhas dela. */
const PERDIDAS_DESDE = "30 minutes";
const MAXIMO_DE_PERDIDAS = 100;

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());
/**
 * O nome de alguém da equipe pela régua única do banco (`fn_nome_do_usuario`,
 * migration 0270): o nome cadastrado e, sem ele, o que vem antes do `@` do
 * e-mail — NUNCA o endereço inteiro. A fila de todos os times vai para todo
 * `viewer`, e o e-mail do colega não é dado de fila. A função é fechada a
 * `authenticated`; a conexão do app é a do dono do banco, a mesma que já chama
 * `fn_encrypt_oauth` em numeros.ts.
 */
const NOME_DE = (coluna: string) => `public.fn_nome_do_usuario(${coluna})`;

export async function lerFilaDoTelefone(db: Queryable, organizationId: string): Promise<FilaDoTelefone> {
  const numeros = await db.query<{ id: string; nome: string | null; numero: string | null }>(
    `select id, display_name as nome, phone_number as numero
       from channel_sessions
      where organization_id = $1 and provider = $2 and archived_at is null
      order by created_at asc`,
    [organizationId, PROVIDER],
  );
  const relogio = await db.query<{ agora: Date }>("select now() as agora");
  const agora = new Date(relogio.rows[0]!.agora).toISOString();
  if (numeros.rows.length === 0) return { ativa: false, agora, times: [], numeros: [], ligacoes: [], perdidas: [] };

  const times = await db.query<{ id: string; nome: string; espera: number | null }>(
    `select id, name as nome, phone_queue_max_wait_seconds as espera
       from attendance_teams
      where organization_id = $1 and archived_at is null
      order by name asc`,
    [organizationId],
  );

  const vivas = await db.query<{
    id: string; status: string; peer_phone: string; team_id: string | null; channel_session_id: string;
    conversation_id: string | null; contact_id: string | null; contato_nome: string | null;
    started_at: Date; queued_at: Date | null; queue_deadline_at: Date | null; answered_at: Date | null;
    menu_id: string | null; menu_outcome: string | null;
    ringing_user_id: string | null; tocando_nome: string | null;
    owner_user_id: string | null; dono_nome: string | null;
    transferencia_time_id: string | null; transferencia_desde: Date | null;
    transferida_por: string | null; transferida_por_nome: string | null;
  }>(
    `select v.id, v.status, v.peer_phone, v.team_id, v.channel_session_id, v.conversation_id, v.contact_id,
            coalesce(c.display_name, c.name) as contato_nome,
            v.started_at, v.queued_at, v.queue_deadline_at, v.answered_at, v.menu_id, v.menu_outcome,
            v.ringing_user_id, ${NOME_DE("v.ringing_user_id")} as tocando_nome,
            v.owner_user_id, ${NOME_DE("v.owner_user_id")} as dono_nome,
            tr.to_team_id as transferencia_time_id, tr.created_at as transferencia_desde,
            tr.from_user_id as transferida_por, ${NOME_DE("tr.from_user_id")} as transferida_por_nome
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
       left join voice_call_transfers tr
         on tr.organization_id = v.organization_id and tr.voice_call_id = v.id
        and tr.status = 'open' and tr.to_team_id is not null
      where v.organization_id = $1 and v.provider = $2 and v.direction = 'inbound' and v.status <> 'ended'
        and v.started_at > now() - interval '${VIVA_HA_NO_MAXIMO}'
      order by coalesce(v.queued_at, v.started_at) asc, v.id asc`,
    [organizationId, PROVIDER],
  );

  const ligacoes: LigacaoNaFila[] = vivas.rows.map((r) => {
    const fase = faseDaLigacao(r);
    const naTransferencia = fase === "transferencia_na_fila";
    return {
      id: r.id,
      fase,
      contato: r.contact_id ? { id: r.contact_id, nome: r.contato_nome } : null,
      numero: r.peer_phone,
      time_id: naTransferencia ? r.transferencia_time_id : r.team_id,
      numero_da_empresa_id: r.channel_session_id,
      conversa_id: r.conversation_id,
      entrou_em: iso(r.started_at)!,
      na_fila_desde: naTransferencia ? iso(r.transferencia_desde) : iso(r.queued_at),
      posicao: null,
      cai_em: fase === "aguardando" ? iso(r.queue_deadline_at) : null,
      tocando_para: fase === "tocando" && r.ringing_user_id ? { id: r.ringing_user_id, nome: r.tocando_nome } : null,
      com: naTransferencia
        ? r.transferida_por
          ? { id: r.transferida_por, nome: r.transferida_por_nome }
          : null
        : fase === "em_ligacao" && r.owner_user_id
          ? { id: r.owner_user_id, nome: r.dono_nome }
          : null,
      atendida_em: iso(r.answered_at),
    };
  });
  const posicoes = posicoesNaFila(ligacoes);
  for (const l of ligacoes) l.posicao = posicoes.get(l.id) ?? null;

  const perdidasQ = await db.query<{
    id: string; peer_phone: string; team_id: string | null; channel_session_id: string;
    conversation_id: string | null; contact_id: string | null; contato_nome: string | null;
    started_at: Date; queued_at: Date | null; ended_at: Date; end_reason: string | null;
    menu_id: string | null; menu_outcome: string | null;
  }>(
    `select v.id, v.peer_phone, v.team_id, v.channel_session_id, v.conversation_id, v.contact_id,
            coalesce(c.display_name, c.name) as contato_nome,
            v.started_at, v.queued_at, v.ended_at, v.end_reason, v.menu_id, v.menu_outcome
       from voice_calls v
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
      where v.organization_id = $1 and v.provider = $2 and v.direction = 'inbound'
        and v.answered_at is null and v.ended_at is not null
        and v.ended_at > now() - interval '${PERDIDAS_DESDE}'
      order by v.ended_at desc
      limit ${MAXIMO_DE_PERDIDAS}`,
    [organizationId, PROVIDER],
  );
  const perdidas: PerdidaRecente[] = perdidasQ.rows.map((r) => ({
    id: r.id,
    contato: r.contact_id ? { id: r.contact_id, nome: r.contato_nome } : null,
    numero: r.peer_phone,
    time_id: r.team_id,
    numero_da_empresa_id: r.channel_session_id,
    conversa_id: r.conversation_id,
    motivo: motivoDaPerdida(r),
    esperou_s: Math.max(
      0,
      Math.round((new Date(r.ended_at).getTime() - new Date(r.queued_at ?? r.started_at).getTime()) / 1000),
    ),
    encerrada_em: iso(r.ended_at)!,
  }));

  return {
    ativa: true,
    agora,
    times: times.rows.map((t) => ({ id: t.id, nome: t.nome, espera_maxima_s: esperaMaximaMs(t.espera) / 1000 })),
    numeros: numeros.rows,
    ligacoes,
    perdidas,
  };
}
