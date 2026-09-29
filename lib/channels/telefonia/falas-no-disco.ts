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
 *   - a limpeza do Storage (`limparStorage`, chamada na mesma passada, com freio
 *     próprio de `INTERVALO_DA_LIMPEZA_MS`, armado com ou sem falha): a prévia que ninguém salvou e o áudio
 *     que nenhuma fala referencia saem do bucket (desenho §4, passo 4). O áudio do
 *     menu arquivado entra aqui: arquivar apaga as falas dele (lib/telefonia/menus.ts).
 *
 * ÓRFÃO SAI 15 MIN DEPOIS DE VISTO ÓRFÃO — no disco e no Storage. A carência
 * conta do PRIMEIRO avistamento (um mapa em memória, por caminho), nunca do
 * `mtime` nem da criação: uma ligação em curso guardou as falas ao entrar (o
 * "aguarde" repete a cada ~40 s), e um "Salvar e usar" no meio dela deixa a fala
 * ANTIGA sem referência. Pelo `mtime`, o arquivo antigo — gravado há dias — sairia
 * na passada seguinte, a repetição cairia em ausente e abriria um
 * `phone_prompt_unplayable` falso. Voltou a ter referência, sai do mapa, e a
 * carência recomeça se ficar órfão de novo. Reiniciar o worker zera o mapa: isso só
 * ATRASA a remoção, que é a direção segura.
 *
 * A LIMPEZA DO STORAGE APAGA A FONTE DA VERDADE, e por isso é a parte com mais
 * trava: sai só o objeto com mais de 24 h de criação E visto órfão há pelo menos
 * 15 min; a referência é lida de novo imediatamente antes de CADA `apagar`, lote a
 * lote, com a organização da pasta; só caminhos `<org>/<hash>.ulaw` da própria
 * pasta (nunca uma pasta, nunca a organização inteira); e "bucket não existe" ou
 * banco fora abortam a passada sem apagar nada. A janela entre ler a referência e
 * o `apagar` é de SEGUNDOS, não de milissegundos: `salvarFalaGeral`
 * (lib/telefonia/falas.ts) confere o objeto no Storage ANTES da transação e só
 * grava a linha depois (download, trava, commit). O que cobre essa janela é a
 * carência de 15 min: o "Salvar e usar" que reaproveita um objeto órfão vira
 * referência bem antes de ela vencer. Sobra a coincidência exata — um objeto órfão
 * há 15 min, com mais de 24 h, salvo nos mesmos segundos da limpeza —; aí o disco
 * ainda pode ter a cópia, e, se nem ele tiver, a ligação pula a fala, abre
 * `phone_prompt_unplayable`, e salvar de novo conserta.
 *
 * LOG SEM GIRAR O ARQUIVO: o log do worker tem 30 MB e é dividido com o motor da
 * IA. Fala pronta sem objeto no Storage é tentada de novo numa escada
 * (`ESCADA_DE_TENTATIVAS_MS`: 1, 5, 30 e 60 min, e de hora em hora) e registrada
 * UMA vez na primeira falha e uma quando o áudio volta; a ligação não espera a
 * escada (`garantir` tenta sempre — salvar de novo conserta na hora). Storage,
 * bucket, volume (a pasta), gravação (a escrita) e banco fora do ar são
 * registrados na TRANSIÇÃO (caiu / voltou), nunca em toda passada.
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
 * pedindo a mesma fala esperam o MESMO download. Os mapas em memória só guardam
 * caminhos órfãos ou ausentes, e são refeitos a cada passada.
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

/** Um arquivo (disco) ou objeto (Storage) sem referência só sai 15 min depois de VISTO órfão pela primeira vez. */
export const CARENCIA_DO_ORFAO_MS = 15 * 60_000;
/** O temporário da escrita atômica largado por uma queda sai 5 min depois do `mtime` (nenhuma escrita dura isso). */
export const CARENCIA_DO_TEMPORARIO_MS = 5 * 60_000;
/**
 * No Storage, só objeto criado há mais de 24 h (desenho §4, passo 4): a janela é o
 * que protege a prévia recém-gerada, que ainda não tem linha em `phone_prompts`.
 */
export const JANELA_DO_STORAGE_MS = 24 * 3_600_000;
/**
 * `limparStorage` só roda de novo 10 min depois da última limpeza — com ou sem
 * falha, bucket ausente inclusive —, e o laço pode chamá-la a cada 60 s.
 */
