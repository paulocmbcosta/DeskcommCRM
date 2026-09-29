/**
 * O CÉREBRO DA TELEFONIA — a aplicação Stasis `crm` (spec 20 §4.2; fase 2 em
 * docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md).
 *
 * O Asterisk entrega aqui toda ligação (o dialplan só diz `Stasis(crm)`),
 * e este controlador decide tudo o que não é áudio:
 *
 *   RECEBIDA  tronco → contato/conversa/voice_calls → URA, se o número aponta
 *             para um menu (§5.1): atende e toca o menu; a tecla do cliente
 *             escolhe o time, e o silêncio ou a tecla errada repetem o menu até
 *             levar ao time padrão. Quem decide é a regra pura
 *             (`lib/telefonia/ura.ts`); aqui só se executa o que ela manda.
 *             Decidido o time (ou direto, no número que aponta para um time) →
 *             FILA DO TIME (§5.2):
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
import {
  ESTADO_INICIAL_DA_URA,
  passoDaUra,
  type AcaoDaUra,
  type EstadoDaUra,
  type EventoDaUra,
  type FalaDaUra,
  type MenuDaUra,
} from "@/lib/telefonia/ura";
import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";

import type { CanalAri } from "./ari";
import { FalasNoAr, semFalaNoAr, type FalaDaLigacao, type PortaFalas } from "./fala-no-ar";
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
  /** A escolha na ligação — e a conversa SEM DONO acompanha o time escolhido (visibilidade por time, 0281). */
  registrarEscolhaDoMenu(org: string, id: string, e: EscolhaDoMenu): Promise<boolean>;
  /** O cliente caiu no time padrão do menu, e ele está ARQUIVADO: `phone_menu_team_archived` na Central. */
  avisarMenuComTimeArquivado(org: string, menu: Pick<MenuDoBanco, "id" | "nome">): Promise<void>;
  /** O cliente ouviu o aviso de instabilidade INTEIRO (`emergency_heard_at`). */
  registrarAvisoOuvido(org: string, id: string): Promise<boolean>;
  /** A fala não tocou e a ligação seguiu sem ela: `phone_prompt_unplayable` na Central. */
  avisarFalaIntocavel(org: string, rotulo: string): Promise<void>;
  acharOuCriarContato(org: string, e164: string, nome: string | null): Promise<string>;
  acharOuCriarConversa(org: string, contactId: string, troncoId: string, teamId: string | null): Promise<string>;
  criarLigacao(l: NovaLigacao): Promise<string>;
  /** O pedido de saída que o ramal disca — só se for DESTE atendente (a organização sai da linha). */
  ligacaoDoAtendente(userId: string, id: string): Promise<LigacaoDoBanco | null>;
  ligacoesVivas(): Promise<LigacaoDoBanco[]>;
  // As escritas da ligação ficam presas à organização dela (`l.org`).
  marcarTocando(org: string, id: string, userId: string | null): Promise<void>;
  marcarAtendida(org: string, id: string, userId: string): Promise<void>;
  encerrarLigacao(org: string, id: string, motivo: string): Promise<LigacaoDoBanco | null>;
  atribuirConversa(org: string, conversationId: string, userId: string): Promise<void>;
  registrarNaConversa(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, duracaoMs: number | null): Promise<void>;
  avisarPerdida(l: LigacaoDoBanco): Promise<void>;
  registrarFim(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, motivo: string): Promise<void>;
}

/** O disco das falas e a folga do relógio da fala moram na mecânica da fala no ar (`fala-no-ar.ts`). */
export type { PortaFalas } from "./fala-no-ar";
export { FOLGA_DO_FIM_DA_FALA_MS } from "./fala-no-ar";

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
 * O que chega no WebSocket. `PlaybackFinished` fecha as falas (URA e fila).
 * `ChannelDtmfReceived` é lido SÓ enquanto a URA está ativa (§5.1): na fila, de
 * propósito, tecla nenhuma muda nada — o aviso de instabilidade toca INTEIRO.
 * `ChannelUserevent` é da transferência (versão 2).
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

/**
 * Para que serve a fala no ar — é o que decide o que vem depois dela. As da URA
 * (`menu`, `invalida`) têm os mesmos nomes das falas da regra (`FalaDaUra`).
 */
type PapelDaFala = "fora_do_horario" | "aviso" | "espera" | "ninguem" | FalaDaUra;

