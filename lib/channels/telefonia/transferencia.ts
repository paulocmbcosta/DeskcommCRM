/**
 * A TRANSFERÊNCIA DE LIGAÇÃO — a mecânica da versão 2 da fase 2 (desenho
 * `docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`,
 * §12, que prevalece sobre §5.3), no molde de `fala-no-ar.ts`: estado por
 * ligação, relógios próprios, e GANCHOS para o controlador. O controlador só
 * roteia os eventos que são dela; tudo o que é transferência mora aqui.
 *
 * A forma comum (§12.2): recebida e feita atendidas são a mesma coisa — a ponte
 * `p-<ligação>`, o canal do cliente e o canal do atendente. A transferência
 * opera sobre essa forma, que o controlador entrega por `vista()`.
 *
 * Os caminhos, pedidos pela tela (a API grava o pedido e emite a ORDEM pela
 * ARI; aqui a transferência é relida do banco — a ordem é ponteiro):
 *
 *   DIRETA PARA PESSOA P, pedida por A (D10):
 *     o cliente ouve música NA PONTE (D19); A sai e é desligado; P toca 20 s
 *     (`transf`). Atendeu → entra na ponte, a música para, a ligação e a
 *     conversa passam a P (`answered`). Não atendeu, recusou ou caiu → A toca
 *     de volta 20 s (`volta`; atendeu → `returned`). A também não → a FILA do
 *     time da ligação (D20/D21).
 *   DIRETA PARA TIME T: a ligação e a conversa vão para T, e a FILA dele.
 *   A FILA (D20): só toques — rodízio do time, 20 s por pessoa, 2 voltas, até
 *     120 s sem ninguém livre, com quem transferiu FORA do rodízio; música o
 *     tempo todo, sem "aguarde", sem aviso de instabilidade, sem "fora do
 *     horário". Alguém atende → `queue_answered`. Esgotou → `missed`: toca
 *     "ninguém atendeu" (se houver) e a ligação acaba com "Ligar de volta".
 *   CONSULTADA (só pessoa): A sai da ponte do cliente SEM ser desligado, entra
 *     na ponte de consulta `k-<ligação>` ouvindo o chamar, e P toca nela
 *     (`consulta`). P atende → os dois conversam. Completar → P vai para a
 *     ponte do cliente e A é desligado. Voltar, P recusar ou P não atender →
 *     A volta ao cliente. A desliga com P na linha → completa; com P ainda
 *     tocando → vira direta (P atendendo vai direto ao cliente; não atendendo,
 *     A toca de volta).
 *   O CLIENTE DESLIGA no meio: tudo encerra (`cancelled`).
 *
 * Uma por vez em cada ligação — aqui (o mapa) e no banco (índice único).
 * Revalidação antes de agir: a ligação está viva, atendida, é de quem
 * transferiu e não tem outra transferência; a pessoa de destino tem ramal
 * online e não está em ligação. Falhou → `refused`, com o motivo, e o painel
 * mostra. Se o worker reinicia, as abertas são fechadas `cancelled`
 * (`worker_reiniciou`) — o risco aceito do desenho, §11.
 */
import {
  ESPERA_NA_FILA_MS,
  ESTADO_INICIAL,
  REAVALIAR_FILA_MS,
  TOQUE_POR_ATENDENTE_MS,
  proximoToque,
  type EstadoDoToque,
} from "@/lib/telefonia/distribuicao";

import type { CanalAri } from "./ari";
import { FOLGA_DO_FIM_DA_FALA_MS, type PortaFalas } from "./fala-no-ar";
import { idDoRamal } from "./pjsip";
import type { EventoAri, PortaAri, PortaBanco, Registro } from "./portas";
import type { DesfechoDaTransferencia, TransferenciaDoBanco } from "./repositorio";

/** O nome do evento de usuário que a API emite pela ARI (`POST /events/user/<nome>`). */
export const EVENTO_DA_TRANSFERENCIA = "telefonia_transferencia";

export const ACOES_DA_TRANSFERENCIA = ["transferir", "completar", "voltar"] as const;
export type AcaoDaTransferencia = (typeof ACOES_DA_TRANSFERENCIA)[number];

/**
 * Os papéis de canal (`appArgs`) da transferência:
 *  - `transf`: o ramal de quem recebe a direta;
 *  - `volta`: o ramal de quem transferiu, tocando de volta;
 *  - `consulta`: o ramal do colega, na ponte de consulta `k-<ligação>`;
 *  - `fila`: o toque da fila da transferência.
 */
export const PAPEIS_DA_TRANSFERENCIA = ["transf", "volta", "consulta", "fila"] as const;
export type PapelDaTransferencia = (typeof PAPEIS_DA_TRANSFERENCIA)[number];

