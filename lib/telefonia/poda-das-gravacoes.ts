/**
 * A PODA DAS GRAVAÇÕES VENCIDAS (F3, D5) — chamada pelo cron diário
 * `data-retention` (app/api/v1/cron/data-retention). Server-only.
 *
 * Vencida = `stored` há mais dias que a retenção da organização
 * (`phone_settings.recording_retention_days`; sem linha, o padrão de 90). Para
 * cada lote: remove os arquivos do Storage PRIMEIRO e só então marca — a
 * mensagem da ligação perde a mídia, a projeção do cartão vira "expirada" e a
 * ligação vira `expired`. Se o Storage falha, nada é marcado, e a rodada de
 * amanhã tenta de novo: marcar antes deixaria arquivo sem ponteiro, pagando
 * cota para sempre. Remover o que já não existe não é erro (idempotente).
 *
 * Mora no `data-retention` e não na passada do worker: a retenção é obrigação
 * (LGPD, e o Decreto 11.034 no mínimo), e tem de acontecer mesmo numa instalação
 * que desligou a telefonia depois de gravar.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { RETENCAO_PADRAO_DIAS } from "./gravacao";

export interface GravacaoVencida {
  vcId: string;
  organizationId: string;
  mensagemId: string | null;
  caminho: string | null;
}

export interface StorageDaPoda {
  /** Remove os objetos do bucket da gravação. Lança se o Storage falhar. */
  remover(caminhos: string[]): Promise<void>;
}

export interface ResultadoDaPodaDasGravacoes {
  /** Quantas gravações expiraram, por organização (a auditoria é por organização). */
  porOrganizacao: Map<string, number>;
  /** O último lote veio cheio e o teto foi atingido: sobrou para amanhã. */
  temResto: boolean;
  falhas: string[];
}

export const LOTE_DA_PODA = 50;
export const MAX_LOTES_DA_PODA = 20;

export async function gravacoesVencidas(db: Queryable, agora: Date, limite: number): Promise<GravacaoVencida[]> {
  const { rows } = await db.query<{
    id: string;
    organization_id: string;
    mensagem_id: string | null;
    caminho: string | null;
  }>(
    `select v.id, v.organization_id, m.id as mensagem_id, m.media_storage_path as caminho
       from voice_calls v
       left join phone_settings s on s.organization_id = v.organization_id
       left join messages m
         on m.organization_id = v.organization_id and m.external_id = 'ligacao:' || v.id::text
      where v.recording_status = 'stored'
        and v.ended_at < $1::timestamptz - make_interval(days => coalesce(s.recording_retention_days, $3))
      order by v.ended_at
      limit $2`,
    [agora.toISOString(), limite, RETENCAO_PADRAO_DIAS],
  );
  return rows.map((r) => ({
    vcId: r.id,
    organizationId: r.organization_id,
    mensagemId: r.mensagem_id,
    caminho: r.caminho,
  }));
}

/**
 * A gravação expirou: a mensagem perde a mídia (só se ainda apontava ESTE
 * arquivo), a projeção vira "expirada" (mesclada — a duração fica), e a ligação
 * vira `expired`. Um comando.
 */
export async function marcarExpirada(db: Queryable, g: GravacaoVencida): Promise<void> {
  await db.query(
    `with m as (
       update messages
          set media_storage_path = null, media_mime = null, media_size_bytes = null,
              metadata = case when metadata #> '{voice_call,gravacao}' is not null
                              then jsonb_set(metadata, '{voice_call,gravacao,situacao}', '"expirada"'::jsonb)
                              else metadata end
        where id = $3::uuid and organization_id = $2 and media_storage_path is not distinct from $4
        returning id
     )
     update voice_calls set recording_status = 'expired', updated_at = now()
      where id = $1 and organization_id = $2 and recording_status = 'stored'`,
    [g.vcId, g.organizationId, g.mensagemId, g.caminho],
  );
}

export async function podarGravacoesVencidas(d: {
  db: Queryable;
  storage: StorageDaPoda;
  agora: Date;
  lote?: number;
  maxLotes?: number;
}): Promise<ResultadoDaPodaDasGravacoes> {
  const lote = d.lote ?? LOTE_DA_PODA;
  const maxLotes = d.maxLotes ?? MAX_LOTES_DA_PODA;
  const porOrganizacao = new Map<string, number>();
  const falhas: string[] = [];
  for (let i = 0; i < maxLotes; i += 1) {
    const vencidas = await gravacoesVencidas(d.db, d.agora, lote);
    if (vencidas.length === 0) return { porOrganizacao, temResto: false, falhas };
    const caminhos = vencidas.map((v) => v.caminho).filter((c): c is string => Boolean(c));
    try {
      if (caminhos.length > 0) await d.storage.remover(caminhos);
    } catch (e) {
      // Sem apagar o arquivo, não se marca nada: amanhã tenta de novo.
      falhas.push(`gravacoes: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      return { porOrganizacao, temResto: true, falhas };
    }
    for (const v of vencidas) {
      await marcarExpirada(d.db, v);
      porOrganizacao.set(v.organizationId, (porOrganizacao.get(v.organizationId) ?? 0) + 1);
    }
    if (vencidas.length < lote) return { porOrganizacao, temResto: false, falhas };
  }
  return { porOrganizacao, temResto: true, falhas };
}
