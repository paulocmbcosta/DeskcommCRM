/**
 * AS FALAS DO TELEFONE NO DISCO — do Storage para o volume que o Asterisk lê
 * (desenho da fase 2, §4 e D12).
 *
 * O Storage (bucket `phone-prompts`) é a fonte da verdade; o volume
 * `telefonia-falas` é cópia. O worker o monta com escrita, o Asterisk só com
 * leitura (docker-compose.prod.yml). Três caminhos:
 *   - a passada de 60 s (`sincronizar`): baixa as falas `ready` que faltam no
 *     volume — de TODAS as organizações, porque o worker serve a instalação
 *     inteira — e apaga do volume os arquivos que nenhuma linha referencia mais;
 *   - antes de tocar (`garantir`): o arquivo existe? se não, baixa na hora, com
 *     prazo curto (quem espera é alguém ao telefone). Não deu → `null`, e a
 *     ligação pula a fala (o controlador avisa na Central). Baixar do Storage
 *     nunca chama a ElevenLabs: este arquivo não alcança o cliente dela
 *     (tests/unit/ligacao-nunca-chama-elevenlabs.test.ts);
 *   - a limpeza do Storage (`limparStorage`, na mesma passada): a prévia que
 *     ninguém salvou e o áudio que nenhuma fala referencia saem do bucket 24 h
 *     depois de gravados (desenho §4, passo 4). O áudio do menu arquivado entra
 *     aqui: arquivar apaga as falas dele (lib/telefonia/menus.ts).
 *
 * A LIMPEZA DO STORAGE APAGA A FONTE DA VERDADE, e por isso é a parte com mais
 * trava: só objeto com mais de 24 h E sem referência; a referência é lida no
 * último instante — imediatamente antes de CADA `apagar`, lote a lote, e não no
 * começo da passada —; só caminhos `<org>/<hash>.ulaw` da pasta que está sendo
 * limpa (nunca uma pasta, nunca a organização inteira); e "bucket não existe"
 * aborta a passada sem apagar nada. A janela entre a leitura da referência e o
 * `apagar` (milissegundos) continua existindo: se uma fala `ready` perder o
 * objeto assim, o disco ainda tem a cópia; se nem ele tiver, a ligação pula a
 * fala e abre `phone_prompt_unplayable`, e salvar de novo conserta.
 *
 * Escrita ATÔMICA: temporário na MESMA pasta (o `rename` só é atômico dentro do
 * mesmo sistema de arquivos), `fsync`, e só então `rename` para o nome final — o
 * Asterisk nunca abre um arquivo pela metade, e uma queda no meio não deixa
 * arquivo truncado com o nome que `garantir` aceita como pronto. O nome é o hash
 * de texto + voz + modelo: um arquivo nunca muda de conteúdo, só nasce ou sai.
 *
 * Permissões 0644 (arquivo) e 0755 (pastas, a raiz do volume inclusive),
 * aplicadas com `chmod` para não depender do umask: o Asterisk roda como o
 * usuário `asterisk` (uid 100) e só lê; o worker roda como root. Medido na VPS de
 * produção no passo zero (Task 0 do plano da fase 2): o Asterisk 20.11.1 toca o
 * `.ulaw` cru pelo caminho ABSOLUTO, sem extensão.
 *
 * Memória (o worker já morreu por OOM): a lista de falas vem do banco em páginas
 * (`lote`), e os áudios são baixados UM POR VEZ na passada. O armazém devolve o
 * objeto inteiro (não há leitura em fluxo no `PortaDoArmazem`), então o teto é um
 * objeto por download em curso — o bucket limita cada um a 2 MB — e duas ligações
 * pedindo a mesma fala esperam o MESMO download.
 *
 * Isolamento: o banco é lido com a conexão do worker, sem RLS. A lista de falas
 * prontas é da instalação inteira (o worker serve todas as organizações); toda
 * pergunta "alguém usa este arquivo?" leva a organização da pasta — o CHECK
 * `phone_prompts_storage_path_check` amarra `storage_path` a
 * `organization_id/content_hash.ulaw`, então o filtro não esconde referência
 * nenhuma. O caminho no disco passa pela mesma régua do CHECK antes de virar
 * caminho de arquivo: nada de `..`.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { armazemDaInstalacao, comPrazoDeLeitura, type ObjetoDoArmazem, type PortaDoArmazem } from "@/lib/telefonia/armazem";

import type { Registro } from "./controle";
import type { FalaDoBanco } from "./repositorio";

/** Onde o worker escreve: o volume `telefonia-falas`, montado com escrita no serviço `worker`. */
export const DIRETORIO_DAS_FALAS = "/var/lib/deskcomm/falas";
/**
 * Como o Asterisk enxerga o MESMO volume (só leitura). Passo zero, ramo A:
 * caminho absoluto, no mesmo ponto de montagem do worker.
 */
