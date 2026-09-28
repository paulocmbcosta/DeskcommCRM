/**
 * OS MENUS DE VOZ (URA) DA ORGANIZAÇÃO — leitura, gravação e arquivamento
 * (desenho da fase 2, D2, §3.1, §6.2 e §8). Server-only.
 *
 * O menu é da ORGANIZAÇÃO e serve a vários números. As opções levam a times da
 * mesma organização — a FK composta do banco (migration 0288) é a catraca;
 * `timesValidos` é a mensagem boa antes dela. Um número só aponta para um menu
 * com a fala pronta (`situacaoDoMenuParaNumero`), e um menu que atende um número
 * não é arquivado.
 *
 * SALVAR (`salvarMenuDaOrg`) é em duas fases, a forma de `salvarFalaGeral`:
 *  1. FORA da transação, sem conexão do pool na mão: as recusas baratas (tecla
 *     repetida, time de fora, menu de outra organização) e a conferência das DUAS
 *     falas — a do menu e a de tecla inválida — contra as prévias no Storage
 *     (`conferirFala`). As duas antes de gravar a primeira: prévia que não confere
 *     não salva menu nenhum. O Storage não tem prazo no supabase-js, e lido com a
 *     trava segura prenderia a linha do menu e uma conexão que as rotas da IA e do
 *     MCP também usam.
 *  2. Numa transação com `lock_timeout`: trava a linha do menu (`for update`),
 *     relê as falas dele e DECIDE DE NOVO (`reconferirFala`, sem Storage) — outra
 *     gravação do mesmo menu pode ter criado ou trocado uma fala no meio, e gravar
 *     com a decisão velha deixaria uma linha de `phone_prompts` órfã. Depois grava
 *     falas, menu e opções. A URA nunca lê um menu com metade das opções, e
 *     recusa ou erro desfazem tudo — inclusive a fala já gravada.
 *
 * As falas chegam como texto + hash da PRÉVIA (`falaParaSalvarSchema`), e nada
 * aqui chama a ElevenLabs (D15). Este arquivo é importado por
 * `lib/channels/telefonia/numeros.ts`: um import do cliente da ElevenLabs aqui
 * (direto ou por um módulo no meio) reprovaria o teste-guarda
 * `tests/unit/ligacao-nunca-chama-elevenlabs.test.ts`.
 *
 * O banco é um `Queryable` que ignora a RLS: TODA consulta filtra
 * `organization_id`, e quem chama passa o da SESSÃO — nunca um valor do corpo.
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { PortaDoArmazem } from "./armazem";
import {
  conferirFala,
  descartarFala,
  falaParaSalvarSchema,
  falaPorId,
  gravarFalaConferida,
  reconferirFala,
  vozDaOrganizacao,
  type FalaConferida,
  type PedidoDeSalvar,
  type PoolDeTransacao,
} from "./falas";
import { somarUltimosSeteDias, type LinhaDoMenuNaSemana } from "./ultimos-sete-dias";
import type { FalaPublica, FalhaDaFala, MenuPublico, OpcaoDoMenuPublica, TipoDeFala } from "./vocabulario";

export const menuSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    opcoes: z
      .array(z.object({ tecla: z.string().regex(/^[0-9]$/), time_id: z.string().uuid() }).strict())
      .min(1)
      .max(10),
    time_padrao_id: z.string().uuid(),
    // O texto e o hash da PRÉVIA da fala do menu — ou os da fala em uso, se o texto
    // não mudou. Nunca um caminho do Storage: quem o monta é o servidor.
    fala: falaParaSalvarSchema,
    // Ausente ou `null` = o menu não tem fala de tecla inválida (a URA só repete o menu).
    fala_invalida: falaParaSalvarSchema.nullish().transform((v) => v ?? null),
  })
  .strict();

export type EntradaDoMenu = z.infer<typeof menuSchema>;

export type FalhaDoMenu = "tecla_repetida" | "time_invalido" | "nao_encontrado" | "menu_em_uso" | "gravacao_em_andamento";

export const MENSAGEM_DA_FALHA_DO_MENU: Record<FalhaDoMenu, string> = {
  tecla_repetida: "Cada tecla só pode levar a um time.",
  time_invalido: "Algum time escolhido não existe nesta organização ou está arquivado.",
  nao_encontrado: "Menu não encontrado.",
  menu_em_uso: "Este menu atende um número. Troque o destino do número antes de arquivar.",
  gravacao_em_andamento: "Outra gravação deste menu está em andamento. Tente de novo em instantes.",
};

/** Qual das duas falas do menu uma falha de fala diz respeito — a tela marca o campo certo. */
export type QualFala = "menu" | "invalida";

