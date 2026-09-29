/**
 * O BANCO DA GRAVAÇÃO DAS LIGAÇÕES (F3; migration 0289) — o que o worker lê e
 * escreve para gravar, guardar e dar como perdida a gravação de uma ligação.
 *
 * Fonte da verdade: `voice_calls.recording_status`. Projeção para a tela:
 * `messages.metadata.voice_call.gravacao` (lida por `gravacaoDaLigacao`,
 * lib/telefonia/gravacao.ts), escrita AQUI e sempre por `jsonb_set` no banco —
 * nunca sobrescrevendo o metadado inteiro, que carrega o resto do cartão.
 *
 * Toda escrita é presa à organização da ligação e a `provider = 'sip_trunk'`. As
 * leituras que varrem a instalação inteira (`gravacoesPendentes`,
 * `estadosDasGravacoes`) são do worker, que serve todas as organizações — como
 * `ligacoesVivas` — e cada efeito depois é gravado na organização da PRÓPRIA linha.
 */
import type pg from "pg";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { MIME_DA_GRAVACAO, type EstadoDaGravacao, type GravacaoDaLigacao } from "@/lib/telefonia/gravacao";

import type { FalaDoBanco } from "./repositorio";

/** A política da organização, lida na entrada de cada ligação. */
export interface PoliticaDeGravacao {
  /** A organização ligou a gravação. */
  gravar: boolean;
  /** O aviso de gravação PRONTO para tocar; `null` = sem aviso, e então não se grava. */
  aviso: FalaDoBanco | null;
}

const SEM_GRAVACAO: PoliticaDeGravacao = Object.freeze({ gravar: false, aviso: null });

export async function politicaDeGravacao(db: Queryable, organizationId: string): Promise<PoliticaDeGravacao> {
  const { rows } = await db.query<{
    recording_enabled: boolean;
    aviso_id: string | null;
    aviso_caminho: string | null;
    aviso_duracao: number | null;
  }>(
    `select s.recording_enabled,
            p.id as aviso_id, p.storage_path as aviso_caminho, p.duration_ms as aviso_duracao
       from phone_settings s
       left join phone_prompts p
         on p.id = s.recording_notice_prompt_id and p.organization_id = s.organization_id and p.status = 'ready'
      where s.organization_id = $1`,
    [organizationId],
  );
  const r = rows[0];
  if (!r) return SEM_GRAVACAO;
  const aviso =
    r.aviso_id && r.aviso_caminho && r.aviso_duracao && r.aviso_duracao > 0
      ? { id: r.aviso_id, storagePath: r.aviso_caminho, duracaoMs: r.aviso_duracao }
      : null;
  return { gravar: r.recording_enabled === true, aviso };
}

/**
 * A gravação começou: `recording` e o momento do aviso. Só a ligação do
 * telefone desta organização, e só se ainda não estava gravando.
 */