export function papelDaTransferencia(papel: string | undefined): papel is PapelDaTransferencia {
  return (PAPEIS_DA_TRANSFERENCIA as readonly string[]).includes(papel ?? "");
}

/** A ponte de consulta da ligação — onde A e P conversam antes de completar. */
export const ponteDeConsulta = (vcId: string) => `k-${vcId}`;

export interface OrdemDaTransferencia {
  acao: AcaoDaTransferencia;
  transferenciaId: string;
  voiceCallId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * O id da ligação é procurado primeiro NA MEMÓRIA do worker (só vai ao banco
 * junto com a organização da ligação achada): basta ser um identificador
 * limpo. O da transferência vai ao banco — tem de ser uuid.
 */
const ID_DA_LIGACAO = /^[0-9A-Za-z-]{1,64}$/;

/**
 * A ordem da tela, lida do evento de usuário da ARI. O formato (medido pela
 * sonda na VPS antes de depender dele — plano, I5): `ChannelUserevent` com o
 * `eventname` e as variáveis em `userevent`. Qualquer outra forma é `null` —
 * e quem chama registra; nada aqui confia no que a ordem diz além dos ids.
 */
export function lerOrdemDaTransferencia(ev: EventoAri): OrdemDaTransferencia | null {
  if (ev.type !== "ChannelUserevent") return null;
  const e = ev as { eventname?: unknown; userevent?: unknown };
  if (e.eventname !== EVENTO_DA_TRANSFERENCIA) return null;
  const v = e.userevent && typeof e.userevent === "object" ? (e.userevent as Record<string, unknown>) : null;
  if (!v) return null;
  const acao = v.acao;
  const transferenciaId = v.transferencia_id;
  const voiceCallId = v.voice_call_id;
  if (typeof acao !== "string" || !(ACOES_DA_TRANSFERENCIA as readonly string[]).includes(acao)) return null;
  if (typeof transferenciaId !== "string" || !UUID.test(transferenciaId)) return null;
  if (typeof voiceCallId !== "string" || !ID_DA_LIGACAO.test(voiceCallId)) return null;
  return { acao: acao as AcaoDaTransferencia, transferenciaId, voiceCallId };
}

/** A ligação atendida, como a transferência a vê — recebida e feita têm a mesma forma (§12.2). */
export interface VistaDaLigacao {
  vcId: string;
  org: string;
  /** A ponte do cliente, `p-<ligação>` — viva a ligação inteira. */
  ponte: string | null;
  /** O canal do cliente (na recebida, o do tronco; na feita, a perna da operadora). */
  cliente: string;
  /** O número que aparece no ramal de quem recebe: o do cliente. */
  numeroExibido: string;
  conversationId: string | null;
  /** O time que a ligação já conhece em memória (recebida: o da fila). Sem ele, o banco responde (D21). */
  teamId: string | null;
  /** Quem está com o cliente agora — `null` no meio de uma direta (A já saiu, P ainda não entrou). */
  atendente: { canal: string; userId: string } | null;
  /** A ligação foi atendida e tem ponte: é a única que pode ser transferida. */
  atendida: boolean;
  /** Acabou, ou está se despedindo. */
  fim: boolean;
}

/** O que o dono da ligação (o controlador) faz quando a transferência precisa dele. */
export interface GanchosDaTransferencia<L> {
  vista(l: L): VistaDaLigacao;
  /** A ligação VIVA que o controlador acompanha com este id — recebida ou feita; `null` se não há. */
  ligacaoPorId(vcId: string): L | null;
  /**
   * O atendente da ligação muda: o canal antigo sai do mapa do controlador (SEM
   * ser desligado — quem desliga é a transferência) e o novo entra; `null` = no
   * meio da direta, ninguém está com o cliente.
   */
  trocarAtendente(l: L, novo: { canal: string; userId: string } | null): void;
  /** Encerra a ligação inteira pelo fim normal. `ligarDeVolta`: abre o "Ligar de volta" mesmo com a ligação atendida. */
  encerrar(l: L, motivo: string, opcoes: { ligarDeVolta: boolean }): Promise<void>;
}

type Relogio = ReturnType<typeof setTimeout>;

type Fase =
  /** A direta: o ramal de P tocando. */
  | "tocando_pessoa"
  /** O ramal de quem transferiu tocando de volta (D10). */
  | "tocando_volta"
  /** A fila da transferência (D20). */
  | "fila"
  /** A consultada: o ramal de P tocando na ponte de consulta, A ouvindo o chamar. */
  | "consulta_tocando"
  /** A consultada: A e P conversando, o cliente com música. */
  | "consulta_falando"
  /** Ninguém pegou: "ninguém atendeu" tocando antes de desligar. */
  | "despedida";

interface EmCurso<L> {
  l: L;
  vcId: string;
  org: string;
  id: string;
  kind: "blind" | "attended";
  /** Quem transferiu — fora do rodízio da fila, e quem toca de volta. */
  de: string;
  para: { userId: string } | { teamId: string };
  fase: Fase;
  /** O canal do destino que está tocando (ou, na consulta, falando). */
  canal: string | null;
  /** Para quem ele está tocando. */
  alvo: string | null;
  /** Consultada: o canal de A na ponte de consulta. `null` = A saiu (ou não é consultada). */
  quemTransferiu: string | null;
  /** Consultada que virou direta porque A desligou com P ainda tocando. */
  virouDireta: boolean;
  /** O chamar que A ouve na ponte de consulta. */
  tom: string | null;
  fila: { teamId: string; toque: EstadoDoToque; inicioDaEspera: number | null } | null;
  /** O playback do "ninguém atendeu" da despedida. */
  fala: string | null;
  relogio: Relogio | null;
  /** A linha do banco já foi fechada. */
  fechada: boolean;
}

const mensagemDe = (e: unknown, max = 160) => (e instanceof Error ? e.message.slice(0, max) : String(e).slice(0, max));

export class Transferencias<L> {
  private readonly porLigacao = new Map<string, EmCurso<L>>();
  private readonly porCanal = new Map<string, EmCurso<L>>();
  private readonly porFala = new Map<string, EmCurso<L>>();

