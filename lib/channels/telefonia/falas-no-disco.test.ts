// @vitest-environment node
/**
 * As falas no disco (desenho da fase 2, §4 e D12) contra um `fs` DE VERDADE num
 * diretório temporário — o volume — e um armazém falso no lugar do Storage. O
 * relógio é injetado (`relogio`): as carências e a escada de tentativas são
 * provadas avançando-o, sem esperar.
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
  ARMAZEM_SEM_STORAGE,
  CARENCIA_DO_ORFAO_MS,
  CARENCIA_DO_TEMPORARIO_MS,
  DIRETORIO_DAS_FALAS,
  DIRETORIO_NO_ASTERISK,
  ESCADA_DE_TENTATIVAS_MS,
  FalasNoDisco,
  INTERVALO_DA_LIMPEZA_MS,
  JANELA_DO_STORAGE_MS,
  caminhoValido,
  falasDoWorker,
  falasNoDiscoDaInstalacao,
  midiaDaFala,
  type OpcoesDasFalasNoDisco,
} from "./falas-no-disco";

const { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } = fs;

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const MINUTO = 60_000;
const hash = (c: string) => c.repeat(64);
const caminho = (c: string, org = ORG) => `${org}/${hash(c)}.ulaw`;

// ─── o relógio ───────────────────────────────────────────────────────────────

let relogio: number;
const avancar = (ms: number) => {
  relogio += ms;
};

// ─── o banco falso: as linhas de `phone_prompts` que importam aqui ──────────

interface Linha {
  organization_id: string;
  storage_path: string | null;
  status: "ready" | "failed";
}
let linhas: Linha[];
/** A ordem do que aconteceu, para provar que a referência é lida logo antes de cada `apagar`. */
let eventos: Array<
  | { tipo: "consulta_referencias"; org: string; caminhos: string[] }
  | { tipo: "consulta_prontas"; limite: number }
  | { tipo: "apagar"; caminhos: string[] }
>;
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
      return resposta(
        linhas.filter((l) => l.organization_id === org && l.storage_path !== null && caminhos.includes(l.storage_path)).map((l) => l.storage_path!),
      );
    }
    throw new Error(`consulta inesperada: ${sql}`);
  }) as unknown as Queryable["query"],
};
const referenciar = (c: string, org = ORG) => linhas.push({ organization_id: org, storage_path: c, status: "ready" });
const desreferenciar = (c: string) => {
  linhas = linhas.filter((l) => l.storage_path !== c);
};

// ─── o Storage falso ─────────────────────────────────────────────────────────

/** O conteúdo dos objetos, para `baixar`. */
let objetos: Map<string, Uint8Array>;
let pastasNoStorage: string[];
/** O que `listarObjetos` devolve — e de onde `apagar` remove. */
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
let listarPastas: ReturnType<typeof vi.fn<PortaDoArmazem["listarPastas"]>>;

