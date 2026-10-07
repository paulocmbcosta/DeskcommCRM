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

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";
import { isWithinSchedule } from "@/lib/routing/eligibility";
import { lerAgenda } from "@/lib/times/agenda";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { CandidatoAoToque } from "@/lib/telefonia/distribuicao";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { avisoVigente } from "@/lib/telefonia/vencimento-da-emergencia";
import type { EstadoDaGravacao, GravacaoDaLigacao } from "@/lib/telefonia/gravacao";
import {
  MOTIVO_FORA_DO_HORARIO,
  type DesfechoDaTransferencia,
  type DesfechoDoMenu,
  type MenuDaLigacao,
  type TransferenciaDaLigacao,
} from "@/lib/telefonia/vocabulario";

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
  /**
   * O que vai antes do DDD na ligação de saída (`sip_dial_prefix`, migration
   * 0287) — `null` = DDD + número. Lido cru: quem o cola no destino confere a
   * régua (`enderecoDeSaida`, em `pjsip.ts`).
   */
  prefixo: string | null;
  /**
   * O menu de voz que atende as ligações deste número (`sip_menu_id`, migration
   * 0288) — `null` = o número aponta para um time (ou para nada). Opcional no
   * tipo para o teste da fase 1 não precisar declará-lo.
   */
  menuId?: string | null;
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
  sip_dial_prefix?: string | null;
  sip_menu_id?: string | null;
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
    prefixo: r.sip_dial_prefix ?? null,
    menuId: r.sip_menu_id ?? null,
  };
}

const SELECT_TRONCO = `
  select id, organization_id, phone_number, display_name, sip_server, sip_port,
         sip_transport, sip_username, sip_team_id, sip_dial_prefix, sip_menu_id,
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

/**
 * Espelha o estado do registro na linha do canal — o que a tela de Conexões mostra.
 *
 * Sem filtro de `organization_id`, de propósito: quem chama é o laço dos troncos
 * (`sincronizacao.ts`), que varre a instalação inteira como `troncosAtivos`, e o
 * `id` sai SEMPRE dessa varredura (ou do mapa do que ela empurrou ao Asterisk) —
 * nunca de dado que chega de fora. Carregar a organização por esse caminho não
 * fecharia porta nenhuma; a linha continua presa ao `provider` do tronco.
 */
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
 * O time pode receber ligação agora? Separa "fora do horário" (toca a fala de
 * fora do horário e desliga — desenho da fase 2, §5.2) de "ninguém disponível"
 * (fila) — antes, as duas perguntas voltavam como a mesma lista vazia de
 * `disponiveisNoTime`, que segue devolvendo `[]` nos dois casos: os chamadores
 * da fase 1 não mudam. Quem pergunta na entrada da fila é `timeParaAFila`.
 *
 * - `indisponivel`: o time não existe NESTA organização, foi arquivado, ou a
 *   agenda dele é algo que o parser não lê. Agenda ilegível NÃO é "fora do
 *   horário": sem certeza do horário, a ligação segue a fila e vira "Ligar de
 *   volta" com aviso na Central (visível), em vez de ouvir que a empresa está
 *   fechada e desligar sem rastro — a mesma régua de `lerAgenda` ("fechado é
 *   visível").
 * - `fora_do_horario`: o time existe, está ativo e a agenda dele diz que não
 *   atende agora.
 * - `aberto`: dentro do horário (agenda sem janelas = 24/7). Se há alguém
 *   disponível é outra pergunta — `disponiveisNoTime`.
 */
export type SituacaoDoTime = "aberto" | "fora_do_horario" | "indisponivel";

/** A decisão pura, a partir da linha do time (`undefined` = não existe nesta organização). */
export function situacaoDaLinhaDoTime(
  time: { schedule: unknown; archived_at: string | Date | null } | undefined,
  agora: Date,
): SituacaoDoTime {
  if (!time || time.archived_at) return "indisponivel";
  const { agenda, valida } = lerAgenda(time.schedule);
  if (!valida) return "indisponivel";
  return isWithinSchedule(agenda, agora) ? "aberto" : "fora_do_horario";
}

/** A linha do time como a fila a lê: a agenda, se está arquivado e o aviso de instabilidade com a fala pronta. */
interface LinhaDoTimeNaFila {
  schedule: unknown;
  archived_at: string | Date | null;
  aviso_desde: Date | string | null;
  aviso_expira_em: Date | string | null;
  aviso_fala_id: string | null;
  aviso_fala_caminho: string | null;
  aviso_fala_duracao: number | null;
  espera_maxima_s: number | null;
}

/** UMA leitura da linha do time DESTA organização — `undefined` se ele não existe nela. */
async function lerTimeNaFila(db: Queryable, organizationId: string, teamId: string): Promise<LinhaDoTimeNaFila | undefined> {
  const { rows } = await db.query<LinhaDoTimeNaFila>(
    `select t.schedule, t.archived_at,
            t.phone_queue_max_wait_seconds as espera_maxima_s,
            t.phone_emergency_active_since as aviso_desde, t.phone_emergency_expires_at as aviso_expira_em,
            p.id as aviso_fala_id, p.storage_path as aviso_fala_caminho, p.duration_ms as aviso_fala_duracao
       from attendance_teams t
       left join phone_prompts p
         on p.id = t.phone_emergency_prompt_id and p.organization_id = t.organization_id and p.status = 'ready'
      where t.id = $1 and t.organization_id = $2`,
    [teamId, organizationId],
  );
  return rows[0];
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
 * canal de voz: quem está falando no WhatsApp também está ocupado — e quem está
 * do outro lado de uma ligação INTERNA (`peer_user_id`, v3), ou tocando numa
 * transferência (`ringing_user_id`, v2).
 */
export async function disponiveisNoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<CandidatoAoToque[]> {
  // Fora do horário, arquivado ou de outra organização: ninguém. QUAL dos três é
  // a pergunta de `timeParaAFila`; aqui a resposta segue a mesma lista vazia.
  // Relido a cada chamada, e não guardado da entrada na fila: o time pode fechar
  // no meio dos 2 minutos de espera.
  if (situacaoDaLinhaDoTime(await lerTimeNaFila(db, organizationId, teamId), agora) !== "aberto") return [];

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
             and (v.owner_user_id = m.user_id or v.ringing_user_id = m.user_id or v.peer_user_id = m.user_id)
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

// ─── URA e falas (fase 2, migration 0288) ─────────────────────────────────
//
// Nada aqui chama a ElevenLabs (D15): o worker só LÊ a fala já gravada e o
// caminho dela no Storage; levar o arquivo ao disco é da passada das falas.
// Toda consulta filtra `organization_id` — a do TRONCO, nunca de dado que o
// chamador controla. A única exceção é a passada dos avisos vencidos, que varre
// a instalação inteira de propósito (como `troncosAtivos` e `ligacoesVivas`) e
// grava cada efeito na organização da PRÓPRIA linha.

/** Uma fala PRONTA para tocar: o que o worker precisa para garantir o arquivo e vigiar o fim dela. */
export interface FalaDoBanco {
  id: string;
  storagePath: string;
  /**
   * A duração do áudio (`phone_prompts.duration_ms`, obrigatória na fala
   * `ready` pelo CHECK `phone_prompts_ready_check`). O controlador arma com ela
   * o relógio que segue a ligação se o `PlaybackFinished` se perder.
   */
  duracaoMs: number;
}

export interface FalasGerais {
  aguarde: FalaDoBanco | null;
  ninguem: FalaDoBanco | null;
  foraDoHorario: FalaDoBanco | null;
}

export interface MenuDoBanco {
  id: string;
  nome: string;
  defaultTeamId: string;
  /**
   * `false` = o time padrão foi ARQUIVADO depois de o menu ser montado. O menu
   * continua atendendo como antes (a ligação cai no time padrão, que não recebe
   * ninguém, e vira perdida com "Ligar de volta"); o sinal existe para o
   * controlador avisar na Central que o menu precisa de outro time padrão.
   */
  timePadraoAtivo: boolean;
  /** `null` = sem fala pronta: o controlador manda direto para o time padrão (desenho §4). */
  fala: FalaDoBanco | null;
  falaInvalida: FalaDoBanco | null;
  /**
   * Em ordem de tecla; só as de times NÃO arquivados. A tecla de um time
   * arquivado não volta, e por isso cai no caminho de "opção inválida" da URA
   * (`lib/telefonia/ura.ts`): toca a fala de tecla inválida e repete o menu.
   */
  opcoes: Array<{ digito: string; teamId: string }>;
  /** O cliente pode digitar o ramal de alguém (v3, `accepts_extension`). Opcional no tipo para os testes da v1. */
  aceitaRamal?: boolean;
}

const falaOuNada = (id: string | null, caminho: string | null, duracaoMs: number | null): FalaDoBanco | null =>
  id && caminho && duracaoMs && duracaoMs > 0 ? { id, storagePath: caminho, duracaoMs } : null;

/**
 * O menu DESTA organização, se não arquivado — só falas prontas, só opções de
 * times não arquivados, e o sinal do time padrão arquivado (`timePadraoAtivo`).
 */
export async function menuPorId(db: Queryable, organizationId: string, menuId: string): Promise<MenuDoBanco | null> {
  const { rows } = await db.query<{
    id: string;
    nome: string;
    default_team_id: string;
    time_padrao_ativo: boolean;
    fala_id: string | null;
    fala_caminho: string | null;
    fala_duracao: number | null;
    invalida_id: string | null;
    invalida_caminho: string | null;
    invalida_duracao: number | null;
    opcoes: Array<{ digito: string; teamId: string }>;
    accepts_extension: boolean;
  }>(
    `select m.id, m.name as nome, m.default_team_id, m.accepts_extension,
            (d.id is not null and d.archived_at is null) as time_padrao_ativo,
            p.id as fala_id, p.storage_path as fala_caminho, p.duration_ms as fala_duracao,
            i.id as invalida_id, i.storage_path as invalida_caminho, i.duration_ms as invalida_duracao,
            coalesce((
              select jsonb_agg(jsonb_build_object('digito', o.digit, 'teamId', o.team_id) order by o.digit)
                from phone_menu_options o
                join attendance_teams t
                  on t.id = o.team_id and t.organization_id = o.organization_id and t.archived_at is null
               where o.menu_id = m.id and o.organization_id = m.organization_id
            ), '[]'::jsonb) as opcoes
       from phone_menus m
       left join attendance_teams d
         on d.id = m.default_team_id and d.organization_id = m.organization_id
       left join phone_prompts p
         on p.id = m.prompt_id and p.organization_id = m.organization_id and p.status = 'ready'
       left join phone_prompts i
         on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id and i.status = 'ready'
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [menuId, organizationId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    nome: r.nome,
    defaultTeamId: r.default_team_id,
    timePadraoAtivo: r.time_padrao_ativo,
    fala: falaOuNada(r.fala_id, r.fala_caminho, r.fala_duracao),
    falaInvalida: falaOuNada(r.invalida_id, r.invalida_caminho, r.invalida_duracao),
    opcoes: r.opcoes,
    aceitaRamal: r.accepts_extension === true,
  };
}

