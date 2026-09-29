/**
 * DUAS GRAVAÇÕES DA MESMA FALA GERAL AO MESMO TEMPO SAEM UMA LINHA SÓ — e quem
 * espera a trava além do prazo desiste em vez de ficar preso. Medido em Postgres
 * real, com conexões de verdade.
 *
 * O defeito que isto prende (revisão da Task 6 da fase 2 da telefonia): o "Salvar
 * e usar" da fala geral lê a fala atual (`phone_settings.<tipo>_prompt_id`) antes
 * de decidir entre regravar a linha de `phone_prompts` que existe ou criar uma.
 * Sem trava, duas PRIMEIRAS gravações simultâneas leem as duas "não há fala",
 * criam uma linha cada, e a coluna fica com a última. A outra linha fica órfã, e a
 * referência dela mantém o objeto do Storage vivo para sempre — a limpeza só apaga
 * objeto que nenhuma linha referencia.
 *
 * O conserto (`salvarFalaGeral`, lib/telefonia/falas.ts) confere o Storage ANTES
 * da transação e, dentro dela, trava a linha de `phone_settings` da organização
 * com `select ... for update` (com `lock_timeout` de 4 s), decide e grava.
 *
 * Por que o encontro logo DEPOIS da leitura de `phone_settings`: sem ele, a
 * primeira transação podia simplesmente terminar antes de a segunda começar, e o
 * teste passaria mesmo sem trava. A conexão embrulhada segura cada gravação, logo
 * depois dessa leitura, até a OUTRA também chegar ali (ou 500 ms): sem trava, as
 * duas chegam juntas e o defeito aparece sempre; com a trava, a segunda está
 * parada no `for update` e a primeira segue sozinha depois do prazo. O caso de
 * controle mede o mesmo encontro numa gravação que NÃO trava — sem ele, um
 * encontro que nunca juntasse ninguém deixaria o primeiro caso verde à toa.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  caminhoDaFala,
  hashDaFala,
  salvarFalaGeral,
  type ConexaoDaTransacao,
  type PoolDeTransacao,
} from "@/lib/telefonia/falas";

import { sql } from "./gov-helpers";

const ORG = "c0de7707-0000-4000-8000-00000000000a";
const OUTRA = "c0de7707-0000-4000-8000-00000000000b";
const VOZ = "voz-concorrente";
const MODELO = "eleven_multilingual_v2";
const TEXTO = "Aguarde, por favor, que já vamos atender.";
const HASH = hashDaFala(TEXTO, VOZ, MODELO);
const LEITURA_DA_TRAVA = /from phone_settings where organization_id = \$1( for update)?\s*$/i;

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

/** O Storage em memória: só a prévia de ORG está guardada. */
const armazem = {
  baixar: async (caminho: string) => (caminho === caminhoDaFala(ORG, HASH) ? new Uint8Array(1600) : null),
};

/**
 * O pool de verdade, com o ponto de encontro logo depois da leitura de
 * `phone_settings`. `tirarTrava` é a gravação de antes do conserto: a mesma
 * leitura, sem `for update`.
 */
function poolComEncontro({ tirarTrava = false, prazoMs = 500 } = {}) {
  let chegaram = 0;
  let dentro = 0;
  let maxDentro = 0;
  let liberar: () => void = () => undefined;
  const todosChegaram = new Promise<void>((r) => (liberar = r));
  const encontro = async () => {
    chegaram++;
    maxDentro = Math.max(maxDentro, ++dentro);
    if (chegaram >= 2) liberar();
    await Promise.race([todosChegaram, new Promise((r) => setTimeout(r, prazoMs))]);
    dentro--;
  };
  const embrulhado: PoolDeTransacao = {
    connect: async (): Promise<ConexaoDaTransacao> => {
      const c = await pool.connect();
      return {
        release: (erro?: Error) => c.release(erro),
        query: (async (texto: string, valores?: unknown[]) => {
          const comando = tirarTrava ? texto.replace(/\s+for update\s*$/i, "") : texto;
          const r = await c.query(comando, valores);
          if (LEITURA_DA_TRAVA.test(texto)) await encontro();
          return r;
        }) as ConexaoDaTransacao["query"],
      };
    },
  };
  return {
    pool: embrulhado,
    /** Quantas gravações passaram pela leitura de `phone_settings`. */
    get chegadas() {
      return chegaram;
    },
    /** Quantas estiveram depois dessa leitura AO MESMO TEMPO, no máximo. */
    get simultaneas() {
      return maxDentro;
    },
  };
}

