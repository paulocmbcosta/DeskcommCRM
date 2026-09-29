// @vitest-environment node
/**
 * O laço da telefonia no worker — a parte que NÃO depende da ARI: a passada de
 * 60 s das falas (Storage → volume), da limpeza do Storage e dos avisos de
 * instabilidade vencidos (desenho da fase 2, §4 e §5.5).
 *
 * Três perguntas:
 *  1. a passada roda as três etapas, e a falha de uma não derruba as outras nem
 *     a próxima passada — nem inunda o log (a queda é registrada na transição);
 *  2. sem cliente do Storage, o disco das falas nasce com o armazém de reserva,
 *     que FALHA (não finge "objeto ausente") e nunca apaga nada;
 *  3. a fiação de `runTelefoniaLoop`: com a telefonia desligada nada roda (o
 *     worker não escreve no volume); ligada, a passada roda ao subir e a cada
 *     60 s mesmo com o Asterisk fora, e o controlador recebe o disco das falas.
 *
 * A ARI, o controlador e o sincronizador são falsos: aqui só se mede a fiação.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloAri from "./ari";
import type * as ModuloControle from "./controle";
import type * as ModuloFalas from "./falas-no-disco";
import type * as ModuloRepositorio from "./repositorio";

const h = vi.hoisted(() => {
  const controladores: unknown[][] = [];
  class ControladorFalso {
    ativas = 0;
    constructor(...args: unknown[]) {
      controladores.push(args);
    }
    usarFila() {}
    async recuperar() {}
    async tratar() {}
  }
  class SincronizadorFalso {
    async sincronizar() {}
    async atualizarEstados() {}
  }
  /** O Asterisk nunca responde: o laço fica reconectando, e a passada tem de rodar assim mesmo. */
  class ClienteAriFalso {
    abrirEventos(): never {
      throw new Error("sem Asterisk no teste");
    }
  }
  return {
    controladores,
    ControladorFalso,
    SincronizadorFalso,
    ClienteAriFalso,
    config: { valor: null as null | { baseUrl: string; senha: string } },
  };
});

vi.mock("./ari", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloAri>()),
  ClienteAri: h.ClienteAriFalso,
  configAriDoAmbiente: () => h.config.valor,
}));
vi.mock("./controle", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloControle>()),
  ControladorDeChamadas: h.ControladorFalso,
}));
vi.mock("./sincronizacao", () => ({ SincronizadorDeTroncos: h.SincronizadorFalso }));
vi.mock("./falas-no-disco", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloFalas>()),
  falasNoDiscoDaInstalacao: vi.fn(),
}));
vi.mock("./repositorio", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloRepositorio>()),
  desligarAvisosVencidos: vi.fn(),
}));

import type pg from "pg";

import { FalasNoDisco, falasNoDiscoDaInstalacao } from "./falas-no-disco";
import { ARMAZEM_SEM_STORAGE, falasDoWorker, passadaDoTelefone, runTelefoniaLoop } from "./laco";
import { desligarAvisosVencidos, type AvisoDesligado } from "./repositorio";

const ORG = "00000000-0000-4000-8000-00000000000a";
const TIME = "00000000-0000-4000-8000-0000000000b1";
const CAMINHO = `${ORG}/${"a".repeat(64)}.ulaw`;

function registro() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function falasFalsas() {
  return {
    sincronizar: vi.fn(async () => ({ baixadas: 0, apagadas: 0, falhas: 0 })),
    limparStorage: vi.fn(async () => ({ apagados: 0, falhas: 0, pulada: false })),
    garantir: vi.fn(async () => null),
  };
}

const pool = { query: vi.fn() } as unknown as pg.Pool;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  h.controladores.length = 0;
  h.config.valor = null;
});

// ─── 1. a passada ────────────────────────────────────────────────────────────

