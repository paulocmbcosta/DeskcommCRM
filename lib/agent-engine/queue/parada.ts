/**
 * A PARADA do worker: drenar o que está em curso ou, acabando o prazo, DEVOLVER.
 *
 * Mora aqui, e não inline no `main.ts`, pelo mesmo motivo de `loop.ts`: o que
 * derruba produção nesta sequência é ORDEM, não aritmética — quando o relógio
 * começa a contar e o que acontece com os jobs que não terminaram. Com as
 * dependências injetadas, o teste dirige a parada inteira sem Postgres
 * (tests/unit/queue-parada.test.ts).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Medido em produção em 2026-10-05. Um turno ficou preso (o banco estava
 * travado atrás de um DDL), o worker recebeu `docker stop`, e o job ficou
 * `running` com `locked_by` de um processo morto: invisível para o worker novo
 * até o reaper do `QUEUE_VISIBILITY_TIMEOUT_MS` — 10 minutos. O cliente esperou
 * mais de 20 pela resposta. Duas causas, as duas aqui:
 *
 *  1. **O prazo começava tarde.** A parada esperava TODOS os loops de fundo
 *     pararem (sem prazo nenhum) e só então armava o relógio de
 *     `SHUTDOWN_GRACE_MS` para os jobs. Um loop com uma consulta presa atrás da
 *     mesma trava segurava a parada inteira, e quem decidia a hora de morrer era
 *     o SIGKILL do Docker — que não avisa.
 *  2. **Acabado o prazo, o worker só saía.** `process.exit(1)` com os jobs ainda
 *     marcados como dele.
 *
 * ─── O desenho ──────────────────────────────────────────────────────────────
 *
 * O relógio conta DESDE o sinal, e cobre loops e jobs. Se tudo sossega antes,
 * a saída é limpa e nada é devolvido. Se o prazo acaba, o worker devolve à fila
 * os jobs que ainda segura — `running` → `pending`, sem consumir tentativa — e
 * só então sai. O worker novo os pega no primeiro claim.
 *
 * Reexecutar um turno interrompido não é novidade: é exatamente o que o reaper
 * já faz depois do visibility timeout, e o que o ledger de envio (F2-06) existe
 * para tornar seguro — a mensagem que já saiu volta como `already_sent`. Esta
 * parada só troca "10 minutos depois" por "no próximo claim".
 *
 * O que isto NÃO cobre: SIGKILL e falta de memória. Processo que morre sem
 * rodar código não devolve nada — para esse continua valendo o reaper.
 */
import pg from 'pg';

import type { Logger } from '../obs/logger';
import { devolverJobsDoWorker } from './queue';

/**
 * Quanto a devolução pode levar antes de o worker desistir dela e sair. Entra na
 * conta do `stop_grace_period` do compose: `SHUTDOWN_GRACE_MS` + isto tem de
 * caber antes do SIGKILL do Docker (tests/unit/parada-do-worker-cabe-no-prazo-do-docker.test.ts).
 */
export const PRAZO_DA_DEVOLUCAO_MS = 8_000;

/** Quanto o `update` da devolução espera por uma linha travada antes de desistir. */
export const PRAZO_DA_TRAVA_NA_DEVOLUCAO_MS = 3_000;

export type DesfechoDaParada = 'limpo' | 'prazo';

export interface DepsDaParada {
  /** Os loops de fundo, JÁ avisados para parar (quem chama abortou o sinal). */
  loops: readonly Promise<unknown>[];
  /**
   * Os jobs em curso. É FUNÇÃO porque a foto só é final depois que o loop de
   * claim parou: um job claimado na última rodada entra em voo DEPOIS do sinal.
   */
  emVoo: () => Iterable<Promise<unknown>>;
  /** `SHUTDOWN_GRACE_MS`: quanto esperar, DESDE o sinal, por loops e jobs. */
  prazoMs: number;
  /** Devolve à fila os jobs que este worker ainda segura; resolve com quantos. */
  devolver: () => Promise<number>;
  /** Só os testes passam: o teto da própria devolução. */
  prazoDaDevolucaoMs?: number;
  log: Logger;
}

