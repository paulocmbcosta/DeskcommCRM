/**
 * A FALA NO AR — a mecânica comum da URA e da fila do time (desenho da fase 2,
 * §5.1 e §5.2). Uma fala por vez no canal do cliente:
 *
 *   porNoAr    garante o arquivo no disco, atende a ligação e pede a fala ao
 *              Asterisk; a que não toca é PULADA (e avisada na Central);
 *   pararAtual para a fala no ar; o fim dela, que chega depois, é ignorado;
 *   aoTerminar o `PlaybackFinished` — ou o RELÓGIO da fala, se o evento se
 *              perder — conclui a fala e devolve a vez ao dono da ligação, pelo
 *              gancho `aposFala`, com o PAPEL que a fala tinha;
 *   esquecer   a ligação acabou: a fala sai do mapa e o relógio dela para.
 *
 * Quem pede uma fala (a URA, a fila; na versão 2, a transferência) não lida com
 * playback nem relógio: pede com um papel e recebe a vez de volta no fim. O que
 * é do dono da ligação — atender, avisar a Central, encerrar, decidir o que vem
 * depois — entra pelos GANCHOS; aqui só mora a mecânica.
 *
 * Nada aqui chama a ElevenLabs (D15): o disco das falas só copia do Storage.
 */
import { ErroAri } from "./ari";
import type { EventoAri, PortaAri, Registro } from "./portas";
import type { FalaDoBanco } from "./repositorio";

/**
 * Quanto além da duração da fala se espera pelo `PlaybackFinished` antes de
 * seguir sem ele. Sem este relógio, um evento perdido deixava a ligação parada
 * para sempre — o cliente em silêncio no meio do aviso de instabilidade, sem
 * nunca chegar ao atendente.
 */
export const FOLGA_DO_FIM_DA_FALA_MS = 5_000;

/**
 * O disco das falas (`falas-no-disco.ts`): o endereço de mídia (`sound:…`) com
 * o arquivo garantido no volume, ou `null` — e aí a ligação pula a fala. Nunca
 * lança e espera no máximo 3 s (`PRAZO_DO_GARANTIR_MS`).
 */
export interface PortaFalas {
  garantir(fala: Pick<FalaDoBanco, "id" | "storagePath">): Promise<string | null>;
}

/**
 * O que aconteceu ao pedir uma fala (`porNoAr`):
 *  - `no_ar` — tocando; o que vem depois é decidido no fim dela;
 *  - `pulada` — não tocou (sem arquivo, recusada pelo Asterisk, ou deixou de
 *    valer enquanto o arquivo era garantido), e quem pediu segue sem ela;
 *  - `sem_canal` — o canal do cliente já tinha ido embora: é ele desligando, e
 *    a ligação já foi encerrada (gancho `canalSumiu`).
 */
export type FalaPedida = "no_ar" | "pulada" | "sem_canal";

/** A fala que está tocando numa ligação. */
export interface FalaAtual<P extends string> {
  playbackId: string;
  papel: P;
  /** O nome da fala na Central, se ela não tocar ("aguarde", "menu Principal"…). */
  rotulo: string;
}

/** O estado da fala de UMA ligação. Só este módulo o escreve. */
export interface FalaDaLigacao<P extends string> {
  atual: FalaAtual<P> | null;
  /**
   * O fim da fala no ar, se o `PlaybackFinished` não chegar (WebSocket da ARI
   * caído, evento perdido): duração da fala + `FOLGA_DO_FIM_DA_FALA_MS`.
   */
  relogio: ReturnType<typeof setTimeout> | null;
}

export function semFalaNoAr<P extends string>(): FalaDaLigacao<P> {
  return { atual: null, relogio: null };
}

/** O que a mecânica lê da ligação. */
export interface LigacaoComFala<P extends string> {
  readonly vcId: string;
  /** O canal do cliente — onde a fala toca. */
  readonly cliente: string;
  readonly fim: boolean;
  /**
   * O cliente pediu para desligar (`ChannelHangupRequest`). Uma fala cortada
   * pela queda do canal termina `failed` e NÃO é fala sem arquivo: não vira
   * aviso na Central, e o que viria depois dela não acontece.
   */
  readonly clienteSaindo: boolean;
  readonly fala: FalaDaLigacao<P>;
}

/** O que o dono da ligação faz quando a mecânica precisa dele. */
export interface GanchosDaFala<L, P extends string> {
  /** Antes do primeiro som: a ligação tem de estar atendida. */
  atender(l: L): Promise<void>;
  /** A fala não tocou e a ligação seguiu sem ela (`phone_prompt_unplayable`). */
  avisarIntocavel(l: L, rotulo: string): Promise<void>;
  /** O canal do cliente sumiu (404/409 ao pedir a fala): encerrar a ligação pelo fim normal. */
  canalSumiu(l: L): Promise<void>;
  /** O fim da fala — ou a que não tocou (`tocou: false`): o que vem depois. */
  aposFala(l: L, papel: P, tocou: boolean): Promise<void>;
}

