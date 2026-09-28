/**
 * μ-law (G.711), 8 kHz, mono — o formato que a ElevenLabs devolve em
 * `output_format=ulaw_8000` e que o Asterisk toca sem converter.
 *
 * Funções puras e client-safe: a tela usa `ulawParaWav` para OUVIR a fala no
 * navegador (navegador não toca μ-law cru), e o cliente da ElevenLabs usa
 * `lerWav` para desembrulhar o áudio se ele vier dentro de um WAV.
 */

export const AMOSTRAS_POR_SEGUNDO = 8000;

/** Faixa de uma amostra PCM assinada de 16 bits — o que `pcm16ParaUlaw` aceita. */
const MAXIMO_PCM16 = 32767;
const MINIMO_PCM16 = -32768;

/** O cabeçalho `fmt ` do WAV que `ulawParaWav` escreve: PCM, mono, 16 bits por amostra. */
const FORMATO_PCM = 1;
const CANAIS_MONO = 1;
const BITS_POR_AMOSTRA = 16;
/** `block align`: bytes de um quadro (todos os canais de uma amostra). Mono de 16 bits = 2. */
const BYTES_POR_QUADRO = CANAIS_MONO * (BITS_POR_AMOSTRA / 8);
/** `byte rate`: quantos bytes de áudio o WAV tem por segundo. */
const BYTES_POR_SEGUNDO = AMOSTRAS_POR_SEGUNDO * BYTES_POR_QUADRO;

/** 1 byte por amostra a 8 kHz: `AMOSTRAS_POR_SEGUNDO / 1000` bytes por ms (8 a 8 kHz). */
const BYTES_POR_MS = AMOSTRAS_POR_SEGUNDO / 1000;
export function duracaoDoUlawMs(bytes: number): number {
  return Math.round(bytes / BYTES_POR_MS);
}

/** Um byte μ-law → uma amostra PCM de 16 bits. */
export function ulawParaPcm16(byte: number): number {
  const b = ~byte & 0xff;
  const sinal = b & 0x80;
  const expoente = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  const amostra = (((mantissa << 3) + 0x84) << expoente) - 0x84;
  // `0 - x`, e não `-x`: o zero negativo do JavaScript não é 0 para `Object.is`.
  return sinal ? 0 - amostra : amostra;
}

/** Uma amostra PCM de 16 bits → um byte μ-law. */
export function pcm16ParaUlaw(amostra: number): number {
  const BIAS = 0x84;
  const TETO = 32635;
  let s = Math.trunc(amostra);
  // O truque de sinal abaixo (`(s >> 8) & 0x80`) só vale dentro da faixa de 16
  // bits: fora dela ele lê o bit 15 de um número que não é mais um int16, e
  // troca o sinal (32768 vira "negativo", −40000 vira "positivo"). Limitar
  // ANTES fecha a entrada na faixa que o resto da função pressupõe.
  if (s > MAXIMO_PCM16) s = MAXIMO_PCM16;
  if (s < MINIMO_PCM16) s = MINIMO_PCM16;
  const sinal = (s >> 8) & 0x80;
  if (sinal) s = -s;
  if (s > TETO) s = TETO;
  s += BIAS;
  let expoente = 7;
  for (let mascara = 0x4000; (s & mascara) === 0 && expoente > 0; mascara >>= 1) expoente--;
  const mantissa = (s >> (expoente + 3)) & 0x0f;
  return ~(sinal | (expoente << 4) | mantissa) & 0xff;
}

/** WAV PCM16 mono 8 kHz com as amostras decodificadas — o que um `<audio>` toca. */
export function ulawParaWav(ulaw: Uint8Array): Uint8Array<ArrayBuffer> {
  const tamanhoDosDados = ulaw.length * 2;
  const wav = new Uint8Array(new ArrayBuffer(44 + tamanhoDosDados));
  const v = new DataView(wav.buffer);
  const escrever = (i: number, s: string) => {
    for (let k = 0; k < 4; k++) wav[i + k] = s.charCodeAt(k);
  };
  escrever(0, "RIFF");
  v.setUint32(4, 36 + tamanhoDosDados, true);
  escrever(8, "WAVE");
  escrever(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, FORMATO_PCM, true);
  v.setUint16(22, CANAIS_MONO, true);
  v.setUint32(24, AMOSTRAS_POR_SEGUNDO, true);
  v.setUint32(28, BYTES_POR_SEGUNDO, true);
  v.setUint16(32, BYTES_POR_QUADRO, true);
  v.setUint16(34, BITS_POR_AMOSTRA, true);
  escrever(36, "data");
  v.setUint32(40, tamanhoDosDados, true);
  for (let i = 0; i < ulaw.length; i++) v.setInt16(44 + i * 2, ulawParaPcm16(ulaw[i]!), true);
  return wav;
}

/** Lê um WAV: formato (1 = PCM, 7 = μ-law), canais, taxa e os bytes do bloco `data`. `null` se não for WAV. */
export function lerWav(
  bytes: Uint8Array,
): { formato: number; canais: number; taxa: number; dados: Uint8Array } | null {
  if (bytes.length < 12) return null;
  const txt = (i: number) => String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
  if (txt(0) !== "RIFF" || txt(8) !== "WAVE") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let formato = -1;
  let canais = 0;
  let taxa = 0;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = txt(i);
    const tamanho = v.getUint32(i + 4, true);
    const inicio = i + 8;
    // O bloco pode declarar um `tamanho` que o buffer truncado não tem: sem este
    // limite, ler os campos abaixo do chunk `fmt ` lança RangeError em vez de
    // devolver null — foi medido com buffers de 20 e 27 bytes.
    if (id === "fmt " && tamanho >= 8 && inicio + 8 <= bytes.length) {
      formato = v.getUint16(inicio, true);
      canais = v.getUint16(inicio + 2, true);
      taxa = v.getUint32(inicio + 4, true);
    }
    if (id === "data") {
      if (formato < 0) return null;
      return { formato, canais, taxa, dados: bytes.subarray(inicio, Math.min(inicio + tamanho, bytes.length)) };
    }
    i = inicio + tamanho + (tamanho % 2);
  }
  return null;
}