const TIPO_DA_FALA: Record<QualFala, TipoDeFala> = { menu: "menu", invalida: "invalid" };

/**
 * O áudio de uma das falas do menu não pôde ser conferido no Storage, dizendo QUAL
 * e o que fazer. Não é a mensagem da prévia (`armazenamento` lá é "não foi
 * possível GUARDAR"): salvar o menu só confere. Com o Storage fora, gerar a prévia
 * de novo não custa nada — sem ler o Storage ela não vai à ElevenLabs
 * (`gerarPrevia`) —, então "se continuar, gere de novo" é seguro.
 */
export const MENSAGEM_DO_AUDIO_DA_FALA_DO_MENU: Record<"previa_ausente" | "armazenamento", Record<QualFala, string>> = {
  previa_ausente: {
    menu: "O áudio da fala do menu não foi encontrado. Gere a prévia de novo e salve.",
    invalida: "O áudio da fala de opção inválida não foi encontrado. Gere a prévia de novo e salve.",
  },
  armazenamento: {
    menu: "Não foi possível conferir o áudio da fala do menu agora. Tente de novo em instantes; se continuar, gere a prévia de novo.",
    invalida:
      "Não foi possível conferir o áudio da fala de opção inválida agora. Tente de novo em instantes; se continuar, gere a prévia de novo.",
  },
};

export function teclaRepetida(opcoes: ReadonlyArray<{ tecla: string }>): boolean {
  return new Set(opcoes.map((o) => o.tecla)).size !== opcoes.length;
}

