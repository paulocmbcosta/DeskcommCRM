/**
 * A GRAVAÇÃO DAS LIGAÇÕES DO TELEFONE (F3 da spec 20; desenho em
 * docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md)
 * — o vocabulário e as regras puras. Client-safe.
 *
 * Sem import nenhum, de propósito: o cartão da ligação (tela) importa este
 * arquivo, e o que ele puxasse iria para o JavaScript do navegador.
 *
 * Três lugares, cada um com seu papel:
 *  - `voice_calls.recording_status` é a FONTE DA VERDADE do ciclo da gravação
 *    (`ESTADOS_DA_GRAVACAO`, espelho do CHECK — conferido contra o Postgres real
 *    por tests/invariants/vocabulario-banco-x-typescript.test.ts);
 *  - `messages.media_storage_path` da mensagem da ligação aponta o arquivo (por
 *    estar ali, a gravação entra na cascata de anonimização que já existe);
 *  - `messages.metadata.voice_call.gravacao` é a PROJEÇÃO para o cartão
 *    (`SituacaoDaGravacao`), escrita só por quem muda o estado, sempre mesclando
 *    no banco — e lida só por `gravacaoDaLigacao`, nunca pelo path cru.
 */

/** `voice_calls.recording_status` — nulo é "não gravada". */
export const ESTADOS_DA_GRAVACAO = ["recording", "stored", "failed", "expired"] as const;
export type EstadoDaGravacao = (typeof ESTADOS_DA_GRAVACAO)[number];

/** A situação que o cartão mostra (`metadata.voice_call.gravacao.situacao`). */
export const SITUACOES_DA_GRAVACAO = ["processando", "pronta", "falhou", "expirada"] as const;
export type SituacaoDaGravacao = (typeof SITUACOES_DA_GRAVACAO)[number];

/** A projeção no metadado da mensagem da ligação. */
export interface GravacaoDaLigacao {
  situacao: SituacaoDaGravacao;
  /** A duração do áudio gravado — só depois de pronta. */
  duracao_ms: number | null;
}

/**
 * Lê `metadata.voice_call.gravacao` e NUNCA lança: o metadado é jsonb aberto.
 * Situação fora do vocabulário (um worker mais novo, registro malformado) →
 * `null`, e o cartão cala sobre a gravação em vez de prometer um áudio.
 */
export function gravacaoDaLigacao(bruto: unknown): GravacaoDaLigacao | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const g = bruto as Record<string, unknown>;
  if (!SITUACOES_DA_GRAVACAO.includes(g.situacao as SituacaoDaGravacao)) return null;
  const duracao = g.duracao_ms;
  return {
    situacao: g.situacao as SituacaoDaGravacao,
    duracao_ms: typeof duracao === "number" && Number.isFinite(duracao) && duracao > 0 ? duracao : null,
  };
}

/**
 * Por quanto tempo a gravação fica guardada — as opções da tela. 90 dias é o
 * padrão: o mínimo que o Decreto 11.034/2022 pede para gravações de SAC.
 */
export const RETENCOES_DA_GRAVACAO_DIAS = [30, 60, 90, 180, 365, 730, 1825] as const;
export type RetencaoDaGravacao = (typeof RETENCOES_DA_GRAVACAO_DIAS)[number];
export const RETENCAO_PADRAO_DIAS: RetencaoDaGravacao = 90;

export function retencaoValida(dias: number): dias is RetencaoDaGravacao {
  return (RETENCOES_DA_GRAVACAO_DIAS as readonly number[]).includes(dias);
}

/** Teto de uma gravação: 2 h (~115 MB de WAV no Asterisk, ~21 MB de MP3 no Storage). */
export const TETO_DA_GRAVACAO_S = 7_200;

/** O MIME do arquivo guardado (MP3 toca em qualquer navegador e computador). */
export const MIME_DA_GRAVACAO = "audio/mpeg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * O nome da gravação no Asterisk: `g-<voice_call_id>`. Determinístico, para o
 * processamento achar o arquivo pela ligação — e a passada achar a ligação pelo
 * arquivo (`vcIdDoNome`) — sem coluna nenhuma.
 */
export function nomeNoAsterisk(vcId: string): string {
  return `g-${vcId}`;
}

/** O id da ligação de um nome de gravação — só `g-<uuid>` exato; o resto não é nosso. */
export function vcIdDoNome(nome: string): string | null {
  if (!nome.startsWith("g-")) return null;
  const id = nome.slice(2);
  return UUID.test(id) ? id : null;
}

/** Cabeçalho do WAV que o Asterisk escreve (medido na VPS: 44 bytes, PCM 8 kHz, 16 bits, mono). */
const CABECALHO_DO_WAV = 44;
const BYTES_POR_SEGUNDO = 8_000 * 2;

/** A duração de um WAV do Asterisk pelo tamanho do arquivo. */
export function duracaoDoWavMs(bytes: number): number {
  if (bytes <= CABECALHO_DO_WAV) return 0;
  return Math.round(((bytes - CABECALHO_DO_WAV) / BYTES_POR_SEGUNDO) * 1000);
}

/**
 * Quanto se espera o Asterisk entregar o arquivo depois do fim da ligação. O
 * arquivo fecha quando a gravação é parada — antes de a ponte ser destruída —,
 * então 404 depois disso é arquivo perdido (o Asterisk reiniciou no meio).
 */
export const PRAZO_DO_ARQUIVO_MS = 2 * 60_000;

/**
 * O prazo de tudo: 30 min depois do fim sem conseguir guardar (Storage fora,
 * conversor quebrado, mensagem da ligação que nunca chegou), a gravação é dada
 * como perdida — o cartão diz, e a Central avisa.
 */
export const PRAZO_TOTAL_DA_GRAVACAO_MS = 30 * 60_000;

/** O Asterisk respondeu 404 para o arquivo: ainda é cedo, ou já é perda? */
export function destinoSemArquivo(p: { fimEm: Date; agora: Date }): "esperar" | "falhar" {
  return p.agora.getTime() - p.fimEm.getTime() >= PRAZO_DO_ARQUIVO_MS ? "falhar" : "esperar";
}
