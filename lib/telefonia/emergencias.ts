/**
 * O AVISO DE INSTABILIDADE DO TELEFONE, POR TIME (desenho da fase 2, D7, D8, §4
 * e §6.3). Server-only.
 *
 * Ligado, toda ligação DE FORA que entra na fila do time ouve o aviso inteiro
 * antes de tocar nos atendentes. Liga e desliga gerente ou admin; a duração é
 * escolhida ao ligar (`DURACOES_DA_EMERGENCIA`, 2 h por padrão). O texto fica
 * salvo no time (`phone_emergency_prompt_id`) — desligar não o apaga, e a próxima
 * vez começa dele.
 *
 * LIGAR (`ligarAvisoDoTime`) recebe o texto e o hash da PRÉVIA do aviso (ou os da
 * fala em uso, quando o texto não mudou) e NÃO chama a ElevenLabs (D15). É em
 * duas fases, a forma de `salvarMenuDaOrg` (menus.ts):
 *  1. FORA da transação, sem conexão do pool na mão: o time existe e está ativo
 *     nesta organização, e a prévia confere com o texto e a voz atual e está no
 *     Storage (`conferirFala`). O Storage não tem prazo no supabase-js; lido com a
 *     trava segura, prenderia a linha do time e uma conexão que as rotas da IA e
 *     do MCP também usam.
 *  2. Numa transação com `lock_timeout` (`emTransacao`, `PRAZO_DA_TRAVA`): trava a
 *     linha do time (`travarTimeDoAviso`), relê a fala dele e DECIDE DE NOVO
 *     (`reconferirFala`, sem Storage) — outra gravação do mesmo aviso pode ter
 *     criado ou trocado a fala no meio, e gravar com a decisão velha deixaria uma
 *     linha de `phone_prompts` órfã. Depois grava a fala e liga o aviso no time.
 *     Recusa ou erro desfazem tudo.
 *
 * DESLIGAR (`desligarAvisoDoTime`) trava a mesma linha e só mexe no aviso
 * VIGENTE (`avisoVigente`: `active_since` preenchido e `expires_at` nulo ou no
 * futuro). O vencido que o worker ainda não varreu fica para a passada dele, que
 * registra o vencimento (`phone.emergency_expired`) e avisa na Central: desligá-lo
 * aqui apagaria esse registro e poria no lugar um "desligado por Fulano" que não
 * aconteceu — o aviso já tinha parado de tocar na hora em que venceu.
 *
 * POR QUE `for no key update` NA LINHA DO TIME: o time é referenciado por FK em
 * tabelas quentes — `voice_calls.team_id` (a ligação que entra), `conversations`,
 * `attendance_team_members`, `channel_sessions.sip_team_id`, as opções do menu.
 * Todo INSERT ou UPDATE com essa FK confere o time em `key share`, e `for update`
 * conflita com `key share`: enquanto um gerente liga o aviso, a ligação que chega
 * esperaria a trava (e cairia no `lock_timeout` do worker). `for no key update`
 * não conflita com `key share`, e conflita consigo mesmo — ligar e desligar o
 * mesmo aviso se serializam. Nenhuma das duas escritas muda a chave do time.
 * tests/invariants/telefonia-aviso-no-banco.test.ts mede as duas coisas, com o
 * controle em `for update`.
 *
 * LER (`avisosDaOrg`) é o que a faixa em todo o CRM e o cartão de Configurações ›
 * Times usam: `ativa` é calculada contra o relógio de quem lê, então um aviso
 * vencido que o worker ainda não desligou já aparece desligado.
 *
 * Auditoria é da ROTA (ela tem o ator e o request id). O banco é um `Queryable`
 * que ignora a RLS: TODA consulta filtra `organization_id`, e quem chama passa o
 * da SESSÃO — nunca um valor do corpo.
 *
 * SEM import do cliente da ElevenLabs (nem por um módulo no meio): ligar nunca
 * sintetiza.
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { PortaDoArmazem } from "./armazem";
import {
  COLUNAS_DA_FALA,
  PRAZO_DA_TRAVA,
  conferirFala,
  falaParaSalvarSchema,
  falaPorId,
  falaPublica,
  gravarFalaConferida,
  reconferirFala,
  vozDaOrganizacao,
  type LinhaDaFala,
  type PedidoDeSalvar,
} from "./falas";
import { confirmar, desfazer, emTransacao, type PoolDeTransacao } from "./transacao";
import { DURACAO_PADRAO, DURACOES_DA_EMERGENCIA, avisoVigente } from "./vencimento-da-emergencia";
import type { AvisoDoTimePublico, FalaPublica, FalaParaSalvar, FalhaDaFala } from "./vocabulario";

export const ligarAvisoSchema = z
  .object({
    // O texto e o hash da prévia ouvida — ou os da fala em uso, se o texto não mudou.
    fala: falaParaSalvarSchema,
    duracao: z.enum(DURACOES_DA_EMERGENCIA).default(DURACAO_PADRAO),
  })
  .strict();

export type EntradaDoAviso = z.infer<typeof ligarAvisoSchema>;

/** As recusas próprias do aviso (as da fala vêm de `FalhaDaFala`). */
export type FalhaDoAviso = "nao_encontrado" | "gravacao_em_andamento";

