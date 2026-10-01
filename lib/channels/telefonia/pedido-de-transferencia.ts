/**
 * O PEDIDO DE TRANSFERÊNCIA, do lado da API (desenho da fase 2, §12.4). Confere
 * tudo o que dá para conferir sem o Asterisk e grava a linha `open`; quem emite a
 * ordem para o worker (e quem revalida contra o estado em memória) são a rota e
 * o worker. A organização vem SEMPRE da sessão — nunca do corpo.
 *
 * As regras:
 *  - a ligação é do TELEFONE desta organização, está `connected` e não é interna (D16);
 *  - quem pede é o dono atual da ligação, ou gerente/admin;
 *  - a consultada é só para pessoa (D9);
 *  - a pessoa de destino tem papel de atendimento aqui, não é quem já está com a
 *    ligação e está DISPONÍVEL pela régua do diretório (D17);
 *  - o time de destino é desta organização, não está arquivado e está dentro do
 *    horário (fora do horário: recusado com motivo);
 *  - uma por vez: o índice único parcial do banco decide a corrida.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { roleAtLeast } from "@/lib/auth/types";

import { lerDiretorio, type SituacaoDaPessoa } from "./diretorio";
import { PROVIDER } from "./repositorio";

export type ModoDaTransferencia = "direta" | "consultada";
export type DestinoDaTransferencia = { user_id: string } | { team_id: string };

export type RecusaDoPedido =
  | "ligacao_inexistente"
  | "ligacao_nao_atendida"
  | "ligacao_interna"
  | "sem_permissao"
  | "consultada_so_para_pessoa"
  | "destino_invalido"
  | "destino_e_voce"
  | `destino_${Exclude<SituacaoDaPessoa, "disponivel">}`
  | "time_fora_do_horario"
  | "ja_ha_transferencia"
  | "sem_transferencia_aberta";

export const MENSAGEM_DA_RECUSA_DO_PEDIDO: Record<RecusaDoPedido, string> = {
  ligacao_inexistente: "Ligação não encontrada.",
  ligacao_nao_atendida: "Só dá para transferir uma ligação em andamento.",
  ligacao_interna: "Ligação interna não pode ser transferida.",
  sem_permissao: "Só quem está com a ligação, ou um gerente, pode transferi-la.",
  consultada_so_para_pessoa: "Falar antes só vale para uma pessoa, não para um time.",
  destino_invalido: "Esse destino não é desta organização.",
  destino_e_voce: "A ligação já está com essa pessoa.",
  destino_offline: "A pessoa está sem o telefone conectado.",
  destino_em_ligacao: "A pessoa está em outra ligação.",
  destino_em_pausa: "A pessoa está em pausa.",
  destino_fora_do_horario: "A pessoa está fora do horário dela.",
  time_fora_do_horario: "O time está fora do horário de atendimento.",
  ja_ha_transferencia: "Já há uma transferência acontecendo nesta ligação.",
  sem_transferencia_aberta: "Não há uma consulta em andamento nesta ligação.",
};

/** O status HTTP de cada recusa: não achou → 404; não pode → 403; o resto é conflito com o estado de agora. */
export function statusDaRecusa(motivo: RecusaDoPedido): number {
  if (motivo === "ligacao_inexistente") return 404;
  if (motivo === "sem_permissao") return 403;
  if (motivo === "consultada_so_para_pessoa" || motivo === "destino_invalido") return 422;
  return 409;
}

export type ResultadoDoPedido<T> = ({ ok: true } & T) | { ok: false; motivo: RecusaDoPedido };

interface LigacaoDoPedido {
  id: string;
  status: string;
  direction: string;
  owner_user_id: string | null;
}

async function lerLigacao(db: Queryable, org: string, vcId: string): Promise<LigacaoDoPedido | null> {
  const { rows } = await db.query<LigacaoDoPedido>(
    `select id, status, direction, owner_user_id from voice_calls
      where id = $1 and organization_id = $2 and provider = $3`,
    [vcId, org, PROVIDER],
  );
  return rows[0] ?? null;
}

