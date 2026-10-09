/**
 * O BANCO DA TRANSCRIÇÃO DAS LIGAÇÕES (F4; migration 0298) — o que o worker lê e
 * escreve para pedir, fazer e dar como perdida a transcrição de uma ligação.
 *
 * Fonte da verdade: `voice_call_transcripts.status`. Projeção para a tela:
 * `messages.metadata.voice_call.transcricao` — só a SITUAÇÃO, nunca o texto
 * (lida por `transcricaoDaLigacao`, lib/telefonia/transcricao.ts), escrita AQUI e
 * sempre mesclando no banco (`jsonb_set` / `#-`), como a projeção da gravação.
 *
 * Toda escrita é presa à organização da ligação. As leituras que varrem a
 * instalação inteira (`pedirAsQueFaltam`, `reservarPendentes`) são do worker,
 * que serve todas as organizações — como `gravacoesPendentes` — e cada efeito
 * depois é gravado na organização da PRÓPRIA linha.
 *
 * "SÓ DAQUI PARA FRENTE" mora aqui, no SQL: um pedido só nasce para a ligação
 * que terminou DEPOIS de a organização ligar a transcrição
 * (`phone_settings.transcription_enabled_at`). A passada que repõe um pedido
 * perdido usa a mesma régua, e ainda olha só as últimas 48 h.
 */
import type pg from "pg";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDaGravacao } from "@/lib/telefonia/gravacao";
import type { SituacaoDaTranscricao, TrechoDaTranscricao } from "@/lib/telefonia/transcricao";

const projecao = (situacao: SituacaoDaTranscricao) => JSON.stringify({ situacao });

/**
 * As ligações que PODEM ter a transcrição pedida: do telefone, gravação
 * guardada, organização com a transcrição ligada, terminada depois de ligar, de
 * contato não anonimizado. Usada pelos dois pedidos — o de uma ligação e o da
 * passada — para que não possam discordar.
 */
const LIGACOES_TRANSCREVIVEIS = `
  select v.id, v.organization_id
    from voice_calls v
    join phone_settings s on s.organization_id = v.organization_id
   where v.provider = 'sip_trunk'
     and v.recording_status = 'stored'
     and v.ended_at is not null
     and s.transcription_enabled
     and s.transcription_enabled_at is not null
     and v.ended_at >= s.transcription_enabled_at
     and not exists (select 1 from contacts c
                      where c.id = v.contact_id and c.organization_id = v.organization_id and c.is_anonymized)
     and not exists (select 1 from voice_call_transcripts t where t.voice_call_id = v.id)`;

/** O pedido nasce `pending`, e o cartão passa a dizer "transcrevendo" no mesmo comando. */
const CRIAR_PEDIDOS = `
  , nova as (
    insert into voice_call_transcripts (voice_call_id, organization_id)
    select id, organization_id from alvo
    on conflict (voice_call_id) do nothing
    returning voice_call_id, organization_id
  ), m as (
    update messages m
       set metadata = jsonb_set(m.metadata, '{voice_call,transcricao}', $1::jsonb, true)
      from nova n
     where m.organization_id = n.organization_id
       and m.external_id = 'ligacao:' || n.voice_call_id::text
       and m.metadata ? 'voice_call'
    returning m.id
  )
  select (select count(*) from nova)::int as novas`;

/**
 * Pede a transcrição de UMA ligação cuja gravação acabou de ser guardada.
 * Devolve se o pedido nasceu agora (a organização não ligou, a ligação é
 * anterior, ou o pedido já existia → `false`).
 */
export async function pedirTranscricao(db: Queryable, organizationId: string, vcId: string): Promise<boolean> {
  const { rows } = await db.query<{ novas: number }>(
    `with alvo as (${LIGACOES_TRANSCREVIVEIS}
       and v.id = $3 and v.organization_id = $2
     ) ${CRIAR_PEDIDOS}`,
    [projecao("processando"), organizationId, vcId],
  );
  return (rows[0]?.novas ?? 0) > 0;
}

