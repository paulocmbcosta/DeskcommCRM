/**
 * AS FALAS DO TELEFONE — salvar a prévia, ler e descartar (desenho da fase 2,
 * §3.1, §4 e D15).
 *
 * Uma fala = uma linha de `phone_prompts` + um arquivo μ-law no bucket privado
 * `phone-prompts`, em `<org>/<hash>.ulaw`, com hash = sha256(modelo, voz, texto)
 * (`hashDaFala`).
 *
 * O áudio nasce na PRÉVIA (`gerarPrevia`, em previa.ts — a única que chama a
 * ElevenLabs). Aqui mora o "Salvar e usar" (`salvarFala`), que NUNCA a chama:
 *  - texto vazio, longo demais ou com o caractere NUL → `texto_recusado` (o
 *    Postgres recusa o NUL com erro, que seria um 500);
 *  - a fala atual já é esta prévia (mesmo tipo, mesmo hash e mesmo texto) e o
 *    objeto dela está no Storage → nada muda. Se o objeto SUMIU, `previa_ausente`
 *    (a pessoa gera a prévia de novo, que regrava o objeto, e salva: a linha é
 *    consertada com a duração do objeto novo);
 *  - senão, o hash tem de ser o do texto com a voz ATUAL da organização
 *    (`previa_desatualizada` se não for: texto editado depois da prévia, ou voz
 *    trocada) e o objeto tem de existir em `<org da SESSÃO>/<hash>.ulaw`
 *    (`previa_ausente`; `armazenamento` se o Storage falhou). O caminho é montado
 *    aqui, nunca recebido;
 *  - passou: a MESMA linha passa a apontar para o hash (ou nasce uma), `ready`,
 *    com a duração do objeto. A partir daí as ligações tocam o áudio novo.
 * Nada daqui apaga o Storage: prévia não salva e áudio sem uso saem na limpeza do
 * worker, 24 h depois de gravados (`FalasNoDisco.limparStorage`).
 *
 * Auditoria (`phone.prompt_saved`) é da ROTA que chama `salvarFala`: é ela que
 * tem o ator, o request id e sabe se `mudou`.
 *
 * SEM import do cliente da ElevenLabs, de propósito: `menus.ts` importa este
 * arquivo e `lib/channels/telefonia/numeros.ts` importa `menus.ts` — o teste-guarda
 * `tests/unit/ligacao-nunca-chama-elevenlabs.test.ts` reprovaria a cadeia.
 *
 * Server-only (sha256 do Node). Banco e Storage entram como portas. O banco é um
 * `Queryable` que ignora a RLS: TODA consulta filtra `organization_id`, e quem
 * chama passa o da sessão — nunca um valor do corpo do pedido.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { logger } from "@/lib/logger";

import type { PortaDoArmazem } from "./armazem";
import { confirmar, desfazer, emTransacao, type PoolDeTransacao } from "./transacao";
import { duracaoDoUlawMs } from "./ulaw";
import {
  MODELO_DE_VOZ_PADRAO,
  TAMANHO_MAXIMO_DA_FALA,
  type EstadoDaFala,
  type FalaGeral,
  type FalaPublica,
  type FalhaDaFala,
  type TipoDeFala,
} from "./vocabulario";

/** sha256 em hexadecimal minúsculo — a régua do CHECK `phone_prompts_hash_check`. */
const FORMATO_DO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * sha256 de modelo + voz + texto. Os três entram como um array JSON, e não colados
 * por um separador: um separador só é seguro se nenhum campo puder contê-lo, e o
 * texto da fala pode ter qualquer caractere. Com o JSON, a fronteira entre os
 * campos faz parte do que é resumido — `("x\nt", "v")` e `("t", "v\nx")` dão hashes
 * diferentes. `JSON.stringify` de um array de strings é determinístico.
 */
export function hashDaFala(texto: string, voiceId: string, modelId: string): string {
  return createHash("sha256").update(JSON.stringify([modelId, voiceId, texto])).digest("hex");
}

