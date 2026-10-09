/**
 * AS TRANSCRIÇÕES DAS LIGAÇÕES NO WORKER (F4; desenho
 * docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md).
 *
 * O caminho de uma ligação gravada, depois que a gravação é guardada:
 *
 *   pedir (só se a organização ligou, e só a ligação que terminou depois disso)
 *     → baixar o MP3 do Storage
 *     → transcrever (ponto de IA `transcricao_de_ligacao`: trechos com tempo)
 *     → resumir e indicar quem falou (ponto de IA `resumo_de_ligacao`)
 *     → gravar em `voice_call_transcripts` e avisar o cartão pela projeção.
 *
 * ## Por que aqui, e não na fila de eventos
 *
 * O dreno de `event_log` é SERIAL — um evento por vez, e é ele que entrega a
 * mensagem do cliente à IA. Medido com gravações reais (2026-10-09): transcrever
 * leva 28 s numa ligação de 10 min 44 s e 76 s numa de 28 min 49 s, e o resumo
 * mais 2 a 16 s. Um handler assim seguraria a resposta de todos os clientes
 * enquanto uma ligação é transcrita. Aqui ela corre na passada do telefone, fora
 * da fila dos eventos da ligação, UMA por vez — como a conversão da gravação.
 *
 * ## Nada disto pode custar a gravação
 *
 * A transcrição começa DEPOIS de a gravação estar guardada e confirmada, e não
 * escreve em `voice_calls`. O gancho que a dispara (`aoGuardar`) nunca lança, e o
 * pedido que se perder é reposto pela passada (`pedirAsQueFaltam`).
 *
 * ## O que acontece quando falha
 *
 * Erro de rede, do provedor ou do Storage: a tentativa é contada e a ligação
 * volta para a fila com espera crescente (`ESPERAS_S`). Depois de
 * `MAX_TENTATIVAS`, ou de `PRAZO_TOTAL_MS` desde o pedido, a transcrição é dada
 * como perdida: o cartão diz, e a Central avisa (`phone_transcription_failed`).
 * Sem chave do transcritor, a Central é avisada na PRIMEIRA vez — quem cadastra a
 * chave em seguida ainda pega a ligação na tentativa seguinte.
 *
 * O RESUMO que falha não derruba a transcrição: o texto do transcritor é
 * guardado sem resumo e sem indicação de quem falou.
 *
 * Nenhuma linha de log leva o texto da ligação.
 *
 * Banco, Storage, transcritor e modelo de conversa entram como PORTAS: o teste
 * troca os quatro por dublês e exercita o caminho inteiro sem rede.
 */
import type pg from "pg";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { apiTranscriptionWithSegments, type TranscricaoComTrechos } from "@/lib/messaging/media/transcription";
import { storagePathFor } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { chaveDoTranscritor, configDeIaDoAmbiente } from "@/lib/telefonia/chave-do-transcritor";
import { BUCKET_DAS_GRAVACOES, MIME_DA_GRAVACAO } from "@/lib/telefonia/gravacao";
import { blocosDeTrechos, lerRespostaDoResumo, montarPedidoDoResumo } from "@/lib/telefonia/resumo-da-ligacao";
import { textoCorrido, type QuemFalou, type TrechoDaTranscricao } from "@/lib/telefonia/transcricao";

import type { Registro } from "./controle";
import { comPrazo } from "./gravacoes";
import * as repo from "./repositorio-das-transcricoes";
import type { ContextoDaTranscricao, TranscricaoPendente } from "./repositorio-das-transcricoes";

/** Quantas vezes se tenta antes de dar a transcrição como perdida. */
export const MAX_TENTATIVAS = 5;
/** Quanto se espera depois da 1ª, 2ª, 3ª e 4ª falha (segundos). */
export const ESPERAS_S = [60, 300, 900, 3_600] as const;
/** Depois disto desde o pedido, não se tenta mais — mesmo com tentativas sobrando. */
export const PRAZO_TOTAL_MS = 24 * 3_600_000;
/**
 * Por quanto tempo a ligação fica reservada enquanto é transcrita. Maior que a
 * soma dos prazos abaixo: se o worker cair no meio, é depois disto que outra
 * passada a pega de novo.
 */
