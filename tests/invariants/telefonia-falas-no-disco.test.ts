/**
 * O SQL DAS FALAS NO DISCO CONTRA POSTGRES REAL (lib/channels/telefonia/falas-no-disco.ts).
 *
 * O módulo é provado com um banco de mentira em falas-no-disco.test.ts; aqui se
 * prova que as duas consultas dele fazem, no schema de verdade (baseline + 0288),
 * o que a limpeza precisa — porque a limpeza APAGA do Storage, e uma consulta que
 * devolve "ninguém usa" por engano apaga áudio em uso:
 *
 *  1. `SQL_PRONTAS` pagina por `storage_path` a instalação inteira (as DUAS
 *     organizações), sem repetir caminho entre páginas nem dentro delas (duas
 *     falas com o mesmo áudio), e sem linha `failed`;
 *  2. `SQL_REFERENCIADOS` responde só pela organização pedida — o mesmo hash na
 *     outra organização é outro caminho e não conta — e conta linha em QUALQUER
 *     estado (uma `failed` com caminho segura o objeto);
 *  3. a fala do menu ARQUIVADO (pela `arquivarMenu` real, que apaga as falas dele)
 *     deixa de aparecer como referenciada e como pronta;
 *  4. de ponta a ponta, com o pool real: a passada baixa as prontas das duas
 *     organizações, e a limpeza do Storage apaga o áudio do menu arquivado — e só
 *     ele — depois da carência.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CARENCIA_DO_ORFAO_MS,
  FalasNoDisco,
  SQL_PRONTAS,
  SQL_REFERENCIADOS,
} from "@/lib/channels/telefonia/falas-no-disco";
import type { ObjetoDoArmazem, PortaDoArmazem } from "@/lib/telefonia/armazem";
import { arquivarMenu } from "@/lib/telefonia/menus";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0212-0000-4000-8000-00000000000a";
const OUTRA = "c0de0212-0000-4000-8000-00000000000b";
const TIME = "c0de0212-2222-4000-8000-000000000001";
const TIME_OUTRA = "c0de0212-2222-4000-8000-000000000002";
const MENU = "c0de0212-4444-4000-8000-000000000001";
const FALA_DO_MENU = "c0de0212-3333-4000-8000-000000000001";
const FALA_INVALIDA_DO_MENU = "c0de0212-3333-4000-8000-000000000002";
const hash = (c: string) => c.repeat(64);
const caminho = (org: string, c: string) => `${org}/${hash(c)}.ulaw`;

/** Linhas de `phone_prompts`: [org, kind, hash, status, com caminho?]. */
const FALAS: Array<[string, string, string, "ready" | "failed", boolean]> = [
  [ORG, "menu", "a", "ready", true],
  [ORG, "invalid", "a", "ready", true], // o mesmo áudio em duas falas: UM caminho
  [ORG, "waiting", "b", "ready", true],
  [ORG, "nobody", "c", "failed", true], // failed com caminho: segura o objeto
  [ORG, "after_hours", "e", "failed", false],
  [OUTRA, "menu", "a", "ready", true], // o MESMO hash de ORG: outro caminho
  [OUTRA, "waiting", "d", "ready", true],
];

async function prontasPaginadas(lote: number): Promise<{ caminhos: string[]; paginas: number }> {
  const caminhos: string[] = [];
  let depois = "";
  let paginas = 0;
  for (;;) {
    const { rows } = await pool.query<{ storage_path: string }>(SQL_PRONTAS, [depois, lote]);
    paginas++;
    expect(rows.length).toBeLessThanOrEqual(lote);
    caminhos.push(...rows.map((r) => r.storage_path));
    if (rows.length < lote) return { caminhos, paginas };
    depois = rows[rows.length - 1]!.storage_path;
  }
}