  constructor(
    private readonly d: {
      ari: PortaAri;
      banco: PortaBanco;
      falas: PortaFalas;
      log: Registro;
      agora: () => number;
      /** A fila serial do laço: o relógio nunca roda no meio de um evento. */
      emFila: (fn: () => Promise<void>) => Promise<void>;
      ganchos: GanchosDaTransferencia<L>;
    },
  ) {}

  /** Quantas transferências estão acontecendo (para testes: o mapa esvazia). */
  get emCurso(): number {
    return this.porLigacao.size;
  }

  /** A ligação tem uma transferência acontecendo? (o controlador não mexe nela enquanto isso). */
  temTransferencia(vcId: string): boolean {
    return this.porLigacao.has(vcId);
  }

  // ─── a ordem da tela ─────────────────────────────────────────────────────

  async aoReceberOrdem(ev: EventoAri): Promise<void> {
    const ordem = lerOrdemDaTransferencia(ev);
    if (!ordem) {
      const nome = (ev as { eventname?: unknown }).eventname;
      if (nome === EVENTO_DA_TRANSFERENCIA) this.d.log.warn("telefonia: ordem de transferência ilegível — ignorada");
      return;
    }
    const l = this.d.ganchos.ligacaoPorId(ordem.voiceCallId);
    if (!l) {
      this.d.log.warn("telefonia: ordem de transferência para ligação que este worker não acompanha — recusada", {
        voice_call: ordem.voiceCallId,
        acao: ordem.acao,
      });
      if (ordem.acao === "transferir" && UUID.test(ordem.voiceCallId)) {
        await this.d.banco
          .recusarTransferenciaOrfa(ordem.transferenciaId, ordem.voiceCallId, "ligacao_desconhecida")
          .catch((e) => this.d.log.warn("telefonia: transferência órfã não recusada", { erro: mensagemDe(e) }));
      }
      return;
    }
    const v = this.d.ganchos.vista(l);
    if (ordem.acao === "transferir") {
      const t = await this.d.banco.transferenciaAberta(v.org, v.vcId, ordem.transferenciaId);
      if (!t) {
        this.d.log.warn("telefonia: ordem de transferência sem transferência aberta no banco — ignorada", {
          voice_call: v.vcId,
          transferencia: ordem.transferenciaId,
        });
        return;
      }
      return this.iniciar(l, t);
    }
    const em = this.porLigacao.get(v.vcId);
    if (!em || em.id !== ordem.transferenciaId || em.kind !== "attended") {
      this.d.log.warn("telefonia: ordem para uma consulta que não está acontecendo — ignorada", {
        voice_call: v.vcId,
        acao: ordem.acao,
      });
      return;
    }
    if (ordem.acao === "completar") {
      if (em.fase !== "consulta_falando") {
        this.d.log.warn("telefonia: completar antes de o colega atender — ignorado", { voice_call: v.vcId, fase: em.fase });
        return;
      }
      return this.completar(em);
    }
    if (em.fase === "consulta_tocando" || em.fase === "consulta_falando") {
      return this.voltarAoCliente(em, { desfecho: "cancelled", motivo: "voltou_ao_cliente" });
    }
  }

  // ─── começo ──────────────────────────────────────────────────────────────