export interface OpcoesDaFala {
  /** O nome da fala na Central; o padrão é o do papel ("aguarde"…). */
  rotulo?: string;
  /** Conferido com o arquivo já garantido: a fala ainda faz sentido? Senão, pulada sem aviso. */
  valeTocar?: () => boolean;
  /** Com o arquivo garantido, logo antes de tocar: parar o que está no ar. */
  antesDeTocar?: () => Promise<void>;
}

export class FalasNoAr<L extends LigacaoComFala<P>, P extends string> {
  /** A que ligação pertence cada fala no ar — o `PlaybackFinished` só traz o id do playback. */
  private readonly porReproducao = new Map<string, L>();

  constructor(
    private readonly d: {
      ari: Pick<PortaAri, "tocarFala" | "pararFala">;
      falas: PortaFalas;
      log: Registro;
      /** A fila serial do laço: o relógio da fala nunca roda no meio de um evento. */
      emFila: (fn: () => Promise<void>) => Promise<void>;
      /** O nome da fala na Central quando quem pede não dá um. */
      rotuloDoPapel: (papel: P) => string;
      ganchos: GanchosDaFala<L, P>;
      /**
       * Quando o `PlaybackFinished` se perde e o RELÓGIO da fala conclui, a fala
       * conta como tocada? O padrão é sim (ver `armarRelogio`). O aviso de
       * gravação responde NÃO: sem a prova de que tocou, a ligação não é gravada
       * (D3 da gravação) — e isso não vira aviso na Central, porque a fala pode
       * muito bem ter tocado.
       */
      tocouPeloRelogio?: (papel: P) => boolean;
    },
  ) {}

  /** Quantas falas estão no ar, à espera do `PlaybackFinished`. */
  get noAr(): number {
    return this.porReproducao.size;
  }

  /**
   * Toca uma fala no canal do cliente e devolve o que aconteceu (`FalaPedida`).
   * A fala que não toca — sem arquivo no disco, ou recusada pelo Asterisk — é
   * PULADA: a Central fica sabendo, e quem pediu segue como se ela não
   * existisse. Atende a ligação só depois de o arquivo estar garantido: sem
   * fala, a fila da fase 1 (que ainda deixa chamar) segue.
   */
  async porNoAr(l: L, fala: FalaDoBanco, papel: P, opcoes: OpcoesDaFala = {}): Promise<FalaPedida> {
    const rotulo = opcoes.rotulo ?? this.d.rotuloDoPapel(papel);
    // Com o arquivo no disco, é um `stat`. Sem ele, baixa do Storage com prazo de
    // até 3 s, e a fila SERIAL do laço fica parada esse tempo — todas as
    // ligações esperam. Custo aceito na v1: só acontece quando uma fala
    // recém-salva toca antes da passada de 60 s levá-la ao disco. A conferência
    // abaixo é defesa para quem chama sem a fila (os testes).
    const midia = await this.d.falas.garantir(fala).catch(() => null);
    if (l.fim || (opcoes.valeTocar && !opcoes.valeTocar())) return "pulada";
    if (!midia) {
      this.d.log.warn("telefonia: fala sem arquivo no disco — pulada", { voice_call: l.vcId, fala: fala.id, papel });
      await this.d.ganchos.avisarIntocavel(l, rotulo);
      return "pulada";
    }
    if (opcoes.antesDeTocar) await opcoes.antesDeTocar();
    await this.d.ganchos.atender(l);
    let playbackId: string;
    try {
      playbackId = await this.d.ari.tocarFala(l.cliente, midia);
    } catch (e) {
      // Canal que sumiu (404) ou saiu do Stasis (409) é o cliente desligando, e
      // a fala não tem culpa (sem aviso na Central). A ligação acaba AGORA, pelo
      // fim normal: sem o canal não há ligação, e se o StasisEnd/ChannelDestroyed
      // se perdeu, nada mais a encerraria — ela ficava viva para sempre, sem
      // relógio (medido na revisão: `ativas = 1` dez minutos depois). O fim do
      // canal que chegar depois a acha encerrada e não faz nada.
      const canalSumiu = e instanceof ErroAri && (e.status === 404 || e.status === 409);
      this.d.log.warn("telefonia: o Asterisk não tocou a fala — pulada", {
        voice_call: l.vcId,
        papel,
        erro: mensagemDe(e),
      });
      if (canalSumiu) {
        await this.d.ganchos.canalSumiu(l);
        return "sem_canal";
      }
      await this.d.ganchos.avisarIntocavel(l, rotulo);
      return "pulada";
    }
    if (l.fim) return "pulada";
    l.fala.atual = { playbackId, papel, rotulo };
    this.porReproducao.set(playbackId, l);
    this.armarRelogio(l, playbackId, fala.duracaoMs);
    return "no_ar";
  }

