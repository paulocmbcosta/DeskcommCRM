/**
 * Cliente da ElevenLabs — só as duas chamadas que a URA usa: listar as vozes da
 * conta (é também como a chave é VALIDADA) e sintetizar uma fala em μ-law 8 kHz,
 * o formato que o Asterisk toca sem converter.
 *
 * Puro no que importa para o teste: o `fetch` e a URL base entram como opção. A
 * base só muda em teste (`ELEVENLABS_API_BASE_URL`, a ElevenLabs falsa do e2e);
 * produção usa a pública. A chave vai no header `xi-api-key`, nunca na URL, e o
 * `fetch` nunca segue redirecionamento (`redirect: "error"`) — a chave não pode
 * vazar para uma origem diferente por um 3xx.
 *
 * Toda falha vira `ErroDaElevenLabs` com um motivo do vocabulário — a tela traduz
 * o motivo, e o texto cru do provedor nunca chega a ela.
 *
 * O `prazoMs` cobre a chamada INTEIRA — headers e corpo. Um servidor que manda os
 * headers e trava o corpo (proxy preso, conexão pendurada) não pode deixar a
 * chamada pendente além do prazo: por isso o corpo é sempre lido dentro da mesma
 * corrida contra o `AbortController` do prazo (`comPrazo`), nunca depois dele.
 * `sintetizar` lê o corpo em streaming com um teto de bytes (2 MB): um provedor
 * que mande um áudio absurdo, ou nunca feche o corpo, não pode estourar memória.
 * O JSON da listagem e o corpo de erro têm o mesmo tratamento, com teto de 1 MB
 * (`lerJsonComTeto`) — sem isso, um corpo de 200 MB é lido inteiro antes de
 * qualquer checagem de tamanho.
 *
 * Quem chama `sintetizar` é SÓ a prévia da tela (`lib/telefonia/previa.ts`,
 * desenho D15): toda ligação toca um arquivo já gravado. Nenhum módulo do caminho
 * da ligação (`lib/channels/telefonia/`, `workers/`) importa este arquivo, nem por
 * um módulo no meio — `tests/unit/ligacao-nunca-chama-elevenlabs.test.ts` reprova.
 */
import { lerWav } from "./ulaw";
import { ID_DE_VOZ, MODELO_DE_VOZ_PADRAO, type MotivoDoErroDaElevenLabs } from "./vocabulario";

export const ELEVENLABS_BASE_PADRAO = "https://api.elevenlabs.io";
/** Uma fala de 1000 caracteres leva alguns segundos para sair; 20 s é folga, não expectativa. */
const PRAZO_PADRAO_MS = 20_000;
/** `audioFormat` 7 do WAV = μ-law. Qualquer outro não serve ao Asterisk sem conversão. */
const FORMATO_WAV_ULAW = 7;
/**
 * Teto do corpo de `sintetizar`, lido em streaming. Uma fala de 1000 caracteres
 * em ulaw_8000 não passa de algumas dezenas de KB; 2 MB é folga generosa contra
 * um provedor que devolva algo absurdo (ou nunca feche o corpo), não expectativa.
 */
const TETO_DE_BYTES_DA_SINTESE = 2 * 1024 * 1024;
/**
 * Teto do JSON da listagem de vozes e do corpo de erro, também lido em
 * streaming. Uma conta real tem dezenas de vozes — 1 MB de JSON é folga
 * generosa. Sem teto, um corpo de 200 MB era lido inteiro antes de qualquer
 * checagem de tamanho (784 MB de memória para processar, medido na revisão).
 */
const TETO_DE_BYTES_DO_JSON = 1024 * 1024;

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

/**
 * HTTP + corpo de erro → motivo. O `detail.status` do corpo vence quando diz mais
 * que o HTTP. `contexto` distingue as duas rotas porque o MESMO 404 significa
 * coisas diferentes: em `/v1/voices` (que não recebe voice_id nenhum) é URL base
 * errada ou o serviço fora do ar — nunca "voz inexistente"; em
 * `/v1/text-to-speech/:voiceId` é mesmo a voz que sumiu da conta.
 */