const pedido = (p: PoolDeTransacao, organizationId = ORG) => ({
  pool: p,
  armazem,
  organizationId,
  userId: null,
  tipo: "waiting" as const,
  texto: TEXTO,
  hash: HASH,
});
const linhasDe = async (org: string) =>
  (await pool.query<{ id: string }>("select id from phone_prompts where organization_id = $1 and kind = 'waiting'", [org])).rows;
const ponteiro = async () =>
  (await pool.query<{ id: string | null }>("select waiting_prompt_id as id from phone_settings where organization_id = $1", [ORG]))
    .rows[0]?.id ?? null;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'fala-geral-concorrente-a', 'Fala Geral A', 'Fala A'),
      ('${OUTRA}', 'fala-geral-concorrente-b', 'Fala Geral B', 'Fala B')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`
    delete from public.phone_settings where organization_id in ('${ORG}', '${OUTRA}');
    delete from public.phone_prompts where organization_id in ('${ORG}', '${OUTRA}');
    insert into public.phone_settings (organization_id, voice_id, model_id) values
      ('${ORG}', '${VOZ}', '${MODELO}'), ('${OUTRA}', '${VOZ}', '${MODELO}');
  `);
});

afterAll(() => pool.end());

describe("salvarFalaGeral sob concorrência (Postgres real)", () => {
  it("duas primeiras gravações simultâneas da mesma fala: UMA linha, a coluna aponta para ela, e as duas respostas a descrevem", async () => {
    const e = poolComEncontro();

    const [a, b] = await Promise.all([salvarFalaGeral(pedido(e.pool)), salvarFalaGeral(pedido(e.pool))]);

    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    const linhas = await linhasDe(ORG);
    expect(linhas).toHaveLength(1);
    expect(await ponteiro()).toBe(linhas[0]!.id);
    expect(a.ok && a.fala.id).toBe(linhas[0]!.id);
    expect(b.ok && b.fala.id).toBe(linhas[0]!.id);
    // Uma escreveu; a outra, que esperou a trava, viu que nada mudou.
    expect([a.ok && a.mudou, b.ok && b.mudou].sort()).toEqual([false, true]);
    // A trava serializou: as duas passaram pela leitura travada, mas nunca juntas.
    expect(e.chegadas).toBe(2);
    expect(e.simultaneas).toBe(1);
  });

  it("a trava é da organização: a gravação de OUTRA organização não espera nem se mistura", async () => {
    const e = poolComEncontro();
    const [a, b] = await Promise.all([
      salvarFalaGeral(pedido(e.pool, ORG)),
      // A prévia da outra organização não está no Storage: ela é recusada sem tocar em ORG.
      salvarFalaGeral(pedido(e.pool, OUTRA)),
    ]);
    expect(a).toMatchObject({ ok: true, mudou: true });
    expect(b).toEqual({ ok: false, motivo: "previa_ausente" });
    // Não esperou: as duas estiveram depois da leitura travada ao mesmo tempo.
    expect(e.simultaneas).toBe(2);
    expect(await linhasDe(ORG)).toHaveLength(1);
    expect(await linhasDe(OUTRA)).toHaveLength(0);
  });

  it("CONTROLE — sem a trava, o mesmo encontro produz a linha órfã (o teste enxerga o defeito que diz prender)", async () => {
    const e = poolComEncontro({ tirarTrava: true });

    await Promise.all([salvarFalaGeral(pedido(e.pool)), salvarFalaGeral(pedido(e.pool))]);

    expect(e.simultaneas).toBe(2);
    expect(await linhasDe(ORG)).toHaveLength(2);
  });

  it("a trava segurada por outra transação além de 4 s: a gravação desiste com gravacao_em_andamento, sem ficar presa nem gravar", async () => {
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from phone_settings where organization_id = $1 for update", [ORG]);

      const inicio = Date.now();
      const r = await salvarFalaGeral(pedido(pool));
      const esperou = Date.now() - inicio;

      expect(r).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
      // Esperou o prazo (4 s) e não mais que isso com folga — não ficou pendurada na trava.
      expect(esperou).toBeGreaterThanOrEqual(3_500);
      expect(esperou).toBeLessThan(8_000);
      expect(await linhasDe(ORG)).toHaveLength(0);
    } finally {
      await dono.query("rollback");
      dono.release();
    }
    // A conexão voltou ao pool sã: a gravação seguinte, sem ninguém na trava, passa.
    expect(await salvarFalaGeral(pedido(pool))).toMatchObject({ ok: true, mudou: true });
    expect(await linhasDe(ORG)).toHaveLength(1);
  });
});