function armazem(extra: Partial<PortaDoArmazem> = {}): Pick<PortaDoArmazem, "baixar" | "listarPastas" | "listarObjetos" | "apagar"> {
  return {
    baixar: (c, o) => baixar(c, o),
    listarPastas: () => listarPastas(),
    listarObjetos: async (pasta) => listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`)),
    apagar: async (caminhos) => {
      eventos.push({ tipo: "apagar", caminhos: [...caminhos] });
      // Como o Storage: devolve só o que existia e saiu.
      const removidos = caminhos.filter((c) => listaDoStorage.some((o) => o.caminho === c));
      listaDoStorage = listaDoStorage.filter((o) => !removidos.includes(o.caminho));
      apagadosDoStorage.push(...removidos);
      return removidos;
    },
    ...extra,
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dir: string;
const disco = (opcoes: OpcoesDasFalasNoDisco = {}, extra: Partial<PortaDoArmazem> = {}) =>
  new FalasNoDisco(dir, db, armazem(extra), log, { agora: () => relogio, ...opcoes });
const horasAtras = (h: number) => new Date(relogio - h * 3_600_000);
const noDisco = (c: string) => join(dir, c);
async function gravarNoDisco(c: string, bytes: number[], idadeMs = 0) {
  await mkdir(dirname(noDisco(c)), { recursive: true });
  await writeFile(noDisco(c), new Uint8Array(bytes));
  if (idadeMs > 0) {
    const quando = new Date(relogio - idadeMs);
    await utimes(noDisco(c), quando, quando);
  }
}
const existe = (c: string) =>
  stat(noDisco(c)).then(
    () => true,
    () => false,
  );
/** As mensagens registradas num nível, para contar avisos. */
const mensagens = (nivel: "info" | "warn" | "error") => log[nivel].mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "falas-"));
  relogio = Date.now();
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
  listarPastas = vi.fn<PortaDoArmazem["listarPastas"]>(async () => [...pastasNoStorage]);
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

  it("as réguas de tempo: órfão 15 min, temporário 5 min, Storage 24 h, limpeza a cada 10 min, escada 1/5/30/60 min", () => {
    expect(CARENCIA_DO_ORFAO_MS).toBe(15 * MINUTO);
    expect(CARENCIA_DO_TEMPORARIO_MS).toBe(5 * MINUTO);
    expect(JANELA_DO_STORAGE_MS).toBe(24 * 60 * MINUTO);
    expect(INTERVALO_DA_LIMPEZA_MS).toBe(10 * MINUTO);
    expect(ESCADA_DE_TENTATIVAS_MS).toEqual([MINUTO, 5 * MINUTO, 30 * MINUTO, 60 * MINUTO]);
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

describe("sincronizar — a passada de 60 s baixa o que falta", () => {
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

  it("Storage fora do ar: para de tentar na 3ª falha seguida (a passada não vira N prazos)", async () => {
    linhas = ["a", "b", "c", "d", "e"].map((c) => ({ organization_id: ORG, storage_path: caminho(c), status: "ready" as const }));
    baixar.mockRejectedValue(new Error("armazem_download: TypeError: fetch failed"));
    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 3 });
    expect(baixar).toHaveBeenCalledTimes(3);
  });

  it("banco fora: nada é apagado do disco (sem saber quem referencia, ninguém é órfão) e não lança", async () => {
    await gravarNoDisco(caminho("d"), [4]);
    const d = disco();
    await d.sincronizar(); // visto órfão
    avancar(CARENCIA_DO_ORFAO_MS);
    bancoFora = true;
    const r = await d.sincronizar();
    expect(r.apagadas).toBe(0);
    expect(r.falhas).toBeGreaterThan(0);
    expect(await existe(caminho("d"))).toBe(true);
  });

  it("caminho fora da régua vindo do banco (CHECK furado): não baixa, não escreve fora do volume, e avisa uma vez só", async () => {
    linhas = [{ organization_id: ORG, storage_path: `${ORG}/../../fora.ulaw`, status: "ready" }];
    const d = disco();
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 1 });
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 1 });
    expect(baixar).not.toHaveBeenCalled();
    expect(mensagens("warn").filter((m) => m.includes("fora da régua"))).toHaveLength(1);
  });

  it("volume ainda sem nada: cria a raiz e não falha", async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await disco().sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 0 });
  });
});

describe("sincronizar — fala pronta sem objeto no Storage: tentativas espaçadas, um aviso só", () => {
  it("a passada espaça as tentativas em 1, 5, 30 e 60 min, e depois de hora em hora", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("9"), status: "ready" }];
    const d = disco();
    const tentativasApos = async (ms: number) => {
      avancar(ms);
      await d.sincronizar();
      return baixar.mock.calls.length;
    };
    expect(await tentativasApos(0)).toBe(1);
    expect(await tentativasApos(MINUTO - 1)).toBe(1);
    expect(await tentativasApos(1)).toBe(2); // 1 min depois da 1ª
    expect(await tentativasApos(5 * MINUTO - 1)).toBe(2);
    expect(await tentativasApos(1)).toBe(3); // 5 min depois da 2ª
    expect(await tentativasApos(30 * MINUTO - 1)).toBe(3);
    expect(await tentativasApos(1)).toBe(4); // 30 min depois da 3ª
    expect(await tentativasApos(60 * MINUTO - 1)).toBe(4);
    expect(await tentativasApos(1)).toBe(5); // 60 min depois da 4ª
    expect(await tentativasApos(60 * MINUTO)).toBe(6); // e de hora em hora
  });

  it("registra UMA vez na primeira falha, e uma vez quando o áudio volta", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("9"), status: "ready" }];
    const d = disco();
    for (let i = 0; i < 6; i++) {
      await d.sincronizar();
      avancar(60 * MINUTO);
    }
    expect(baixar.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mensagens("warn").filter((m) => m.includes("sem áudio no Storage"))).toHaveLength(1);

    objetos.set(caminho("9"), new Uint8Array([9]));
    expect(await d.sincronizar()).toEqual({ baixadas: 1, apagadas: 0, falhas: 0 });
    expect(mensagens("info").filter((m) => m.includes("voltou ao Storage"))).toHaveLength(1);
    avancar(60 * MINUTO);
    await d.sincronizar();
    expect(mensagens("warn").filter((m) => m.includes("sem áudio no Storage"))).toHaveLength(1);
    expect(mensagens("info").filter((m) => m.includes("voltou ao Storage"))).toHaveLength(1);
  });

  it("a ligação não espera a escada: garantir tenta na hora (salvar de novo conserta) e não repete o aviso", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("9"), status: "ready" }];
    const d = disco();
    await d.sincronizar();
    expect(await d.garantir({ id: "f", storagePath: caminho("9") })).toBeNull();
    expect(baixar).toHaveBeenCalledTimes(2);
    expect(mensagens("warn").filter((m) => m.includes("sem áudio no Storage"))).toHaveLength(1);
    objetos.set(caminho("9"), new Uint8Array([9]));
    expect(await d.garantir({ id: "f", storagePath: caminho("9") })).toBe(midiaDaFala(caminho("9")));
    expect(mensagens("info").filter((m) => m.includes("voltou ao Storage"))).toHaveLength(1);
  });

  it("a fala que deixou de estar pronta sai da escada (a memória não cresce com fala velha)", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("9"), status: "ready" }];
    const d = disco();
    await d.sincronizar();
    linhas = [];
    avancar(MINUTO);
    await d.sincronizar();
    // Voltou a ser pronta (mesmo caminho): é tratada como nova — tenta já e avisa de novo.
    linhas = [{ organization_id: ORG, storage_path: caminho("9"), status: "ready" }];
    await d.sincronizar();
    expect(baixar).toHaveBeenCalledTimes(2);
    expect(mensagens("warn").filter((m) => m.includes("sem áudio no Storage"))).toHaveLength(2);
  });
});

describe("sincronizar — Storage, disco e banco fora do ar: registra na transição, não em toda passada", () => {
  it("Storage caiu: um aviso; passadas seguintes caladas; um registro quando volta", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("a"), status: "ready" }];
    baixar.mockRejectedValue(new Error("armazem_download: TypeError: fetch failed"));
    const d = disco();
    for (let i = 0; i < 5; i++) await d.sincronizar();
    expect(baixar).toHaveBeenCalledTimes(5);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(mensagens("warn")[0]).toMatch(/Storage/);

    baixar.mockImplementation(baixarPadrao);
    objetos.set(caminho("a"), new Uint8Array([1]));
    await d.sincronizar();
    expect(mensagens("info").filter((m) => m.includes("Storage das falas voltou"))).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("banco fora: um aviso por queda, não por passada", async () => {
    bancoFora = true;
    const d = disco();
    for (let i = 0; i < 4; i++) await d.sincronizar();
    expect(log.warn).toHaveBeenCalledTimes(1);
    bancoFora = false;
    await d.sincronizar();
    expect(mensagens("info").filter((m) => m.includes("banco"))).toHaveLength(1);
  });
});

describe("sincronizar — volume e gravação são frentes separadas", () => {
  it("volume inacessível que volta SEM nada para baixar: um aviso quando cai, um registro quando volta", async () => {
    const bloqueio = join(dir, "bloqueio");
    await writeFile(bloqueio, new Uint8Array([0])); // um ARQUIVO onde devia haver pasta: a raiz do volume não nasce
    const d = new FalasNoDisco(join(bloqueio, "falas"), db, armazem(), log, { agora: () => relogio });
    for (let i = 0; i < 3; i++) expect((await d.sincronizar()).falhas).toBe(1);
    expect(mensagens("warn").filter((m) => m.includes("inacessível"))).toHaveLength(1);

    await rm(bloqueio);
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 0 });
    await d.sincronizar();
    expect(mensagens("info").filter((m) => m.includes("volume das falas voltou a ficar acessível"))).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("disco cheio: a pasta segue legível e a escrita falha — um aviso só, sem alternar a cada passada; volta na próxima escrita boa", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("a"), status: "ready" }];
    objetos.set(caminho("a"), new Uint8Array([1]));
    for (let i = 0; i < 4; i++) {
      vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device, open"), { code: "ENOSPC" }));
    }
    const d = disco();
    for (let i = 0; i < 4; i++) {
      expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 1 });
      avancar(MINUTO);
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(mensagens("warn")[0]).toContain("não gravada");
    expect(mensagens("info").filter((m) => m.includes("voltou"))).toEqual([]);

    expect(await d.sincronizar()).toEqual({ baixadas: 1, apagadas: 0, falhas: 0 });
    expect(mensagens("info").filter((m) => m.includes("voltou a aceitar gravação"))).toHaveLength(1);
    expect(mensagens("info").filter((m) => m.includes("voltou a ficar acessível"))).toEqual([]);
  });

  it("bucket ausente visto pela passada é registrado como BUCKET (erro), não como Storage fora; e volta como bucket", async () => {
    linhas = [{ organization_id: ORG, storage_path: caminho("a"), status: "ready" }];
    baixar.mockRejectedValue(new Error("armazem_download: StorageApiError 400: Bucket not found"));
    const d = disco();
    await d.sincronizar();
    await d.sincronizar();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(mensagens("error")[0]).toMatch(/bucket/);
    expect(mensagens("warn").filter((m) => m.includes("Storage das falas não responde"))).toEqual([]);

    baixar.mockImplementation(baixarPadrao);
    objetos.set(caminho("a"), new Uint8Array([1]));
    await d.sincronizar();
    expect(mensagens("info").filter((m) => m.includes("bucket das falas voltou"))).toHaveLength(1);
  });
});

describe("sincronizar — o órfão do disco sai 15 min depois de VISTO órfão, não pelo mtime", () => {
  it("órfão recém-avistado fica, mesmo com mtime antigo; sai 15 min depois do primeiro avistamento", async () => {
    await gravarNoDisco(caminho("d"), [4], 30 * 24 * 60 * MINUTO); // arquivo de um mês atrás
    const d = disco();
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 0 });
    avancar(CARENCIA_DO_ORFAO_MS - 1);
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 0, falhas: 0 });
    expect(await existe(caminho("d"))).toBe(true);
    avancar(1);
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 1, falhas: 0 });
    expect(await existe(caminho("d"))).toBe(false);
  });

  it("voltou a ter referência: sai do mapa — e, órfão de novo, a carência recomeça", async () => {
    await gravarNoDisco(caminho("d"), [4]);
    const d = disco();
    await d.sincronizar(); // visto órfão em T0
    avancar(10 * MINUTO);
    referenciar(caminho("d"));
    await d.sincronizar(); // referenciado: sai do mapa
    avancar(6 * MINUTO); // T0 + 16 min
    desreferenciar(caminho("d"));
    expect((await d.sincronizar()).apagadas).toBe(0); // órfão de NOVO: primeiro avistamento agora
    avancar(CARENCIA_DO_ORFAO_MS - 1);
    expect((await d.sincronizar()).apagadas).toBe(0);
    avancar(1);
    expect((await d.sincronizar()).apagadas).toBe(1);
  });

  it("reiniciar o worker zera o mapa: a remoção só ATRASA", async () => {
    await gravarNoDisco(caminho("d"), [4]);
    await disco().sincronizar(); // visto órfão em T0 pelo worker antigo
    avancar(CARENCIA_DO_ORFAO_MS + MINUTO);
    const reiniciado = disco();
    expect((await reiniciado.sincronizar()).apagadas).toBe(0);
    avancar(CARENCIA_DO_ORFAO_MS);
    expect((await reiniciado.sincronizar()).apagadas).toBe(1);
  });

  it("a referência é consultada COM a organização da pasta", async () => {
    await gravarNoDisco(caminho("d"), [4]);
    await gravarNoDisco(caminho("d", OUTRA), [4]);
    // A linha é da OUTRA organização: o arquivo de ORG com o mesmo hash continua órfão.
    linhas = [{ organization_id: OUTRA, storage_path: caminho("d", OUTRA), status: "ready" }];
    const d = disco();
    await d.sincronizar();
    avancar(CARENCIA_DO_ORFAO_MS);
    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 1, falhas: 0 });
    expect(await existe(caminho("d"))).toBe(false);
    expect(await existe(caminho("d", OUTRA))).toBe(true);
    const orgs = new Set(eventos.flatMap((e) => (e.tipo === "consulta_referencias" ? [e.org] : [])));
    expect([...orgs].sort()).toEqual([ORG, OUTRA].sort());
  });

  it("só mexe no que é seu: referenciado fica (em qualquer estado), temporário largado sai pelo mtime, nome estranho e pasta que não é organização ficam", async () => {
    linhas = [
      { organization_id: ORG, storage_path: caminho("a"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("f"), status: "failed" },
    ];
    await gravarNoDisco(caminho("a"), [1]);
    await gravarNoDisco(caminho("f"), [1]);
    await gravarNoDisco(`${ORG}/.${hash("7")}.abc.tmp`, [0], CARENCIA_DO_TEMPORARIO_MS); // largado por uma queda: sai
    await gravarNoDisco(`${ORG}/.${hash("8")}.def.tmp`, [0]); // escrita em curso: fica
    await gravarNoDisco(`${ORG}/LEIA-ME.txt`, [0]);
    await gravarNoDisco(`nao-e-org/${hash("9")}.ulaw`, [0]);
    await writeFile(join(dir, "solto.ulaw"), new Uint8Array([0]));
    const d = disco();

    expect(await d.sincronizar()).toEqual({ baixadas: 0, apagadas: 1, falhas: 0 });
    avancar(CARENCIA_DO_ORFAO_MS);
    await d.sincronizar();
    // Depois da carência, o temporário "em curso" também é velho e sai; o resto continua.
    expect((await readdir(join(dir, ORG))).sort()).toEqual([`${hash("a")}.ulaw`, `${hash("f")}.ulaw`, "LEIA-ME.txt"].sort());
    expect(await readdir(join(dir, "nao-e-org"))).toEqual([`${hash("9")}.ulaw`]);
    expect(await existe("solto.ulaw")).toBe(true);
  });

  it("a ligação em curso: a fala ANTIGA continua tocável durante a carência, no disco e no Storage", async () => {
    // "Aguarde" A está em uso, no disco e no Storage, gravado há dias.
    referenciar(caminho("a"));
    objetos.set(caminho("a"), new Uint8Array([1]));
    listaDoStorage = [{ caminho: caminho("a"), criadoEm: horasAtras(72) }];
    pastasNoStorage = [ORG];
    const d = disco();
    await d.sincronizar();
    await d.limparStorage();
    const antiga = { id: "aguarde", storagePath: caminho("a") }; // o que a ligação guardou ao entrar

    // "Salvar e usar" troca o texto: A deixa de ser referenciada.
    desreferenciar(caminho("a"));
    referenciar(caminho("b"));
    objetos.set(caminho("b"), new Uint8Array([2]));

    // A passada roda a cada minuto; o "aguarde" repete a cada ~40 s — tocável durante toda a carência.
    for (let t = 0; t < CARENCIA_DO_ORFAO_MS; t += MINUTO) {
      await d.sincronizar();
      await d.limparStorage();
      expect(await d.garantir(antiga), `aos ${t / MINUTO} min`).toBe(midiaDaFala(caminho("a")));
      avancar(MINUTO);
    }
    expect(apagadosDoStorage).toEqual([]);

    // Passada a carência, A sai do disco e, na limpeza seguinte, do Storage.
    await d.sincronizar();
    expect(await existe(caminho("a"))).toBe(false);
    avancar(INTERVALO_DA_LIMPEZA_MS);
    await d.limparStorage();
    expect(apagadosDoStorage).toEqual([caminho("a")]);
    expect(await existe(caminho("b"))).toBe(true);
  });
});

describe("limparStorage — prévia não salva e áudio sem uso saem do Storage (desenho §4)", () => {
  /** Primeira limpeza avista os órfãos; a segunda, depois da carência, apaga. */
  async function limparDuasVezes(d: FalasNoDisco) {
    const primeira = await d.limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    const segunda = await d.limparStorage();
    return { primeira, segunda };
  }

  it("regra dupla: mais de 24 h de criação E órfão visto há pelo menos 15 min", async () => {
    pastasNoStorage = [ORG];
    linhas = [
      { organization_id: ORG, storage_path: caminho("a"), status: "ready" },
      { organization_id: ORG, storage_path: caminho("f"), status: "failed" },
    ];
    listaDoStorage = [
      { caminho: caminho("a"), criadoEm: horasAtras(48) }, // em uso: fica
      { caminho: caminho("f"), criadoEm: horasAtras(48) }, // referenciado por linha failed: fica
      { caminho: caminho("b"), criadoEm: horasAtras(48) }, // sem uso e velho: sai depois da carência
      { caminho: caminho("c"), criadoEm: horasAtras(2) }, // prévia recém-gerada, ainda sem linha: fica
      { caminho: caminho("d"), criadoEm: horasAtras(23.9) }, // só passa de 24 h na 2ª limpeza, e só ali é avistado órfão: fica
      { caminho: caminho("e"), criadoEm: new Date("não é data") }, // data ilegível: fica
    ];
    const { primeira, segunda } = await limparDuasVezes(disco());
    expect(primeira).toEqual({ apagados: 0, falhas: 0, pulada: false });
    expect(segunda).toEqual({ apagados: 1, falhas: 0, pulada: false });
    expect(apagadosDoStorage).toEqual([caminho("b")]);
  });

  it("voltou a ter referência entre duas limpezas: sai do mapa, e a carência recomeça", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
    const d = disco();
    await d.limparStorage(); // avistado em T0
    avancar(INTERVALO_DA_LIMPEZA_MS);
    referenciar(caminho("b"));
    await d.limparStorage(); // referenciado: sai do mapa
    avancar(INTERVALO_DA_LIMPEZA_MS);
    desreferenciar(caminho("b"));
    expect((await d.limparStorage()).apagados).toBe(0); // T0 + 20 min, mas órfão de novo só agora
    avancar(INTERVALO_DA_LIMPEZA_MS);
    expect((await d.limparStorage()).apagados).toBe(0);
    avancar(INTERVALO_DA_LIMPEZA_MS);
    expect((await d.limparStorage()).apagados).toBe(1);
  });

  it("reiniciar o worker zera o mapa: só atrasa", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
    await disco().limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    const reiniciado = disco();
    expect((await reiniciado.limparStorage()).apagados).toBe(0);
    avancar(CARENCIA_DO_ORFAO_MS);
    expect((await reiniciado.limparStorage()).apagados).toBe(1);
  });

  it("o áudio de um menu arquivado sai: arquivar apaga as linhas das falas, e o objeto fica sem referência", async () => {
    pastasNoStorage = [ORG];
    linhas = []; // o menu foi arquivado e as falas dele, apagadas
    listaDoStorage = [
      { caminho: caminho("4"), criadoEm: horasAtras(24 * 30) },
      { caminho: caminho("5"), criadoEm: horasAtras(24 * 30) },
    ];
    expect((await limparDuasVezes(disco())).segunda).toEqual({ apagados: 2, falhas: 0, pulada: false });
    expect(apagadosDoStorage.sort()).toEqual([caminho("4"), caminho("5")].sort());
  });

  it("conta só o que o Storage DE FATO removeu", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [
      { caminho: caminho("b"), criadoEm: horasAtras(48) },
      { caminho: caminho("c"), criadoEm: horasAtras(48) },
    ];
    const d = disco(
      {},
      {
        apagar: async (caminhos) => {
          apagadosDoStorage.push(...caminhos.slice(0, 1));
          return caminhos.slice(0, 1); // o outro já não existia quando o pedido chegou
        },
      },
    );
    expect((await limparDuasVezes(d)).segunda).toEqual({ apagados: 1, falhas: 0, pulada: false });
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
    const d = disco(
      {},
      {
        listarObjetos: async (pasta) => {
          listadas.push(pasta);
          return listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`));
        },
      },
    );
    const { segunda } = await limparDuasVezes(d);
    expect(segunda).toEqual({ apagados: 0, falhas: 0, pulada: false });
    expect(new Set(listadas)).toEqual(new Set([ORG]));
    expect(eventos.some((e) => e.tipo === "apagar")).toBe(false);
  });

  it("objeto listado numa pasta com caminho de OUTRA organização não é apagado por ela", async () => {
    pastasNoStorage = [ORG];
    const d = disco({}, { listarObjetos: async () => [{ caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) }] });
    expect((await limparDuasVezes(d)).segunda).toEqual({ apagados: 0, falhas: 0, pulada: false });
    expect(eventos.some((e) => e.tipo === "apagar")).toBe(false);
  });

  it("a referência é lida IMEDIATAMENTE antes de CADA apagar, com a organização, e cobre tudo o que vai ser apagado", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [
      ...["b", "c", "d"].map((c) => ({ caminho: caminho(c), criadoEm: horasAtras(48) })),
      ...["b", "c"].map((c) => ({ caminho: caminho(c, OUTRA), criadoEm: horasAtras(48) })),
    ];
    const d = disco({ lote: 2 });
    await d.limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    eventos = [];
    expect(await d.limparStorage()).toEqual({ apagados: 5, falhas: 0, pulada: false });

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
    let armado = false;
    const d = disco(
      { lote: 1 },
      {
        apagar: async (caminhos) => {
          apagadosDoStorage.push(...caminhos);
          // Depois do primeiro apagar, alguém salva uma fala que reaproveita "c".
          if (armado) referenciar(caminho("c"));
          return caminhos;
        },
      },
    );
    await d.limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    armado = true;
    expect(await d.limparStorage()).toEqual({ apagados: 1, falhas: 0, pulada: false });
    expect(apagadosDoStorage).toEqual([caminho("b")]);
  });

  it("o que passou a ser usado entre a listagem e o apagar não é apagado", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
    let armado = false;
    const d = disco(
      {},
      {
        listarObjetos: async () => {
          if (armado) referenciar(caminho("b"));
          return [...listaDoStorage];
        },
      },
    );
    await d.limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    armado = true;
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 0, pulada: false });
    expect(apagadosDoStorage).toEqual([]);
  });

  it("bucket ausente ao listar as pastas: aborta a passada, não apaga nada e grita no log", async () => {
    listarPastas.mockRejectedValue(new Error("armazem_lista: StorageApiError 400: Bucket not found"));
    const d = disco();
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
    expect(eventos.some((e) => e.tipo === "apagar")).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("bucket"), expect.anything());
  });

  it("bucket ausente ao listar uma organização: aborta — as organizações seguintes nem são olhadas", async () => {
    pastasNoStorage = [ORG, OUTRA];
    listaDoStorage = [{ caminho: caminho("b", OUTRA), criadoEm: horasAtras(48) }];
    const listadas: string[] = [];
    let quebrado = false;
    const d = disco(
      {},
      {
        listarObjetos: async (pasta) => {
          listadas.push(pasta);
          if (quebrado && pasta === ORG) throw new Error("armazem_lista: StorageApiError 400: Bucket not found");
          return listaDoStorage.filter((o) => o.caminho.startsWith(`${pasta}/`));
        },
      },
    );
    await d.limparStorage(); // avista o órfão de OUTRA
    avancar(CARENCIA_DO_ORFAO_MS);
    quebrado = true;
    listadas.length = 0;
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
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
    const { segunda } = await limparDuasVezes(d);
    expect(segunda).toEqual({ apagados: 0, falhas: 1, pulada: false });
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
    const { segunda } = await limparDuasVezes(d);
    expect(segunda).toEqual({ apagados: 1, falhas: 1, pulada: false });
    expect(apagadosDoStorage).toEqual([caminho("b", OUTRA)]);
  });

  it("banco fora: sem conferir a referência, não apaga nada, e não lança", async () => {
    pastasNoStorage = [ORG];
    listaDoStorage = [{ caminho: caminho("b"), criadoEm: horasAtras(48) }];
    const d = disco();
    await d.limparStorage();
    avancar(CARENCIA_DO_ORFAO_MS);
    bancoFora = true;
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
    expect(apagadosDoStorage).toEqual([]);
  });

  it("Storage fora do ar: conta a falha, não lança, e avisa uma vez por queda", async () => {
    listarPastas.mockRejectedValue(new Error("armazem_lista: TypeError: fetch failed"));
    const d = disco();
    for (let i = 0; i < 4; i++) {
      expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
      avancar(INTERVALO_DA_LIMPEZA_MS);
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    listarPastas.mockResolvedValue([]);
    await d.limparStorage();
    expect(mensagens("info").filter((m) => m.includes("Storage das falas voltou"))).toHaveLength(1);
  });
});