/** Todos os times são desta organização e não estão arquivados. Repetidos contam uma vez. */
export async function timesValidos(db: Queryable, organizationId: string, ids: readonly string[]): Promise<boolean> {
  const unicos = [...new Set(ids)];
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from attendance_teams
      where organization_id = $1 and id = any($2::uuid[]) and archived_at is null`,
    [organizationId, unicos],
  );
  return (rows[0]?.n ?? 0) === unicos.length;
}

export async function menuDaOrg(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<{ id: string; prompt_id: string | null; invalid_prompt_id: string | null } | null> {
  const { rows } = await db.query<{ id: string; prompt_id: string | null; invalid_prompt_id: string | null }>(
    "select id, prompt_id, invalid_prompt_id from phone_menus where id = $1 and organization_id = $2 and archived_at is null",
    [id, organizationId],
  );
  return rows[0] ?? null;
}

export interface PedidoDeSalvarMenu {
  /** O pool da rota: consultas soltas na fase 1 e UMA conexão para a transação da fase 2. */
  pool: Queryable & PoolDeTransacao;
  armazem: Pick<PortaDoArmazem, "baixar">;
  /** A organização da SESSÃO — a de toda consulta, de toda escrita e do caminho do Storage. */
  organizationId: string;
  userId: string | null;
  /** `null` = menu novo. */
  id: string | null;
  entrada: EntradaDoMenu;
}

export interface FalaGravada {
  fala: FalaPublica;
  mudou: boolean;
}

export type ResultadoDoSalvarMenu =
  | {
      ok: true;
      id: string;
      fala: FalaGravada;
      falaInvalida: FalaGravada | null;
      /** A fala de tecla inválida que o menu deixou de ter e saiu junto (a limpeza do worker leva o objeto). */
      falaInvalidaDescartada: string | null;
    }
  | { ok: false; motivo: Exclude<FalhaDoMenu, "menu_em_uso"> }
  | { ok: false; motivo: FalhaDaFala; fala: QualFala };

/** O `lock_timeout` da transação do menu — o mesmo prazo da fala geral. */
const PRAZO_DA_TRAVA = "4s";

/** Sob a trava ninguém lê o Storage: a porta que a decisão NÃO pode usar lança se for usada. */
const SEM_STORAGE_SOB_A_TRAVA: Pick<PortaDoArmazem, "baixar"> = {
  baixar: async () => {
    throw new Error("menus: o Storage não é lido com a trava do menu segura");
  },
};

type ErroDoPg = { code?: unknown; constraint?: unknown } | null;

/** O que um erro do Postgres na transação significa para quem salva — ou `null`, e ele sobe. */
function falhaDoErro(e: unknown): Exclude<FalhaDoMenu, "menu_em_uso"> | null {
  const { code, constraint } = (e ?? {}) as NonNullable<ErroDoPg>;
  // O `lock_timeout` venceu esperando a trava do menu.
  if (code === "55P03") return "gravacao_em_andamento";
  // A FK composta do time (time padrão ou de uma opção) — o time sumiu ou é de outra organização.
  if (code === "23503" && typeof constraint === "string" && /team_id_fkey$/.test(constraint)) return "time_invalido";
  // A chave (menu_id, digit) das opções.
  if (code === "23505" && constraint === "phone_menu_options_pkey") return "tecla_repetida";
  return null;
}

/**
 * Salva o menu (novo ou editado), com as falas e as opções — as duas fases do
 * cabeçalho. Não audita: a rota tem o ator e o request id, e sabe o que `mudou`.
 */
export async function salvarMenuDaOrg(p: PedidoDeSalvarMenu): Promise<ResultadoDoSalvarMenu> {
  const { pool, organizationId: org, entrada: e } = p;

  // ── Fase 1: fora da transação ────────────────────────────────────────────
  if (teclaRepetida(e.opcoes)) return { ok: false, motivo: "tecla_repetida" };
  const atual = p.id ? await menuDaOrg(pool, org, p.id) : null;
  if (p.id && !atual) return { ok: false, motivo: "nao_encontrado" };
  if (!(await timesValidos(pool, org, [...e.opcoes.map((o) => o.time_id), e.time_padrao_id]))) {
    return { ok: false, motivo: "time_invalido" };
  }
  const voz = await vozDaOrganizacao(pool, org);

  const pedidoDaFala = (
    qual: QualFala,
    db: Queryable,
    armazem: Pick<PortaDoArmazem, "baixar">,
    falaAtualId: string | null,
  ): PedidoDeSalvar | null => {
    const f = qual === "menu" ? e.fala : e.fala_invalida;
    if (!f) return null;
    return { db, armazem, organizationId: org, userId: p.userId, tipo: TIPO_DA_FALA[qual], texto: f.texto, hash: f.hash, falaAtualId, voz };
  };

  const aprovadas: Partial<Record<QualFala, Extract<FalaConferida, { ok: true }>>> = {};
  for (const qual of ["menu", "invalida"] as const) {
    const pedido = pedidoDaFala(qual, pool, p.armazem, (qual === "menu" ? atual?.prompt_id : atual?.invalid_prompt_id) ?? null);
    if (!pedido) continue;
    const c = await conferirFala(pedido);
    if (!c.ok) return { ok: false, motivo: c.motivo, fala: qual };
    aprovadas[qual] = c;
  }

  // ── Fase 2: a transação, sob a trava do menu ─────────────────────────────
  const conexao = await pool.connect();
  let descartar: Error | undefined;
  try {
    await conexao.query("begin");
    await conexao.query(`set local lock_timeout = '${PRAZO_DA_TRAVA}'`);

    let travado: { prompt_id: string | null; invalid_prompt_id: string | null } | null = null;
    if (p.id) {
      const { rows } = await conexao.query<{ prompt_id: string | null; invalid_prompt_id: string | null }>(
        `select prompt_id, invalid_prompt_id from phone_menus
          where id = $1 and organization_id = $2 and archived_at is null
          for update`,
        [p.id, org],
      );
      travado = rows[0] ?? null;
      if (!travado) {
        await conexao.query("rollback");
        return { ok: false, motivo: "nao_encontrado" };
      }
    }

    const gravadas: Partial<Record<QualFala, FalaGravada>> = {};
    for (const qual of ["menu", "invalida"] as const) {
      const aprovada = aprovadas[qual];
      const idAtual = (qual === "menu" ? travado?.prompt_id : travado?.invalid_prompt_id) ?? null;
      const pedido = pedidoDaFala(qual, conexao, SEM_STORAGE_SOB_A_TRAVA, idAtual);
      if (!aprovada || !pedido) continue;
      const lida = idAtual ? await falaPorId(conexao, org, idAtual) : null;
      const c = reconferirFala(pedido, lida, aprovada);
      if (!c.ok) {
        await conexao.query("rollback");
        return { ok: false, motivo: c.motivo, fala: qual };
      }
      gravadas[qual] = await gravarFalaConferida(pedido, c);
    }
    const fala = gravadas.menu!;
    const falaInvalida = gravadas.invalida ?? null;

    let id = p.id;
    if (id) {
      await conexao.query(
        `update phone_menus
            set name = $3, default_team_id = $4, prompt_id = $5, invalid_prompt_id = $6, updated_at = now()
          where id = $1 and organization_id = $2 and archived_at is null`,
        [id, org, e.nome, e.time_padrao_id, fala.fala.id, falaInvalida?.fala.id ?? null],
      );
      await conexao.query("delete from phone_menu_options where menu_id = $1 and organization_id = $2", [id, org]);
    } else {
      const { rows } = await conexao.query<{ id: string }>(
        `insert into phone_menus (organization_id, name, default_team_id, prompt_id, invalid_prompt_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [org, e.nome, e.time_padrao_id, fala.fala.id, falaInvalida?.fala.id ?? null],
      );
      id = rows[0]!.id;
    }
    await conexao.query(
      `insert into phone_menu_options (organization_id, menu_id, digit, team_id)
       select $1, $2, x.tecla, x.time_id from jsonb_to_recordset($3::jsonb) as x(tecla text, time_id uuid)`,
      [org, id, JSON.stringify(e.opcoes)],
    );

    // A fala de tecla inválida que o menu deixou de ter sai junto, DEPOIS de o menu soltá-la.
    const falaInvalidaDescartada = !e.fala_invalida && travado?.invalid_prompt_id ? travado.invalid_prompt_id : null;
    if (falaInvalidaDescartada) await descartarFala(conexao, org, falaInvalidaDescartada);

    await conexao.query("commit");
    return { ok: true, id, fala, falaInvalida, falaInvalidaDescartada };
  } catch (erro) {
    try {
      await conexao.query("rollback");
    } catch (falha) {
      // A conexão morreu: devolvê-la ao pool entregaria a próxima rota a um socket quebrado.
      descartar = falha instanceof Error ? falha : new Error("rollback falhou");
    }
    const motivo = falhaDoErro(erro);
    if (motivo) return { ok: false, motivo };
    throw erro;
  } finally {
    conexao.release(descartar);
  }
}

