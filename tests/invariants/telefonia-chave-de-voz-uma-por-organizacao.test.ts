/**
 * A CHAVE DE VOZ DO TELEFONE É UMA POR ORGANIZAÇÃO — medido no baseline real.
 *
 * `lib/telefonia/chave-elevenlabs.ts` grava a chave da ElevenLabs em
 * `ai_provider_credentials` por upsert em `(organization_id, provider, label)`,
 * e as leituras filtram pelo MESMO trio. O teste de unidade só confere o TEXTO do
 * SQL; aqui roda o SQL de verdade (as funções do módulo, com um `pg.Pool` no
 * banco que o `test:db` monta do `baseline.sql`), porque o que protege o cliente
 * são propriedades do banco:
 *
 *  1. TROCAR a chave mantém o MESMO id da linha (a auditoria e qualquer ponteiro
 *     continuam apontando para ela) e diz que substituiu;
 *  2. nunca há uma segunda linha ativa da chave de voz na organização;
 *  3. uma organização não toca na linha da outra, e cada uma lê só a sua;
 *  4. a linha desativada volta ativa ao trocar — sem nascer outra;
 *  5. a chave de modelo da mesma organização (mesmo rótulo, outro provider) não
 *     é lida como chave de voz;
 *  6. o texto puro não está no banco.
 *
 * Chaves fictícias. A AI_CRED_AES_KEY é gerada aqui, na hora, só para a cifra.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as ModuloDaChave from "@/lib/telefonia/chave-elevenlabs";

// Antes de qualquer import que leia `lib/env` (a cifra lê a chave de lá).
process.env.AI_CRED_AES_KEY = randomBytes(32).toString("base64");

const ORG_A = "c0de0005-0000-4000-8000-00000000000a";
const ORG_B = "c0de0005-0000-4000-8000-00000000000b";
const ADMIN = "c0de0005-1111-4000-8000-00000000000a";
const CHAVE_A1 = "sk_ficticia_da_org_a_1111";
const CHAVE_A2 = "sk_ficticia_da_org_a_2222";
const CHAVE_A3 = "sk_ficticia_da_org_a_3333";
const CHAVE_B = "sk_ficticia_da_org_b_9999";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});

let m: typeof ModuloDaChave;

async function linhasDeVoz(org: string): Promise<Array<{ id: string; is_active: boolean; last4: string }>> {
  const { rows } = await pool.query<{ id: string; is_active: boolean; last4: string }>(
    `select id, is_active, api_key_last4 as last4 from ai_provider_credentials
      where organization_id = $1 and provider = $2 order by created_at`,
    [org, m.PROVEDOR_DE_VOZ],
  );
  return rows;
}

beforeAll(async () => {
  m = await import("@/lib/telefonia/chave-elevenlabs");
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'chave-voz-0005@invariant.test') on conflict (id) do nothing`,
    [ADMIN],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'chave-voz-a', 'Chave de voz A', 'Voz A'), ($2, 'chave-voz-b', 'Chave de voz B', 'Voz B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("a chave de voz do telefone, no banco real", () => {
  it("trocar a chave mantém o MESMO id, diz que substituiu e não cria segunda linha ativa", async () => {
    const primeira = await m.guardarChaveDeVoz(pool, { organizationId: ORG_A, userId: ADMIN, chave: CHAVE_A1 });
    expect(primeira.substituiu).toBe(false);

    const troca = await m.guardarChaveDeVoz(pool, { organizationId: ORG_A, userId: ADMIN, chave: CHAVE_A2 });
    expect(troca).toEqual({ id: primeira.id, last4: "2222", substituiu: true });

    const linhas = await linhasDeVoz(ORG_A);
    expect(linhas).toEqual([{ id: primeira.id, is_active: true, last4: "2222" }]);
    expect(await m.chaveDeVoz(pool, ORG_A)).toBe(CHAVE_A2);
    expect(await m.estadoDaChaveDeVoz(pool, ORG_A)).toMatchObject({ cadastrada: true, last4: "2222" });
  });

  it("uma organização não toca na linha da outra, e cada uma lê só a sua", async () => {
    const [daA] = await linhasDeVoz(ORG_A);
    const daB = await m.guardarChaveDeVoz(pool, { organizationId: ORG_B, userId: ADMIN, chave: CHAVE_B });

    expect(daB.id).not.toBe(daA!.id);
    expect(daB.substituiu).toBe(false);
    expect(await linhasDeVoz(ORG_A)).toEqual([{ id: daA!.id, is_active: true, last4: "2222" }]);
    expect(await m.chaveDeVoz(pool, ORG_A)).toBe(CHAVE_A2);
    expect(await m.chaveDeVoz(pool, ORG_B)).toBe(CHAVE_B);
    expect(await m.estadoDaChaveDeVoz(pool, ORG_B)).toMatchObject({ cadastrada: true, last4: "9999" });
  });

  it("a linha desativada some da leitura e volta ativa ao trocar — sem nascer outra", async () => {
    const [antes] = await linhasDeVoz(ORG_A);
    await pool.query(
      `update ai_provider_credentials set is_active = false where organization_id = $1 and provider = $2`,
      [ORG_A, m.PROVEDOR_DE_VOZ],
    );
    expect(await m.estadoDaChaveDeVoz(pool, ORG_A)).toEqual({ cadastrada: false, last4: null, validada_em: null });
    expect(await m.chaveDeVoz(pool, ORG_A)).toBeNull();

    const volta = await m.guardarChaveDeVoz(pool, { organizationId: ORG_A, userId: ADMIN, chave: CHAVE_A3 });
    expect(volta).toEqual({ id: antes!.id, last4: "3333", substituiu: true });
    expect(await linhasDeVoz(ORG_A)).toEqual([{ id: antes!.id, is_active: true, last4: "3333" }]);
  });

  it("a chave de MODELO da organização, com o mesmo rótulo, não é lida como chave de voz", async () => {
    await pool.query(
      `insert into ai_provider_credentials
         (organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, is_active)
       values ($1, 'anthropic', $2, '\\x00', '\\x00', '\\x00', 'xxxx', true)`,
      [ORG_A, m.ROTULO_DA_CHAVE_DE_VOZ],
    );
    expect(await m.chaveDeVoz(pool, ORG_A)).toBe(CHAVE_A3);
    expect(await m.estadoDaChaveDeVoz(pool, ORG_A)).toMatchObject({ last4: "3333" });
  });

  it("o texto puro de nenhuma das chaves está no banco", async () => {
    for (const chave of [CHAVE_A1, CHAVE_A2, CHAVE_A3, CHAVE_B]) {
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from ai_provider_credentials
          where position(convert_to($1, 'UTF8') in api_key_encrypted) > 0
             or api_key_last4 = $1 or label = $1`,
        [chave],
      );
      expect(rows[0]!.n, chave).toBe("0");
    }
  });
});