describe("limparStorage — o freio de 10 min", () => {
  it("depois de uma limpeza bem-sucedida, só roda de novo 10 min depois", async () => {
    pastasNoStorage = [ORG];
    const d = disco();
    expect((await d.limparStorage()).pulada).toBe(false);
    avancar(INTERVALO_DA_LIMPEZA_MS - 1);
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 0, pulada: true });
    expect(listarPastas).toHaveBeenCalledTimes(1);
    avancar(1);
    expect((await d.limparStorage()).pulada).toBe(false);
    expect(listarPastas).toHaveBeenCalledTimes(2);
  });

  it("falha persistente numa organização: o freio arma assim mesmo — nada de limpeza a cada 60 s", async () => {
    pastasNoStorage = [ORG];
    const listarObjetos = vi.fn<PortaDoArmazem["listarObjetos"]>(async () => {
      throw new Error("armazem_lista: TypeError: fetch failed");
    });
    const d = disco({}, { listarObjetos });
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
    for (let t = MINUTO; t < INTERVALO_DA_LIMPEZA_MS; t += MINUTO) {
      avancar(MINUTO);
      expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 0, pulada: true });
    }
    expect(listarObjetos).toHaveBeenCalledTimes(1);
    avancar(MINUTO);
    expect((await d.limparStorage()).pulada).toBe(false);
    expect(listarObjetos).toHaveBeenCalledTimes(2);
  });

  it("bucket ausente aborta a passada, e o freio arma também: o bucket não volta em 60 s", async () => {
    listarPastas.mockRejectedValue(new Error("armazem_lista: StorageApiError 400: Bucket not found"));
    const d = disco();
    expect((await d.limparStorage()).falhas).toBe(1);
    avancar(MINUTO);
    expect(await d.limparStorage()).toEqual({ apagados: 0, falhas: 0, pulada: true });
    expect(listarPastas).toHaveBeenCalledTimes(1);
    avancar(INTERVALO_DA_LIMPEZA_MS);
    await d.limparStorage();
    expect(listarPastas).toHaveBeenCalledTimes(2);
  });
});

