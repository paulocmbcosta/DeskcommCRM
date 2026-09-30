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
 * Toda escrita que depende de o menu estar ATIVO — salvar, arquivar, apontar um
 * número para ele — trava a linha dele com `travarMenuAtivo` dentro da própria
 * transação. É o que impede um número de terminar tocando um menu arquivado
 * (o contrato está no comentário da função).
 *
 * SALVAR (`salvarMenuDaOrg`) é em duas fases, a forma de `salvarFalaGeral`:
 *  1. FORA da transação, sem conexão do pool na mão: as recusas baratas (tecla
 *     repetida, time de fora, menu de outra organização) e a conferência das DUAS
 *     falas — a do menu e a de tecla inválida — contra as prévias no Storage
 *     (`conferirFala`). As duas antes de gravar a primeira: prévia que não confere
 *     não salva menu nenhum. O Storage não tem prazo no supabase-js, e lido com a
 *     trava segura prenderia a linha do menu e uma conexão que as rotas da IA e do
 *     MCP também usam.
 *  2. Numa transação com `lock_timeout` (`emTransacao`): trava a linha do menu
 *     (`travarMenuAtivo`, `for no key update`),
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
  PRAZO_DA_TRAVA,
  conferirFala,
  descartarFala,
  falaParaSalvarSchema,
  falaPorId,
  gravarFalaConferida,
  reconferirFala,
  vozDaOrganizacao,
  type FalaConferida,
  type PedidoDeSalvar,
} from "./falas";
import { numeroParaFalar, trocarMarcador } from "./texto-do-menu";
import { confirmar, desfazer, emTransacao, type PoolDeTransacao } from "./transacao";
import { somarUltimosSeteDias, type LinhaDoMenuNaSemana } from "./ultimos-sete-dias";
import {
  TAMANHO_MAXIMO_DO_NOME_DO_MENU,
  TECLAS_DO_MENU,
  teclaRepetida,
  type FalaPublica,
  type FalhaDaFala,
  type MenuPublico,
  type OpcaoDoMenuPublica,
  type TipoDeFala,
  type UltimosSeteDias,
} from "./vocabulario";

// A regra da tecla repetida mora no vocabulário (client-safe): o editor da aba
// Menus pergunta lá, sem puxar este arquivo (server-only) para o navegador.
export { teclaRepetida };

