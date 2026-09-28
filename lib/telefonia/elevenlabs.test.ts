// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ErroDaElevenLabs, listarVozes, motivoDaResposta, sintetizar } from "./elevenlabs";

const CHAVE = "sk_teste_elevenlabs_1234";

function resposta(status: number, corpo: unknown, tipo = "application/json"): Response {
  // `as BodyInit`: TS 6 tipa `Uint8Array` como genérico sobre o buffer
  // (`Uint8Array<ArrayBufferLike>`), e o `BodyInit` do lib.dom exige o buffer
  // concreto (`Uint8Array<ArrayBuffer>`). Em runtime o `Response` aceita
  // qualquer `Uint8Array`; o cast só destrava o typecheck.
  const body = (corpo instanceof Uint8Array ? corpo : JSON.stringify(corpo)) as BodyInit;
  return new Response(body, { status, headers: { "Content-Type": tipo } });
}

describe("listarVozes — também é como a chave é validada", () => {
  it("manda a chave SÓ no header, e devolve as vozes em ordem de nome", async () => {
    const f = vi.fn(async () =>
      resposta(200, {
        voices: [
          { voice_id: "v2", name: "Bruna", category: "premade", preview_url: "https://cdn.exemplo/b.mp3" },
          { voice_id: "v1", name: "Ana", category: "cloned", preview_url: "http://inseguro/a.mp3" },
          { voice_id: "../x", name: "Invasora" },
        ],
      }),
    );
    const vozes = await listarVozes(CHAVE, { fetch: f as unknown as typeof fetch, baseUrl: "http://falsa.local/" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://falsa.local/v1/voices");
    expect(url).not.toContain(CHAVE);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(CHAVE);
    expect(vozes).toEqual([
      { voice_id: "v1", nome: "Ana", categoria: "cloned", amostra_url: null },
      { voice_id: "v2", nome: "Bruna", categoria: "premade", amostra_url: "https://cdn.exemplo/b.mp3" },
    ]);
  });

  it.each([
    [401, { detail: { status: "invalid_api_key" } }, "chave_invalida"],
    [401, { detail: { status: "quota_exceeded" } }, "sem_credito"],
    [402, null, "sem_credito"],
    [429, null, "limite_de_uso"],
    [500, null, "erro_do_provedor"],
  ] as const)("HTTP %i %j → %s", async (status, corpo, motivo) => {
    const f = vi.fn(async () => resposta(status, corpo));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({ motivo, status });
  });

  it("rede que falha → sem_resposta", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const erro = await listarVozes(CHAVE, { fetch: f as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDaElevenLabs);
    expect(erro).toMatchObject({ motivo: "sem_resposta", status: null });
  });
});

describe("sintetizar — μ-law 8 kHz", () => {
  it("pede ulaw_8000 à voz escolhida, com texto e modelo no corpo, e devolve os bytes crus", async () => {
    const audio = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const f = vi.fn(async () => resposta(200, audio, "audio/basic"));
    const bytes = await sintetizar(
      { chave: CHAVE, voiceId: "voz 1", texto: "Para Suporte, digite 1." },
      { fetch: f as unknown as typeof fetch },
    );

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz%201?output_format=ulaw_8000");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(CHAVE);
    expect(JSON.parse(String(init.body))).toEqual({ text: "Para Suporte, digite 1.", model_id: "eleven_multilingual_v2" });
    expect([...bytes]).toEqual([0xff, 0x7f, 0x00, 0x80]);
  });

  it("áudio que venha dentro de um WAV μ-law é desembrulhado", async () => {
    const wav = new Uint8Array(46);
    const v = new DataView(wav.buffer);
    const w = (i: number, s: string) => [...s].forEach((c, k) => (wav[i + k] = c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 38, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 7, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
    w(36, "data"); v.setUint32(40, 2, true); wav[44] = 0x11; wav[45] = 0x22;
    const f = vi.fn(async () => resposta(200, wav, "audio/wav"));
    const bytes = await sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch });
    expect([...bytes]).toEqual([0x11, 0x22]);
  });

  it("WAV que não é μ-law 8 kHz mono não serve ao Asterisk → erro_do_provedor", async () => {
    const wav = new Uint8Array(46);
    const v = new DataView(wav.buffer);
    const w = (i: number, s: string) => [...s].forEach((c, k) => (wav[i + k] = c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 38, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
    w(36, "data"); v.setUint32(40, 2, true);
    const f = vi.fn(async () => resposta(200, wav, "audio/wav"));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "erro_do_provedor",
    });
  });

  it("corpo vazio → erro_do_provedor", async () => {
    const f = vi.fn(async () => resposta(200, new Uint8Array(0), "audio/basic"));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "erro_do_provedor",
    });
  });

  it.each([
    [422, null, "texto_recusado"],
    [400, { detail: { status: "voice_not_found" } }, "voz_inexistente"],
    [404, null, "voz_inexistente"],
  ] as const)("HTTP %i %j → %s", async (status, corpo, motivo) => {
    const f = vi.fn(async () => resposta(status, corpo));
    await expect(sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo,
    });
  });
});

describe("motivoDaResposta", () => {
  it("o status do corpo vence o HTTP quando diz mais", () => {
    expect(motivoDaResposta(401, { detail: { status: "quota_exceeded" } })).toBe("sem_credito");
    expect(motivoDaResposta(403, null)).toBe("chave_invalida");
  });
});
