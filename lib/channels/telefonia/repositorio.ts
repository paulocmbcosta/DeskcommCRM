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

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";
import { isWithinSchedule } from "@/lib/routing/eligibility";
import { lerAgenda } from "@/lib/times/agenda";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { CandidatoAoToque } from "@/lib/telefonia/distribuicao";
import { avisoVigente } from "@/lib/telefonia/vencimento-da-emergencia";
import { MOTIVO_FORA_DO_HORARIO, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";

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

/** Espelha o estado do registro na linha do canal — o que a tela de Conexões mostra. */
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
 * da fase 1 não mudam.
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

export async function situacaoDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<SituacaoDoTime> {
  const { rows } = await db.query<{ schedule: unknown; archived_at: string | Date | null }>(
    "select schedule, archived_at from attendance_teams where id = $1 and organization_id = $2",
    [teamId, organizationId],
  );
  return situacaoDaLinhaDoTime(rows[0], agora);
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
 * canal de voz: quem está falando no WhatsApp também está ocupado.
 */
export async function disponiveisNoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<CandidatoAoToque[]> {
  // Fora do horário, arquivado ou de outra organização: ninguém. QUAL dos três é
  // a pergunta de `situacaoDoTime`; aqui a resposta segue a mesma lista vazia.
  if ((await situacaoDoTime(db, organizationId, teamId, agora)) !== "aberto") return [];

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
             and (v.owner_user_id = m.user_id or v.ringing_user_id = m.user_id)
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

/** Uma fala PRONTA para tocar: só o que o worker precisa para garantir o arquivo. */
export interface FalaDoBanco {
  id: string;
  storagePath: string;
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
  /** `null` = sem fala pronta: o controlador manda direto para o time padrão (desenho §4). */
  fala: FalaDoBanco | null;
  falaInvalida: FalaDoBanco | null;
  /** Em ordem de tecla; só as de times NÃO arquivados (tecla de time arquivado conta como inválida). */
  opcoes: Array<{ digito: string; teamId: string }>;
}

const falaOuNada = (id: string | null, caminho: string | null): FalaDoBanco | null =>
  id && caminho ? { id, storagePath: caminho } : null;

/** O menu DESTA organização, se não arquivado — só falas prontas, só opções de times não arquivados. */
export async function menuPorId(db: Queryable, organizationId: string, menuId: string): Promise<MenuDoBanco | null> {
  const { rows } = await db.query<{
    id: string;
    nome: string;
    default_team_id: string;
    fala_id: string | null;
    fala_caminho: string | null;
    invalida_id: string | null;
    invalida_caminho: string | null;
    opcoes: Array<{ digito: string; teamId: string }>;
  }>(
    `select m.id, m.name as nome, m.default_team_id,
            p.id as fala_id, p.storage_path as fala_caminho,
            i.id as invalida_id, i.storage_path as invalida_caminho,
            coalesce((
              select jsonb_agg(jsonb_build_object('digito', o.digit, 'teamId', o.team_id) order by o.digit)
                from phone_menu_options o
                join attendance_teams t
                  on t.id = o.team_id and t.organization_id = o.organization_id and t.archived_at is null
               where o.menu_id = m.id and o.organization_id = m.organization_id
            ), '[]'::jsonb) as opcoes
       from phone_menus m
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
    fala: falaOuNada(r.fala_id, r.fala_caminho),
    falaInvalida: falaOuNada(r.invalida_id, r.invalida_caminho),
    opcoes: r.opcoes,
  };
}

/** As três falas gerais da organização (aguarde, ninguém atendeu, fora do horário) — só as prontas. */
export async function falasGerais(db: Queryable, organizationId: string): Promise<FalasGerais> {
  const { rows } = await db.query<{
    aguarde_id: string | null;
    aguarde_caminho: string | null;
    ninguem_id: string | null;
    ninguem_caminho: string | null;
    fora_id: string | null;
    fora_caminho: string | null;
  }>(
    `select w.id as aguarde_id, w.storage_path as aguarde_caminho,
            n.id as ninguem_id, n.storage_path as ninguem_caminho,
            a.id as fora_id, a.storage_path as fora_caminho
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
    aguarde: falaOuNada(r?.aguarde_id ?? null, r?.aguarde_caminho ?? null),
    ninguem: falaOuNada(r?.ninguem_id ?? null, r?.ninguem_caminho ?? null),
    foraDoHorario: falaOuNada(r?.fora_id ?? null, r?.fora_caminho ?? null),
  };
}

/**
 * O aviso de instabilidade que a ligação deve ouvir ao entrar na fila do time —
 * ou `null`. Toca só com o time ATIVO (não arquivado) e o aviso VIGENTE
 * (`avisoVigente`, a mesma régua da tela: `active_since` preenchido e
 * `expires_at` nulo ou depois de `agora`), com a fala pronta. Decidido contra o
 * relógio da ligação, a cada ligação: o aviso vencido para de tocar na hora, sem
 * esperar a passada de 60 s desligá-lo no banco (desenho §5.5).
 */
export async function emergenciaDoTime(
  db: Queryable,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<FalaDoBanco | null> {
  const { rows } = await db.query<{
    desde: Date | string | null;
    expira_em: Date | string | null;
    arquivado: boolean;
    fala_id: string | null;
    fala_caminho: string | null;
  }>(
    `select t.phone_emergency_active_since as desde, t.phone_emergency_expires_at as expira_em,
            t.archived_at is not null as arquivado,
            p.id as fala_id, p.storage_path as fala_caminho
       from attendance_teams t
       left join phone_prompts p
         on p.id = t.phone_emergency_prompt_id and p.organization_id = t.organization_id and p.status = 'ready'
      where t.id = $1 and t.organization_id = $2`,
    [teamId, organizationId],
  );
  const t = rows[0];
  if (!t || t.arquivado || !avisoVigente({ desde: t.desde, expiraEm: t.expira_em }, agora)) return null;
  return falaOuNada(t.fala_id, t.fala_caminho);
}

/**
 * O que o cliente fez no menu (`menu_digit`, `menu_outcome`). `digito` nulo =
 * nenhuma tecla válida (o desfecho diz se houve tecla errada). Devolve `false`
 * se a ligação não é desta organização — nada muda.
 */
export async function registrarMenu(
  db: Queryable,
  organizationId: string,
  id: string,
  m: { digito: string | null; desfecho: DesfechoDoMenu },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update voice_calls set menu_digit = $3, menu_outcome = $4, updated_at = now()
      where id = $1 and organization_id = $2`,
    [id, organizationId, m.digito, m.desfecho],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * O time da ligação passa a ser o que a URA escolheu — é o que o "Ligar de
 * volta", a distribuição e o cartão leem. A ligação E o time têm de ser desta
 * organização (a FK de `voice_calls.team_id` é simples e não confere isso);
 * senão, `false` e nada muda.
 */
export async function definirTimeDaLigacao(
  db: Queryable,
  organizationId: string,
  id: string,
  teamId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update voice_calls set team_id = $3, updated_at = now()
      where id = $1 and organization_id = $2
        and exists (select 1 from attendance_teams t where t.id = $3 and t.organization_id = $2)`,
    [id, organizationId, teamId],
  );
  return (rowCount ?? 0) > 0;
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
 * O "não existe" e o INSERT são um comando só; duas chamadas SIMULTÂNEAS da mesma
 * fala poderiam abrir dois, e é aceito: a fila do laço (`laco.ts`) serializa os
 * eventos das ligações, e um aviso a mais não esconde nada.
 */
export async function avisarFalaIntocavel(db: Queryable, organizationId: string, rotulo: string): Promise<void> {
  const titulo = `Uma fala do telefone não tocou: ${rotulo}`.slice(0, 200);
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body)
     select $1::uuid, 'phone_prompt_unplayable', 'warn', $2::text,
            'A ligação seguiu sem ela. Gere a fala de novo em Conexões › Telefone e confira se o serviço de telefonia está de pé.'
      where not exists (
        select 1 from agent_inbox_items
         where organization_id = $1::uuid and kind = 'phone_prompt_unplayable' and status = 'open' and title = $2::text
      )`,
    [organizationId, titulo],
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
 * grava a auditoria `phone.emergency_expired` (sem ator: o aviso venceu sozinho)
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
       insert into api_audit_log (organization_id, action, resource_type, resource_id, metadata)
       select organization_id, 'phone.emergency_expired', 'attendance_team', id,
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
  direction: "inbound" | "outbound";
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
}

/** As colunas de `LigacaoDoBanco` — uma lista só para leitura, recuperação e encerramento. */
const COLUNAS_DA_LIGACAO = `id, organization_id, channel_session_id, contact_id, conversation_id, direction,
  peer_phone, status, owner_user_id, created_by, team_id, started_at, answered_at,
  provider, sip_call_ref, menu_id, menu_digit, menu_outcome, emergency_heard_at, end_reason`;

export async function ligacaoPorId(db: Queryable, id: string): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(`select ${COLUNAS_DA_LIGACAO} from voice_calls where id = $1`, [id]);
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

/** Tocando para alguém (ou para ninguém, com `null`). */
export async function marcarTocando(db: Queryable, id: string, userId: string | null): Promise<void> {
  await db.query(
    `update voice_calls set status = 'ringing', ringing_user_id = $2, updated_at = now()
      where id = $1 and status <> 'ended'`,
    [id, userId],
  );
}

export async function marcarAtendida(db: Queryable, id: string, userId: string): Promise<void> {
  await db.query(
    `update voice_calls
        set status = 'connected', answered_at = coalesce(answered_at, now()),
            owner_user_id = coalesce(owner_user_id, $2), ringing_user_id = null, updated_at = now()
      where id = $1 and status <> 'ended'`,
    [id, userId],
  );
}

/** Fecha a ligação. Idempotente: a segunda chamada não muda nada e devolve `null`. */
export async function encerrarLigacao(
  db: Queryable,
  id: string,
  motivo: string,
): Promise<LigacaoDoBanco | null> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `update voice_calls
        set status = 'ended', ended_at = now(), end_reason = $2, ringing_user_id = null,
            duration_ms = case when answered_at is null then null
                               else (extract(epoch from (now() - answered_at)) * 1000)::int end,
            updated_at = now()
      where id = $1 and status <> 'ended'
      returning ${COLUNAS_DA_LIGACAO}`,
    [id, motivo],
  );
  return rows[0] ?? null;
}

/** A conversa passa a ser de quem atendeu — o mesmo gesto de "assumir". */
export async function atribuirConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<void> {
  await db.query("select 1 from public.fn_conversation_assign($1, $2, $3, 'claim')", [
    organizationId,
    conversationId,
    userId,
  ]);
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
 * O registro da ligação DENTRO da conversa — a linha que o atendente vê no chat.
 *
 * `type=system`, `sent_via=system`, `direction=outbound`, de propósito: uma
 * mensagem `inbound` emite `message.received`, que acorda o agente de IA e
 * religa o termômetro de espera — e uma ligação não é uma fala a responder por
 * texto. `external_id` com o id da ligação: o mesmo registro não entra duas
 * vezes (índice único por organização).
 */
export async function registrarNaConversa(
  db: Queryable,
  l: LigacaoDoBanco,
  desfecho: DesfechoDaLigacao,
  duracaoMs: number | null,
): Promise<void> {
  if (!l.conversation_id || !l.contact_id) return;
  let quem: string | null = null;
  if (l.owner_user_id) {
    const { rows } = await db.query<{ nome: string | null }>(
      "select coalesce(raw_user_meta_data->>'full_name', email) as nome from auth.users where id = $1",
      [l.owner_user_id],
    );
    quem = rows[0]?.nome ?? null;
  }
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem, motivo: l.end_reason ?? null });
  // O que a URA fez (fase 2): o cartão mostra "escolheu 2 → Financeiro" ou "sem escolha → Suporte".
  let menu: { desfecho: DesfechoDoMenu; tecla: string | null; time_nome: string | null } | null = null;
  if (l.menu_outcome) {
    let timeNome: string | null = null;
    if (l.team_id) {
      const { rows: t } = await db.query<{ name: string }>(
        "select name from attendance_teams where id = $1 and organization_id = $2",
        [l.team_id, l.organization_id],
      );
      timeNome = t[0]?.name ?? null;
    }
    menu = { desfecho: l.menu_outcome, tecla: l.menu_digit ?? null, time_nome: timeNome };
  }
  // Sem `on conflict`: a trava única de `(organization_id, external_id)` é
  // DEFERRABLE, e o Postgres recusa trava deferível como árbitro ("ON CONFLICT
  // does not support deferrable unique constraints") — medido na prova pela
  // tela, onde isso derrubava o fim da ligação inteiro. Conferir antes e tratar
  // o 23505 do reenvio cobre o mesmo caso.
  const externalId = `ligacao:${l.id}`;
  const { rows: ja } = await db.query(
    "select 1 from messages where organization_id = $1 and external_id = $2 limit 1",
    [l.organization_id, externalId],
  );
  if (ja.length > 0) return;
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
      JSON.stringify({
        voice_call: {
          id: l.id,
          direcao: l.direction,
          desfecho,
          duracao_ms: duracaoMs,
          atendente_id: l.owner_user_id,
          atendente_nome: quem,
          motivo: l.end_reason ?? null,
          menu,
          ouviu_aviso: Boolean(l.emergency_heard_at),
        },
      }),
    ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return;
    throw e;
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, l.organization_id, texto],
  );
}

/** Chamada recebida que ninguém atendeu: aviso na Central para alguém retornar. */
export async function avisarPerdida(db: Queryable, l: LigacaoDoBanco): Promise<void> {
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'voice_call_missed', 'warn', $2, $3, $4, $5)`,
    [
      l.organization_id,
      `Ligação perdida de ${l.peer_phone}`,
      "Ninguém atendeu. Ligue de volta pela conversa.",
      l.contact_id ? "contact" : null,
      l.contact_id,
    ],
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
