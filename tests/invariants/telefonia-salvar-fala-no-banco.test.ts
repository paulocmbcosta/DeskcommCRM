/**
 * O "SALVAR E USAR" DAS FALAS NO BANCO — o SQL de `gravarFalaConferida`
 * (lib/telefonia/falas.ts) contra o Postgres real do baseline.
 *
 * O teste de unidade (falas.test.ts) usa um banco em memória que só reconhece o
 * formato das consultas: ele não sabe se as colunas existem, se o `returning`
 * devolve o que `LinhaDaFala` promete, nem o que os CHECKs e as FKs da 0288
 * fazem com o que o código grava. Aqui o código DE VERDADE escreve no schema DE
 * VERDADE, e o que se prova:
 *  1. cria a linha `ready` no caminho `<org>/<hash>.ulaw`, e a relê com as colunas
 *     que o código lê (inclusive `model_id`, que o conserto da fala usa);
 *  2. trocar o texto troca o hash MANTENDO o id — é o id que `phone_settings` e
 *     `phone_menus` apontam, e a ligação passa a tocar o áudio novo sem mexer neles;
 *  3. não cruza organização: um `falaAtualId` de outra organização não é regravado
 *     (o UPDATE filtra a organização e nasce uma linha da sessão), e a FK COMPOSTA
 *     recusa apontar a configuração de B para a fala de A;
 *  4. o `storage_path` bate com o CHECK `phone_prompts_storage_path_check`: o
 *     caminho que `caminhoDaFala` monta passa (também com o UUID em maiúsculas),
 *     e um caminho de outra organização ou de outro hash é recusado pelo BANCO,
 *     mesmo que o código errasse.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  caminhoDaFala,
  falaPorId,
  gravarFalaConferida,
  hashDaFala,
  type FalaConferida,
  type LinhaDaFala,
  type PedidoDeSalvar,
} from "@/lib/telefonia/falas";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG_A = "c0de0288-6666-4000-8000-00000000000a";
const ORG_B = "c0de0288-6666-4000-8000-00000000000b";
const USUARIO = "c0de0288-7777-4000-8000-00000000000a";
const VOZ = { voiceId: "voz-1", modelId: "eleven_multilingual_v2" };
const TEXTO_1 = "Aguarde, por favor.";
const TEXTO_2 = "Só um instante, já vamos atender.";
const HASH_1 = hashDaFala(TEXTO_1, VOZ.voiceId, VOZ.modelId);
const HASH_2 = hashDaFala(TEXTO_2, VOZ.voiceId, VOZ.modelId);

type Aprovada = Extract<FalaConferida, { ok: true }>;

/** O pedido do "Salvar e usar" — `armazem` não é tocado por `gravarFalaConferida`. */
const pedido = (organizationId: string, texto: string, hash: string): PedidoDeSalvar => ({
  db: pool,
  armazem: { baixar: async () => null },
  organizationId,
  userId: USUARIO,
  tipo: "waiting",
  texto,
  hash,
  falaAtualId: null,
  voz: VOZ,
});

/** O que `conferirFala` aprovaria para `hash` em `caminho`, substituindo `atual`. */
const aprovada = (atual: LinhaDaFala | null, hash: string, caminho: string): Aprovada => ({
  ok: true,
  atual,
  nova: { hash, caminho, duracaoMs: 200, voiceId: VOZ.voiceId, modelId: VOZ.modelId },
});

const linhasDa = async (org: string) =>
  (
    await pool.query<{ id: string; content_hash: string; storage_path: string }>(
      "select id, content_hash, storage_path from phone_prompts where organization_id = $1 order by created_at",
      [org],
    )
  ).rows;

beforeAll(async () => {
  await pool.query("insert into auth.users (id, email) values ($1, 'salvar-fala@invariant.test') on conflict (id) do nothing", [USUARIO]);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'salvar-fala-a', 'Salvar Fala A', 'Salvar A'), ($2, 'salvar-fala-b', 'Salvar Fala B', 'Salvar B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
  await pool.query("insert into phone_settings (organization_id) values ($1), ($2) on conflict do nothing", [ORG_A, ORG_B]);
});

afterAll(async () => {
  await pool.end();
});

