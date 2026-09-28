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

/**
 * Um `ReadableStream` que NUNCA fecha e conta quantos bytes foram PUXADOS —
 * gerados sob demanda em `pull()`, não entregues de uma vez em `start()`. Prova
 * que a implementação lê em streaming e para no teto: uma versão ingênua ("ler
 * tudo, então conferir o tamanho") nunca terminaria de ler este fluxo (ele não
 * fecha), e ficaria presa até o prazo — a versão certa rejeita tipado tendo
 * puxado só um pouco mais que o teto.
 */
function fluxoInfinitoContando(tamanhoDoPedaco = 64 * 1024): {
  stream: ReadableStream<Uint8Array>;
  bytesPuxados: () => number;
} {
  let total = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      total += tamanhoDoPedaco;
      controller.enqueue(new Uint8Array(tamanhoDoPedaco));
    },
  });
  return { stream, bytesPuxados: () => total };
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

  it("item malformado em voices (null, string, número, objeto sem voice_id) é descartado, não vira TypeError", async () => {
    const f = vi.fn(async () =>
      resposta(200, {
        voices: [null, "x", 42, {}, { voice_id: "v1", name: "Ana" }],
      }),
    );
    const vozes = await listarVozes(CHAVE, { fetch: f as unknown as typeof fetch });
    expect(vozes).toEqual([{ voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null }]);
  });

  it("404 é URL base errada ou serviço fora do ar — não voz inexistente (não faz sentido nesta rota)", async () => {
    const f = vi.fn(async () => resposta(404, null));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "sem_resposta",
      status: 404,
    });
  });
});

describe("sintetizar — μ-law 8 kHz", () => {
  it("pede ulaw_8000 à voz escolhida, com texto e modelo no corpo, e devolve os bytes crus", async () => {
    // `voz_1`, não `voz 1`: um voice_id real da ElevenLabs nunca tem espaço, e o
    // formato agora é validado por ID_DE_VOZ antes de qualquer fetch (ver describe
    // "voiceId fora do formato" abaixo) — um valor com espaço seria recusado antes
    // de chegar aqui. A URL ainda passa por encodeURIComponent como defesa.
    const audio = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const f = vi.fn(async () => resposta(200, audio, "audio/basic"));
    const bytes = await sintetizar(
      { chave: CHAVE, voiceId: "voz_1", texto: "Para Suporte, digite 1." },
      { fetch: f as unknown as typeof fetch },
    );

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz_1?output_format=ulaw_8000");
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

  it("voiceId fora do formato recusa ANTES de qualquer fetch", async () => {
    const f = vi.fn();
    await expect(
      sintetizar({ chave: CHAVE, voiceId: "..", texto: "oi" }, { fetch: f as unknown as typeof fetch }),
    ).rejects.toMatchObject({ motivo: "voz_inexistente" });
    expect(f).not.toHaveBeenCalled();
  });

  it("corpo maior que 2 MB é recusado em streaming, tendo puxado só um pouco mais que o teto", async () => {
    const TETO = 2 * 1024 * 1024;
    const { stream, bytesPuxados } = fluxoInfinitoContando();
    const f = vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "audio/basic" } }));
    await expect(
      sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch }),
    ).rejects.toMatchObject({ motivo: "erro_do_provedor" });
    // O fluxo é INFINITO: se a implementação lesse tudo antes de conferir o
    // tamanho, este teste nunca chegaria aqui (ficaria presa até o prazo).
    // Passar tendo puxado só um pouco mais que o teto prova o streaming.
    expect(bytesPuxados()).toBeGreaterThan(TETO);
    expect(bytesPuxados()).toBeLessThan(TETO + 256 * 1024);
  });
});

describe("nunca segue redirecionamento — a xi-api-key não pode ir para outra origem", () => {
  it("sintetizar: passa redirect:\"error\", e um 3xx que escape vira falha tipada", async () => {
    const f = vi.fn(async () => resposta(302, null));
    await expect(
      sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ErroDaElevenLabs);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });

  it("listarVozes: passa redirect:\"error\", e um 3xx que escape vira falha tipada", async () => {
    const f = vi.fn(async () => resposta(302, null));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toBeInstanceOf(ErroDaElevenLabs);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });
});

describe("o prazo cobre a leitura do corpo, não só os headers", () => {
  /** Manda um pedaço e nunca fecha — simula um corpo que trava depois dos headers chegarem. */
  function corpoQueNuncaFecha(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
  }

  it("sintetizar: HTTP 200 com corpo travado estoura o prazo em vez de ficar pendente", async () => {
    const f = vi.fn(
      async () => new Response(corpoQueNuncaFecha(), { status: 200, headers: { "Content-Type": "audio/basic" } }),
    );
    const inicio = Date.now();
    await expect(
      sintetizar({ chave: CHAVE, voiceId: "v1", texto: "oi" }, { fetch: f as unknown as typeof fetch, prazoMs: 200 }),
    ).rejects.toMatchObject({ motivo: "sem_resposta" });
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it("listarVozes: HTTP 500 com corpo travado estoura o prazo em vez de ficar pendente", async () => {
    const f = vi.fn(
      async () => new Response(corpoQueNuncaFecha(), { status: 500, headers: { "Content-Type": "application/json" } }),
    );
    const inicio = Date.now();
    await expect(
      listarVozes(CHAVE, { fetch: f as unknown as typeof fetch, prazoMs: 200 }),
    ).rejects.toMatchObject({ motivo: "sem_resposta" });
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});

describe("teto de bytes no JSON — listagem e corpo de erro, 1 MB", () => {
  it("JSON da listagem maior que 1 MB é recusado, tendo puxado só um pouco mais que o teto", async () => {
    const TETO = 1024 * 1024;
    const { stream, bytesPuxados } = fluxoInfinitoContando();
    const f = vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "erro_do_provedor",
    });
    expect(bytesPuxados()).toBeGreaterThan(TETO);
    expect(bytesPuxados()).toBeLessThan(TETO + 256 * 1024);
  });

  it("corpo de erro maior que 1 MB não esconde o status: o motivo continua saindo dele, o corpo só é descartado", async () => {
    const { stream } = fluxoInfinitoContando();
    const f = vi.fn(async () => new Response(stream, { status: 429, headers: { "Content-Type": "application/json" } }));
    await expect(listarVozes(CHAVE, { fetch: f as unknown as typeof fetch })).rejects.toMatchObject({
      motivo: "limite_de_uso",
      status: 429,
    });
  });
});

describe("motivoDaResposta", () => {
  it("o status do corpo vence o HTTP quando diz mais", () => {
    expect(motivoDaResposta(401, { detail: { status: "quota_exceeded" } })).toBe("sem_credito");
    expect(motivoDaResposta(403, null)).toBe("chave_invalida");
  });
});
