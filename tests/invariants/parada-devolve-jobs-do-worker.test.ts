import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { devolverPorConexaoPropria } from "@/lib/agent-engine/queue/parada";
import { claimJobs, devolverJobsDoWorker } from "@/lib/agent-engine/queue/queue";

/**
 * A DEVOLUÇÃO DOS JOBS NA PARADA DO WORKER — CONTRA UM POSTGRES DE VERDADE.
 *
 * `tests/unit/queue-parada.test.ts` prova a ORDEM da parada com dublês. Este
 * arquivo prova o que dublê nenhum sabe: que o `update` devolve as linhas certas
 * (e só elas), que o job devolvido é de fato claimável, e que a devolução passa
 * nas duas condições em que ela é chamada de verdade — pool esgotado e linha
 * travada.
 *
 * O incidente: em 2026-10-05 um job ficou `running` com o `locked_by` de um
 * worker morto e o cliente esperou mais de 20 minutos, porque só o reaper do
 * visibility timeout (10 min) o devolvia. Ver `lib/agent-engine/queue/parada.ts`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const pool = new pg.Pool({ connectionString: URL, max: 3 });

const ORG = "9a4ada00-0000-4000-8000-000000000001";
const contato = (n: number) => `9a4ada00-0000-4000-8000-0000000000c${n}`;
const job = (n: number) => `9a4ada00-0000-4000-8000-0000000000f${n}`;

const ESTE = "agent-engine-parada-este";
const OUTRO = "agent-engine-parada-outro";

/** Um job por contato: a lane por contato não pode decidir o desfecho deste arquivo. */
async function semear(
  n: number,
  linha: { status: string; lockedBy: string | null; attempts: number; maxAttempts?: number },
) {
  await pool.query(
    `insert into job_queue (id, organization_id, kind, contact_id, status, locked_by, locked_at, attempts, max_attempts)
     values ($1, $2, 'inbound_turn', $3, $4, $5, case when $5::text is null then null else now() end, $6, $7)`,
    [job(n), ORG, contato(n), linha.status, linha.lockedBy, linha.attempts, linha.maxAttempts ?? 5],
  );
}

async function estado(n: number) {
  const { rows } = await pool.query<{
    status: string;
    locked_by: string | null;
    travado: boolean;
    attempts: number;
  }>(
    `select status, locked_by, locked_at is not null as travado, attempts from job_queue where id = $1`,
    [job(n)],
  );
  return rows[0];
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-parada-do-worker', 'Org Parada LTDA', 'Org Parada')`,
    [ORG],
  );
  for (let n = 1; n <= 6; n++) {
    await pool.query(`insert into contacts (id, organization_id) values ($1, $2)`, [contato(n), ORG]);
  }
});

beforeEach(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
});

afterAll(async () => {
  await pool.end();
});

describe("devolução dos jobs na parada do worker", () => {
  it("devolve só os jobs em curso DESTE worker, sem consumir a tentativa", async () => {
    await semear(1, { status: "running", lockedBy: ESTE, attempts: 1 });
    await semear(2, { status: "running", lockedBy: ESTE, attempts: 3 });
    await semear(3, { status: "running", lockedBy: OUTRO, attempts: 1 });
    await semear(4, { status: "pending", lockedBy: null, attempts: 0 });
    await semear(5, { status: "done", lockedBy: null, attempts: 1 });

    await expect(devolverJobsDoWorker(pool, ESTE)).resolves.toBe(2);

    expect(await estado(1)).toEqual({ status: "pending", locked_by: null, travado: false, attempts: 0 });
    expect(await estado(2)).toEqual({ status: "pending", locked_by: null, travado: false, attempts: 2 });
    // A cerca: o job de outro worker, o que ainda nem começou e o concluído
    // ficam exatamente como estavam.
    expect(await estado(3)).toEqual({ status: "running", locked_by: OUTRO, travado: true, attempts: 1 });
    expect(await estado(4)).toEqual({ status: "pending", locked_by: null, travado: false, attempts: 0 });
    expect(await estado(5)).toEqual({ status: "done", locked_by: null, travado: false, attempts: 1 });
  });

  it("o job devolvido é claimável NA HORA pelo worker novo — inclusive o que estava na última tentativa", async () => {
    // Na última tentativa (attempts = max_attempts): o reaper o mataria ('dead').
    // Interrupção por parada não é falha do job, então ele volta com a tentativa
    // de volta — e é por isso que o claim seguinte o aceita.
    await semear(1, { status: "running", lockedBy: ESTE, attempts: 5, maxAttempts: 5 });
    await devolverJobsDoWorker(pool, ESTE);

    const claimados = await claimJobs(pool, { workerId: "agent-engine-parada-novo", maxConcurrency: 8 });
    expect(claimados.map((j) => j.id)).toEqual([job(1)]);
    expect(await estado(1)).toMatchObject({
      status: "running",
      locked_by: "agent-engine-parada-novo",
      attempts: 5,
    });
  });

  it("passa com o POOL ESGOTADO — por isso a conexão é própria", async () => {
    await semear(1, { status: "running", lockedBy: ESTE, attempts: 1 });

    // O worker no momento da parada: todo client do pool em checkout por um job
    // que não termina. `max: 1` + um checkout = pool sem vaga.
    const esgotado = new pg.Pool({ connectionString: URL, max: 1 });
    const ocupado = await esgotado.connect();
    try {
      // O CONTROLE: pelo pool, a mesma devolução não é atendida. Sem ele, o
      // caso passaria igual se a conexão própria fosse trocada por `pool.query`
      // num dia em que o pool do teste tivesse vaga.
      let peloPool: "voltou" | "na fila" = "na fila";
      const naFila = devolverJobsDoWorker(esgotado, ESTE).then(() => (peloPool = "voltou"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(peloPool).toBe("na fila");

      await expect(devolverPorConexaoPropria(URL, ESTE)).resolves.toBe(1);
      expect(await estado(1)).toMatchObject({ status: "pending", locked_by: null });

      ocupado.release();
      await naFila;
    } finally {
      await esgotado.end();
    }
  });

  it("linha TRAVADA por outra transação: desiste no prazo em vez de pendurar a saída", async () => {
    await semear(1, { status: "running", lockedBy: ESTE, attempts: 1 });

    const outra = await pool.connect();
    try {
      await outra.query("begin");
      await outra.query("select id from job_queue where id = $1 for update", [job(1)]);

      const inicio = Date.now();
      await expect(devolverPorConexaoPropria(URL, ESTE, { prazoDaTravaMs: 400 })).rejects.toMatchObject({
        code: "55P03", // lock_not_available
      });
      expect(Date.now() - inicio, "desistiu perto do prazo, não no timeout do teste").toBeLessThan(5_000);
    } finally {
      await outra.query("rollback");
      outra.release();
    }
    // Nada mudou: o job fica para o reaper, como antes deste conserto.
    expect(await estado(1)).toMatchObject({ status: "running", locked_by: ESTE, attempts: 1 });
  });
});