/** Como a Central chama cada fala quando ela não toca (`phone_prompt_unplayable`). */
const ROTULO_DA_FALA = {
  fora_do_horario: "fora do horário",
  aviso: "aviso de instabilidade",
  espera: "aguarde",
  ninguem: "ninguém atendeu",
  // A URA sempre manda o rótulo com o nome do menu ("menu Principal").
  menu: "menu",
  invalida: "tecla inválida do menu",
} as const satisfies Record<PapelDaFala, string>;

type Relogio = ReturnType<typeof setTimeout>;
/**
 * Os relógios de UM grupo do estado da ligação, pelo nome. O grupo é parado
 * inteiro (`pararTodos`): o relógio novo que entrar aqui já cai junto no fim da
 * ligação, sem ninguém precisar lembrar de acrescentá-lo a `pararRelogios`.
 */
type Relogios<K extends string> = Record<K, Relogio | null>;

function pararRelogio<K extends string>(r: Relogios<K>, nome: K): void {
  const t = r[nome];
  if (t) clearTimeout(t);
  r[nome] = null;
}

function pararTodos<K extends string>(r: Relogios<K>): void {
  for (const nome of Object.keys(r) as K[]) pararRelogio(r, nome);
}

/** A URA de uma ligação, enquanto o cliente escolhe: a regra pura decide, o controlador executa. */
interface UraEmCurso {
  menu: MenuDoBanco;
  regra: MenuDaUra;
  estado: EstadoDaUra;
  /** `prazo`: os 5 s depois do menu. A `vez` da espera fica presa no timer, não aqui (`armarPrazoDaUra`). */
  relogios: Relogios<"prazo">;
}

/** A fila do time (§5.2): o que ela lê na entrada e o que faz enquanto o cliente espera. */
interface FilaDaLigacao {
  /** O time da fila: o do número (com a URA, o escolhido no menu). */
  teamId: string | null;
  /** Lidas na entrada da fila; todas `null` = a fila da fase 1. */
  falasGerais: FalasGerais;
  /** O aviso de instabilidade que ainda vai tocar (lido na entrada da fila). */
  avisoPendente: FalaDoBanco | null;
  /**
   * Quando os TOQUES começaram (depois do aviso de instabilidade, §5.1.3) — a
   * régua do "tocou demais sem atender: atende e segura".
   */
  inicioDosToques: number;
  toque: EstadoDoToque;
  /** O ramal que está tocando agora. */
  ramal: { canal: string; userId: string } | null;
  /** Segurando na linha ("aguarde" e música): o cliente já está esperando. */
  segurando: boolean;
  /** Sem ninguém disponível, esperando a vez. */
  esperando: boolean;
  /** Início dos 2 min de espera sem ninguém disponível (fase 1). */
  inicioDaEspera: number | null;
  /**
   * `reavaliar`: reavaliar a fila, ou a rede de segurança do toque do ramal;
   * `aguarde`: a repetição do "aguarde" (~40 s de música entre um e outro).
   */
  relogios: Relogios<"reavaliar" | "aguarde">;
}

/**
 * Uma ligação recebida. O estado de cada fase mora num GRUPO — a fila, a fala
 * no ar, a URA —, e cada grupo é limpo inteiro no fim (`pararRelogios`). Em cima
 * fica só o que é da ligação toda: quem é, se foi atendida e se está acabando.
 */
