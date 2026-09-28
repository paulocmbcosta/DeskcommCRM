/**
 * O CÉREBRO DA TELEFONIA — a aplicação Stasis `crm` (spec 20 §4.2).
 *
 * O Asterisk entrega aqui toda ligação (o dialplan só diz `Stasis(crm)`),
 * e este controlador decide tudo o que não é áudio:
 *
 *   RECEBIDA  tronco → contato/conversa/voice_calls → toca UM ramal por vez,
 *             quem atendeu menos hoje primeiro, 20 s cada, 2 voltas → ponte.
 *             Ninguém disponível: atende e põe música, reavaliando, até 2 min.
 *   FEITA     o ramal disca `c-<voice_call_id>` → confere que a API criou essa
 *             ligação para ESTE atendente há menos de 60 s → cria a perna da
 *             operadora, põe as duas numa ponte e disca.
 *
 * Estado em memória por ligação. Se o worker reinicia no meio de uma ligação,
 * `recuperar()` reencontra as pontes vivas pelo nome (`p-<voice_call_id>`) e
 * volta a vigiar o fim delas; o que estava só tocando é encerrado como perdido.
 *
 * ARI e banco entram como PORTAS (interfaces): o teste troca os dois por
 * dublês e exercita a máquina de estados inteira sem Asterisk nem Postgres.
 */
import {
  ESPERA_NA_FILA_MS,
  ESTADO_INICIAL,
  REAVALIAR_FILA_MS,
  TOQUE_POR_ATENDENTE_MS,
  proximoToque,
  type CandidatoAoToque,
  type EstadoDoToque,
} from "@/lib/telefonia/distribuicao";
import { binaParaE164, numeroParaLigar } from "@/lib/telefonia/numero";

import type { CanalAri } from "./ari";
import { donoDoEndpoint, endpointDoCanal, idDoRamal, idDoTronco } from "./pjsip";
import type { DesfechoDaLigacao, LigacaoDoBanco, NovaLigacao, TroncoDoBanco } from "./repositorio";

// ─── portas ────────────────────────────────────────────────────────────────

export interface PortaAri {
  atender(canal: string): Promise<unknown>;
  indicarChamando(canal: string): Promise<unknown>;
  desligar(canal: string, motivo?: "normal" | "busy" | "congestion" | "no_answer"): Promise<unknown>;
  originar(p: {
    endpoint: string;
    appArgs: string;
    callerId?: string;
    prazoS: number;
    variaveis?: Record<string, string>;
  }): Promise<{ id: string }>;
  criarCanal(p: { endpoint: string; appArgs: string; callerId?: string }): Promise<{ id: string }>;
  discar(canal: string, prazoS: number): Promise<unknown>;
  criarPonte(id: string): Promise<{ id: string }>;
  porNaPonte(ponte: string, canal: string): Promise<unknown>;
  destruirPonte(ponte: string): Promise<unknown>;
  musicaDeEspera(canal: string): Promise<unknown>;
  pararMusica(canal: string): Promise<unknown>;
  tocarTom(canal: string, tom: "ring" | "busy" | "congestion"): Promise<{ id: string }>;
  pararReproducao(id: string): Promise<unknown>;
  /** O ramal está registrado (há navegador para tocar)? */
  ramalOnline(userId: string): Promise<boolean>;
  /** Pontes vivas com os canais de cada uma — para `recuperar()`. */
  pontes(): Promise<Array<{ id: string; channels: string[] }>>;
  canais(): Promise<Array<{ id: string }>>;
}

