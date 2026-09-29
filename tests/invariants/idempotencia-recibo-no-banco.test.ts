/**
 * O RECIBO DE IDEMPOTÊNCIA NO BANCO DE VERDADE — `comIdempotencia` (lib/api/idempotency.ts)
 * contra a coluna `idempotency_keys.request_hash`, que é `bytea`.
 *
 * O defeito que este arquivo prende: o helper gravava o hash hex SEM o prefixo
 * `\x`. A entrada de `bytea` lê isso no formato "escape" — os 64 BYTES ASCII dos
 * caracteres —, e o PostgREST devolve `bytea` sempre como `"\x" + hex` desses
 * bytes (`\x3966…`). O lido nunca era igual ao gravado: TODO replay com a mesma
 * chave virava 409 `idempotency_conflict`, em todas as rotas que usam o helper
 * (message-templates, menus e números do telefone). Os testes de unidade não
 * viam porque o banco falso guardava e devolvia a MESMA string.
 *
 * O caminho: `pgComoSupabase` (tests/pg-como-supabase.ts) — o mesmo `from().select()
 * .eq().gt().maybeSingle()` e `from().insert()` do supabase-js, sobre o `pg` do
 * `test:db`. A ESCRITA é a do PostgREST (a string vai como texto e passa pela
 * entrada de `bytea`); a LEITURA devolve `bytea` como o `to_json` do Postgres
 * (`"\x" + hex`), que é o que o PostgREST serializa — o próprio adaptador prova
 * isso em pg-como-supabase.test.ts. O que ele não reproduz é a RLS (conecta como
 * `postgres`): a policy `idempotency_tenant` não entra no que se mede aqui.
 *
 * Mede:
 *  1. a mesma chave e o mesmo corpo devolvem a resposta gravada, sem 409 e sem
 *     executar o efeito de novo;
 *  2. a mesma chave com outro corpo dá conflito (409), sem executar;
 *  3. o recibo guarda os 32 bytes do digest — o formato de `fn_create_tenant_with_owner`
 *     (`decode(p_hash, 'hex')`), o outro escritor da tabela;
 *  4. o recibo gravado ANTES do conserto (64 bytes ASCII, vive até 24 h) continua
 *     casando: replay com o mesmo corpo, conflito com outro — nunca 500.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { comIdempotencia, hashDoCorpo } from "@/lib/api/idempotency";

import { pgComoSupabase } from "../pg-como-supabase";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const db = pgComoSupabase(pool);

const ORG = "1de70000-0000-4000-8000-00000000000a";
const CHAVE = "1de70000-0000-4000-8000-0000000000c1";
const ENDPOINT = "/api/v1/telefonia/numeros";
const CORPO = { nome: "Recepção", numero: "(61) 3000-0000", time_id: null };

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'idem-recibo-bytea', 'Idem Recibo', 'Idem Recibo') on conflict (id) do nothing`,
    [ORG],
  );
});

beforeEach(async () => {
  await pool.query("delete from idempotency_keys where organization_id = $1", [ORG]);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

const pedir = (corpo: unknown, executar: () => Promise<{ resposta: { id: string }; status: number }>) =>
  comIdempotencia<{ id: string }>({ db, organizationId: ORG, endpoint: ENDPOINT, chave: CHAVE, corpo, executar });

describe("comIdempotencia contra a coluna bytea de verdade", () => {
  it("a mesma chave e o mesmo corpo: a segunda devolve a resposta gravada — sem 409 e sem segundo efeito", async () => {
    const executar = vi.fn(async () => ({ resposta: { id: "numero-1" }, status: 201 }));

    const primeira = await pedir(CORPO, executar);
    const segunda = await pedir({ ...CORPO }, executar);

    expect(primeira).toEqual({ tipo: "executou", resposta: { id: "numero-1" }, status: 201 });
    expect(segunda).toEqual({ tipo: "replay", resposta: { id: "numero-1" }, status: 201 });
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("a mesma chave com outro corpo: conflito (409), sem executar de novo", async () => {
    const executar = vi.fn(async () => ({ resposta: { id: "numero-1" }, status: 201 }));

    await pedir(CORPO, executar);
    const outro = await pedir({ ...CORPO, nome: "Outro nome" }, executar);

    expect(outro).toEqual({ tipo: "conflito" });
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("o recibo guarda os 32 bytes do digest — o mesmo formato do RPC de tenant (decode(p_hash, 'hex'))", async () => {
    await pedir(CORPO, async () => ({ resposta: { id: "numero-1" }, status: 201 }));

    const { rows } = await pool.query<{ bytes: number; hex: string }>(
      "select length(request_hash) as bytes, encode(request_hash, 'hex') as hex from idempotency_keys where organization_id = $1",
      [ORG],
    );
    expect(rows).toEqual([{ bytes: 32, hex: hashDoCorpo(CORPO) }]);
  });

  it("recibo gravado ANTES do conserto (64 bytes ASCII) ainda casa: replay com o mesmo corpo, conflito com outro — nunca 500", async () => {
    // Exatamente o que o helper antigo mandava: o hash hex sem o prefixo, pela mesma cadeia.
    const { error } = await db.from("idempotency_keys").insert({
      organization_id: ORG,
      key: CHAVE,
      endpoint: ENDPOINT,
      request_hash: hashDoCorpo(CORPO),
      status_code: 201,
      response_body: { id: "numero-antigo" },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(error).toBeNull();
    const { rows } = await pool.query<{ bytes: number }>(
      "select length(request_hash) as bytes from idempotency_keys where organization_id = $1",
      [ORG],
    );
    expect(rows[0]!.bytes).toBe(64); // controle: é mesmo o formato antigo

    const executar = vi.fn(async () => ({ resposta: { id: "numero-novo" }, status: 201 }));
    expect(await pedir(CORPO, executar)).toEqual({ tipo: "replay", resposta: { id: "numero-antigo" }, status: 201 });
    expect(await pedir({ ...CORPO, nome: "Outro nome" }, executar)).toEqual({ tipo: "conflito" });
    expect(executar).not.toHaveBeenCalled();
  });
});