const falaJson = (a: string) => `case when ${a}.id is null then null else jsonb_build_object(
  'id', ${a}.id, 'tipo', ${a}.kind, 'texto', ${a}."text", 'voice_id', ${a}.voice_id, 'hash', ${a}.content_hash,
  'status', ${a}.status,
  'erro', ${a}.error, 'duracao_ms', ${a}.duration_ms, 'atualizada_em', ${a}.updated_at) end`;

interface LinhaDoMenu {
  id: string;
  nome: string;
  time_padrao_id: string;
  time_padrao_nome: string;
  opcoes: OpcaoDoMenuPublica[];
  fala: FalaPublica | null;
  fala_invalida: FalaPublica | null;
  numeros: string[];
}

/**
 * O "últimos 7 dias" dos menus (desenho §8): as ligações ENCERRADAS que passaram
 * por eles. Uma ligação em curso ainda pode escolher uma opção — contá-la agora
 * (como "desligou no menu", que é o `menu_outcome` nulo dela) seria contar um
 * desfecho que não aconteceu (`lib/telefonia/ultimos-sete-dias.ts`). O
 * `menu_id is not null` explícito é o predicado do índice parcial
 * `idx_voice_calls_menu_recentes (menu_id, started_at)` da 0288.
 */
export const CONSULTA_DA_SEMANA = `select menu_id, menu_outcome, menu_digit, count(*)::int as n
       from voice_calls
      where organization_id = $1
        and menu_id is not null and menu_id = any($2::uuid[])
        and started_at >= now() - interval '7 days'
        and status = 'ended'
      group by menu_id, menu_outcome, menu_digit`;

/** A data de uma fala lida de `jsonb` sai no mesmo ISO de `falaPublica`. */
const comDataIso = (f: FalaPublica | null): FalaPublica | null =>
  f ? { ...f, atualizada_em: new Date(f.atualizada_em).toISOString() } : null;