export const RESERVA_S = 45 * 60;
export const PRAZO_DO_DOWNLOAD_MS = 2 * 60_000;
/** A ligação de 2 h (o teto da gravação) transcreve em poucos minutos; isto é folga. */
export const PRAZO_DO_TRANSCRITOR_MS = 20 * 60_000;
/** Por bloco de trechos (a ligação comum tem um bloco só). */
export const PRAZO_DO_RESUMO_MS = 2 * 60_000;

/** Quantas pendentes uma passada faz, em série. */
const LOTE_DA_PASSADA = 3;
/** Quantos pedidos perdidos uma passada repõe. */
const LOTE_DOS_PEDIDOS = 20;

/** O ponto de IA do transcritor — o `purpose` da linha em `llm_calls`. */
export const PONTO_DO_TRANSCRITOR = "transcricao_de_ligacao";
/** O modelo do transcritor (o mesmo do áudio do WhatsApp). */
export const MODELO_DO_TRANSCRITOR = "whisper-1";
/**
 * US$ 0,006 por minuto de áudio — o preço público do `whisper-1` na OpenAI,
 * conferido em 2026-10. É estimativa para a tela de Execuções: a fatura da
 * OpenAI é a fonte.
 */
export const CENTAVOS_POR_MINUTO_DO_TRANSCRITOR = 0.6;

export interface BancoDaTranscricao {
  pedir(org: string, vcId: string): Promise<boolean>;
  pedirAsQueFaltam(limite: number): Promise<number>;
  reservar(limite: number, reservaS: number): Promise<TranscricaoPendente[]>;
  reservarUma(org: string, vcId: string, reservaS: number): Promise<TranscricaoPendente | null>;
  contexto(org: string, vcId: string): Promise<ContextoDaTranscricao | null>;
  concluir(p: Parameters<typeof repo.concluirTranscricao>[1]): Promise<"gravada" | "descartada">;
  reagendar(org: string, vcId: string, esperaS: number, erro: string): Promise<void>;
  falhar(org: string, vcId: string, erro: string, aviso: { titulo: string; corpo: string }): Promise<boolean>;
  avisar(org: string, aviso: { titulo: string; corpo: string }): Promise<void>;
  descartar(org: string, vcId: string): Promise<void>;
  registrarUso(p: Parameters<typeof repo.registrarUsoDoTranscritor>[1]): Promise<void>;
}

export interface ArquivoDaGravacao {
  /** O MP3 da gravação. Lança se o Storage não entregar. */
  baixar(caminho: string): Promise<Buffer>;
}

export interface TranscritorDaLigacao {
  /** A chave do serviço de transcrição desta organização. `null` = não há chave cadastrada. */
  chave(org: string): Promise<string | null>;
  transcrever(chave: string, audio: Buffer, lingua: string): Promise<TranscricaoComTrechos>;
}

export interface ResumidorDaLigacao {
  /** Uma ida ao modelo de conversa (ponto `resumo_de_ligacao`). Lança se não conseguir. */
  perguntar(org: string, pedido: { system: string; user: string }): Promise<string>;
}

export interface PortasDaTranscricao {
  banco: BancoDaTranscricao;
  arquivo: ArquivoDaGravacao;
  transcritor: TranscritorDaLigacao;
  resumidor: ResumidorDaLigacao;
  log: Registro;
  agora?: () => Date;
  /** Para o teste encurtar: os prazos de cada passo lento. */
  prazos?: { downloadMs?: number; transcritorMs?: number; resumoMs?: number };
}

/** O que aconteceu ao processar uma transcrição — para o log e para os testes. */
export type DesfechoDaTranscricao = "pronta" | "sem_fala" | "descartada" | "adiada" | "falhou" | "em_curso";

const SEM_CHAVE = "sem_chave";

