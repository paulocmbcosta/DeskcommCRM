/**
 * Cliente da ARI (Asterisk REST Interface) — a única porta do CRM para o
 * Asterisk da telefonia (spec 20 §4).
 *
 * Duas metades: HTTP (comandos: criar tronco, tocar ramal, fazer ponte) e
 * WebSocket (eventos da aplicação Stasis `crm`). A senha vai no cabeçalho
 * `Authorization`, nunca na URL — a ARI aceita `?api_key=`, e é exatamente o
 * que a doutrina proíbe (chave em query string vaza em log).
 *
 * Configuração da INSTALAÇÃO, não da organização: `TELEFONIA_ARI_URL` e
 * `TELEFONIA_ARI_PASSWORD`. Ausentes = telefonia desligada nesta instalação,
 * e quem pergunta recebe `null`, nunca uma exceção.
 */

import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Nomes neutros de propósito: a marca do produto é configurável (white-label),
 * e estes são identificadores técnicos entre o worker e o Asterisk.
 */
export const APP_STASIS = "crm";
export const USUARIO_ARI = "crm";

export interface ConfigAri {
  baseUrl: string;
  senha: string;
}

export function configAriDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigAri | null {
  const baseUrl = (env.TELEFONIA_ARI_URL ?? "").trim().replace(/\/+$/, "");
  const senha = (env.TELEFONIA_ARI_PASSWORD ?? "").trim();
  if (!baseUrl || !senha) return null;
  return { baseUrl, senha };
}

/**
 * O nome de uma gravação vai no CAMINHO da ARI: só letras, dígitos, `-` e `_`.
 * Uma barra ou `..` apontaria para outro recurso (ou outro arquivo) do Asterisk.
 */
function nomeDeGravacao(nome: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(nome)) throw new Error(`nome de gravação inválido: ${nome.slice(0, 40)}`);
  return nome;
}

export class ErroAri extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
    readonly caminho: string,
  ) {
    super(`ari ${status} em ${caminho}: ${corpo.slice(0, 200)}`);
    this.name = "ErroAri";
  }
}

type Metodo = "GET" | "POST" | "PUT" | "DELETE";

/** Campo de configuração PJSIP no formato que a ARI recebe. */
export interface CampoPjsip {
  attribute: string;
  value: string;
}

export interface CanalAri {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan: { context: string; exten: string; priority: number };
  creationtime: string;
}

export class ClienteAri {
  private readonly auth: string;

  constructor(
    readonly config: ConfigAri,
    private readonly prazoMs = 5_000,
  ) {
    this.auth = "Basic " + Buffer.from(`${USUARIO_ARI}:${config.senha}`).toString("base64");
  }