  private async recusar(org: string, vcId: string, id: string, motivo: string): Promise<void> {
    this.d.log.warn("telefonia: transferência recusada", { voice_call: vcId, transferencia: id, motivo });
    await this.d.banco
      .encerrarTransferencia(org, id, { desfecho: "refused", motivo, atendidaPor: null })
      .catch((e) => this.d.log.warn("telefonia: recusa da transferência não gravada", { erro: mensagemDe(e) }));
  }

  private async online(userId: string): Promise<boolean> {
    return this.d.ari.ramalOnline(userId).catch(() => false);
  }

  private async emLigacao(org: string, userId: string): Promise<boolean> {
    // Sem a resposta, segue: o navegador de quem está em ligação recusa o segundo toque (486).
    return this.d.banco.pessoaEmLigacao(org, userId).catch(() => false);
  }

  private async iniciar(l: L, t: TransferenciaDoBanco): Promise<void> {
    const v = this.d.ganchos.vista(l);
    const recusar = (motivo: string) => this.recusar(v.org, v.vcId, t.id, motivo);
    if (v.fim || !v.atendida || !v.atendente || !v.ponte) return recusar("ligacao_nao_atendida");
    if (this.porLigacao.has(v.vcId)) return recusar("ja_ha_transferencia");
    if (t.fromUserId && t.fromUserId !== v.atendente.userId) return recusar("dono_mudou");
    if (t.kind === "attended" && !t.toUserId) return recusar("consultada_so_para_pessoa");
    if (t.toUserId) {
      if (t.toUserId === v.atendente.userId) return recusar("destino_e_quem_transferiu");
      if (!(await this.online(t.toUserId))) return recusar("destino_offline");
      if (await this.emLigacao(v.org, t.toUserId)) return recusar("destino_em_ligacao");
    } else if (!t.toTeamId) {
      return recusar("sem_destino");
    }
    // As leituras acima esperaram: a ligação pode ter acabado, ou mudado de mãos, nesse meio-tempo.
    const agora = this.d.ganchos.vista(l);
    if (agora.fim || !agora.atendente || agora.atendente.userId !== v.atendente.userId) return recusar("ligacao_mudou");
    if (this.porLigacao.has(v.vcId)) return recusar("ja_ha_transferencia");

    const a = agora.atendente;
    const em: EmCurso<L> = {
      l,
      vcId: v.vcId,
      org: v.org,
      id: t.id,
      kind: t.kind,
      de: a.userId,
      para: t.toUserId ? { userId: t.toUserId } : { teamId: t.toTeamId! },
      fase: t.kind === "attended" ? "consulta_tocando" : t.toUserId ? "tocando_pessoa" : "fila",
      canal: null,
      alvo: null,
      quemTransferiu: null,
      virouDireta: false,
      tom: null,
      fila: null,
      fala: null,
      relogio: null,
      fechada: false,
    };
    this.porLigacao.set(v.vcId, em);
    this.d.log.info("telefonia: transferência começou", {
      voice_call: v.vcId,
      transferencia: t.id,
      tipo: t.kind,
      para: t.toUserId ? "pessoa" : "time",
    });

    // O cliente ouve música na ponte dele do começo ao fim (D19).
    await this.d.ari
      .musicaNaPonte(agora.ponte!)
      .catch((e) => this.d.log.warn("telefonia: música na ponte não tocou", { voice_call: v.vcId, erro: mensagemDe(e) }));

    if (t.kind === "attended") {
      // A sai da ponte do cliente SEM ser desligado e vai para a ponte de consulta.
      em.quemTransferiu = a.canal;
      this.porCanal.set(a.canal, em);
      await this.d.ari.tirarDaPonte(agora.ponte!, a.canal).catch(() => undefined);
      await this.d.ari.criarPonte(ponteDeConsulta(v.vcId));
      await this.d.ari.porNaPonte(ponteDeConsulta(v.vcId), a.canal);
      em.tom = (await this.d.ari.tocarTom(a.canal, "ring").catch(() => null))?.id ?? null;
      return this.tocar(em, t.toUserId!, "consulta");
    }

    // Direta: A sai e é desligado. Primeiro sai do mapa do controlador — o fim do
    // canal dele não é o fim da ligação.
    this.d.ganchos.trocarAtendente(l, null);
    await this.d.ari.desligar(a.canal).catch(() => undefined);
    if (t.toUserId) return this.tocar(em, t.toUserId, "transf");
    // Para time: a ligação e a conversa vão para ele, e a fila dele.
    await this.d.banco
      .moverParaOTime(v.org, v.vcId, v.conversationId, t.toTeamId!)
      .catch((e) => this.d.log.warn("telefonia: ligação não movida para o time", { voice_call: v.vcId, erro: mensagemDe(e) }));
    return this.comecarFila(em, t.toTeamId!);
  }