/** O código da língua que o transcritor espera (ISO 639-1). */
const LINGUA: Record<Idioma, string> = { "pt-BR": "pt", es: "es" };

/**
 * A CLASSE do erro, para `last_error` e para o log — nunca a mensagem crua: a de
 * um provedor pode ecoar o pedido, e o pedido é a conversa do cliente. Só passam
 * os códigos que este módulo mesmo escreve (`transcription_429`,
 * `download_sem_resposta`, `storage_download`).
 */
export function classeDoErro(e: unknown): string {
  if (typeof e === "string") return /^[a-z_]+(_\d{3})?$/.test(e) ? e : "erro";
  if (e instanceof Error) {
    if (/^[a-z_]+(_\d{3})?$/.test(e.message)) return e.message;
    return e.name || "erro";
  }
  return "erro";
}

/** Os avisos da Central, no idioma da organização. */
export function avisoSemChave(idioma: Idioma): { titulo: string; corpo: string } {
  return {
    titulo: traduzir("A transcrição das ligações está sem chave", idioma),
    corpo: traduzir(
      "As ligações gravadas não estão sendo transcritas: falta uma chave da OpenAI. Cadastre a chave em Agente de IA → Provedores, ou desligue a transcrição em Conexões → Telefone → Gravação. As gravações continuam sendo guardadas normalmente.",
      idioma,
    ),
  };
}

export function avisoDeFalha(idioma: Idioma): { titulo: string; corpo: string } {
  return {
    titulo: traduzir("A transcrição de uma ligação não saiu", idioma),
    corpo: traduzir(
      "A ligação foi gravada normalmente, mas o serviço de transcrição falhou em todas as tentativas. Confira a chave e o saldo da OpenAI em Agente de IA → Provedores. As próximas ligações seguem sendo transcritas.",
      idioma,
    ),
  };
}

const ms = (segundos: number) => Math.max(0, Math.round(segundos * 1000));

export class TranscricoesDaTelefonia {
  private readonly emCurso = new Set<string>();
  /** UMA transcrição por vez: várias ligações terminando juntas não abrem N downloads e N pedidos ao provedor. */
  private serie: Promise<unknown> = Promise.resolve();
  private readonly agora: () => Date;

  constructor(private readonly p: PortasDaTranscricao) {
    this.agora = p.agora ?? (() => new Date());
  }

  /**
   * A gravação desta ligação acabou de ser guardada: pede a transcrição (se a
   * organização ligou) e a faz em seguida. NUNCA lança — quem chama é o
   * processamento da gravação, que não pode falhar por causa disto.
   */
  aoGuardar(org: string, vcId: string): void {
    void (async () => {
      try {
        if (!(await this.p.banco.pedir(org, vcId))) return;
        const t = await this.p.banco.reservarUma(org, vcId, RESERVA_S);
        if (t) await this.processar(t);
      } catch (e) {
        this.p.log.warn("telefonia: transcrição não pedida agora — a passada a pega", {
          voice_call: vcId,
          erro: classeDoErro(e),
        });
      }
    })();
  }

  /** A passada (a cada 60 s): repõe o pedido que se perdeu e faz as pendentes da vez, em série. */
  async passada(): Promise<void> {
    const novas = await this.p.banco.pedirAsQueFaltam(LOTE_DOS_PEDIDOS);
    if (novas > 0) this.p.log.info("telefonia: transcrições pedidas pela passada", { ligacoes: novas });
    for (const t of await this.p.banco.reservar(LOTE_DA_PASSADA, RESERVA_S)) await this.processar(t);
  }

  /** Transcreve UMA ligação reservada. Nunca lança: o que falha é reagendado, até o limite. */
  async processar(t: TranscricaoPendente): Promise<DesfechoDaTranscricao> {
    if (this.emCurso.has(t.vcId)) return "em_curso";
    this.emCurso.add(t.vcId);
    try {
      const vez = this.serie.then(() => this.processarAgora(t));
      this.serie = vez.catch(() => undefined);
      return await vez;
    } catch (e) {
      // Só chega aqui o que nem o reagendamento conseguiu registrar (o banco
      // fora): a reserva vence sozinha e a passada pega de novo.
      this.p.log.warn("telefonia: transcrição interrompida — volta para a fila quando a reserva vencer", {
        voice_call: t.vcId,
        erro: classeDoErro(e),
      });
      return "adiada";
    } finally {
      this.emCurso.delete(t.vcId);
    }
  }