export const DIRETORIO_NO_ASTERISK = "/var/lib/deskcomm/falas";

/** Arquivo recém-escrito não é órfão ainda: a fala pode ter nascido depois da leitura do banco. */
export const CARENCIA_DO_ORFAO_MS = 5 * 60_000;
/**
 * Prévia não salva e áudio sem uso saem do STORAGE 24 h depois de gravados
 * (desenho §4, passo 4). A janela é o que protege a prévia recém-gerada, que ainda
 * não tem linha em `phone_prompts`.
 */
export const JANELA_DO_STORAGE_MS = 24 * 3_600_000;
/** Quanto uma ligação espera o Storage antes de pular a fala. */
export const PRAZO_DO_GARANTIR_MS = 3_000;
/** Quanto a passada espera cada download: ninguém está ao telefone, mas a passada não pode travar. */
export const PRAZO_DA_PASSADA_MS = 20_000;
/** Linhas por página do banco, e caminhos por consulta de referência e por `apagar`. */
const LOTE = 100;
/** Falhas seguidas do Storage (não ausência) depois das quais a passada para de baixar até a próxima. */
const FALHAS_SEGUIDAS_ATE_DESISTIR = 3;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CAMINHO_VALIDO = new RegExp(`^${UUID}/[0-9a-f]{64}\\.ulaw$`);
const ORG_VALIDA = new RegExp(`^${UUID}$`);
const ARQUIVO_DE_FALA = /^[0-9a-f]{64}\.ulaw$/;
/** `.<hash>.<aleatório>.tmp` — o temporário da escrita atômica. */
const TEMPORARIO = /^\.[0-9a-f]{64}\.[0-9a-f]+\.tmp$/;

/** As falas prontas da INSTALAÇÃO, em páginas por `storage_path` (índice `phone_prompts_caminho_pronto`). */
const SQL_PRONTAS = `select distinct storage_path
   from phone_prompts
  where status = 'ready' and storage_path is not null and storage_path > $1
  order by storage_path
  limit $2`;
/** Dos caminhos dados, os que alguma linha DESTA organização referencia — em qualquer estado. */
const SQL_REFERENCIADOS = `select storage_path
   from phone_prompts
  where organization_id = $1::uuid and storage_path = any($2::text[])`;

/** A mesma régua do CHECK `phone_prompts_storage_path_check`: `<org>/<sha256>.ulaw`, nada de `..`. */
export function caminhoValido(storagePath: string): boolean {
  return CAMINHO_VALIDO.test(storagePath);
}

/**
 * O endereço que a ARI toca: `sound:` + caminho absoluto SEM a extensão (o
 * Asterisk escolhe o formato pelo arquivo). Lança com caminho fora da régua: um
 * endereço montado com `..` apontaria para fora do volume.
 */
export function midiaDaFala(storagePath: string): string {
  if (!caminhoValido(storagePath)) throw new Error("midiaDaFala: caminho de fala fora da régua");
  return `sound:${DIRETORIO_NO_ASTERISK}/${storagePath.slice(0, -".ulaw".length)}`;
}

export interface OpcoesDasFalasNoDisco {
  /** Relógio (ms). Padrão: `Date.now`. */
  agora?: () => number;
  /** Padrão: `PRAZO_DO_GARANTIR_MS`. */
  prazoDoGarantirMs?: number;
  /** Padrão: `PRAZO_DA_PASSADA_MS`. */
  prazoDaPassadaMs?: number;
  /** Padrão: 100. */
  lote?: number;
}

export interface ResultadoDaSincronizacao {
  baixadas: number;
  apagadas: number;
  falhas: number;
}

export interface ResultadoDaLimpeza {
  apagados: number;
  falhas: number;
}

export type ArmazemDasFalas = Pick<PortaDoArmazem, "baixar" | "listarPastas" | "listarObjetos" | "apagar">;

type Baixa = "gravada" | "ausente" | "falhou";

const motivo = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));

