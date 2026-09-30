/**
 * AS PORTAS DO CONTROLADOR DE CHAMADAS — ARI, banco, registro e os eventos que
 * chegam do Asterisk. Moram aqui, e não em `controle.ts`, para que as mecânicas
 * que o controlador compõe (`fala-no-ar.ts`, `transferencia.ts`) importem os
 * tipos sem importar o controlador que as importa (notas da v1, item 1;
 * desenho da fase 2, §12.2).
 *
 * `controle.ts` reexporta tudo: quem já importava de lá não muda.
 */
import type { CanalAri } from "./ari";
import type { CandidatoAoToque } from "@/lib/telefonia/distribuicao";
import type {
  DesfechoDaLigacao,
  DesfechoDaTransferencia,
  EscolhaDoMenu,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  TimeParaAFila,
  TransferenciaDoBanco,
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
  // ── transferência (v2, D19): o cliente ouve música NA PONTE dele ──
  /** Música para quem está na ponte (o cliente, enquanto a transferência acontece). */
  musicaNaPonte(ponte: string): Promise<unknown>;
  /** Para a música da ponte. Ponte sem música não é erro. */
  pararMusicaNaPonte(ponte: string): Promise<unknown>;
  /** Tira um canal da ponte SEM desligá-lo (a consultada leva quem transferiu para outra ponte). */
  tirarDaPonte(ponte: string, canal: string): Promise<unknown>;
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
  atribuirConversa(org: string, conversationId: string, userId: string, motivo?: "claim" | "transfer"): Promise<void>;
  registrarNaConversa(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, duracaoMs: number | null): Promise<void>;
  avisarPerdida(l: LigacaoDoBanco): Promise<void>;
  registrarFim(l: LigacaoDoBanco, desfecho: DesfechoDaLigacao, motivo: string): Promise<void>;
  // ── transferência (v2, migration 0290) ──
  /** A transferência ABERTA `id` desta ligação, nesta organização (a ordem da ARI é só ponteiro). */
  transferenciaAberta(org: string, vcId: string, id: string): Promise<TransferenciaDoBanco | null>;
  encerrarTransferencia(
    org: string,
    id: string,
    fim: { desfecho: DesfechoDaTransferencia; motivo: string | null; atendidaPor: string | null },
  ): Promise<void>;
  /** A ordem chegou para uma ligação que este worker não acompanha: recusada, presa ao par (transferência, ligação). */
  recusarTransferenciaOrfa(id: string, vcId: string, motivo: string): Promise<void>;
  /** Na (re)conexão: as abertas morreram com o worker anterior. */
  cancelarTransferenciasAbertas(motivo: string): Promise<number>;
  /** `ringing_user_id` sem mexer no `status` (a ligação segue `connected`). */
  marcarTocandoNaTransferencia(org: string, id: string, userId: string | null): Promise<void>;
  /** A ligação passa a ser de quem pegou a transferência. */
  passarLigacao(org: string, id: string, userId: string): Promise<void>;
  /** Transferência para time: a ligação e a conversa vão para ele. */
  moverParaOTime(org: string, id: string, conversationId: string | null, teamId: string): Promise<void>;
  /** D21: o time da ligação (o dela ou, sem ele, o da conversa). */
  timeDaLigacao(org: string, id: string): Promise<string | null>;
  /** A pessoa está numa ligação viva (falando, tocando, ou do outro lado de uma interna). */
  pessoaEmLigacao(org: string, userId: string): Promise<boolean>;
  // ── ramais (v3, migration 0291) ──
  /** Quem tem o ramal `numero` nesta organização (a URA com ramal). */
  donoDoRamal(org: string, numero: string): Promise<string | null>;
  /** O nome e o ramal de quem faz a ligação interna. */
  quemLiga(org: string, userId: string): Promise<{ nome: string; ramal: string | null }>;
  /** O colega pode receber a interna `vcId` agora (membro, sem pausa, sem outra ligação)? */
  colegaLivreParaInterna(org: string, userId: string, vcId: string): Promise<boolean>;
}

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
 * `ChannelUserevent` é a ORDEM da tela para a transferência (versão 2): a API a
 * emite pela ARI, e ela chega aqui como qualquer evento da aplicação.
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