/** Só as ligações das últimas horas: a passada repõe pedido perdido, não varre o histórico. */
export const JANELA_DO_PEDIDO_PERDIDO_H = 48;

/**
 * A rede de segurança do pedido: gravação guardada sem pedido (o worker caiu
 * entre guardar e pedir, ou o pedido falhou). Devolve quantos nasceram.
 */
export async function pedirAsQueFaltam(db: Queryable, limite: number): Promise<number> {
  const { rows } = await db.query<{ novas: number }>(
    `with alvo as (${LIGACOES_TRANSCREVIVEIS}
       and v.ended_at >= now() - make_interval(hours => $2)
     order by v.ended_at
     limit $3
     ) ${CRIAR_PEDIDOS}`,
    [projecao("processando"), JANELA_DO_PEDIDO_PERDIDO_H, limite],
  );
  return rows[0]?.novas ?? 0;
}

/** Um pedido que este worker reservou para fazer agora. */
export interface TranscricaoPendente {
  vcId: string;
  organizationId: string;
  /** Qual tentativa é ESTA (1 = a primeira). Contada na reserva — ver `reservarPendentes`. */
  tentativas: number;
  pedidaEm: Date;
}

interface LinhaPendente {
  voice_call_id: string;
  organization_id: string;
  attempts: number;
  created_at: Date;
}

const pendente = (r: LinhaPendente): TranscricaoPendente => ({
  vcId: r.voice_call_id,
  organizationId: r.organization_id,
  tentativas: r.attempts,
  pedidaEm: new Date(r.created_at),
});

/**
 * Reserva as pendentes da vez, as mais antigas primeiro: empurra
 * `next_attempt_at` para a frente, de modo que outra passada (ou outro worker)
 * não pegue a mesma enquanto esta trabalha. Se este worker cair no meio, a
 * reserva vence e a ligação volta para a fila sozinha.
 *
 * A TENTATIVA É CONTADA AQUI, na reserva, e não quando a falha é registrada. Um
 * worker que morre no meio (falta de memória, contêiner reiniciado) não chega a
 * registrar falha nenhuma: se a conta fosse só na falha, a ligação que derruba o
 * worker voltaria para a fila para sempre, com zero tentativas — foi assim que
 * um PDF derrubou o worker em laço em 28/09/2026. Contando na reserva, cada vez
 * que alguém PEGA a ligação gasta uma tentativa, termine como terminar.
 */
export async function reservarPendentes(db: Queryable, limite: number, reservaS: number): Promise<TranscricaoPendente[]> {
  const { rows } = await db.query<LinhaPendente>(
    `update voice_call_transcripts t
        set next_attempt_at = now() + make_interval(secs => $2), attempts = t.attempts + 1
      where t.voice_call_id in (
              select voice_call_id from voice_call_transcripts
               where status = 'pending' and next_attempt_at <= now()
               order by next_attempt_at
               limit $1
               for update skip locked)
      returning t.voice_call_id, t.organization_id, t.attempts, t.created_at`,
    [limite, reservaS],
  );
  return rows.map(pendente).sort((a, b) => a.pedidaEm.getTime() - b.pedidaEm.getTime());
}

/** Reserva UMA pendente — a que acabou de ser pedida. `null` = já foi pega, ou não está na vez. */
export async function reservarUma(
  db: Queryable,
  organizationId: string,
  vcId: string,
  reservaS: number,
): Promise<TranscricaoPendente | null> {
  const { rows } = await db.query<LinhaPendente>(
    `update voice_call_transcripts
        set next_attempt_at = now() + make_interval(secs => $3), attempts = attempts + 1
      where voice_call_id = $2 and organization_id = $1 and status = 'pending' and next_attempt_at <= now()
      returning voice_call_id, organization_id, attempts, created_at`,
    [organizationId, vcId, reservaS],
  );
  return rows[0] ? pendente(rows[0]) : null;
}