export async function menusDaOrg(db: Queryable, organizationId: string): Promise<MenuPublico[]> {
  const { rows } = await db.query<LinhaDoMenu>(
    `select m.id, m.name as nome, m.default_team_id as time_padrao_id, dt.name as time_padrao_nome,
            coalesce((select jsonb_agg(jsonb_build_object('tecla', o.digit, 'time_id', o.team_id, 'time_nome', t.name)
                                       order by o.digit)
                        from phone_menu_options o
                        join attendance_teams t on t.id = o.team_id and t.organization_id = o.organization_id
                       where o.menu_id = m.id and o.organization_id = m.organization_id), '[]'::jsonb) as opcoes,
            ${falaJson("p")} as fala,
            ${falaJson("i")} as fala_invalida,
            coalesce((select jsonb_agg(coalesce(c.display_name, c.phone_number) order by c.created_at)
                        from channel_sessions c
                       where c.organization_id = m.organization_id and c.sip_menu_id = m.id
                         and c.archived_at is null), '[]'::jsonb) as numeros
       from phone_menus m
       join attendance_teams dt on dt.id = m.default_team_id and dt.organization_id = m.organization_id
       left join phone_prompts p on p.id = m.prompt_id and p.organization_id = m.organization_id
       left join phone_prompts i on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id
      where m.organization_id = $1 and m.archived_at is null
      order by m.created_at`,
    [organizationId],
  );
  if (rows.length === 0) return [];
  const { rows: semana } = await db.query<LinhaDoMenuNaSemana & { menu_id: string }>(CONSULTA_DA_SEMANA, [
    organizationId,
    rows.map((r) => r.id),
  ]);
  return rows.map((r) => {
    const fala = comDataIso(r.fala);
    const falaInvalida = comDataIso(r.fala_invalida);
    return {
      ...r,
      fala,
      fala_invalida: falaInvalida,
      pronto: fala?.status === "ready" && (!falaInvalida || falaInvalida.status === "ready"),
      ultimos_7_dias: somarUltimosSeteDias(semana.filter((s) => s.menu_id === r.id)),
    };
  });
}

/**
 * Arquiva o menu, se nenhum número o toca. Arquivar um menu em uso calaria a URA
 * daquele número. O uso é conferido no MESMO comando que arquiva, e não numa
 * leitura antes dele — o que fecha a janela entre "conferi" e "arquivei", mas não
 * serializa com uma troca de destino do número ainda não confirmada: essa troca
 * só trava a linha do menu em `key share` (a FK), que não conflita com este
 * UPDATE. Quem aponta o número para o menu confere `archived_at` do lado dele
 * (`situacaoDoMenuParaNumero`).
 */
export async function arquivarMenu(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<"ok" | "nao_encontrado" | "menu_em_uso"> {
  const { rows } = await db.query<{ id: string }>(
    `update phone_menus m
        set archived_at = now(), updated_at = now()
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null
        and not exists (select 1 from channel_sessions c
                         where c.organization_id = m.organization_id and c.sip_menu_id = m.id and c.archived_at is null)
      returning m.id`,
    [id, organizationId],
  );
  if (rows[0]) return "ok";
  const { rows: motivo } = await db.query<{ em_uso: boolean }>(
    `select exists (select 1 from channel_sessions c
                     where c.organization_id = m.organization_id and c.sip_menu_id = m.id and c.archived_at is null) as em_uso
       from phone_menus m
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [id, organizationId],
  );
  return motivo[0]?.em_uso ? "menu_em_uso" : "nao_encontrado";
}

/** Um número só toca um menu desta organização, não arquivado, com a fala (e a de inválida, se houver) pronta. */
export async function situacaoDoMenuParaNumero(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<"pronto" | "pendente" | "inexistente"> {
  const { rows } = await db.query<{ pronto: boolean }>(
    `select coalesce(p.status = 'ready' and (m.invalid_prompt_id is null or i.status = 'ready'), false) as pronto
       from phone_menus m
       left join phone_prompts p on p.id = m.prompt_id and p.organization_id = m.organization_id
       left join phone_prompts i on i.id = m.invalid_prompt_id and i.organization_id = m.organization_id
      where m.id = $1 and m.organization_id = $2 and m.archived_at is null`,
    [id, organizationId],
  );
  if (!rows[0]) return "inexistente";
  return rows[0].pronto ? "pronto" : "pendente";
}
