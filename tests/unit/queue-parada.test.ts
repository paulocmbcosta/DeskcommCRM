import { describe, expect, it, vi } from "vitest";

import { drenarOuDevolver } from "@/lib/agent-engine/queue/parada";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * A parada do worker, dirigida sem Postgres e sem processo — ver o cabeçalho de
 * `lib/agent-engine/queue/parada.ts` para o incidente que a originou.
 *
 * Cada caso tem a sabotagem que o derruba anotada ao lado, porque as duas
 * propriedades que importam aqui (o prazo conta DESDE o sinal; a foto dos jobs
 * é tirada DEPOIS dos loops) são de ORDEM — e ordem errada passa em qualquer
 * teste que só confira "chamou" ou "não chamou".
 */
function logSpy(): Logger & { linhas: { nivel: string; msg: string }[] } {
  const linhas: { nivel: string; msg: string }[] = [];
  return {
    info: (msg: string) => void linhas.push({ nivel: "info", msg }),
    warn: (msg: string) => void linhas.push({ nivel: "warn", msg }),
    error: (msg: string) => void linhas.push({ nivel: "error", msg }),
    linhas,
  } as unknown as Logger & { linhas: { nivel: string; msg: string }[] };
}

function adiado<T = void>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

/** Nunca resolve: o loop (ou o job) com a consulta presa atrás de uma trava. */
const preso = () => new Promise<never>(() => undefined);
const em = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `Promise.race` contra um relógio do TESTE: a sabotagem típica deste módulo
 * faz a parada pendurar, e pendurar até o timeout do vitest diria "demorou" em
 * vez de dizer o que quebrou.
 */
async function ouPendurou<T>(promessa: Promise<T>, ms = 1_000): Promise<T | "PENDUROU"> {
  return Promise.race([promessa, em(ms).then(() => "PENDUROU" as const)]);
}

const PRAZO = 40;

describe("drenarOuDevolver", () => {
  it("tudo sossega antes do prazo: saída limpa, e nada é devolvido", async () => {
    // Sabotagem: devolver em toda parada → este caso acusa. A parada limpa é a
    // de todo deploy; abrir uma conexão a mais ao banco em cada uma, para devolver
    // nada, é custo sem efeito.
    const devolver = vi.fn(async () => 0);
    const job = adiado();
    const parada = drenarOuDevolver({
      loops: [Promise.resolve()],
      emVoo: () => [job.promessa],
      prazoMs: 1_000,
      devolver,
      log: logSpy(),
    });
    job.resolver();
    await expect(ouPendurou(parada)).resolves.toBe("limpo");
    expect(devolver).not.toHaveBeenCalled();
  });

  it("job que não termina: acabado o prazo, DEVOLVE e só então sai", async () => {
    // Sabotagem: sair sem devolver (o comportamento antigo) → `devolver` com 0
    // chamadas. É o defeito que deixou o cliente 20 minutos sem resposta.
    const devolver = vi.fn(async () => 1);
    const log = logSpy();
    const desfecho = await ouPendurou(
      drenarOuDevolver({
        loops: [Promise.resolve()],
        emVoo: () => [preso()],
        prazoMs: PRAZO,
        devolver,
        log,
      }),
    );
    expect(desfecho).toBe("prazo");
    expect(devolver).toHaveBeenCalledTimes(1);
    expect(log.linhas.map((l) => l.nivel)).toEqual(["error", "warn"]);
  });

  it("LOOP que não para: o prazo conta desde o sinal, não desde o fim dos loops", async () => {
    // Sabotagem: esperar os loops ANTES de armar o relógio (a ordem antiga) →
    // PENDUROU. Com o banco travado, o loop de fundo tem uma consulta na fila
    // atrás da mesma trava que prendeu o job: quem espera por ele espera para
    // sempre, e quem decide a hora de morrer vira o SIGKILL do Docker.
    const devolver = vi.fn(async () => 2);
    const desfecho = await ouPendurou(
      drenarOuDevolver({
        loops: [preso()],
        emVoo: () => [],
        prazoMs: PRAZO,
        devolver,
        log: logSpy(),
      }),
    );
    expect(desfecho).toBe("prazo");
    expect(devolver).toHaveBeenCalledTimes(1);
  });

  it("job claimado na última rodada entra na conta: a foto é tirada depois dos loops", async () => {
    // Sabotagem: fotografar os jobs ANTES de esperar os loops → sai "limpo" com
    // um job em curso, e o `pool.end()` de quem chama o derruba no meio.
    const loop = adiado();
    const tardio = adiado();
    const emVoo: Promise<unknown>[] = [];
    let saiu: string | undefined;
    const parada = drenarOuDevolver({
      loops: [loop.promessa],
      emVoo: () => emVoo,
      prazoMs: 1_000,
      devolver: vi.fn(async () => 0),
      log: logSpy(),
    }).then((d) => (saiu = d));

    // O loop de claim ainda estava numa rodada quando o sinal chegou, e ela
    // trouxe um job: ele entra em voo DEPOIS do início da parada.
    emVoo.push(tardio.promessa);
    loop.resolver();
    await em(20);
    expect(saiu, "com o job tardio em curso a parada ainda não terminou").toBeUndefined();

    tardio.resolver();
    await expect(ouPendurou(parada)).resolves.toBe("limpo");
  });

  it("loop que REJEITA não pula a espera pelos jobs", async () => {
    // Sabotagem: `Promise.all` no lugar de `allSettled` → a parada rejeita, e
    // `void shutdown()` no worker vira rejeição não tratada com jobs em curso.
    const job = adiado();
    let saiu: string | undefined;
    const parada = drenarOuDevolver({
      loops: [Promise.reject(new Error("loop quebrou")), Promise.resolve()],
      emVoo: () => [job.promessa],
      prazoMs: 1_000,
      devolver: vi.fn(async () => 0),
      log: logSpy(),
    }).then((d) => (saiu = d));
    await em(20);
    expect(saiu).toBeUndefined();
    job.resolver();
    await expect(ouPendurou(parada)).resolves.toBe("limpo");
  });

  it("devolução que FALHA não segura a saída — e fica dito no log", async () => {
    // Sabotagem: sem o try/catch → a parada rejeita em vez de devolver "prazo".
    const log = logSpy();
    const desfecho = await ouPendurou(
      drenarOuDevolver({
        loops: [],
        emVoo: () => [preso()],
        prazoMs: PRAZO,
        devolver: async () => {
          throw new Error("canceling statement due to lock timeout\nCONTEXT: linha com dado de cliente");
        },
        log,
      }),
    );
    expect(desfecho).toBe("prazo");
    const erros = log.linhas.filter((l) => l.nivel === "error").map((l) => l.msg);
    expect(erros).toHaveLength(2);
    expect(erros[1]).toContain("reaper");
  });

  it("devolução que NÃO RESPONDE não pendura a saída", async () => {
    // Sabotagem: sem o teto próprio da devolução → PENDUROU. É o caso em que o
    // banco não aceita nem a conexão nova: sem teto, o worker fica vivo até o
    // SIGKILL — de volta ao ponto de partida.
    const desfecho = await ouPendurou(
      drenarOuDevolver({
        loops: [],
        emVoo: () => [preso()],
        prazoMs: PRAZO,
        prazoDaDevolucaoMs: PRAZO,
        devolver: () => preso(),
        log: logSpy(),
      }),
    );
    expect(desfecho).toBe("prazo");
  });
});