export async function pedirTransferencia(
  db: Queryable,
  p: {
    org: string;
    userId: string;
    papel: string;
    vcId: string;
    modo: ModoDaTransferencia;
    para: DestinoDaTransferencia;
    agora: Date;
    online: Set<string>;
  },
): Promise<ResultadoDoPedido<{ id: string; kind: "blind" | "attended"; fromUserId: string }>> {
  const l = await lerLigacao(db, p.org, p.vcId);
  if (!l) return { ok: false, motivo: "ligacao_inexistente" };
  if (l.direction === "internal") return { ok: false, motivo: "ligacao_interna" };
  if (l.status !== "connected" || !l.owner_user_id) return { ok: false, motivo: "ligacao_nao_atendida" };
  if (l.owner_user_id !== p.userId && !roleAtLeast(p.papel, "manager")) return { ok: false, motivo: "sem_permissao" };
  if (p.modo === "consultada" && !("user_id" in p.para)) return { ok: false, motivo: "consultada_so_para_pessoa" };

  const diretorio = await lerDiretorio(db, p.org, p.userId, p.agora, p.online);
  if ("user_id" in p.para) {
    const alvo = p.para.user_id;
    const pessoa = diretorio.pessoas.find((x) => x.user_id === alvo);
    if (!pessoa) return { ok: false, motivo: "destino_invalido" };
    if (alvo === l.owner_user_id) return { ok: false, motivo: "destino_e_voce" };
    // A própria ligação deixa o dono "em ligação" — mas o dono não é o destino (acima).
    if (pessoa.situacao !== "disponivel") return { ok: false, motivo: `destino_${pessoa.situacao}` };
  } else {
    const alvo = p.para.team_id;
    const time = diretorio.times.find((t) => t.id === alvo);
    if (!time) return { ok: false, motivo: "destino_invalido" };
    if (time.situacao === "fora_do_horario") return { ok: false, motivo: "time_fora_do_horario" };
  }

  const kind = p.modo === "consultada" ? "attended" : "blind";
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into voice_call_transfers (organization_id, voice_call_id, requested_by, from_user_id, to_user_id, to_team_id, kind)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        p.org,
        p.vcId,
        p.userId,
        l.owner_user_id,
        "user_id" in p.para ? p.para.user_id : null,
        "team_id" in p.para ? p.para.team_id : null,
        kind,
      ],
    );
    return { ok: true, id: rows[0]!.id, kind, fromUserId: l.owner_user_id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, motivo: "ja_ha_transferencia" };
    throw e;
  }
}

/** A ordem de completar ou voltar: a consulta aberta desta ligação, pedida por quem transferiu (ou gerente+). */
export async function consultaAberta(
  db: Queryable,
  p: { org: string; userId: string; papel: string; vcId: string },
): Promise<ResultadoDoPedido<{ id: string }>> {
  const { rows } = await db.query<{ id: string; from_user_id: string | null }>(
    `select id, from_user_id from voice_call_transfers
      where organization_id = $1 and voice_call_id = $2 and status = 'open' and kind = 'attended'`,
    [p.org, p.vcId],
  );
  const t = rows[0];
  if (!t) return { ok: false, motivo: "sem_transferencia_aberta" };
  if (t.from_user_id !== p.userId && !roleAtLeast(p.papel, "manager")) return { ok: false, motivo: "sem_permissao" };
  return { ok: true, id: t.id };
}

/** O worker não recebeu a ordem (a ARI não respondeu): a linha não pode ficar aberta travando a próxima. */
export async function recusarPedidoSemWorker(db: Queryable, org: string, id: string): Promise<void> {
  await db.query(
    `update voice_call_transfers set status = 'ended', outcome = 'refused', reason = 'telefonia_indisponivel', ended_at = now()
      where id = $1 and organization_id = $2 and status = 'open'`,
    [id, org],
  );
}
