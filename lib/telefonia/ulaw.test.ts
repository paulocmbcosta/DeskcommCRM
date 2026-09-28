import { describe, expect, it } from "vitest";

import { duracaoDoUlawMs, lerWav, pcm16ParaUlaw, ulawParaPcm16, ulawParaWav } from "./ulaw";

/** Um WAV μ-law (formato 7), como a ElevenLabs PODERIA devolver — para provar que `lerWav` o desembrulha. */
function wavMuLaw(dados: Uint8Array): Uint8Array {
  const b = new Uint8Array(44 + dados.length);
  const v = new DataView(b.buffer);
  const escrever = (i: number, s: string) => {
    for (let k = 0; k < 4; k++) b[i + k] = s.charCodeAt(k);
  };
  escrever(0, "RIFF");
  v.setUint32(4, 36 + dados.length, true);
  escrever(8, "WAVE");
  escrever(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 7, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  escrever(36, "data");
  v.setUint32(40, dados.length, true);
  b.set(dados, 44);
  return b;
}

describe("G.711 μ-law", () => {
  it("decodifica os valores de referência da tabela", () => {
    expect(ulawParaPcm16(0xff)).toBe(0);
    expect(ulawParaPcm16(0x7f)).toBe(0);
    expect(ulawParaPcm16(0x00)).toBe(-32124);
    expect(ulawParaPcm16(0x80)).toBe(32124);
  });

  it("codificar e decodificar volta perto do original (erro de quantização ≤ 4%)", () => {
    for (const s of [-30000, -1000, -100, 0, 100, 1000, 30000]) {
      const volta = ulawParaPcm16(pcm16ParaUlaw(s));
      expect(Math.abs(volta - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) * 0.04));
    }
  });

  it("silêncio codifica em 0xFF", () => {
    expect(pcm16ParaUlaw(0)).toBe(0xff);
  });

  it("1 byte por amostra a 8 kHz: 8000 bytes = 1000 ms", () => {
    expect(duracaoDoUlawMs(8000)).toBe(1000);
    expect(duracaoDoUlawMs(4)).toBe(1);
  });
});

describe("ulawParaWav — o que o navegador consegue tocar", () => {
  it("monta WAV PCM16 mono 8 kHz com o cabeçalho certo e as amostras decodificadas", () => {
    const wav = ulawParaWav(new Uint8Array([0xff, 0x00, 0x80]));
    const v = new DataView(wav.buffer);
    const txt = (i: number) => String.fromCharCode(...wav.subarray(i, i + 4));
    expect([txt(0), txt(8), txt(12), txt(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(16000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, -32124, 32124]);
  });

  it("o WAV montado é lido de volta por lerWav (PCM, mono, 8 kHz)", () => {
    const lido = lerWav(ulawParaWav(new Uint8Array(10)));
    expect(lido).toMatchObject({ formato: 1, canais: 1, taxa: 8000 });
    expect(lido!.dados.length).toBe(20);
  });
});

describe("lerWav", () => {
  it("bytes que não são WAV → null", () => {
    expect(lerWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it("WAV μ-law (formato 7) → só os bytes do bloco data", () => {
    const lido = lerWav(wavMuLaw(new Uint8Array([0xff, 0x7f, 0x00])));
    expect(lido).toMatchObject({ formato: 7, canais: 1, taxa: 8000 });
    expect([...lido!.dados]).toEqual([0xff, 0x7f, 0x00]);
  });
});