/** O que a tela diz de cada recusa do aviso. Em português; a rota passa por `t()`. */
export const MENSAGEM_DA_FALHA_DO_AVISO: Record<FalhaDoAviso, string> = {
  nao_encontrado: "Time não encontrado.",
  gravacao_em_andamento: "Outra mudança no aviso deste time está em andamento. Tente de novo em instantes.",
};

/** Um período em que o aviso esteve ligado, como a auditoria o guarda. */
export interface PeriodoDoAviso {
  desde: string;
  /** `null` = "até eu desligar". */
  expiraEm: string | null;
}

/** A linha do time como o aviso a lê (datas chegam do `pg` como `Date`). */
export interface TimeDoAviso {
  id: string;
  nome: string;
  falaId: string | null;
  desde: Date | string | null;
  expiraEm: Date | string | null;
  arquivado: boolean;
}

const COLUNAS_DO_TIME = `id, name as nome, phone_emergency_prompt_id as fala_id,
  phone_emergency_active_since as desde, phone_emergency_expires_at as expira_em,
  archived_at is not null as arquivado`;

async function lerTime(db: Queryable, organizationId: string, teamId: string, travar: boolean): Promise<TimeDoAviso | null> {
  const { rows } = await db.query<{
    id: string;
    nome: string;
    fala_id: string | null;
    desde: Date | string | null;
    expira_em: Date | string | null;
    arquivado: boolean;
  }>(
    `select ${COLUNAS_DO_TIME} from attendance_teams
      where id = $1 and organization_id = $2${travar ? "\n      for no key update" : ""}`,
    [teamId, organizationId],
  );
  const r = rows[0];
  return r ? { id: r.id, nome: r.nome, falaId: r.fala_id, desde: r.desde, expiraEm: r.expira_em, arquivado: r.arquivado } : null;
}

/**
 * TRAVA a linha do time desta organização (`select … for no key update`) e a
 * devolve — ou `null` se o time não existe ou é de outra organização. O arquivado
 * volta com `arquivado: true`: ligar o recusa, desligar não (desligar nunca faz mal).
 *
 * CONTRATO de quem chama: `cliente` é UMA conexão com a transação JÁ aberta, com
 * `set local lock_timeout` (`emTransacao`); a escrita vem DEPOIS, na mesma
 * transação. Por que `for no key update`: o cabeçalho deste arquivo.
 */
export function travarTimeDoAviso(cliente: Queryable, organizationId: string, teamId: string): Promise<TimeDoAviso | null> {
  return lerTime(cliente, organizationId, teamId, true);
}

function periodoDe(t: TimeDoAviso): PeriodoDoAviso | null {
  if (!t.desde) return null;
  return { desde: new Date(t.desde).toISOString(), expiraEm: t.expiraEm ? new Date(t.expiraEm).toISOString() : null };
}