/** O que o worker precisa saber da ligação para transcrevê-la. */
export interface ContextoDaTranscricao {
  sentido: "recebida" | "feita";
  /** O nome da organização — o modelo sabe quem é "o atendente" por ele. */
  empresa: string;
  idioma: Idioma;
  /** A organização segue com a transcrição ligada. */
  ligada: boolean;
  gravacao: EstadoDaGravacao | null;
  anonimizado: boolean;
  contactId: string | null;
  conversationId: string | null;
  /** A mensagem da ligação e o arquivo que ela aponta. */
  mensagemId: string | null;
  caminho: string | null;
}

export async function contextoDaTranscricao(
  db: Queryable,
  organizationId: string,
  vcId: string,
): Promise<ContextoDaTranscricao | null> {
  const { rows } = await db.query<{
    direction: string;
    recording_status: EstadoDaGravacao | null;
    contact_id: string | null;
    conversation_id: string | null;
    empresa: string | null;
    locale: string | null;
    ligada: boolean | null;
    anonimizado: boolean | null;
    mensagem_id: string | null;
    caminho: string | null;
  }>(
    `select v.direction, v.recording_status, v.contact_id, v.conversation_id,
            o.display_name as empresa, o.locale,
            s.transcription_enabled as ligada,
            c.is_anonymized as anonimizado,
            m.id as mensagem_id, m.media_storage_path as caminho
       from voice_calls v
       join organizations o on o.id = v.organization_id
       left join phone_settings s on s.organization_id = v.organization_id
       left join contacts c on c.id = v.contact_id and c.organization_id = v.organization_id
       left join messages m
         on m.organization_id = v.organization_id and m.external_id = 'ligacao:' || v.id::text
        and m.conversation_id = v.conversation_id and m.type = 'system'
      where v.id = $2 and v.organization_id = $1 and v.provider = 'sip_trunk'
      limit 1`,
    [organizationId, vcId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    sentido: r.direction === "inbound" ? "recebida" : "feita",
    empresa: (r.empresa ?? "").trim(),
    idioma: normalizarIdioma(r.locale),
    ligada: r.ligada === true,
    gravacao: r.recording_status,
    anonimizado: r.anonimizado === true,
    contactId: r.contact_id,
    conversationId: r.conversation_id,
    mensagemId: r.mensagem_id,
    caminho: r.caminho,
  };
}

/**
 * A transcrição terminou: a linha vira `ready` (ou `empty`, sem fala) e a
 * projeção do cartão acompanha.
 *
 * Numa TRANSAÇÃO com a MESMA trava da anonimização (`fn_service_lock(org,
 * contato)`, que os dois caminhos de anonimização tomam primeiro) — a mesma
 * disciplina de `anexarGravacao`: ou a anonimização vem depois e o trigger da
 * 0298 apaga a linha, ou veio antes e nada é escrito. Sem a trava, o texto de
 * uma ligação poderia ser gravado um instante DEPOIS de o contato ser
 * anonimizado, e ficaria.
 *
 * `"descartada"` = o contato está anonimizado, a gravação já não está guardada
 * (venceu, falhou) ou o pedido já não está `pending`: a linha é apagada (ou
 * deixada como está, se outro a concluiu) e nada do texto é escrito.
 */
export async function concluirTranscricao(
  pool: Pick<pg.Pool, "connect">,
  p: {
    organizationId: string;
    vcId: string;
    estado: "ready" | "empty";
    texto: string | null;
    trechos: TrechoDaTranscricao[];
    resumo: string | null;
    idioma: string | null;
    modelo: string;
    duracaoMs: number | null;
  },
): Promise<"gravada" | "descartada"> {
  const c = await pool.connect();
  let quebrada: Error | undefined;
  try {
    await c.query("begin");
    const { rows: ligacoes } = await c.query<{ contact_id: string | null; recording_status: string | null }>(
      `select contact_id, recording_status from voice_calls
        where id = $2 and organization_id = $1 and provider = 'sip_trunk'`,
      [p.organizationId, p.vcId],
    );
    const l = ligacoes[0];
    let pode = l !== undefined && l.recording_status === "stored";
    if (pode && l?.contact_id) {
      await c.query("select public.fn_service_lock($1, $2)", [p.organizationId, l.contact_id]);
      const { rows: contatos } = await c.query<{ is_anonymized: boolean | null }>(
        "select is_anonymized from contacts where id = $1 and organization_id = $2",
        [l.contact_id, p.organizationId],
      );
      pode = contatos[0] !== undefined && contatos[0].is_anonymized !== true;
    }
    if (!pode) {
      await c.query(
        `with t as (
           delete from voice_call_transcripts
            where voice_call_id = $2 and organization_id = $1 and status = 'pending'
           returning voice_call_id
         )
         update messages set metadata = metadata #- '{voice_call,transcricao}'
          where organization_id = $1 and external_id = 'ligacao:' || $2::text
            and metadata #> '{voice_call,transcricao}' is not null
            and exists (select 1 from t)`,
        [p.organizationId, p.vcId],
      );
      await c.query("commit");
      return "descartada";
    }
    const { rows } = await c.query<{ gravadas: number }>(
      `with t as (
         update voice_call_transcripts
            set status = $3, text = $4, segments = $5::jsonb, summary = $6, language = $7, model = $8,
                audio_duration_ms = $9, last_error = null, completed_at = now()
          where voice_call_id = $2 and organization_id = $1 and status = 'pending'
          returning voice_call_id
       ), m as (
         update messages set metadata = jsonb_set(metadata, '{voice_call,transcricao}', $10::jsonb, true)
          where organization_id = $1 and external_id = 'ligacao:' || $2::text and metadata ? 'voice_call'
            and exists (select 1 from t)
          returning id
       )
       select (select count(*) from t)::int as gravadas`,
      [
        p.organizationId,
        p.vcId,
        p.estado,
        p.texto,
        JSON.stringify(p.trechos),
        p.resumo,
        p.idioma,
        p.modelo,
        p.duracaoMs,
        projecao(p.estado === "ready" ? "pronta" : "sem_fala"),
      ],
    );
    await c.query("commit");
    return (rows[0]?.gravadas ?? 0) > 0 ? "gravada" : "descartada";
  } catch (e) {
    quebrada = e instanceof Error ? e : new Error(String(e));
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release(quebrada);
  }
}

/** A tentativa falhou e ainda há outra: marca a próxima (a tentativa já foi contada na reserva). */
export async function reagendarTranscricao(
  db: Queryable,
  organizationId: string,
  vcId: string,
  esperaS: number,
  erro: string,
): Promise<void> {
  await db.query(
    `update voice_call_transcripts
        set next_attempt_at = now() + make_interval(secs => $3), last_error = $4
      where voice_call_id = $2 and organization_id = $1 and status = 'pending'`,
    [organizationId, vcId, esperaS, erro.slice(0, 200)],
  );
}

/**
 * A transcrição não saiu: `failed`, a projeção "falhou" e UM aviso na Central
 * (dedup `kind_e_titulo`: enquanto o anterior estiver aberto, outra falha não
 * abre outro — com o provedor fora do ar, seriam dezenas). Só quem estava
 * `pending` transita; devolve se transitou.
 *
 * `aviso` nulo = falha que quem opera não tem como consertar (o arquivo da
 * gravação não confere): o cartão diz que não saiu, o log do worker diz por quê,
 * e a Central não ganha um aviso que mandaria a pessoa mexer na chave à toa.
 *
 * A linha FICA, `failed` — é o que impede a passada de pedir a mesma ligação de
 * novo a cada minuto.
 */
export async function falharTranscricao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  vcId: string,
  erro: string,
  aviso: { titulo: string; corpo: string } | null,
): Promise<boolean> {
  const { rows } = await db.query<{ transitou: boolean }>(
    `with t as (
       update voice_call_transcripts
          set status = 'failed', last_error = $3, completed_at = now()
        where voice_call_id = $2 and organization_id = $1 and status = 'pending'
        returning voice_call_id
     ), m as (
       update messages set metadata = jsonb_set(metadata, '{voice_call,transcricao}', $4::jsonb, true)
        where organization_id = $1 and external_id = 'ligacao:' || $2::text and metadata ? 'voice_call'
          and exists (select 1 from t)
        returning id
     )
     select exists (select 1 from t) as transitou`,
    [organizationId, vcId, erro.slice(0, 200), projecao("falhou")],
  );
  const transitou = rows[0]?.transitou === true;
  if (transitou && aviso) await avisarNaCentral(db, organizationId, aviso);
  return transitou;
}