/** As três falas gerais da organização (aguarde, ninguém atendeu, fora do horário) — só as prontas. */
export async function falasGerais(db: Queryable, organizationId: string): Promise<FalasGerais> {
  const { rows } = await db.query<{
    aguarde_id: string | null;
    aguarde_caminho: string | null;
    aguarde_duracao: number | null;
    ninguem_id: string | null;
    ninguem_caminho: string | null;
    ninguem_duracao: number | null;
    fora_id: string | null;
    fora_caminho: string | null;
    fora_duracao: number | null;
  }>(
    `select w.id as aguarde_id, w.storage_path as aguarde_caminho, w.duration_ms as aguarde_duracao,
            n.id as ninguem_id, n.storage_path as ninguem_caminho, n.duration_ms as ninguem_duracao,
            a.id as fora_id, a.storage_path as fora_caminho, a.duration_ms as fora_duracao
       from phone_settings s
       left join phone_prompts w
         on w.id = s.waiting_prompt_id and w.organization_id = s.organization_id and w.status = 'ready'
       left join phone_prompts n
         on n.id = s.nobody_prompt_id and n.organization_id = s.organization_id and n.status = 'ready'
       left join phone_prompts a
         on a.id = s.after_hours_prompt_id and a.organization_id = s.organization_id and a.status = 'ready'
      where s.organization_id = $1`,
    [organizationId],
  );
  const r = rows[0];
  return {
    aguarde: falaOuNada(r?.aguarde_id ?? null, r?.aguarde_caminho ?? null, r?.aguarde_duracao ?? null),
    ninguem: falaOuNada(r?.ninguem_id ?? null, r?.ninguem_caminho ?? null, r?.ninguem_duracao ?? null),
    foraDoHorario: falaOuNada(r?.fora_id ?? null, r?.fora_caminho ?? null, r?.fora_duracao ?? null),
  };
}

/** O que a ligação encontra ao entrar na fila do time. */
export interface TimeParaAFila {
  situacao: SituacaoDoTime;
  /**
   * O aviso de instabilidade a tocar antes dos atendentes — ou `null`. Vem com a
   * situação que for: a ordem (fora do horário antes do aviso, desenho §5.2) é
   * do controlador, não desta leitura.
   */
  aviso: FalaDoBanco | null;
  /** A espera máxima na fila deste time, em segundos (0295) — `null` = o padrão. Lida aqui, na entrada: mudar a configuração não altera quem já está esperando. */
  esperaMaximaS: number | null;
}

/**
 * A entrada na fila do time numa leitura só da linha dele: a situação
 * (`situacaoDaLinhaDoTime`) e o aviso de instabilidade. O aviso toca só com o
 * time ATIVO (não arquivado) e VIGENTE (`avisoVigente`, a mesma régua da tela:
 * `active_since` preenchido e `expires_at` nulo ou depois de `agora`), com a
 * fala pronta. Decidido contra o relógio da ligação, a cada ligação: o aviso
 * vencido para de tocar na hora, sem esperar a passada de 60 s desligá-lo no
 * banco (desenho §5.5). Time de outra organização: `indisponivel`, sem aviso.
 */
