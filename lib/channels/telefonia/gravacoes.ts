/**
 * AS GRAVAÇÕES DAS LIGAÇÕES NO WORKER (F3, DYD-53; desenho
 * docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md).
 *
 * Duas metades:
 *  - a PORTA do controlador (`PortaGravacao`, controle.ts): a política da
 *    organização, começar a gravar a ponte (a ARI grava, o banco marca
 *    `recording`), tocar o aviso na ponte, parar no fim e pedir o processamento;
 *  - o PROCESSAMENTO, fora da fila serial dos eventos: baixar o WAV pela ARI →
 *    converter para MP3 (ffmpeg) → subir ao Storage como mídia da mensagem da
 *    ligação → anexar (a mensagem aponta o arquivo e a ligação vira `stored`) →
 *    apagar o WAV do Asterisk.
 *
 * O processamento corre logo depois do fim (`aoEncerrar`) e, para o que ficou
 * para trás (worker reiniciado, Storage fora), na passada de 60 s do telefone.
 * 30 min depois do fim sem conseguir, a gravação é dada como perdida: o cartão
 * diz, e a Central avisa (`phone_recording_failed`) — ninguém fica achando que
 * há um áudio que não há.
 *
 * ARI, banco, Storage e conversor entram como PORTAS: o teste troca os quatro
 * por dublês e exercita o caminho inteiro sem Asterisk, Postgres nem ffmpeg.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type pg from "pg";

import { storagePathFor } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BUCKET_DAS_GRAVACOES,
  MIME_DA_GRAVACAO,
  PRAZO_TOTAL_DA_GRAVACAO_MS,
  TETO_DA_GRAVACAO_S,
  destinoSemArquivo,
  duracaoDoWavMs,
  nomeNoAsterisk,
  vcIdDoNome,
  type EstadoDaGravacao,
} from "@/lib/telefonia/gravacao";

import type { ClienteAri } from "./ari";
import type { PortaGravacao, Registro } from "./controle";
import * as repo from "./repositorio-das-gravacoes";
import type { GravacaoPendente, PoliticaDeGravacao } from "./repositorio-das-gravacoes";

/** Quantas pendentes uma passada processa, em série (uma conversão por vez no worker de 512 MB). */
const LOTE_DA_PASSADA = 5;

/** Espera entre o fim da ligação e o primeiro processamento (o arquivo fecha no `stop`). */
const ESPERA_DO_PRIMEIRO_PROCESSAMENTO_MS = 1_000;

export interface AriDaGravacao {
  gravarPonte(ponte: string, nome: string, tetoS: number): Promise<unknown>;
  pararGravacao(nome: string): Promise<void>;
  tocarNaPonte(ponte: string, midia: string): Promise<unknown>;
  baixarGravacao(nome: string, destino: string): Promise<{ bytes: number } | "ausente">;
  apagarGravacao(nome: string): Promise<void>;
  listarGravacoes(): Promise<string[]>;
}

export interface BancoDaGravacao {
  politica(org: string): Promise<PoliticaDeGravacao>;
  marcarGravando(org: string, vcId: string, avisoEm: Date): Promise<boolean>;
  pendentes(limite: number): Promise<GravacaoPendente[]>;
  mensagemDaLigacao(org: string, vcId: string): Promise<{ id: string; conversationId: string } | null>;
  anexar(p: Parameters<typeof repo.anexarGravacao>[1]): Promise<"anexada" | "anonimizada">;
  falhar(org: string, vcId: string): Promise<boolean>;
  descartar(org: string, vcId: string): Promise<void>;
  estados(vcIds: string[]): Promise<Map<string, EstadoDaGravacao | null>>;
}

export interface StorageDaGravacao {
  subir(caminho: string, arquivoLocal: string, mime: string): Promise<void>;
  apagar(caminho: string): Promise<void>;
}

export interface ConversorDaGravacao {
  /** WAV do Asterisk → MP3 mono 16 kHz 24 kbps. Lança se não conseguir. */
  converter(entrada: string, saida: string): Promise<void>;
}

