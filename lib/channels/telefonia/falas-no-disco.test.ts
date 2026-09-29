// @vitest-environment node
/**
 * As falas no disco (desenho da fase 2, §4 e D12) contra um `fs` DE VERDADE num
 * diretório temporário — o volume — e um armazém falso no lugar do Storage.
 *
 * `open` e `rename` passam pelo real; o mock existe só para os dois testes da
 * escrita atômica injetarem, uma vez, um disco que enche no meio da escrita e um
 * olhar no instante do `rename`.
 */
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDoArmazem from "@/lib/telefonia/armazem";
import type * as ModuloFs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloFs>();
  const comEspioes = { ...real, open: vi.fn(real.open), rename: vi.fn(real.rename) };
  return { ...comEspioes, default: comEspioes };
});

vi.mock("@/lib/telefonia/armazem", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoArmazem>();
  return { ...real, armazemDaInstalacao: vi.fn() };
});

import * as fs from "node:fs/promises";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { armazemDaInstalacao, type ObjetoDoArmazem, type PortaDoArmazem } from "@/lib/telefonia/armazem";

import {
  CARENCIA_DO_ORFAO_MS,
  DIRETORIO_DAS_FALAS,
  DIRETORIO_NO_ASTERISK,
  FalasNoDisco,
  JANELA_DO_STORAGE_MS,
  caminhoValido,
  falasNoDiscoDaInstalacao,
  midiaDaFala,
  type OpcoesDasFalasNoDisco,
} from "./falas-no-disco";

const { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } = fs;

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const hash = (c: string) => c.repeat(64);
const caminho = (c: string, org = ORG) => `${org}/${hash(c)}.ulaw`;

// ─── o banco falso: as linhas de `phone_prompts` que importam aqui ──────────

interface Linha {
  organization_id: string;
  storage_path: string | null;
  status: "ready" | "failed";
}
let linhas: Linha[];
/** A ordem do que aconteceu, para provar que a referência é lida logo antes de cada `apagar`. */
let eventos: Array<{ tipo: "consulta_referencias"; org: string; caminhos: string[] } | { tipo: "consulta_prontas"; limite: number } | { tipo: "apagar"; caminhos: string[] }>;
let bancoFora: boolean;

const db: Queryable = {
  query: (async (sql: string, params: unknown[] = []) => {
    if (bancoFora) throw new Error("connection terminated");
    const resposta = (caminhos: string[]) => ({ rows: caminhos.map((storage_path) => ({ storage_path })), rowCount: caminhos.length });
    if (sql.includes("status = 'ready'")) {
      const [depois, limite] = params as [string, number];
      eventos.push({ tipo: "consulta_prontas", limite });
      const prontas = new Set(
        linhas.filter((l) => l.status === "ready" && l.storage_path !== null && l.storage_path > depois).map((l) => l.storage_path!),
      );
      return resposta([...prontas].sort().slice(0, limite));
    }
    if (sql.includes("organization_id = $1") && sql.includes("any($2")) {
      const [org, caminhos] = params as [string, string[]];
      eventos.push({ tipo: "consulta_referencias", org, caminhos: [...caminhos] });
      return resposta(linhas.filter((l) => l.organization_id === org && l.storage_path !== null && caminhos.includes(l.storage_path)).map((l) => l.storage_path!));
    }
    throw new Error(`consulta inesperada: ${sql}`);
  }) as unknown as Queryable["query"],
};

// ─── o Storage falso ─────────────────────────────────────────────────────────

let objetos: Map<string, Uint8Array>;
let pastasNoStorage: string[];
let listaDoStorage: ObjetoDoArmazem[];
let apagadosDoStorage: string[];
let baixadosEmParalelo: number;
let picoDeParalelismo: number;

const baixarPadrao = async (c: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  baixadosEmParalelo++;
  picoDeParalelismo = Math.max(picoDeParalelismo, baixadosEmParalelo);
  await new Promise((r) => setTimeout(r, 1));
  baixadosEmParalelo--;
  return objetos.has(c) ? new Uint8Array(objetos.get(c)!) : null;
};
let baixar: ReturnType<typeof vi.fn<PortaDoArmazem["baixar"]>>;