export const menuSchema = z
  .object({
    nome: z.string().trim().min(1).max(TAMANHO_MAXIMO_DO_NOME_DO_MENU),
    opcoes: z
      .array(z.object({ tecla: z.string().regex(/^[0-9]$/), time_id: z.string().uuid() }).strict())
      .min(1)
      .max(TECLAS_DO_MENU.length),
    time_padrao_id: z.string().uuid(),
    // O texto e o hash da PRÉVIA da fala do menu — ou os da fala em uso, se o texto
    // não mudou. Nunca um caminho do Storage: quem o monta é o servidor.
    fala: falaParaSalvarSchema,
    // Ausente ou `null` = o menu não tem fala de tecla inválida (a URA só repete o menu).
    fala_invalida: falaParaSalvarSchema.nullish().transform((v) => v ?? null),
    // v3: o cliente pode digitar o ramal de alguém. Ausente = não (a tela da v1 não manda).
    aceita_ramal: z.boolean().optional().default(false),
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

/** Um número que toca o menu, como o banco o guarda: o nome dado a ele (se houver) e o número. */
export interface NumeroDoMenu {
  nome: string | null;
  numero: string | null;
}

/**
 * Como a tela e a recusa mostram um número: "Recepção · (61) 3686-1503" com os
 * dois (o número já traz parênteses; outro par em volta ficaria dobrado); só o
 * nome, ou só o número, quando falta o outro — ou quando o nome É o número.
 */
export function rotuloDoNumero(n: NumeroDoMenu): string {
  const nome = n.nome?.trim() || null;
  const bruto = n.numero?.trim() || null;
  const numero = bruto ? (numeroParaFalar(bruto) ?? bruto) : null;
  if (nome && numero) return nome.replace(/\D/g, "") === bruto!.replace(/\D/g, "") ? numero : `${nome} · ${numero}`;
  return nome ?? numero ?? "";
}

/** O menu em uso por um número (ou vários), NOMEANDO-os. `{numero}`/`{numeros}` entram depois da tradução. */
export const MENSAGEM_DO_MENU_EM_USO = {
  um: "Este menu está em uso por: {numero}. Troque o destino do número antes de arquivar.",
  varios: "Este menu está em uso por: {numeros}. Troque o destino dos números antes de arquivar.",
} as const;

/**
 * A recusa de arquivar, com os números que usam o menu. `t` traduz o MODELO (a
 * chave do dicionário é o texto com o marcador) e os rótulos entram depois.
 */
export function mensagemDoMenuEmUso(numeros: readonly NumeroDoMenu[], t: (texto: string) => string = (x) => x): string {
  const rotulos = numeros.map(rotuloDoNumero).filter(Boolean);
  if (rotulos.length === 0) return t(MENSAGEM_DA_FALHA_DO_MENU.menu_em_uso);
  if (rotulos.length === 1) return trocarMarcador(t(MENSAGEM_DO_MENU_EM_USO.um), "{numero}", rotulos[0]!);
  return trocarMarcador(t(MENSAGEM_DO_MENU_EM_USO.varios), "{numeros}", rotulos.join(", "));
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

/** A linha do menu travada por `travarMenuAtivo`. */
export interface MenuTravado {
  id: string;
  prompt_id: string | null;
  invalid_prompt_id: string | null;
}

/**
 * TRAVA a linha de um menu ATIVO desta organização (`select … for no key update`)
 * e o devolve — ou `null` se ele não existe, é de outra organização ou está arquivado.
 *
 * CONTRATO de quem chama:
 *  - `cliente` é UMA conexão com a transação JÁ aberta (`begin`), com
 *    `set local lock_timeout` — esperar a trava para sempre não é opção. Pelo pool
 *    solto a trava acaba com o comando e não protege nada;
 *  - a escrita que depende de o menu estar ativo vem DEPOIS, na MESMA transação,
 *    num comando SEPARADO (em READ COMMITTED cada comando tem snapshot novo: é o
 *    comando seguinte que enxerga o que a transação que segurava a trava confirmou);
 *  - `null` = recusar e desfazer (`rollback`), sem escrever.
 *
 * É a catraca comum das três escritas que dependem do menu ativo — salvar o menu
 * (`salvarMenuDaOrg`), arquivá-lo (`arquivarMenu`) e apontar um número para ele
 * (`lib/channels/telefonia/numeros.ts`, na transação da troca do destino). As três
 * travam a MESMA linha em `for no key update`, que conflita consigo mesmo, e por
 * isso se serializam:
 *  - arquivar primeiro: quem aponta o número espera a trava; quando o arquivamento
 *    confirma, o Postgres reconfere `archived_at is null` na versão nova da linha e
 *    devolve `null` — nenhum número passa a tocar um menu arquivado;
 *  - apontar primeiro: o arquivamento espera; o comando seguinte dele já vê o
 *    número e recusa com `menu_em_uso`.
 * A FK composta `channel_sessions → phone_menus` sozinha NÃO serializa: ela trava o
 * menu em `key share`, que não conflita com o UPDATE de `archived_at` — e o
 * `not exists` de um comando só é avaliado com o snapshot do início dele, sem ver
 * o número recém-apontado.
 *
 * Por que `for no key update` e não `for update`: a LIGAÇÃO também toca esta linha.
 * O INSERT em `voice_calls` com `menu_id` confere a FK composta com `key share`, e
 * `for update` conflita com `key share` — quem salva o menu faria uma ligação
 * esperar (e cair no `lock_timeout` do worker). `for no key update` não conflita
 * com `key share`, e nenhuma das três escritas muda a chave do menu (`id`,
 * `organization_id`). tests/invariants/telefonia-menus-no-banco.test.ts mede as
 * três coisas, com os controles.
 */
export async function travarMenuAtivo(cliente: Queryable, organizationId: string, menuId: string): Promise<MenuTravado | null> {
  const { rows } = await cliente.query<MenuTravado>(
    `select id, prompt_id, invalid_prompt_id from phone_menus
      where id = $1 and organization_id = $2 and archived_at is null
      for no key update`,
    [menuId, organizationId],
  );
  return rows[0] ?? null;
}

/** Os números ATIVOS da organização que tocam o menu, na ordem em que foram criados. */
export async function numerosDoMenu(db: Queryable, organizationId: string, menuId: string): Promise<NumeroDoMenu[]> {
  const { rows } = await db.query<NumeroDoMenu>(
    `select c.display_name as nome, c.phone_number as numero from channel_sessions c
      where c.organization_id = $1 and c.sip_menu_id = $2 and c.archived_at is null
      order by c.created_at`,
    [organizationId, menuId],
  );
  return rows;
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

/** O menu como a transação o gravou — o `MenuPublico` sem a semana, que é leitura à parte (`semanaDoMenu`). */
export type MenuSalvo = Omit<MenuPublico, "ultimos_7_dias">;

export type ResultadoDoSalvarMenu =
  | {
      ok: true;
      id: string;
      menu: MenuSalvo;
      fala: FalaGravada;
      falaInvalida: FalaGravada | null;
      /** A fala de tecla inválida que o menu deixou de ter e saiu junto (a limpeza do worker leva o objeto). */
      falaInvalidaDescartada: string | null;
    }
  | { ok: false; motivo: Exclude<FalhaDoMenu, "menu_em_uso"> }
  | { ok: false; motivo: FalhaDaFala; fala: QualFala };

/** Sob a trava ninguém lê o Storage: a porta que a decisão NÃO pode usar lança se for usada. */
const SEM_STORAGE_SOB_A_TRAVA: Pick<PortaDoArmazem, "baixar"> = {
  baixar: async () => {
    throw new Error("menus: o Storage não é lido com a trava do menu segura");
  },
};

type ErroDoPg = { code?: unknown; constraint?: unknown } | null;

/**
 * O que um erro do Postgres na transação significa para quem salva — ou `null`, e
 * ele sobe. O 55P03 (prazo da trava) é traduzido por `emTransacao`.
 */
function falhaDoErro(e: unknown): "time_invalido" | "tecla_repetida" | null {
  const { code, constraint } = (e ?? {}) as NonNullable<ErroDoPg>;
  // A FK composta do time (time padrão ou de uma opção) — o time sumiu ou é de outra organização.
  if (code === "23503" && typeof constraint === "string" && /team_id_fkey$/.test(constraint)) return "time_invalido";
  // A chave (menu_id, digit) das opções.
  if (code === "23505" && constraint === "phone_menu_options_pkey") return "tecla_repetida";
  return null;
}

/** A coluna de `phone_menus` de cada fala do menu — lista fechada: nunca texto de fora no SQL. */
const COLUNA_DA_FALA_DO_MENU: Record<QualFala, "prompt_id" | "invalid_prompt_id"> = {
  menu: "prompt_id",
  invalida: "invalid_prompt_id",
};

type PonteirosDasFalas = Record<"prompt_id" | "invalid_prompt_id", string | null>;

/**
 * Grava o menu (novo, se `id` é `null`, ou o travado) e TROCA as opções dele.
 * Devolve o id. Dentro da transação de `salvarMenuDaOrg`, com a trava do menu
 * segura. É aqui que a versão 3 (ramais) mexe: `accepts_extension` entra ao lado
 * de nome, time padrão e falas.
 */
async function gravarMenuEOpcoes(
  c: Queryable,
  org: string,
  id: string | null,
  e: EntradaDoMenu,
  falas: PonteirosDasFalas,
): Promise<string> {
  let menuId = id;
  if (menuId) {
    await c.query(
      `update phone_menus
          set name = $3, default_team_id = $4, prompt_id = $5, invalid_prompt_id = $6, accepts_extension = $7,
              updated_at = now()
        where id = $1 and organization_id = $2 and archived_at is null`,
      [menuId, org, e.nome, e.time_padrao_id, falas.prompt_id, falas.invalid_prompt_id, e.aceita_ramal],
    );
    await c.query("delete from phone_menu_options where menu_id = $1 and organization_id = $2", [menuId, org]);
  } else {
    const { rows } = await c.query<{ id: string }>(
      `insert into phone_menus (organization_id, name, default_team_id, prompt_id, invalid_prompt_id, accepts_extension)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [org, e.nome, e.time_padrao_id, falas.prompt_id, falas.invalid_prompt_id, e.aceita_ramal],
    );
    menuId = rows[0]!.id;
  }
  await c.query(
    `insert into phone_menu_options (organization_id, menu_id, digit, team_id)
     select $1, $2, x.tecla, x.time_id from jsonb_to_recordset($3::jsonb) as x(tecla text, time_id uuid)`,
    [org, menuId, JSON.stringify(e.opcoes)],
  );
  return menuId;
}

/**
 * O menu gravado como a tela o vê, montado com o que a transação acabou de gravar
 * — sem reler a lista inteira. Os nomes dos times e os números que o tocam são
 * lidos na mesma transação; menu novo não tem número (ninguém aponta para um menu
 * que ainda não foi confirmado).
 */
async function descreverMenu(
  c: Queryable,
  org: string,
  id: string,
  novo: boolean,
  e: EntradaDoMenu,
  fala: FalaPublica,
  falaInvalida: FalaPublica | null,
): Promise<MenuSalvo> {
  const ids = [...new Set([...e.opcoes.map((o) => o.time_id), e.time_padrao_id])];
  const { rows: times } = await c.query<{ id: string; name: string }>(
    "select id, name from attendance_teams where organization_id = $1 and id = any($2::uuid[])",
    [org, ids],
  );
  const nomeDo = (timeId: string) => times.find((t) => t.id === timeId)?.name ?? "";
  const numeros = novo ? [] : await numerosDoMenu(c, org, id);
  return {
    id,
    nome: e.nome,
    time_padrao_id: e.time_padrao_id,
    time_padrao_nome: nomeDo(e.time_padrao_id),
    opcoes: [...e.opcoes]
      .sort((a, b) => a.tecla.localeCompare(b.tecla))
      .map((o) => ({ tecla: o.tecla, time_id: o.time_id, time_nome: nomeDo(o.time_id) })),
    fala,
    fala_invalida: falaInvalida,
    pronto: fala.status === "ready" && (!falaInvalida || falaInvalida.status === "ready"),
    numeros: numeros.map(rotuloDoNumero),
    aceita_ramal: e.aceita_ramal,
  };
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
    const pedido = pedidoDaFala(qual, pool, p.armazem, atual?.[COLUNA_DA_FALA_DO_MENU[qual]] ?? null);
    if (!pedido) continue;
    const c = await conferirFala(pedido);
    if (!c.ok) return { ok: false, motivo: c.motivo, fala: qual };
    aprovadas[qual] = c;
  }

  // ── Fase 2: a transação, sob a trava do menu ─────────────────────────────
  return emTransacao<ResultadoDoSalvarMenu>(
    pool,
    PRAZO_DA_TRAVA,
    async (conexao) => {
      const travado = p.id ? await travarMenuAtivo(conexao, org, p.id) : null;
      if (p.id && !travado) return desfazer({ ok: false, motivo: "nao_encontrado" });

      const gravadas: Partial<Record<QualFala, FalaGravada>> = {};
      for (const qual of ["menu", "invalida"] as const) {
        const aprovada = aprovadas[qual];
        const idAtual = travado?.[COLUNA_DA_FALA_DO_MENU[qual]] ?? null;
        const pedido = pedidoDaFala(qual, conexao, SEM_STORAGE_SOB_A_TRAVA, idAtual);
        if (!aprovada || !pedido) continue;
        const lida = idAtual ? await falaPorId(conexao, org, idAtual) : null;
        const c = reconferirFala(pedido, lida, aprovada);
        if (!c.ok) return desfazer({ ok: false, motivo: c.motivo, fala: qual });
        gravadas[qual] = await gravarFalaConferida(pedido, c);
      }
      const fala = gravadas.menu!;
      const falaInvalida = gravadas.invalida ?? null;

      const id = await gravarMenuEOpcoes(conexao, org, p.id, e, {
        prompt_id: fala.fala.id,
        invalid_prompt_id: falaInvalida?.fala.id ?? null,
      });

      // A fala de tecla inválida que o menu deixou de ter sai junto, DEPOIS de o menu soltá-la.
      const falaInvalidaDescartada = !e.fala_invalida && travado?.invalid_prompt_id ? travado.invalid_prompt_id : null;
      if (falaInvalidaDescartada) await descartarFala(conexao, org, falaInvalidaDescartada);

      const menu = await descreverMenu(conexao, org, id, !p.id, e, fala.fala, falaInvalida?.fala ?? null);
      return confirmar({ ok: true, id, menu, fala, falaInvalida, falaInvalidaDescartada });
    },
    (erro) => {
      const motivo = falhaDoErro(erro);
      return motivo ? { ok: false, motivo } : null;
    },
  );
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
  /** Nome e número de cada um; a lista devolve o rótulo pronto (`rotuloDoNumero`). */
  numeros: NumeroDoMenu[];
  aceita_ramal: boolean;
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
            m.accepts_extension as aceita_ramal,
            coalesce((select jsonb_agg(jsonb_build_object('tecla', o.digit, 'time_id', o.team_id, 'time_nome', t.name)
                                       order by o.digit)
                        from phone_menu_options o
                        join attendance_teams t on t.id = o.team_id and t.organization_id = o.organization_id
                       where o.menu_id = m.id and o.organization_id = m.organization_id), '[]'::jsonb) as opcoes,
            ${falaJson("p")} as fala,
            ${falaJson("i")} as fala_invalida,
            coalesce((select jsonb_agg(jsonb_build_object('nome', c.display_name, 'numero', c.phone_number)
                                       order by c.created_at)
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
      numeros: r.numeros.map(rotuloDoNumero),
      pronto: fala?.status === "ready" && (!falaInvalida || falaInvalida.status === "ready"),
      ultimos_7_dias: somarUltimosSeteDias(semana.filter((s) => s.menu_id === r.id)),
    };
  });
}

/** O "últimos 7 dias" de UM menu — a mesma régua de `menusDaOrg`, só para ele. */
export async function semanaDoMenu(db: Queryable, organizationId: string, menuId: string): Promise<UltimosSeteDias> {
  const { rows } = await db.query<LinhaDoMenuNaSemana & { menu_id: string }>(CONSULTA_DA_SEMANA, [organizationId, [menuId]]);
  return somarUltimosSeteDias(rows);
}

export type ResultadoDoArquivar =
  /** `falasDescartadas` = as linhas de `phone_prompts` do menu que saíram junto. */
  | { ok: true; falasDescartadas: string[] }
  | { ok: false; motivo: "nao_encontrado" | "gravacao_em_andamento" }
  /** `numeros` = os números que tocam o menu — a tela os mostra (`rotuloDoNumero`). */
  | { ok: false; motivo: "menu_em_uso"; numeros: NumeroDoMenu[] };

/**
 * Arquiva o menu, se nenhum número o toca: arquivar um menu em uso calaria a URA
 * daquele número. Numa transação (`emTransacao`), em comandos SEPARADOS: trava a
 * linha do menu (`travarMenuAtivo`); DEPOIS, num comando próprio (snapshot novo),
 * confere os números ativos que apontam para ele; só então arquiva. Num comando só
 * (`update … where not exists`), a subconsulta usaria o snapshot do início do
 * comando e não veria um número apontado por uma transação que acabou de
 * confirmar — nem esperaria por uma que ainda não confirmou.
 *
 * As FALAS do menu saem na mesma transação: a linha de `phone_prompts` de cada uma
 * é apagada, as FKs de `phone_menus.prompt_id`/`invalid_prompt_id` (`set null`
 * da coluna) soltam o menu, e os objetos, sem referência, saem do Storage na
 * limpeza do worker (24 h). Sem isso, a referência de um menu arquivado manteria
 * o áudio vivo para sempre. O menu fica — é dele que `voice_calls.menu_id` fala.
 */
export async function arquivarMenu(pool: PoolDeTransacao, organizationId: string, id: string): Promise<ResultadoDoArquivar> {
  return emTransacao<ResultadoDoArquivar>(pool, PRAZO_DA_TRAVA, async (conexao) => {
    const menu = await travarMenuAtivo(conexao, organizationId, id);
    if (!menu) return desfazer({ ok: false, motivo: "nao_encontrado" });
    const numeros = await numerosDoMenu(conexao, organizationId, id);
    if (numeros.length > 0) return desfazer({ ok: false, motivo: "menu_em_uso", numeros });
    await conexao.query(
      "update phone_menus set archived_at = now(), updated_at = now() where id = $1 and organization_id = $2",
      [id, organizationId],
    );
    const falas = [menu.prompt_id, menu.invalid_prompt_id].filter((f): f is string => f !== null);
    let falasDescartadas: string[] = [];
    if (falas.length > 0) {
      const { rows } = await conexao.query<{ id: string }>(
        "delete from phone_prompts where organization_id = $1 and id = any($2::uuid[]) returning id",
        [organizationId, falas],
      );
      falasDescartadas = rows.map((r) => r.id);
    }
    return confirmar({ ok: true, falasDescartadas });
  });
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