  // ─── tocar um ramal ──────────────────────────────────────────────────────

  private armar(em: EmCurso<L>, ms: number, fn: () => Promise<void>) {
    this.pararRelogio(em);
    em.relogio = setTimeout(() => {
      em.relogio = null;
      void this.d
        .emFila(async () => {
          if (this.porLigacao.get(em.vcId) === em) await fn();
        })
        .catch((e) => this.d.log.error("telefonia: relógio da transferência falhou", { erro: String(e) }));
    }, ms);
  }

  private pararRelogio(em: EmCurso<L>) {
    if (em.relogio) clearTimeout(em.relogio);
    em.relogio = null;
  }

  private vivo(em: EmCurso<L>): boolean {
    return this.porLigacao.get(em.vcId) === em && !this.d.ganchos.vista(em.l).fim;
  }

  private async tocar(em: EmCurso<L>, userId: string, papel: PapelDaTransferencia): Promise<void> {
    if (!this.vivo(em)) return;
    const v = this.d.ganchos.vista(em.l);
    em.alvo = userId;
    let canal: { id: string };
    try {
      canal = await this.d.ari.originar({
        endpoint: `PJSIP/${idDoRamal(userId)}`,
        appArgs: `${papel},${em.vcId}`,
        callerId: v.numeroExibido,
        prazoS: Math.round(TOQUE_POR_ATENDENTE_MS / 1000),
        variaveis: {
          "PJSIP_HEADER(add,X-Ligacao-Id)": em.vcId,
          "PJSIP_HEADER(add,X-Transferida-Por)": em.de,
          "PJSIP_HEADER(add,X-Transferencia)": papel,
        },
      });
    } catch (e) {
      this.d.log.warn("telefonia: ramal da transferência não tocou — segue como não atendido", {
        voice_call: em.vcId,
        papel,
        erro: mensagemDe(e),
      });
      em.alvo = null;
      return this.naoAtendeu(em);
    }
    if (!this.vivo(em)) {
      await this.d.ari.desligar(canal.id).catch(() => undefined);
      return;
    }
    em.canal = canal.id;
    this.porCanal.set(canal.id, em);
    await this.d.banco
      .marcarTocandoNaTransferencia(em.org, em.vcId, userId)
      .catch((e) => this.d.log.warn("telefonia: 'tocando' da transferência não gravado", { erro: mensagemDe(e) }));
    // Rede de segurança: se o Asterisk não derrubar o toque no prazo, derrubamos.
    const esperado = canal.id;
    this.armar(em, TOQUE_POR_ATENDENTE_MS + 3_000, async () => {
      if (em.canal === esperado && (em.fase !== "consulta_falando")) {
        await this.d.ari.desligar(esperado, "no_answer").catch(() => undefined);
      }
    });
  }

  /** O ramal que tocava não atendeu (recusou, caiu, 20 s) — o próximo passo depende da fase. */
  private async naoAtendeu(em: EmCurso<L>): Promise<void> {
    em.canal = null;
    em.alvo = null;
    this.pararRelogio(em);
    if (!this.vivo(em)) return;
    switch (em.fase) {
      case "tocando_pessoa":
        return this.tocarVolta(em);
      case "tocando_volta":
        return this.irParaAFila(em);
      case "fila":
        return this.proximoDaFila(em);
      case "consulta_tocando":
        if (em.virouDireta) return this.tocarVolta(em);
        return this.voltarAoCliente(em, { desfecho: "returned", motivo: "destino_nao_atendeu" });
      case "consulta_falando":
        // O colega desligou no meio da conversa com A: A volta ao cliente.
        return this.voltarAoCliente(em, { desfecho: "returned", motivo: "destino_desligou" });
      case "despedida":
        return;
    }
  }

  /**
   * D10: P não atendeu — o ramal de quem transferiu toca de volta. "Livre" aqui
   * DESCONTA esta ligação: quem transferiu ainda é o dono dela no banco, e a
   * régua comum (`pessoaEmLigacao`) diria sempre que está ocupado.
   */
  private async tocarVolta(em: EmCurso<L>): Promise<void> {
    em.fase = "tocando_volta";
    const livre =
      (await this.online(em.de)) &&
      (await this.d.banco.colegaLivreParaInterna(em.org, em.de, em.vcId).catch(() => true));
    if (!livre) return this.irParaAFila(em);
    return this.tocar(em, em.de, "volta");
  }

  // ─── a fila da transferência (D20) ───────────────────────────────────────

