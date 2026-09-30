/**
 * O PEDIDO DE LIGAÇÃO INTERNA, do lado da API (v3; desenho §12.4, D17, D23).
 *
 * Como o pedido de saída (`saida.ts`): não liga nada — cria a `voice_calls`
 * `internal` com dono e devolve o destino que o ramal do navegador disca,
 * `c-<id>`; o worker confere o pedido (dono, validade de 60 s) e toca o colega.
 * Sem número da empresa, sem contato, sem conversa.
 *
 * A régua de quem pode receber é a do diretório (D17): só o colega DISPONÍVEL
 * — a mesma da transferência. A organização vem da sessão.
 */
import { randomUUID } from "node:crypto";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { REGUA_DO_RAMAL } from "@/lib/telefonia/vocabulario";

import { lerDiretorio, type SituacaoDaPessoa } from "./diretorio";
import { PROVIDER, donoDoRamal } from "./repositorio";

/** A régua do ramal mora no vocabulário (client-safe): o discador da tela pergunta lá. */
export { REGUA_DO_RAMAL };

export type RecusaDaInterna =
  | "ramal_inexistente"
  | "ramal_e_seu"
  | "ja_em_ligacao"
  | `colega_${Exclude<SituacaoDaPessoa, "disponivel">}`;

export const MENSAGEM_DA_RECUSA_DA_INTERNA: Record<RecusaDaInterna, string> = {
  ramal_inexistente: "Esse ramal não existe nesta organização.",
  ramal_e_seu: "Esse é o seu ramal.",
  ja_em_ligacao: "Você já está em uma ligação.",
  colega_offline: "O colega está sem o telefone conectado.",
  colega_em_ligacao: "O colega está em outra ligação.",
  colega_em_pausa: "O colega está em pausa.",
  colega_fora_do_horario: "O colega está fora do horário dele.",
};

export async function criarPedidoInterno(
  db: Queryable,
  p: { organizationId: string; userId: string; ramal: string; agora: Date; online: Set<string> },
): Promise<{ ok: true; id: string; colega: string } | { ok: false; motivo: RecusaDaInterna }> {
  const colega = await donoDoRamal(db, p.organizationId, p.ramal);
  if (!colega) return { ok: false, motivo: "ramal_inexistente" };
  if (colega === p.userId) return { ok: false, motivo: "ramal_e_seu" };

  const diretorio = await lerDiretorio(db, p.organizationId, p.userId, p.agora, p.online);
  const eu = diretorio.pessoas.find((x) => x.user_id === p.userId);
  if (eu?.situacao === "em_ligacao") return { ok: false, motivo: "ja_em_ligacao" };
  const situacao = diretorio.pessoas.find((x) => x.user_id === colega)?.situacao ?? "offline";
  if (situacao !== "disponivel") return { ok: false, motivo: `colega_${situacao}` };

  const { rows } = await db.query<{ id: string }>(
    `insert into voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status,
        owner_user_id, created_by, peer_user_id)
     values ($1, null, $2, $3, 'internal', $4, 'starting', $5, $5, $6)
     returning id`,
    [p.organizationId, PROVIDER, `pedido-${randomUUID()}`, p.ramal, p.userId, colega],
  );
  return { ok: true, id: rows[0]!.id, colega };
}

/** O número do ramal da pessoa nesta organização — `null` se ela não tem. */
export async function meuRamal(db: Queryable, organizationId: string, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ numero: string }>(
    `select "number" as numero from phone_extensions where organization_id = $1 and user_id = $2`,
    [organizationId, userId],
  );
  return rows[0]?.numero ?? null;
}

export type FalhaDaTrocaDeRamal = "sem_ramal" | "ramal_em_uso";

/** O admin troca o número do ramal de alguém (D11/D22). Devolve o anterior. */
export async function trocarRamal(
  db: Queryable,
  p: { organizationId: string; userId: string; numero: string; por: string },
): Promise<{ ok: true; antes: string } | { ok: false; motivo: FalhaDaTrocaDeRamal }> {
  try {
    const { rows } = await db.query<{ antes: string }>(
      `with antes as (
         select "number" as antes from phone_extensions where organization_id = $1 and user_id = $2 for update
       )
       update phone_extensions e
          set "number" = $3, updated_by = $4, updated_at = now()
         from antes
        where e.organization_id = $1 and e.user_id = $2
       returning antes.antes`,
      [p.organizationId, p.userId, p.numero, p.por],
    );
    if (!rows[0]) return { ok: false, motivo: "sem_ramal" };
    return { ok: true, antes: rows[0].antes };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, motivo: "ramal_em_uso" };
    throw e;
  }
}
