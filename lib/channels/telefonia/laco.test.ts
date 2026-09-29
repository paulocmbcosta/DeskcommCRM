// @vitest-environment node
/**
 * O laço da telefonia no worker — a parte que NÃO depende da ARI: a passada de
 * 60 s dos avisos de instabilidade vencidos, das falas (Storage → volume) e da
 * limpeza do Storage (desenho da fase 2, §4 e §5.5).
 *
 * Quatro perguntas:
 *  1. a passada roda as três etapas, e a falha de uma não derruba as outras nem
 *     a próxima passada — nem inunda o log (a queda é registrada na transição);
 *  2. o Storage pendurado não segura os avisos vencidos (guarda própria) nem a
 *     reconciliação dos troncos da fase 1 (a fila serial);
 *  3. no desligamento do worker, a passada não começa etapa nova, e a que termina
 *     depois do sinal não registra queda do banco — o pool já foi encerrado
 *     (workers/agent-worker/main.ts);
 *  4. a fiação de `runTelefoniaLoop`: com a telefonia desligada nada roda (o
 *     worker não escreve no volume); ligada, a passada roda ao subir e a cada
 *     60 s mesmo com o Asterisk fora, e o controlador recebe o disco das falas.
 *
 * A ARI, o controlador e o sincronizador são falsos: aqui só se mede a fiação.
 * O disco das falas e o armazém de reserva são medidos em falas-no-disco.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloAri from "./ari";
import type * as ModuloControle from "./controle";
import type * as ModuloFalas from "./falas-no-disco";
import type * as ModuloRepositorio from "./repositorio";

const h = vi.hoisted(() => {
  const controladores: unknown[][] = [];
  /** O argumento de cada `sync.sincronizar`: `true` ao conectar, `false` na reconciliação de 60 s. */
  const reconciliacoes: boolean[] = [];
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
    async sincronizar(completa = false) {
      reconciliacoes.push(completa);
    }
    async atualizarEstados() {}
  }
  /**
   * O Asterisk: fora (`conecta: false`, o laço fica reconectando) ou de pé — um
   * WebSocket mínimo que abre logo depois de criado e fecha quando o laço aborta.
   */
  const ari = { conecta: false };
  class ClienteAriFalso {
    abrirEventos() {
      if (!ari.conecta) throw new Error("sem Asterisk no teste");
      const ws = {
        onopen: null as null | (() => void),
        onmessage: null,
        onerror: null,
        onclose: null as null | ((c: { code: number }) => void),
        close() {
          ws.onclose?.({ code: 1000 });
        },
      };
      void Promise.resolve().then(() => ws.onopen?.());
      return ws;
    }
  }
  return {
    controladores,
    reconciliacoes,
    ari,
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
  falasDoWorker: vi.fn(),
}));
vi.mock("./repositorio", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloRepositorio>()),
  desligarAvisosVencidos: vi.fn(),
}));

import type pg from "pg";

import type { Registro } from "./controle";
import { falasDoWorker, type FalasNoDisco } from "./falas-no-disco";
import { passadaDoTelefone, runTelefoniaLoop } from "./laco";
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

/** Uma promessa que só termina quando o teste manda. */
function pendurada<T>() {
  let soltar!: (v: T) => void;
  let quebrar!: (e: unknown) => void;
  const promessa = new Promise<T>((resolve, reject) => {
    soltar = resolve;
    quebrar = reject;
  });
  return { promessa, soltar, quebrar };
}

const pool = { query: vi.fn() } as unknown as pg.Pool;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  h.controladores.length = 0;
  h.reconciliacoes.length = 0;
  h.ari.conecta = false;
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

  it("não reentra: o Storage lento não empilha outra sincronização — e a seguinte, depois dele, roda inteira", async () => {
    const falas = falasFalsas();
    const lenta = pendurada<{ baixadas: number; apagadas: number; falhas: number }>();
    falas.sincronizar.mockImplementationOnce(() => lenta.promessa);
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const passada = passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log: registro() });

    const primeira = passada();
    await vi.waitFor(() => expect(falas.sincronizar).toHaveBeenCalledTimes(1));
    await passada(); // chega com a primeira ainda baixando
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);

    lenta.soltar({ baixadas: 0, apagadas: 0, falhas: 0 });
    await primeira;
    expect(falas.limparStorage).toHaveBeenCalledTimes(1);
    await passada(); // a primeira terminou: a próxima roda inteira
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
    expect(falas.limparStorage).toHaveBeenCalledTimes(2);
  });
});

