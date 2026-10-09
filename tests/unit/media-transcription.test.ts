import { describe, expect, it, vi } from "vitest";

import {
  apiTranscriptionProvider,
  apiTranscriptionWithSegments,
  lerTranscricaoComTrechos,
} from "@/lib/messaging/media/transcription";

describe("apiTranscriptionProvider", () => {
  it("POSTa multipart pro endpoint de transcrição e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = apiTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });
});

describe("apiTranscriptionWithSegments", () => {
  const resposta = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

  it("pede os trechos com tempo, no idioma dado, e SEM vocabulário", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      resposta({
        text: "Totus, boa tarde. Oi.",
        language: "portuguese",
        duration: 3.5,
        segments: [
          { start: 0, end: 1.9, text: " Totus, boa tarde." },
          { start: 2.4, end: 3.1, text: " Oi." },
        ],
      }),
    );
    const t = await apiTranscriptionWithSegments({ apiKey: "sk-test" }, fetchMock).transcribe(Buffer.from([1, 2]), "audio/mpeg", {
      language: "pt",
    });
    expect(t).toEqual({
      text: "Totus, boa tarde. Oi.",
      language: "portuguese",
      durationSeconds: 3.5,
      segments: [
        { start: 0, end: 1.9, text: "Totus, boa tarde." },
        { start: 2.4, end: 3.1, text: "Oi." },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("pt");
    // Medido com gravações reais: o vocabulário faz o áudio de telefone perder o texto.
    expect(form.get("prompt")).toBeNull();
    expect((form.get("file") as File).name).toBe("audio.mp3");
  });

  it("erro do serviço leva só o status — nunca o corpo, que pode ecoar o pedido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"segredo"}}', { status: 429 }));
    await expect(
      apiTranscriptionWithSegments({ apiKey: "k" }, fetchMock).transcribe(Buffer.from([1]), "audio/mpeg"),
    ).rejects.toThrow(/^transcription_429$/);
  });

  it("repassa o sinal de cancelamento ao pedido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resposta({ text: "" }));
    const controle = new AbortController();
    await apiTranscriptionWithSegments({ apiKey: "k" }, fetchMock).transcribe(Buffer.from([1]), "audio/mpeg", {
      signal: controle.signal,
    });
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controle.signal);
  });
});

describe("lerTranscricaoComTrechos", () => {
  it("não lança com resposta torta, e trecho sem texto ou sem tempo fica de fora", () => {
    expect(lerTranscricaoComTrechos(null)).toEqual({ text: "", language: null, durationSeconds: null, segments: [] });
    expect(
      lerTranscricaoComTrechos({ text: "a", segments: [null, { text: "sem tempo" }, { start: -1, text: "x" }, { start: 2, text: "  " }] })
        .segments,
    ).toEqual([{ start: 0, end: 0, text: "a" }]);
  });

  it("serviço que não devolve trechos: o texto inteiro vira um trecho, e a ligação não fica sem transcrição", () => {
    expect(lerTranscricaoComTrechos({ text: "Alô, bom dia.", duration: 4 }).segments).toEqual([
      { start: 0, end: 4, text: "Alô, bom dia." },
    ]);
  });

  it("fim antes do início vale o início", () => {
    expect(lerTranscricaoComTrechos({ text: "a", segments: [{ start: 5, end: 1, text: "a" }] }).segments[0]).toEqual({
      start: 5,
      end: 5,
      text: "a",
    });
  });

  it("sem fala: texto vazio e nenhum trecho", () => {
    expect(lerTranscricaoComTrechos({ text: "  ", segments: [] }).segments).toEqual([]);
  });
});