export async function timeParaAFila(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<TimeParaAFila> {
  const t = await lerTimeNaFila(db, organizationId, teamId);
  const situacao = situacaoDaLinhaDoTime(t, agora);
  // O teto vem com a situação que for; o time que não existe NESTA organização não tem teto (`null` = o padrão).
  const esperaMaximaS = t?.espera_maxima_s ?? null;
  if (!t || t.archived_at || !avisoVigente({ desde: t.aviso_desde, expiraEm: t.aviso_expira_em }, agora)) {
    return { situacao, aviso: null, esperaMaximaS };
  }
  return { situacao, aviso: falaOuNada(t.aviso_fala_id, t.aviso_fala_caminho, t.aviso_fala_duracao), esperaMaximaS };
}

/** O que a URA decidiu: a tecla (nula = nenhuma tecla válida), o desfecho e o time para onde a ligação vai. */
export interface EscolhaDoMenu {
  digito: string | null;
  desfecho: DesfechoDoMenu;
  teamId: string;
}

/**
 * Grava o que o cliente fez no menu (`menu_digit`, `menu_outcome`) e o time que
 * a URA escolheu (`team_id` — o que o "Ligar de volta", a distribuição e o
 * cartão leem) num comando só: o desfecho e o time nunca ficam um sem o outro.
 * A ligação E o time têm de ser desta organização (a FK de `voice_calls.team_id`
 * é simples e não confere isso); senão, `false` e nada muda.
 *
 * No MESMO comando, a CONVERSA da ligação vai para o time escolhido
 * (`conversations.team_id`). É a coluna que a visibilidade por time lê
 * (`fn_can_view_conversation`, migration 0281): no modo restrito ao time, quem
 * é só do Financeiro não enxerga a conversa que nasceu no time padrão do menu —
 * e o "Ligar de volta" dela ficaria sem ter quem abrisse a conversa.
 *
 * A regra é a do roteamento de conversas (`lib/routing/worker.ts`): conversa
 * COM DONO (`assigned_to_user_id`) não é mexida — não se tira uma conversa de
 * quem a tem, nem se muda o time debaixo dela. Só a sem dono acompanha a URA.
 * E só para time ATIVO: o padrão arquivado de um menu fica na ligação (é para
 * ele que ela vai), mas a conversa não é levada a um time que ninguém vê — fica
 * onde está.
 * Direto na coluna, e não por `fn_conversation_set_team`: aquela é o gesto de
 * uma PESSOA (exige `auth.uid()`, solta o dono e pede o rodízio de texto, que a
 * conversa de telefone não tem — `skipped_voice_channel`).
 */
export async function registrarEscolhaDoMenu(
  db: Queryable,
  organizationId: string,
  id: string,
  e: EscolhaDoMenu,
): Promise<boolean> {
  const { rows } = await db.query<{ ligacao: number }>(
    `with ligacao as (
       update voice_calls
          set menu_digit = $3, menu_outcome = $4, team_id = $5, updated_at = now()
        where id = $1 and organization_id = $2
          and exists (select 1 from attendance_teams t where t.id = $5 and t.organization_id = $2)
        returning conversation_id
     ), conversa as (
       update conversations c
          set team_id = $5, updated_at = now()
         from ligacao
        where c.id = ligacao.conversation_id and c.organization_id = $2
          and c.assigned_to_user_id is null
          and c.team_id is distinct from $5
          and exists (select 1 from attendance_teams t
                       where t.id = $5 and t.organization_id = $2 and t.archived_at is null)
        returning c.id
     )
     select (select count(*) from ligacao)::int as ligacao`,
    [id, organizationId, e.digito, e.desfecho, e.teamId],
  );
  return (rows[0]?.ligacao ?? 0) > 0;
}

/**
 * O cliente ouviu o aviso de instabilidade INTEIRO — a fonte do "ouviu o aviso"
 * no cartão. Guarda a PRIMEIRA vez (ouvir de novo não move o instante).
 */
export async function registrarAvisoOuvido(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update voice_calls set emergency_heard_at = coalesce(emergency_heard_at, now()), updated_at = now()
      where id = $1 and organization_id = $2`,
    [id, organizationId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * A fala não tocou (arquivo ausente, Storage fora ou reprodução falha) e a
 * ligação seguiu sem ela: aviso `phone_prompt_unplayable` na Central, sem
 * referência (o destino é a aba das falas, `lib/ai/inbox-destino.ts`). Um só por
 * fala enquanto o anterior estiver ABERTO — sem isto, cada ligação abriria um.
 * `rotulo` diz qual fala ("menu Principal", "aguarde"): é ele que distingue um
 * aviso do outro.
 *
 * É o dedup `kind_e_titulo` de `insertInboxItem` (a função da Central que todos
 * usam): o "não existe" e o INSERT são um comando só; duas chamadas SIMULTÂNEAS
 * da mesma fala poderiam abrir dois, e é aceito: a fila do laço (`laco.ts`)
 * serializa os eventos das ligações, e um aviso a mais não esconde nada.
 */
export async function avisarFalaIntocavel(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  rotulo: string,
): Promise<void> {
  await insertInboxItem(
    db,
    organizationId,
    {
      kind: "phone_prompt_unplayable",
      severity: "warn",
      title: `Uma fala do telefone não tocou: ${rotulo}`.slice(0, 200),
      body: "A ligação seguiu sem ela. Gere a fala de novo em Conexões › Telefone e confira se o serviço de telefonia está de pé.",
    },
    "kind_e_titulo",
  );
}

/**
 * Quem ligou caiu no time PADRÃO de um menu, e esse time está ARQUIVADO: a
 * ligação segue a fila dele (que não atende ninguém) e vira perdida com
 * "Ligar de volta"; este aviso (`phone_menu_team_archived`, migration 0288) diz
 * na Central que o menu precisa de outro time padrão. Sem referência, como a
 * fala que não tocou: o destino é a aba dos menus do telefone
 * (`lib/ai/inbox-destino.ts`). Um por menu enquanto o anterior estiver ABERTO —
 * o dedup `kind_e_titulo`, com o nome do menu no título.
 */
export async function avisarMenuComTimeArquivado(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  menu: { id: string; nome: string },
): Promise<void> {
  await insertInboxItem(
    db,
    organizationId,
    {
      kind: "phone_menu_team_archived",
      severity: "warn",
      title: `O menu do telefone ${menu.nome} manda para um time arquivado`.slice(0, 200),
      body:
        "Quem liga e não escolhe uma opção nesse menu cai no time padrão dele, que foi arquivado e não atende ninguém: a ligação vira perdida. Escolha outro time padrão para o menu em Conexões › Telefone › Menus.",
    },
    "kind_e_titulo",
  );
}

/** Um aviso de instabilidade que a passada desligou. */
export interface AvisoDesligado {
  id: string;
  organizationId: string;
  nome: string;
}

/**
 * A passada de 60 s (desenho §5.5): desliga os avisos de instabilidade VENCIDOS
 * — de TODA a instalação, também o do time ARQUIVADO que ficou com prazo —,
 * grava a auditoria `phone.emergency_expired` (de SISTEMA: sem ator, o aviso
 * venceu sozinho, e `bypassed_rls`, como `lib/lgpd/sla-alarm.ts`)
 * e abre `phone_emergency_expired` na Central, na organização de cada time. Um
 * comando só: a auditoria e o aviso não se perdem se o worker cair no meio, e a
 * segunda passada não acha o mesmo aviso de novo. O texto
 * (`phone_emergency_prompt_id`) fica no time: religar começa dele. O aviso sem
 * prazo ("até alguém desligar") nunca vence aqui.
 *
 * A TRAVA é `for no key update skip locked`, nunca `for update`:
 * - `no key update` porque o time é referenciado por FK na ligação que entra
 *   (`voice_calls.team_id`), e toda FK confere o time em `key share` — que
 *   `for update` bloquearia, deixando a ligação esperar a passada;
 * - `skip locked` porque a linha que um gerente segura (ligando ou desligando
 *   o aviso, `lib/telefonia/emergencias.ts`) é da decisão dele — a passada não
 *   espera: pula, e a seguinte a reavalia.
 * tests/invariants/telefonia-repositorio-da-ura.test.ts mede as duas coisas, com
 * o controle em `for update`.
 */
export async function desligarAvisosVencidos(db: Queryable, agora: Date): Promise<AvisoDesligado[]> {
  const { rows } = await db.query<{ id: string; organization_id: string; name: string }>(
    `with vencidos as (
       select id, organization_id, name, phone_emergency_active_since as desde,
              phone_emergency_expires_at as expirou_em, phone_emergency_activated_by as ligado_por
         from attendance_teams
        where phone_emergency_active_since is not null
          and phone_emergency_expires_at is not null
          and phone_emergency_expires_at <= $1
        for no key update skip locked
     ), desligados as (
       update attendance_teams t
          set phone_emergency_active_since = null, phone_emergency_expires_at = null,
              phone_emergency_activated_by = null, updated_at = now()
         from vencidos v
        where t.id = v.id and t.organization_id = v.organization_id
        returning v.id, v.organization_id, v.name, v.desde, v.expirou_em, v.ligado_por
     ), auditados as (
       insert into api_audit_log (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
       select organization_id, 'phone.emergency_expired', 'attendance_team', id, true,
              jsonb_build_object('time', name, 'ligado_em', desde, 'expirou_em', expirou_em, 'ligado_por', ligado_por)
         from desligados
       returning 1
     ), avisados as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body)
       select organization_id, 'phone_emergency_expired', 'info',
              left('O aviso de instabilidade do telefone de ' || name || ' desligou sozinho', 200),
              'Ele venceu no horário escolhido quando foi ligado. Se a instabilidade continua, ligue o aviso de novo em Configurações › Times.'
         from desligados
       returning 1
     )
     select id, organization_id, name from desligados`,
    [agora],
  );
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, nome: r.name }));
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
  /** O menu de voz que atendeu (fase 2). Nulo/ausente = o número aponta para um time. */
  menuId?: string | null;
}

export async function criarLigacao(db: Queryable, l: NovaLigacao): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into voice_calls
       (organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction,
        peer_phone, status, conversation_id, team_id, menu_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      l.menuId ?? null,
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
  direction: "inbound" | "outbound" | "internal";
  peer_phone: string;
  status: string;
  owner_user_id: string | null;
  created_by: string | null;
  team_id: string | null;
  started_at: string;
  answered_at: string | null;
  provider: string;
  sip_call_ref: string | null;
  // Fase 2 (0288). Opcionais no tipo: os testes da fase 1 montam ligações sem eles.
  menu_id?: string | null;
  menu_digit?: string | null;
  menu_outcome?: DesfechoDoMenu | null;
  emergency_heard_at?: string | Date | null;
  end_reason?: string | null;
  /** O ciclo da gravação (0289). `recording` no fim = há arquivo a guardar. */
  recording_status?: EstadoDaGravacao | null;
  /** Na ligação interna (0291): quem recebe. */
  peer_user_id?: string | null;
  /** Na FEITA (0294): quando o telefone do cliente começou a chamar. Nulo = não chamou, ou ninguém mediu. */
  peer_ringing_at?: string | Date | null;
  /** Preenchido só no fim (`encerrarLigacao`). */
  ended_at?: string | Date | null;
}

/** As colunas de `LigacaoDoBanco` — uma lista só para leitura, recuperação e encerramento. */
const COLUNAS_DA_LIGACAO = `id, organization_id, channel_session_id, contact_id, conversation_id, direction,
  peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
  provider, sip_call_ref, menu_id, menu_digit, menu_outcome, emergency_heard_at, end_reason, recording_status, peer_user_id,
  peer_ringing_at, ended_at`;

/**
 * A ligação `id`, se ela for DESTE atendente (`owner_user_id`) e do TELEFONE — o
 * pedido de ligação de saída que o ramal disca (`c-<id>`). A linha do WaCalls o
 * agent cria pela REST: sem o filtro de provider ela servia de pedido forjado. A catraca aqui é o atendente, e
 * não a organização: quando o ramal disca, a organização ainda não é conhecida
 * (o ramal é da pessoa, que pode estar em mais de uma), e ela sai da PRÓPRIA
 * linha, que o controlador confere contra o tronco antes de discar.
 */
export async function ligacaoDoAtendente(db: Queryable, userId: string, id: string): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls where id = $1 and owner_user_id = $2 and provider = $3`,
    [id, userId, PROVIDER],
  );
  return rows[0] ?? null;
}