describe("gravarFalaConferida no Postgres real", () => {
  let idDeA = "";

  it("cria a linha pronta no caminho <org>/<hash>.ulaw, e a relê com as colunas que o código lê", async () => {
    const { fala, mudou } = await gravarFalaConferida(pedido(ORG_A, TEXTO_1, HASH_1), aprovada(null, HASH_1, caminhoDaFala(ORG_A, HASH_1)));
    idDeA = fala.id;
    expect(mudou).toBe(true);
    expect(fala).toMatchObject({ tipo: "waiting", texto: TEXTO_1, voice_id: VOZ.voiceId, hash: HASH_1, status: "ready", duracao_ms: 200 });

    const { rows } = await pool.query(
      "select organization_id, storage_path, model_id, created_by, error from phone_prompts where id = $1",
      [idDeA],
    );
    expect(rows[0]).toEqual({
      organization_id: ORG_A,
      storage_path: `${ORG_A}/${HASH_1}.ulaw`,
      model_id: VOZ.modelId,
      created_by: USUARIO,
      error: null,
    });
    expect(await falaPorId(pool, ORG_A, idDeA)).toMatchObject({ model_id: VOZ.modelId, content_hash: HASH_1 });
  });

  it("trocar o texto troca o hash MANTENDO o id — o ponteiro de phone_settings segue valendo", async () => {
    await pool.query("update phone_settings set waiting_prompt_id = $1 where organization_id = $2", [idDeA, ORG_A]);
    const atual = await falaPorId(pool, ORG_A, idDeA);
    const { fala } = await gravarFalaConferida(
      { ...pedido(ORG_A, TEXTO_2, HASH_2), falaAtualId: idDeA },
      aprovada(atual, HASH_2, caminhoDaFala(ORG_A, HASH_2)),
    );
    expect(fala.id).toBe(idDeA);
    expect(await linhasDa(ORG_A)).toEqual([{ id: idDeA, content_hash: HASH_2, storage_path: `${ORG_A}/${HASH_2}.ulaw` }]);
    const { rows } = await pool.query("select waiting_prompt_id from phone_settings where organization_id = $1", [ORG_A]);
    expect(rows[0].waiting_prompt_id).toBe(idDeA);
  });

  it("não cruza organização: a fala de A como 'atual' de B não é regravada — nasce uma linha de B", async () => {
    const daA = await falaPorId(pool, ORG_A, idDeA);
    const { fala } = await gravarFalaConferida(
      { ...pedido(ORG_B, TEXTO_1, HASH_1), falaAtualId: idDeA },
      aprovada(daA, HASH_1, caminhoDaFala(ORG_B, HASH_1)),
    );
    expect(fala.id).not.toBe(idDeA);
    expect(await linhasDa(ORG_A)).toEqual([{ id: idDeA, content_hash: HASH_2, storage_path: `${ORG_A}/${HASH_2}.ulaw` }]);
    expect(await linhasDa(ORG_B)).toEqual([{ id: fala.id, content_hash: HASH_1, storage_path: `${ORG_B}/${HASH_1}.ulaw` }]);
  });

  it("não cruza organização: a FK composta recusa a configuração de B apontar para a fala de A (controle: a de B passa)", async () => {
    await expect(
      pool.query("update phone_settings set waiting_prompt_id = $1 where organization_id = $2", [idDeA, ORG_B]),
    ).rejects.toMatchObject({ code: "23503", constraint: "phone_settings_waiting_prompt_id_org_fkey" });
    const [daB] = await linhasDa(ORG_B);
    await expect(
      pool.query("update phone_settings set waiting_prompt_id = $1 where organization_id = $2", [daB!.id, ORG_B]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("o caminho de caminhoDaFala bate com o CHECK — também com o UUID da organização em maiúsculas", async () => {
    const hash = hashDaFala("Maiúsculas.", VOZ.voiceId, VOZ.modelId);
    const org = ORG_A.toUpperCase();
    const { fala } = await gravarFalaConferida(pedido(org, "Maiúsculas.", hash), aprovada(null, hash, caminhoDaFala(org, hash)));
    const { rows } = await pool.query("select storage_path from phone_prompts where id = $1", [fala.id]);
    expect(rows[0].storage_path).toBe(`${ORG_A}/${hash}.ulaw`);
  });

  it("o BANCO recusa caminho de outra organização ou de outro hash, mesmo que o código errasse — e nada é gravado", async () => {
    const antes = (await linhasDa(ORG_A)).length;
    const hash = hashDaFala("Caminho errado.", VOZ.voiceId, VOZ.modelId);
    await expect(
      gravarFalaConferida(pedido(ORG_A, "Caminho errado.", hash), aprovada(null, hash, caminhoDaFala(ORG_B, hash))),
    ).rejects.toMatchObject({ code: "23514", constraint: "phone_prompts_storage_path_check" });
    await expect(
      gravarFalaConferida(pedido(ORG_A, "Caminho errado.", hash), aprovada(null, hash, caminhoDaFala(ORG_A, HASH_1))),
    ).rejects.toMatchObject({ code: "23514", constraint: "phone_prompts_storage_path_check" });
    expect((await linhasDa(ORG_A)).length).toBe(antes);
  });
});
