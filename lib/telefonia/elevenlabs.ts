/**
 * Cliente da ElevenLabs — só as duas chamadas que a URA usa: listar as vozes da
 * conta (é também como a chave é VALIDADA) e sintetizar uma fala em μ-law 8 kHz,
 * o formato que o Asterisk toca sem converter.
 *
 * Puro no que importa para o teste: o `fetch` e a URL base entram como opção. A
 * base só muda em teste (`ELEVENLABS_API_BASE_URL`, a ElevenLabs falsa do e2e);
 * produção usa a pública. A chave vai no header `xi-api-key`, nunca na URL.
 *
 * Toda falha vira `ErroDaElevenLabs` com um motivo do vocabulário — a tela traduz
 * o motivo, e o texto cru do provedor nunca chega a ela.
 *
 * Quem chama `sintetizar` é SÓ a prévia da tela (`lib/telefonia/previa.ts`,
 * desenho D15): toda ligação toca um arquivo já gravado. Nenhum módulo do caminho
 * da ligação (`lib/channels/telefonia/`, `workers/`) importa este arquivo, nem por
 * um módulo no meio — `tests/unit/ligacao-nunca-chama-elevenlabs.test.ts` reprova.
 */
import { lerWav } from "./ulaw";
import { MODELO_DE_VOZ_PADRAO, type MotivoDoErroDaElevenLabs } from "./vocabulario";

export const ELEVENLABS_BASE_PADRAO = "https://api.elevenlabs.io";
/** Uma fala de 1000 caracteres leva alguns segundos para sair; 20 s é folga, não expectativa. */
const PRAZO_PADRAO_MS = 20_000;
/** `audioFormat` 7 do WAV = μ-law. Qualquer outro não serve ao Asterisk sem conversão. */
const FORMATO_WAV_ULAW = 7;
const ID_DE_VOZ = /^[A-Za-z0-9_-]{1,64}$/;

export class ErroDaElevenLabs extends Error {
  constructor(
    readonly motivo: MotivoDoErroDaElevenLabs,
    readonly status: number | null,
  ) {
    super(`elevenlabs_${motivo}${status ? `_${status}` : ""}`);
    this.name = "ErroDaElevenLabs";
  }
}

export interface OpcoesDoCliente {
  baseUrl?: string;
  fetch?: typeof fetch;
  prazoMs?: number;
}

export interface VozDaElevenLabs {
  voice_id: string;
  nome: string;
  categoria: string | null;
  /** Amostra pública da voz (só `https:`), para o botão "Ouvir amostra". */
  amostra_url: string | null;
}

/** HTTP + corpo de erro → motivo. O `detail.status` do corpo vence quando diz mais que o HTTP. */
export function motivoDaResposta(status: number, corpo: unknown): MotivoDoErroDaElevenLabs {
  const doCorpo = (corpo as { detail?: { status?: unknown } } | null)?.detail?.status;
  if (doCorpo === "quota_exceeded" || status === 402) return "sem_credito";
  if (doCorpo === "voice_not_found" || status === 404) return "voz_inexistente";
  if (status === 401 || status === 403) return "chave_invalida";
  if (status === 400 || status === 422) return "texto_recusado";
  if (status === 429) return "limite_de_uso";
  return "erro_do_provedor";
}

function base(o: OpcoesDoCliente): string {
  return (o.baseUrl?.trim() || ELEVENLABS_BASE_PADRAO).replace(/\/+$/, "");
}

async function chamar(url: string, init: RequestInit, o: OpcoesDoCliente): Promise<Response> {
  const f = o.fetch ?? fetch;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), o.prazoMs ?? PRAZO_PADRAO_MS);
  let resp: Response;
  try {
    resp = await f(url, { ...init, signal: controle.signal });
  } catch {
    throw new ErroDaElevenLabs("sem_resposta", null);
  } finally {
    clearTimeout(relogio);
  }
  if (!resp.ok) {
    const corpo = await resp.json().catch(() => null);
    throw new ErroDaElevenLabs(motivoDaResposta(resp.status, corpo), resp.status);
  }
  return resp;
}

export async function listarVozes(chave: string, o: OpcoesDoCliente = {}): Promise<VozDaElevenLabs[]> {
  const resp = await chamar(
    `${base(o)}/v1/voices`,
    { method: "GET", headers: { "xi-api-key": chave, Accept: "application/json" } },
    o,
  );
  const corpo = (await resp.json().catch(() => null)) as {
    voices?: Array<{ voice_id?: unknown; name?: unknown; category?: unknown; preview_url?: unknown }>;
  } | null;
  if (!corpo || !Array.isArray(corpo.voices)) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
  return corpo.voices
    .filter((v): v is { voice_id: string; name?: unknown; category?: unknown; preview_url?: unknown } =>
      typeof v.voice_id === "string" && ID_DE_VOZ.test(v.voice_id),
    )
    .map((v) => ({
      voice_id: v.voice_id,
      nome: typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 80) : v.voice_id,
      categoria: typeof v.category === "string" ? v.category : null,
      amostra_url: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export async function sintetizar(
  p: { chave: string; voiceId: string; modelId?: string; texto: string },
  o: OpcoesDoCliente = {},
): Promise<Uint8Array> {
  const url = `${base(o)}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=ulaw_8000`;
  const resp = await chamar(
    url,
    {
      method: "POST",
      headers: { "xi-api-key": p.chave, "Content-Type": "application/json", Accept: "audio/basic" },
      body: JSON.stringify({ text: p.texto, model_id: p.modelId ?? MODELO_DE_VOZ_PADRAO }),
    },
    o,
  );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch {
    throw new ErroDaElevenLabs("sem_resposta", resp.status);
  }
  const wav = lerWav(bytes);
  if (wav) {
    if (wav.formato !== FORMATO_WAV_ULAW || wav.canais !== 1 || wav.taxa !== 8000) {
      throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
    }
    bytes = wav.dados;
  }
  if (bytes.length === 0) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
  return bytes;
}