/** Ligações de telefone que o banco acha que ainda estão vivas (para `recuperar()`). */
export async function ligacoesVivas(db: Queryable): Promise<LigacaoDoBanco[]> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls where provider = $1 and status <> 'ended'`,
    [PROVIDER],
  );
  return rows;
}

/** Tocando para alguém (ou para ninguém, com `null`). Presa à organização da ligação. */
export async function marcarTocando(
  db: Queryable,
  organizationId: string,
  id: string,
  userId: string | null,
): Promise<void> {
  await db.query(
    `update voice_calls set status = 'ringing', ringing_user_id = $3, updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId, userId],
  );
}

/**
 * A ligação passou a ESPERAR POR UMA PESSOA (0295): o começo dos toques. Guarda
 * a PRIMEIRA vez — é a ordem de chegada da fila, e mover de time não a muda.
 */
export async function marcarNaFila(db: Queryable, organizationId: string, id: string): Promise<void> {
  await db.query(
    `update voice_calls set queued_at = coalesce(queued_at, now()), updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId],
  );
}

/**
 * Quando a espera sem ninguém livre esgota (0295) — o "cai em" da aba Telefone.
 * `restanteMs` é o que falta no relógio do worker; vira `now()` do BANCO mais
 * isso, para a conta não depender de os dois relógios baterem (o desenho da
 * 0294). `null` = não está mais esperando.
 */
export async function marcarPrazoDaFila(
  db: Queryable,
  organizationId: string,
  id: string,
  restanteMs: number | null,
): Promise<void> {
  await db.query(
    `update voice_calls
        set queue_deadline_at = case when $3::double precision is null then null
                                     else now() + make_interval(secs => $3::double precision / 1000) end,
            updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId, restanteMs],
  );
}

/** Atendida por `userId`. Presa à organização da ligação. Quem foi atendido não cai por espera: o prazo da fila some (0295). */
export async function marcarAtendida(db: Queryable, organizationId: string, id: string, userId: string): Promise<void> {
  await db.query(
    `update voice_calls
        set status = 'connected', answered_at = coalesce(answered_at, now()),
            owner_user_id = coalesce(owner_user_id, $3), ringing_user_id = null,
            queue_deadline_at = null, updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId, userId],
  );
}

/**
 * Fecha a ligação. Idempotente: a segunda chamada não muda nada e devolve `null`
 * — como a de outra organização, que nunca a alcança.
 *
 * `desdeOPrimeiroToqueMs` (0294, só a FEITA): há quanto tempo o telefone do
 * cliente começou a chamar, medido pelo relógio do worker. Vira
 * `peer_ringing_at` no relógio do BANCO (`now()` menos esse tempo), na mesma
 * escrita que fecha a ligação: `ended_at - peer_ringing_at` é exatamente o que
 * o worker mediu, mesmo com os dois relógios fora de sincronia. `null` = não
 * chamou (ou ninguém mediu): a coluna fica como está. Só na linha do telefone:
 * em qualquer outra o CHECK da 0294 recusaria a escrita, e a ligação não fecharia.
 */
export async function encerrarLigacao(
  db: Queryable,
  organizationId: string,
  id: string,
  motivo: string,
  desdeOPrimeiroToqueMs: number | null = null,
): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `update voice_calls
        set status = 'ended', ended_at = now(), end_reason = $3, ringing_user_id = null,
            duration_ms = case when answered_at is null then null
                               else (extract(epoch from (now() - answered_at)) * 1000)::int end,
            peer_ringing_at = case when $4::double precision is null or provider <> $5 then peer_ringing_at
                                   else now() - make_interval(secs => $4::double precision / 1000) end,
            updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'
      returning ${COLUNAS_DA_LIGACAO}`,
    [id, organizationId, motivo, desdeOPrimeiroToqueMs, PROVIDER],
  );
  return rows[0] ?? null;
}

/**
 * A conversa passa a ser de quem atendeu — o mesmo gesto de "assumir" (`claim`).
 * Na transferência (v2) o motivo é `transfer`, que o evento de atribuição já
 * conhece: a corrente fica legível no histórico da conversa.
 */
export async function atribuirConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  userId: string,
  motivo: "claim" | "transfer" = "claim",
): Promise<void> {
  await db.query("select 1 from public.fn_conversation_assign($1, $2, $3, $4)", [
    organizationId,
    conversationId,
    userId,
    motivo,
  ]);
}

// ─── transferência (fase 2, versão 2; migration 0290) ─────────────────────
//
// A API grava o PEDIDO (a linha `open`) e avisa o worker pela ARI; o worker
// relê a linha aqui — pelo id, com a organização DA LIGAÇÃO em memória e o id
// da ligação junto — e grava o DESFECHO. A variável do evento é ponteiro,
// nunca autoridade (desenho §12.2).

export type { DesfechoDaTransferencia };

export interface TransferenciaDoBanco {
  id: string;
  kind: "blind" | "attended";
  fromUserId: string | null;
  toUserId: string | null;
  toTeamId: string | null;
}

/** A transferência ABERTA `id` desta ligação, nesta organização — ou `null`. */
export async function transferenciaAberta(
  db: Queryable,
  organizationId: string,
  voiceCallId: string,
  id: string,
): Promise<TransferenciaDoBanco | null> {
  const { rows } = await db.query<{
    id: string;
    kind: "blind" | "attended";
    from_user_id: string | null;
    to_user_id: string | null;
    to_team_id: string | null;
  }>(
    `select id, kind, from_user_id, to_user_id, to_team_id
       from voice_call_transfers
      where id = $1 and organization_id = $2 and voice_call_id = $3 and status = 'open'`,
    [id, organizationId, voiceCallId],
  );
  const r = rows[0];
  return r ? { id: r.id, kind: r.kind, fromUserId: r.from_user_id, toUserId: r.to_user_id, toTeamId: r.to_team_id } : null;
}

/** Fecha a transferência com o desfecho. Idempotente: a que já fechou não muda. */
export async function encerrarTransferencia(
  db: Queryable,
  organizationId: string,
  id: string,
  fim: { desfecho: DesfechoDaTransferencia; motivo: string | null; atendidaPor: string | null },
): Promise<void> {
  await db.query(
    `update voice_call_transfers
        set status = 'ended', outcome = $3, reason = $4, answered_by = $5, ended_at = now()
      where id = $1 and organization_id = $2 and status = 'open'`,
    [id, organizationId, fim.desfecho, fim.motivo, fim.atendidaPor],
  );
}

/**
 * A ordem chegou para uma ligação que este worker não acompanha (reiniciou, ou
 * ela acabou): a transferência é recusada, senão a linha `open` travaria a
 * próxima tentativa na mesma ligação (índice de uma aberta por vez). Sem
 * organização de propósito — não há ligação em memória de onde tirá-la —, mas
 * presa ao PAR (transferência, ligação) que a própria ordem trouxe.
 */
export async function recusarTransferenciaOrfa(db: Queryable, id: string, voiceCallId: string, motivo: string): Promise<void> {
  await db.query(
    `update voice_call_transfers
        set status = 'ended', outcome = 'refused', reason = $3, ended_at = now()
      where id = $1 and voice_call_id = $2 and status = 'open'`,
    [id, voiceCallId, motivo],
  );
}

/**
 * Na (re)conexão do worker: toda transferência aberta morreu com o estado em
 * memória do worker anterior (risco aceito, desenho §11). Varre a instalação,
 * como `ligacoesVivas`.
 */
export async function cancelarTransferenciasAbertas(db: Queryable, motivo: string): Promise<number> {
  const { rowCount } = await db.query(
    `update voice_call_transfers
        set status = 'ended', outcome = 'cancelled', reason = $1, ended_at = now()
      where status = 'open'`,
    [motivo],
  );
  return rowCount ?? 0;
}

/**
 * Tocando para `userId` DURANTE a transferência: só o `ringing_user_id` (o
 * "ocupado" que o distribuidor e o diretório leem). O `status` fica
 * `connected` — `marcarTocando` o poria em `ringing`, e o painel e o
 * `recuperar()` leriam a ligação como não atendida.
 */
export async function marcarTocandoNaTransferencia(
  db: Queryable,
  organizationId: string,
  id: string,
  userId: string | null,
): Promise<void> {
  await db.query(
    `update voice_calls set ringing_user_id = $3, updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId, userId],
  );
}