/** Abre o aviso da transcrição na Central — um por título enquanto estiver aberto. */
export async function avisarNaCentral(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  aviso: { titulo: string; corpo: string },
): Promise<void> {
  await insertInboxItem(
    db,
    organizationId,
    { kind: "phone_transcription_failed", severity: "warn", title: aviso.titulo, body: aviso.corpo },
    "kind_e_titulo",
  );
}

/**
 * O pedido deixou de fazer sentido (a organização desligou a transcrição, o
 * contato foi anonimizado, a gravação venceu): a linha `pending` sai, e o cartão
 * para de dizer "transcrevendo". Transcrição já pronta não é desfeita por aqui.
 */
export async function descartarTranscricao(db: Queryable, organizationId: string, vcId: string): Promise<void> {
  await db.query(
    `with t as (
       delete from voice_call_transcripts
        where voice_call_id = $2 and organization_id = $1 and status = 'pending'
       returning voice_call_id
     )
     update messages set metadata = metadata #- '{voice_call,transcricao}'
      where organization_id = $1 and external_id = 'ligacao:' || $2::text
        and metadata #> '{voice_call,transcricao}' is not null
        and exists (select 1 from t)`,
    [organizationId, vcId],
  );
}

/**
 * A linha da chamada ao transcritor em `llm_calls` — é o que a faz aparecer em
 * IA › Execuções, com o custo. Best-effort: quem chama engole a falha (a
 * telemetria não derruba a transcrição que ela descreve). `custoCents` nulo =
 * preço desconhecido — nunca inventar zero.
 */