  /** Para a fala no ar. O `PlaybackFinished` dela, que chega depois, é ignorado (já saiu do mapa). */
  async pararAtual(l: L): Promise<void> {
    if (!l.fala.atual) return;
    const id = l.fala.atual.playbackId;
    l.fala.atual = null;
    this.porReproducao.delete(id);
    this.pararRelogio(l);
    await this.d.ari.pararFala(id).catch((e) => this.d.log.warn("telefonia: fala não parada", { erro: mensagemDe(e) }));
  }

  /** O `PlaybackFinished` que a ARI entregou. */
  async aoTerminar(ev: Extract<EventoAri, { type: "PlaybackFinished" }>): Promise<void> {
    const id = ev.playback?.id;
    const l = id ? this.porReproducao.get(id) : undefined;
    // Fala que paramos (ou cujo relógio já seguiu sem ela), ou de ligação que já acabou: nada a fazer.
    if (!l || !id) return;
    return this.concluir(l, id, ev.playback.state !== "failed");
  }

  /** A ligação acabou: a fala no ar sai do mapa e o relógio dela para, sem pedir nada ao Asterisk. */
  esquecer(l: L): void {
    this.pararRelogio(l);
    if (l.fala.atual) this.porReproducao.delete(l.fala.atual.playbackId);
    l.fala.atual = null;
  }

  pararRelogio(l: L): void {
    if (l.fala.relogio) clearTimeout(l.fala.relogio);
    l.fala.relogio = null;
  }

  /** O fim de uma fala — pelo `PlaybackFinished` ou pelo relógio dela (`semAviso`: não avisa a Central). */
  private async concluir(l: L, id: string, tocou: boolean, opcoes: { semAviso?: boolean } = {}): Promise<void> {
    this.porReproducao.delete(id);
    if (l.fim || l.fala.atual?.playbackId !== id) return;
    const fala = l.fala.atual;
    l.fala.atual = null;
    this.pararRelogio(l);
    // Cortada porque o cliente desligou: quem encerra é o StasisEnd que vem atrás.
    // Vale para toda fala — a do menu também: quem desliga no menu não "escolheu"
    // nada, e a ligação vira perdida pelo fim do canal, não pela URA.
    if (l.clienteSaindo) return;
    if (!tocou && !opcoes.semAviso) {
      this.d.log.warn("telefonia: o Asterisk não tocou a fala — pulada", { voice_call: l.vcId, papel: fala.papel });
      await this.d.ganchos.avisarIntocavel(l, fala.rotulo);
    }
    return this.d.ganchos.aposFala(l, fala.papel, tocou);
  }

  /**
   * Se o `PlaybackFinished` desta fala não chegar até a duração dela + a folga,
   * a fala é parada e a ligação segue EXATAMENTE como se ela tivesse terminado
   * bem. O fim que chegar atrasado já não a encontra no mapa e é ignorado.
   *
   * "Como se tivesse terminado bem" é uma SUPOSIÇÃO: sem o evento não há como
   * saber se o áudio tocou até o fim. Quando a fala é o aviso de instabilidade,
   * isso quer dizer que o "ouviu o aviso" (`emergency_heard_at`, no cartão da
   * ligação) é gravado por suposição — a fala tinha arquivo, o Asterisk a
   * aceitou e a duração dela passou. É a leitura mais provável, e a alternativa
   * (não gravar) diria ao atendente que o cliente não ouviu o que provavelmente
   * ouviu. Na URA, o menu dado por terminado abre a espera de 5 s.
   */
  private armarRelogio(l: L, playbackId: string, duracaoMs: number): void {
    this.pararRelogio(l);
    if (l.fim) return;
    l.fala.relogio = setTimeout(() => {
      l.fala.relogio = null;
      if (l.fim) return;
      void this.d
        .emFila(async () => {
          if (l.fim || l.fala.atual?.playbackId !== playbackId) return;
          this.d.log.warn("telefonia: o fim da fala não chegou — a ligação segue sem ele", {
            voice_call: l.vcId,
            papel: l.fala.atual.papel,
          });
          await this.d.ari
            .pararFala(playbackId)
            .catch((e) => this.d.log.warn("telefonia: fala não parada", { erro: mensagemDe(e) }));
          await this.concluir(l, playbackId, this.d.tocouPeloRelogio?.(l.fala.atual.papel) ?? true, { semAviso: true });
        })
        .catch((e) => this.d.log.error("telefonia: relógio da fala falhou", { erro: String(e) }));
    }, duracaoMs + FOLGA_DO_FIM_DA_FALA_MS);
  }
}

const mensagemDe = (e: unknown) => (e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160));