/** A ligação passa a ser de `userId` (a transferência pegou). `answered_at` não muda: é de quando o cliente foi atendido. */
export async function passarLigacao(db: Queryable, organizationId: string, id: string, userId: string): Promise<void> {
  await db.query(
    `update voice_calls set owner_user_id = $3, ringing_user_id = null, updated_at = now()
      where id = $1 and organization_id = $2 and status <> 'ended'`,
    [id, organizationId, userId],
  );
}

/**
 * Transferência para um TIME: a ligação e a conversa vão para ele. A conversa
 * sai de quem a tinha (é o gesto de `fn_conversation_set_team`, que exige
 * sessão de usuário — o worker não tem), com o evento `team_transfer` no
 * histórico; quem atender a fila fica com ela (`atribuirConversa`, `transfer`).
 * Time de outra organização, ou arquivado, não recebe nada.
 */
export async function moverParaOTime(
  db: Queryable,
  organizationId: string,
  id: string,
  conversationId: string | null,
  teamId: string,
): Promise<void> {
  await db.query(
    `with time as (
       select t.id from attendance_teams t
        where t.id = $3 and t.organization_id = $2 and t.archived_at is null
     ), ligacao as (
       update voice_calls v set team_id = time.id, updated_at = now()
         from time
        where v.id = $1 and v.organization_id = $2
       returning v.id
     ), antes as (
       select c.assigned_to_user_id as dono from conversations c
        where c.id = $4 and c.organization_id = $2
     ), conversa as (
       update conversations c
          set team_id = time.id, assigned_to_user_id = null, assignee_kind = null, updated_at = now()
         from time
        where c.id = $4 and c.organization_id = $2
       returning c.id
     )
     insert into conversation_assignment_events (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
     select $2, $4, antes.dono, null, null, 'team_transfer'
       from antes, conversa
      where antes.dono is not null`,
    [id, organizationId, teamId, conversationId],
  );
}

/** O time da ligação (D21): o dela (recebida: fila, número ou menu) ou, sem ele, o da conversa (feita). */
export async function timeDaLigacao(db: Queryable, organizationId: string, id: string): Promise<string | null> {
  const { rows } = await db.query<{ time: string | null }>(
    `select coalesce(v.team_id, c.team_id) as time
       from voice_calls v
       left join conversations c on c.id = v.conversation_id and c.organization_id = v.organization_id
      where v.id = $1 and v.organization_id = $2`,
    [id, organizationId],
  );
  return rows[0]?.time ?? null;
}

/**
 * A pessoa está numa ligação viva desta organização — falando, tocando, ou do
 * outro lado de uma ligação interna (v3). A mesma régua do "ocupado" de
 * `disponiveisNoTime`, para uma pessoa só.
 */