export interface PortaBanco {
  troncoPorId(id: string): Promise<TroncoDoBanco | null>;
  disponiveisNoTime(org: string, teamId: string, agora: Date): Promise<CandidatoAoToque[]>;
  acharOuCriarContato(org: string, e164: string, nome: string | null): Promise<string>;
  acharOuCriarConversa(org: string, contactId: string, troncoId: string, teamId: string | null): Promise<string>;
  criarLigacao(l: NovaLigacao): Promise<string>;
  ligacaoPorId(id: string): Promise<LigacaoDoBanco | null>;
  ligacoesVivas(): Promise<LigacaoDoBanco[]>;
  marcarTocando(id: string, userId: string | null): Promise<void>;
  marcarAtendida(id: string, userId: string): Promise<void>;
  encerrarLigacao(id: string, motivo: string): Promise<LigacaoDoBanco | null>;
  atribuirConversa(org: string, conversationId: string, userId: string): Promise<void>;
  registrarNaConversa(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, duracaoMs: number | null): Promise<void>;
  avisarPerdida(l: LigacaoDoBanco): Promise<void>;
  registrarFim(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, motivo: string): Promise<void>;
}

export interface Registro {
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
  error(msg: string, campos?: Record<string, unknown>): void;
}

// ─── eventos da ARI que importam ───────────────────────────────────────────

export type EventoAri =
  | { type: "StasisStart"; channel: CanalAri; args: string[] }
  | { type: "StasisEnd"; channel: CanalAri }
  | { type: "ChannelDestroyed"; channel: CanalAri; cause: number; cause_txt?: string }
  | { type: "Dial"; peer: CanalAri; dialstatus: string }
  | { type: string; [k: string]: unknown };

// ─── estado por ligação ────────────────────────────────────────────────────

interface Recebida {
  tipo: "recebida";
  vcId: string;
  org: string;
  tronco: TroncoDoBanco;
  cliente: string;
  numeroExibido: string;
  inicio: number;
  estado: EstadoDoToque;
  ramal: { canal: string; userId: string } | null;
  atendidaPor: string | null;
  conversationId: string | null;
  atendidaPelaRede: boolean;
  naFila: boolean;
  inicioFila: number | null;
  ponte: string | null;
  relogio: ReturnType<typeof setTimeout> | null;
  fim: boolean;
}

interface Feita {
  tipo: "feita";
  vcId: string;
  org: string;
  userId: string;
  ramal: string;
  perna: string | null;
  ponte: string;
  tom: string | null;
  atendida: boolean;
  causaDaRede: number | null;
  fim: boolean;
}

/** Só a vigia do fim: ligação reencontrada depois de um reinício do worker. */
interface Recuperada {
  tipo: "recuperada";
  vcId: string;
  ponte: string;
  canais: string[];
  fim: boolean;
}

type Ligacao = Recebida | Feita | Recuperada;

/** Depois de tocar tanto sem atender, a rede pode derrubar a ligação: atende e segue na fila. */
const ATENDER_E_SEGURAR_APOS_MS = 45_000;
/** Ligação de saída: prazo para a pessoa do outro lado atender. */
const PRAZO_DA_SAIDA_S = 60;
/** A API cria a voice_calls e o navegador disca logo em seguida — mais que isto é reuso. */
const VALIDADE_DO_PEDIDO_DE_SAIDA_MS = 60_000;

/** Causas Q.850 que querem dizer "a rede recusou", não "ninguém atendeu". */
const CAUSAS_DE_RECUSA = new Set([1, 3, 20, 21, 22, 27, 28, 34, 38, 41, 42, 47, 58, 88, 102, 111, 127]);

const ponteDe = (vcId: string) => `p-${vcId}`;

export class ControladorDeChamadas {
  private readonly porCanal = new Map<string, Ligacao>();
  private readonly porId = new Map<string, Ligacao>();
  /** Última causa Q.850 vista por canal (ChannelHangupRequest), para quando o fim chega sem ela. */
  private readonly causas = new Map<string, number>();
  /**
   * Por onde os relógios (toque vencido, reavaliar a fila) entram. O laço do
   * worker troca por sua fila serial, para um relógio nunca rodar no meio do
   * tratamento de um evento da mesma ligação.
   */
  private emFila: (fn: () => Promise<void>) => Promise<void> = (fn) => fn();

  usarFila(fila: (fn: () => Promise<void>) => Promise<void>) {
    this.emFila = fila;
  }

