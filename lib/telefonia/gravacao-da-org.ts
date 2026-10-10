/**
 * A POLÍTICA DE GRAVAÇÃO DA ORGANIZAÇÃO (F3, migration 0289) — ler e salvar.
 * Server-only (as rotas da aba Gravação, `app/api/v1/telefonia/gravacao`).
 *
 * A regra que mora aqui, e não na tela: **a gravação só liga com o aviso de
 * gravação pronto** (a fala geral `recording_notice`). Gravar quem não foi
 * avisado é o risco LGPD que a feature não pode criar; a tela só espelha a
 * recusa. Desligar e mudar a retenção nunca dependem do aviso.
 *
 * A mesma linha guarda a política da TRANSCRIÇÃO (F4, migration 0298): ligar
 * exige uma chave do transcritor, e marca o instante a partir do qual as
 * ligações passam a ser transcritas (ver `salvarPoliticaDaOrg`).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { falaPorId, falaPublica } from "./falas";
import { RETENCAO_PADRAO_DIAS } from "./gravacao";
import type { FalaPublica } from "./vocabulario";

export interface PoliticaDaOrg {
  ativa: boolean;
  retencaoDias: number;
  /** Transcrever e resumir as ligações gravadas (F4, migration 0298). */
  transcrever: boolean;
  /** O aviso de gravação configurado (pronto ou não) — a tela mostra o estado dele. */
  aviso: FalaPublica | null;
}

export async function lerPoliticaDaOrg(db: Queryable, organizationId: string): Promise<PoliticaDaOrg> {
  const { rows } = await db.query<{
    recording_enabled: boolean;
    recording_retention_days: number;
    recording_notice_prompt_id: string | null;
    transcription_enabled: boolean;
  }>(
    `select recording_enabled, recording_retention_days, recording_notice_prompt_id, transcription_enabled
       from phone_settings where organization_id = $1`,
    [organizationId],
  );
  const s = rows[0];
  const linha = s?.recording_notice_prompt_id ? await falaPorId(db, organizationId, s.recording_notice_prompt_id) : null;
  return {
    ativa: s?.recording_enabled === true,
    retencaoDias: s?.recording_retention_days ?? RETENCAO_PADRAO_DIAS,
    transcrever: s?.transcription_enabled === true,
    aviso: linha ? falaPublica(linha) : null,
  };
}

/** O que a auditoria guarda da política, antes e depois. */
export interface RetratoDaPolitica {
  ativa: boolean;
  retencaoDias: number;
  transcrever: boolean;
}

export type ResultadoDaPolitica =
  | { ok: true; mudou: boolean; antes: RetratoDaPolitica; depois: RetratoDaPolitica }
  | { ok: false; motivo: "sem_aviso" | "sem_chave_de_transcricao" };

/**
 * Salva. Ligar a GRAVAÇÃO exige o aviso PRONTO — conferido no mesmo comando que
 * grava (`where` com o `exists`), para não haver janela entre conferir e ligar.
 * A linha de `phone_settings` nasce aqui quando a organização ainda não tem uma.
 *
 * A TRANSCRIÇÃO (`transcrever`; ausente = fica como está):
 *  - LIGAR (de desligada para ligada) exige uma chave do transcritor — quem
 *    responde é `temChave`, que só é perguntado nessa transição. Desligar, ou
 *    salvar outra coisa com ela já ligada, nunca depende da chave: quem perdeu a
 *    chave tem de conseguir mudar a retenção;
 *  - ao ligar, `transcription_enabled_at` vira AGORA. É a régua do "só daqui para
 *    frente": o worker não transcreve ligação que terminou antes disso. Desligar
 *    e ligar de novo recomeça a contagem — o intervalo desligado não é transcrito.
 */
export async function salvarPoliticaDaOrg(
  db: Queryable,
  organizationId: string,
  pedido: { ativa: boolean; retencaoDias: number; transcrever?: boolean },
  temChave: () => Promise<boolean> = async () => true,
): Promise<ResultadoDaPolitica> {
  await db.query("insert into phone_settings (organization_id) values ($1) on conflict (organization_id) do nothing", [
    organizationId,
  ]);
  const { rows: antesRows } = await db.query<{
    recording_enabled: boolean;
    recording_retention_days: number;
    transcription_enabled: boolean;
  }>(
    "select recording_enabled, recording_retention_days, transcription_enabled from phone_settings where organization_id = $1",
    [organizationId],
  );
  const antes: RetratoDaPolitica = {
    ativa: antesRows[0]?.recording_enabled === true,
    retencaoDias: antesRows[0]?.recording_retention_days ?? RETENCAO_PADRAO_DIAS,
    transcrever: antesRows[0]?.transcription_enabled === true,
  };
  const transcrever = pedido.transcrever ?? antes.transcrever;
  if (transcrever && !antes.transcrever && !(await temChave())) return { ok: false, motivo: "sem_chave_de_transcricao" };

  const { rowCount } = await db.query(
    `update phone_settings s
        set recording_enabled = $2, recording_retention_days = $3,
            transcription_enabled = $4,
            transcription_enabled_at = case when $4 and not s.transcription_enabled then now()
                                            else s.transcription_enabled_at end,
            updated_at = now()
      where s.organization_id = $1
        and ($2 = false or exists (
              select 1 from phone_prompts p
               where p.id = s.recording_notice_prompt_id and p.organization_id = s.organization_id
                 and p.status = 'ready'))`,
    [organizationId, pedido.ativa, pedido.retencaoDias, transcrever],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, motivo: "sem_aviso" };
  const depois: RetratoDaPolitica = { ativa: pedido.ativa, retencaoDias: pedido.retencaoDias, transcrever };
  return {
    ok: true,
    mudou:
      antes.ativa !== depois.ativa || antes.retencaoDias !== depois.retencaoDias || antes.transcrever !== depois.transcrever,
    antes,
    depois,
  };
}