export function motivoDaResposta(
  status: number,
  corpo: unknown,
  contexto: "vozes" | "sintese" = "sintese",
): MotivoDoErroDaElevenLabs {
  const doCorpo = (corpo as { detail?: { status?: unknown } } | null)?.detail?.status;
  if (doCorpo === "quota_exceeded" || status === 402) return "sem_credito";
  if (doCorpo === "voice_not_found") return "voz_inexistente";
  if (status === 404) return contexto === "vozes" ? "sem_resposta" : "voz_inexistente";
  if (status === 401 || status === 403) return "chave_invalida";
  if (status === 400 || status === 422) return "texto_recusado";
  if (status === 429) return "limite_de_uso";
  return "erro_do_provedor";
}

function base(o: OpcoesDoCliente): string {
  return (o.baseUrl?.trim() || ELEVENLABS_BASE_PADRAO).replace(/\/+$/, "");
}

/** Rejeita assim que `controle` abortar — é o que faz o prazo valer para o corpo, não só para os headers. */
function aguardarAborto(controle: AbortController): Promise<never> {
  return new Promise((_, reject) => {
    const rejeitar = () => reject(new ErroDaElevenLabs("sem_resposta", null));
    if (controle.signal.aborted) {
      rejeitar();
      return;
    }
    controle.signal.addEventListener("abort", rejeitar, { once: true });
  });
}

/**
 * Roda `operacao` sob o prazo: corre contra o aborto do relógio, e qualquer erro
 * que NÃO seja `ErroDaElevenLabs` (rede, JSON malformado, corpo travado) vira
 * `sem_resposta`. `operacao` recebe o próprio `controle` para poder ler o corpo
 * dentro da mesma corrida.
 */
async function comPrazo<T>(o: OpcoesDoCliente, operacao: (controle: AbortController) => Promise<T>): Promise<T> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), o.prazoMs ?? PRAZO_PADRAO_MS);
  try {
    return await Promise.race([operacao(controle), aguardarAborto(controle)]);
  } catch (e) {
    if (e instanceof ErroDaElevenLabs) throw e;
    throw new ErroDaElevenLabs("sem_resposta", null);
  } finally {
    clearTimeout(relogio);
  }
}

/** Faz a chamada e, se `!resp.ok`, já traduz o erro — a leitura do corpo de erro corre sob o mesmo prazo. */
async function pedirResposta(
  url: string,
  init: RequestInit,
  o: OpcoesDoCliente,
  controle: AbortController,
  contexto: "vozes" | "sintese",
): Promise<Response> {
  const f = o.fetch ?? fetch;
  // `redirect: "error"`: a `xi-api-key` vai só para a origem da ElevenLabs. Um
  // 3xx faz o `fetch` de verdade rejeitar — nunca reenviamos a chave para o
  // `Location`. Se um `fetch` falso (teste) devolver o 3xx mesmo assim, o
  // `!resp.ok` abaixo trata como falha tipada — nunca seguimos por conta própria.
  const resp = await f(url, { ...init, redirect: "error", signal: controle.signal });
  if (!resp.ok) {
    // Teto de 1 MB, em streaming: estourar o teto não pode esconder o status —
    // `lerJsonComTeto` devolve `null` (nunca lança), e o motivo abaixo continua
    // saindo do `resp.status`. O corpo só é descartado, nunca o status.
    const corpoErro = await lerJsonComTeto(resp, TETO_DE_BYTES_DO_JSON);
    throw new ErroDaElevenLabs(motivoDaResposta(resp.status, corpoErro, contexto), resp.status);
  }
  return resp;
}

/** `voice_id` da ElevenLabs no formato esperado — filtra a listagem e descarta item malformado sem lançar. */
function vozValida(v: unknown): v is { voice_id: string; name?: unknown; category?: unknown; preview_url?: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const candidato = v as { voice_id?: unknown };
  return typeof candidato.voice_id === "string" && ID_DE_VOZ.test(candidato.voice_id);
}