export async function marcarGravando(
  db: Queryable,
  organizationId: string,
  vcId: string,
  avisoEm: Date | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update voice_calls
        set recording_status = 'recording', recording_notice_at = coalesce(recording_notice_at, $3), updated_at = now()
      where id = $1 and organization_id = $2 and provider = 'sip_trunk' and recording_status is null`,
    [vcId, organizationId, avisoEm],
  );
  return (rowCount ?? 0) > 0;
}

/** Uma gravação que ainda não foi guardada, de uma ligação que já acabou. */
export interface GravacaoPendente {
  vcId: string;
  organizationId: string;
  fimEm: Date;
}

/** As pendentes da instalação, as mais velhas primeiro (índice parcial `voice_calls_gravacao_pendente`). */
export async function gravacoesPendentes(db: Queryable, limite: number): Promise<GravacaoPendente[]> {
  const { rows } = await db.query<{ id: string; organization_id: string; ended_at: Date }>(
    `select id, organization_id, ended_at
       from voice_calls
      where recording_status = 'recording' and provider = 'sip_trunk' and status = 'ended' and ended_at is not null
      order by ended_at
      limit $1`,
    [limite],
  );
  return rows.map((r) => ({ vcId: r.id, organizationId: r.organization_id, fimEm: new Date(r.ended_at) }));
}

/** A mensagem da ligação na conversa (`external_id = ligacao:<id>`), se já foi registrada. */
export async function mensagemDaLigacao(
  db: Queryable,
  organizationId: string,
  vcId: string,
): Promise<{ id: string; conversationId: string } | null> {
  const { rows } = await db.query<{ id: string; conversation_id: string }>(
    "select id, conversation_id from messages where organization_id = $1 and external_id = $2 limit 1",
    [organizationId, `ligacao:${vcId}`],
  );
  const r = rows[0];
  return r ? { id: r.id, conversationId: r.conversation_id } : null;
}

const projecao = (g: GravacaoDaLigacao) => JSON.stringify(g);

/**
 * O arquivo está no Storage: a mensagem da ligação passa a apontá-lo e a
 * projeção diz "pronta"; a ligação vira `stored`. UM comando (CTEs que
 * modificam dados rodam na mesma transação): nunca uma sem a outra.
 *
 * `"anonimizada"` = a mensagem não tem mais o `voice_call` no metadado (a
 * cascata de anonimização o limpou no meio do caminho) ou sumiu: nada foi
 * escrito, e quem chamou apaga o arquivo recém-subido.
 */
export async function anexarGravacao(
  db: Queryable,
  p: {
    organizationId: string;
    vcId: string;
    mensagemId: string;
    caminho: string;
    bytes: number;
    duracaoMs: number;
  },
): Promise<"anexada" | "anonimizada"> {
  const { rows } = await db.query<{ mensagens: string }>(
    `with m as (
       update messages
          set media_storage_path = $4, media_mime = $5, media_size_bytes = $6,
              metadata = jsonb_set(metadata, '{voice_call,gravacao}', $7::jsonb, true)
        where id = $3 and organization_id = $1 and metadata ? 'voice_call'
        returning id
     ), v as (
       update voice_calls set recording_status = 'stored', updated_at = now()
        where id = $2 and organization_id = $1 and recording_status = 'recording' and exists (select 1 from m)
        returning id
     )
     select (select count(*) from m) as mensagens`,
    [
      p.organizationId,
      p.vcId,
      p.mensagemId,
      p.caminho,
      MIME_DA_GRAVACAO,
      p.bytes,
      projecao({ situacao: "pronta", duracao_ms: p.duracaoMs > 0 ? p.duracaoMs : null }),
    ],
  );
  return Number(rows[0]?.mensagens ?? 0) > 0 ? "anexada" : "anonimizada";
}

/**
 * A gravação se perdeu: `failed`, a projeção "falhou" e UM aviso na Central
 * (dedup `kind_e_titulo`: enquanto o anterior estiver aberto, uma falha a mais
 * não abre outro — num serviço fora do ar, seriam dezenas). Só quem estava
 * `recording` transita; devolve se transitou.
 */
export async function falharGravacao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  vcId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ transitou: boolean }>(
    `with v as (
       update voice_calls set recording_status = 'failed', updated_at = now()
        where id = $2 and organization_id = $1 and recording_status = 'recording'
        returning id
     ), m as (
       update messages
          set metadata = jsonb_set(metadata, '{voice_call,gravacao}', $3::jsonb, true)
        where organization_id = $1 and external_id = 'ligacao:' || $2 and metadata ? 'voice_call'
          and exists (select 1 from v)
        returning id
     )
     select exists (select 1 from v) as transitou`,
    [organizationId, vcId, projecao({ situacao: "falhou", duracao_ms: null })],
  );
  const transitou = rows[0]?.transitou === true;
  if (transitou) {
    await insertInboxItem(
      db,
      organizationId,
      {
        kind: "phone_recording_failed",
        severity: "warn",
        title: "A gravação de uma ligação não foi salva",
        body:
          "A ligação aconteceu normalmente, mas a gravação dela não chegou a ser guardada em 30 minutos. Confira se o serviço de telefonia está de pé; as próximas ligações seguem sendo gravadas.",
      },
      "kind_e_titulo",
    );
  }
  return transitou;
}

/** A gravação não tem mais onde morar (a mensagem foi anonimizada): `expired`, sem projeção. */
export async function descartarGravacao(db: Queryable, organizationId: string, vcId: string): Promise<void> {
  await db.query(
    `update voice_calls set recording_status = 'expired', updated_at = now()
      where id = $2 and organization_id = $1 and recording_status = 'recording'`,
    [organizationId, vcId],
  );
}

/** O estado da gravação de cada ligação pedida (as que não existem ficam de fora). */
export async function estadosDasGravacoes(
  db: Queryable,
  vcIds: string[],
): Promise<Map<string, EstadoDaGravacao | null>> {
  if (vcIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; recording_status: EstadoDaGravacao | null }>(
    "select id, recording_status from voice_calls where id = any($1::uuid[])",
    [vcIds],
  );
  return new Map(rows.map((r) => [r.id, r.recording_status]));
}