/** "Bucket not found" (todas as versões do Storage) ou `NoSuchBucket` — na mensagem que o armazém lança. */
function bucketAusente(e: unknown): boolean {
  return /bucket not found|NoSuchBucket/i.test(e instanceof Error ? e.message : String(e));
}

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

async function dentroDoPrazo<T>(promessa: Promise<T>, ms: number): Promise<T | "prazo"> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promessa, new Promise<"prazo">((r) => (relogio = setTimeout(() => r("prazo"), ms)))]);
  } finally {
    clearTimeout(relogio);
  }
}

export class FalasNoDisco {
  private readonly agora: () => number;
  private readonly prazoDoGarantirMs: number;
  private readonly prazoDaPassadaMs: number;
  private readonly lote: number;
  /** Download em curso por caminho: quem pede a mesma fala espera o MESMO download. */
  private readonly emCurso = new Map<string, Promise<Baixa>>();

  constructor(
    private readonly dir: string,
    private readonly db: Queryable,
    private readonly armazem: ArmazemDasFalas,
    private readonly log: Registro,
    opcoes: OpcoesDasFalasNoDisco = {},
  ) {
    this.agora = opcoes.agora ?? Date.now;
    this.prazoDoGarantirMs = opcoes.prazoDoGarantirMs ?? PRAZO_DO_GARANTIR_MS;
    this.prazoDaPassadaMs = opcoes.prazoDaPassadaMs ?? PRAZO_DA_PASSADA_MS;
    this.lote = Math.max(1, opcoes.lote ?? LOTE);
  }

  // ─── antes de tocar ────────────────────────────────────────────────────────

  /**
   * O endereço de mídia com o arquivo garantido no disco, ou `null` (a ligação
   * pula a fala). Espera no máximo `prazoDoGarantirMs`: se o download já estava em
   * curso pela passada, desiste no próprio prazo e deixa o download terminar para
   * a próxima vez. Nunca lança.
   */
  async garantir(fala: FalaDoBanco): Promise<string | null> {
    try {
      if (!caminhoValido(fala.storagePath)) {
        this.log.warn("telefonia: caminho de fala fora da régua — não tocada", { fala: fala.id });
        return null;
      }
      if (await this.presente(fala.storagePath)) return midiaDaFala(fala.storagePath);
      const baixa = await dentroDoPrazo(this.baixarUmaVez(fala.storagePath, this.prazoDoGarantirMs), this.prazoDoGarantirMs);
      if (baixa === "gravada") return midiaDaFala(fala.storagePath);
      if (baixa === "prazo") {
        this.log.warn("telefonia: fala não chegou ao disco no prazo — pulada", { fala: fala.id, caminho: fala.storagePath });
      }
      return null;
    } catch (e) {
      this.log.warn("telefonia: fala não garantida no disco — pulada", { fala: fala.id, erro: motivo(e) });
      return null;
    }
  }

  // ─── a passada de 60 s ─────────────────────────────────────────────────────

  /** Baixa as prontas que faltam e apaga os órfãos velhos. Nunca lança. */
  async sincronizar(): Promise<ResultadoDaSincronizacao> {
    const r: ResultadoDaSincronizacao = { baixadas: 0, apagadas: 0, falhas: 0 };
    try {
      await this.pastaLegivel(this.dir);
    } catch (e) {
      r.falhas++;
      this.log.warn("telefonia: volume das falas inacessível", { erro: motivo(e) });
      return r;
    }
    await this.baixarAsQueFaltam(r);
    await this.apagarOrfaos(r);
    if (r.baixadas || r.apagadas || r.falhas) this.log.info("telefonia: falas sincronizadas no disco", { ...r });
    return r;
  }

  private async baixarAsQueFaltam(r: ResultadoDaSincronizacao): Promise<void> {
    let depois = "";
    let falhasSeguidas = 0;
    try {
      for (;;) {
        const { rows } = await this.db.query<{ storage_path: string }>(SQL_PRONTAS, [depois, this.lote]);
        for (const { storage_path: caminho } of rows) {
          if (!caminhoValido(caminho)) {
            r.falhas++;
            this.log.warn("telefonia: fala pronta com caminho fora da régua — ignorada", { caminho: caminho.slice(0, 200) });
            continue;
          }
          if (await this.presente(caminho)) continue;
          const baixa = await this.baixarUmaVez(caminho, this.prazoDaPassadaMs);
          if (baixa === "gravada") r.baixadas++;
          else r.falhas++;
          // Ausência é resposta do Storage (ele está de pé); falha é Storage fora ou disco cheio.
          falhasSeguidas = baixa === "falhou" ? falhasSeguidas + 1 : 0;
          if (falhasSeguidas >= FALHAS_SEGUIDAS_ATE_DESISTIR) {
            this.log.warn("telefonia: Storage ou disco falhando — o resto das falas fica para a próxima passada", { falhasSeguidas });
            return;
          }
        }
        if (rows.length < this.lote) return;
        depois = rows[rows.length - 1]!.storage_path;
      }
    } catch (e) {
      r.falhas++;
      this.log.warn("telefonia: não li as falas prontas do banco", { erro: motivo(e) });
    }
  }

