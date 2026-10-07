/**
 * OS PEDIDOS DA FILA DO TELEFONE, do lado da API (aba Telefone, entrega 3;
 * migration 0296): "atender" — puxar para o próprio ramal uma ligação que espera
 * — e "mover" — mandá-la para a fila de outro time. No molde do pedido de
 * transferência (`pedido-de-transferencia.ts`): confere tudo o que dá para
 * conferir sem o Asterisk e GRAVA a ordem `open` em `voice_call_queue_orders`;
 * quem emite a ordem para o worker é a rota, e quem age — e revalida contra o
 * estado em memória — é o worker. A organização vem SEMPRE da sessão, nunca do
 * corpo, e entra em TODA consulta: a conexão é a do app, fora da RLS.
 *
 * As regras:
 *  - só a ligação RECEBIDA do TELEFONE desta organização, viva, ainda não
 *    atendida e que já espera por uma pessoa (`queued_at`). No menu e nos avisos
 *    ninguém puxa nem move: quem não ouviu o aviso de gravação até o fim não é
 *    gravado. A de outra organização responde igual à que não existe;
 *  - atender: o ramal de quem pede está registrado, e a pessoa não está em
 *    outra ligação;
 *  - mover: o time é desta organização, não está arquivado, não é o time em que
 *    a ligação já está, e está dentro do horário;
 *  - uma ordem por vez: o índice único parcial do banco decide a corrida de dois
 *    cliques.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";

import { PROVIDER, pessoaEmLigacao, situacaoDaLinhaDoTime } from "./repositorio";

export type RecusaDaFila =
  | "ligacao_inexistente"
  | "ligacao_encerrada"
  | "ligacao_ja_atendida"
  | "ligacao_fora_da_fila"
  | "voce_offline"
  | "voce_em_ligacao"
  | "ja_ha_ordem"
  | "destino_invalido"
  | "ja_esta_nesse_time"
  | "time_fora_do_horario";

export const MENSAGEM_DA_RECUSA_DA_FILA: Record<RecusaDaFila, string> = {
  ligacao_inexistente: "Ligação não encontrada.",
  ligacao_encerrada: "Esta ligação já acabou.",
  ligacao_ja_atendida: "Esta ligação já foi atendida.",
  ligacao_fora_da_fila: "Esta ligação ainda está no menu. Espere ela entrar na fila.",
  voce_offline: "Seu telefone não está conectado. Recarregue a página e tente de novo.",
  voce_em_ligacao: "Você está em outra ligação.",
  ja_ha_ordem: "Outra pessoa já está cuidando desta ligação.",
  destino_invalido: "Esse time não é desta organização.",
  ja_esta_nesse_time: "A ligação já está na fila desse time.",
  time_fora_do_horario: "O time está fora do horário de atendimento.",
};

/** O status HTTP de cada recusa: não achou → 404; destino que não serve → 422; o resto é conflito com o estado de agora. */
export function statusDaRecusaDaFila(motivo: RecusaDaFila): number {
  if (motivo === "ligacao_inexistente") return 404;
  if (motivo === "destino_invalido") return 422;
  return 409;
}

/**
 * `por`: só em `ja_ha_ordem`, o nome de quem já está PUXANDO a ligação. Fica
 * `null` quando a ordem aberta é de mover (ninguém está atendendo, e a frase com
 * o nome mentiria) ou quando ela fechou entre a recusa e a leitura.
 */
export type RecusaDoPedidoDaFila = { ok: false; motivo: RecusaDaFila; por?: string | null };
export type ResultadoDoPedidoDaFila<T> = ({ ok: true } & T) | RecusaDoPedidoDaFila;

/**
 * A frase de uma recusa, no idioma de quem pediu (`t` é o `traduzir` da rota).
 * Sabendo QUEM já está puxando a ligação, a frase diz o nome — que entra
 * literal (`trocarMarcador`): ele é editável por qualquer usuário, e um `$&`
 * nele não pode virar outra coisa na tela.
 */
export function fraseDaRecusaDaFila(r: RecusaDoPedidoDaFila, t: (texto: string) => string): string {
  if (r.motivo === "ja_ha_ordem" && r.por) return trocarMarcador(t("{nome} já está atendendo esta ligação."), "{nome}", r.por);
  return t(MENSAGEM_DA_RECUSA_DA_FILA[r.motivo]);
}

/** A ordem como a tela de quem pediu a lê — o desfecho é escrito pelo worker. */
export interface OrdemDaFilaNaTela {
  id: string;
  kind: "pull" | "move";
  status: "open" | "ended";
  outcome: string | null;
  reason: string | null;
  requested_by: string | null;
  to_team_id: string | null;
}

/**
 * A ligação sobre a qual a fila deixa agir, ou por que não. A catraca entre as
 * organizações é o `organization_id` DESTA consulta; o `provider` deixa de fora a
 * linha do WaCalls, que o atendente escreve pela REST com o JWT dele.
 */
async function ligacaoQueEspera(
  db: Queryable,
  org: string,
  vcId: string,
): Promise<{ ok: true; teamId: string | null } | { ok: false; motivo: RecusaDaFila }> {
  const { rows } = await db.query<{
    status: string;
    direction: string;
    queued_at: Date | string | null;
    answered_at: Date | string | null;
    team_id: string | null;
  }>(
    `select status, direction, queued_at, answered_at, team_id from voice_calls
      where id = $1 and organization_id = $2 and provider = $3`,
    [vcId, org, PROVIDER],
  );
  const l = rows[0];
  // Feita ou interna: não é ligação de fila, e a resposta é a mesma da que não existe.
  if (!l || l.direction !== "inbound") return { ok: false, motivo: "ligacao_inexistente" };
  if (l.status === "ended") return { ok: false, motivo: "ligacao_encerrada" };
  if (l.status === "connected" || l.answered_at !== null) return { ok: false, motivo: "ligacao_ja_atendida" };
  if (l.queued_at === null) return { ok: false, motivo: "ligacao_fora_da_fila" };
  return { ok: true, teamId: l.team_id };
}