// ─── 2. o Storage pendurado não segura o resto ───────────────────────────────

describe("passadaDoTelefone — cada frente com a sua guarda", () => {
  it("com o Storage travado (limpeza sem prazo), os avisos vencidos seguem sendo desligados a cada passada", async () => {
    const falas = falasFalsas();
    falas.limparStorage.mockImplementation(() => pendurada<never>().promessa);
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const passada = passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log: registro() });

    void passada(); // a primeira fica presa na limpeza, para sempre
    await vi.waitFor(() => expect(falas.limparStorage).toHaveBeenCalledTimes(1));
    await passada();
    await passada();

    expect(desligar).toHaveBeenCalledTimes(3);
    // A frente do Storage não reentra enquanto a limpeza não volta.
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);
    expect(falas.limparStorage).toHaveBeenCalledTimes(1);
  });

  it("e o banco lento nos avisos não segura as falas", async () => {
    const falas = falasFalsas();
    const desligar = vi.fn((_: Date) => pendurada<AvisoDesligado[]>().promessa);
    const passada = passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log: registro() });

    void passada();
    await vi.waitFor(() => expect(falas.limparStorage).toHaveBeenCalledTimes(1));
    void passada();
    await vi.waitFor(() => expect(falas.limparStorage).toHaveBeenCalledTimes(2));

    expect(desligar).toHaveBeenCalledTimes(1);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
  });
});

// ─── 3. o desligamento do worker ─────────────────────────────────────────────

describe("passadaDoTelefone — no desligamento do worker", () => {
  it("com o sinal dado, não começa passada", async () => {
    const falas = falasFalsas();
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const abortar = new AbortController();
    abortar.abort();
    await passadaDoTelefone({ falas, desligarAvisosVencidos: desligar, log: registro(), signal: abortar.signal })();

    expect(desligar).not.toHaveBeenCalled();
    expect(falas.sincronizar).not.toHaveBeenCalled();
    expect(falas.limparStorage).not.toHaveBeenCalled();
  });

  it("o sinal no meio da passada: a etapa seguinte não começa", async () => {
    const falas = falasFalsas();
    const lenta = pendurada<{ baixadas: number; apagadas: number; falhas: number }>();
    falas.sincronizar.mockImplementationOnce(() => lenta.promessa);
    const abortar = new AbortController();
    const passada = passadaDoTelefone({
      falas,
      desligarAvisosVencidos: async () => [],
      log: registro(),
      signal: abortar.signal,
    });

    const emCurso = passada();
    await vi.waitFor(() => expect(falas.sincronizar).toHaveBeenCalledTimes(1));
    abortar.abort();
    lenta.soltar({ baixadas: 0, apagadas: 0, falhas: 0 });
    await emCurso;

    expect(falas.limparStorage).not.toHaveBeenCalled();
  });

  it("a etapa que falha DEPOIS do sinal não registra queda: é o pool encerrado, não o banco", async () => {
    const falas = falasFalsas();
    const consulta = pendurada<AvisoDesligado[]>();
    const sincronizacao = pendurada<never>();
    falas.sincronizar.mockImplementationOnce(() => sincronizacao.promessa);
    const abortar = new AbortController();
    const log = registro();
    const emCurso = passadaDoTelefone({
      falas,
      desligarAvisosVencidos: () => consulta.promessa,
      log,
      signal: abortar.signal,
    })();
    await vi.waitFor(() => expect(falas.sincronizar).toHaveBeenCalledTimes(1));

    // O worker desliga: o sinal, e depois o `pool.end()` (workers/agent-worker/main.ts).
    abortar.abort();
    const poolEncerrado = new Error("Cannot use a pool after calling end on the pool");
    consulta.quebrar(poolEncerrado);
    sincronizacao.quebrar(poolEncerrado);
    await emCurso;

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(falas.limparStorage).not.toHaveBeenCalled();
  });
});

// ─── 4. a fiação do laço ─────────────────────────────────────────────────────