  /**
   * Apaga do volume o arquivo de fala que nenhuma linha referencia (em qualquer
   * estado) e passou da carência, e o temporário largado por uma escrita que
   * caiu. Só nas pastas de organização e só nomes que este módulo escreve. Sem
   * banco não há como saber quem é órfão: a varredura para sem apagar.
   */
  private async apagarOrfaos(r: ResultadoDaSincronizacao): Promise<void> {
    let orgs: string[];
    try {
      orgs = (await readdir(this.dir)).filter((nome) => ORG_VALIDA.test(nome));
    } catch (e) {
      r.falhas++;
      this.log.warn("telefonia: não li o volume das falas", { erro: motivo(e) });
      return;
    }
    try {
      for (const org of orgs) {
        const pasta = join(this.dir, org);
        const nomes = await readdir(pasta).catch(() => [] as string[]);
        const agora = this.agora();
        const velhas: string[] = [];
        for (const nome of nomes) {
          const ehFala = ARQUIVO_DE_FALA.test(nome);
          if (!ehFala && !TEMPORARIO.test(nome)) continue;
          const info = await lstat(join(pasta, nome)).catch(() => null);
          if (!info?.isFile() || agora - info.mtimeMs < CARENCIA_DO_ORFAO_MS) continue;
          if (ehFala) velhas.push(nome);
          else if (await this.apagarDoDisco(join(pasta, nome))) r.apagadas++;
        }
        for (const lote of emLotes(velhas, this.lote)) {
          const usados = await this.referenciados(org, lote.map((nome) => `${org}/${nome}`));
          for (const nome of lote) {
            if (!usados.has(`${org}/${nome}`) && (await this.apagarDoDisco(join(pasta, nome)))) r.apagadas++;
          }
        }
      }
    } catch (e) {
      r.falhas++;
      this.log.warn("telefonia: não conferi os órfãos do volume — nada apagado a partir daqui", { erro: motivo(e) });
    }
  }

  // ─── a limpeza do Storage ──────────────────────────────────────────────────

  /**
   * Sai do bucket o objeto que nenhuma linha de `phone_prompts` referencia E foi
   * gravado há mais de 24 h. A referência é conferida imediatamente antes de CADA
   * `apagar`, com a organização da pasta. Só pastas de organização (uuid), só
   * caminhos na régua e da própria pasta. Bucket ausente ou banco fora abortam a
   * passada. Nunca lança.
   */
  async limparStorage(): Promise<ResultadoDaLimpeza> {
    const r: ResultadoDaLimpeza = { apagados: 0, falhas: 0 };
    const limite = this.agora() - JANELA_DO_STORAGE_MS;
    try {
      for (const org of await this.armazem.listarPastas()) {
        if (!ORG_VALIDA.test(org)) continue;
        let objetos: ObjetoDoArmazem[];
        try {
          objetos = await this.armazem.listarObjetos(org);
        } catch (e) {
          if (bucketAusente(e)) throw e;
          r.falhas++;
          this.log.warn("telefonia: não listei as falas do Storage", { organization_id: org, erro: motivo(e) });
          continue;
        }
        const candidatos = objetos
          .filter((o) => caminhoValido(o.caminho) && o.caminho.startsWith(`${org}/`) && o.criadoEm.getTime() < limite)
          .map((o) => o.caminho);
        for (const lote of emLotes(candidatos, this.lote)) {
          // A referência é lida AQUI, e não no começo da passada: um "Salvar e usar"
          // que reaproveitou este áudio há um instante tem de ser visto.
          const usados = await this.referenciados(org, lote);
          const semUso = lote.filter((c) => !usados.has(c));
          if (semUso.length === 0) continue;
          try {
            await this.armazem.apagar(semUso);
            r.apagados += semUso.length;
          } catch (e) {
            if (bucketAusente(e)) throw e;
            r.falhas++;
            this.log.warn("telefonia: não apaguei falas sem uso do Storage", { organization_id: org, erro: motivo(e) });
            break;
          }
        }
      }
    } catch (e) {
      r.falhas++;
      if (bucketAusente(e)) {
        this.log.error("telefonia: o bucket das falas não existe — limpeza do Storage abortada sem apagar nada", { erro: motivo(e) });
      } else {
        this.log.warn("telefonia: limpeza das falas no Storage abortada", { erro: motivo(e) });
      }
    }
    if (r.apagados || r.falhas) this.log.info("telefonia: limpeza das falas no Storage", { ...r });
    return r;
  }