  constructor(
    private readonly ari: PortaAri,
    private readonly banco: PortaBanco,
    private readonly log: Registro,
    private readonly agora: () => number = Date.now,
  ) {}

  /** Quantas ligações o controlador está acompanhando (para /healthz e testes). */
  get ativas(): number {
    return this.porId.size;
  }

  async tratar(ev: EventoAri): Promise<void> {
    try {
      switch (ev.type) {
        case "StasisStart":
          return await this.aoEntrarNoStasis(ev as Extract<EventoAri, { type: "StasisStart" }>);
        // StasisEnd também é fim: canal desligado DENTRO do Stasis pode sair da
        // aplicação sem que o ChannelDestroyed chegue depois (a aplicação deixa
        // de assinar o canal). Os dois caminhos são idempotentes.
        case "StasisEnd":
        case "ChannelDestroyed":
          return await this.aoDestruirCanal(ev as Extract<EventoAri, { type: "ChannelDestroyed" }>);
        case "ChannelHangupRequest": {
          const h = ev as { channel?: { id: string }; cause?: number };
          if (h.channel?.id && typeof h.cause === "number") this.causas.set(h.channel.id, h.cause);
          return;
        }
        case "Dial":
          return await this.aoDiscar(ev as Extract<EventoAri, { type: "Dial" }>);
        default:
          return;
      }
    } catch (e) {
      this.log.error("telefonia: evento falhou", {
        tipo: ev.type,
        erro: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  // ─── entrada no Stasis ───────────────────────────────────────────────────

  private async aoEntrarNoStasis(ev: Extract<EventoAri, { type: "StasisStart" }>) {
    const [papel, vcId] = ev.args;
    if (papel === "entrada") return this.novaRecebida(ev.channel);
    if (papel === "saida") return this.novaFeita(ev.channel);
    if (papel === "oferta" && vcId) return this.ramalAtendeu(ev.channel, vcId);
    // "perna": a perna da operadora nasce já dentro do Stasis (channels/create);
    // quem cuida dela é a ligação feita, pelos eventos Dial e ChannelDestroyed.
    if (papel === "perna") return;
    this.log.warn("telefonia: canal sem papel conhecido — desligado", { canal: ev.channel.name, papel });
    await this.ari.desligar(ev.channel.id);
  }

  private registrar(l: Ligacao, canal: string) {
    this.porCanal.set(canal, l);
    this.porId.set(l.vcId, l);
  }

  // ─── recebida ────────────────────────────────────────────────────────────

  private async novaRecebida(canal: CanalAri) {
    const endpoint = endpointDoCanal(canal.name);
    const dono = endpoint ? donoDoEndpoint(endpoint) : null;
    if (dono?.tipo !== "tronco") {
      this.log.warn("telefonia: entrada que não veio de tronco — desligada", { canal: canal.name });
      await this.ari.desligar(canal.id, "congestion");
      return;
    }
    const tronco = await this.banco.troncoPorId(dono.id);
    if (!tronco) {
      this.log.warn("telefonia: tronco desconhecido ou arquivado — desligada", { tronco: dono.id });
      await this.ari.desligar(canal.id, "congestion");
      return;
    }

    // O chamar que quem ligou ouve enquanto escolhemos quem atende.
    await this.ari.indicarChamando(canal.id).catch(() => undefined);

    const e164 = binaParaE164(canal.caller.number);
    let contactId: string | null = null;
    let conversationId: string | null = null;
    if (e164) {
      contactId = await this.banco.acharOuCriarContato(tronco.organizationId, e164, canal.caller.name || null);
      conversationId = await this.banco.acharOuCriarConversa(tronco.organizationId, contactId, tronco.id, tronco.teamId);
    }
    const vcId = await this.banco.criarLigacao({
      organizationId: tronco.organizationId,
      troncoId: tronco.id,
      sipCallRef: canal.id,
      direcao: "inbound",
      numeroDoOutroLado: e164 ?? (canal.caller.number || "desconhecido"),
      contactId,
      conversationId,
      teamId: tronco.teamId,
      status: "ringing",
    });

    const l: Recebida = {
      tipo: "recebida",
      vcId,
      org: tronco.organizationId,
      tronco,
      cliente: canal.id,
      numeroExibido: e164 ?? canal.caller.number ?? "",
      inicio: this.agora(),
      estado: ESTADO_INICIAL,
      ramal: null,
      atendidaPor: null,
      conversationId,
      atendidaPelaRede: false,
      naFila: false,
      inicioFila: null,
      ponte: null,
      relogio: null,
      fim: false,
    };
    this.registrar(l, canal.id);
    this.log.info("telefonia: ligação recebida", { voice_call: vcId, tronco: tronco.id, time: tronco.teamId });
    await this.tocarProximo(l);
  }

  private async disponiveisComRamal(l: Recebida): Promise<CandidatoAoToque[]> {
    if (!l.tronco.teamId) return [];
    const todos = await this.banco.disponiveisNoTime(l.org, l.tronco.teamId, new Date(this.agora()));
    const online = await Promise.all(todos.map((c) => this.ari.ramalOnline(c.userId).catch(() => false)));
    return todos.filter((_, i) => online[i]);
  }

  private async segurarNaLinha(l: Recebida) {
    if (l.atendidaPelaRede) return;
    l.atendidaPelaRede = true;
    await this.ari.atender(l.cliente);
    await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
  }

  private async tocarProximo(l: Recebida): Promise<void> {
    if (l.fim || l.atendidaPor) return;
    const disponiveis = await this.disponiveisComRamal(l);
    const p = proximoToque(disponiveis, l.estado);

    if (p.tipo === "desistir") return this.encerrarRecebida(l, "ninguem_atendeu");

    if (p.tipo === "esperar") {
      if (!l.naFila) {
        l.naFila = true;
        l.inicioFila = this.agora();
        await this.segurarNaLinha(l);
        await this.banco.marcarTocando(l.vcId, null);
      }
      if (this.agora() - (l.inicioFila ?? this.agora()) >= ESPERA_NA_FILA_MS) {
        return this.encerrarRecebida(l, "fila_esgotada");
      }
      this.armar(l, REAVALIAR_FILA_MS, () => this.tocarProximo(l));
      return;
    }

    l.estado = p.estado;
    // Tocou demais sem ninguém pegar (ou começou a segunda volta): atende e
    // segura com música — a rede costuma derrubar ligação que só chama.
    if (p.estado.volta > 1 || this.agora() - l.inicio >= ATENDER_E_SEGURAR_APOS_MS) {
      await this.segurarNaLinha(l);
    }

    let canalDoRamal: { id: string };
    try {
      canalDoRamal = await this.ari.originar({
        endpoint: `PJSIP/${idDoRamal(p.userId)}`,
        appArgs: `oferta,${l.vcId}`,
        callerId: l.numeroExibido,
        prazoS: Math.round(TOQUE_POR_ATENDENTE_MS / 1000),
        variaveis: { "PJSIP_HEADER(add,X-Ligacao-Id)": l.vcId },
      });
    } catch (e) {
      // Ramal que sumiu entre a pergunta e o toque: conta como tocado e segue.
      this.log.warn("telefonia: não consegui tocar o ramal — próximo", {
        voice_call: l.vcId,
        erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
      return this.tocarProximo(l);
    }
    l.ramal = { canal: canalDoRamal.id, userId: p.userId };
    this.porCanal.set(canalDoRamal.id, l);
    await this.banco.marcarTocando(l.vcId, p.userId);
    // Rede de segurança: se o Asterisk não derrubar o toque no prazo, derrubamos.
    const canalEsperado = canalDoRamal.id;
    this.armar(l, TOQUE_POR_ATENDENTE_MS + 3_000, async () => {
      if (l.ramal?.canal === canalEsperado && !l.atendidaPor) await this.ari.desligar(canalEsperado, "no_answer");
    });
  }

  private armar(l: Recebida, ms: number, fn: () => Promise<unknown>) {
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = setTimeout(() => {
      l.relogio = null;
      if (!l.fim)
        void this.emFila(async () => {
          if (!l.fim) await fn();
        }).catch((e) => this.log.error("telefonia: relógio falhou", { erro: String(e) }));
    }, ms);
  }

  private async ramalAtendeu(canal: CanalAri, vcId: string) {
    const l = this.porId.get(vcId);
    if (!l || l.tipo !== "recebida" || l.fim || l.ramal?.canal !== canal.id || l.atendidaPor) {
      // Atendeu tarde (a ligação já foi para outro ou acabou): larga o ramal.
      await this.ari.desligar(canal.id);
      return;
    }
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = null;
    l.atendidaPor = l.ramal.userId;

    if (l.atendidaPelaRede) await this.ari.pararMusica(l.cliente);
    else {
      l.atendidaPelaRede = true;
      await this.ari.atender(l.cliente);
    }
    l.ponte = ponteDe(vcId);
    await this.ari.criarPonte(l.ponte);
    await this.ari.porNaPonte(l.ponte, l.cliente);
    await this.ari.porNaPonte(l.ponte, canal.id);
    await this.banco.marcarAtendida(vcId, l.atendidaPor);
    if (l.conversationId) {
      await this.banco.atribuirConversa(l.org, l.conversationId, l.atendidaPor).catch((e) =>
        this.log.warn("telefonia: conversa não atribuída a quem atendeu", { erro: String(e) }),
      );
    }
    this.log.info("telefonia: ligação atendida", { voice_call: vcId, atendente: l.atendidaPor });
  }

  private async encerrarRecebida(l: Recebida, motivo: string) {
    if (l.fim) return;
    l.fim = true;
    if (l.relogio) clearTimeout(l.relogio);
    const outros = [l.cliente, l.ramal?.canal].filter((c): c is string => Boolean(c));
    for (const c of outros) {
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    if (l.ponte) await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    await this.finalizar(l.vcId, l.atendidaPor ? "atendida" : "perdida", motivo);
  }

  // ─── feita ───────────────────────────────────────────────────────────────

  private async novaFeita(canal: CanalAri) {
    const endpoint = endpointDoCanal(canal.name);
    const dono = endpoint ? donoDoEndpoint(endpoint) : null;
    const m = /^c-([0-9a-f-]{36})$/.exec(canal.dialplan.exten);
    const recusar = async (motivo: string, extra: Record<string, unknown> = {}) => {
      this.log.warn(`telefonia: saída recusada — ${motivo}`, { canal: canal.name, ...extra });
      await this.ari.desligar(canal.id, "congestion");
    };
    if (dono?.tipo !== "ramal") return recusar("não veio de ramal");
    if (!m) return recusar("destino não é um pedido de ligação");

    const vc = await this.banco.ligacaoPorId(m[1]!);
    if (!vc) return recusar("pedido inexistente");
    // A autorização inteira da ligação de saída: o pedido existe, é de saída,
    // ainda não começou, é DESTE atendente e é recente. A senha do ramal, sozinha,
    // não disca para lugar nenhum.
    if (vc.direction !== "outbound" || vc.status !== "starting") return recusar("pedido já usado", { voice_call: vc.id });
    if (vc.owner_user_id !== dono.id) return recusar("pedido de outro atendente", { voice_call: vc.id });
    if (this.agora() - new Date(vc.started_at).getTime() > VALIDADE_DO_PEDIDO_DE_SAIDA_MS) {
      await this.banco.encerrarLigacao(vc.id, "pedido_expirado");
      return recusar("pedido expirado", { voice_call: vc.id });
    }
    const numero = numeroParaLigar(vc.peer_phone);
    if (!numero.ok) {
      await this.banco.encerrarLigacao(vc.id, `numero_${numero.motivo}`);
      return recusar("número fora da política", { voice_call: vc.id, motivo: numero.motivo });
    }
    const tronco = await this.banco.troncoPorId(vc.channel_session_id);
    if (!tronco || tronco.organizationId !== vc.organization_id) {
      await this.banco.encerrarLigacao(vc.id, "tronco_indisponivel");
      return recusar("tronco indisponível", { voice_call: vc.id });
    }

    const l: Feita = {
      tipo: "feita",
      vcId: vc.id,
      org: vc.organization_id,
      userId: dono.id,
      ramal: canal.id,
      perna: null,
      ponte: ponteDe(vc.id),
      tom: null,
      atendida: false,
      causaDaRede: null,
      fim: false,
    };
    this.registrar(l, canal.id);

    await this.ari.atender(canal.id);
    await this.ari.criarPonte(l.ponte);
    await this.ari.porNaPonte(l.ponte, canal.id);
    const perna = await this.ari.criarCanal({
      endpoint: `PJSIP/${numero.discar}@${idDoTronco(tronco.id)}`,
      appArgs: `perna,${vc.id}`,
      ...(tronco.numero ? { callerId: tronco.numero.replace(/^\+55/, "") } : {}),
    });
    l.perna = perna.id;
    this.porCanal.set(perna.id, l);
    await this.ari.porNaPonte(l.ponte, perna.id);
    // O chamar local até a operadora mandar áudio próprio (183) ou atender.
    l.tom = (await this.ari.tocarTom(canal.id, "ring").catch(() => null))?.id ?? null;
    await this.banco.marcarTocando(vc.id, null);
    await this.ari.discar(perna.id, PRAZO_DA_SAIDA_S);
    this.log.info("telefonia: ligação feita", { voice_call: vc.id, tronco: tronco.id });
  }

  private async pararTom(l: Feita) {
    if (!l.tom) return;
    const id = l.tom;
    l.tom = null;
    await this.ari.pararReproducao(id).catch(() => undefined);
  }

  private async aoDiscar(ev: Extract<EventoAri, { type: "Dial" }>) {
    const l = this.porCanal.get(ev.peer.id);
    if (!l || l.tipo !== "feita" || l.perna !== ev.peer.id || l.fim) return;
    const s = ev.dialstatus;
    // O desfecho da discagem vira causa Q.850 aproximada, para o caso de o fim
    // do canal chegar sem causa própria (StasisEnd não traz).
    const causaDoDial: Record<string, number> = { BUSY: 17, NOANSWER: 19, CHANUNAVAIL: 34, CONGESTION: 34 };
    if (causaDoDial[s] !== undefined) this.causas.set(ev.peer.id, causaDoDial[s]!);
    if (s === "PROGRESS") return this.pararTom(l);
    if (s === "ANSWER") {
      await this.pararTom(l);
      l.atendida = true;
      await this.banco.marcarAtendida(l.vcId, l.userId);
      this.log.info("telefonia: ligação feita atendida", { voice_call: l.vcId });
    }
  }

  private async encerrarFeita(l: Feita, motivo: string) {
    if (l.fim) return;
    l.fim = true;
    for (const c of [l.ramal, l.perna]) {
      if (!c) continue;
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    const desfecho: DesfechoDaLigacao = l.atendida
      ? "atendida"
      : l.causaDaRede !== null && CAUSAS_DE_RECUSA.has(l.causaDaRede)
        ? "recusada_pela_rede"
        : "sem_resposta";
    await this.finalizar(l.vcId, desfecho, motivo);
  }

  // ─── fim de canal ────────────────────────────────────────────────────────

  private async aoDestruirCanal(ev: Extract<EventoAri, { type: "ChannelDestroyed" }>) {
    const causaVista = this.causas.get(ev.channel.id);
    this.causas.delete(ev.channel.id);
    const l = this.porCanal.get(ev.channel.id);
    if (!l || l.fim) return;
    this.porCanal.delete(ev.channel.id);
    const causa = typeof ev.cause === "number" ? ev.cause : (causaVista ?? 16);
    this.log.info("telefonia: canal encerrado", { voice_call: l.vcId, canal: ev.channel.name, causa });

    if (l.tipo === "recebida") {
      if (ev.channel.id === l.cliente) return this.encerrarRecebida(l, "cliente_desligou");
      if (l.ramal?.canal === ev.channel.id) {
        if (l.atendidaPor) return this.encerrarRecebida(l, "atendente_desligou");
        // Não atendeu, recusou ou o ramal caiu: próximo da lista.
        l.ramal = null;
        if (l.relogio) clearTimeout(l.relogio);
        l.relogio = null;
        await this.banco.marcarTocando(l.vcId, null);
        return this.tocarProximo(l);
      }
      return;
    }

    if (l.tipo === "feita") {
      if (ev.channel.id === l.perna) {
        l.causaDaRede = causa;
        return this.encerrarFeita(l, l.atendida ? "cliente_desligou" : `rede_${ev.cause}`);
      }
      return this.encerrarFeita(l, "atendente_desligou");
    }

    // Recuperada: qualquer ponta que cai derruba as outras.
    l.fim = true;
    for (const c of l.canais) {
      this.porCanal.delete(c);
      if (c !== ev.channel.id) await this.ari.desligar(c).catch(() => undefined);
    }
    await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    await this.finalizar(l.vcId, "atendida", "encerrada_apos_reinicio");
  }

  private async finalizar(vcId: string, desfechoPedido: DesfechoDaLigacao, motivo: string) {
    const l = await this.banco.encerrarLigacao(vcId, motivo);
    if (!l) return; // já encerrada por outro caminho
    const desfecho: DesfechoDaLigacao = l.answered_at ? "atendida" : desfechoPedido === "atendida" ? "perdida" : desfechoPedido;
    const duracao = l.answered_at ? this.agora() - new Date(l.answered_at).getTime() : null;
    await this.banco.registrarNaConversa(l, desfecho, duracao);
    if (desfecho === "perdida" && l.direction === "inbound") await this.banco.avisarPerdida(l);
    await this.banco.registrarFim(l, desfecho, motivo);
    this.log.info("telefonia: ligação encerrada", { voice_call: vcId, desfecho, motivo });
  }

  // ─── reinício do worker ──────────────────────────────────────────────────

  /**
   * Depois de (re)conectar à ARI: o que o banco diz estar vivo é conferido com
   * o que o Asterisk tem. Ponte viva `p-<id>` = ligação em curso: volta a ser
   * vigiada. Qualquer outra ligação "viva" no banco e sem ponte morreu com o
   * worker anterior — encerrada, e a recebida vira perdida (alguém liga de volta).
   */
  async recuperar(): Promise<void> {
    const [vivas, pontes, canais] = await Promise.all([
      this.banco.ligacoesVivas(),
      this.ari.pontes(),
      this.ari.canais(),
    ]);
    const canaisVivos = new Set(canais.map((c) => c.id));
    for (const vc of vivas) {
      if (this.porId.has(vc.id)) continue;
      const ponte = pontes.find((p) => p.id === ponteDe(vc.id));
      const canaisDaPonte = (ponte?.channels ?? []).filter((c) => canaisVivos.has(c));
      if (ponte && canaisDaPonte.length >= 2) {
        const r: Recuperada = { tipo: "recuperada", vcId: vc.id, ponte: ponte.id, canais: canaisDaPonte, fim: false };
        this.porId.set(vc.id, r);
        for (const c of canaisDaPonte) this.porCanal.set(c, r);
        this.log.info("telefonia: ligação em curso retomada após reinício", { voice_call: vc.id });
        continue;
      }
      for (const c of canaisDaPonte) await this.ari.desligar(c).catch(() => undefined);
      if (vc.sip_call_ref && canaisVivos.has(vc.sip_call_ref)) await this.ari.desligar(vc.sip_call_ref).catch(() => undefined);
      if (ponte) await this.ari.destruirPonte(ponte.id).catch(() => undefined);
      await this.finalizar(vc.id, vc.answered_at ? "atendida" : "perdida", "interrompida_no_reinicio");
    }
  }
}