export async function listarVozes(chave: string, o: OpcoesDoCliente = {}): Promise<VozDaElevenLabs[]> {
  return comPrazo(o, async (controle) => {
    const resp = await pedirResposta(
      `${base(o)}/v1/voices`,
      { method: "GET", headers: { "xi-api-key": chave, Accept: "application/json" } },
      o,
      controle,
      "vozes",
    );
    // Teto de 1 MB, em streaming: um corpo maior vira `null` aqui (nunca lança) e
    // cai no `!corpo` abaixo, que já é `erro_do_provedor` — sem ler 200 MB de JSON
    // inteiro para só então descobrir que passou do tamanho (medido na revisão:
    // 784 MB de memória para processar um corpo assim).
    const corpo = (await lerJsonComTeto(resp, TETO_DE_BYTES_DO_JSON)) as { voices?: unknown[] } | null;
    if (!corpo || !Array.isArray(corpo.voices)) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
    return corpo.voices
      .filter(vozValida)
      .map((v) => ({
        voice_id: v.voice_id,
        nome: typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 80) : v.voice_id,
        categoria: typeof v.category === "string" ? v.category : null,
        amostra_url: typeof v.preview_url === "string" && v.preview_url.startsWith("https://") ? v.preview_url : null,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  });
}

/**
 * Lê o corpo em streaming, com teto de bytes — nunca confia em `Content-Length`
 * (pode faltar ou mentir). Ao estourar o teto, cancela o leitor (sem tocar no
 * `controle` do prazo — são dois motivos de parar diferentes) e lança
 * `erro_do_provedor`: um áudio de fala não chega perto de 2 MB.
 */
async function lerComTeto(resp: Response, teto: number): Promise<Uint8Array> {
  const corpo = resp.body;
  if (!corpo) {
    // Sem streaming disponível (não deveria ocorrer em Node/undici) — cai para
    // o modo direto, ainda com o teto conferido depois de ler.
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length > teto) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
    return bytes;
  }
  const leitor = corpo.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > teto) {
        await leitor.cancel().catch(() => {});
        throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
      }
      pedacos.push(value);
    }
  } finally {
    leitor.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let deslocamento = 0;
  for (const pedaco of pedacos) {
    bytes.set(pedaco, deslocamento);
    deslocamento += pedaco.length;
  }
  return bytes;
}

/**
 * `lerComTeto` + `JSON.parse`, com QUALQUER falha virando `null` — corpo
 * malformado, vazio, ou maior que `teto` (o mesmo `ErroDaElevenLabs` que
 * `lerComTeto` lança nesse caso). Nunca lança: cada chamador decide o que um
 * corpo ausente significa (listagem: `erro_do_provedor`; corpo de erro: o
 * motivo continua saindo do `status`, nunca do tamanho do corpo).
 */
async function lerJsonComTeto(resp: Response, teto: number): Promise<unknown | null> {
  try {
    const bytes = await lerComTeto(resp, teto);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function sintetizar(
  p: { chave: string; voiceId: string; modelId?: string; texto: string },
  o: OpcoesDoCliente = {},
): Promise<Uint8Array> {
  // Formato inválido nunca é uma voz real da conta: recusa ANTES de qualquer
  // fetch, sem gastar rede nem abrir o relógio do prazo.
  if (!ID_DE_VOZ.test(p.voiceId)) throw new ErroDaElevenLabs("voz_inexistente", null);

  return comPrazo(o, async (controle) => {
    const url = `${base(o)}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=ulaw_8000`;
    const resp = await pedirResposta(
      url,
      {
        method: "POST",
        headers: { "xi-api-key": p.chave, "Content-Type": "application/json", Accept: "audio/basic" },
        body: JSON.stringify({ text: p.texto, model_id: p.modelId ?? MODELO_DE_VOZ_PADRAO }),
      },
      o,
      controle,
      "sintese",
    );
    let bytes = await lerComTeto(resp, TETO_DE_BYTES_DA_SINTESE);
    const wav = lerWav(bytes);
    if (wav) {
      if (wav.formato !== FORMATO_WAV_ULAW || wav.canais !== 1 || wav.taxa !== 8000) {
        throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
      }
      bytes = wav.dados;
    }
    if (bytes.length === 0) throw new ErroDaElevenLabs("erro_do_provedor", resp.status);
    return bytes;
  });
}