export interface PortasDaGravacao {
  ari: AriDaGravacao;
  banco: BancoDaGravacao;
  storage: StorageDaGravacao;
  conversor: ConversorDaGravacao;
  log: Registro;
  agora?: () => Date;
}

/** O que aconteceu ao processar uma gravação — para o log e para os testes. */
export type DesfechoDoProcessamento = "anexada" | "anonimizada" | "esperando" | "perdida" | "em_curso";

/** Os estados em que a gravação já não vai ser guardada: o arquivo no Asterisk é lixo. */
const TERMINAIS: ReadonlySet<EstadoDaGravacao> = new Set<EstadoDaGravacao>(["stored", "failed", "expired"]);

const mensagemDe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class GravacoesDaTelefonia implements PortaGravacao {
  private readonly emCurso = new Set<string>();
  /** As que já tiveram a falha registrada no log: tentar de novo a cada minuto não repete a linha. */
  private readonly jaAvisadas = new Set<string>();
  private readonly agora: () => Date;

  constructor(private readonly p: PortasDaGravacao) {
    this.agora = p.agora ?? (() => new Date());
  }

  // ─── a porta do controlador ──────────────────────────────────────────────

  politica(org: string): Promise<PoliticaDeGravacao> {
    return this.p.banco.politica(org);
  }

  /**
   * A ARI grava PRIMEIRO, e só então o banco marca: marcar antes deixaria uma
   * ligação `recording` sem arquivo, que 2 min depois viraria "a gravação não
   * foi salva" na Central — um alarme sobre algo que nunca existiu. Se o banco
   * não marca, a gravação é parada e apagada: ninguém a guardaria.
   */
  async comecar(q: { org: string; vcId: string; ponte: string; avisoEm: Date }): Promise<boolean> {
    const nome = nomeNoAsterisk(q.vcId);
    await this.p.ari.gravarPonte(q.ponte, nome, TETO_DA_GRAVACAO_S);
    try {
      if (await this.p.banco.marcarGravando(q.org, q.vcId, q.avisoEm)) {
        this.p.log.info("telefonia: gravando a ligação", { voice_call: q.vcId });
        return true;
      }
    } catch (e) {
      this.p.log.warn("telefonia: gravação não marcada no banco — descartada", { voice_call: q.vcId, erro: mensagemDe(e) });
    }
    await this.p.ari.pararGravacao(nome).catch(() => undefined);
    await this.p.ari.apagarGravacao(nome).catch(() => undefined);
    return false;
  }

  async tocarAvisoNaPonte(ponte: string, midia: string): Promise<boolean> {
    await this.p.ari.tocarNaPonte(ponte, midia);
    return true;
  }

  async parar(vcId: string): Promise<void> {
    await this.p.ari.pararGravacao(nomeNoAsterisk(vcId));
  }

  aoEncerrar(org: string, vcId: string): void {
    const fimEm = this.agora();
    setTimeout(() => {
      void this.processar({ vcId, organizationId: org, fimEm }).catch((e) =>
        this.p.log.error("telefonia: processamento da gravação falhou", { voice_call: vcId, erro: mensagemDe(e) }),
      );
    }, ESPERA_DO_PRIMEIRO_PROCESSAMENTO_MS);
  }

  // ─── o processamento ─────────────────────────────────────────────────────

  /** Guarda UMA gravação. Nunca lança: o que falha é tentado de novo, até o prazo. */
  async processar(g: GravacaoPendente): Promise<DesfechoDoProcessamento> {
    if (this.emCurso.has(g.vcId)) return "em_curso";
    this.emCurso.add(g.vcId);
    const idade = () => this.agora().getTime() - g.fimEm.getTime();
    let dir: string | null = null;
    try {
      const msg = await this.p.banco.mensagemDaLigacao(g.organizationId, g.vcId);
      if (!msg) {
        // O fim ainda não foi registrado na conversa (ou nunca vai ser).
        return idade() >= PRAZO_TOTAL_DA_GRAVACAO_MS ? await this.perder(g, "sem_mensagem") : "esperando";
      }
      dir = await mkdtemp(join(tmpdir(), "gravacao-"));
      const wav = join(dir, "g.wav");
      const mp3 = join(dir, "g.mp3");
      const nome = nomeNoAsterisk(g.vcId);
      const baixado = await this.p.ari.baixarGravacao(nome, wav);
      if (baixado === "ausente") {
        return destinoSemArquivo({ fimEm: g.fimEm, agora: this.agora() }) === "falhar"
          ? await this.perder(g, "arquivo_ausente")
          : "esperando";
      }
      await this.p.conversor.converter(wav, mp3);
      const bytes = (await stat(mp3)).size;
      const caminho = storagePathFor(g.organizationId, msg.conversationId, msg.id, MIME_DA_GRAVACAO);
      await this.p.storage.subir(caminho, mp3, MIME_DA_GRAVACAO);
      const r = await this.p.banco.anexar({
        organizationId: g.organizationId,
        vcId: g.vcId,
        mensagemId: msg.id,
        caminho,
        bytes,
        duracaoMs: duracaoDoWavMs(baixado.bytes),
      });
      if (r === "anonimizada") {
        // A conversa foi anonimizada no meio do caminho: o arquivo recém-subido
        // não pode ficar sem dono no Storage.
        await this.p.storage.apagar(caminho).catch((e) =>
          this.p.log.warn("telefonia: gravação de conversa anonimizada não apagada do Storage", {
            voice_call: g.vcId,
            erro: mensagemDe(e),
          }),
        );
        await this.p.banco.descartar(g.organizationId, g.vcId);
      }
      // O WAV no Asterisk já não serve. Se o apagar falhar, a passada das órfãs o pega.
      await this.p.ari.apagarGravacao(nome).catch(() => undefined);
      this.jaAvisadas.delete(g.vcId);
      this.p.log.info("telefonia: gravação guardada", { voice_call: g.vcId, desfecho: r, bytes });
      return r;
    } catch (e) {
      if (idade() >= PRAZO_TOTAL_DA_GRAVACAO_MS) return await this.perder(g, mensagemDe(e));
      if (!this.jaAvisadas.has(g.vcId)) {
        this.jaAvisadas.add(g.vcId);
        this.p.log.warn("telefonia: gravação não guardada — tenta de novo a cada minuto", {
          voice_call: g.vcId,
          erro: mensagemDe(e),
        });
      }
      return "esperando";
    } finally {
      this.emCurso.delete(g.vcId);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async perder(g: GravacaoPendente, motivo: string): Promise<DesfechoDoProcessamento> {
    this.jaAvisadas.delete(g.vcId);
    try {
      if (await this.p.banco.falhar(g.organizationId, g.vcId)) {
        this.p.log.warn("telefonia: gravação perdida", { voice_call: g.vcId, motivo });
      }
    } catch (e) {
      // O banco fora: a próxima passada tenta de novo (a ligação segue `recording`).
      this.p.log.warn("telefonia: gravação perdida, mas não marcada", { voice_call: g.vcId, erro: mensagemDe(e) });
      return "esperando";
    }
    await this.p.ari.apagarGravacao(nomeNoAsterisk(g.vcId)).catch(() => undefined);
    return "perdida";
  }

  /**
   * A passada (a cada 60 s, fora da fila serial): as pendentes, em série, e
   * depois as órfãs — arquivos `g-<id>` no Asterisk cuja ligação já está num
   * estado TERMINAL (guardada, perdida, expirada). Nunca apaga o de ligação
   * `recording` nem o de ligação desconhecida: um arquivo pode existir um
   * instante antes de o banco marcar a ligação (`comecar`).
   */
  async passada(): Promise<void> {
    const pendentes = await this.p.banco.pendentes(LOTE_DA_PASSADA);
    for (const g of pendentes) await this.processar(g);
    await this.limparOrfas();
  }

  private async limparOrfas(): Promise<void> {
    const porId = new Map<string, string>();
    for (const nome of await this.p.ari.listarGravacoes()) {
      const id = vcIdDoNome(nome);
      if (id && !this.emCurso.has(id)) porId.set(id, nome);
    }
    if (porId.size === 0) return;
    const estados = await this.p.banco.estados([...porId.keys()]);
    for (const [id, nome] of porId) {
      const estado = estados.get(id);
      if (!estado || !TERMINAIS.has(estado)) continue;
      await this.p.ari
        .apagarGravacao(nome)
        .catch((e) => this.p.log.warn("telefonia: gravação órfã não apagada", { voice_call: id, erro: mensagemDe(e) }));
    }
  }
}

// ─── as portas de verdade (o worker) ─────────────────────────────────────────

/** Roda ffmpeg; rejeita com a cauda do stderr se sair diferente de zero. */
function rodarFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2_000);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg_spawn_failed: ${err.message}`)));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}: ${stderr.slice(-200)}`))));
  });
}