/**
 * `<org>/<hash>.ulaw` — o mesmo texto que o CHECK `phone_prompts_storage_path_check`
 * exige (`organization_id::text`, que o Postgres escreve em minúsculas). LANÇA se a
 * organização não for UUID ou o hash não for sha256: nenhum pedaço de fora vira
 * `..` ou `/` no caminho. Quem chama passa a organização da SESSÃO.
 */
export function caminhoDaFala(organizationId: string, hash: string): string {
  const org = organizationId.toLowerCase();
  if (!FORMATO_DE_UUID.test(org)) throw new Error("caminho_da_fala: organização fora do formato");
  if (!FORMATO_DO_HASH.test(hash)) throw new Error("caminho_da_fala: hash fora do formato");
  return `${org}/${hash}.ulaw`;
}

/** O caractere NUL: o Postgres não o aceita em `text` (erro, não truncamento). */
const NUL = "\u0000";

/**
 * O texto pode virar fala? Sem as pontas: não vazio, até `TAMANHO_MAXIMO_DA_FALA`
 * (o CHECK `phone_prompts_text_check`) e sem NUL. A régua ÚNICA da prévia (antes
 * de gastar cota) e do salvar. O `length` do JavaScript conta unidades UTF-16 e o
 * `char_length` do Postgres conta caracteres: um emoji conta 2 aqui e 1 lá, então
 * esta régua é mais estrita que o CHECK, nunca mais frouxa.
 */
export function textoDaFalaValido(texto: string): boolean {
  const t = texto.trim();
  return t.length >= 1 && t.length <= TAMANHO_MAXIMO_DA_FALA && !t.includes(NUL);
}

/**
 * O corpo que salva uma fala: o texto e o hash da PRÉVIA dele (ou da fala em uso,
 * quando o texto não mudou). Caminho do Storage e organização nunca entram —
 * `.strict()` recusa.
 */
export const falaParaSalvarSchema = z
  .object({
    texto: z
      .string()
      .trim()
      .min(1)
      .max(TAMANHO_MAXIMO_DA_FALA)
      .refine((t) => !t.includes(NUL), { message: "texto com caractere inválido" }),
    hash: z.string().regex(FORMATO_DO_HASH),
  })
  .strict();

/** A linha como o `pg` a devolve (datas chegam como `Date`). */
export interface LinhaDaFala {
  id: string;
  tipo: TipoDeFala;
  texto: string;
  voice_id: string;
  model_id: string;
  status: EstadoDaFala;
  erro: string | null;
  duracao_ms: number | null;
  atualizada_em: Date | string;
  content_hash: string;
  storage_path: string | null;
}

export const COLUNAS_DA_FALA = `id, kind as tipo, "text" as texto, voice_id, model_id, status, error as erro,
  duration_ms as duracao_ms, updated_at as atualizada_em, content_hash, storage_path`;

export function falaPublica(l: LinhaDaFala): FalaPublica {
  return {
    id: l.id,
    tipo: l.tipo,
    texto: l.texto,
    voice_id: l.voice_id,
    hash: l.content_hash,
    status: l.status,
    erro: l.erro,
    duracao_ms: l.duracao_ms,
    atualizada_em: new Date(l.atualizada_em).toISOString(),
  };
}

export async function falaPorId(db: Queryable, organizationId: string, id: string): Promise<LinhaDaFala | null> {
  const { rows } = await db.query<LinhaDaFala>(
    `select ${COLUNAS_DA_FALA} from phone_prompts where id = $1 and organization_id = $2`,
    [id, organizationId],
  );
  return rows[0] ?? null;
}

export interface VozDaOrganizacao {
  voiceId: string;
  modelId: string;
}

/** A voz de uma linha de `phone_settings` — a régua única de "a organização escolheu voz?". */
function vozDaLinha(r: { voice_id: string | null; model_id: string | null } | undefined): VozDaOrganizacao | null {
  return r?.voice_id ? { voiceId: r.voice_id, modelId: r.model_id || MODELO_DE_VOZ_PADRAO } : null;
}