export interface PedidoDeLigarAviso {
  /** O pool da rota: consultas soltas na fase 1 e UMA conexão para a transação da fase 2. */
  pool: Queryable & PoolDeTransacao;
  armazem: Pick<PortaDoArmazem, "baixar">;
  /** A organização da SESSÃO — a de toda consulta, de toda escrita e do caminho do Storage. */
  organizationId: string;
  userId: string;
  teamId: string;
  /** O texto e o hash da prévia (ou da fala em uso). */
  fala: FalaParaSalvar;
  /** Quando o aviso passa a valer — e a base do prazo. */
  desde: Date;
  /** `expiraEm(duracao, desde)`; `null` = até alguém desligar. */
  expiraEm: Date | null;
}

export type ResultadoDoLigar =
  | {
      ok: true;
      time: { id: string; nome: string };
      fala: FalaPublica;
      /** A fala mudou (linha nova ou regravada) — a rota audita `phone.prompt_saved`. */
      mudou: boolean;
      /**
       * O período que estava na linha quando ela foi travada — ligado, ou vencido
       * e ainda não varrido pelo worker —, ou `null` se estava desligado. Ligar por
       * cima o substitui; a rota o põe na auditoria para a trilha não perder o fim
       * dele.
       */
      anterior: PeriodoDoAviso | null;
    }
  | { ok: false; motivo: FalhaDaFala | FalhaDoAviso };

/** Sob a trava ninguém lê o Storage: a porta que a decisão NÃO pode usar lança se for usada. */
const SEM_STORAGE_SOB_A_TRAVA: Pick<PortaDoArmazem, "baixar"> = {
  baixar: async () => {
    throw new Error("emergencias: o Storage não é lido com a trava do time segura");
  },
};

/** Liga o aviso do time com a fala da prévia — as duas fases do cabeçalho. Não audita. */
export async function ligarAvisoDoTime(p: PedidoDeLigarAviso): Promise<ResultadoDoLigar> {
  const { pool, organizationId: org } = p;

  // ── Fase 1: fora da transação ────────────────────────────────────────────
  const time = await lerTime(pool, org, p.teamId, false);
  if (!time || time.arquivado) return { ok: false, motivo: "nao_encontrado" };
  const voz = await vozDaOrganizacao(pool, org);
  const pedidoDaFala = (db: Queryable, armazem: Pick<PortaDoArmazem, "baixar">, falaAtualId: string | null): PedidoDeSalvar => ({
    db,
    armazem,
    organizationId: org,
    userId: p.userId,
    tipo: "emergency",
    texto: p.fala.texto,
    hash: p.fala.hash,
    falaAtualId,
    voz,
  });
  const aprovada = await conferirFala(pedidoDaFala(pool, p.armazem, time.falaId));
  if (!aprovada.ok) return aprovada;

  // ── Fase 2: a transação, sob a trava do time ─────────────────────────────
  return emTransacao<ResultadoDoLigar>(pool, PRAZO_DA_TRAVA, async (conexao) => {
    const travado = await travarTimeDoAviso(conexao, org, p.teamId);
    if (!travado || travado.arquivado) return desfazer({ ok: false, motivo: "nao_encontrado" });

    const pedido = pedidoDaFala(conexao, SEM_STORAGE_SOB_A_TRAVA, travado.falaId);
    const lida = travado.falaId ? await falaPorId(conexao, org, travado.falaId) : null;
    const c = reconferirFala(pedido, lida, aprovada);
    if (!c.ok) return desfazer(c);
    const { fala, mudou } = await gravarFalaConferida(pedido, c);

    await conexao.query(
      `update attendance_teams
          set phone_emergency_prompt_id = $3, phone_emergency_active_since = $4, phone_emergency_expires_at = $5,
              phone_emergency_activated_by = $6, updated_at = now()
        where id = $1 and organization_id = $2`,
      [travado.id, org, fala.id, p.desde, p.expiraEm, p.userId],
    );
    return confirmar({ ok: true, time: { id: travado.id, nome: travado.nome }, fala, mudou, anterior: periodoDe(travado) });
  });
}

export type ResultadoDoDesligar =
  | {
      ok: true;
      /** O período que foi desligado, ou `null` se não havia aviso vigente (nada mudou, nada a auditar). */
      desligado: PeriodoDoAviso | null;
    }
  | { ok: false; motivo: FalhaDoAviso };

/**
 * Desliga o aviso VIGENTE do time, sob a trava da linha dele. `agora` é o relógio
 * da requisição — o mesmo com que `avisosDaOrg` decide o que a tela mostra ligado.
 * O texto (`phone_emergency_prompt_id`) fica. Não audita.
 */
