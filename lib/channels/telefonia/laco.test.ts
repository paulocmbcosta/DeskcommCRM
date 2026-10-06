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
 *     60 s mesmo com o Asterisk fora, e o controlador recebe o disco das falas;
 *  5. a reconexão: a abertura que falha sem `close`, ou que não dá sinal nenhum,
 *     não prende o laço — nem o desligamento do worker — e o socket largado não
 *     vira uma segunda conexão ao Asterisk.
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
  /** Cada evento que chegou ao controlador, na ordem. */
  const eventos: unknown[] = [];
  class ControladorFalso {
    ativas = 0;
    constructor(...args: unknown[]) {
      controladores.push(args);
    }
    usarFila() {}
    async recuperar() {}
    async tratar(ev: unknown) {
      eventos.push(ev);
    }
  }
  class SincronizadorFalso {
    async sincronizar(completa = false) {
      reconciliacoes.push(completa);
    }
    async atualizarEstados() {}
  }
  /**
   * O WebSocket falso, que se comporta como o do Node 22 (undici 6) — MEDIDO na
   * imagem do worker (`node:22-alpine`, Node 22.23.3, undici 6.28.1):
   *  - `abre`: a abertura dá certo, vem `open`;
   *  - `falha`: porta fechada, nome que não resolve, resposta que não é 101 — vem
   *    SÓ `error`. `close` nunca vem, e o socket fica "abrindo" para sempre;
   *  - `muda`: o servidor aceita o TCP e não responde — não vem evento nenhum;
   *  - `close()` num socket que não abriu: `error` DENTRO da chamada — antes de o
   *    socket se dar por encerrado, então o tratador que chama `close()` de novo
   *    não volta nunca (no Node 22, `RangeError` de pilha) —, outro logo depois, e
   *    de novo nenhum `close`;
   *  - `close()` com a conexão aberta: `close` só vem quando o servidor responde à
   *    despedida. Com ele travado (`despede = false`) não vem nada — medido por
   *    20 s, no Node 22 e no 24.
   */
  type Abertura = "abre" | "falha" | "muda";
  class SoqueteFalso {
    onopen: null | (() => void) = null;
    onmessage: null | ((m: { data: string }) => void) = null;
    onerror: null | (() => void) = null;
    onclose: null | ((c: { code: number }) => void) = null;
    estado: "abrindo" | "aberto" | "encerrado" = "abrindo";
    /** O servidor responde à despedida do `close()`. */
    despede = true;
    constructor(abertura: Abertura) {
      if (abertura === "abre") {
        void Promise.resolve().then(() => {
          if (this.estado !== "abrindo") return;
          this.estado = "aberto";
          this.onopen?.();
        });
      }
      if (abertura === "falha") void Promise.resolve().then(() => this.onerror?.());
    }
    close() {
      if (this.estado === "encerrado") return;
      if (this.estado === "aberto") {
        if (!this.despede) return;
        this.estado = "encerrado";
        this.onclose?.({ code: 1000 });
        return;
      }
      this.onerror?.();
      this.estado = "encerrado";
      void Promise.resolve().then(() => this.onerror?.());
    }
    /** O Asterisk some com a conexão aberta: `close` 1006, sem despedida. */
    cair() {
      this.estado = "encerrado";
      this.onclose?.({ code: 1006 });
    }
  }
  /**
   * O Asterisk: fora (`conecta: false`, `abrirEventos` lança e o laço fica
   * reconectando) ou de pé. `roteiro` diz como abre cada socket criado, em ordem;
   * esgotado, todos abrem. `vivosAoAbrir` guarda, a cada abertura, quantos sockets
   * anteriores ainda não estavam encerrados — o que tem de ser sempre zero.
   */
  const ari = {
    conecta: false,
    roteiro: [] as Abertura[],
    soquetes: [] as SoqueteFalso[],
    vivosAoAbrir: [] as number[],
  };
  class ClienteAriFalso {
    abrirEventos() {
      if (!ari.conecta) throw new Error("sem Asterisk no teste");
      ari.vivosAoAbrir.push(ari.soquetes.filter((s) => s.estado !== "encerrado").length);
      const ws = new SoqueteFalso(ari.roteiro.shift() ?? "abre");
      ari.soquetes.push(ws);
      return ws;
    }
  }
  return {
    controladores,
    reconciliacoes,
    eventos,
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
// As gravações (F3) têm teste próprio (gravacoes.test.ts); aqui, só a passada que as chama.
vi.mock("./gravacoes", () => ({ gravacoesDoWorker: vi.fn(() => ({ passada: vi.fn(async () => undefined) })) }));
vi.mock("./repositorio", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloRepositorio>()),
  desligarAvisosVencidos: vi.fn(),
  // O conserto de verdade consultaria o `pool` de mentira e lançaria em TODO caso do laço.
  consertarCartoesOrfaos: vi.fn(async () => 0),
}));

import type pg from "pg";