function armazem(extra: Partial<PortaDoArmazem> = {}): Pick<PortaDoArmazem, "baixar" | "listarPastas" | "listarObjetos" | "apagar"> {
  return {
    baixar: (c, o) => baixar(c, o),
    listarPastas: async () => [...pastasNoStorage],
    listarObjetos: async (pasta) => listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`)),
    apagar: async (caminhos) => {
      eventos.push({ tipo: "apagar", caminhos: [...caminhos] });
      apagadosDoStorage.push(...caminhos);
    },
    ...extra,
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dir: string;
const disco = (opcoes: OpcoesDasFalasNoDisco = {}, extra: Partial<PortaDoArmazem> = {}) =>
  new FalasNoDisco(dir, db, armazem(extra), log, opcoes);
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000);
const noDisco = (c: string) => join(dir, c);
async function gravarNoDisco(c: string, bytes: number[], idadeMs = 0) {
  await mkdir(dirname(noDisco(c)), { recursive: true });
  await writeFile(noDisco(c), new Uint8Array(bytes));
  if (idadeMs > 0) {
    const quando = new Date(Date.now() - idadeMs);
    await utimes(noDisco(c), quando, quando);
  }
}
const existe = (c: string) =>
  stat(noDisco(c)).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "falas-"));
  linhas = [];
  eventos = [];
  bancoFora = false;
  objetos = new Map();
  pastasNoStorage = [];
  listaDoStorage = [];
  apagadosDoStorage = [];
  baixadosEmParalelo = 0;
  picoDeParalelismo = 0;
  baixar = vi.fn<PortaDoArmazem["baixar"]>(baixarPadrao);
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("o endereço de mídia e a régua do caminho", () => {
  it("o worker escreve e o Asterisk lê o MESMO caminho absoluto (passo zero, ramo A)", () => {
    expect(DIRETORIO_DAS_FALAS).toBe("/var/lib/deskcomm/falas");
    expect(DIRETORIO_NO_ASTERISK).toBe(DIRETORIO_DAS_FALAS);
  });

  it("sound: + caminho absoluto SEM extensão (o Asterisk escolhe o formato pelo arquivo)", () => {
    expect(midiaDaFala(caminho("a"))).toBe(`sound:/var/lib/deskcomm/falas/${ORG}/${hash("a")}`);
  });

  it("midiaDaFala recusa caminho fora da régua em vez de montar um endereço para fora do volume", () => {
    expect(() => midiaDaFala(`${ORG}/../../etc/asterisk/manager.ulaw`)).toThrow(/fora da régua/);
  });

  it("só aceita <uuid>/<sha256>.ulaw — nada de subir diretório, pasta solta ou maiúscula", () => {
    expect(caminhoValido(caminho("a"))).toBe(true);
    for (const ruim of [
      `${ORG}/../../etc/passwd`,
      `${ORG}/..${hash("a").slice(2)}.ulaw`,
      `outra/${hash("a")}.ulaw`,
      `${ORG}/${hash("a")}.wav`,
      `${ORG}/${hash("A")}.ulaw`,
      `${ORG}/sub/${hash("a")}.ulaw`,
      `/${ORG}/${hash("a")}.ulaw`,
      ORG,
      `${ORG}/`,
      `${ORG.toUpperCase()}/${hash("a")}.ulaw`,
      `${caminho("a")}\n`,
    ]) {
      expect(caminhoValido(ruim), ruim).toBe(false);
    }
  });
});

describe("garantir — antes de tocar", () => {
  it("arquivo que já está no disco: não baixa", async () => {
    await gravarNoDisco(caminho("a"), [1]);
    expect(await disco().garantir({ id: "f1", storagePath: caminho("a") })).toBe(midiaDaFala(caminho("a")));
    expect(baixar).not.toHaveBeenCalled();
  });

  it("arquivo vazio no disco não conta como presente: baixa de novo", async () => {
    await gravarNoDisco(caminho("a"), []);
    objetos.set(caminho("a"), new Uint8Array([9, 9]));
    expect(await disco().garantir({ id: "f1", storagePath: caminho("a") })).toBe(midiaDaFala(caminho("a")));
    expect([...(await readFile(noDisco(caminho("a"))))]).toEqual([9, 9]);
  });

  it("arquivo ausente: baixa na hora e grava 0644 dentro de pastas 0755 — mesmo com umask fechado", async () => {
    objetos.set(caminho("b"), new Uint8Array([0xff, 0x7f]));
    const anterior = process.umask(0o077);
    try {
      expect(await disco().garantir({ id: "f2", storagePath: caminho("b") })).toBe(midiaDaFala(caminho("b")));
    } finally {
      process.umask(anterior);
    }
    expect([...(await readFile(noDisco(caminho("b"))))]).toEqual([0xff, 0x7f]);
    expect((await stat(noDisco(caminho("b")))).mode & 0o777).toBe(0o644);
    expect((await stat(join(dir, ORG))).mode & 0o777).toBe(0o755);
    // O mkdtemp nasce 0700: o Asterisk (outro usuário) não atravessaria a raiz do volume.
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    // Nenhum temporário ficou para trás.
    expect(await readdir(join(dir, ORG))).toEqual([`${hash("b")}.ulaw`]);
  });

  it("nem no disco nem no Storage: null (a ligação pula a fala) e avisa no log", async () => {
    expect(await disco().garantir({ id: "f3", storagePath: caminho("c") })).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("Storage com erro: null, sem lançar", async () => {
    baixar.mockRejectedValueOnce(new Error("armazem_download: StorageApiError 500: boom"));
    expect(await disco().garantir({ id: "f3", storagePath: caminho("c") })).toBeNull();
  });

  it("Storage que não responde: desiste no prazo curto e ABORTA o pedido pelo AbortSignal", async () => {
    let sinal: AbortSignal | undefined;
    baixar.mockImplementationOnce(
      (_c, opcoes) =>
        new Promise((_, rejeitar) => {
          sinal = opcoes?.signal;
          sinal?.addEventListener("abort", () => rejeitar(new Error("aborted")));
        }),
    );
    const inicio = Date.now();
    expect(await disco({ prazoDoGarantirMs: 40 }).garantir({ id: "f5", storagePath: caminho("e") })).toBeNull();
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(sinal?.aborted).toBe(true);
  });

  it("caminho fora da régua: null, sem baixar e sem escrever nada", async () => {
    expect(await disco().garantir({ id: "f4", storagePath: `${ORG}/../x.ulaw` })).toBeNull();
    expect(baixar).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("duas ligações pedindo a mesma fala ao mesmo tempo: um download só", async () => {
    objetos.set(caminho("f"), new Uint8Array([6]));
    const d = disco();
    const [a, b] = await Promise.all([
      d.garantir({ id: "f6", storagePath: caminho("f") }),
      d.garantir({ id: "f6", storagePath: caminho("f") }),
    ]);
    expect(a).toBe(midiaDaFala(caminho("f")));
    expect(b).toBe(a);
    expect(baixar).toHaveBeenCalledTimes(1);
  });

  it("não espera o prazo longo da passada: desiste no próprio prazo, e o download da passada termina", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("1"), status: "ready" }];
    let liberar!: () => void;
    baixar.mockImplementationOnce(() => new Promise((r) => (liberar = () => r(new Uint8Array([7])))));
    const d = disco({ prazoDoGarantirMs: 40, prazoDaPassadaMs: 10_000 });
    const passada = d.sincronizar();
    await vi.waitFor(() => expect(baixar).toHaveBeenCalledTimes(1));
    expect(await d.garantir({ id: "f7", storagePath: caminho("1") })).toBeNull();
    liberar();
    expect(await passada).toEqual({ baixadas: 1, apagadas: 0, falhas: 0 });
    expect(await existe(caminho("1"))).toBe(true);
  });
});

describe("garantir — a escrita é ATÔMICA", () => {
  it("no instante do rename o arquivo inteiro já está num temporário da MESMA pasta, com 0644, e o nome final ainda não existe", async () => {
    objetos.set(caminho("2"), new Uint8Array([1, 2, 3, 4]));
    const real = await vi.importActual<typeof ModuloFs>("node:fs/promises");
    const visto: { mesmaPasta?: boolean; oculto?: boolean; finalExistia?: boolean; conteudo?: number[]; modo?: number } = {};
    vi.mocked(fs.rename).mockImplementationOnce(async (de, para) => {
      visto.mesmaPasta = dirname(String(de)) === dirname(String(para));
      visto.oculto = basename(String(de)).startsWith(".");
      visto.finalExistia = await real.stat(para).then(
        () => true,
        () => false,
      );
      visto.conteudo = [...(await real.readFile(de))];
      visto.modo = (await real.stat(de)).mode & 0o777;
      return real.rename(de, para);
    });

    expect(await disco().garantir({ id: "f8", storagePath: caminho("2") })).toBe(midiaDaFala(caminho("2")));
    expect(visto).toEqual({ mesmaPasta: true, oculto: true, finalExistia: false, conteudo: [1, 2, 3, 4], modo: 0o644 });
    expect(dirname(String(vi.mocked(fs.rename).mock.calls.at(-1)![1]))).toBe(join(dir, ORG));
  });

  it("disco cheio no meio da escrita: o nome final nunca aparece, e o temporário parcial sai", async () => {
    objetos.set(caminho("3"), new Uint8Array([1, 2, 3, 4]));
    const real = await vi.importActual<typeof ModuloFs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
      const alca = await real.open(...args);
      return new Proxy(alca, {
        get(alvo, prop) {
          if (prop === "writeFile") {
            return async (dados: Uint8Array) => {
              await alvo.write(dados.subarray(0, 1));
              throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
            };
          }
          const valor = Reflect.get(alvo, prop);
          return typeof valor === "function" ? valor.bind(alvo) : valor;
        },
      });
    }) as typeof real.open);

    expect(await disco().garantir({ id: "f9", storagePath: caminho("3") })).toBeNull();
    expect(await existe(caminho("3"))).toBe(false);
    expect(await readdir(join(dir, ORG))).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("não gravada"), expect.objectContaining({ erro: expect.stringContaining("ENOSPC") }));
  });
});

describe("sincronizar — a passada de 60 s", () => {
  it("baixa as prontas de TODAS as organizações que faltam, uma por vez e em páginas, e pula as que já estão no disco", async () => {
    linhas = [
      { organization_id: ORG, storage_path: caminho("a"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("b"), status: "ready" },
      // A mesma fala em duas linhas (menu e tecla inválida com o mesmo texto): um download.
      { organization_id: ORG, storage_path: caminho("b"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("c"), status: "ready" },
      { organization_id: OUTRA, storage_path: caminho("d", OUTRA), status: "ready" },
      { organization_id: OUTRA, storage_path: caminho("e", OUTRA), status: "ready" },
      { organization_id: ORG, storage_path: null, status: "failed" },
    ];
    for (const l of linhas) if (l.storage_path) objetos.set(l.storage_path, new Uint8Array([1]));
    await gravarNoDisco(caminho("a"), [1]);

    expect(await disco({ lote: 2 }).sincronizar()).toEqual({ baixadas: 4, apagadas: 0, falhas: 0 });
    expect(baixar.mock.calls.map((c) => c[0]).sort()).toEqual([caminho("b"), caminho("c"), caminho("d", OUTRA), caminho("e", OUTRA)]);
    for (const c of [caminho("b"), caminho("c"), caminho("d", OUTRA), caminho("e", OUTRA)]) expect(await existe(c)).toBe(true);
    // Memória: nunca dois áudios ao mesmo tempo, e a lista vem do banco em páginas do tamanho do lote.
    expect(picoDeParalelismo).toBe(1);
    const paginas = eventos.filter((e) => e.tipo === "consulta_prontas");
    expect(paginas.length).toBeGreaterThanOrEqual(3);
    expect(paginas.every((e) => e.tipo === "consulta_prontas" && e.limite === 2)).toBe(true);
  });

  it("apaga do disco só o que nenhuma linha referencia e já passou da carência; o resto fica", async () => {
    const velho = CARENCIA_DO_ORFAO_MS + 60_000;
    linhas = [
      { organization_id: ORG, storage_path: caminho("a"), status: "ready" },
      // Referenciado por uma linha que não está pronta: não é órfão.
      { organization_id: ORG, storage_path: caminho("f"), status: "failed" },
    ];
    objetos.set(caminho("a"), new Uint8Array([1]));
    await gravarNoDisco(caminho("a"), [1], velho);
    await gravarNoDisco(caminho("f"), [1], velho);
    await gravarNoDisco(caminho("d"), [4], velho); // órfão velho: sai
    await gravarNoDisco(caminho("e"), [5]); // órfão recém-escrito: fica (a fala pode ter nascido depois da leitura)
    await gravarNoDisco(`${ORG}/.${hash("7")}.abc.tmp`, [0], velho); // temporário largado por uma queda: sai
    await gravarNoDisco(`${ORG}/.${hash("8")}.def.tmp`, [0]); // temporário de uma escrita em curso: fica
    await gravarNoDisco(`${ORG}/LEIA-ME.txt`, [0], velho); // nome que não é nosso: não mexe
    await gravarNoDisco(`nao-e-org/${hash("9")}.ulaw`, [0], velho); // pasta que não é organização: não mexe
    await writeFile(join(dir, "solto.ulaw"), new Uint8Array([0])); // arquivo na raiz: não mexe

    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 2, falhas: 0 });
    expect((await readdir(join(dir, ORG))).sort()).toEqual(
      [`.${hash("8")}.def.tmp`, `${hash("a")}.ulaw`, `${hash("e")}.ulaw`, `${hash("f")}.ulaw`, "LEIA-ME.txt"].sort(),
    );
    expect(await readdir(join(dir, "nao-e-org"))).toEqual([`${hash("9")}.ulaw`]);
    expect(await existe("solto.ulaw")).toBe(true);
  });

  it("a referência do órfão é consultada COM a organização da pasta", async () => {
    await gravarNoDisco(caminho("d"), [4], CARENCIA_DO_ORFAO_MS + 60_000);
    await gravarNoDisco(caminho("d", OUTRA), [4], CARENCIA_DO_ORFAO_MS + 60_000);
    // A linha é da OUTRA organização: o arquivo de ORG com o mesmo hash continua órfão.
    linhas = [{ organization_id: OUTRA, storage_path: caminho("d", OUTRA), status: "ready" }];
    objetos.set(caminho("d", OUTRA), new Uint8Array([4]));

    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 1, falhas: 0 });
    expect(await existe(caminho("d"))).toBe(false);
    expect(await existe(caminho("d", OUTRA))).toBe(true);
    const consultas = eventos.filter((e) => e.tipo === "consulta_referencias");
    expect(consultas.map((e) => e.tipo === "consulta_referencias" && e.org).sort()).toEqual([ORG, OUTRA].sort());
  });

  it("fala pronta que o Storage não devolve conta como falha e não derruba a passada", async () => {
    linhas = [
      { organization_id: ORG, storage_path: caminho("8"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("9"), status: "ready" },
    ];
    objetos.set(caminho("9"), new Uint8Array([2]));
    expect(await disco().sincronizar()).toEqual({ baixadas: 1, apagadas: 0, falhas: 1 });
    expect(await existe(caminho("9"))).toBe(true);
  });

  it("Storage fora do ar: para de tentar na 3ª falha seguida (a passada não vira N prazos), e os órfãos saem assim mesmo", async () => {
    linhas = ["a", "b", "c", "d", "e"].map((c) => ({ organization_id: ORG, storage_path: caminho(c), status: "ready" as const }));
    baixar.mockRejectedValue(new Error("armazem_download: TypeError: fetch failed"));
    await gravarNoDisco(caminho("6"), [1], CARENCIA_DO_ORFAO_MS + 60_000);

    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 1, falhas: 3 });
    expect(baixar).toHaveBeenCalledTimes(3);
  });

  it("banco fora: nada é apagado do disco (sem saber quem referencia, ninguém é órfão) e não lança", async () => {
    await gravarNoDisco(caminho("d"), [4], CARENCIA_DO_ORFAO_MS + 60_000);
    bancoFora = true;
    const r = await disco().sincronizar();
    expect(r.apagadas).toBe(0);
    expect(r.falhas).toBeGreaterThan(0);
    expect(await existe(caminho("d"))).toBe(true);
  });

  it("caminho fora da régua vindo do banco (CHECK furado): não baixa e não escreve fora do volume", async () => {
    linhas = [{ organization_id: ORG, storage_path: `${ORG}/../../fora.ulaw`, status: "ready" }];
    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 1 });
    expect(baixar).not.toHaveBeenCalled();
  });

  it("volume ainda sem nada: cria a raiz e não falha", async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 0 });
  });
});

describe("limparStorage — prévia não salva e áudio sem uso saem do Storage 24 h depois (desenho §4)", () => {
  it("apaga só o que nenhuma linha usa E foi gravado há mais de 24 h", async () => {
    expect(JANELA_DO_STORAGE_MS).toBe(24 * 3_600_000);
    pastasNoStorage = [ORG];
    linhas = [
      { organization_id: ORG, storage_path: caminho("a"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("f"), status: "failed" },
    ];
    listaDoStorage = [
      { caminho: caminho("a"), criadoEm: horasAtras(48) }, // em uso: fica
      { caminho: caminho("f"), criadoEm: horasAtras(48) }, // referenciado por linha failed: fica
      { caminho: caminho("b"), criadoEm: horasAtras(48) }, // sem uso e velho: sai
      { caminho: caminho("c"), criadoEm: horasAtras(2) }, // prévia recém-gerada, ainda sem linha: fica
      { caminho: caminho("d"), criadoEm: horasAtras(23.9) }, // quase 24 h: fica
      { caminho: caminho("e"), criadoEm: new Date("não é data") }, // data ilegível: fica
    ];
    expect(await disco().limparStorage()).toEqual({ apagados: 1, falhas: 0 });
    expect(apagadosDoStorage).toEqual([caminho("b")]);
  });

  it("o áudio de um menu arquivado sai: arquivar apaga as linhas das falas, e o objeto fica sem referência", async () => {
    pastasNoStorage = [ORG];
    linhas = []; // o menu foi arquivado e as falas dele, apagadas
    listaDoStorage = [
      { caminho: caminho("4"), criadoEm: horasAtras(24 * 30) },
      { caminho: caminho("5"), criadoEm: horasAtras(24 * 30) },
    ];
    expect(await disco().limparStorage()).toEqual({ apagados: 2, falhas: 0 });
    expect(apagadosDoStorage.sort()).toEqual([caminho("4"), caminho("5")].sort());
  });

  it("nunca apaga pasta: nem a da organização, nem subpasta, nem pasta que não é organização (esta nem é listada)", async () => {
    pastasNoStorage = [ORG, "nao-e-org", ""];
    const listadas: string[] = [];
    listaDoStorage = [
      { caminho: `${ORG}/`, criadoEm: horasAtras(48) },
      { caminho: `${ORG}/sub/${hash("a")}.ulaw`, criadoEm: horasAtras(48) },
      { caminho: `${ORG}/${hash("a")}`, criadoEm: horasAtras(48) },
      { caminho: `nao-e-org/${hash("a")}.ulaw`, criadoEm: horasAtras(48) },
    ];
    const r = await disco(
      {},
      {
        listarObjetos: async (pasta) => {
          listadas.push(pasta);
          return listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`));
        },
      },
    ).limparStorage();
    expect(r).toEqual({ apagados: 0, falhas: 0 });
    expect(listadas).toEqual([ORG]);
    expect(apagadosDoStorage).toEqual([]);
  });

  it("objeto listado numa pasta com caminho de OUTRA organização não é apagado por ela", async () => {
    pastasNoStorage = [ORG];
    const r = await disco({}, { listarObjetos: async () => [{ caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) }] }).limparStorage();
    expect(r).toEqual({ apagados: 0, falhas: 0 });
    expect(apagadosDoStorage).toEqual([]);
  });

  it("a referência é lida IMEDIATAMENTE antes de CADA apagar, com a organização, e cobre tudo o que vai ser apagado", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [
      ...["b", "c", "d"].map((c) => ({ caminho: caminho(c), criadoEm: horasAtras(48) })),
      ...["b", "c"].map((c) => ({ caminho: caminho(c, OUTRA), criadoEm: horasAtras(48) })),
    ];
    expect(await disco({ lote: 2 }).limparStorage()).toEqual({ apagados: 5, falhas: 0 });

    const apagares = eventos.flatMap((e, i) => (e.tipo === "apagar" ? [i] : []));
    expect(apagares.length).toBe(3);
    for (const i of apagares) {
      const antes = eventos[i - 1]!;
      const apagar = eventos[i]!;
      expect(antes.tipo).toBe("consulta_referencias");
      if (antes.tipo !== "consulta_referencias" || apagar.tipo !== "apagar") continue;
      expect(apagar.caminhos.every((c) => antes.caminhos.includes(c) && c.startsWith(`${antes.org}/`))).toBe(true);
    }
  });

  it("o que passou a ser usado entre um apagar e o seguinte (um Salvar e usar no meio da passada) não é apagado", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [
      { caminho: caminho("b"), criadoEm: horasAtras(48) },
      { caminho: caminho("c"), criadoEm: horasAtras(48) },
    ];
    const d = disco(
      { lote: 1 },
      {
        apagar: async (caminhos) => {
          eventos.push({ tipo: "apagar", caminhos: [...caminhos] });
          apagadosDoStorage.push(...caminhos);
          // Depois do primeiro apagar, alguém salva uma fala que reaproveita "c".
          linhas.push({ organization_id: ORG, storage_path: caminho("c"), status: "ready" });
        },
      },
    );
    expect(await d.limparStorage()).toEqual({ apagados: 1, falhas: 0 });
    expect(apagadosDoStorage).toEqual([caminho("b")]);
  });

  it("o que passou a ser usado entre a listagem e o apagar não é apagado", async () => {
    pastasNoStorage = [ORG];
    const d = disco(
      {},
      {
        listarObjetos: async () => {
          const lista = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
          linhas.push({ organization_id: ORG, storage_path: caminho("b"), status: "ready" });
          return lista;
        },
      },
    );
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 0 });
    expect(apagadosDoStorage).toEqual([]);
  });

  it("bucket ausente ao listar as pastas: aborta a passada, não apaga nada e grita no log", async () => {
    const d = disco({}, { listarPastas: async () => Promise.reject(new Error("armazem_lista: StorageApiError 400: Bucket not found")) });
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1 });
    expect(apagadosDoStorage).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("bucket"), expect.anything());
  });

  it("bucket ausente ao listar uma organização: aborta — as organizações seguintes nem são olhadas", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [{ caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) }];
    const listadas: string[] = [];
    const d = disco(
      {},
      {
        listarObjetos: async (pasta) => {
          listadas.push(pasta);
          if (pasta === ORG) throw new Error("armazem_lista: StorageApiError 400: Bucket not found");
          return listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`));
        },
      },
    );
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1 });
    expect(listadas).toEqual([ORG]);
    expect(apagadosDoStorage).toEqual([]);
  });

  it("bucket ausente ao apagar: aborta sem seguir para os próximos lotes nem organizações", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [
      { caminho: caminho("b"), criadoEm: horasAtras(48) },
      { caminho: caminho("c"), criadoEm: horasAtras(48) },
      { caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) },
    ];
    const tentativas: string[][] = [];
    const d = disco(
      { lote: 1 },
      {
        apagar: async (caminhos) => {
          tentativas.push(caminhos);
          throw new Error("armazem_remocao: StorageApiError 400: Bucket not found");
        },
      },
    );
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1 });
    expect(tentativas).toEqual([[caminho("b")]]);
  });

  it("outra falha ao listar uma organização: pula só ela, e as outras são limpas", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [{ caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) }];
    const d = disco(
      {},
      {
        listarObjetos: async (pasta) => {
          if (pasta === ORG) throw new Error("armazem_lista: TypeError: fetch failed");
          return listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`));
        },
      },
    );
    expect(await d.limparStorage()).toEqual({ apagados: 1, falhas: 1 });
    expect(apagadosDoStorage).toEqual([caminho("b", OUTRA)]);
  });

  it("banco fora: sem conferir a referência, não apaga nada, e não lança", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
    bancoFora = true;
    expect(await disco().limparStorage()).toEqual({ apagados: 0, falhas: 1 });
    expect(apagadosDoStorage).toEqual([]);
  });

  it("Storage fora do ar: conta a falha e não lança", async () => {
    const d = disco({}, { listarPastas: async () => Promise.reject(new Error("armazem_lista: TypeError: fetch failed")) });
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1 });
  });
});

describe("falasNoDiscoDaInstalacao — a fiação do worker", () => {
  it("usa o armazém da instalação (sem ElevenLabs no caminho) e não toca o Storage ao nascer", async () => {
    const falso = { ...armazem(), enviar: vi.fn() } as PortaDoArmazem;
    vi.mocked(armazemDaInstalacao).mockReturnValueOnce(falso);
    const f = falasNoDiscoDaInstalacao(db, log);
    expect(f).toBeInstanceOf(FalasNoDisco);
    expect(armazemDaInstalacao).toHaveBeenCalledTimes(1);
    expect(baixar).not.toHaveBeenCalled();
  });
});