  /** D21: o time da ligação. Sem time → perdida, com "Ligar de volta". */
  private async irParaAFila(em: EmCurso<L>): Promise<void> {
    if (!this.vivo(em)) return;
    const v = this.d.ganchos.vista(em.l);
    let teamId: string | null = "teamId" in em.para ? em.para.teamId : v.teamId;
    if (!teamId) teamId = await this.d.banco.timeDaLigacao(em.org, em.vcId).catch(() => null);
    if (!teamId) return this.desistir(em, "sem_time");
    // A ligação vai para a fila do time: ela e a conversa passam a ser dele.
    await this.d.banco
      .moverParaOTime(em.org, em.vcId, v.conversationId, teamId)
      .catch((e) => this.d.log.warn("telefonia: ligação não movida para o time", { voice_call: em.vcId, erro: mensagemDe(e) }));
    return this.comecarFila(em, teamId);
  }

  private async comecarFila(em: EmCurso<L>, teamId: string): Promise<void> {
    em.fase = "fila";
    em.fila = { teamId, toque: ESTADO_INICIAL, inicioDaEspera: null };
    return this.proximoDaFila(em);
  }

  private async proximoDaFila(em: EmCurso<L>): Promise<void> {
    if (!this.vivo(em) || !em.fila) return;
    const fila = em.fila;
    let disponiveis: Awaited<ReturnType<PortaBanco["disponiveisNoTime"]>> = [];
    try {
      disponiveis = await this.d.banco.disponiveisNoTime(em.org, fila.teamId, new Date(this.d.agora()));
    } catch (e) {
      this.d.log.warn("telefonia: disponíveis do time não lidos — a fila da transferência espera", {
        voice_call: em.vcId,
        erro: mensagemDe(e),
      });
    }
    // Quem transferiu fica FORA do rodízio (D20).
    const candidatos = disponiveis.filter((c) => c.userId !== em.de);
    const online = await Promise.all(candidatos.map((c) => this.online(c.userId)));
    const p = proximoToque(
      candidatos.filter((_, i) => online[i]),
      fila.toque,
    );
    if (!this.vivo(em)) return;
    if (p.tipo === "desistir") return this.desistir(em, "ninguem_atendeu");
    if (p.tipo === "esperar") {
      if (fila.inicioDaEspera === null) {
        fila.inicioDaEspera = this.d.agora();
        await this.d.banco.marcarTocandoNaTransferencia(em.org, em.vcId, null).catch(() => undefined);
      }
      if (this.d.agora() - fila.inicioDaEspera >= ESPERA_NA_FILA_MS) return this.desistir(em, "fila_esgotada");
      this.armar(em, REAVALIAR_FILA_MS, () => this.proximoDaFila(em));
      return;
    }
    fila.toque = p.estado;
    return this.tocar(em, p.userId, "fila");
  }

  /**
   * Ninguém pegou (D20): a transferência fecha `missed`, toca "ninguém atendeu"
   * (se houver e tocar) e a ligação acaba com "Ligar de volta" para o time.
   */
  private async desistir(em: EmCurso<L>, motivo: string): Promise<void> {
    if (!this.vivo(em)) return;
    em.fase = "despedida";
    this.pararRelogio(em);
    await this.fechar(em, { desfecho: "missed", motivo, atendidaPor: null });
    await this.d.banco.marcarTocandoNaTransferencia(em.org, em.vcId, null).catch(() => undefined);
    const v = this.d.ganchos.vista(em.l);
    let midia: string | null = null;
    let duracaoMs = 0;
    try {
      const ninguem = (await this.d.banco.falasGerais(em.org)).ninguem;
      if (ninguem) {
        midia = await this.d.falas.garantir(ninguem).catch(() => null);
        duracaoMs = ninguem.duracaoMs;
      }
    } catch (e) {
      this.d.log.warn("telefonia: falas gerais não lidas — a transferência encerra sem 'ninguém atendeu'", {
        voice_call: em.vcId,
        erro: mensagemDe(e),
      });
    }
    if (midia && v.ponte) {
      await this.d.ari.pararMusicaNaPonte(v.ponte).catch(() => undefined);
      try {
        const id = await this.d.ari.tocarFala(v.cliente, midia);
        em.fala = id;
        this.porFala.set(id, em);
        this.armar(em, duracaoMs + FOLGA_DO_FIM_DA_FALA_MS, () => this.terminarDespedida(em));
        return;
      } catch (e) {
        this.d.log.warn("telefonia: 'ninguém atendeu' não tocou na transferência", { voice_call: em.vcId, erro: mensagemDe(e) });
      }
    }
    return this.terminarDespedida(em);
  }

  private async terminarDespedida(em: EmCurso<L>): Promise<void> {
    if (this.porLigacao.get(em.vcId) !== em) return;
    if (em.fala) this.porFala.delete(em.fala);
    em.fala = null;
    this.esquecer(em);
    await this.d.ganchos.encerrar(em.l, "transferencia_nao_atendida", { ligarDeVolta: true });
  }