export async function pessoaEmLigacao(db: Queryable, organizationId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from voice_calls v
      where v.organization_id = $1 and v.status <> 'ended'
        and (v.owner_user_id = $2 or v.ringing_user_id = $2 or v.peer_user_id = $2)
        and v.started_at > now() - interval '4 hours'
      limit 1`,
    [organizationId, userId],
  );
  return rows.length > 0;
}

// ─── as ordens da fila (fila visível, entrega 3; migration 0296) ──────────
//
// "Atender" e "Mover", pedidos pela aba Telefone. O mesmo desenho da
// transferência: a API grava o PEDIDO (a linha `open`) e avisa o worker pela
// ARI; o worker relê a linha aqui — pelo id, com a organização DA LIGAÇÃO em
// memória e o id da ligação junto — e grava o DESFECHO. A variável do evento
// é ponteiro, nunca autoridade.

/** Como a ordem acaba (`voice_call_queue_orders.outcome`, o CHECK da 0296). */
export type DesfechoDaOrdemDaFila = "done" | "refused" | "no_answer" | "cancelled";

export interface OrdemDaFilaDoBanco {
  id: string;
  /** `pull`: puxar para o ramal de `toUserId`. `move`: mandar para a fila de `toTeamId`. */
  kind: "pull" | "move";
  requestedBy: string | null;
  toUserId: string | null;
  toTeamId: string | null;
}

/** A ordem ABERTA `id` desta ligação, nesta organização — ou `null`. */
export async function ordemDaFilaAberta(
  db: Queryable,
  organizationId: string,
  voiceCallId: string,
  id: string,
): Promise<OrdemDaFilaDoBanco | null> {
  const { rows } = await db.query<{
    id: string;
    kind: "pull" | "move";
    requested_by: string | null;
    to_user_id: string | null;
    to_team_id: string | null;
  }>(
    `select id, kind, requested_by, to_user_id, to_team_id
       from voice_call_queue_orders
      where id = $1 and organization_id = $2 and voice_call_id = $3 and status = 'open'`,
    [id, organizationId, voiceCallId],
  );
  const r = rows[0];
  return r ? { id: r.id, kind: r.kind, requestedBy: r.requested_by, toUserId: r.to_user_id, toTeamId: r.to_team_id } : null;
}

/** Fecha a ordem com o desfecho. Idempotente: a que já fechou não muda. */
export async function encerrarOrdemDaFila(
  db: Queryable,
  organizationId: string,
  id: string,
  fim: { desfecho: DesfechoDaOrdemDaFila; motivo: string | null },
): Promise<void> {
  await db.query(
    `update voice_call_queue_orders
        set status = 'ended', outcome = $3, reason = $4, ended_at = now()
      where id = $1 and organization_id = $2 and status = 'open'`,
    [id, organizationId, fim.desfecho, fim.motivo],
  );
}

/**
 * A ordem chegou para uma ligação que este worker não acompanha (ela acabou, ou
 * ele reiniciou): recusada — a tela para de esperar por ela. Sem organização
 * de propósito, como `recusarTransferenciaOrfa`: não há ligação em memória de
 * onde tirá-la; fica presa ao PAR (ordem, ligação) que a própria ordem trouxe.
 */
export async function recusarOrdemDaFilaOrfa(db: Queryable, id: string, voiceCallId: string, motivo: string): Promise<void> {
  await db.query(
    `update voice_call_queue_orders
        set status = 'ended', outcome = 'refused', reason = $3, ended_at = now()
      where id = $1 and voice_call_id = $2 and status = 'open'`,
    [id, voiceCallId, motivo],
  );
}

/**
 * Na (re)conexão do worker: toda ordem aberta morreu com o estado em memória do
 * worker anterior — o ramal de quem puxou não toca mais por ela. Varre a
 * instalação, como `cancelarTransferenciasAbertas`.
 */
export async function cancelarOrdensDaFilaAbertas(db: Queryable, motivo: string): Promise<number> {
  const { rowCount } = await db.query(
    `update voice_call_queue_orders
        set status = 'ended', outcome = 'cancelled', reason = $1, ended_at = now()
      where status = 'open'`,
    [motivo],
  );
  return rowCount ?? 0;
}

/**
 * A ligação acabou: a ordem que ficou aberta nela (o ramal de quem puxou ainda
 * tocava, ou o evento nunca chegou ao worker) fecha `cancelled`. Presa à
 * organização da ligação.
 */
export async function cancelarOrdensDaLigacao(
  db: Queryable,
  organizationId: string,
  voiceCallId: string,
  motivo: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `update voice_call_queue_orders
        set status = 'ended', outcome = 'cancelled', reason = $3, ended_at = now()
      where organization_id = $1 and voice_call_id = $2 and status = 'open'`,
    [organizationId, voiceCallId, motivo],
  );
  return rowCount ?? 0;
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
  /** O `end_reason` da ligação: `after_hours` (fase 2) muda o texto da recebida não atendida. */
  motivo?: string | null;
}): string {
  const d = duracaoLegivel(p.duracaoMs);
  if (p.direcao === "inbound") {
    if (p.desfecho === "atendida") return `Ligação recebida${p.quem ? `, atendida por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
    if (p.motivo === MOTIVO_FORA_DO_HORARIO) return "Ligação recebida fora do horário";
    return "Ligação recebida não atendida";
  }
  if (p.desfecho === "atendida") return `Ligação feita${p.quem ? ` por ${p.quem}` : ""}${d ? ` · ${d}` : ""}`;
  if (p.desfecho === "recusada_pela_rede") return "Ligação feita · não completou";
  return "Ligação feita · sem resposta";
}

/**
 * O que a URA fez (fase 2), no schema central que o cartão lê (`MenuDaLigacao`):
 * o menu, a tecla, o time para onde a ligação foi — ou que o cliente desligou no
 * menu. Nulo quando a ligação não passou por menu.
 *
 * Os nomes são os desta hora, sem filtro de arquivamento (é história), e os dois
 * lidos DESTA organização. Sem decisão, não há time a nomear: o `team_id` ainda é
 * o de entrada, e ninguém chegou a tocar.
 *
 * NUNCA lança: os nomes são cosméticos, e quem chama é `finalizar` (controle.ts),
 * que depois disto ainda abre o "Ligar de volta" e grava o `registrarFim`. Se a
 * leitura falha, o registro sai com os nomes nulos (o cartão diz "menu do
 * telefone") e o log conta por quê.
 */
async function menuDoRegistro(db: Queryable, l: LigacaoDoBanco): Promise<MenuDaLigacao | null> {
  if (!l.menu_id && !l.menu_outcome) return null;
  let nomes: { menu: string | null; time: string | null } | undefined;
  try {
    const { rows } = await db.query<{ menu: string | null; time: string | null }>(
      `select (select m.name from phone_menus m where m.id = $2::uuid and m.organization_id = $1) as menu,
              (select t.name from attendance_teams t where t.id = $3::uuid and t.organization_id = $1) as time`,
      [l.organization_id, l.menu_id ?? null, l.menu_outcome ? l.team_id : null],
    );
    nomes = rows[0];
  } catch (e) {
    logger.warn("telefonia: nomes do menu e do time não lidos — o registro na conversa sai sem eles", {
      voice_call: l.id,
      erro: (e instanceof Error ? e.message : String(e)).slice(0, 160),
    });
  }
  return {
    nome: nomes?.menu ?? null,
    desfecho: l.menu_outcome ?? null,
    tecla: l.menu_digit ?? null,
    time_nome: nomes?.time ?? null,
    desligou: desligouNoMenu(l),
  };
}

/**
 * A corrente de transferências da ligação (v2), para o cartão
 * (`TransferenciaDaLigacao`). Os nomes são os desta hora, e os dois lados da
 * junção presos à organização da ligação. NUNCA lança, pelo mesmo motivo de
 * `menuDoRegistro`: é cosmético, e quem chama ainda tem o "Ligar de volta".
 */
async function transferenciasDoRegistro(db: Queryable, l: LigacaoDoBanco): Promise<TransferenciaDaLigacao[]> {
  try {
    const { rows } = await db.query<{
      kind: TransferenciaDaLigacao["tipo"];
      outcome: TransferenciaDaLigacao["desfecho"];
      de_nome: string | null;
      para_nome: string | null;
      para_time: string | null;
      atendida_por_nome: string | null;
    }>(
      `select t.kind, t.outcome,
              (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = t.from_user_id) as de_nome,
              (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = t.to_user_id) as para_nome,
              (select tm.name from attendance_teams tm where tm.id = t.to_team_id and tm.organization_id = t.organization_id) as para_time,
              (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = t.answered_by) as atendida_por_nome
         from voice_call_transfers t
        where t.organization_id = $1 and t.voice_call_id = $2
          and t.outcome is distinct from 'refused'
        order by t.created_at`,
      [l.organization_id, l.id],
    );
    return rows.map((r) => ({
      tipo: r.kind,
      desfecho: r.outcome,
      de_nome: r.de_nome,
      para_nome: r.para_nome,
      para_time: r.para_time,
      atendida_por_nome: r.atendida_por_nome,
    }));
  } catch (e) {
    logger.warn("telefonia: transferências da ligação não lidas — o registro sai sem elas", {
      voice_call: l.id,
      erro: (e instanceof Error ? e.message : String(e)).slice(0, 160),
    });
    return [];
  }
}

/**
 * O que a tela fez com a ligação enquanto ela esperava (0296), como o cartão o
 * lê — a mesma forma de `AcaoNaFilaDaLigacao` (`lib/telefonia/vocabulario.ts`),
 * escrita aqui para o worker não depender do leitor da tela.
 */
interface AcaoNaFilaDoRegistro {
  tipo: "pull" | "move";
  por_nome: string | null;
  de_time: string | null;
  para_time: string | null;
}

/**
 * As ordens da fila que ACONTECERAM nesta ligação (`done`): quem a puxou, quem
 * a moveu e entre que times — na ordem em que foram pedidas. A recusada, a que
 * ninguém atendeu e a cancelada não mudaram a ligação e ficam fora do cartão.
 * Os nomes são os desta hora, e os times lidos DESTA organização. NUNCA lança,
 * pelo mesmo motivo de `menuDoRegistro`: é cosmético, e quem chama ainda tem o
 * "Ligar de volta".
 */
async function acoesNaFilaDoRegistro(db: Queryable, l: LigacaoDoBanco): Promise<AcaoNaFilaDoRegistro[]> {
  try {
    const { rows } = await db.query<{
      kind: AcaoNaFilaDoRegistro["tipo"];
      por_nome: string | null;
      de_time: string | null;
      para_time: string | null;
    }>(
      `select o.kind,
              (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = o.requested_by) as por_nome,
              (select tm.name from attendance_teams tm where tm.id = o.from_team_id and tm.organization_id = o.organization_id) as de_time,
              (select tm.name from attendance_teams tm where tm.id = o.to_team_id and tm.organization_id = o.organization_id) as para_time
         from voice_call_queue_orders o
        where o.organization_id = $1 and o.voice_call_id = $2 and o.outcome = 'done'
        order by o.created_at, o.id`,
      [l.organization_id, l.id],
    );
    return rows.map((r) => ({ tipo: r.kind, por_nome: r.por_nome, de_time: r.de_time, para_time: r.para_time }));
  } catch (e) {
    logger.warn("telefonia: ordens da fila da ligação não lidas — o registro sai sem elas", {
      voice_call: l.id,
      erro: (e instanceof Error ? e.message : String(e)).slice(0, 160),
    });
    return [];
  }
}

const GRAVACAO_EM_PROCESSAMENTO: GravacaoDaLigacao = { situacao: "processando", duracao_ms: null };

/**
 * Por quanto tempo o telefone do cliente chamou na ligação FEITA que ninguém
 * atendeu (0294) — o que o cartão conta embaixo do selo "Ligação sem resposta".
 * Sai da linha que `encerrarLigacao` devolveu, as duas pontas no relógio do
 * banco. `null` — e o registro fica sem a chave — quando não é esse caso ou o
 * telefone não chegou a chamar: o cartão nunca mostra um tempo que ninguém mediu.
 */
export function toqueDaSaidaSemResposta(
  l: Pick<LigacaoDoBanco, "direction" | "answered_at" | "peer_ringing_at" | "ended_at">,
): number | null {
  if (l.direction !== "outbound" || l.answered_at || !l.peer_ringing_at || !l.ended_at) return null;
  const ms = Math.round(new Date(l.ended_at).getTime() - new Date(l.peer_ringing_at).getTime());
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Quanto durou a tentativa da FEITA que ninguém atendeu: do pedido (o clique em
 * "Ligar", `started_at`) ao fim. É o que o cartão conta de quem desligou quando
 * a rede não avisou que o telefone chamava — quem esperou 40 s não fica igual a
 * quem desligou em 1 s. As duas pontas no relógio do banco.
 */
export function tentativaDaSaidaSemResposta(
  l: Pick<LigacaoDoBanco, "direction" | "answered_at" | "started_at" | "ended_at">,
): number | null {
  if (l.direction !== "outbound" || l.answered_at || !l.started_at || !l.ended_at) return null;
  const ms = Math.round(new Date(l.ended_at).getTime() - new Date(l.started_at).getTime());
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** O nome de quem atende, como o registro da conversa o escreve: o cadastrado ou, sem ele, o e-mail. */
async function nomeDoAtendente(db: Queryable, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ nome: string | null }>(
    "select coalesce(raw_user_meta_data->>'full_name', email) as nome from auth.users where id = $1",
    [userId],
  );
  return rows[0]?.nome ?? null;
}

/** A prévia da conversa enquanto a ligação está em andamento — em português, como todo `body` de registro. */
export function textoDoCartaoEmAndamento(quem: string | null): string {
  return `Ligação em andamento${quem ? ` com ${quem}` : ""}`;
}

/**
 * O CARTÃO "LIGAÇÃO EM ANDAMENTO" (fila visível, entrega 1). Chamado quando a
 * recebida é atendida — DEPOIS de `atribuirConversa`, que reabre a conversa
 * encerrada e abre o atendimento novo: o cartão tem de nascer dentro dele, e é
 * ele que dá posição à conversa na lista (`last_message_at`). O atendente passa
 * a ter onde escrever uma nota interna enquanto fala.
 *
 * É a MESMA mensagem que `registrarNaConversa` completa no fim (`ligacao:<id>`),
 * com `em_andamento: true` e `desfecho: "atendida"` — e não um desfecho novo: a
 * aba que não recarregou depois da atualização leria um desfecho desconhecido
 * como "não atendida" e mostraria "Ligação perdida" durante a ligação.
 *
 * Idempotente. A primeira chamada cria o cartão; as seguintes — a transferência
 * que passa a ligação a outra pessoa — só trocam o nome de quem está com ela.
 *
 * NÃO mexe no time da conversa. A conversa de quem já ligou antes guarda o time
 * do atendimento anterior, e levá-la ao time desta ligação aqui gravaria na
 * linha do tempo "Transferida para a fila do time… Aguardando operador
 * disponível" com a ligação já atendida (o gatilho de `conversations` só cala
 * esse evento quando o time muda no MESMO comando que reabre a conversa). O
 * conserto pede migration e ficou fora desta entrega.
 *
 * `false` = nada a fazer: ligação de outra organização, feita, ainda não
 * atendida, sem conversa (número oculto) ou já encerrada.
 */
export async function abrirCartaoDaLigacao(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls
      where id = $1 and organization_id = $2 and provider = $3
        and direction = 'inbound' and status = 'connected'`,
    [id, organizationId, PROVIDER],
  );
  const l = rows[0];
  if (!l || !l.conversation_id || !l.contact_id || !l.owner_user_id) return false;
  const quem = await nomeDoAtendente(db, l.owner_user_id);
  const texto = textoDoCartaoEmAndamento(quem);
  const externalId = `ligacao:${l.id}`;

  const { rows: ja } = await db.query<{ em_andamento: string | null }>(
    "select metadata->'voice_call'->>'em_andamento' as em_andamento from messages where organization_id = $1 and external_id = $2 limit 1",
    [organizationId, externalId],
  );
  if (ja[0]) {
    if (ja[0].em_andamento !== "true") return false;
    await db.query(
      `update messages
          set body = $3,
              metadata = jsonb_set(metadata, '{voice_call}', (metadata->'voice_call') || $4::jsonb)
        where organization_id = $1 and external_id = $2
          and metadata->'voice_call'->>'em_andamento' = 'true'`,
      [organizationId, externalId, texto, JSON.stringify({ atendente_id: l.owner_user_id, atendente_nome: quem })],
    );
    await db.query(
      // Só enquanto a prévia ainda é a do cartão: uma mensagem mais nova na conversa não é pisada.
      `update conversations set last_message_preview = left($3, 200), updated_at = now()
        where id = $1 and organization_id = $2 and last_message_preview like $4`,
      [l.conversation_id, organizationId, texto, `${textoDoCartaoEmAndamento(null)}%`],
    );
    return true;
  }

  const menu = await menuDoRegistro(db, l);
  try {
    await db.query(
      `insert into messages
         (organization_id, conversation_id, contact_id, channel_session_id, external_id,
          direction, type, body, sent_via, status, metadata)
       values ($1, $2, $3, $4, $5, 'outbound', 'system', $6, 'system', 'sent', $7)`,
      [
        organizationId,
        l.conversation_id,
        l.contact_id,
        l.channel_session_id,
        externalId,
        texto,
        JSON.stringify({
          voice_call: {
            id: l.id,
            direcao: "inbound",
            desfecho: "atendida",
            em_andamento: true,
            duracao_ms: null,
            atendente_id: l.owner_user_id,
            atendente_nome: quem,
            motivo: null,
            menu,
            ouviu_aviso: Boolean(l.emergency_heard_at),
          },
        }),
      ],
    );
  } catch (e) {
    // A trava única é DEFERRABLE (ver `registrarNaConversa`): quem perdeu a corrida não tem o que fazer.
    if ((e as { code?: string }).code === "23505") return false;
    throw e;
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, organizationId, texto],
  );
  return true;
}