describe("falasNoDiscoDaInstalacao — a fiação do worker", () => {
  it("usa o armazém da instalação (sem ElevenLabs no caminho) e não toca o Storage ao nascer", () => {
    const falso = { ...armazem(), enviar: vi.fn() } as PortaDoArmazem;
    vi.mocked(armazemDaInstalacao).mockReturnValueOnce(falso);
    const f = falasNoDiscoDaInstalacao(db, log);
    expect(f).toBeInstanceOf(FalasNoDisco);
    expect(armazemDaInstalacao).toHaveBeenCalledTimes(1);
    expect(baixar).not.toHaveBeenCalled();
    expect(listarPastas).not.toHaveBeenCalled();
  });
});

describe("falasDoWorker e o armazém de reserva — o disco do laço do worker", () => {
  it("usa o disco da instalação quando o cliente do Storage existe", () => {
    vi.mocked(armazemDaInstalacao).mockReturnValueOnce({ ...armazem(), enviar: vi.fn() } as PortaDoArmazem);
    expect(falasDoWorker(db, log)).toBeInstanceOf(FalasNoDisco);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("sem cliente do Storage, o mesmo volume com a reserva — e o log diz por quê UMA vez", async () => {
    vi.mocked(armazemDaInstalacao).mockImplementationOnce(() => {
      throw new Error("supabaseUrl is required.");
    });
    const falas = falasDoWorker(db, log);

    expect(falas).toBeInstanceOf(FalasNoDisco);
    expect(mensagens("error")).toEqual(["telefonia: sem cliente do Storage — as falas do telefone não chegam ao disco"]);
    // A ligação pula a fala (null), a limpeza não apaga nada — e nada lança. Só
    // `stat` no volume da instalação: nada é escrito fora do diretório de teste.
    expect(await falas.garantir({ id: "f1", storagePath: caminho("a") })).toBeNull();
    expect(await falas.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
  });

  it("a reserva FALHA na leitura (não é 'objeto ausente') e o apagar não remove nada", async () => {
    // `null` no baixar quer dizer "o objeto não existe" (lib/telefonia/armazem.ts);
    // aqui ninguém perguntou ao Storage — é falha, registrada uma vez na transição,
    // e não uma "fala pronta sem áudio" por fala.
    await expect(ARMAZEM_SEM_STORAGE.baixar(caminho("a"))).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.listarPastas()).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.listarObjetos(ORG)).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.apagar([caminho("a")])).resolves.toEqual([]);
  });

  it("com a reserva, a passada registra UMA queda do Storage, não uma 'fala sem áudio' por fala", async () => {
    referenciar(caminho("a"));
    referenciar(caminho("b"));
    const d = new FalasNoDisco(dir, db, ARMAZEM_SEM_STORAGE, log, { agora: () => relogio });
    await d.sincronizar();
    await d.limparStorage();
    avancar(INTERVALO_DA_LIMPEZA_MS);
    await d.sincronizar();
    await d.limparStorage();

    expect(mensagens("warn")).toEqual(["telefonia: o Storage das falas não responde"]);
    expect(mensagens("info")).toEqual([]);
    expect(await existe(caminho("a"))).toBe(false);
  });
});
