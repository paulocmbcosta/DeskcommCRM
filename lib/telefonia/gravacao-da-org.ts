/**
 * A POLÍTICA DE GRAVAÇÃO DA ORGANIZAÇÃO (F3, migration 0289) — ler e salvar.
 * Server-only (as rotas da aba Gravação, `app/api/v1/telefonia/gravacao`).
 *
 * A regra que mora aqui, e não na tela: **a gravação só liga com o aviso de
 * gravação pronto** (a fala geral `recording_notice`). Gravar quem não foi
 * avisado é o risco LGPD que a feature não pode criar; a tela só espelha a
 * recusa. Desligar e mudar a retenção nunca dependem do aviso.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { falaPorId, falaPublica } from "./falas";
import { RETENCAO_PADRAO_DIAS } from "./gravacao";
import type { FalaPublica } from "./vocabulario";

export interface PoliticaDaOrg {
  ativa: boolean;
  retencaoDias: number;
  /** O aviso de gravação configurado (pronto ou não) — a tela mostra o estado dele. */
  aviso: FalaPublica | null;
}

export async function lerPoliticaDaOrg(db: Queryable, organizationId: string): Promise<PoliticaDaOrg> {
  const { rows } = await db.query<{
    recording_enabled: boolean;
    recording_retention_days: number;
    recording_notice_prompt_id: string | null;
  }>(
    `select recording_enabled, recording_retention_days, recording_notice_prompt_id
       from phone_settings where organization_id = $1`,
    [organizationId],
  );
  const s = rows[0];
  const linha = s?.recording_notice_prompt_id ? await falaPorId(db, organizationId, s.recording_notice_prompt_id) : null;
  return {
    ativa: s?.recording_enabled === true,
    retencaoDias: s?.recording_retention_days ?? RETENCAO_PADRAO_DIAS,
    aviso: linha ? falaPublica(linha) : null,
  };
}

export type ResultadoDaPolitica =
  | { ok: true; mudou: boolean; antes: { ativa: boolean; retencaoDias: number }; depois: { ativa: boolean; retencaoDias: number } }
  | { ok: false; motivo: "sem_aviso" };

/**
 * Salva. Ligar exige o aviso PRONTO — conferido no mesmo comando que grava
 * (`where` com o `exists`), para não haver janela entre conferir e ligar. A linha
 * de `phone_settings` nasce aqui quando a organização ainda não tem uma.
 */
export async function salvarPoliticaDaOrg(
  db: Queryable,
  organizationId: string,
  pedido: { ativa: boolean; retencaoDias: number },
): Promise<ResultadoDaPolitica> {
  await db.query("insert into phone_settings (organization_id) values ($1) on conflict (organization_id) do nothing", [
    organizationId,
  ]);
  const { rows: antesRows } = await db.query<{ recording_enabled: boolean; recording_retention_days: number }>(
    "select recording_enabled, recording_retention_days from phone_settings where organization_id = $1",
    [organizationId],
  );
  const antes = {
    ativa: antesRows[0]?.recording_enabled === true,
    retencaoDias: antesRows[0]?.recording_retention_days ?? RETENCAO_PADRAO_DIAS,
  };
  const { rowCount } = await db.query(
    `update phone_settings s
        set recording_enabled = $2, recording_retention_days = $3, updated_at = now()
      where s.organization_id = $1
        and ($2 = false or exists (
              select 1 from phone_prompts p
               where p.id = s.recording_notice_prompt_id and p.organization_id = s.organization_id
                 and p.status = 'ready'))`,
    [organizationId, pedido.ativa, pedido.retencaoDias],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, motivo: "sem_aviso" };
  const depois = { ativa: pedido.ativa, retencaoDias: pedido.retencaoDias };
  return {
    ok: true,
    mudou: antes.ativa !== depois.ativa || antes.retencaoDias !== depois.retencaoDias,
    antes,
    depois,
  };
}
