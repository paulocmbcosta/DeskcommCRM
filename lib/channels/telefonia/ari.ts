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
   * Para uma fala em andamento. Um playback que já terminou responde 404
   * (`GET /playbacks/{id}` medido na VPS) e NÃO é erro — o estado desejado
   * (fala parada) já vale.
   */
  async pararFala(playbackId: string) {
    try {
      await this.pedir("DELETE", `/playbacks/${playbackId}`);
    } catch (e) {
      if (e instanceof ErroAri && e.status === 404) return;
      throw e;
    }
  }

  listarCanais() {
    return this.pedir<CanalAri[]>("GET", "/channels");
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