  private async processarAgora(t: TranscricaoPendente): Promise<DesfechoDaTranscricao> {
    const { organizationId: org, vcId } = t;
    const ctx = await this.p.banco.contexto(org, vcId);
    const caminho = ctx ? this.arquivoDaLigacao(org, ctx) : null;
    if (!ctx || !ctx.ligada || ctx.anonimizado || ctx.gravacao !== "stored" || !caminho) {
      // A organização desligou, o contato foi anonimizado, a gravação venceu ou
      // o arquivo não é o da gravação: nada vai ao provedor, e o pedido sai.
      await this.p.banco.descartar(org, vcId);
      this.p.log.info("telefonia: transcrição descartada — o pedido deixou de valer", { voice_call: vcId });
      return "descartada";
    }

    const chave = await this.p.transcritor.chave(org);
    if (chave === null) {
      await this.p.banco.avisar(org, avisoSemChave(ctx.idioma));
      return await this.adiarOuFalhar(t, SEM_CHAVE, ctx);
    }

    let audio: Buffer;
    try {
      audio = await comPrazo(
        () => this.p.arquivo.baixar(caminho),
        this.p.prazos?.downloadMs ?? PRAZO_DO_DOWNLOAD_MS,
        "download_sem_resposta",
      );
    } catch (e) {
      return await this.adiarOuFalhar(t, classeDoErro(e), ctx);
    }

    const inicio = this.agora().getTime();
    let transcrito: TranscricaoComTrechos;
    try {
      transcrito = await comPrazo(
        () => this.p.transcritor.transcrever(chave, audio, LINGUA[ctx.idioma]),
        this.p.prazos?.transcritorMs ?? PRAZO_DO_TRANSCRITOR_MS,
        "transcricao_sem_resposta",
      );
    } catch (e) {
      const erro = classeDoErro(e);
      await this.registrarUso(org, ctx, { latenciaMs: this.agora().getTime() - inicio, segundos: null, erro });
      return await this.adiarOuFalhar(t, erro, ctx);
    }
    await this.registrarUso(org, ctx, {
      latenciaMs: this.agora().getTime() - inicio,
      segundos: transcrito.durationSeconds,
      erro: null,
    });

    const trechos: TrechoDaTranscricao[] = transcrito.segments
      .map((s) => ({ inicio_ms: ms(s.start), fim_ms: ms(s.end), quem: null as QuemFalou | null, texto: s.text.trim() }))
      .filter((s) => s.texto !== "");
    const duracaoMs = transcrito.durationSeconds !== null ? ms(transcrito.durationSeconds) : null;
    const comum = { organizationId: org, vcId, idioma: transcrito.language, modelo: MODELO_DO_TRANSCRITOR, duracaoMs };

    if (trechos.length === 0) {
      const r = await this.p.banco.concluir({ ...comum, estado: "empty", texto: null, trechos: [], resumo: null });
      this.p.log.info("telefonia: ligação transcrita — sem fala", { voice_call: vcId, desfecho: r });
      return r === "gravada" ? "sem_fala" : "descartada";
    }

    const { resumo, marcados } = await this.resumir(org, vcId, ctx, trechos);
    const r = await this.p.banco.concluir({ ...comum, estado: "ready", texto: textoCorrido(trechos), trechos, resumo });
    this.p.log.info("telefonia: ligação transcrita", {
      voice_call: vcId,
      desfecho: r,
      trechos: trechos.length,
      com_quem_falou: marcados,
      com_resumo: resumo !== null,
    });
    return r === "gravada" ? "pronta" : "descartada";
  }