export const INTERVALO_DA_LIMPEZA_MS = 10 * 60_000;
/** Intervalo até a próxima tentativa de uma fala pronta sem objeto no Storage: 1, 5, 30, 60 min, e de hora em hora. */
export const ESCADA_DE_TENTATIVAS_MS: readonly number[] = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000]);
/** Quanto uma ligação espera o Storage antes de pular a fala. */
export const PRAZO_DO_GARANTIR_MS = 3_000;
/** Quanto a passada espera cada download: ninguém está ao telefone, mas a passada não pode travar. */
export const PRAZO_DA_PASSADA_MS = 20_000;
/** Linhas por página do banco, e caminhos por consulta de referência e por `apagar`. */
const LOTE = 100;
/** Falhas seguidas do Storage ou do disco (não ausência) depois das quais a passada para de baixar até a próxima. */
const FALHAS_SEGUIDAS_ATE_DESISTIR = 3;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CAMINHO_VALIDO = new RegExp(`^${UUID}/[0-9a-f]{64}\\.ulaw$`);
const ORG_VALIDA = new RegExp(`^${UUID}$`);
const ARQUIVO_DE_FALA = /^[0-9a-f]{64}\.ulaw$/;
/** `.<hash>.<aleatório>.tmp` — o temporário da escrita atômica. */
const TEMPORARIO = /^\.[0-9a-f]{64}\.[0-9a-f]+\.tmp$/;

/**
 * As falas prontas da INSTALAÇÃO, em páginas por `storage_path` (índice
 * `phone_prompts_caminho_pronto`). `$1` = o último caminho da página anterior
 * (`''` na primeira), `$2` = o tamanho da página.
 */
export const SQL_PRONTAS = `select distinct storage_path
   from phone_prompts
  where status = 'ready' and storage_path is not null and storage_path > $1
  order by storage_path
  limit $2`;