  async pedir<T = unknown>(
    metodo: Metodo,
    caminho: string,
    opcoes: { query?: Record<string, string | number | undefined>; corpo?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}/ari${caminho}`);
    for (const [k, v] of Object.entries(opcoes.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url, {
      method: metodo,
      headers: {
        Authorization: this.auth,
        ...(opcoes.corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
      signal: AbortSignal.timeout(this.prazoMs),
    });
    const texto = await resp.text();
    if (!resp.ok) throw new ErroAri(resp.status, texto, caminho);
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  ping(): Promise<unknown> {
    return this.pedir("GET", "/asterisk/ping");
  }

  // ─── configuração dinâmica (sorcery em memória) ──────────────────────────

  gravarObjeto(tipo: "auth" | "aor" | "endpoint" | "registration" | "identify", id: string, campos: CampoPjsip[]) {
    return this.pedir("PUT", `/asterisk/config/dynamic/res_pjsip/${tipo}/${encodeURIComponent(id)}`, {
      corpo: { fields: campos },
    });
  }

  /** Apaga um objeto. 404 não é erro: apagar o que não existe é o estado desejado. */
  async apagarObjeto(tipo: "auth" | "aor" | "endpoint" | "registration" | "identify", id: string) {
    try {
      await this.pedir("DELETE", `/asterisk/config/dynamic/res_pjsip/${tipo}/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  // ─── canais e pontes ─────────────────────────────────────────────────────

  atender(canalId: string) {
    return this.pedir("POST", `/channels/${canalId}/answer`);
  }

  indicarChamando(canalId: string) {
    return this.pedir("POST", `/channels/${canalId}/ring`);
  }

  async desligar(canalId: string, motivo: "normal" | "busy" | "congestion" | "no_answer" = "normal") {
    try {
      await this.pedir("DELETE", `/channels/${canalId}`, { query: { reason: motivo } });
    } catch (e) {
      // Canal que já caiu: desligar o que não existe é o estado desejado.
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  /** Cria um canal SEM discar ainda — para entrar na ponte antes e ouvir o chamar. */
  criarCanal(p: { endpoint: string; appArgs: string; callerId?: string; variaveis?: Record<string, string> }) {
    return this.pedir<CanalAri>("POST", "/channels/create", {
      corpo: {
        endpoint: p.endpoint,
        app: APP_STASIS,
        appArgs: p.appArgs,
        ...(p.variaveis ? { variables: p.variaveis } : {}),
      },
      query: { ...(p.callerId ? { callerId: p.callerId } : {}) },
    });
  }

  discar(canalId: string, prazoS: number) {
    return this.pedir("POST", `/channels/${canalId}/dial`, { query: { timeout: prazoS } });
  }

  /** Origina e disca de uma vez (o ramal do atendente, na chamada recebida). */
  originar(p: {
    endpoint: string;
    appArgs: string;
    callerId?: string;
    prazoS: number;
    variaveis?: Record<string, string>;
  }) {
    return this.pedir<CanalAri>("POST", "/channels", {
      query: {
        endpoint: p.endpoint,
        app: APP_STASIS,
        appArgs: p.appArgs,
        timeout: p.prazoS,
        ...(p.callerId ? { callerId: p.callerId } : {}),
      },
      corpo: p.variaveis ? { variables: p.variaveis } : undefined,
    });
  }

  lerVariavel(canalId: string, nome: string) {
    return this.pedir<{ value: string }>("GET", `/channels/${canalId}/variable`, { query: { variable: nome } });
  }

  criarPonte(id: string) {
    return this.pedir<{ id: string }>("POST", "/bridges", { query: { type: "mixing", bridgeId: id } });
  }

  porNaPonte(ponteId: string, canalId: string) {
    return this.pedir("POST", `/bridges/${ponteId}/addChannel`, { query: { channel: canalId } });
  }

  async destruirPonte(ponteId: string) {
    try {
      await this.pedir("DELETE", `/bridges/${ponteId}`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  musicaDeEspera(canalId: string) {
    return this.pedir("POST", `/channels/${canalId}/moh`, { query: { mohClass: "default" } });
  }

  async pararMusica(canalId: string) {
    try {
      await this.pedir("DELETE", `/channels/${canalId}/moh`);
    } catch (e) {
      if (e instanceof ErroAri && (e.status === 404 || e.status === 409)) return;
      throw e;
    }
  }

  /** Toca um tom de progresso (`ring`, `busy`) no canal, pela tabela `br` do indications.conf. */
  tocarTom(canalId: string, tom: "ring" | "busy" | "congestion") {
    return this.pedir<{ id: string }>("POST", `/channels/${canalId}/play`, {
      query: { media: `tone:${tom};tonezone=br` },
    });
  }

  async pararReproducao(playbackId: string) {
    try {
      await this.pedir("DELETE", `/playbacks/${playbackId}`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  /**
   * Toca uma fala do telefone no canal (URA, aguarde, aviso). `midia` é
   * `sound:<caminho SEM extensão>` — o Asterisk escolhe o arquivo pelo formato
   * (`.ulaw`). Medido na VPS (Task 0): responde 201 com `state: "queued"`; o
   * fim chega pelo evento `PlaybackFinished` no WebSocket, nunca por polling.
   */
  tocarFala(canalId: string, midia: string) {
    return this.pedir<{ id: string }>("POST", `/channels/${canalId}/play`, { query: { media: midia } });
  }

  /**
   * Para uma fala em andamento. Nome próprio para a URA ler melhor no chamador
   * (`pararReproducao` é do tom) — mesmo endpoint, mesmo corpo: um playback que
   * já terminou responde 404 (`GET /playbacks/{id}` medido na VPS) e NÃO é erro.
   */
  pararFala(playbackId: string) {
    return this.pararReproducao(playbackId);
  }

  listarCanais() {
    return this.pedir<CanalAri[]>("GET", "/channels");
  }

  // ─── transferência (fase 2, versão 2) ────────────────────────────────────

  /** Música para todos na ponte — o cliente, enquanto a transferência acontece (D19). */
  musicaNaPonte(ponteId: string) {
    return this.pedir("POST", `/bridges/${ponteId}/moh`, { query: { mohClass: "default" } });
  }

  /** Para a música da ponte. Ponte que já caiu (404) ou sem música (409) é o estado desejado. */
  async pararMusicaNaPonte(ponteId: string) {
    try {
      await this.pedir("DELETE", `/bridges/${ponteId}/moh`);
    } catch (e) {
      if (e instanceof ErroAri && (e.status === 404 || e.status === 409)) return;
      throw e;
    }
  }

  /**
   * Tira o canal da ponte SEM desligá-lo. O canal que já não está nela (422) ou
   * a ponte que já caiu (404) é o estado desejado.
   */
  async tirarDaPonte(ponteId: string, canalId: string) {
    try {
      await this.pedir("POST", `/bridges/${ponteId}/removeChannel`, { query: { channel: canalId } });
    } catch (e) {
      if (e instanceof ErroAri && (e.status === 404 || e.status === 422)) return;
      throw e;
    }
  }

  /**
   * Um EVENTO DE USUÁRIO para a aplicação Stasis (D13): é assim que a API manda a
   * ordem da tela ao worker, que o recebe como `ChannelUserevent` na mesma
   * WebSocket dos eventos das ligações. Sem `source`: a ordem não é de um canal,
   * é da aplicação. As variáveis vão no CORPO, nunca na URL.
   */
  emitirEvento(nome: string, variaveis: Record<string, string>) {
    if (!/^[a-z_]{1,60}$/.test(nome)) throw new Error(`nome de evento inválido: ${nome.slice(0, 40)}`);
    return this.pedir("POST", `/events/user/${nome}`, {
      query: { application: APP_STASIS },
      corpo: { variables: variaveis },
    });
  }

  // ─── gravação da ponte (F3; medido na VPS em 2026-09-29) ─────────────────
  //
  // O Asterisk grava a PONTE (os dois lados misturados) em WAV, no diretório de
  // gravações dele; o worker baixa o arquivo pela própria ARI — nenhum volume
  // compartilhado — e o apaga depois de guardá-lo no Storage.

  /**
   * Começa a gravar a ponte. `ifExists=overwrite`: o nome é o da ligação, e um
   * resto de uma tentativa anterior não pode travar a gravação nova. Sem bipe e
   * sem tecla que encerre — quem avisa é a fala do aviso de gravação.
   */
  gravarPonte(ponteId: string, nome: string, tetoS: number) {
    return this.pedir("POST", `/bridges/${ponteId}/record`, {
      query: {
        name: nomeDeGravacao(nome),
        format: "wav",
        maxDurationSeconds: tetoS,
        ifExists: "overwrite",
        beep: "false",
        terminateOn: "none",
      },
    });
  }

  /** Para a gravação e fecha o arquivo. 404 = já parada (a ponte caiu antes): o estado desejado. */
  async pararGravacao(nome: string) {
    try {
      await this.pedir("POST", `/recordings/live/${nomeDeGravacao(nome)}/stop`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  /** Toca uma mídia para TODOS na ponte (o aviso de gravação da ligação feita). */
  tocarNaPonte(ponteId: string, midia: string) {
    return this.pedir<{ id: string }>("POST", `/bridges/${ponteId}/play`, { query: { media: midia } });
  }

  /**
   * Baixa o arquivo guardado para `destino`, em stream: uma ligação de 2 h tem
   * ~115 MB de WAV, e o worker vive com 512 MB. 404 = o Asterisk não tem o
   * arquivo (ainda não fechou, ou se perdeu num reinício): `"ausente"`.
   */
  async baixarGravacao(nome: string, destino: string, prazoMs = 120_000): Promise<{ bytes: number } | "ausente"> {
    const caminho = `/recordings/stored/${nomeDeGravacao(nome)}/file`;
    const resp = await fetch(new URL(`${this.config.baseUrl}/ari${caminho}`), {
      method: "GET",
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(prazoMs),
    });
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => undefined);
      return "ausente";
    }
    if (!resp.ok || !resp.body) throw new ErroAri(resp.status, await resp.text().catch(() => ""), caminho);
    await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destino));
    return { bytes: (await stat(destino)).size };
  }

  /** Apaga o arquivo guardado. 404 = já apagado: o estado desejado. */
  async apagarGravacao(nome: string) {
    try {
      await this.pedir("DELETE", `/recordings/stored/${nomeDeGravacao(nome)}`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  /** Os nomes das gravações guardadas no Asterisk (a passada acha as órfãs por aqui). */
  async listarGravacoes(): Promise<string[]> {
    const lista = await this.pedir<Array<{ name: string }>>("GET", "/recordings/stored");
    return (lista ?? []).map((g) => g.name);
  }

  /** WebSocket de eventos da aplicação Stasis. Quem reconecta é o laço do worker. */
  abrirEventos(): WebSocket {
    const url = new URL(`${this.config.baseUrl}/ari/events`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", APP_STASIS);
    url.searchParams.set("subscribeAll", "false");
    // O WebSocket do Node (undici) aceita cabeçalhos no segundo argumento.
    // Tipado como o do navegador, que não aceita — daí o cast.
    return new WebSocket(url, { headers: { Authorization: this.auth } } as unknown as string[]);
  }
}