export async function desligarAvisoDoTime(
  pool: PoolDeTransacao,
  organizationId: string,
  teamId: string,
  agora: Date,
): Promise<ResultadoDoDesligar> {
  return emTransacao<ResultadoDoDesligar>(pool, PRAZO_DA_TRAVA, async (conexao) => {
    const travado = await travarTimeDoAviso(conexao, organizationId, teamId);
    if (!travado) return desfazer({ ok: false, motivo: "nao_encontrado" });
    const periodo = periodoDe(travado);
    if (!periodo || !avisoVigente(travado, agora)) return desfazer({ ok: true, desligado: null });
    await conexao.query(
      `update attendance_teams
          set phone_emergency_active_since = null, phone_emergency_expires_at = null,
              phone_emergency_activated_by = null, updated_at = now()
        where id = $1 and organization_id = $2`,
      [travado.id, organizationId],
    );
    return confirmar({ ok: true, desligado: periodo });
  });
}

/**
 * Resolve o nome de EXIBIÇÃO de quem ligou (`nomesDeExibicao`, em
 * lib/users/nome-do-atendente.ts, na rota). Entra como porta: este arquivo não
 * carrega o cliente de serviço, e o nome não sai de `auth.users` por SQL — a
 * conexão do app pode ser uma role com grants só em `public`, e o e-mail inteiro
 * de quem ligou não vai para a tela de todo membro.
 */
export type NomesDeQuemLigou = (userIds: string[]) => Promise<Map<string, string | null>>;

/**
 * O aviso de cada time ATIVO da organização, em ordem de nome. `ativa` é
 * `avisoVigente` contra `agora`; desligado ou vencido, `desde`, `expira_em` e
 * `ligada_por` voltam nulos. A fala salva do time vem sempre (o cartão a mostra
 * desligado). O nome só é pedido para quem ligou um aviso VIGENTE — sem aviso
 * ligado, nenhuma chamada.
 */
export async function avisosDaOrg(
  db: Queryable,
  organizationId: string,
  agora: Date,
  nomes: NomesDeQuemLigou,
): Promise<AvisoDoTimePublico[]> {
  const { rows } = await db.query<{
    team_id: string;
    time_nome: string;
    desde: Date | string | null;
    expira_em: Date | string | null;
    ligada_por_id: string | null;
    fala_id: string | null;
  }>(
    `select id as team_id, name as time_nome,
            phone_emergency_active_since as desde, phone_emergency_expires_at as expira_em,
            phone_emergency_activated_by as ligada_por_id, phone_emergency_prompt_id as fala_id
       from attendance_teams
      where organization_id = $1 and archived_at is null
      order by name`,
    [organizationId],
  );

  const ids = rows.map((r) => r.fala_id).filter((id): id is string => Boolean(id));
  const falas = new Map<string, FalaPublica>();
  if (ids.length > 0) {
    const { rows: linhas } = await db.query<LinhaDaFala>(
      `select ${COLUNAS_DA_FALA} from phone_prompts where organization_id = $1 and id = any($2::uuid[])`,
      [organizationId, ids],
    );
    for (const l of linhas) falas.set(l.id, falaPublica(l));
  }

  const vigentes = rows.map((r) => avisoVigente({ desde: r.desde, expiraEm: r.expira_em }, agora));
  const quemLigou = [...new Set(rows.filter((r, i) => vigentes[i] && r.ligada_por_id).map((r) => r.ligada_por_id!))];
  const nomeDe = quemLigou.length > 0 ? await nomes(quemLigou) : new Map<string, string | null>();

  return rows.map((r, i) => {
    const ativa = vigentes[i]!;
    return {
      team_id: r.team_id,
      time_nome: r.time_nome,
      ativa,
      desde: ativa && r.desde ? new Date(r.desde).toISOString() : null,
      expira_em: ativa && r.expira_em ? new Date(r.expira_em).toISOString() : null,
      ligada_por: ativa && r.ligada_por_id ? (nomeDe.get(r.ligada_por_id) ?? null) : null,
      fala: r.fala_id ? (falas.get(r.fala_id) ?? null) : null,
    };
  });
}
