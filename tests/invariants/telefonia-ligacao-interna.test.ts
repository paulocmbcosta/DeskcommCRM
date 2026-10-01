/**
 * A LIGAÇÃO INTERNA E A TROCA DE RAMAL (lado da API; migration 0291) — no
 * Postgres real, com a outra organização ao lado:
 *
 *  - `criarPedidoInterno` só liga para o ramal de um colega DESTA organização,
 *    disponível pela régua do diretório (D17); a linha nasce `internal`, sem
 *    número da empresa, com `peer_user_id`; e o colega fica "em ligação";
 *  - `trocarRamal` troca o número, recusa o de outra pessoa (409) e quem não tem
 *    ramal; o número de outra organização não conta como "em uso".
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lerDiretorio } from "@/lib/channels/telefonia/diretorio";
import { criarPedidoInterno, meuRamal, trocarRamal } from "@/lib/channels/telefonia/interna";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0294-0000-4000-8000-00000000000a";
const OUTRA = "c0de0294-0000-4000-8000-00000000000b";
const ANA = "c0de0294-1111-4000-8000-000000000001";
const BIA = "c0de0294-1111-4000-8000-000000000002";
const CAIO = "c0de0294-1111-4000-8000-000000000003";
const VIEWER = "c0de0294-1111-4000-8000-000000000004";
const ZE = "c0de0294-1111-4000-8000-000000000005";
const AGORA = new Date("2026-09-28T13:00:00Z");
const ONLINE = new Set([ANA, BIA, CAIO, ZE]);

const ramal = async (org: string, u: string) => meuRamal(pool, org, u);

beforeAll(async () => {
  await pool.query(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}', 'ana-0294@invariant.test', '{"full_name":"Ana"}'), ('${BIA}', 'bia-0294@invariant.test', '{"full_name":"Bia"}'),
      ('${CAIO}', 'caio-0294@invariant.test', '{"full_name":"Caio"}'), ('${VIEWER}', 'v-0294@invariant.test', '{}'),
      ('${ZE}', 'ze-0294@invariant.test', '{"full_name":"Zé"}')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'interna-0294-a', 'Interna A', 'Interna A'), ('${OUTRA}', 'interna-0294-b', 'Interna B', 'Interna B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, created_at) values
      ('${ANA}', '${ORG}', 'agent', now(), now() - interval '3 day'),
      ('${BIA}', '${ORG}', 'agent', now(), now() - interval '2 day'),
      ('${CAIO}', '${ORG}', 'agent', now(), now() - interval '1 day'),
      ('${VIEWER}', '${ORG}', 'viewer', now(), now()),
      ('${ZE}', '${OUTRA}', 'agent', now(), now())
      on conflict do nothing;
    insert into public.attendant_availability (organization_id, user_id, is_available) values
      ('${ORG}', '${ANA}', true), ('${ORG}', '${BIA}', true), ('${ORG}', '${CAIO}', false), ('${OUTRA}', '${ZE}', true)
      on conflict (organization_id, user_id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("o pedido de ligação interna", () => {
  it("os ramais vieram do gatilho: 201, 202, 203 na ordem de entrada; viewer não tem", async () => {
    expect(await ramal(ORG, ANA)).toBe("201");
    expect(await ramal(ORG, BIA)).toBe("202");
    expect(await ramal(ORG, CAIO)).toBe("203");
    expect(await ramal(ORG, VIEWER)).toBeNull();
    expect(await ramal(OUTRA, ZE)).toBe("201");
  });

  it("para o colega disponível: a linha interna nasce sem número da empresa, e o colega fica em ligação", async () => {
    const r = await criarPedidoInterno(pool, { organizationId: ORG, userId: ANA, ramal: "202", agora: AGORA, online: ONLINE });
    expect(r).toMatchObject({ ok: true, colega: BIA });
    const linha = (
      await pool.query(`select direction, channel_session_id, peer_user_id, owner_user_id, status, peer_phone from voice_calls where id = $1`, [
        r.ok && r.id,
      ])
    ).rows[0];
    expect(linha).toEqual({ direction: "internal", channel_session_id: null, peer_user_id: BIA, owner_user_id: ANA, status: "starting", peer_phone: "202" });
    const d = await lerDiretorio(pool, ORG, CAIO, AGORA, ONLINE);
    expect(d.pessoas.find((p) => p.user_id === BIA)?.situacao).toBe("em_ligacao");
    // Quem já está numa ligação não liga de novo, e ninguém liga para quem está.
    expect(await criarPedidoInterno(pool, { organizationId: ORG, userId: ANA, ramal: "203", agora: AGORA, online: ONLINE })).toEqual({
      ok: false,
      motivo: "ja_em_ligacao",
    });
    await pool.query(`update voice_calls set status = 'ended' where id = $1`, [r.ok && r.id]);
  });

  it.each([
    ["209", "ramal_inexistente"],
    ["201", "ramal_e_seu"],
    ["203", "colega_em_pausa"],
  ])("ramal %s → %s", async (numero, motivo) => {
    expect(await criarPedidoInterno(pool, { organizationId: ORG, userId: ANA, ramal: numero, agora: AGORA, online: ONLINE })).toEqual({
      ok: false,
      motivo,
    });
  });

  it("colega offline", async () => {
    expect(
      await criarPedidoInterno(pool, { organizationId: ORG, userId: ANA, ramal: "202", agora: AGORA, online: new Set([ANA]) }),
    ).toEqual({ ok: false, motivo: "colega_offline" });
  });

  it("o ramal 201 da OUTRA organização não é alcançável daqui", async () => {
    expect(await criarPedidoInterno(pool, { organizationId: ORG, userId: BIA, ramal: "201", agora: AGORA, online: ONLINE })).toMatchObject({
      ok: true,
      colega: ANA,
    });
    await pool.query(`update voice_calls set status = 'ended' where organization_id = $1`, [ORG]);
  });
});

describe("a troca de ramal pelo admin", () => {
  it("troca e devolve o anterior; o de outra pessoa é recusado; o número de outra organização está livre aqui", async () => {
    expect(await trocarRamal(pool, { organizationId: ORG, userId: BIA, numero: "300", por: ANA })).toEqual({ ok: true, antes: "202" });
    expect(await ramal(ORG, BIA)).toBe("300");
    expect(await trocarRamal(pool, { organizationId: ORG, userId: CAIO, numero: "300", por: ANA })).toEqual({
      ok: false,
      motivo: "ramal_em_uso",
    });
    expect(await trocarRamal(pool, { organizationId: OUTRA, userId: ZE, numero: "300", por: ZE })).toEqual({ ok: true, antes: "201" });
  });

  it("quem não tem ramal (viewer, ou de outra organização) não é trocado", async () => {
    expect(await trocarRamal(pool, { organizationId: ORG, userId: VIEWER, numero: "400", por: ANA })).toEqual({ ok: false, motivo: "sem_ramal" });
    expect(await trocarRamal(pool, { organizationId: ORG, userId: ZE, numero: "400", por: ANA })).toEqual({ ok: false, motivo: "sem_ramal" });
  });

  it("o número liberado volta a ser o próximo livre", async () => {
    await pool.query(`insert into auth.users (id, email) values ('c0de0294-1111-4000-8000-000000000009', 'n-0294@invariant.test')`);
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at) values ('c0de0294-1111-4000-8000-000000000009', $1, 'agent', now())`,
      [ORG],
    );
    expect(await ramal(ORG, "c0de0294-1111-4000-8000-000000000009")).toBe("202");
  });
});