export async function registrarUsoDoTranscritor(
  db: Queryable,
  p: {
    organizationId: string;
    contactId: string | null;
    proposito: string;
    modelo: string;
    custoCents: number | null;
    latenciaMs: number;
    /** A classe do erro (`transcription_429`), sem texto da ligação. `null` = deu certo. */
    erro: string | null;
  },
): Promise<void> {
  const status = p.erro ? Number(/_(\d{3})$/.exec(p.erro)?.[1] ?? NaN) : NaN;
  // A mesma régua de códigos do resto de `llm_calls` (`codigoDeErroDaFalha`,
  // workers/classificador-comercial.ts): é por ela que a tela de Execuções
  // traduz a falha em português de gente.
  const codigo =
    status === 401 || status === 403
      ? "credencial_recusada"
      : status === 402 || status === 429
        ? "limite_ou_saldo"
        : status === 404
          ? "modelo_inexistente"
          : status >= 500 || !Number.isFinite(status)
            ? "provedor_indisponivel"
            : "erro_desconhecido";
  await db.query(
    `insert into llm_calls
       (organization_id, contact_id, purpose, provider, model,
        input_tokens, output_tokens, cost_cents, latency_ms,
        status, error_code, error_message, http_status)
     values ($1, $2, $3, 'openai', $4, 0, 0, $5, $6, $7, $8, $9, $10)`,
    [
      p.organizationId,
      p.contactId,
      p.proposito,
      p.modelo,
      p.erro ? null : p.custoCents,
      Math.round(p.latenciaMs),
      p.erro ? "erro" : "ok",
      p.erro ? codigo : null,
      p.erro ? p.erro.slice(0, 200) : null,
      Number.isFinite(status) ? status : null,
    ],
  );
}