async function referenciados(org: string, caminhos: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ storage_path: string }>(SQL_REFERENCIADOS, [org, caminhos]);
  return [...new Set(rows.map((r) => r.storage_path))].sort();
}

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'falas-disco-a', 'Falas disco A', 'Falas disco A'), ($2, 'falas-disco-b', 'Falas disco B', 'Falas disco B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug, schedule) values
       ($1, $3, 'Suporte', 'suporte', '{}'::jsonb), ($2, $4, 'Suporte B', 'suporte', '{}'::jsonb)
     on conflict (id) do nothing`,
    [TIME, TIME_OUTRA, ORG, OUTRA],
  );
  for (const [org, kind, h, status, comCaminho] of FALAS) {
    await pool.query(
      `insert into public.phone_prompts
         (organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
       values ($1, $2, 'Fala de teste.', 'v', 'm', $3, $4, $5, $6)`,
      [org, kind, hash(h), comCaminho ? caminho(org, h) : null, comCaminho ? 1500 : null, status],
    );
  }
  // O menu que vai ser arquivado, com as duas falas dele.
  await pool.query(
    `insert into public.phone_prompts
       (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
     values ($1, $3, 'menu', 'Menu velho.', 'v', 'm', $4, $5, 1500, 'ready'),
            ($2, $3, 'invalid', 'Tecla inválida.', 'v', 'm', $6, $7, 1500, 'ready')`,
    [FALA_DO_MENU, FALA_INVALIDA_DO_MENU, ORG, hash("4"), caminho(ORG, "4"), hash("5"), caminho(ORG, "5")],
  );
  await pool.query(
    `insert into public.phone_menus (id, organization_id, name, prompt_id, invalid_prompt_id, default_team_id)
     values ($1, $2, 'Menu velho', $3, $4, $5)`,
    [MENU, ORG, FALA_DO_MENU, FALA_INVALIDA_DO_MENU, TIME],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("SQL_PRONTAS — as falas prontas da instalação, em páginas", () => {
  it("as duas organizações, sem repetir caminho, sem failed, em ordem, qualquer que seja o tamanho da página", async () => {
    const esperado = [
      caminho(ORG, "4"),
      caminho(ORG, "5"),
      caminho(ORG, "a"),
      caminho(ORG, "b"),
      caminho(OUTRA, "a"),
      caminho(OUTRA, "d"),
    ].sort();
    for (const lote of [1, 2, 4, 100]) {
      const { caminhos, paginas } = await prontasPaginadas(lote);
      expect(caminhos, `lote ${lote}`).toEqual(esperado);
      expect(new Set(caminhos).size).toBe(caminhos.length);
      if (lote === 2) expect(paginas).toBe(4); // 6 caminhos em páginas de 2, e a página vazia que encerra
    }
  });
});

describe("SQL_REFERENCIADOS — quem usa o caminho, só na organização pedida", () => {
  it("conta linha pronta e failed da organização; ignora a outra organização e o caminho sem linha", async () => {
    const perguntados = [caminho(ORG, "a"), caminho(ORG, "c"), caminho(ORG, "f"), caminho(OUTRA, "a"), caminho(OUTRA, "d")];
    expect(await referenciados(ORG, perguntados)).toEqual([caminho(ORG, "a"), caminho(ORG, "c")].sort());
    expect(await referenciados(OUTRA, perguntados)).toEqual([caminho(OUTRA, "a"), caminho(OUTRA, "d")].sort());
  });

  it("o caminho de ORG perguntado em nome da OUTRA não aparece, mesmo com o mesmo hash", async () => {
    expect(await referenciados(OUTRA, [caminho(ORG, "a"), caminho(ORG, "b")])).toEqual([]);
  });
});

describe("a fala do menu arquivado deixa de ser referenciada", () => {
  it("antes de arquivar, as duas falas do menu seguram os objetos; depois, nenhuma — e saem das prontas", async () => {
    const doMenu = [caminho(ORG, "4"), caminho(ORG, "5")];
    expect(await referenciados(ORG, doMenu)).toEqual(doMenu.sort());

    expect(await arquivarMenu(pool, ORG, MENU)).toMatchObject({ ok: true });

    expect(await referenciados(ORG, doMenu)).toEqual([]);
    const { caminhos } = await prontasPaginadas(2);
    expect(caminhos).not.toContain(caminho(ORG, "4"));
    expect(caminhos).not.toContain(caminho(ORG, "5"));
    // As falas que não eram do menu continuam.
    expect(await referenciados(ORG, [caminho(ORG, "a"), caminho(ORG, "b")])).toEqual([caminho(ORG, "a"), caminho(ORG, "b")].sort());
  });
});

describe("de ponta a ponta com o pool real", () => {
  it("a passada baixa as prontas das duas organizações, e a limpeza apaga do Storage só o áudio sem linha", async () => {
    const dir = await mkdtemp(join(tmpdir(), "falas-invariante-"));
    try {
      let relogio = Date.now();
      const criado = new Date(relogio - 48 * 3_600_000);
      // O Storage: as prontas (menu já arquivado), a failed com caminho e o áudio do menu arquivado.
      let lista: ObjetoDoArmazem[] = [
        caminho(ORG, "a"),
        caminho(ORG, "b"),
        caminho(ORG, "c"),
        caminho(ORG, "4"),
        caminho(ORG, "5"),
        caminho(OUTRA, "a"),
        caminho(OUTRA, "d"),
      ].map((c) => ({ caminho: c, criadoEm: criado }));
      const apagados: string[] = [];
      const armazem: Pick<PortaDoArmazem, "baixar" | "listarPastas" | "listarObjetos" | "apagar"> = {
        baixar: async (c) => (lista.some((o) => o.caminho === c) ? new Uint8Array([0xff]) : null),
        listarPastas: async () => [ORG, OUTRA],
        listarObjetos: async (pasta) => lista.filter((o) => o.caminho.startsWith(`${pasta}/`)),
        apagar: async (caminhos) => {
          const removidos = caminhos.filter((c) => lista.some((o) => o.caminho === c));
          lista = lista.filter((o) => !removidos.includes(o.caminho));
          apagados.push(...removidos);
          return removidos;
        },
      };
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const falas = new FalasNoDisco(dir, pool, armazem, log, { agora: () => relogio, lote: 2 });

      expect(await falas.sincronizar()).toEqual({ baixadas: 4, apagadas: 0, falhas: 0 });
      expect((await readdir(join(dir, ORG))).sort()).toEqual([`${hash("a")}.ulaw`, `${hash("b")}.ulaw`].sort());
      expect((await readdir(join(dir, OUTRA))).sort()).toEqual([`${hash("a")}.ulaw`, `${hash("d")}.ulaw`].sort());

      expect(await falas.limparStorage()).toEqual({ apagados: 0, falhas: 0, pulada: false }); // avistados
      relogio += CARENCIA_DO_ORFAO_MS;
      expect(await falas.limparStorage()).toEqual({ apagados: 2, falhas: 0, pulada: false });
      expect(apagados.sort()).toEqual([caminho(ORG, "4"), caminho(ORG, "5")].sort());
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