describe("runTelefoniaLoop — a passada no laço", () => {
  beforeEach(() => {
    vi.mocked(desligarAvisosVencidos).mockResolvedValue([]);
  });

  it("com a telefonia desligada, nada roda: o worker não escreve no volume nem mexe nos avisos", async () => {
    await runTelefoniaLoop({ pool, signal: new AbortController().signal, log: registro() });

    expect(falasDoWorker).not.toHaveBeenCalled();
    expect(desligarAvisosVencidos).not.toHaveBeenCalled();
    expect(h.controladores).toHaveLength(0);
  });

  it("ligada, a passada roda ao subir e a cada 60 s — mesmo com o Asterisk fora — e o controlador recebe o disco das falas", async () => {
    vi.useFakeTimers();
    h.config.valor = { baseUrl: "http://asterisk:8088", senha: "senha-de-teste" };
    const falas = falasFalsas();
    vi.mocked(falasDoWorker).mockReturnValue(falas as unknown as FalasNoDisco);
    const abortar = new AbortController();

    const laco = runTelefoniaLoop({ pool, signal: abortar.signal, log: registro() });
    await vi.advanceTimersByTimeAsync(0);
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);
    expect(falas.limparStorage).toHaveBeenCalledTimes(1);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(1);
    expect(vi.mocked(desligarAvisosVencidos).mock.calls[0]![0]).toBe(pool);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
    expect(falas.limparStorage).toHaveBeenCalledTimes(2);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(2);

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
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
  });

  it("o Storage pendurado não segura os avisos vencidos nem a reconciliação dos troncos da fase 1", async () => {
    vi.useFakeTimers();
    h.config.valor = { baseUrl: "http://asterisk:8088", senha: "senha-de-teste" };
    h.ari.conecta = true;
    const falas = falasFalsas();
    // A primeira passada vai bem; o Storage pendura a partir da segunda (60 s),
    // quando a reconciliação dos troncos já roda no mesmo tique.
    falas.sincronizar.mockImplementation(() => pendurada<never>().promessa);
    falas.sincronizar.mockImplementationOnce(async () => ({ baixadas: 0, apagadas: 0, falhas: 0 }));
    vi.mocked(falasDoWorker).mockReturnValue(falas as unknown as FalasNoDisco);
    const abortar = new AbortController();

    const laco = runTelefoniaLoop({ pool, signal: abortar.signal, log: registro() });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconciliacoes).toEqual([true]); // conectou: a sincronização completa
    await vi.advanceTimersByTimeAsync(60_000); // o Storage pendura aqui
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.reconciliacoes).toEqual([true, false, false, false]);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(4);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);

    abortar.abort();
    await laco;
  });

  it("no desligamento: o intervalo não começa passada, e o log das falas cala as quedas", async () => {
    vi.useFakeTimers();
    h.config.valor = { baseUrl: "http://asterisk:8088", senha: "senha-de-teste" };
    const falas = falasFalsas();
    vi.mocked(falasDoWorker).mockReturnValue(falas as unknown as FalasNoDisco);
    const abortar = new AbortController();
    const log = registro();

    const laco = runTelefoniaLoop({ pool, signal: abortar.signal, log });
    await vi.advanceTimersByTimeAsync(59_500);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(1);
    const logDasFalas = vi.mocked(falasDoWorker).mock.calls[0]![1] as Registro;
    logDasFalas.warn("telefonia: o Storage das falas não responde");
    expect(log.warn).toHaveBeenCalledWith("telefonia: o Storage das falas não responde");
    log.warn.mockClear();

    abortar.abort();
    // O Asterisk está fora: o laço dorme no backoff (até 61 s) e o intervalo de
    // 60 s ainda dispara — a passada vê o sinal e não começa.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(1);
    expect(falas.sincronizar).toHaveBeenCalledTimes(1);

    // O pool já foi encerrado (main.ts): a falha que chega agora não é queda do banco.
    logDasFalas.warn("telefonia: a passada das falas não lê o banco", { erro: "Cannot use a pool after calling end on the pool" });
    logDasFalas.error("telefonia: o bucket das falas não existe");
    logDasFalas.info("telefonia: falas sincronizadas no disco", { baixadas: 1 });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("telefonia: falas sincronizadas no disco", { baixadas: 1 });

    await vi.advanceTimersByTimeAsync(30_000);
    await laco;
  });
});