/**
 * Quem já está PUXANDO esta ligação, pela régua de nome da fila
 * (`fn_nome_do_usuario`, a mesma de `fila-da-tela.ts`: o nome cadastrado ou o
 * começo do e-mail, NUNCA o endereço). Só a ordem de atender: na de mover
 * ninguém "está atendendo".
 */
async function quemJaPuxa(db: Queryable, org: string, vcId: string): Promise<string | null> {
  const { rows } = await db.query<{ nome: string | null }>(
    `select public.fn_nome_do_usuario(o.requested_by) as nome
       from voice_call_queue_orders o
      where o.organization_id = $1 and o.voice_call_id = $2 and o.status = 'open' and o.kind = 'pull'`,
    [org, vcId],
  );
  return rows[0]?.nome ?? null;
}

/** Grava a ordem `open`. A segunda na mesma ligação bate no índice único parcial (uma aberta por ligação). */
async function gravarOrdem(
  db: Queryable,
  o: {
    org: string;
    vcId: string;
    kind: "pull" | "move";
    userId: string;
    toUserId: string | null;
    toTeamId: string | null;
    fromTeamId: string | null;
  },
): Promise<{ ok: true; id: string } | RecusaDoPedidoDaFila> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into voice_call_queue_orders
         (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [o.org, o.vcId, o.kind, o.userId, o.toUserId, o.toTeamId, o.fromTeamId],
    );
    return { ok: true, id: rows[0]!.id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return { ok: false, motivo: "ja_ha_ordem", por: await quemJaPuxa(db, o.org, o.vcId) };
    }
    throw e;
  }
}

/** "Atender": quem pede puxa a ligação para o PRÓPRIO ramal — `to_user_id` é sempre quem pediu. */
export async function pedirAtender(
  db: Queryable,
  p: { org: string; userId: string; vcId: string; online: Set<string> },
): Promise<ResultadoDoPedidoDaFila<{ id: string; timeId: string | null }>> {
  const l = await ligacaoQueEspera(db, p.org, p.vcId);
  if (!l.ok) return l;
  if (!p.online.has(p.userId)) return { ok: false, motivo: "voce_offline" };
  if (await pessoaEmLigacao(db, p.org, p.userId)) return { ok: false, motivo: "voce_em_ligacao" };

  const r = await gravarOrdem(db, {
    org: p.org,
    vcId: p.vcId,
    kind: "pull",
    userId: p.userId,
    toUserId: p.userId,
    toTeamId: null,
    fromTeamId: l.teamId,
  });
  return r.ok ? { ok: true, id: r.id, timeId: l.teamId } : r;
}

/** "Mover": a ligação vai para a fila de outro time desta organização. */
export async function pedirMover(
  db: Queryable,
  p: { org: string; userId: string; vcId: string; teamId: string; agora: Date },
): Promise<ResultadoDoPedidoDaFila<{ id: string; deTimeId: string | null }>> {
  const l = await ligacaoQueEspera(db, p.org, p.vcId);
  if (!l.ok) return l;

  const { rows } = await db.query<{ id: string; schedule: unknown; archived_at: Date | string | null }>(
    `select id, schedule, archived_at from attendance_teams where id = $1 and organization_id = $2`,
    [p.teamId, p.org],
  );
  const time = rows[0];
  // De outra organização, inexistente ou arquivado: a mesma resposta, sem dizer qual.
  if (!time || time.archived_at) return { ok: false, motivo: "destino_invalido" };
  if (time.id === l.teamId) return { ok: false, motivo: "ja_esta_nesse_time" };
  if (situacaoDaLinhaDoTime(time, p.agora) !== "aberto") return { ok: false, motivo: "time_fora_do_horario" };

  const r = await gravarOrdem(db, {
    org: p.org,
    vcId: p.vcId,
    kind: "move",
    userId: p.userId,
    toUserId: null,
    toTeamId: time.id,
    fromTeamId: l.teamId,
  });
  return r.ok ? { ok: true, id: r.id, deTimeId: l.teamId } : r;
}

/** O worker não recebeu a ordem (a ARI não respondeu): a linha não pode ficar aberta travando a próxima. */
export async function recusarOrdemSemWorker(db: Queryable, org: string, id: string): Promise<void> {
  await db.query(
    `update voice_call_queue_orders
        set status = 'ended', outcome = 'refused', reason = 'telefonia_indisponivel', ended_at = now()
      where id = $1 and organization_id = $2 and status = 'open'`,
    [id, org],
  );
}

/**
 * A ordem para a TELA de quem pediu (`GET /telefonia/fila/ordens/[id]`), presa
 * à organização da sessão. Quem pode lê-la — quem pediu, ou gerente+ — é
 * decisão da rota. Não confundir com `lerOrdemDaFila` (`ordens-da-fila.ts`),
 * que lê o EVENTO da ARI.
 */
export async function lerOrdemParaATela(db: Queryable, org: string, id: string): Promise<OrdemDaFilaNaTela | null> {
  const { rows } = await db.query<OrdemDaFilaNaTela>(
    `select id, kind, status, outcome, reason, requested_by, to_team_id
       from voice_call_queue_orders
      where id = $1 and organization_id = $2`,
    [id, org],
  );
  return rows[0] ?? null;
}