/** Dos caminhos dados (`$2`), os que alguma linha da organização `$1` referencia — em qualquer estado. */
export const SQL_REFERENCIADOS = `select storage_path
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
  /** Objetos que o Storage DE FATO removeu. */
  apagados: number;
  falhas: number;
  /** `true` = não rodou: a última limpeza bem-sucedida foi há menos de `INTERVALO_DA_LIMPEZA_MS`. */
  pulada: boolean;
}

export type ArmazemDasFalas = Pick<PortaDoArmazem, "baixar" | "listarPastas" | "listarObjetos" | "apagar">;

type Baixa = "gravada" | "ausente" | "falhou";
/** O que pode cair — e é registrado só na transição. */
/**
 * O que pode cair — e é registrado só na transição. O disco são DUAS frentes: o
 * `volume` (a raiz está legível?) volta assim que a pasta volta, mesmo sem nada
 * para baixar; a `gravacao` (a escrita deu certo?) volta na próxima escrita boa.
 * Com o disco cheio a pasta segue legível e a escrita falha: nenhuma das duas
 * alterna a cada passada.
 */
type Frente = "storage" | "bucket" | "volume" | "gravacao" | "banco";

const VOLTOU: Record<Frente, string> = {
  storage: "telefonia: o Storage das falas voltou a responder",
  bucket: "telefonia: o bucket das falas voltou a existir",
  volume: "telefonia: o volume das falas voltou a ficar acessível",
  gravacao: "telefonia: o volume das falas voltou a aceitar gravação",
  banco: "telefonia: o banco voltou a responder à passada das falas",
};

/** Erro de consulta ao banco, para a limpeza saber qual frente caiu. */
class FalhaDoBanco extends Error {}

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
  /** Caminho → quando foi visto órfão pela primeira vez. Refeitos a cada passada. */
  private orfaosNoDisco = new Map<string, number>();
  private orfaosNoStorage = new Map<string, number>();
  /** Fala pronta sem objeto no Storage: quantas vezes faltou e quando a passada tenta de novo. */
  private readonly ausentes = new Map<string, { vezes: number; proxima: number }>();
  /** Caminhos fora da régua já registrados (um aviso por caminho). */
  private readonly foraDaReguaAvisados = new Set<string>();
  private readonly fora = new Set<Frente>();
  /** Quando a última limpeza RODOU — com ou sem falha. */
  private ultimaLimpeza: number | null = null;

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
   * a próxima vez. Não respeita a escada das ausentes — tenta sempre. Nunca lança.
   */
  async garantir(fala: Pick<FalaDoBanco, "id" | "storagePath">): Promise<string | null> {
    try {
      if (!caminhoValido(fala.storagePath)) {
        this.avisarForaDaRegua(fala.storagePath, { fala: fala.id });
        return null;
      }
      if (await this.presente(fala.storagePath)) return midiaDaFala(fala.storagePath);
      const baixa = await dentroDoPrazo(this.baixarUmaVez(fala.storagePath, this.prazoDoGarantirMs), this.prazoDoGarantirMs);
      if (baixa === "gravada") return midiaDaFala(fala.storagePath);
      if (baixa === "prazo") {
        this.caiu("storage", "telefonia: o Storage das falas está lento — fala pulada na ligação", { fala: fala.id });
      }
      return null;
    } catch (e) {
      this.log.warn("telefonia: fala não garantida no disco — pulada", { fala: fala.id, erro: motivo(e) });
      return null;
    }
  }

  // ─── a passada de 60 s ─────────────────────────────────────────────────────

  /** Baixa as prontas que faltam e apaga os órfãos que passaram da carência. Nunca lança. */
  async sincronizar(): Promise<ResultadoDaSincronizacao> {
    const r: ResultadoDaSincronizacao = { baixadas: 0, apagadas: 0, falhas: 0 };
    const agora = this.agora();
    try {
      await this.pastaLegivel(this.dir);
    } catch (e) {
      r.falhas++;
      this.caiu("volume", "telefonia: volume das falas inacessível", { erro: motivo(e) });
      return r;
    }
    this.voltou("volume");
    await this.baixarAsQueFaltam(r, agora);
    await this.apagarOrfaos(r, agora);
    if (r.baixadas || r.apagadas) this.log.info("telefonia: falas sincronizadas no disco", { ...r });
    return r;
  }

  private async baixarAsQueFaltam(r: ResultadoDaSincronizacao, agora: number): Promise<void> {
    let depois = "";
    let falhasSeguidas = 0;
    let completa = false;
    /** As ausentes que continuam prontas: as outras saem da escada no fim de uma passada completa. */
    const ausentesProntas = new Set<string>();
    try {
      for (;;) {
        const { rows } = await this.consultar<{ storage_path: string }>(SQL_PRONTAS, [depois, this.lote]);
        for (const { storage_path: caminho } of rows) {
          if (!caminhoValido(caminho)) {
            r.falhas++;
            this.avisarForaDaRegua(caminho, {});
            continue;
          }
          if (await this.presente(caminho)) {
            this.ausentes.delete(caminho);
            continue;
          }
          const ausencia = this.ausentes.get(caminho);
          if (ausencia) {
            ausentesProntas.add(caminho);
            if (agora < ausencia.proxima) continue;
          }
          const baixa = await this.baixarUmaVez(caminho, this.prazoDaPassadaMs);
          if (baixa === "gravada") r.baixadas++;
          else r.falhas++;
          if (baixa === "ausente") ausentesProntas.add(caminho);
          // Ausência é resposta do Storage (ele está de pé); falha é Storage fora ou disco cheio.
          falhasSeguidas = baixa === "falhou" ? falhasSeguidas + 1 : 0;
          if (falhasSeguidas >= FALHAS_SEGUIDAS_ATE_DESISTIR) return;
        }
        if (rows.length < this.lote) {
          completa = true;
          return;
        }
        depois = rows[rows.length - 1]!.storage_path;
      }
    } catch (e) {
      r.falhas++;
      this.caiu("banco", "telefonia: a passada das falas não lê o banco", { erro: motivo(e) });
    } finally {
      if (completa) for (const c of [...this.ausentes.keys()]) if (!ausentesProntas.has(c)) this.ausentes.delete(c);
    }
  }

  /**
   * Apaga do volume o arquivo de fala que nenhuma linha referencia (em qualquer
   * estado) e foi visto órfão há `CARENCIA_DO_ORFAO_MS`, e o temporário largado por
   * uma escrita que caiu. Só nas pastas de organização e só nomes que este módulo
   * escreve. Sem banco não há como saber quem é órfão: a varredura para sem apagar.
   */
  private async apagarOrfaos(r: ResultadoDaSincronizacao, agora: number): Promise<void> {
    let orgs: string[];
    try {
      orgs = (await readdir(this.dir)).filter((nome) => ORG_VALIDA.test(nome));
    } catch (e) {
      r.falhas++;
      this.caiu("volume", "telefonia: volume das falas inacessível", { erro: motivo(e) });
      return;
    }
    // Só fica no mapa quem esta passada CONFIRMOU órfão: o que voltou a ter
    // referência, sumiu, ou não foi olhado (banco caiu no meio) sai — e só atrasa.
    const vistos = new Map<string, number>();
    try {
      for (const org of orgs) {
        const pasta = join(this.dir, org);
        const falas: string[] = [];
        for (const nome of await readdir(pasta).catch(() => [] as string[])) {
          const ehTemporario = TEMPORARIO.test(nome);
          if (!ehTemporario && !ARQUIVO_DE_FALA.test(nome)) continue;
          const info = await lstat(join(pasta, nome)).catch(() => null);
          if (!info?.isFile()) continue;
          if (!ehTemporario) falas.push(nome);
          else if (agora - info.mtimeMs >= CARENCIA_DO_TEMPORARIO_MS && (await this.apagarDoDisco(join(pasta, nome)))) r.apagadas++;
        }
        for (const lote of emLotes(falas, this.lote)) {
          const usados = await this.referenciados(org, lote.map((nome) => `${org}/${nome}`));
          for (const nome of lote) {
            const caminho = `${org}/${nome}`;
            if (usados.has(caminho)) continue;
            const desde = this.orfaosNoDisco.get(caminho) ?? agora;
            if (agora - desde >= CARENCIA_DO_ORFAO_MS && (await this.apagarDoDisco(join(pasta, nome)))) r.apagadas++;
            else vistos.set(caminho, desde);
          }
        }
      }
    } catch (e) {
      r.falhas++;
      this.caiu("banco", "telefonia: a passada das falas não lê o banco", { erro: motivo(e) });
    } finally {
      this.orfaosNoDisco = vistos;
    }
  }

  // ─── a limpeza do Storage ──────────────────────────────────────────────────

  /**
   * Sai do bucket o objeto criado há mais de 24 h E visto órfão (nenhuma linha de
   * `phone_prompts` o referencia) há pelo menos 15 min. A referência é conferida
   * imediatamente antes de CADA `apagar`, com a organização da pasta. Só pastas de
   * organização (uuid), só caminhos na régua e da própria pasta. Bucket ausente ou
   * banco fora abortam a passada. Roda no máximo a cada `INTERVALO_DA_LIMPEZA_MS`
   * contados da última limpeza, com ou sem falha. Nunca lança.
   */
  async limparStorage(): Promise<ResultadoDaLimpeza> {
    const agora = this.agora();
    if (this.ultimaLimpeza !== null && agora - this.ultimaLimpeza < INTERVALO_DA_LIMPEZA_MS) {
      return { apagados: 0, falhas: 0, pulada: true };
    }
    const r: ResultadoDaLimpeza = { apagados: 0, falhas: 0, pulada: false };
    const limite = agora - JANELA_DO_STORAGE_MS;
    const vistos = new Map<string, number>();
    let storageFalhou = false;
    try {
      for (const org of await this.armazem.listarPastas()) {
        if (!ORG_VALIDA.test(org)) continue;
        let objetos: ObjetoDoArmazem[];
        try {
          objetos = await this.armazem.listarObjetos(org);
        } catch (e) {
          if (bucketAusente(e)) throw e;
          r.falhas++;
          storageFalhou = true;
          this.caiu("storage", "telefonia: o Storage das falas não responde — limpeza adiada", { organization_id: org, erro: motivo(e) });
          continue;
        }
        const candidatos = objetos
          .filter((o) => caminhoValido(o.caminho) && o.caminho.startsWith(`${org}/`) && o.criadoEm.getTime() < limite)
          .map((o) => o.caminho);
        for (const lote of emLotes(candidatos, this.lote)) {
          // A referência é lida AQUI, imediatamente antes do `apagar`, e não no
          // começo da passada: um "Salvar e usar" que reaproveitou este áudio há um
          // instante tem de ser visto.
          const usados = await this.referenciados(org, lote);
          const vencidos: string[] = [];
          for (const caminho of lote) {
            if (usados.has(caminho)) continue;
            const desde = this.orfaosNoStorage.get(caminho) ?? agora;
            vistos.set(caminho, desde);
            if (agora - desde >= CARENCIA_DO_ORFAO_MS) vencidos.push(caminho);
          }
          if (vencidos.length === 0) continue;
          try {
            r.apagados += (await this.armazem.apagar(vencidos)).length;
            for (const caminho of vencidos) vistos.delete(caminho);
          } catch (e) {
            if (bucketAusente(e)) throw e;
            r.falhas++;
            storageFalhou = true;
            this.caiu("storage", "telefonia: o Storage das falas não responde — limpeza adiada", { organization_id: org, erro: motivo(e) });
            break;
          }
        }
      }
      if (!storageFalhou) {
        this.voltou("bucket");
        this.voltou("storage");
      }
    } catch (e) {
      r.falhas++;
      if (e instanceof FalhaDoBanco) {
        this.caiu("banco", "telefonia: a limpeza das falas não lê o banco — nada apagado", { erro: motivo(e) });
      } else if (bucketAusente(e)) {
        this.caiu("bucket", "telefonia: o bucket das falas não existe — limpeza do Storage abortada sem apagar nada", { erro: motivo(e) }, "error");
      } else {
        this.caiu("storage", "telefonia: o Storage das falas não responde — limpeza adiada", { erro: motivo(e) });
      }
    } finally {
      this.orfaosNoStorage = vistos;
    }
    // O freio arma com ou sem falha: uma organização que falha sempre na listagem,
    // ou o bucket ausente (que não volta em 60 s), não pode virar limpeza por minuto.
    this.ultimaLimpeza = agora;
    if (r.apagados) this.log.info("telefonia: falas sem uso apagadas do Storage", { apagados: r.apagados });
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

  private async consultar<R extends { storage_path: string }>(sql: string, params: unknown[]): Promise<{ rows: R[] }> {
    let resposta: { rows: R[] };
    try {
      resposta = await this.db.query<R>(sql, params);
    } catch (e) {
      throw new FalhaDoBanco(motivo(e));
    }
    this.voltou("banco");
    return resposta;
  }

  private async referenciados(org: string, caminhos: string[]): Promise<Set<string>> {
    const { rows } = await this.consultar<{ storage_path: string }>(SQL_REFERENCIADOS, [org, caminhos]);
    return new Set(rows.map((l) => l.storage_path));
  }

  private baixarUmaVez(storagePath: string, prazoMs: number): Promise<Baixa> {
    const emCurso = this.emCurso.get(storagePath);
    if (emCurso) return emCurso;
    const baixa = this.baixarParaODisco(storagePath, prazoMs).finally(() => this.emCurso.delete(storagePath));
    this.emCurso.set(storagePath, baixa);
    return baixa;
  }

  /** Storage → disco. Nunca lança: a falha vira `"falhou"`, a ausência `"ausente"`. */
  private async baixarParaODisco(storagePath: string, prazoMs: number): Promise<Baixa> {
    let bytes: Uint8Array | null;
    try {
      bytes = await comPrazoDeLeitura(this.armazem, prazoMs).baixar(storagePath);
    } catch (e) {
      if (bucketAusente(e)) {
        this.caiu("bucket", "telefonia: o bucket das falas não existe — falas não baixadas", { caminho: storagePath, erro: motivo(e) }, "error");
      } else {
        this.caiu("storage", "telefonia: o Storage das falas não responde", { caminho: storagePath, erro: motivo(e) });
      }
      return "falhou";
    }
    // O armazém LANÇA com bucket ausente: resposta (objeto ou ausência) prova os dois.
    this.voltou("bucket");
    this.voltou("storage");
    if (!bytes || bytes.length === 0) {
      this.registrarAusencia(storagePath);
      return "ausente";
    }
    try {
      await this.gravarAtomico(storagePath, bytes);
    } catch (e) {
      this.caiu("gravacao", "telefonia: fala não gravada no volume", { caminho: storagePath, erro: motivo(e) });
      return "falhou";
    }
    this.voltou("gravacao");
    if (this.ausentes.delete(storagePath)) this.log.info("telefonia: o áudio da fala voltou ao Storage", { caminho: storagePath });
    return "gravada";
  }

  /** Mais um degrau da escada; o aviso sai só na PRIMEIRA falta do caminho. */
  private registrarAusencia(storagePath: string): void {
    const vezes = (this.ausentes.get(storagePath)?.vezes ?? 0) + 1;
    const espera = ESCADA_DE_TENTATIVAS_MS[Math.min(vezes, ESCADA_DE_TENTATIVAS_MS.length) - 1]!;
    this.ausentes.set(storagePath, { vezes, proxima: this.agora() + espera });
    if (vezes === 1) {
      this.log.warn("telefonia: fala pronta sem áudio no Storage — a passada tenta de novo em intervalos crescentes", {
        caminho: storagePath,
      });
    }
  }

  private avisarForaDaRegua(storagePath: string, campos: Record<string, unknown>): void {
    const chave = storagePath.slice(0, 200);
    if (this.foraDaReguaAvisados.has(chave)) return;
    this.foraDaReguaAvisados.add(chave);
    this.log.warn("telefonia: caminho de fala fora da régua — ignorado", { ...campos, caminho: chave });
  }

  private caiu(frente: Frente, mensagem: string, campos: Record<string, unknown>, nivel: "warn" | "error" = "warn"): void {
    if (this.fora.has(frente)) return;
    this.fora.add(frente);
    this.log[nivel](mensagem, campos);
  }

  private voltou(frente: Frente): void {
    if (this.fora.delete(frente)) this.log.info(VOLTOU[frente]);
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