/**
 * Espera loops e jobs sossegarem; se o prazo acabar antes, devolve os jobs.
 * Resolve — NUNCA rejeita e nunca pendura: quem chama decide `process.exit`
 * pelo desfecho, e uma rejeição aqui (ou uma devolução que não volta) deixaria o
 * processo vivo até o SIGKILL, que é o defeito que este módulo existe para tirar.
 */
export async function drenarOuDevolver(deps: DepsDaParada): Promise<DesfechoDaParada> {
  let relogio: NodeJS.Timeout | undefined;
  // Armado ANTES de qualquer `await`: é isto que faz o prazo contar desde o sinal.
  const prazo = new Promise<'prazo'>((resolve) => {
    relogio = setTimeout(() => resolve('prazo'), deps.prazoMs);
  });
  const drenado = (async (): Promise<'limpo'> => {
    // `allSettled`: loop que rejeita não pode pular a espera pelos jobs.
    await Promise.allSettled(deps.loops);
    await Promise.allSettled([...deps.emVoo()]);
    return 'limpo';
  })();

  const desfecho = await Promise.race([drenado, prazo]);
  clearTimeout(relogio);
  if (desfecho === 'limpo') return 'limpo';

  deps.log.error('parada: o prazo acabou com trabalho em curso — devolvendo os jobs à fila', {
    grace_ms: deps.prazoMs,
    in_flight: [...deps.emVoo()].length,
  });
  try {
    const devolvidos = await comPrazo(
      deps.devolver(),
      deps.prazoDaDevolucaoMs ?? PRAZO_DA_DEVOLUCAO_MS,
    );
    deps.log.warn('parada: jobs em curso devolvidos à fila — o próximo worker os retoma', {
      devolvidos,
    });
  } catch (err) {
    // Sem devolução o estado é o de antes deste módulo: o reaper retoma no
    // visibility timeout. Pior que o conserto, nunca pior que o que havia.
    deps.log.error(
      'parada: não consegui devolver os jobs — ficam para o reaper do visibility timeout',
      { error: (err instanceof Error ? err.message : String(err)).split('\n', 1)[0]?.slice(0, 300) },
    );
  }
  return 'prazo';
}

async function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let relogio: NodeJS.Timeout | undefined;
  const estourou = new Promise<never>((_, reject) => {
    relogio = setTimeout(() => reject(new Error(`sem resposta em ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promessa, estourou]);
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * A devolução por uma conexão PRÓPRIA, aberta na hora — nunca pelo pool do worker.
 *
 * Quando o prazo acaba é porque há job preso, e job preso costuma estar
 * segurando conexão: no incidente cada turno tinha um client em checkout
 * esperando o banco. Um `pool.query` aqui entraria na fila do pool atrás deles e
 * nunca seria atendido — a devolução dependeria justamente do que está travado.
 *
 * O `lock_timeout` cobre o outro modo de pendurar: a linha do job travada por
 * uma transação que não termina. Aí o `update` desiste (55P03), quem chama loga
 * e o job fica para o reaper.
 */
export async function devolverPorConexaoPropria(
  databaseUrl: string,
  workerId: string,
  opts: { prazoDaTravaMs?: number } = {},
): Promise<number> {
  const prazoDaTravaMs = opts.prazoDaTravaMs ?? PRAZO_DA_TRAVA_NA_DEVOLUCAO_MS;
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: PRAZO_DA_DEVOLUCAO_MS,
  });
  // Sem listener, um backend que cai entre o connect e o end derruba o processo
  // com 'error' não tratado (mesmo pitfall descrito em db/pool.ts).
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query(`set lock_timeout = ${Math.trunc(prazoDaTravaMs)}`);
    return await devolverJobsDoWorker(client, workerId);
  } finally {
    await client.end().catch(() => undefined);
  }
}