  // ─── miúdos ────────────────────────────────────────────────────────────────

  private arquivo(storagePath: string): string {
    return join(this.dir, storagePath);
  }

  /** O arquivo está lá e não está vazio. */
  private async presente(storagePath: string): Promise<boolean> {
    try {
      const info = await stat(this.arquivo(storagePath));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  private async referenciados(org: string, caminhos: string[]): Promise<Set<string>> {
    const { rows } = await this.db.query<{ storage_path: string }>(SQL_REFERENCIADOS, [org, caminhos]);
    return new Set(rows.map((l) => l.storage_path));
  }

  private baixarUmaVez(storagePath: string, prazoMs: number): Promise<Baixa> {
    const emCurso = this.emCurso.get(storagePath);
    if (emCurso) return emCurso;
    const baixa = this.baixarParaODisco(storagePath, prazoMs).finally(() => this.emCurso.delete(storagePath));
    this.emCurso.set(storagePath, baixa);
    return baixa;
  }

  /** Storage → disco. Nunca lança: a falha vira `"falhou"`, a ausência `"ausente"`, e as duas vão ao log. */
  private async baixarParaODisco(storagePath: string, prazoMs: number): Promise<Baixa> {
    let bytes: Uint8Array | null;
    try {
      bytes = await comPrazoDeLeitura(this.armazem, prazoMs).baixar(storagePath);
    } catch (e) {
      this.log.warn("telefonia: o Storage não entregou a fala", { caminho: storagePath, erro: motivo(e) });
      return "falhou";
    }
    if (!bytes || bytes.length === 0) {
      this.log.warn("telefonia: fala pronta sem áudio no Storage", { caminho: storagePath });
      return "ausente";
    }
    try {
      await this.gravarAtomico(storagePath, bytes);
      return "gravada";
    } catch (e) {
      this.log.warn("telefonia: fala não gravada no disco", { caminho: storagePath, erro: motivo(e) });
      return "falhou";
    }
  }

  /** Temporário na mesma pasta, `fsync`, `rename`. Em qualquer falha o temporário sai e o nome final não aparece. */
  private async gravarAtomico(storagePath: string, bytes: Uint8Array): Promise<void> {
    const [org, nome] = storagePath.split("/") as [string, string];
    const pasta = join(this.dir, org);
    await this.pastaLegivel(this.dir);
    await this.pastaLegivel(pasta);
    const temporario = join(pasta, `.${nome.slice(0, 64)}.${randomBytes(6).toString("hex")}.tmp`);
    let alca: FileHandle | undefined;
    try {
      alca = await open(temporario, "wx", 0o644);
      await alca.writeFile(bytes);
      await alca.chmod(0o644);
      await alca.sync();
      await alca.close();
      alca = undefined;
      await rename(temporario, join(pasta, nome));
    } catch (e) {
      await alca?.close().catch(() => undefined);
      await unlink(temporario).catch(() => undefined);
      throw e;
    }
  }

  /** A pasta existe e é 0755 — o Asterisk (outro usuário) precisa atravessá-la. */
  private async pastaLegivel(pasta: string): Promise<void> {
    await mkdir(pasta, { recursive: true, mode: 0o755 });
    if (((await stat(pasta)).mode & 0o777) !== 0o755) await chmod(pasta, 0o755);
  }

  private async apagarDoDisco(caminho: string): Promise<boolean> {
    try {
      await unlink(caminho);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * As falas no volume da instalação, com o armazém do cliente de serviço — a
 * fiação que o laço do worker usa. O cliente do Storage só nasce aqui, nunca na
 * importação, e nada neste caminho alcança a ElevenLabs.
 */
export function falasNoDiscoDaInstalacao(db: Queryable, log: Registro): FalasNoDisco {
  return new FalasNoDisco(DIRETORIO_DAS_FALAS, db, armazemDaInstalacao(), log);
}