/**
 * O registro da ligação DENTRO da conversa — a linha que o atendente vê no chat.
 *
 * `type=system`, `sent_via=system`, `direction=outbound`, de propósito: uma
 * mensagem `inbound` emite `message.received`, que acorda o agente de IA e
 * religa o termômetro de espera — e uma ligação não é uma fala a responder por
 * texto. `external_id` com o id da ligação: o mesmo registro não entra duas
 * vezes (índice único por organização).
 *
 * Fila visível, entrega 1: a recebida ATENDIDA já tem o cartão — `abrirCartaoDaLigacao`
 * o criou "em andamento". Aqui ele é COMPLETADO, mesclando no banco (reações e
 * gravação escrevem no mesmo `metadata`); o cartão já fechado não é reescrito.
 */
export async function registrarNaConversa(
  db: Queryable,
  l: LigacaoDoBanco,
  desfecho: DesfechoDaLigacao,
  duracaoMs: number | null,
): Promise<void> {
  // A interna (v3) não tem conversa nem contato: não há onde registrar.
  if (!l.conversation_id || !l.contact_id || l.direction === "internal") return;
  const quem = await nomeDoAtendente(db, l.owner_user_id);
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem, motivo: l.end_reason ?? null });
  // Sem `on conflict`: a trava única de `(organization_id, external_id)` é
  // DEFERRABLE, e o Postgres recusa trava deferível como árbitro ("ON CONFLICT
  // does not support deferrable unique constraints") — medido na prova pela
  // tela, onde isso derrubava o fim da ligação inteiro. Conferir antes e tratar
  // o 23505 do reenvio cobre o mesmo caso.
  const externalId = `ligacao:${l.id}`;
  const { rows: ja } = await db.query<{ em_andamento: string | null }>(
    "select metadata->'voice_call'->>'em_andamento' as em_andamento from messages where organization_id = $1 and external_id = $2 limit 1",
    [l.organization_id, externalId],
  );
  const emAndamento = ja[0]?.em_andamento === "true";
  if (ja.length > 0 && !emAndamento) return;
  const menu = await menuDoRegistro(db, l);
  const transferencias = await transferenciasDoRegistro(db, l);
  // Só a recebida entra na fila: a feita não tem ordem a ler.
  const fila = l.direction === "inbound" ? await acoesNaFilaDoRegistro(db, l) : [];
  const toqueMs = toqueDaSaidaSemResposta(l);
  const tentativaMs = tentativaDaSaidaSemResposta(l);
  const registro = {
    id: l.id,
    direcao: l.direction,
    desfecho,
    duracao_ms: duracaoMs,
    atendente_id: l.owner_user_id,
    atendente_nome: quem,
    motivo: l.end_reason ?? null,
    menu,
    ouviu_aviso: Boolean(l.emergency_heard_at),
    // Feita e não atendida: por quanto tempo o telefone do cliente chamou (0294). Ausente sem a medida.
    ...(toqueMs !== null ? { toque_ms: toqueMs } : {}),
    // E quanto durou a tentativa, do pedido ao fim — o que o cartão conta de quem desligou sem o toque.
    ...(tentativaMs !== null ? { tentativa_ms: tentativaMs } : {}),
    // A corrente de transferências (v2), com os nomes daquela hora. Ausente sem transferência.
    ...(transferencias.length > 0 ? { transferencias } : {}),
    // Puxada da fila ou movida de time pela aba Telefone (0296). Ausente quando ninguém agiu nela.
    ...(fila.length > 0 ? { fila } : {}),
    // Gravada: o arquivo ainda vai ser guardado (lib/channels/telefonia/gravacoes.ts),
    // e é o processamento que troca a situação, sempre mesclando no banco.
    ...(l.recording_status === "recording" ? { gravacao: GRAVACAO_EM_PROCESSAMENTO } : {}),
  };
  if (emAndamento) {
    // A `gravacao` que JÁ está no cartão vence a do registro: o cartão existe
    // desde o atender, e a passada das gravações (fora da fila serial) pode
    // guardar o arquivo entre o fechamento da ligação e esta escrita — o
    // "processando" do registro por cima dela esconderia o botão de ouvir para sempre.
    await db.query(
      `update messages
          set body = $3,
              metadata = jsonb_set(
                metadata,
                '{voice_call}',
                ((metadata->'voice_call') - 'em_andamento') || $4::jsonb
                  || case when (metadata->'voice_call') ? 'gravacao'
                          then jsonb_build_object('gravacao', metadata->'voice_call'->'gravacao')
                          else '{}'::jsonb end
              )
        where organization_id = $1 and external_id = $2
          and metadata->'voice_call'->>'em_andamento' = 'true'`,
      [l.organization_id, externalId, texto, JSON.stringify(registro)],
    );
  } else {
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
          JSON.stringify({ voice_call: registro }),
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return;
      throw e;
    }
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, l.organization_id, texto],
  );
}