interface Recebida {
  tipo: "recebida";
  vcId: string;
  org: string;
  tronco: TroncoDoBanco;
  cliente: string;
  numeroExibido: string;
  conversationId: string | null;
  atendidaPelaRede: boolean;
  atendidaPor: string | null;
  ponte: string | null;
  fila: FilaDaLigacao;
  /**
   * A fala no ar — uma por vez — e o relógio dela, próprio porque o relógio da
   * fila corre em paralelo durante o "aguarde". Quem escreve é `FalasNoAr`.
   */
  fala: FalaDaLigacao<PapelDaFala>;
  /** A URA, enquanto o cliente escolhe no menu; `null` antes (número de time) e depois da escolha. */
  ura: UraEmCurso | null;
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
  org: string;
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
    falas: PortaFalas = SEM_DISCO,
  ) {
    this.falaNoAr = new FalasNoAr<Recebida, PapelDaFala>({
      ari: this.ari,
      falas,
      log: this.log,
      emFila: (fn) => this.emFila(fn),
      rotuloDoPapel: (papel) => ROTULO_DA_FALA[papel],
      ganchos: {
        atender: (l) => this.garantirAtendida(l),
        avisarIntocavel: (l, rotulo) => this.avisarIntocavel(l, rotulo),
        canalSumiu: (l) => this.encerrarRecebida(l, l.encerrando ?? "cliente_desligou"),
        aposFala: (l, papel, tocou) => this.aposFala(l, papel, tocou),
      },
    });
  }

  /** A mecânica da fala no ar (pôr, parar, fim e relógio), comum à URA e à fila. */
  private readonly falaNoAr: FalasNoAr<Recebida, PapelDaFala>;

  /** Quantas ligações o controlador está acompanhando (para /healthz e testes). */
  get ativas(): number {
    return this.porId.size;
  }

  /** Quantas falas estão no ar, à espera do `PlaybackFinished` (para testes: o mapa esvazia). */
  get falasNoAr(): number {
    return this.falaNoAr.noAr;
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
          return await this.falaNoAr.aoTerminar(ev as Extract<EventoAri, { type: "PlaybackFinished" }>);
        case "ChannelDtmfReceived":
          return await this.aoReceberTecla(ev as Extract<EventoAri, { type: "ChannelDtmfReceived" }>);
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

    // O número aponta para um time OU para um menu (0288). Com menu, a ligação
    // nasce no time PADRÃO dele: é o time dela enquanto o cliente escolhe, e o
    // dono do "Ligar de volta" de quem desliga no menu (§5.1).
    const menu = await this.menuDoNumero(tronco);
    const teamId = menu ? menu.defaultTeamId : tronco.teamId;
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
      menuId: menu?.id ?? null,
    });

    const l: Recebida = {
      tipo: "recebida",
      vcId,
      org: tronco.organizationId,
      tronco,
      cliente: canal.id,
      numeroExibido: e164 ?? canal.caller.number ?? "",
      conversationId,
      atendidaPelaRede: false,
      atendidaPor: null,
      ponte: null,
      fila: {
        teamId,
        falasGerais: SEM_FALAS_GERAIS,
        avisoPendente: null,
        inicioDosToques: this.agora(),
        toque: ESTADO_INICIAL,
        ramal: null,
        segurando: false,
        esperando: false,
        inicioDaEspera: null,
        relogios: { reavaliar: null, aguarde: null },
      },
      fala: semFalaNoAr(),
      ura: null,
      encerrando: null,
      clienteSaindo: false,
      fim: false,
    };
    this.registrar(l, canal.id);
    this.log.info("telefonia: ligação recebida", { voice_call: vcId, tronco: tronco.id, time: teamId, menu: menu?.id ?? null });
    if (menu) return this.iniciarUra(l, menu);
    await this.entrarNaFila(l);
  }

  /**
   * O menu do número, se ele aponta para um. Menu que não volta (arquivado ou
   * apagado — a tela recusa arquivar menu em uso, então é raro) ou leitura que
   * falha: a ligação segue SEM menu, com o time do número — nenhum, num número
   * de menu —, a fila da fase 1 e, no fim, "Ligar de volta".
   */
  private async menuDoNumero(tronco: TroncoDoBanco): Promise<MenuDoBanco | null> {
    if (!tronco.menuId) return null;
    try {
      const menu = await this.banco.menuPorId(tronco.organizationId, tronco.menuId);
      if (!menu) {
        this.log.warn("telefonia: o número aponta para um menu que não existe mais — segue sem menu", {
          tronco: tronco.id,
          menu: tronco.menuId,
        });
      }
      return menu;
    } catch (e) {
      this.log.warn("telefonia: menu do número não lido — segue sem menu", { tronco: tronco.id, erro: mensagemDe(e, 160) });
      return null;
    }
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
    let entrada: TimeParaAFila = { situacao: "aberto", aviso: null };
    if (l.fila.teamId) {
      try {
        entrada = await this.banco.timeParaAFila(l.org, l.fila.teamId, new Date(this.agora()));
      } catch (e) {
        this.log.warn("telefonia: situação do time não lida — segue a fila sem as falas do time", {
          voice_call: l.vcId,
          erro: mensagemDe(e, 160),
        });
      }
    }
    try {
      l.fila.falasGerais = await this.banco.falasGerais(l.org);
    } catch (e) {
      this.log.warn("telefonia: falas gerais não lidas — segue a fila sem elas", { voice_call: l.vcId, erro: mensagemDe(e, 160) });
    }
    if (l.fim) return;
    l.fila.avisoPendente = entrada.aviso;

    // Fora do horário SÓ com a fala pronta e tocando. Sem ela (ou se ela não
    // toca), a fase 1: fila e "Ligar de volta" — desligar calado seria um beco
    // sem saída para quem ligou (plano, "Decisões de implementação").
    if (entrada.situacao === "fora_do_horario" && l.fila.falasGerais.foraDoHorario) {
      if ((await this.falaNoAr.porNoAr(l, l.fila.falasGerais.foraDoHorario, "fora_do_horario")) === "no_ar") {
        l.encerrando = MOTIVO_FORA_DO_HORARIO;
        return;
      }
    }
    return this.tocarAviso(l);
  }

  /** O aviso de instabilidade, se houver e se tocar; depois (ou sem ele), os ramais. */
  private async tocarAviso(l: Recebida): Promise<void> {
    if (l.fim) return;
    const aviso = l.fila.avisoPendente;
    l.fila.avisoPendente = null;
    if (aviso && (await this.falaNoAr.porNoAr(l, aviso, "aviso")) === "no_ar") return;
    return this.comecarOsToques(l);
  }

  /** Os ramais. A régua dos 45 s ("atende e segura") conta daqui, depois do aviso. */
  private async comecarOsToques(l: Recebida): Promise<void> {
    if (l.fim) return;
    l.fila.inicioDosToques = this.agora();
    return this.tocarProximo(l);
  }

  private async disponiveisComRamal(l: Recebida): Promise<CandidatoAoToque[]> {
    if (!l.fila.teamId) return [];
    const todos = await this.banco.disponiveisNoTime(l.org, l.fila.teamId, new Date(this.agora()));
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
    if (l.fila.segurando || l.fim) return;
    l.fila.segurando = true;
    const aguarde = l.fila.falasGerais.aguarde;
    if (aguarde && (await this.falaNoAr.porNoAr(l, aguarde, "espera", { valeTocar: () => this.aindaEspera(l) })) === "no_ar") {
      return;
    }
    if (l.fim || l.atendidaPor) return;
    await this.garantirAtendida(l);
    await this.ari.musicaDeEspera(l.cliente).catch(() => undefined);
  }

  private async tocarProximo(l: Recebida): Promise<void> {
    if (l.fim || l.atendidaPor || l.encerrando) return;
    let disponiveis: CandidatoAoToque[];
    try {
      disponiveis = await this.disponiveisComRamal(l);
    } catch (e) {
      // Sem a lista, ninguém toca AGORA: a fila espera e pergunta de novo em 5 s
      // (e esgota em 2 min, como sempre). Lançar daqui deixava a ligação parada
      // sem relógio nenhum — logo depois do aviso, o cliente em silêncio.
      this.log.warn("telefonia: disponíveis do time não lidos — a fila espera e pergunta de novo", {
        voice_call: l.vcId,
        erro: mensagemDe(e, 160),
      });
      disponiveis = [];
    }
    const p = proximoToque(disponiveis, l.fila.toque);

    if (p.tipo === "desistir") return this.encerrarComFala(l, "ninguem_atendeu");

    if (p.tipo === "esperar") {
      if (!l.fila.esperando) {
        l.fila.esperando = true;
        l.fila.inicioDaEspera = this.agora();
        await this.segurarNaLinha(l);
        if (l.fim) return;
        await this.marcarTocando(l, null);
      }
      if (this.agora() - (l.fila.inicioDaEspera ?? this.agora()) >= ESPERA_NA_FILA_MS) {
        return this.encerrarComFala(l, "fila_esgotada");
      }
      this.armar(l, REAVALIAR_FILA_MS, () => this.tocarProximo(l));
      return;
    }

    l.fila.toque = p.estado;
    // Tocou demais sem ninguém pegar (ou começou a segunda volta): atende e
    // segura — a rede costuma derrubar ligação que só chama. E a ligação que já
    // foi atendida (pelo aviso, pela URA) não espera o ramal em silêncio.
    if (l.atendidaPelaRede || p.estado.volta > 1 || this.agora() - l.fila.inicioDosToques >= ATENDER_E_SEGURAR_APOS_MS) {
      await this.segurarNaLinha(l);
      // O "aguarde" pode ter encontrado o canal do cliente já fechado: não toca ramal para ninguém.
      if (l.fim) return;
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
    l.fila.ramal = { canal: canalDoRamal.id, userId: p.userId };
    this.porCanal.set(canalDoRamal.id, l);
    await this.marcarTocando(l, p.userId);
    // Rede de segurança: se o Asterisk não derrubar o toque no prazo, derrubamos.
    const canalEsperado = canalDoRamal.id;
    this.armar(l, TOQUE_POR_ATENDENTE_MS + 3_000, async () => {
      if (l.fila.ramal?.canal === canalEsperado && !l.atendidaPor) await this.ari.desligar(canalEsperado, "no_answer");
    });
  }

  /** O estado na tela ("tocando para Fulano"). Não gravar não pode parar a fila: o relógio vem depois. */
  private async marcarTocando(l: Recebida, userId: string | null) {
    await this.banco
      .marcarTocando(l.org, l.vcId, userId)
      .catch((e) => this.log.warn("telefonia: 'tocando' não gravado", { voice_call: l.vcId, erro: mensagemDe(e, 160) }));
  }

  private armar(l: Recebida, ms: number, fn: () => Promise<unknown>) {
    pararRelogio(l.fila.relogios, "reavaliar");
    if (l.fim) return;
    l.fila.relogios.reavaliar = setTimeout(() => {
      l.fila.relogios.reavaliar = null;
      if (!l.fim)
        void this.emFila(async () => {
          if (!l.fim) await fn();
        }).catch((e) => this.log.error("telefonia: relógio falhou", { erro: String(e) }));
    }, ms);
  }

  /** Todos os relógios da ligação, grupo a grupo e cada grupo inteiro: a fila, a fala no ar e a URA. */
  private pararRelogios(l: Recebida) {
    pararTodos(l.fila.relogios);
    this.falaNoAr.pararRelogio(l);
    if (l.ura) pararTodos(l.ura.relogios);
  }

  // ─── depois da fala (a mecânica está em `fala-no-ar.ts`) ─────────────────
  //
  // A fala no ar — pôr, parar, o fim pelo `PlaybackFinished` ou pelo relógio —
  // é de `FalasNoAr`. Aqui ficam os ganchos dela: avisar a Central da fala que
  // não tocou, e decidir, pelo PAPEL da fala, o que vem depois.

  private async avisarIntocavel(l: Recebida, rotulo: string) {
    await this.banco
      .avisarFalaIntocavel(l.org, rotulo)
      .catch((e) => this.log.warn("telefonia: aviso de fala que não tocou não gravado", { erro: mensagemDe(e, 160) }));
  }

  /** O que vem depois de cada fala — ou de uma que não tocou (e então é como se não existisse). */
  private async aposFala(l: Recebida, papel: PapelDaFala, tocou: boolean): Promise<void> {
    if (l.fim) return;
    switch (papel) {
      case "menu":
      case "invalida": {
        // A URA: a regra decide o que vem depois do fim — ou da fala que não tocou.
        const ura = l.ura;
        if (!ura) return;
        return this.executarUra(l, ura, tocou ? { tipo: "fim_da_fala" } : { tipo: "fala_falhou" });
      }
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

  // ─── URA (desenho §5.1) ──────────────────────────────────────────────────
  //
  // A regra é a pura de `lib/telefonia/ura.ts` — estado + evento → UMA ação —, e
  // aqui só se executa a ação. Os eventos que chegam à regra: a tecla do cliente
  // (só enquanto a URA está ativa), o fim da fala, a fala que não tocou e o prazo
  // dos 5 s depois do menu. Decidido o time, a URA acaba (`l.ura = null`) e a
  // ligação entra na fila dele: a partir dali tecla nenhuma muda nada.

  /**
   * A tecla do CLIENTE, e só enquanto a URA está ativa. No aviso de
   * instabilidade, no "aguarde" e na fila, a tecla é ignorada: o aviso toca
   * INTEIRO (§5.2.2). A tecla do canal do ramal também não conta.
   */
  private async aoReceberTecla(ev: Extract<EventoAri, { type: "ChannelDtmfReceived" }>) {
    const canal = ev.channel?.id;
    const l = canal ? this.porCanal.get(canal) : undefined;
    if (!l || l.tipo !== "recebida" || l.fim || l.clienteSaindo || !l.ura || canal !== l.cliente) return;
    if (typeof ev.digit !== "string" || ev.digit.length !== 1) return;
    return this.executarUra(l, l.ura, { tipo: "tecla", digito: ev.digit });
  }

  /** O número aponta para um menu: a URA começa, e o menu toca (atendendo a ligação). */
  private async iniciarUra(l: Recebida, menu: MenuDoBanco): Promise<void> {
    const ura: UraEmCurso = {
      menu,
      regra: { opcoes: menu.opcoes, defaultTeamId: menu.defaultTeamId, temFalaInvalida: menu.falaInvalida !== null },
      estado: ESTADO_INICIAL_DA_URA,
      relogios: { prazo: null },
    };
    l.ura = ura;
    return this.tocarNaUra(l, ura, "menu");
  }

  /**
   * Põe no ar a fala que a regra pediu. A que não toca (sem fala pronta, sem
   * arquivo, recusada pelo Asterisk) volta à regra como `fala_falhou` — é ela
   * quem decide o que isso significa (o menu vai ao time padrão; a de tecla
   * inválida cede ao menu).
   */
  private async tocarNaUra(l: Recebida, ura: UraEmCurso, qual: FalaDaUra): Promise<void> {
    const fala = qual === "menu" ? ura.menu.fala : ura.menu.falaInvalida;
    const rotulo = qual === "menu" ? `menu ${ura.menu.nome}` : `tecla inválida do menu ${ura.menu.nome}`;
    if (!fala) {
      // O menu sem fala pronta (desenho §4): avisado, e direto para o time padrão.
      await this.avisarIntocavel(l, rotulo);
      return this.executarUra(l, ura, { tipo: "fala_falhou" });
    }
    const pedida = await this.falaNoAr.porNoAr(l, fala, qual, { rotulo, valeTocar: () => l.ura === ura });
    // `sem_canal` é o cliente desligando: a ligação já acabou (perdida, sem
    // desfecho de menu), e a URA não decide nada por ele.
    if (pedida !== "pulada") return;
    return this.executarUra(l, ura, { tipo: "fala_falhou" });
  }

  /** Um passo da regra, executado. */
  private async executarUra(l: Recebida, ura: UraEmCurso, evento: EventoDaUra): Promise<void> {
    if (l.fim || l.ura !== ura) return;
    const { estado, acao } = passoDaUra(ura.regra, ura.estado, evento);
    ura.estado = estado;
    switch (acao.tipo) {
      case "ignorar":
        return;
      case "esperar":
        return this.armarPrazoDaUra(l, ura, acao.ms, acao.vez);
      case "tocar":
        this.pararPrazoDaUra(ura);
        if (acao.pararAtual) await this.falaNoAr.pararAtual(l);
        return this.tocarNaUra(l, ura, acao.fala);
      case "encaminhar":
        this.pararPrazoDaUra(ura);
        if (acao.pararAtual) await this.falaNoAr.pararAtual(l);
        return this.sairDaUra(l, ura, acao);
      default: {
        const _nunca: never = acao;
        return _nunca;
      }
    }
  }

  /**
   * Os 5 s depois do menu. O timer guarda a `vez` da ação `esperar` NO MOMENTO
   * EM QUE É ARMADO e a devolve no `prazo` — nunca a vez do estado na hora do
   * disparo. O prazo que disparou e esperou na fila serial atrás de uma tecla
   * chega quando a espera já é outra; com a vez da hora do disparo, ele gastaria
   * uma repetição que o cliente não teve. Com a vez de quando foi armado, a
   * regra o reconhece como velho e o ignora.
   */
  private armarPrazoDaUra(l: Recebida, ura: UraEmCurso, ms: number, vez: number) {
    this.pararPrazoDaUra(ura);
    if (l.fim) return;
    ura.relogios.prazo = setTimeout(() => {
      ura.relogios.prazo = null;
      if (l.fim || l.ura !== ura) return;
      void this.emFila(() => this.executarUra(l, ura, { tipo: "prazo", vez })).catch((e) =>
        this.log.error("telefonia: prazo da URA falhou", { erro: String(e) }),
      );
    }, ms);
  }

  private pararPrazoDaUra(ura: UraEmCurso) {
    pararRelogio(ura.relogios, "prazo");
  }

  /**
   * A URA decidiu o time: grava a escolha (tecla, desfecho e time numa escrita
   * só, que também leva a conversa sem dono para o time, para quem é dele
   * enxergá-la e o "Ligar de volta" ter quem a abra) e a ligação entra na fila
   * dele (§5.2), com tudo o que a fila faz — fora
   * do horário, aviso de instabilidade, "aguarde", os ramais e "ninguém
   * atendeu". Os 2 min da fila contam daqui, da entrada nela (§5.1.3).
   *
   * Time padrão ARQUIVADO: a ligação segue o mesmo caminho (a fila de um time
   * que não atende ninguém, e perdida com "Ligar de volta"), mas antes a Central
   * fica sabendo que o menu precisa de outro time padrão.
   */
  private async sairDaUra(l: Recebida, ura: UraEmCurso, acao: Extract<AcaoDaUra, { tipo: "encaminhar" }>): Promise<void> {
    l.ura = null;
    l.fila.teamId = acao.teamId;
    try {
      const gravou = await this.banco.registrarEscolhaDoMenu(l.org, l.vcId, {
        digito: acao.digito,
        desfecho: acao.desfecho,
        teamId: acao.teamId,
      });
      if (!gravou) this.log.warn("telefonia: escolha do menu não achou a ligação nesta organização", { voice_call: l.vcId });
    } catch (e) {
      // A ligação não para por isso: o cliente já escolheu, e vai ao time dele.
      this.log.warn("telefonia: escolha do menu não gravada", { voice_call: l.vcId, erro: mensagemDe(e, 160) });
    }
    if (acao.teamId === ura.menu.defaultTeamId && !ura.menu.timePadraoAtivo) {
      await this.banco
        .avisarMenuComTimeArquivado(l.org, ura.menu)
        .catch((e) => this.log.warn("telefonia: aviso do menu com time arquivado não gravado", { erro: mensagemDe(e, 160) }));
    }
    this.log.info("telefonia: a URA decidiu o time", {
      voice_call: l.vcId,
      menu: ura.menu.id,
      desfecho: acao.desfecho,
      time: acao.teamId,
    });
    return this.entrarNaFila(l);
  }

  // ─── falas da fila ───────────────────────────────────────────────────────

  /** O "aguarde" só vale enquanto ninguém atendeu e a fila não está se despedindo. */
  private aindaEspera(l: Recebida): boolean {
    return !l.atendidaPor && !l.encerrando;
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
    pararRelogio(l.fila.relogios, "aguarde");
    if (l.fim) return;
    l.fila.relogios.aguarde = setTimeout(() => {
      l.fila.relogios.aguarde = null;
      if (l.fim) return;
      void this.emFila(async () => {
        const aguarde = l.fila.falasGerais.aguarde;
        if (!aguarde || l.fim || l.atendidaPor || l.encerrando || l.fala.atual) return;
        let parouAMusica = false;
        const tocando =
          (await this.falaNoAr.porNoAr(l, aguarde, "espera", {
            valeTocar: () => this.aindaEspera(l),
            antesDeTocar: async () => {
              parouAMusica = true;
              await this.ari.pararMusica(l.cliente).catch(() => undefined);
            },
          })) === "no_ar";
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
    const ninguem = l.fila.falasGerais.ninguem;
    if (
      ninguem &&
      (await this.falaNoAr.porNoAr(l, ninguem, "ninguem", {
        antesDeTocar: async () => {
          await this.falaNoAr.pararAtual(l);
          if (l.atendidaPelaRede) await this.ari.pararMusica(l.cliente).catch(() => undefined);
        },
      })) === "no_ar"
    ) {
      return;
    }
    return this.encerrarRecebida(l, motivo);
  }

  // ─── atendimento e fim da recebida ───────────────────────────────────────

  private async ramalAtendeu(canal: CanalAri, vcId: string) {
    const l = this.porId.get(vcId);
    if (!l || l.tipo !== "recebida" || l.fim || l.encerrando || l.fila.ramal?.canal !== canal.id || l.atendidaPor) {
      // Atendeu tarde (a ligação já foi para outro, acabou ou está se despedindo): larga o ramal.
      await this.ari.desligar(canal.id);
      return;
    }
    this.pararRelogios(l);
    l.atendidaPor = l.fila.ramal.userId;

    // Atendeu no meio do "aguarde": a fala para, e a ponte se forma.
    await this.falaNoAr.pararAtual(l);
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
    await this.banco.marcarAtendida(l.org, vcId, l.atendidaPor);
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
    l.ura = null;
    this.falaNoAr.esquecer(l);
    const outros = [l.cliente, l.fila.ramal?.canal].filter((c): c is string => Boolean(c));
    for (const c of outros) {
      this.porCanal.delete(c);
      await this.ari.desligar(c).catch(() => undefined);
    }
    if (l.ponte) await this.ari.destruirPonte(l.ponte).catch(() => undefined);
    this.porId.delete(l.vcId);
    await this.finalizar(l.org, l.vcId, l.atendidaPor ? "atendida" : "perdida", motivo);
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

    // Só o pedido DESTE atendente: o de outro nem volta do banco.
    const vc = await this.banco.ligacaoDoAtendente(dono.id, m[1]!);
    if (!vc) return recusar("pedido inexistente");
    // A autorização inteira da ligação de saída: o pedido existe, é de saída,
    // ainda não começou, é DESTE atendente e é recente. A senha do ramal, sozinha,
    // não disca para lugar nenhum.
    if (vc.direction !== "outbound" || vc.status !== "starting") return recusar("pedido já usado", { voice_call: vc.id });
    // Defesa em profundidade: a leitura já filtra o dono; a regra continua escrita aqui.
    if (vc.owner_user_id !== dono.id) return recusar("pedido de outro atendente", { voice_call: vc.id });
    if (this.agora() - new Date(vc.started_at).getTime() > VALIDADE_DO_PEDIDO_DE_SAIDA_MS) {
      await this.banco.encerrarLigacao(vc.organization_id, vc.id, "pedido_expirado");
      return recusar("pedido expirado", { voice_call: vc.id });
    }
    const numero = numeroParaLigar(vc.peer_phone);
    if (!numero.ok) {
      await this.banco.encerrarLigacao(vc.organization_id, vc.id, `numero_${numero.motivo}`);
      return recusar("número fora da política", { voice_call: vc.id, motivo: numero.motivo });
    }
    const tronco = await this.banco.troncoPorId(vc.channel_session_id);
    if (!tronco || tronco.organizationId !== vc.organization_id) {
      await this.banco.encerrarLigacao(vc.organization_id, vc.id, RECUSA_DA_SAIDA.troncoIndisponivel);
      return recusar("tronco indisponível", { voice_call: vc.id });
    }
    // O prefixo de discagem é DO TRONCO (vem do banco, nunca do que o atendente
    // digitou) e entra na frente do número que a política acabou de julgar.
    const destino = enderecoDeSaida(tronco, numero.discar);
    if (!destino.ok) {
      await this.banco.encerrarLigacao(vc.organization_id, vc.id, RECUSA_DA_SAIDA.troncoConfiguracaoInvalida);
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
    await this.banco.marcarTocando(vc.organization_id, vc.id, null);
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
      await this.banco.marcarAtendida(l.org, l.vcId, l.userId);
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
    await this.finalizar(l.org, l.vcId, desfecho, motivoFinal);
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
      if (l.fila.ramal?.canal === ev.channel.id) {
        if (l.atendidaPor) return this.encerrarRecebida(l, "atendente_desligou");
        // Não atendeu, recusou ou o ramal caiu: próximo da lista.
        l.fila.ramal = null;
        pararRelogio(l.fila.relogios, "reavaliar");
        await this.marcarTocando(l, null);
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
    await this.finalizar(l.org, l.vcId, "atendida", "encerrada_apos_reinicio");
  }

  private async finalizar(org: string, vcId: string, desfechoPedido: DesfechoDaLigacao, motivo: string) {
    const l = await this.banco.encerrarLigacao(org, vcId, motivo);
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
        const r: Recuperada = {
          tipo: "recuperada",
          vcId: vc.id,
          org: vc.organization_id,
          ponte: ponte.id,
          canais: canaisDaPonte,
          fim: false,
        };
        this.porId.set(vc.id, r);
        for (const c of canaisDaPonte) this.porCanal.set(c, r);
        this.log.info("telefonia: ligação em curso retomada após reinício", { voice_call: vc.id });
        continue;
      }
      for (const c of canaisDaPonte) await this.ari.desligar(c).catch(() => undefined);
      if (vc.sip_call_ref && canaisVivos.has(vc.sip_call_ref)) await this.ari.desligar(vc.sip_call_ref).catch(() => undefined);
      if (ponte) await this.ari.destruirPonte(ponte.id).catch(() => undefined);
      await this.finalizar(vc.organization_id, vc.id, vc.answered_at ? "atendida" : "perdida", "interrompida_no_reinicio");
    }
  }
}