describe("passadaDoTelefone — as três etapas de 60 s", () => {
  it("desliga os avisos vencidos, sincroniza as falas e limpa o Storage — com o relógio da passada", async () => {
    const ordem: string[] = [];
    const falas = falasFalsas();
    falas.sincronizar.mockImplementation(async () => (ordem.push("sincronizar"), { baixadas: 0, apagadas: 0, falhas: 0 }));
    falas.limparStorage.mockImplementation(async () => (ordem.push("limparStorage"), { apagados: 0, falhas: 0, pulada: true }));
    const agora = new Date("2026-09-29T12:00:00Z");
    const desligar = vi.fn(async (_: Date) => (ordem.push("avisos"), [] as AvisoDesligado[]));
    const log = registro();

    await passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log, agora: () => agora })();

    // O aviso vencido primeiro: é um comando só, e não espera a sincronização
    // (que pode baixar arquivos por minutos) para aparecer desligado na Central.
    expect(ordem).toEqual(["avisos", "sincronizar", "limparStorage"]);
    expect(desligar).toHaveBeenCalledWith(agora);
    // Passada sem efeito não escreve nada no log (o log do worker é dividido com a IA).
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("cada aviso desligado vira UMA linha no log, com o time e a organização", async () => {
    const log = registro();
    const vencidos: AvisoDesligado[] = [
      { id: TIME, organizationId: ORG, nome: "Financeiro" },
      { id: "00000000-0000-4000-8000-0000000000b2", organizationId: ORG, nome: "Suporte" },
    ];
    await passadaDoTelefone({ falas: falasFalsas(), desligarAvisosVencidos: async () => vencidos, log })();

    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith("telefonia: aviso de instabilidade venceu e foi desligado", {
      team_id: TIME,
      organization_id: ORG,
    });
  });

  it.each([
    ["sincronizar", "falas no disco"],
    ["limparStorage", "limpeza do Storage das falas"],
    ["avisos", "avisos de instabilidade vencidos"],
  ] as const)("%s lançando não derruba as outras etapas nem a próxima passada — e o log registra só a transição", async (quem, etapa) => {
    const falas = falasFalsas();
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const quebrada = quem === "avisos" ? desligar : falas[quem];
    quebrada.mockRejectedValue(new Error("banco fora do ar"));
    const log = registro();
    const passada = passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log });

    await passada();
    await passada();
    await passada();

    expect(desligar).toHaveBeenCalledTimes(3);
    expect(falas.sincronizar).toHaveBeenCalledTimes(3);
    expect(falas.limparStorage).toHaveBeenCalledTimes(3);
    // Três passadas quebradas, UMA linha: a queda, não cada tentativa.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(`telefonia: a passada de ${etapa} falhou — tenta de novo a cada minuto`, {
      erro: "Error: banco fora do ar",
    });

    // Voltou: uma linha dizendo que voltou, e nada mais nas passadas seguintes.
    quebrada.mockReset();
    if (quem === "avisos") desligar.mockResolvedValue([]);
    else if (quem === "sincronizar") falas.sincronizar.mockResolvedValue({ baixadas: 0, apagadas: 0, falhas: 0 });
    else falas.limparStorage.mockResolvedValue({ apagados: 0, falhas: 0, pulada: true });
    await passada();
    await passada();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(`telefonia: a passada de ${etapa} voltou a funcionar`);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("não reentra: uma passada lenta não empilha outra", async () => {
    const falas = falasFalsas();
    let soltar!: () => void;
    falas.sincronizar.mockImplementationOnce(
      () => new Promise((r) => (soltar = () => r({ baixadas: 0, apagadas: 0, falhas: 0 }))),
    );
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const passada = passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log: registro() });

    const primeira = passada();
    await vi.waitFor(() => expect(falas.sincronizar).toHaveBeenCalledTimes(1));
    await passada(); // chega com a primeira ainda baixando: volta sem fazer nada
    expect(desligar).toHaveBeenCalledTimes(1);
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);

    soltar();
    await primeira;
    expect(falas.limparStorage).toHaveBeenCalledTimes(1);
    await passada(); // a primeira terminou: a próxima roda inteira
    expect(desligar).toHaveBeenCalledTimes(2);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
  });
});

// ─── 2. o disco das falas do worker ──────────────────────────────────────────