  /** O `PlaybackFinished` do "ninguém atendeu". `true` = era dela. */
  async aoTerminarFala(ev: Extract<EventoAri, { type: "PlaybackFinished" }>): Promise<boolean> {
    const id = ev.playback?.id;
    const em = id ? this.porFala.get(id) : undefined;
    if (!em || !id) return false;
    this.porFala.delete(id);
    em.fala = null;
    await this.terminarDespedida(em);
    return true;
  }

  // ─── atendeu ─────────────────────────────────────────────────────────────

  /** Um ramal da transferência atendeu (`StasisStart` com um dos papéis). */
  async aoAtender(canal: CanalAri, papel: PapelDaTransferencia, vcId: string): Promise<void> {
    const em = this.porCanal.get(canal.id);
    if (!em || em.vcId !== vcId || em.canal !== canal.id || !this.vivo(em) || !em.alvo) {
      // Atendeu tarde (já foi para outro, voltou, acabou): larga o ramal.
      await this.d.ari.desligar(canal.id).catch(() => undefined);
      return;
    }
    this.pararRelogio(em);
    if (papel === "consulta" && !em.virouDireta) {
      // P atendeu a consulta: fala com A na ponte de consulta, o cliente segue com música.
      await this.pararTom(em);
      await this.d.ari.porNaPonte(ponteDeConsulta(em.vcId), canal.id);
      em.fase = "consulta_falando";
      await this.d.banco.marcarTocandoNaTransferencia(em.org, em.vcId, em.alvo).catch(() => undefined);
      this.d.log.info("telefonia: consulta atendida", { voice_call: em.vcId });
      return;
    }
    const desfecho: DesfechoDaTransferencia =
      papel === "volta" ? "returned" : papel === "fila" ? "queue_answered" : "answered";
    if (papel === "consulta") await this.d.ari.destruirPonte(ponteDeConsulta(em.vcId)).catch(() => undefined);
    return this.entregar(em, canal.id, em.alvo, desfecho);
  }

  /** Quem atendeu fica com o cliente: entra na ponte, a música para, a ligação e a conversa passam a ele. */
  private async entregar(em: EmCurso<L>, canal: string, userId: string, desfecho: DesfechoDaTransferencia): Promise<void> {
    const v = this.d.ganchos.vista(em.l);
    this.porCanal.delete(canal);
    em.canal = null;
    this.esquecer(em);
    if (!v.ponte) return;
    await this.d.ari.porNaPonte(v.ponte, canal);
    await this.d.ari
      .pararMusicaNaPonte(v.ponte)
      .catch((e) => this.d.log.warn("telefonia: música da ponte não parada", { voice_call: em.vcId, erro: mensagemDe(e) }));
    this.d.ganchos.trocarAtendente(em.l, { canal, userId });
    await this.d.banco
      .passarLigacao(em.org, em.vcId, userId)
      .catch((e) => this.d.log.warn("telefonia: ligação não passada a quem atendeu", { erro: mensagemDe(e) }));
    if (v.conversationId) {
      await this.d.banco
        .atribuirConversa(em.org, v.conversationId, userId, "transfer")
        .catch((e) => this.d.log.warn("telefonia: conversa não atribuída a quem pegou a transferência", { erro: mensagemDe(e) }));
    }
    await this.fechar(em, { desfecho, motivo: null, atendidaPor: userId });
    this.d.log.info("telefonia: transferência atendida", { voice_call: em.vcId, desfecho, atendente: userId });
  }

  // ─── a consultada ────────────────────────────────────────────────────────

  private async pararTom(em: EmCurso<L>) {
    const id = em.tom;
    em.tom = null;
    if (id) await this.d.ari.pararReproducao(id).catch(() => undefined);
  }

  /** Completar: P passa para a ponte do cliente e A é desligado. */
  private async completar(em: EmCurso<L>): Promise<void> {
    const p = em.canal;
    const userId = em.alvo;
    if (!p || !userId) return;
    const a = em.quemTransferiu;
    em.quemTransferiu = null;
    if (a) this.porCanal.delete(a);
    await this.d.ari.tirarDaPonte(ponteDeConsulta(em.vcId), p).catch(() => undefined);
    if (a) await this.d.ari.tirarDaPonte(ponteDeConsulta(em.vcId), a).catch(() => undefined);
    await this.d.ari.destruirPonte(ponteDeConsulta(em.vcId)).catch(() => undefined);
    // `entregar` troca o atendente — A sai do mapa do controlador antes de ser desligado.
    await this.entregar(em, p, userId, "answered");
    if (a) await this.d.ari.desligar(a).catch(() => undefined);
  }