import type { Registro } from "./controle";
import { falasDoWorker, type FalasNoDisco } from "./falas-no-disco";
import { passadaDoTelefone, runTelefoniaLoop } from "./laco";
import { consertarCartoesOrfaos, desligarAvisosVencidos, type AvisoDesligado } from "./repositorio";

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
  h.eventos.length = 0;
  h.ari.conecta = false;
  h.ari.roteiro.length = 0;
  h.ari.soquetes.length = 0;
  h.ari.vivosAoAbrir.length = 0;
  h.config.valor = null;
});

// ─── 1. a passada ────────────────────────────────────────────────────────────

describe("passadaDoTelefone — as etapas de 60 s", () => {
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

  it("as gravações das ligações (F3): rodam em cada passada; lançando, não derrubam as outras etapas e o log registra só a transição", async () => {
    const falas = falasFalsas();
    const desligar = vi.fn(async (_: Date): Promise<AvisoDesligado[]> => []);
    const gravacoes = { passada: vi.fn(async () => undefined) };
    const log = registro();
    const passada = passadaDoTelefone({ falas, gravacoes, desligarAvisosVencidos: desligar, log });

    await passada();
    expect(gravacoes.passada).toHaveBeenCalledTimes(1);

    gravacoes.passada.mockRejectedValue(new Error("ari 503"));
    await passada();
    await passada();
    expect(falas.sincronizar).toHaveBeenCalledTimes(3);
    expect(desligar).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("telefonia: a passada de gravações das ligações falhou — tenta de novo a cada minuto", {
      erro: "Error: ari 503",
    });
  });

  it("fecha os cartões de ligação que ficaram em andamento, e diz quantos", async () => {
    const consertar = vi.fn(async () => 2);
    const log = registro();
    await passadaDoTelefone({ falas: falasFalsas(), desligarAvisosVencidos: async () => [], consertarCartoes: consertar, log })();
    expect(consertar).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "telefonia: cartão de ligação em andamento fechado pela passada",
      { cartoes: 2 },
    );
  });

  it("sem cartão órfão a passada não escreve nada; e a etapa que lança não derruba as outras", async () => {
    const falas = falasFalsas();
    const log = registro();
    await passadaDoTelefone({ falas, desligarAvisosVencidos: async () => [], consertarCartoes: async () => 0, log })();
    expect(log.info).not.toHaveBeenCalled();
    await passadaDoTelefone({
      falas,
      desligarAvisosVencidos: async () => [],
      consertarCartoes: async () => {
        throw new Error("banco fora do ar");
      },
      log,
    })();
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
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
    // O conserto do cartão órfão (fila visível, entrega 1) entra na mesma passada, com o pool do worker.
    expect(consertarCartoesOrfaos).toHaveBeenCalledTimes(1);
    expect(consertarCartoesOrfaos).toHaveBeenCalledWith(pool);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
    expect(falas.limparStorage).toHaveBeenCalledTimes(2);
    expect(desligarAvisosVencidos).toHaveBeenCalledTimes(2);
    expect(consertarCartoesOrfaos).toHaveBeenCalledTimes(2);

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

// ─── 5. a reconexão ──────────────────────────────────────────────────────────
//
// Medido em produção em 30/09/2026: recriado só o contêiner do Asterisk, o worker
// registrou UMA vez "conexão com o Asterisk caiu" e nunca mais nada — a telefonia
// ficou muda até alguém reiniciar o worker. A tentativa de 1 s depois pegou o
// Asterisk ainda subindo, e a abertura que falha não dispara `close` no Node 22.

describe("runTelefoniaLoop — a abertura que não fecha", () => {
  const CAIU = "telefonia: conexão com o Asterisk caiu — reconectando";
  const CONECTOU = "telefonia: conectada ao Asterisk";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(desligarAvisosVencidos).mockResolvedValue([]);
    vi.mocked(falasDoWorker).mockReturnValue(falasFalsas() as unknown as FalasNoDisco);
    h.config.valor = { baseUrl: "http://asterisk:8088", senha: "senha-de-teste" };
    h.ari.conecta = true;
  });

  function subirOLaco() {
    const abortar = new AbortController();
    const log = registro();
    const estado = { conectada: false, ligacoesAtivas: 0 };
    let encerrou = false;
    const laco = runTelefoniaLoop({ pool, signal: abortar.signal, log, estado }).then(() => {
      encerrou = true;
    });
    const linhas = (mensagem: string, fn: typeof log.warn) => fn.mock.calls.filter(([m]) => m === mensagem);
    return {
      abortar,
      log,
      estado,
      laco,
      encerrou: () => encerrou,
      quedas: () => linhas(CAIU, log.warn).map(([, campos]) => campos),
      conexoes: () => linhas(CONECTOU, log.info).length,
    };
  }

  it("a abertura que falha só com `error` (sem `close`): o laço tenta de novo e reconecta", async () => {
    h.ari.roteiro.push("abre", "falha", "abre");
    const t = subirOLaco();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.estado.conectada).toBe(true);

    // O contêiner do Asterisk é recriado: a conexão aberta cai.
    h.ari.soquetes[0]!.cair();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.estado.conectada).toBe(false);
    expect(t.quedas()).toEqual([{ motivo: "fechou (1006)", em_ms: 1_000 }]);

    // 1 s depois o Asterisk ainda está subindo: `error`, e mais nada.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.ari.soquetes).toHaveLength(2);
    expect(t.quedas()).toEqual([
      { motivo: "fechou (1006)", em_ms: 1_000 },
      { motivo: "a abertura falhou", em_ms: 2_000 },
    ]);

    // Era aqui que o laço parava para sempre. A tentativa seguinte abre.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.ari.soquetes).toHaveLength(3);
    expect(t.estado.conectada).toBe(true);
    expect(t.conexoes()).toBe(2);
    // Reconectou de verdade: os troncos são sincronizados por inteiro de novo.
    expect(h.reconciliacoes).toEqual([true, true]);
    expect(h.ari.vivosAoAbrir).toEqual([0, 0, 0]);

    t.abortar.abort();
    await t.laco;
  });

  it("a abertura que não dá sinal nenhum: em 10 s o laço a larga, fecha o socket e tenta de novo", async () => {
    h.ari.roteiro.push("muda", "abre");
    const t = subirOLaco();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.ari.soquetes).toHaveLength(1);
    expect(t.quedas()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(t.quedas()).toEqual([{ motivo: "não abriu em 10 s", em_ms: 1_000 }]);
    // Fechado ANTES de a seguinte abrir: nunca duas conexões ao mesmo tempo.
    expect(h.ari.soquetes[0]!.estado).toBe("encerrado");
    expect(h.ari.soquetes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.ari.soquetes).toHaveLength(2);
    expect(t.estado.conectada).toBe(true);
    expect(t.conexoes()).toBe(1);
    expect(h.ari.vivosAoAbrir).toEqual([0, 0]);

    t.abortar.abort();
    await t.laco;
  });

  it("a conexão que abriu não tem prazo: passados os 10 s, ela segue de pé", async () => {
    const t = subirOLaco();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.estado.conectada).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.ari.soquetes).toHaveLength(1);
    expect(h.ari.soquetes[0]!.estado).toBe("aberto");
    expect(t.estado.conectada).toBe(true);
    expect(t.quedas()).toEqual([]);

    t.abortar.abort();
    await t.laco;
  });

  it("o socket largado não fala mais: `open`, evento e `close` tardios dele não chegam ao controlador nem derrubam a conexão nova", async () => {
    h.ari.roteiro.push("muda", "abre");
    const t = subirOLaco();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(t.estado.conectada).toBe(true);
    const [largado, vivo] = h.ari.soquetes as [(typeof h.ari.soquetes)[number], (typeof h.ari.soquetes)[number]];

    // O servidor mudo acorda tarde demais.
    largado.onopen?.();
    largado.onmessage?.({ data: JSON.stringify({ type: "StasisStart", de: "largado" }) });
    largado.onerror?.();
    largado.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.eventos).toEqual([]);
    expect(t.conexoes()).toBe(1);
    expect(h.reconciliacoes).toEqual([true]);
    // O `close` tardio não marca a conexão VIVA como caída nem abre outra.
    expect(t.estado.conectada).toBe(true);
    expect(t.quedas()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.ari.soquetes).toHaveLength(2);

    // E a conexão viva segue entregando.
    vivo.onmessage?.({ data: JSON.stringify({ type: "StasisStart", de: "vivo" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.eventos).toEqual([{ type: "StasisStart", de: "vivo" }]);

    t.abortar.abort();
    await t.laco;
  });

  it.each(["muda", "falha"] as const)("o desligamento do worker não fica preso numa abertura %s", async (abertura) => {
    // Depois de uma abertura que falha o laço dorme o intervalo de reconexão; a
    // segunda, muda, é a que o desligamento encontra em curso.
    h.ari.roteiro.push(abertura, "muda");
    const t = subirOLaco();
    await vi.advanceTimersByTimeAsync(3_000);
    const emCurso = h.ari.soquetes.at(-1)!;
    expect(emCurso.estado).toBe("abrindo");

    t.abortar.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(t.encerrou()).toBe(true);
    expect(emCurso.estado).toBe("encerrado");
    // O prazo de abertura morreu com o laço: nada dispara depois.
    const quedas = t.quedas().length;
    const abertos = h.ari.soquetes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.quedas()).toHaveLength(quedas);
    expect(h.ari.soquetes).toHaveLength(abertos);
  });

  it("nem numa conexão aberta com o Asterisk travado: o desligamento não espera a despedida", async () => {
    const t = subirOLaco();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.estado.conectada).toBe(true);
    const aberta = h.ari.soquetes[0]!;
    aberta.despede = false;

    t.abortar.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(t.encerrou()).toBe(true);
    expect(t.estado.conectada).toBe(false);
    // O worker encerra o pool em seguida: evento que chega depois não entra na fila.
    aberta.onmessage?.({ data: JSON.stringify({ type: "StasisStart" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.eventos).toEqual([]);
  });
});
