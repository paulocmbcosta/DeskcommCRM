/**
 * A TRANSCRIÇÃO DAS LIGAÇÕES GRAVADAS (F4 da spec 20; desenho em
 * docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md)
 * — o vocabulário e as regras puras. Client-safe.
 *
 * Sem import nenhum, de propósito: o cartão da ligação (tela) importa este
 * arquivo, e o que ele puxasse iria para o JavaScript do navegador.
 *
 * Três lugares, cada um com seu papel:
 *  - `voice_call_transcripts.status` é a FONTE DA VERDADE do ciclo
 *    (`ESTADOS_DA_TRANSCRICAO`, espelho do CHECK — conferido contra o Postgres
 *    real por tests/invariants/vocabulario-banco-x-typescript.test.ts). A tabela
 *    guarda o texto, os trechos e o resumo, e NÃO é lida pelo navegador;
 *  - `messages.metadata.voice_call.transcricao` é a PROJEÇÃO para o cartão — só a
 *    situação (`SituacaoDaTranscricao`), nunca o texto: a linha de `messages` vai
 *    inteira, pela REST e pelo Realtime, a qualquer membro que veja a conversa;
 *  - a LISTAGEM de mensagens reescreve a projeção a partir da tabela e acrescenta
 *    o resumo, só para quem pode ouvir a gravação. É a resposta dela que o cartão
 *    lê, por `transcricaoDaLigacao`.
 *
 * QUEM FALOU É ESTIMATIVA. A gravação é a ponte, com as duas vozes no mesmo
 * canal; quem falou cada trecho é deduzido do conteúdo por um modelo de
 * conversa. Medido em 2026-10-09 com gravações reais: acerta a maior parte e
 * erra em respostas curtas ("Isso.", um nome repetido). A tela diz isso.
 */

/** `voice_call_transcripts.status`. */
export const ESTADOS_DA_TRANSCRICAO = ["pending", "ready", "empty", "failed"] as const;
export type EstadoDaTranscricao = (typeof ESTADOS_DA_TRANSCRICAO)[number];

/** A situação que o cartão mostra (`metadata.voice_call.transcricao.situacao`). */
export const SITUACOES_DA_TRANSCRICAO = ["processando", "pronta", "sem_fala", "falhou"] as const;
export type SituacaoDaTranscricao = (typeof SITUACOES_DA_TRANSCRICAO)[number];

export const SITUACAO_DO_ESTADO: Record<EstadoDaTranscricao, SituacaoDaTranscricao> = {
  pending: "processando",
  ready: "pronta",
  empty: "sem_fala",
  failed: "falhou",
};

/**
 * Quem falou um trecho. `sistema` é o que não é nenhuma das duas pessoas: o
 * aviso de gravação, a caixa postal, uma mensagem gravada, ruído ou música que
 * o transcritor transformou em texto.
 */
export const QUEM_FALOU = ["atendente", "cliente", "sistema"] as const;
export type QuemFalou = (typeof QUEM_FALOU)[number];

/** Um trecho, como o transcritor o cortou. `quem` nulo = não deu para saber. */
export interface TrechoDaTranscricao {
  inicio_ms: number;
  fim_ms: number;
  quem: QuemFalou | null;
  texto: string;
}

const numeroValido = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Lê `voice_call_transcripts.segments` e NUNCA lança: o jsonb é aberto. Trecho
 * sem texto, ou com tempo ilegível, fica de fora; `quem` fora do vocabulário (um
 * worker mais novo) vira `null` — o texto continua valendo.
 */
