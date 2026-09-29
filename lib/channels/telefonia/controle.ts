/**
 * O CÉREBRO DA TELEFONIA — a aplicação Stasis `crm` (spec 20 §4.2; fase 2 em
 * docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md).
 *
 * O Asterisk entrega aqui toda ligação (o dialplan só diz `Stasis(crm)`),
 * e este controlador decide tudo o que não é áudio:
 *
 *   RECEBIDA  tronco → contato/conversa/voice_calls → FILA DO TIME (§5.2):
 *             time fora do horário, com a fala pronta → "fora do horário" e
 *             desliga (sem "Ligar de volta"); aviso de instabilidade vigente →
 *             toca o aviso INTEIRO; então toca UM ramal por vez, quem atendeu
 *             menos hoje primeiro, 20 s cada, 2 voltas → ponte. Quem espera
 *             ouve "aguarde", música, e o "aguarde" de novo a cada ~40 s, até
 *             2 min contados da entrada na fila. Esgotou: "ninguém atendeu" e
 *             desliga, e a ligação vira "Ligar de volta" na Central.
 *   FEITA     o ramal disca `c-<voice_call_id>` → confere que a API criou essa
 *             ligação para ESTE atendente há menos de 60 s → cria a perna da
 *             operadora, põe as duas numa ponte e disca.
 *
 * Sem fala nenhuma configurada, a fila é a da fase 1, chamada por chamada: o
 * número que aponta para um time se comporta como antes. Fala sem arquivo no
 * disco, ou que o Asterisk não tocou, é PULADA — a ligação segue como se ela não
 * existisse — e vira `phone_prompt_unplayable` na Central. Nada aqui chama a
 * ElevenLabs (D15): o disco das falas só copia do Storage.
 *
 * Estado em memória por ligação. Se o worker reinicia no meio de uma ligação,
 * `recuperar()` reencontra as pontes vivas pelo nome (`p-<voice_call_id>`) e
 * volta a vigiar o fim delas; o que estava só tocando é encerrado como perdido.
 *
 * ARI, banco e disco das falas entram como PORTAS (interfaces): o teste troca os
 * três por dublês e exercita a máquina de estados inteira sem Asterisk nem Postgres.
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
import { RECUSA_DA_SAIDA, fimDaSaidaNaoAtendida } from "@/lib/telefonia/fim-da-saida";
import { binaParaE164, numeroParaLigar } from "@/lib/telefonia/numero";
import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";

import { ErroAri, type CanalAri } from "./ari";
import { donoDoEndpoint, endpointDoCanal, enderecoDeSaida, idDoRamal } from "./pjsip";
import type {
  DesfechoDaLigacao,
  EscolhaDoMenu,
  FalaDoBanco,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  TimeParaAFila,
  TroncoDoBanco,
} from "./repositorio";

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
  /** Toca uma fala do telefone (URA, aguarde, aviso) e devolve o id do playback. */
  tocarFala(canal: string, midia: string): Promise<string>;
  /** Para uma fala em andamento. Um playback que já terminou não é erro. */
  pararFala(playbackId: string): Promise<unknown>;
  /** O ramal está registrado (há navegador para tocar)? */
  ramalOnline(userId: string): Promise<boolean>;
  /** Pontes vivas com os canais de cada uma — para `recuperar()`. */
  pontes(): Promise<Array<{ id: string; channels: string[] }>>;
  canais(): Promise<Array<{ id: string }>>;
}