  /**
   * O arquivo SÓ é o da gravação se for EXATAMENTE `<org>/<conversa>/<mensagem>.mp3`
   * — a mesma conferência da rota da escuta e da poda. Um ponteiro trocado não
   * manda outro objeto do bucket ao provedor.
   */
  private arquivoDaLigacao(org: string, ctx: ContextoDaTranscricao): string | null {
    if (!ctx.caminho || !ctx.mensagemId || !ctx.conversationId) return null;
    return ctx.caminho === storagePathFor(org, ctx.conversationId, ctx.mensagemId, MIME_DA_GRAVACAO) ? ctx.caminho : null;
  }

  /**
   * O resumo e quem falou cada trecho — preenche `quem` nos próprios trechos.
   * NUNCA lança: sem resposta do modelo, a transcrição segue sem resumo e sem
   * indicação de quem falou.
   *
   * Numa ligação longa (mais de um bloco), o resumo só vale se TODOS os blocos
   * o devolverem: um resumo que cobre só o começo, apresentado como o da
   * ligação, seria pior que não ter. A indicação de quem falou não tem esse
   * problema — vale por trecho —, e fica com o que foi marcado.
   */
  private async resumir(
    org: string,
    vcId: string,
    ctx: ContextoDaTranscricao,
    trechos: TrechoDaTranscricao[],
  ): Promise<{ resumo: string | null; marcados: number }> {
    const blocos = blocosDeTrechos(trechos.length);
    let resumo: string | null = null;
    let resumoPerdido = false;
    let marcados = 0;
    for (const [i, b] of blocos.entries()) {
      const pedido = montarPedidoDoResumo({
        empresa: ctx.empresa,
        sentido: ctx.sentido,
        idioma: ctx.idioma,
        primeiro: b.inicio + 1,
        trechos: trechos.slice(b.inicio, b.fim).map((t) => t.texto),
        resumoAteAqui: i === 0 || resumoPerdido ? null : resumo,
        temMais: i < blocos.length - 1,
      });
      let resposta: string;
      try {
        resposta = await comPrazo(
          () => this.p.resumidor.perguntar(org, pedido),
          this.p.prazos?.resumoMs ?? PRAZO_DO_RESUMO_MS,
          "resumo_sem_resposta",
        );
      } catch (e) {
        // O modelo não respondeu: não se insiste nos blocos seguintes.
        this.p.log.warn("telefonia: o resumo da ligação não saiu — a transcrição segue sem ele", {
          voice_call: vcId,
          erro: classeDoErro(e),
        });
        return { resumo: null, marcados };
      }
      const lido = lerRespostaDoResumo(resposta, { primeiro: b.inicio + 1, quantos: b.fim - b.inicio });
      lido.quem.forEach((q, k) => {
        const alvo = trechos[b.inicio + k];
        if (alvo) alvo.quem = q;
      });
      marcados += lido.marcados;
      if (lido.resumo === null) resumoPerdido = true;
      else resumo = lido.resumo;
    }
    return { resumo: resumoPerdido ? null : resumo, marcados };
  }

  private async adiarOuFalhar(t: TranscricaoPendente, erro: string, ctx: ContextoDaTranscricao): Promise<DesfechoDaTranscricao> {
    const idade = this.agora().getTime() - t.pedidaEm.getTime();
    const esgotou = t.tentativas + 1 >= MAX_TENTATIVAS || idade >= PRAZO_TOTAL_MS;
    if (!esgotou) {
      const espera = ESPERAS_S[Math.min(t.tentativas, ESPERAS_S.length - 1)] ?? 3_600;
      await this.p.banco.reagendar(t.organizationId, t.vcId, espera, erro);
      this.p.log.warn("telefonia: transcrição não saiu — tenta de novo", {
        voice_call: t.vcId,
        erro,
        tentativa: t.tentativas + 1,
        espera_s: espera,
      });
      return "adiada";
    }
    const aviso = erro === SEM_CHAVE ? avisoSemChave(ctx.idioma) : avisoDeFalha(ctx.idioma);
    if (await this.p.banco.falhar(t.organizationId, t.vcId, erro, aviso)) {
      this.p.log.warn("telefonia: transcrição perdida", { voice_call: t.vcId, erro, tentativas: t.tentativas + 1 });
    }
    return "falhou";
  }