/**
 * O cliente desligou NO MENU: a ligação tinha menu, a URA não chegou a decidir
 * (sem `menu_outcome`) e ela acabou porque ele desligou. A que o worker encerrou
 * ao reiniciar no meio do menu não conta — não foi o cliente.
 */
export function desligouNoMenu(l: Pick<LigacaoDoBanco, "menu_id" | "menu_outcome" | "end_reason">): boolean {
  return Boolean(l.menu_id) && !l.menu_outcome && l.end_reason === "cliente_desligou";
}

/**
 * O texto do "Ligar de volta", no idioma da organização. Três casos: quem
 * desligou no menu (ninguém chegou a tocar — dizer que o time não atendeu seria
 * falso), o time que não atendeu, e sem time.
 */
export function textoDoAvisoDePerdida(p: {
  numero: string;
  nomeDoTime: string | null;
  desligouNoMenu: boolean;
  idioma: Idioma;
}): { titulo: string; corpo: string } {
  // Troca LITERAL (`trocarMarcador`): com uma string no 2º argumento do `replace`,
  // `$&`, `$$` e `$'` no nome do time (ou no número) viram padrões e saem deturpados.
  const titulo = trocarMarcador(traduzir("Ligação perdida de {numero}", p.idioma), "{numero}", p.numero);
  if (p.desligouNoMenu) {
    return { titulo, corpo: traduzir("O cliente desligou no menu do telefone. Ligue de volta pela conversa.", p.idioma) };
  }
  const nomeDoTime = p.nomeDoTime;
  if (nomeDoTime) {
    return {
      titulo,
      corpo: trocarMarcador(traduzir("Ninguém do time {time} atendeu. Ligue de volta pela conversa.", p.idioma), "{time}", nomeDoTime),
    };
  }
  return { titulo, corpo: traduzir("Ninguém atendeu. Ligue de volta pela conversa.", p.idioma) };
}

/**
 * Chamada recebida que ninguém atendeu: aviso na Central para alguém retornar.
 *
 * O aviso diz o TIME que ficou com a ligação (`voice_calls.team_id`): com a URA,
 * o escolhido no menu. A Central é da organização inteira (o aviso não tem
 * coluna de time), então é o texto que diz de quem é o retorno; a conversa já
 * está no mesmo time (`registrarEscolhaDoMenu`), e quem é dele a abre. O nome do
 * time e o idioma são lidos DESTA organização: time de outra não é nomeado.
 */
export async function avisarPerdida(db: Queryable, l: LigacaoDoBanco): Promise<void> {
  const { rows } = await db.query<{ time: string | null; idioma: string | null }>(
    `select (select t.name from attendance_teams t where t.id = $2::uuid and t.organization_id = $1) as time,
            (select o.locale from organizations o where o.id = $1) as idioma`,
    [l.organization_id, l.team_id],
  );
  const { titulo, corpo } = textoDoAvisoDePerdida({
    numero: l.peer_phone,
    nomeDoTime: rows[0]?.time ?? null,
    desligouNoMenu: desligouNoMenu(l),
    idioma: normalizarIdioma(rows[0]?.idioma),
  });
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'voice_call_missed', 'warn', $2, $3, $4, $5)`,
    [l.organization_id, titulo, corpo, l.contact_id ? "contact" : null, l.contact_id],
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

// ─── o cartão que ficou "em andamento" (fila visível, entrega 1) ──────────

/**
 * Ligações do telefone já ENCERRADAS cujo cartão ficou "em andamento": a
 * ligação fechou no banco e a escrita do cartão falhou (o banco caiu entre uma
 * e outra). Varre a instalação inteira de propósito, como `ligacoesVivas` — e
 * cada conserto escreve na organização da PRÓPRIA linha. Parte de `voice_calls`
 * (pequena) e sonda `messages` pelo índice único de `(organization_id,
 * external_id)`: nunca varre `messages`. O minuto de folga deixa o fim normal
 * (`finalizar`) terminar antes; as 24 h limitam a sonda ao que ainda importa.
 */
export async function ligacoesComCartaoOrfao(db: Queryable, limite = 20): Promise<LigacaoDoBanco[]> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls v
      where v.provider = $1 and v.status = 'ended' and v.direction = 'inbound' and v.answered_at is not null
        and v.ended_at > now() - interval '24 hours' and v.ended_at < now() - interval '1 minute'
        and exists (select 1 from messages m
                     where m.organization_id = v.organization_id
                       and m.external_id = 'ligacao:' || v.id::text
                       and m.metadata->'voice_call'->>'em_andamento' = 'true')
      order by v.ended_at
      limit $2`,
    [PROVIDER, limite],
  );
  return rows;
}

/**
 * Fecha os cartões órfãos pelo caminho de sempre (`registrarNaConversa`).
 * Devolve quantos FECHOU. O que falha fica para a próxima passada e não segura
 * os outros: uma ligação que não fecha nunca não pode deixar as demais dizendo
 * "em andamento".
 */
export async function consertarCartoesOrfaos(db: Queryable): Promise<number> {
  const orfas = await ligacoesComCartaoOrfao(db);
  let fechados = 0;
  for (const l of orfas) {
    const duracao =
      l.answered_at && l.ended_at
        ? Math.max(0, Math.round(new Date(l.ended_at).getTime() - new Date(l.answered_at).getTime()))
        : null;
    try {
      await registrarNaConversa(db, l, "atendida", duracao);
      fechados++;
    } catch (e) {
      logger.warn("telefonia: cartão em andamento de ligação encerrada não fechado — a próxima passada tenta de novo", {
        voice_call: l.id,
        erro: (e instanceof Error ? e.message : String(e)).slice(0, 160),
      });
    }
  }
  return fechados;
}

// ─── ramais e ligação interna (fase 2, versão 3; migration 0291) ──────────

/** Quem tem o ramal `numero` NESTA organização — `null` se ninguém. */
export async function donoDoRamal(db: Queryable, organizationId: string, numero: string): Promise<string | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `select e.user_id from phone_extensions e
       join user_organizations uo on uo.user_id = e.user_id and uo.organization_id = e.organization_id
        and uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin')
      where e.organization_id = $1 and e."number" = $2`,
    [organizationId, numero],
  );
  return rows[0]?.user_id ?? null;
}

/** O nome e o ramal de quem liga — o que aparece no telefone do colega ("Ana (201)"). */
export async function quemLiga(db: Queryable, organizationId: string, userId: string): Promise<{ nome: string; ramal: string | null }> {
  const { rows } = await db.query<{ nome: string | null; ramal: string | null }>(
    `select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) as nome,
            (select e."number" from phone_extensions e where e.organization_id = $1 and e.user_id = u.id) as ramal
       from auth.users u where u.id = $2`,
    [organizationId, userId],
  );
  return { nome: rows[0]?.nome ?? "", ramal: rows[0]?.ramal ?? null };
}

/**
 * O colega pode receber a ligação interna `vcId` agora? Membro com papel de
 * atendimento desta organização, disponível (sem pausa), e sem OUTRA ligação
 * viva — a própria interna já o marca como `peer_user_id`, então ela fica de
 * fora da conta. O "online" é da ARI, e o horário próprio a API já conferiu.
 */
export async function colegaLivreParaInterna(
  db: Queryable,
  organizationId: string,
  userId: string,
  vcId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from user_organizations uo
       join attendant_availability a on a.organization_id = uo.organization_id and a.user_id = uo.user_id and a.is_available
      where uo.organization_id = $1 and uo.user_id = $2 and uo.revoked_at is null
        and uo.role in ('agent', 'manager', 'admin')
        and not exists (
          select 1 from voice_calls v
           where v.organization_id = $1 and v.status <> 'ended' and v.id <> $3
             and (v.owner_user_id = $2 or v.ringing_user_id = $2 or v.peer_user_id = $2)
             and v.started_at > now() - interval '4 hours'
        )`,
    [organizationId, userId, vcId],
  );
  return rows.length > 0;
}
