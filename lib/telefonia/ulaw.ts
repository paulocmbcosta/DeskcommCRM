/**
 * μ-law (G.711), 8 kHz, mono — o formato que a ElevenLabs devolve em
 * `output_format=ulaw_8000` e que o Asterisk toca sem converter.
 *
 * Funções puras e client-safe: a tela usa `ulawParaWav` para OUVIR a fala no
 * navegador (navegador não toca μ-law cru), e o cliente da ElevenLabs usa
 * `lerWav` para desembrulhar o áudio se ele vier dentro de um WAV.
 */

export const AMOSTRAS_POR_SEGUNDO = 8000;

/** 1 byte por amostra a 8 kHz: 8 bytes = 1 ms. */
export function duracaoDoUlawMs(bytes: number): number {
  return Math.round(bytes / 8);
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
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, AMOSTRAS_POR_SEGUNDO, true);
  v.setUint32(28, AMOSTRAS_POR_SEGUNDO * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
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
    if (id === "fmt " && tamanho >= 8) {
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