/**
 * MP3 mono 16 kHz, 24 kbps (~180 KB por minuto): toca em qualquer navegador e
 * em qualquer computador (o cliente pode pedir a gravação), e 16 kHz é a taxa
 * que a transcrição usa. O WAV do Asterisk é 8 kHz: subir a taxa não inventa
 * som, mas põe o MP3 no MPEG-2, que todo decodificador lê (o MPEG-2.5 de 8 kHz não).
 */
export const conversorFfmpeg: ConversorDaGravacao = {
  converter: (entrada, saida) =>
    rodarFfmpeg(["-i", entrada, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "24k", saida]),
};

function storageDaInstalacao(): StorageDaGravacao {
  const admin = createAdminClient();
  const bucket = () => admin.storage.from(BUCKET_DAS_GRAVACOES);
  return {
    async subir(caminho, arquivoLocal, mime) {
      const bytes = await readFile(arquivoLocal);
      const { error } = await bucket().upload(caminho, bytes, { contentType: mime, upsert: true });
      if (error) throw new Error(`storage_upload: ${error.message}`);
    },
    async apagar(caminho) {
      const { error } = await bucket().remove([caminho]);
      if (error) throw new Error(`storage_remove: ${error.message}`);
    },
  };
}

/** As gravações do worker: a ARI da telefonia, o pool do worker, o Storage da instalação e o ffmpeg da imagem. */
export function gravacoesDoWorker(pool: pg.Pool, ari: ClienteAri, log: Registro): GravacoesDaTelefonia {
  return new GravacoesDaTelefonia({
    ari: {
      gravarPonte: (p, n, t) => ari.gravarPonte(p, n, t),
      pararGravacao: (n) => ari.pararGravacao(n),
      tocarNaPonte: (p, m) => ari.tocarNaPonte(p, m),
      baixarGravacao: (n, d) => ari.baixarGravacao(n, d),
      apagarGravacao: (n) => ari.apagarGravacao(n),
      listarGravacoes: () => ari.listarGravacoes(),
    },
    banco: {
      politica: (org) => repo.politicaDeGravacao(pool, org),
      marcarGravando: (org, id, avisoEm) => repo.marcarGravando(pool, org, id, avisoEm),
      pendentes: (limite) => repo.gravacoesPendentes(pool, limite),
      mensagemDaLigacao: (org, id) => repo.mensagemDaLigacao(pool, org, id),
      anexar: (p) => repo.anexarGravacao(pool, p),
      falhar: (org, id) => repo.falharGravacao(pool, org, id),
      descartar: (org, id) => repo.descartarGravacao(pool, org, id),
      estados: (ids) => repo.estadosDasGravacoes(pool, ids),
    },
    storage: storageDaInstalacao(),
    conversor: conversorFfmpeg,
    log,
  });
}