export function trechosDaTranscricao(bruto: unknown): TrechoDaTranscricao[] {
  if (!Array.isArray(bruto)) return [];
  const trechos: TrechoDaTranscricao[] = [];
  for (const item of bruto) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const texto = typeof t.texto === "string" ? t.texto.trim() : "";
    if (!texto || !numeroValido(t.inicio_ms)) continue;
    trechos.push({
      inicio_ms: Math.round(t.inicio_ms),
      fim_ms: numeroValido(t.fim_ms) ? Math.max(Math.round(t.fim_ms), Math.round(t.inicio_ms)) : Math.round(t.inicio_ms),
      quem: (QUEM_FALOU as readonly unknown[]).includes(t.quem) ? (t.quem as QuemFalou) : null,
      texto,
    });
  }
  return trechos;
}

/** O que o cartão sabe da transcrição. `resumo` só chega a quem pode ouvir a gravação. */
export interface TranscricaoNoCartao {
  situacao: SituacaoDaTranscricao;
  resumo: string | null;
}

/**
 * Lê `metadata.voice_call.transcricao` (como a listagem o entrega) e NUNCA
 * lança. Situação fora do vocabulário → `null`, e o cartão cala sobre a
 * transcrição em vez de prometer um texto.
 */
export function transcricaoDaLigacao(bruto: unknown): TranscricaoNoCartao | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const t = bruto as Record<string, unknown>;
  if (!(SITUACOES_DA_TRANSCRICAO as readonly unknown[]).includes(t.situacao)) return null;
  const resumo = typeof t.resumo === "string" ? t.resumo.trim() : "";
  return { situacao: t.situacao as SituacaoDaTranscricao, resumo: resumo || null };
}

/** Uma fala: os trechos seguidos da mesma pessoa, juntos. É o que a tela lista. */
export interface FalaDaTranscricao {
  quem: QuemFalou | null;
  inicio_ms: number;
  texto: string;
}

/** Silêncio maior que isto entre dois trechos da mesma pessoa abre outra fala. */
const PAUSA_QUE_SEPARA_MS = 20_000;
/** Uma fala não passa muito disto: parágrafo sem fim não se lê. */
const TAMANHO_DA_FALA = 600;

/**
 * Junta os trechos seguidos de quem falou em falas — o transcritor corta a cada
 * poucas palavras, e uma linha por corte seria ilegível. Nenhuma palavra some.
 */
export function falasDaTranscricao(trechos: readonly TrechoDaTranscricao[]): FalaDaTranscricao[] {
  const falas: FalaDaTranscricao[] = [];
  let fimDaAnterior = 0;
  for (const t of trechos) {
    const atual = falas[falas.length - 1];
    const continua =
      atual !== undefined &&
      atual.quem === t.quem &&
      t.inicio_ms - fimDaAnterior < PAUSA_QUE_SEPARA_MS &&
      atual.texto.length + t.texto.length < TAMANHO_DA_FALA;
    if (continua && atual) atual.texto = `${atual.texto} ${t.texto}`;
    else falas.push({ quem: t.quem, inicio_ms: t.inicio_ms, texto: t.texto });
    fimDaAnterior = t.fim_ms;
  }
  return falas;
}

/** O texto corrido da ligação, sem rótulo de quem falou — o que vai para `text`. */
export function textoCorrido(trechos: readonly Pick<TrechoDaTranscricao, "texto">[]): string {
  return trechos
    .map((t) => t.texto.trim())
    .filter(Boolean)
    .join(" ");
}

/** O instante de uma fala, como a tela o escreve: `0:07`, `12:40`, `1:03:15`. */
export function marcaDeTempo(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Teto do resumo guardado: é para caber no cartão, em poucas linhas. */
export const TAMANHO_DO_RESUMO = 600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * O id da ligação de uma mensagem que É o registro de uma ligação
 * (`external_id = ligacao:<uuid>`, que só o sistema escreve — trigger da 0289).
 * Qualquer outra coisa → `null`: não vira consulta.
 */
export function ligacaoDoExternalId(externalId: string | null | undefined): string | null {
  if (!externalId?.startsWith("ligacao:")) return null;
  const id = externalId.slice("ligacao:".length);
  return UUID.test(id) ? id : null;
}
