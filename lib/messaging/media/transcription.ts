/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const base = creds.baseUrl ?? DEFAULT_BASE;
  const model = creds.model ?? DEFAULT_MODEL;
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("model", model);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}

/** Um trecho da transcrição, com o tempo em que foi falado (segundos desde o início do áudio). */
export interface TrechoTranscrito {
  start: number;
  end: number;
  text: string;
}

/** A transcrição com os trechos e o tempo de cada um — o que a ligação gravada precisa. */
export interface TranscricaoComTrechos {
  text: string;
  /** O idioma que o serviço detectou ou recebeu; `null` se não disse. */
  language: string | null;
  /** A duração do áudio segundo o serviço, em segundos; `null` se não disse. */
  durationSeconds: number | null;
  segments: TrechoTranscrito[];
}

export interface TranscritorComTrechos {
  transcribe(audio: Buffer, mime: string, opts?: { language?: string; signal?: AbortSignal }): Promise<TranscricaoComTrechos>;
}

const numero = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Lê a resposta `verbose_json` e NUNCA lança: o serviço é "compatível com a
 * OpenAI", e cada implementação preenche o que quer. Trecho sem texto ou sem
 * tempo fica de fora. Sem trecho nenhum mas com texto, o texto inteiro vira um
 * trecho só — a ligação não perde a transcrição por faltar o recorte.
 */
export function lerTranscricaoComTrechos(json: unknown): TranscricaoComTrechos {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const text = typeof j.text === "string" ? j.text.trim() : "";
  const durationSeconds = numero(j.duration) && j.duration >= 0 ? j.duration : null;
  const segments: TrechoTranscrito[] = [];
  if (Array.isArray(j.segments)) {
    for (const bruto of j.segments) {
      if (!bruto || typeof bruto !== "object") continue;
      const s = bruto as Record<string, unknown>;
      const t = typeof s.text === "string" ? s.text.trim() : "";
      if (!t || !numero(s.start) || s.start < 0) continue;
      segments.push({ start: s.start, end: numero(s.end) && s.end >= s.start ? s.end : s.start, text: t });
    }
  }
  if (segments.length === 0 && text) segments.push({ start: 0, end: durationSeconds ?? 0, text });
  return { text, language: typeof j.language === "string" && j.language ? j.language : null, durationSeconds, segments };
}

/**
 * O mesmo serviço de `apiTranscriptionProvider`, pedindo os TRECHOS com tempo
 * (`verbose_json`). É o que transcreve a ligação gravada do telefone: sem o
 * tempo não há como dizer em que momento cada coisa foi dita.
 *
 * Sem vocabulário (`prompt`), de propósito. Medido em 2026-10-09 com gravações
 * reais de telefone: com o nome da empresa como `prompt`, 2 de 3 ligações
 * voltaram só com a primeira frase — o resto do áudio sumiu.
 */
export function apiTranscriptionWithSegments(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscritorComTrechos {
  const base = creds.baseUrl ?? DEFAULT_BASE;
  const model = creds.model ?? DEFAULT_MODEL;
  return {
    async transcribe(audio, mime, opts = {}) {
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "verbose_json");
      if (opts.language) form.append("language", opts.language);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        body: form,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // Só o status: o corpo do erro de um provedor pode ecoar o pedido.
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      return lerTranscricaoComTrechos(await res.json());
    },
  };
}