  /** A linha em `llm_calls`. Best-effort: a telemetria não derruba a transcrição que ela descreve. */
  private async registrarUso(
    org: string,
    ctx: ContextoDaTranscricao,
    u: { latenciaMs: number; segundos: number | null; erro: string | null },
  ): Promise<void> {
    try {
      await this.p.banco.registrarUso({
        organizationId: org,
        contactId: ctx.contactId,
        proposito: PONTO_DO_TRANSCRITOR,
        modelo: MODELO_DO_TRANSCRITOR,
        // Sem a duração não há como estimar: nulo, nunca zero.
        custoCents: u.segundos !== null ? (u.segundos / 60) * CENTAVOS_POR_MINUTO_DO_TRANSCRITOR : null,
        latenciaMs: u.latenciaMs,
        erro: u.erro,
      });
    } catch {
      /* a telemetria é o que menos importa aqui */
    }
  }
}

// ─── as portas de verdade (o worker) ─────────────────────────────────────────

/** As transcrições do worker: o pool do worker, o Storage da instalação, o transcritor e o modelo de conversa da organização. */
export function transcricoesDoWorker(pool: pg.Pool, log: Registro): TranscricoesDaTelefonia {
  const admin = createAdminClient();
  return new TranscricoesDaTelefonia({
    banco: {
      pedir: (org, id) => repo.pedirTranscricao(pool, org, id),
      pedirAsQueFaltam: (limite) => repo.pedirAsQueFaltam(pool, limite),
      reservar: (limite, reservaS) => repo.reservarPendentes(pool, limite, reservaS),
      reservarUma: (org, id, reservaS) => repo.reservarUma(pool, org, id, reservaS),
      contexto: (org, id) => repo.contextoDaTranscricao(pool, org, id),
      concluir: (p) => repo.concluirTranscricao(pool, p),
      reagendar: (org, id, esperaS, erro) => repo.reagendarTranscricao(pool, org, id, esperaS, erro),
      falhar: (org, id, erro, aviso) => repo.falharTranscricao(pool, org, id, erro, aviso),
      avisar: (org, aviso) => repo.avisarNaCentral(pool, org, aviso),
      descartar: (org, id) => repo.descartarTranscricao(pool, org, id),
      registrarUso: (p) => repo.registrarUsoDoTranscritor(pool, p),
    },
    arquivo: {
      async baixar(caminho) {
        const { data, error } = await admin.storage.from(BUCKET_DAS_GRAVACOES).download(caminho);
        if (error || !data) throw new Error("storage_download");
        return Buffer.from(await data.arrayBuffer());
      },
    },
    transcritor: {
      chave: (org) => chaveDoTranscritor(pool, org),
      // O ponto de IA `transcricao_de_ligacao`: transcreverGravacao( — o áudio da
      // ligação vai ao serviço de transcrição, e volta em trechos com tempo.
      transcrever: (chave, audio, lingua) => transcreverGravacao(chave, audio, lingua),
    },
    resumidor: {
      async perguntar(org, pedido) {
        const { result } = await runModelCall(
          pool,
          configDeIaDoAmbiente(),
          {
            tenantId: org,
            purpose: "resumo_de_ligacao",
            system: pedido.system,
            messages: [{ role: "user", content: pedido.user }],
          },
          { log },
        );
        return result.text;
      },
    },
    log,
  });
}

/** O MP3 da ligação no transcritor, com o prazo do próprio pedido de rede. */
export function transcreverGravacao(chave: string, audio: Buffer, lingua: string): Promise<TranscricaoComTrechos> {
  return apiTranscriptionWithSegments({ apiKey: chave, model: MODELO_DO_TRANSCRITOR }).transcribe(audio, MIME_DA_GRAVACAO, {
    language: lingua,
    signal: AbortSignal.timeout(PRAZO_DO_TRANSCRITOR_MS),
  });
}