export async function vozDaOrganizacao(db: Queryable, organizationId: string): Promise<VozDaOrganizacao | null> {
  const { rows } = await db.query<{ voice_id: string | null; model_id: string | null }>(
    "select voice_id, model_id from phone_settings where organization_id = $1",
    [organizationId],
  );
  return vozDaLinha(rows[0]);
}

/** A coluna de `phone_settings` de cada fala geral — lista fechada: nunca texto de fora no SQL. */
export const COLUNA_DA_FALA_GERAL: Record<FalaGeral, "waiting_prompt_id" | "nobody_prompt_id" | "after_hours_prompt_id"> = {
  waiting: "waiting_prompt_id",
  nobody: "nobody_prompt_id",
  after_hours: "after_hours_prompt_id",
};

export async function falasGeraisDaOrg(
  db: Queryable,
  organizationId: string,
): Promise<Record<FalaGeral, FalaPublica | null>> {
  const { rows } = await db.query<{
    waiting_prompt_id: string | null;
    nobody_prompt_id: string | null;
    after_hours_prompt_id: string | null;
  }>(
    "select waiting_prompt_id, nobody_prompt_id, after_hours_prompt_id from phone_settings where organization_id = $1",
    [organizationId],
  );
  const s = rows[0];
  const ler = async (id: string | null | undefined) => {
    if (!id) return null;
    const l = await falaPorId(db, organizationId, id);
    return l ? falaPublica(l) : null;
  };
  return {
    waiting: await ler(s?.waiting_prompt_id),
    nobody: await ler(s?.nobody_prompt_id),
    after_hours: await ler(s?.after_hours_prompt_id),
  };
}

export interface PedidoDeSalvar {
  db: Queryable;
  armazem: Pick<PortaDoArmazem, "baixar">;
  /** A organização da SESSÃO — é com ela que o caminho do Storage é montado. */
  organizationId: string;
  userId: string | null;
  tipo: TipoDeFala;
  texto: string;
  /** O hash da prévia — o servidor monta o caminho com ele e com a organização da sessão. */
  hash: string;
  /** A fala que esta substitui (a mesma fala geral, o mesmo menu, o mesmo aviso). `null` = nova. */
  falaAtualId: string | null;
  voz: VozDaOrganizacao | null;
}

/** O que a prévia conferida passa a ser. */
export interface NovaFala {
  hash: string;
  caminho: string;
  duracaoMs: number;
  voiceId: string;
  modelId: string;
}

export type FalaConferida =
  | { ok: true; atual: LinhaDaFala; nova: null }
  | { ok: true; atual: LinhaDaFala | null; nova: NovaFala }
  | { ok: false; motivo: FalhaDaFala };

export type ResultadoDoSalvar = { ok: true; fala: FalaPublica; mudou: boolean } | { ok: false; motivo: FalhaDaFala };

interface DadosDaLinha {
  organizationId: string;
  userId: string | null;
  tipo: TipoDeFala;
  texto: string;
  voiceId: string;
  modelId: string;
  hash: string;
  storagePath: string | null;
  duracaoMs: number | null;
  status: EstadoDaFala;
  erro: string | null;
}