export interface PortaBanco {
  troncoPorId(id: string): Promise<TroncoDoBanco | null>;
  disponiveisNoTime(org: string, teamId: string, agora: Date): Promise<CandidatoAoToque[]>;
  /** A entrada na fila: fora do horário/aberto/indisponível e o aviso de instabilidade vigente. */
  timeParaAFila(org: string, teamId: string, agora: Date): Promise<TimeParaAFila>;
  falasGerais(org: string): Promise<FalasGerais>;
  /** A URA (§5.1): o menu do número e o que o cliente escolheu nele. */
  menuPorId(org: string, menuId: string): Promise<MenuDoBanco | null>;
  registrarEscolhaDoMenu(org: string, id: string, e: EscolhaDoMenu): Promise<boolean>;
  /** O cliente ouviu o aviso de instabilidade INTEIRO (`emergency_heard_at`). */
  registrarAvisoOuvido(org: string, id: string): Promise<boolean>;
  /** A fala não tocou e a ligação seguiu sem ela: `phone_prompt_unplayable` na Central. */
  avisarFalaIntocavel(org: string, rotulo: string): Promise<void>;
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

/**
 * O disco das falas (`falas-no-disco.ts`): o endereço de mídia (`sound:…`) com
 * o arquivo garantido no volume, ou `null` — e aí a ligação pula a fala. Nunca
 * lança e espera no máximo 3 s (`PRAZO_DO_GARANTIR_MS`).
 */
export interface PortaFalas {
  garantir(fala: FalaDoBanco): Promise<string | null>;
}

/**
 * Sem disco das falas (o laço antes de ligá-lo): nenhuma fala toca. Se houver
 * fala configurada, ela é pulada e avisada como qualquer fala sem arquivo — a
 * Central conta a verdade: a fala existe e não tocou.
 */
const SEM_DISCO: PortaFalas = { garantir: async () => null };

export interface Registro {
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
  error(msg: string, campos?: Record<string, unknown>): void;
}

// ─── eventos da ARI que importam ───────────────────────────────────────────

/** O playback que a ARI devolve em `PlaybackStarted`/`PlaybackFinished` (Task 0, medido na VPS). */
export interface PlaybackAri {
  id: string;
  media_uri: string;
  target_uri: string;
  language: string;
  state: string;
}

/**
 * O que chega no WebSocket. `PlaybackFinished` fecha as falas da fila (§5.2).
 * `ChannelDtmfReceived` NÃO é tratado na fila, de propósito: o aviso de
 * instabilidade toca INTEIRO, e tecla nenhuma o interrompe — só a URA (Task 15)
 * lê teclas. `ChannelUserevent` é da transferência (versão 2).
 */
export type EventoAri =
  | { type: "StasisStart"; channel: CanalAri; args: string[] }
  | { type: "StasisEnd"; channel: CanalAri }
  | { type: "ChannelDestroyed"; channel: CanalAri; cause: number; cause_txt?: string }
  | { type: "Dial"; peer: CanalAri; dialstatus: string }
  | { type: "PlaybackFinished"; playback: PlaybackAri }
  /** As teclas da operadora chegam por RFC 4733 (Task 0, medido na VPS). */
  | { type: "ChannelDtmfReceived"; channel: CanalAri; digit: string; duration_ms?: number }
  | { type: "ChannelUserevent"; eventname: string; channel?: CanalAri; userevent?: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

// ─── estado por ligação ────────────────────────────────────────────────────

/** Para que serve a fala no ar — é o que decide o que vem depois dela. */
type PapelDaFala = "fora_do_horario" | "aviso" | "espera" | "ninguem";

/** Como a Central chama cada fala quando ela não toca (`phone_prompt_unplayable`). */
const ROTULO_DA_FALA = {
  fora_do_horario: "fora do horário",
  aviso: "aviso de instabilidade",
  espera: "aguarde",
  ninguem: "ninguém atendeu",
} as const satisfies Record<PapelDaFala, string>;

interface FalaNoAr {
  playbackId: string;
  papel: PapelDaFala;
  /** O nome da fala na Central, se ela não tocar ("aguarde", "menu Principal"…). */
  rotulo: string;
}

interface Recebida {
  tipo: "recebida";
  vcId: string;
  org: string;
  tronco: TroncoDoBanco;
  cliente: string;
  numeroExibido: string;
  /**
   * Quando a FILA começou (depois do aviso de instabilidade, §5.1.3) — a régua
   * do "tocou demais sem atender: atende e segura".
   */
  inicio: number;
  estado: EstadoDoToque;
  ramal: { canal: string; userId: string } | null;
  atendidaPor: string | null;
  conversationId: string | null;
  atendidaPelaRede: boolean;
  /** Segurando na linha ("aguarde" e música): o cliente já está esperando. */
  segurando: boolean;
  naFila: boolean;
  /** Início dos 2 min de espera sem ninguém disponível (fase 1). */
  inicioFila: number | null;
  ponte: string | null;
  /** Reavaliar a fila, ou a rede de segurança do toque do ramal. */
  relogio: ReturnType<typeof setTimeout> | null;
  /** A repetição do "aguarde" (~40 s de música entre um e outro). */
  relogioDaEspera: ReturnType<typeof setTimeout> | null;
  /** O time da fila: o do número (com a URA, o escolhido no menu). */
  teamId: string | null;
  /** Lidas na entrada da fila; todas `null` = a fila da fase 1. */
  falasGerais: FalasGerais;
  /** O aviso de instabilidade que ainda vai tocar (lido na entrada da fila). */
  avisoPendente: FalaDoBanco | null;
  /** A fala no ar — uma por vez. */
  fala: FalaNoAr | null;
  /** O motivo do fim, já decidido enquanto a última fala toca ("fora do horário", "ninguém atendeu"). */
  encerrando: string | null;
  /**
   * O cliente pediu para desligar (`ChannelHangupRequest`). Uma fala cortada
   * pela queda do canal termina `failed` ("Playback failed" no
   * res_stasis_playback) e NÃO é fala sem arquivo: não vira aviso na Central, e
   * o que viria depois dela não acontece — o fim chega logo atrás (StasisEnd).
   */
  clienteSaindo: boolean;
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
  /** Chegou `Dial` RINGING (180) ou PROGRESS (183): a rede completou até o telefone. */
  tocou: boolean;
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
/** Música entre um "aguarde" e o próximo (desenho §5.2.4: ~40 s). */
export const REPETIR_AGUARDE_MS = 40_000;

const SEM_FALAS_GERAIS: FalasGerais = Object.freeze({ aguarde: null, ninguem: null, foraDoHorario: null });

const ponteDe = (vcId: string) => `p-${vcId}`;
const mensagemDe = (e: unknown, max: number) => (e instanceof Error ? e.message.slice(0, max) : String(e).slice(0, max));

export class ControladorDeChamadas {
  private readonly porCanal = new Map<string, Ligacao>();
  private readonly porId = new Map<string, Ligacao>();
  /** A que ligação pertence cada fala no ar — o `PlaybackFinished` só traz o id do playback. */
  private readonly porReproducao = new Map<string, Recebida>();
  /** Última causa Q.850 vista por canal (ChannelHangupRequest), para quando o fim chega sem ela. */
  private readonly causas = new Map<string, number>();
  /**
   * Por onde os relógios (toque vencido, reavaliar a fila, repetir o "aguarde")
   * entram. O laço do worker troca por sua fila serial, para um relógio nunca
   * rodar no meio do tratamento de um evento da mesma ligação.
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
    private readonly falas: PortaFalas = SEM_DISCO,
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
          if (!h.channel?.id) return;
          if (typeof h.cause === "number") this.causas.set(h.channel.id, h.cause);
          const l = this.porCanal.get(h.channel.id);
          if (l?.tipo === "recebida" && l.cliente === h.channel.id) l.clienteSaindo = true;
          return;
        }
        case "Dial":
          return await this.aoDiscar(ev as Extract<EventoAri, { type: "Dial" }>);
        case "PlaybackFinished":
          return await this.aoTerminarFala(ev as Extract<EventoAri, { type: "PlaybackFinished" }>);
        default:
          return;
      }
    } catch (e) {
      this.log.error("telefonia: evento falhou", { tipo: ev.type, erro: mensagemDe(e, 300) });
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

    const teamId = tronco.teamId;
    const e164 = binaParaE164(canal.caller.number);
    let contactId: string | null = null;
    let conversationId: string | null = null;
    if (e164) {
      contactId = await this.banco.acharOuCriarContato(tronco.organizationId, e164, canal.caller.name || null);
      conversationId = await this.banco.acharOuCriarConversa(tronco.organizationId, contactId, tronco.id, teamId);
    }
    const vcId = await this.banco.criarLigacao({
      organizationId: tronco.organizationId,
      troncoId: tronco.id,
      sipCallRef: canal.id,
      direcao: "inbound",
      numeroDoOutroLado: e164 ?? (canal.caller.number || "desconhecido"),
      contactId,
      conversationId,
      teamId,
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
      segurando: false,
      naFila: false,
      inicioFila: null,
      ponte: null,
      relogio: null,
      relogioDaEspera: null,
      teamId,
      falasGerais: SEM_FALAS_GERAIS,
      avisoPendente: null,
      fala: null,
      encerrando: null,
      clienteSaindo: false,
      fim: false,
    };
    this.registrar(l, canal.id);
    this.log.info("telefonia: ligação recebida", { voice_call: vcId, tronco: tronco.id, time: teamId });
    await this.entrarNaFila(l);
  }

  /**
   * A FILA DO TIME (desenho §5.2), nesta ordem:
   *  1. fora do horário, com a fala pronta: "fora do horário" e desliga;
   *  2. aviso de instabilidade vigente: toca INTEIRO;
   *  3. os ramais, pela regra da fase 1 (rodízio, 20 s, 2 voltas, 2 min).
   * A leitura que falha não trava nada: sem ela, a fila é a da fase 1.
   */
  private async entrarNaFila(l: Recebida): Promise<void> {
    if (l.fim) return;
    let fila: TimeParaAFila = { situacao: "aberto", aviso: null };
    if (l.teamId) {
      try {
        fila = await this.banco.timeParaAFila(l.org, l.teamId, new Date(this.agora()));
      } catch (e) {
        this.log.warn("telefonia: situação do time não lida — segue a fila sem as falas do time", {
          voice_call: l.vcId,
          erro: mensagemDe(e, 160),
        });
      }
    }
    try {
      l.falasGerais = await this.banco.falasGerais(l.org);
    } catch (e) {
      this.log.warn("telefonia: falas gerais não lidas — segue a fila sem elas", { voice_call: l.vcId, erro: mensagemDe(e, 160) });
    }
    if (l.fim) return;
    l.avisoPendente = fila.aviso;

    // Fora do horário SÓ com a fala pronta e tocando. Sem ela (ou se ela não
    // toca), a fase 1: fila e "Ligar de volta" — desligar calado seria um beco
    // sem saída para quem ligou (plano, "Decisões de implementação").
    if (fila.situacao === "fora_do_horario" && l.falasGerais.foraDoHorario) {
      if (await this.tocarNaFila(l, l.falasGerais.foraDoHorario, "fora_do_horario")) {
        l.encerrando = MOTIVO_FORA_DO_HORARIO;
        return;
      }
    }
    return this.tocarAviso(l);
  }

  /** O aviso de instabilidade, se houver e se tocar; depois (ou sem ele), os ramais. */
  private async tocarAviso(l: Recebida): Promise<void> {
    if (l.fim) return;
    const aviso = l.avisoPendente;
    l.avisoPendente = null;
    if (aviso && (await this.tocarNaFila(l, aviso, "aviso"))) return;
    return this.comecarOsToques(l);
  }

  /** Os ramais. A régua dos 45 s ("atende e segura") conta daqui, depois do aviso. */
  private async comecarOsToques(l: Recebida): Promise<void> {
    if (l.fim) return;
    l.inicio = this.agora();
    return this.tocarProximo(l);
  }

  private async disponiveisComRamal(l: Recebida): Promise<CandidatoAoToque[]> {
    if (!l.teamId) return [];
    const todos = await this.banco.disponiveisNoTime(l.org, l.teamId, new Date(this.agora()));
    const online = await Promise.all(todos.map((c) => this.ari.ramalOnline(c.userId).catch(() => false)));
    return todos.filter((_, i) => online[i]);
  }

  private async garantirAtendida(l: Recebida) {
    if (l.atendidaPelaRede) return;
    l.atendidaPelaRede = true;
    await this.ari.atender(l.cliente);
  }

  /** O cliente vai esperar: "aguarde" (se tocar) e a música no fim dele; sem "aguarde", música direto. */
  private async segurarNaLinha(l: Recebida) {
    if (l.segurando || l.fim) return;
    l.segurando = true;
    if (l.falasGerais.aguarde && (await this.tocarNaFila(l, l.falasGerais.aguarde, "espera"))) return;
    if (l.fim || l.atendidaPor) return;
    await this.garantirAtendida(l);
    await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
  }

  private async tocarProximo(l: Recebida): Promise<void> {
    if (l.fim || l.atendidaPor || l.encerrando) return;
    const disponiveis = await this.disponiveisComRamal(l);
    const p = proximoToque(disponiveis, l.estado);

    if (p.tipo === "desistir") return this.encerrarComFala(l, "ninguem_atendeu");

    if (p.tipo === "esperar") {
      if (!l.naFila) {
        l.naFila = true;
        l.inicioFila = this.agora();
        await this.segurarNaLinha(l);
        await this.banco.marcarTocando(l.vcId, null);
      }
      if (this.agora() - (l.inicioFila ?? this.agora()) >= ESPERA_NA_FILA_MS) {
        return this.encerrarComFala(l, "fila_esgotada");
      }
      this.armar(l, REAVALIAR_FILA_MS, () => this.tocarProximo(l));
      return;
    }

    l.estado = p.estado;
    // Tocou demais sem ninguém pegar (ou começou a segunda volta): atende e
    // segura — a rede costuma derrubar ligação que só chama. E a ligação que já
    // foi atendida (pelo aviso, pela URA) não espera o ramal em silêncio.
    if (l.atendidaPelaRede || p.estado.volta > 1 || this.agora() - l.inicio >= ATENDER_E_SEGURAR_APOS_MS) {
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
        erro: mensagemDe(e, 160),
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
    l.relogio = null;
    if (l.fim) return;
    l.relogio = setTimeout(() => {
      l.relogio = null;
      if (!l.fim)
        void this.emFila(async () => {
          if (!l.fim) await fn();
        }).catch((e) => this.log.error("telefonia: relógio falhou", { erro: String(e) }));
    }, ms);
  }

  private pararRelogios(l: Recebida) {
    if (l.relogio) clearTimeout(l.relogio);
    l.relogio = null;
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    l.relogioDaEspera = null;
  }

  // ─── falas da fila ───────────────────────────────────────────────────────

  /**
   * Toca uma fala da fila no canal do cliente. `true` = no ar (o que vem depois
   * é decidido no `PlaybackFinished`). `false` = a fala foi PULADA — sem arquivo
   * no disco ou recusada pelo Asterisk —, a Central fica sabendo, e quem chamou
   * segue como se ela não existisse. Atende a ligação só depois de o arquivo
   * estar garantido: sem fala, a fila da fase 1 (que ainda deixa chamar) segue.
   */
  private async tocarNaFila(
    l: Recebida,
    fala: FalaDoBanco,
    papel: PapelDaFala,
    opcoes: {
      /** O nome da fala na Central; o padrão é o do papel ("aguarde"…). */
      rotulo?: string;
      /** Com o arquivo garantido, logo antes de tocar: parar o que está no ar. */
      antesDeTocar?: () => Promise<void>;
    } = {},
  ): Promise<boolean> {
    const rotulo = opcoes.rotulo ?? ROTULO_DA_FALA[papel];
    const midia = await this.falas.garantir(fala).catch(() => null);
    // O disco pode levar até 3 s: a ligação pode ter acabado, ou (o "aguarde") ter sido atendida.
    if (l.fim || (papel === "espera" && (l.atendidaPor || l.encerrando))) return false;
    if (!midia) {
      this.log.warn("telefonia: fala sem arquivo no disco — pulada", { voice_call: l.vcId, fala: fala.id, papel });
      await this.avisarIntocavel(l, rotulo);
      return false;
    }
    if (opcoes.antesDeTocar) await opcoes.antesDeTocar();
    await this.garantirAtendida(l);
    let playbackId: string;
    try {
      playbackId = await this.ari.tocarFala(l.cliente, midia);
    } catch (e) {
      // Canal que sumiu (404) ou saiu do Stasis (409) é o cliente desligando: o
      // fim vem logo atrás, e a fala não tem culpa.
      const canalSumiu = e instanceof ErroAri && (e.status === 404 || e.status === 409);
      this.log.warn("telefonia: o Asterisk não tocou a fala — pulada", {
        voice_call: l.vcId,
        papel,
        erro: mensagemDe(e, 160),
      });
      if (!canalSumiu) await this.avisarIntocavel(l, rotulo);
      return false;
    }
    if (l.fim) return false;
    l.fala = { playbackId, papel, rotulo };
    this.porReproducao.set(playbackId, l);
    return true;
  }

  private async avisarIntocavel(l: Recebida, rotulo: string) {
    await this.banco
      .avisarFalaIntocavel(l.org, rotulo)
      .catch((e) => this.log.warn("telefonia: aviso de fala que não tocou não gravado", { erro: mensagemDe(e, 160) }));
  }

  /** Para a fala no ar. O `PlaybackFinished` dela, que chega depois, é ignorado (já saiu do mapa). */
  private async pararFalaAtual(l: Recebida) {
    if (!l.fala) return;
    const id = l.fala.playbackId;
    l.fala = null;
    this.porReproducao.delete(id);
    await this.ari.pararFala(id).catch((e) => this.log.warn("telefonia: fala não parada", { erro: mensagemDe(e, 160) }));
  }

  private async aoTerminarFala(ev: Extract<EventoAri, { type: "PlaybackFinished" }>) {
    const id = ev.playback?.id;
    const l = id ? this.porReproducao.get(id) : undefined;
    // Fala que paramos, ou de ligação que já acabou: nada a fazer.
    if (!l || !id) return;
    this.porReproducao.delete(id);
    if (l.fim || l.fala?.playbackId !== id) return;
    const fala = l.fala;
    l.fala = null;
    // Cortada porque o cliente desligou: quem encerra é o StasisEnd que vem atrás.
    if (l.clienteSaindo) return;
    const tocou = ev.playback.state !== "failed";
    if (!tocou) {
      this.log.warn("telefonia: o Asterisk não tocou a fala — pulada", { voice_call: l.vcId, papel: fala.papel });
      await this.avisarIntocavel(l, fala.rotulo);
    }
    return this.aposFala(l, fala.papel, tocou);
  }

  /** O que vem depois de cada fala — ou de uma que não tocou (e então é como se não existisse). */
  private async aposFala(l: Recebida, papel: PapelDaFala, tocou: boolean): Promise<void> {
    if (l.fim) return;
    switch (papel) {
      case "fora_do_horario":
        // Ouviu o porquê: acaba aqui, sem "Ligar de volta" (§5.2.1).
        if (tocou) return this.encerrarRecebida(l, MOTIVO_FORA_DO_HORARIO);
        // Não ouviu: é o caso "sem fala" — a fila da fase 1, e perdida com aviso.
        l.encerrando = null;
        return this.tocarAviso(l);
      case "aviso":
        if (tocou) await this.registrarOuviuOAviso(l);
        return this.comecarOsToques(l);
      case "espera":
        if (l.atendidaPor || l.encerrando) return;
        await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
        // Só repete o que tocou: o que falhou uma vez falharia a cada 40 s.
        if (tocou) this.armarEspera(l);
        return;
      case "ninguem":
        return this.encerrarRecebida(l, l.encerrando ?? "ninguem_atendeu");
      default: {
        const _nunca: never = papel;
        return _nunca;
      }
    }
  }

  private async registrarOuviuOAviso(l: Recebida) {
    try {
      if (!(await this.banco.registrarAvisoOuvido(l.org, l.vcId))) {
        this.log.warn("telefonia: 'ouviu o aviso' não achou a ligação", { voice_call: l.vcId });
      }
    } catch (e) {
      this.log.warn("telefonia: 'ouviu o aviso' não gravado", { voice_call: l.vcId, erro: mensagemDe(e, 160) });
    }
  }

  /** Daqui a ~40 s: para a música, toca o "aguarde" de novo, e a música volta no fim dele. */
  private armarEspera(l: Recebida) {
    if (l.relogioDaEspera) clearTimeout(l.relogioDaEspera);
    l.relogioDaEspera = null;
    if (l.fim) return;
    l.relogioDaEspera = setTimeout(() => {
      l.relogioDaEspera = null;
      if (l.fim) return;
      void this.emFila(async () => {
        const aguarde = l.falasGerais.aguarde;
        if (!aguarde || l.fim || l.atendidaPor || l.encerrando || l.fala) return;
        let parouAMusica = false;
        const tocando = await this.tocarNaFila(l, aguarde, "espera", {
          antesDeTocar: async () => {
            parouAMusica = true;
            await this.ari.pararMusica(l.cliente).catch(() => undefined);
          },
        });
        // Pulado: sem arquivo, a música nem parou e segue; recusado pelo Asterisk, ela volta.
        if (!tocando && parouAMusica && !l.fim && !l.atendidaPor && !l.encerrando) {
          await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
        }
      }).catch((e) => this.log.error("telefonia: relógio do 'aguarde' falhou", { erro: String(e) }));
    }, REPETIR_AGUARDE_MS);
  }

  /** Esgotou: "ninguém atendeu" (se tocar) e só então desliga. */
  private async encerrarComFala(l: Recebida, motivo: string): Promise<void> {
    if (l.fim || l.encerrando) return;
    l.encerrando = motivo;
    this.pararRelogios(l);
    const ninguem = l.falasGerais.ninguem;
    if (
      ninguem &&
      (await this.tocarNaFila(l, ninguem, "ninguem", {
        antesDeTocar: async () => {
          await this.pararFalaAtual(l);
          if (l.atendidaPelaRede) await this.ari.pararMusica(l.cliente).catch(() => undefined);
        },
      }))
    ) {
      return;
    }
    return this.encerrarRecebida(l, motivo);
  }

  // ─── atendimento e fim da recebida ───────────────────────────────────────

  private async ramalAtendeu(canal: CanalAri, vcId: string) {
    const l = this.porId.get(vcId);
    if (!l || l.tipo !== "recebida" || l.fim || l.encerrando || l.ramal?.canal !== canal.id || l.atendidaPor) {
      // Atendeu tarde (a ligação já foi para outro, acabou ou está se despedindo): larga o ramal.
      await this.ari.desligar(canal.id);
      return;
    }
    this.pararRelogios(l);
    l.atendidaPor = l.ramal.userId;

    // Atendeu no meio do "aguarde": a fala para, e a ponte se forma.
    await this.pararFalaAtual(l);
    if (l.atendidaPelaRede) {
      await this.ari
        .pararMusica(l.cliente)
        .catch((e) => this.log.warn("telefonia: música não parada — a ponte segue", { erro: mensagemDe(e, 160) }));
    } else {
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
    this.pararRelogios(l);
    if (l.fala) this.porReproducao.delete(l.fala.playbackId);
    l.fala = null;
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
      await this.banco.encerrarLigacao(vc.id, RECUSA_DA_SAIDA.troncoIndisponivel);
      return recusar("tronco indisponível", { voice_call: vc.id });
    }
    // O prefixo de discagem é DO TRONCO (vem do banco, nunca do que o atendente
    // digitou) e entra na frente do número que a política acabou de julgar.
    const destino = enderecoDeSaida(tronco, numero.discar);
    if (!destino.ok) {
      await this.banco.encerrarLigacao(vc.id, RECUSA_DA_SAIDA.troncoConfiguracaoInvalida);
      return recusar("tronco com configuração inválida", { voice_call: vc.id, problema: destino.problema });
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
      tocou: false,
      causaDaRede: null,
      fim: false,
    };
    this.registrar(l, canal.id);

    await this.ari.atender(canal.id);
    await this.ari.criarPonte(l.ponte);
    await this.ari.porNaPonte(l.ponte, canal.id);
    const perna = await this.ari.criarCanal({
      endpoint: destino.endpoint,
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
    if (s === "RINGING" || s === "PROGRESS") l.tocou = true;
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
    // O tom ANTES dos canais: desligar o ramal com o chamar ainda tocando faz o
    // Asterisk registrar "Playback failed for tone:ring;tonezone=br" — medido
    // num Asterisk 20.11.1 local, só nesse caso; parado pela ARI, o mesmo tom
    // termina "done". Era o aviso do log de produção na saída recusada em 0,2 s,
    // em que nem PROGRESS nem ANSWER chegaram para pará-lo.
    await this.pararTom(l);
    for (const c of [l.ramal, l.perna]) {
      if (!c) continue;
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    let desfecho: DesfechoDaLigacao = l.atendida ? "atendida" : "sem_resposta";
    let motivoFinal = motivo;
    // A perna da operadora acabou antes de alguém atender (e não foi o atendente
    // que desistiu): o motivo diz o que a rede fez, e a tela do atendente o lê.
    if (!l.atendida && l.causaDaRede !== null) {
      ({ desfecho, motivo: motivoFinal } = fimDaSaidaNaoAtendida({ causa: l.causaDaRede, tocou: l.tocou }));
    }
    await this.finalizar(l.vcId, desfecho, motivoFinal);
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
      // Enquanto a última fala toca ("fora do horário", "ninguém atendeu"), o motivo já está decidido.
      if (ev.channel.id === l.cliente) return this.encerrarRecebida(l, l.encerrando ?? "cliente_desligou");
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
        // `causa`, não `ev.cause`: o fim da perna chega primeiro pelo StasisEnd,
        // que não traz causa — era o `rede_undefined` do log de produção.
        l.causaDaRede = causa;
        return this.encerrarFeita(l, "cliente_desligou");
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
    // Fora do horário NÃO vira "Ligar de volta" (§5.2.1): o cliente ouviu o porquê.
    if (desfecho === "perdida" && l.direction === "inbound" && motivo !== MOTIVO_FORA_DO_HORARIO) {
      await this.banco.avisarPerdida(l);
    }
    await this.banco.registrarFim(l, desfecho, motivo);
    this.log.info("telefonia: ligação encerrada", { voice_call: vcId, desfecho, motivo });
  }

  // ─── reinício do worker ──────────────────────────────────────────────────

  /**
   * Depois de (re)conectar à ARI: o que o banco diz estar vivo é conferido com
   * o que o Asterisk tem. Ponte viva `p-<id>` = ligação em curso: volta a ser
   * vigiada. Qualquer outra ligação "viva" no banco e sem ponte morreu com o
   * worker anterior — encerrada, e a recebida vira perdida (alguém liga de volta).
   * Uma fala no ar (ou uma URA) também morre aqui: risco aceito (desenho §11).
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
