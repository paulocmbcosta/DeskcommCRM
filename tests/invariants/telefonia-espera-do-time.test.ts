/**
 * A ESPERA MÁXIMA NA FILA DO TELEFONE, POR TIME, CONTRA POSTGRES REAL (migration 0295).
 *
 * `attendance_teams` só tem GRANT de leitura para `authenticated`: quem grava
 * `phone_queue_max_wait_seconds` é a rota de Configurações › Times, pela conexão
 * do app — FORA da RLS. A única catraca entre uma organização e a outra é o
 * `organization_id` da consulta, e por isso aqui há sempre DUAS organizações:
 *
 *  1. gravar devolve o que ficou, o que VALE e o que havia antes (a auditoria
 *     guarda o antes e o depois); `null` volta ao padrão de 120 s;
 *  2. o time de OUTRA organização não é encontrado — e a linha dele não muda;
 *  3. o time arquivado é recusado com motivo próprio — e não muda;
 *  4. a leitura devolve só os times ATIVOS da organização pedida, pelo nome.
 *
 * Os limites (30 a 1800 s) são do Zod da rota e do CHECK do banco, provado em
 * telefonia-fila-visivel-schema.test.ts.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gravarEsperaDoTime, lerEsperaDosTimes } from "@/lib/telefonia/espera-do-time";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0298-0000-4000-8000-00000000000a";
const OUTRA = "c0de0298-0000-4000-8000-00000000000b";
const SUPORTE = "c0de0298-2222-4000-8000-000000000001";
const FINANCEIRO = "c0de0298-2222-4000-8000-000000000002";
const ARQUIVADO = "c0de0298-2222-4000-8000-000000000003";
const TIME_OUTRA = "c0de0298-2222-4000-8000-000000000004";
const NAO_EXISTE = "c0de0298-2222-4000-8000-0000000000ff";

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'espera-0298-a', 'Espera 0298 A', 'Espera A'), ($2, 'espera-0298-b', 'Espera 0298 B', 'Espera B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug, archived_at, phone_queue_max_wait_seconds) values
       ($1, $5, 'Suporte', 'suporte-0298', null, null),
       ($2, $5, 'Financeiro', 'financeiro-0298', null, 300),
       ($3, $5, 'Antigo', 'antigo-0298', now(), 900),
       ($4, $6, 'Suporte B', 'suporte-0298', null, 300)
     on conflict (id) do nothing`,
    [SUPORTE, FINANCEIRO, ARQUIVADO, TIME_OUTRA, ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

/** A linha do time, como está no banco: o teto e a última alteração. */
async function naLinha(id: string): Promise<{ espera: number | null; alterada_em: string }> {
  const { rows } = await pool.query<{ espera: number | null; alterada_em: Date }>(
    "select phone_queue_max_wait_seconds as espera, updated_at as alterada_em from public.attendance_teams where id = $1",
    [id],
  );
  return { espera: rows[0]!.espera, alterada_em: new Date(rows[0]!.alterada_em).toISOString() };
}

describe("gravar a espera máxima do time", () => {
  it("grava 600 s: devolve o gravado, o que vale e o que havia antes (nada)", async () => {
    expect(await gravarEsperaDoTime(pool, ORG, SUPORTE, 600)).toEqual({
      ok: true,
      time: { team_id: SUPORTE, espera_maxima_s: 600, em_vigor_s: 600 },
      anterior: null,
    });
    expect((await naLinha(SUPORTE)).espera).toBe(600);
  });

  it("grava `null`: volta ao padrão de 120 s, e o que havia antes eram os 600", async () => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 600 where id = $1", [SUPORTE]);
    expect(await gravarEsperaDoTime(pool, ORG, SUPORTE, null)).toEqual({
      ok: true,
      time: { team_id: SUPORTE, espera_maxima_s: null, em_vigor_s: 120 },
      anterior: 600,
    });
    expect((await naLinha(SUPORTE)).espera).toBeNull();
  });

  it("gravar o mesmo valor de novo: o antes e o depois são iguais", async () => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 300 where id = $1", [FINANCEIRO]);
    expect(await gravarEsperaDoTime(pool, ORG, FINANCEIRO, 300)).toEqual({
      ok: true,
      time: { team_id: FINANCEIRO, espera_maxima_s: 300, em_vigor_s: 300 },
      anterior: 300,
    });
  });

  it("o time de OUTRA organização não é encontrado — e a linha dele não muda", async () => {
    const antes = await naLinha(TIME_OUTRA);
    expect(antes.espera).toBe(300);
    expect(await gravarEsperaDoTime(pool, ORG, TIME_OUTRA, 1800)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await gravarEsperaDoTime(pool, ORG, TIME_OUTRA, null)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await naLinha(TIME_OUTRA)).toEqual(antes);
    // E pela organização DELE a gravação entra: a recusa acima era a catraca, não o time.
    expect(await gravarEsperaDoTime(pool, OUTRA, TIME_OUTRA, 900)).toMatchObject({ ok: true, anterior: 300 });
    expect((await naLinha(TIME_OUTRA)).espera).toBe(900);
  });

  it("o time que não existe não é encontrado", async () => {
    expect(await gravarEsperaDoTime(pool, ORG, NAO_EXISTE, 600)).toEqual({ ok: false, motivo: "nao_encontrado" });
  });

  it("o time arquivado é recusado com motivo próprio — e não muda", async () => {
    const antes = await naLinha(ARQUIVADO);
    expect(antes.espera).toBe(900);
    expect(await gravarEsperaDoTime(pool, ORG, ARQUIVADO, 120)).toEqual({ ok: false, motivo: "time_arquivado" });
    expect(await naLinha(ARQUIVADO)).toEqual(antes);
  });
});

describe("ler a espera dos times", () => {
  it("só os times ATIVOS da organização pedida, pelo nome, com o gravado e o que vale", async () => {
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = null where id = $1", [SUPORTE]);
    await pool.query("update public.attendance_teams set phone_queue_max_wait_seconds = 300 where id = $1", [FINANCEIRO]);
    expect(await lerEsperaDosTimes(pool, ORG)).toEqual([
      { team_id: FINANCEIRO, espera_maxima_s: 300, em_vigor_s: 300 },
      { team_id: SUPORTE, espera_maxima_s: null, em_vigor_s: 120 },
    ]);
    const deB = await lerEsperaDosTimes(pool, OUTRA);
    expect(deB.map((t) => t.team_id)).toEqual([TIME_OUTRA]);
  });
});