async function gravar(db: Queryable, d: DadosDaLinha, idExistente: string | null): Promise<LinhaDaFala> {
  if (idExistente) {
    const { rows } = await db.query<LinhaDaFala>(
      `update phone_prompts
          set "text" = $3, voice_id = $4, model_id = $5, content_hash = $6, storage_path = $7,
              duration_ms = $8, status = $9, error = $10, updated_at = now()
        where id = $1 and organization_id = $2
        returning ${COLUNAS_DA_FALA}`,
      [idExistente, d.organizationId, d.texto, d.voiceId, d.modelId, d.hash, d.storagePath, d.duracaoMs, d.status, d.erro],
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await db.query<LinhaDaFala>(
    `insert into phone_prompts
       (organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status, error, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning ${COLUNAS_DA_FALA}`,
    [d.organizationId, d.tipo, d.texto, d.voiceId, d.modelId, d.hash, d.storagePath, d.duracaoMs, d.status, d.erro, d.userId],
  );
  return rows[0]!;
}

/** O objeto `<org>/<hash>.ulaw` medido no Storage: a duração, ou por que não serve. */
export type MedidaDoObjeto = { ok: true; duracaoMs: number } | { ok: false; motivo: FalhaDaFala };

/**
 * Mede no Storage o objeto do hash pedido: a duração, `previa_ausente` (não existe,
 * ou está vazio) ou `armazenamento` (o Storage falhou — a pessoa não precisa gerar
 * de novo, e a causa vai para o log).
 *
 * O objeto medido é SEMPRE `<org da sessão>/<hash pedido>.ulaw`: no "nada mudou" a
 * fala atual tem esse mesmo hash, e na fala nova o caminho é o do hash. Por isso a
 * medida pode vir ANTES de ler a fala atual — e, na fala geral, antes de abrir a
 * transação. Hash fora de sha256 não é o de texto nenhum: nem se monta caminho.
 */
async function medirObjeto(
  armazem: Pick<PortaDoArmazem, "baixar">,
  organizationId: string,
  hash: string,
): Promise<MedidaDoObjeto> {
  if (!FORMATO_DO_HASH.test(hash)) return { ok: false, motivo: "previa_desatualizada" };
  let bytes: Uint8Array | null;
  try {
    bytes = await armazem.baixar(caminhoDaFala(organizationId, hash));
  } catch (e) {
    logger.error("[telefonia] salvar fala: o Storage falhou ao conferir o áudio", {
      etapa: "conferir_storage",
      organization_id: organizationId,
      causa: e instanceof Error ? e.message.slice(0, 300) : "desconhecida",
    });
    return { ok: false, motivo: "armazenamento" };
  }
  if (!bytes || bytes.length === 0) return { ok: false, motivo: "previa_ausente" };
  return { ok: true, duracaoMs: Math.max(1, duracaoDoUlawMs(bytes.length)) };
}

/**
 * O que a prévia pedida exige, decidido SÓ com a fala atual e a voz — sem Storage:
 *  - `manter`: é a fala em uso (mesmo tipo, mesmo hash, mesmo texto, pronta); falta
 *    conferir que o áudio dela ainda está lá;
 *  - `nova`: o hash é o do texto com a voz atual; falta conferir que a prévia está lá;
 *  - `recusa`: `sem_voz` ou `previa_desatualizada` — o Storage não muda a resposta,
 *    então nem se vai a ele.
 */
type ExigenciaDaFala =
  | { tipo: "manter"; atual: LinhaDaFala }
  | { tipo: "nova"; atual: LinhaDaFala | null; hash: string; voiceId: string; modelId: string }
  | { tipo: "recusa"; motivo: FalhaDaFala };

/** O que a decisão lê do pedido — sem banco nem Storage. */
export type PedidoDaDecisao = Pick<PedidoDeSalvar, "organizationId" | "tipo" | "texto" | "hash" | "voz">;

/**
 * A prévia pedida É a fala em uso: mesmo tipo, pronta, mesmo hash e mesmo texto.
 * A régua ÚNICA do "nada mudou" — `exigenciaDaFala` decide com ela, e o aviso de
 * instabilidade (emergencias.ts) a usa para ligar com o texto salvo sem ir ao
 * Storage. Pura.
 */
export function ehAFalaEmUso(
  p: Pick<PedidoDaDecisao, "tipo" | "texto" | "hash">,
  lida: LinhaDaFala | null,
): lida is LinhaDaFala {
  return (
    lida !== null &&
    lida.tipo === p.tipo &&
    lida.status === "ready" &&
    lida.content_hash === p.hash &&
    lida.texto === p.texto.trim()
  );
}

function exigenciaDaFala(p: PedidoDaDecisao, lida: LinhaDaFala | null): ExigenciaDaFala {
  const texto = p.texto.trim();
  // Uma fala de OUTRO tipo não é "a atual" desta: nem vale como "nada mudou", nem
  // é regravada (a coluna `kind` não muda no UPDATE) — nasce uma linha do tipo pedido.
  const atual = lida && lida.tipo === p.tipo ? lida : null;
  if (ehAFalaEmUso(p, atual)) return { tipo: "manter", atual };
  if (!p.voz) return { tipo: "recusa", motivo: "sem_voz" };
  const { voiceId, modelId } = p.voz;
  if (p.hash !== hashDaFala(texto, voiceId, modelId)) return { tipo: "recusa", motivo: "previa_desatualizada" };
  return { tipo: "nova", atual, hash: p.hash, voiceId, modelId };
}

/** A exigência atendida (ou não) pelo que o Storage disse do objeto. Pura. */
function concluirFala(
  organizationId: string,
  e: Exclude<ExigenciaDaFala, { tipo: "recusa" }>,
  objeto: MedidaDoObjeto,
): FalaConferida {
  if (!objeto.ok) return objeto;
  if (e.tipo === "manter") {
    // "Nada mudou" só vale se o áudio em uso ainda existe: uma linha `ready` que
    // aponta para objeto sumido faz a ligação pular a fala, e o "Salvar" diria
    // que está tudo certo. A voz e o modelo são os DA FALA, não os atuais da
    // organização: é o áudio em uso que se confere (e se conserta).
    const { atual } = e;
    if (objeto.duracaoMs === atual.duracao_ms) return { ok: true, atual, nova: null };
    // O objeto foi regravado por uma prévia nova do mesmo texto: outra síntese,
    // outra duração. A linha passa a dizer a duração do áudio que está guardado.
    return {
      ok: true,
      atual,
      nova: {
        hash: atual.content_hash,
        caminho: caminhoDaFala(organizationId, atual.content_hash),
        duracaoMs: objeto.duracaoMs,
        voiceId: atual.voice_id,
        modelId: atual.model_id,
      },
    };
  }
  return {
    ok: true,
    atual: e.atual,
    nova: { hash: e.hash, caminho: caminhoDaFala(organizationId, e.hash), duracaoMs: objeto.duracaoMs, voiceId: e.voiceId, modelId: e.modelId },
  };
}

/**
 * A DECISÃO inteira do "Salvar e usar", pura, com o objeto JÁ medido — a forma da
 * fala geral, que mede o Storage fora da trava e decide sob ela. As falhas saem na
 * ordem de sempre: `sem_voz` e `previa_desatualizada` antes do que o Storage disse.
 */
function decidirFala(p: PedidoDaDecisao, lida: LinhaDaFala | null, objeto: MedidaDoObjeto): FalaConferida {
  const e = exigenciaDaFala(p, lida);
  if (e.tipo === "recusa") return { ok: false, motivo: e.motivo };
  return concluirFala(p.organizationId, e, objeto);
}

/**
 * A prévia pedida pode virar a fala? NÃO grava nada — o menu confere as duas falas
 * (a dele e a de tecla inválida) antes de gravar a primeira.
 *
 * Sem trava, então na ordem mais barata: a fala atual e as exigências primeiro, e
 * o Storage só quando a resposta depende dele — `sem_voz` e `previa_desatualizada`
 * não leem o Storage (nem registram falha dele no log).
 */
export async function conferirFala(p: PedidoDeSalvar): Promise<FalaConferida> {
  if (!textoDaFalaValido(p.texto)) return { ok: false, motivo: "texto_recusado" };
  const lida = p.falaAtualId ? await falaPorId(p.db, p.organizationId, p.falaAtualId) : null;
  const e = exigenciaDaFala(p, lida);
  if (e.tipo === "recusa") return { ok: false, motivo: e.motivo };
  return concluirFala(p.organizationId, e, await medirObjeto(p.armazem, p.organizationId, p.hash));
}

/**
 * A decisão de novo, SOB A TRAVA de quem grava a fala numa transação própria (o
 * menu, em menus.ts), da prévia que `conferirFala` aprovou FORA dela: com a fala
 * atual RELIDA na transação e sem voltar ao Storage — a mesma forma de
 * `salvarFalaGeral` (mede fora, decide dentro). Pura.
 *
 * Por que decidir de novo: entre a conferência e a trava, outra gravação do mesmo
 * menu pode ter criado ou trocado a fala. Gravar com a decisão velha criaria uma
 * segunda linha (a primeira fica órfã, e mantém o objeto vivo para sempre) ou
 * tomaria como "nada mudou" uma fala que já é outra.
 *
 * A medida do objeto sai da própria aprovação, e é exata: nas duas formas dela o
 * objeto medido é o `<org>/<hash pedido>.ulaw` (`medirObjeto`), com a duração em
 * `nova`; sem `nova`, a duração é a da fala atual, que é o que `concluirFala`
 * exige para não mudar nada.
 */
export function reconferirFala(
  p: PedidoDaDecisao,
  lida: LinhaDaFala | null,
  aprovada: Extract<FalaConferida, { ok: true }>,
): FalaConferida {
  const duracaoMs = aprovada.nova ? aprovada.nova.duracaoMs : aprovada.atual.duracao_ms;
  if (duracaoMs === null) return { ok: false, motivo: "previa_ausente" };
  return decidirFala(p, lida, { ok: true, duracaoMs });
}

/** Grava o que `conferirFala` aprovou: a MESMA linha passa a apontar para o hash novo (ou nasce uma). */
export async function gravarFalaConferida(
  p: PedidoDeSalvar,
  c: Extract<FalaConferida, { ok: true }>,
): Promise<{ fala: FalaPublica; mudou: boolean }> {
  if (c.nova === null) return { fala: falaPublica(c.atual), mudou: false };
  const linha = await gravar(
    p.db,
    {
      organizationId: p.organizationId,
      userId: p.userId,
      tipo: p.tipo,
      texto: p.texto.trim(),
      voiceId: c.nova.voiceId,
      modelId: c.nova.modelId,
      hash: c.nova.hash,
      storagePath: c.nova.caminho,
      duracaoMs: c.nova.duracaoMs,
      status: "ready",
      erro: null,
    },
    c.atual?.id ?? null,
  );
  return { fala: falaPublica(linha), mudou: true };
}

/** O "Salvar e usar": confere e grava. Nunca chama a ElevenLabs. */
export async function salvarFala(p: PedidoDeSalvar): Promise<ResultadoDoSalvar> {
  const c = await conferirFala(p);
  if (!c.ok) return c;
  return { ok: true, ...(await gravarFalaConferida(p, c)) };
}

/** Remove a linha (ex.: a fala de tecla inválida que o menu deixou de ter). O objeto fica para a limpeza do worker. */
export async function descartarFala(db: Queryable, organizationId: string, id: string): Promise<void> {
  await db.query("delete from phone_prompts where id = $1 and organization_id = $2", [id, organizationId]);
}

// Os tipos da conexão moram em transacao.ts (a transação única do telefone); o
// reexport mantém quem já os importava daqui.
export type { ConexaoDaTransacao, PoolDeTransacao } from "./transacao";

export interface PedidoDaFalaGeral {
  pool: PoolDeTransacao;
  armazem: Pick<PortaDoArmazem, "baixar">;
  /** A organização da SESSÃO — a da linha travada e a do caminho do Storage. */
  organizationId: string;
  userId: string | null;
  tipo: FalaGeral;
  texto: string;
  hash: string;
}

/** O `lock_timeout` das gravações do telefone: quem espera a trava mais que isto desiste. */
export const PRAZO_DA_TRAVA = "4s";

/**
 * O "Salvar e usar" de uma fala GERAL (`waiting`, `nobody`, `after_hours`): confere
 * e grava a fala e aponta a coluna do tipo em `phone_settings`, numa transação só,
 * SOB A TRAVA da linha de `phone_settings` da organização.
 *
 * Por que a trava: a fala atual (a coluna do tipo) e a voz são lidas ANTES de
 * decidir entre regravar a linha de `phone_prompts` que existe ou criar uma. Sem
 * trava, duas primeiras gravações simultâneas da mesma fala leem as duas "não há
 * fala", criam UMA LINHA CADA, e a coluna fica com a última: a outra linha fica
 * órfã, e a referência dela mantém o objeto do Storage vivo para sempre (a
 * limpeza só apaga objeto que nenhuma linha referencia). Com o `select ... for
 * update`, a segunda espera a primeira confirmar e lê a fala que ela gravou — e a
 * regrava, ou vê que nada mudou.
 *
 * A ordem, e por quê:
 *  1. O Storage é conferido ANTES do `begin`, sem conexão do pool na mão. O
 *     supabase-js não tem prazo, e um Storage lento com a trava segura prenderia a
 *     linha da organização e uma das conexões que as rotas da IA e do MCP também
 *     usam. Conferir fora não reabre a corrida: salvar nunca escreve nem apaga
 *     objeto, e o objeto medido é sempre `<org>/<hash>.ulaw` (`medirObjeto`).
 *  2. `begin` e `set local lock_timeout`: quem espera a trava mais que
 *     `PRAZO_DA_TRAVA` desiste com `gravacao_em_andamento` (409) em vez de ficar
 *     preso — o papel da conexão direta não tem `lock_timeout` de papel.
 *  3. O upsert da linha vem ANTES da trava porque `for update` não trava linha que
 *     não existe: sem ele, a primeira fala de uma organização sem `phone_settings`
 *     ficaria sem trava nenhuma.
 *  4. Com a trava: a fala atual, a decisão PURA (`decidirFala`) e a gravação. Nada
 *     aqui espera rede. Recusa (ou erro) desfaz tudo, inclusive a linha do upsert.
 * A transação é a `emTransacao` (transacao.ts): prazo, rollback, 55P03 e a conexão
 * descartada quando o rollback falha moram lá, uma vez só.
 */
export async function salvarFalaGeral(p: PedidoDaFalaGeral): Promise<ResultadoDoSalvar> {
  if (!textoDaFalaValido(p.texto)) return { ok: false, motivo: "texto_recusado" };
  const objeto = await medirObjeto(p.armazem, p.organizationId, p.hash);

  const coluna = COLUNA_DA_FALA_GERAL[p.tipo];
  return emTransacao<ResultadoDoSalvar>(p.pool, PRAZO_DA_TRAVA, async (conexao) => {
    await conexao.query("insert into phone_settings (organization_id) values ($1) on conflict (organization_id) do nothing", [
      p.organizationId,
    ]);
    const { rows } = await conexao.query<{ voice_id: string | null; model_id: string | null; fala_atual_id: string | null }>(
      `select voice_id, model_id, ${coluna} as fala_atual_id from phone_settings where organization_id = $1 for update`,
      [p.organizationId],
    );
    const linha = rows[0];
    const pedido: PedidoDeSalvar = {
      db: conexao,
      armazem: p.armazem,
      organizationId: p.organizationId,
      userId: p.userId,
      tipo: p.tipo,
      texto: p.texto,
      hash: p.hash,
      falaAtualId: linha?.fala_atual_id ?? null,
      voz: vozDaLinha(linha),
    };
    const lida = pedido.falaAtualId ? await falaPorId(conexao, p.organizationId, pedido.falaAtualId) : null;
    const c = decidirFala(pedido, lida, objeto);
    if (!c.ok) return desfazer(c);
    const r = await gravarFalaConferida(pedido, c);
    if (r.mudou) {
      await conexao.query(`update phone_settings set ${coluna} = $2, updated_at = now() where organization_id = $1`, [
        p.organizationId,
        r.fala.id,
      ]);
    }
    return confirmar({ ok: true, ...r });
  });
}