  /** Voltar ao cliente (A pediu, P recusou, não atendeu ou desligou): P sai, A volta à ponte do cliente. */
  private async voltarAoCliente(
    em: EmCurso<L>,
    fim: { desfecho: DesfechoDaTransferencia; motivo: string },
  ): Promise<void> {
    const v = this.d.ganchos.vista(em.l);
    this.pararRelogio(em);
    const p = em.canal;
    em.canal = null;
    em.alvo = null;
    if (p) {
      this.porCanal.delete(p);
      await this.d.ari.desligar(p).catch(() => undefined);
    }
    await this.pararTom(em);
    const a = em.quemTransferiu;
    em.quemTransferiu = null;
    if (a) this.porCanal.delete(a);
    this.esquecer(em);
    if (a) await this.d.ari.tirarDaPonte(ponteDeConsulta(em.vcId), a).catch(() => undefined);
    await this.d.ari.destruirPonte(ponteDeConsulta(em.vcId)).catch(() => undefined);
    if (a && v.ponte) {
      await this.d.ari.porNaPonte(v.ponte, a);
      await this.d.ari.pararMusicaNaPonte(v.ponte).catch(() => undefined);
    }
    await this.d.banco.marcarTocandoNaTransferencia(em.org, em.vcId, null).catch(() => undefined);
    await this.fechar(em, { ...fim, atendidaPor: em.de });
    this.d.log.info("telefonia: consulta encerrada, de volta ao cliente", { voice_call: em.vcId, motivo: fim.motivo });
  }

  // ─── canais que caem ─────────────────────────────────────────────────────

  /** O fim de um canal. `true` = era da transferência, e já foi tratado aqui. */
  async aoDestruirCanal(canalId: string): Promise<boolean> {
    const em = this.porCanal.get(canalId);
    if (!em) return false;
    this.porCanal.delete(canalId);
    if (canalId === em.quemTransferiu) {
      // A desligou no meio da consulta.
      em.quemTransferiu = null;
      em.tom = null;
      this.d.ganchos.trocarAtendente(em.l, null);
      if (!this.vivo(em)) return true;
      if (em.fase === "consulta_falando" && em.canal && em.alvo) {
        // Com P na linha: completa.
        const p = em.canal;
        await this.d.ari.tirarDaPonte(ponteDeConsulta(em.vcId), p).catch(() => undefined);
        await this.d.ari.destruirPonte(ponteDeConsulta(em.vcId)).catch(() => undefined);
        await this.entregar(em, p, em.alvo, "answered");
        return true;
      }
      // Com P ainda tocando: vira direta.
      em.virouDireta = true;
      await this.d.ari.destruirPonte(ponteDeConsulta(em.vcId)).catch(() => undefined);
      this.d.log.info("telefonia: quem transferiu desligou com o colega tocando — virou direta", { voice_call: em.vcId });
      return true;
    }
    if (canalId === em.canal) await this.naoAtendeu(em);
    return true;
  }

  // ─── fim da ligação ──────────────────────────────────────────────────────

  /**
   * A ligação está acabando (o cliente desligou, ou a despedida terminou): os
   * canais da transferência caem, a ponte de consulta também, e a linha do
   * banco fecha `cancelled` se ainda estava aberta. Idempotente.
   */
  async aoEncerrarLigacao(vcId: string): Promise<void> {
    const em = this.porLigacao.get(vcId);
    if (!em) return;
    this.pararRelogio(em);
    this.esquecer(em);
    if (em.fala) this.porFala.delete(em.fala);
    em.fala = null;
    await this.pararTom(em);
    for (const c of [em.canal, em.quemTransferiu]) {
      if (!c) continue;
      this.porCanal.delete(c);
      await this.d.ari.desligar(c).catch(() => undefined);
    }
    em.canal = null;
    em.quemTransferiu = null;
    if (em.kind === "attended") await this.d.ari.destruirPonte(ponteDeConsulta(vcId)).catch(() => undefined);
    await this.fechar(em, { desfecho: "cancelled", motivo: "cliente_desligou", atendidaPor: null });
  }

  private esquecer(em: EmCurso<L>) {
    if (this.porLigacao.get(em.vcId) === em) this.porLigacao.delete(em.vcId);
    this.pararRelogio(em);
  }

  private async fechar(
    em: EmCurso<L>,
    fim: { desfecho: DesfechoDaTransferencia; motivo: string | null; atendidaPor: string | null },
  ): Promise<void> {
    if (em.fechada) return;
    em.fechada = true;
    await this.d.banco
      .encerrarTransferencia(em.org, em.id, fim)
      .catch((e) => this.d.log.warn("telefonia: desfecho da transferência não gravado", { voice_call: em.vcId, erro: mensagemDe(e) }));
  }
}