describe("falasDoWorker e o armazém de reserva", () => {
  it("usa o disco da instalação quando o cliente do Storage existe", () => {
    const daInstalacao = falasFalsas() as unknown as FalasNoDisco;
    vi.mocked(falasNoDiscoDaInstalacao).mockReturnValueOnce(daInstalacao);
    const log = registro();
    expect(falasDoWorker(pool, log)).toBe(daInstalacao);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("sem cliente do Storage, o mesmo volume com a reserva — e o log diz por quê UMA vez", async () => {
    vi.mocked(falasNoDiscoDaInstalacao).mockImplementationOnce(() => {
      throw new Error("supabaseUrl is required.");
    });
    const log = registro();
    const falas = falasDoWorker(pool, log);

    expect(falas).toBeInstanceOf(FalasNoDisco);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatch(/sem cliente do Storage/);
    // A ligação pula a fala (null), a limpeza não apaga nada — e nada lança.
    expect(await falas.garantir({ id: "f1", storagePath: CAMINHO })).toBeNull();
    expect(await falas.limparStorage()).toEqual({ apagados: 0, falhas: 1, pulada: false });
  });

  it("a reserva FALHA na leitura (não é 'objeto ausente') e o apagar não remove nada", async () => {
    // `null` no baixar quer dizer "o objeto não existe" (lib/telefonia/armazem.ts);
    // aqui ninguém perguntou ao Storage — é falha, registrada uma vez na transição,
    // e não uma "fala pronta sem áudio" por fala.
    await expect(ARMAZEM_SEM_STORAGE.baixar(CAMINHO)).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.listarPastas()).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.listarObjetos(ORG)).rejects.toThrow(/sem cliente do Storage/);
    await expect(ARMAZEM_SEM_STORAGE.apagar([CAMINHO])).resolves.toEqual([]);
  });
});

// ─── 3. a fiação do laço ─────────────────────────────────────────────────────

describe("runTelefoniaLoop — a passada no laço", () => {
  beforeEach(() => {
    vi.mocked(desligarAvisosVencidos).mockResolvedValue([]);
  });

  it("com a telefonia desligada, nada roda: o worker não escreve no volume nem mexe nos avisos", async () => {
    const log = registro();
    await runTelefoniaLoop({ pool, signal: new AbortController().signal, log });

    expect(falasNoDiscoDaInstalacao).not.toHaveBeenCalled();
    expect(desligarAvisosVencidos).not.toHaveBeenCalled();
    expect(h.controladores).toHaveLength(0);
  });

  it("ligada, a passada roda ao subir e a cada 60 s — mesmo com o Asterisk fora — e o controlador recebe o disco das falas", async () => {
    vi.useFakeTimers();
    h.config.valor = { baseUrl: "http://asterisk:8088", senha: "senha-de-teste" };
    const falas = falasFalsas();
    vi.mocked(falasNoDiscoDaInstalacao).mockReturnValue(falas as unknown as FalasNoDisco);
    const abortar = new AbortController();
    const log = registro();

    const laco = runTelefoniaLoop({ pool, signal: abortar.signal, log });
    await vi.advanceTimersByTimeAsync(0);
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);
    expect(falas.limparStorage).toHaveBeenCalledTimes(1);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(1);
    expect(vi.mocked(desligarAvisosVencidos).mock.calls[0]![0]).toBe(pool);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
    expect(falas.limparStorage).toHaveBeenCalledTimes(2);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(falas.sincronizar).toHaveBeenCalledTimes(3);

    // O disco das falas é a porta `falas` do controlador (5º argumento): é por
    // ele que a ligação garante o arquivo antes de tocar.
    expect(h.controladores).toHaveLength(1);
    const porta = h.controladores[0]![4] as { garantir: (f: { id: string; storagePath: string }) => Promise<string | null> };
    await porta.garantir({ id: "f1", storagePath: CAMINHO });
    expect(falas.garantir).toHaveBeenCalledWith({ id: "f1", storagePath: CAMINHO });

    abortar.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await laco;
    // Parou: o intervalo foi limpo com o laço.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(falas.sincronizar).toHaveBeenCalledTimes(3);
  });
});
