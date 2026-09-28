/**
 * DUAS GRAVAÇÕES DA MESMA FALA GERAL AO MESMO TEMPO SAEM UMA LINHA SÓ — medido em
 * Postgres real, com duas conexões de verdade.
 *
 * O defeito que isto prende (revisão da Task 6 da fase 2 da telefonia): o "Salvar
 * e usar" da fala geral lê a fala atual (`phone_settings.<tipo>_prompt_id`) antes
 * de decidir entre regravar a linha de `phone_prompts` que existe ou criar uma.
 * Sem trava, duas PRIMEIRAS gravações simultâneas leem as duas "não há fala",
 * criam uma linha cada, e a coluna fica com a última. A outra linha fica órfã, e a
 * referência dela mantém o objeto do Storage vivo para sempre — a limpeza só apaga
 * objeto que nenhuma linha referencia.
 *
 * O conserto (`salvarFalaGeral`, lib/telefonia/falas.ts) trava a linha de
 * `phone_settings` da organização com `select ... for update`, na mesma transação
 * que grava a fala e aponta a coluna.
 *
 * Por que o encontro no Storage: sem ele, a primeira transação podia simplesmente
 * terminar antes de a segunda começar, e o teste passaria mesmo sem trava. O
 * `baixar` falso segura cada gravação até a OUTRA também chegar nele (ou 500 ms):
 * sem trava, as duas chegam juntas e o defeito aparece sempre; com a trava, a
 * segunda está parada no `for update` e a primeira segue sozinha depois do prazo.
 * O caso de controle mede o mesmo encontro numa gravação que NÃO trava — sem ele,
 * um encontro que nunca juntasse ninguém deixaria o primeiro caso verde à toa.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { caminhoDaFala, hashDaFala, salvarFalaGeral, type ConexaoDaTransacao } from "@/lib/telefonia/falas";

import { sql } from "./gov-helpers";

const ORG = "c0de7707-0000-4000-8000-00000000000a";
const OUTRA = "c0de7707-0000-4000-8000-00000000000b";
const VOZ = "voz-concorrente";
const MODELO = "eleven_multilingual_v2";
const TEXTO = "Aguarde, por favor, que já vamos atender.";
const HASH = hashDaFala(TEXTO, VOZ, MODELO);

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

/** O Storage em memória, com o ponto de encontro das duas gravações. */
function armazemComEncontro(prazoMs = 500) {
  let chegaram = 0;
  let dentro = 0;
  let maxDentro = 0;
  let liberar: () => void = () => undefined;
  const todosChegaram = new Promise<void>((r) => (liberar = r));
  const objetos = new Map<string, Uint8Array>([[caminhoDaFala(ORG, HASH), new Uint8Array(1600)]]);
  return {
    /** Quantas gravações chegaram a conferir o Storage. */
    get chegadas() {
      return chegaram;
    },
    /** Quantas estiveram conferindo o Storage AO MESMO TEMPO, no máximo. */
    get simultaneas() {
      return maxDentro;
    },
    baixar: async (caminho: string) => {
      chegaram++;
      maxDentro = Math.max(maxDentro, ++dentro);
      if (chegaram >= 2) liberar();
      await Promise.race([todosChegaram, new Promise((r) => setTimeout(r, prazoMs))]);
      dentro--;
      const b = objetos.get(caminho);
      return b ? new Uint8Array(b) : null;
    },
  };
}

const linhasDaOrg = async () =>
  (await pool.query<{ id: string }>("select id from phone_prompts where organization_id = $1 and kind = 'waiting'", [ORG])).rows;
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
    const armazem = armazemComEncontro();
    const pedido = { pool, armazem, organizationId: ORG, userId: null, tipo: "waiting" as const, texto: TEXTO, hash: HASH };

    const [a, b] = await Promise.all([salvarFalaGeral(pedido), salvarFalaGeral(pedido)]);

    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    const linhas = await linhasDaOrg();
    expect(linhas).toHaveLength(1);
    expect(await ponteiro()).toBe(linhas[0]!.id);
    expect(a.ok && a.fala.id).toBe(linhas[0]!.id);
    expect(b.ok && b.fala.id).toBe(linhas[0]!.id);
    // Uma escreveu; a outra, que esperou a trava, viu que nada mudou.
    expect([a.ok && a.mudou, b.ok && b.mudou].sort()).toEqual([false, true]);
    // A trava serializou: as duas conferiram o Storage, mas nunca ao mesmo tempo.
    expect(armazem.chegadas).toBe(2);
    expect(armazem.simultaneas).toBe(1);
  });

  it("a trava é da organização: a gravação de OUTRA organização não espera nem se mistura", async () => {
    const armazem = armazemComEncontro();
    const [a, b] = await Promise.all([
      salvarFalaGeral({ pool, armazem, organizationId: ORG, userId: null, tipo: "waiting", texto: TEXTO, hash: HASH }),
      // A prévia da outra organização não está no Storage: ela é recusada sem tocar em ORG.
      salvarFalaGeral({ pool, armazem, organizationId: OUTRA, userId: null, tipo: "waiting", texto: TEXTO, hash: HASH }),
    ]);
    expect(a).toMatchObject({ ok: true, mudou: true });
    expect(b).toEqual({ ok: false, motivo: "previa_ausente" });
    // Não esperou: as duas estiveram no Storage ao mesmo tempo.
    expect(armazem.simultaneas).toBe(2);
    expect(await linhasDaOrg()).toHaveLength(1);
    const daOutra = await pool.query("select 1 from phone_prompts where organization_id = $1", [OUTRA]);
    expect(daOutra.rowCount).toBe(0);
  });

  it("CONTROLE — sem a trava, o mesmo encontro produz a linha órfã (o teste enxerga o defeito que diz prender)", async () => {
    // Uma "pool" que tira o `for update` de toda consulta: é a gravação de antes do conserto.
    const semTrava = {
      connect: async (): Promise<ConexaoDaTransacao> => {
        const c = await pool.connect();
        return {
          release: () => c.release(),
          query: ((texto: string, valores?: unknown[]) =>
            c.query(texto.replace(/\s+for update\s*$/i, ""), valores)) as ConexaoDaTransacao["query"],
        };
      },
    };
    const armazem = armazemComEncontro();
    const pedido = { pool: semTrava, armazem, organizationId: ORG, userId: null, tipo: "waiting" as const, texto: TEXTO, hash: HASH };

    await Promise.all([salvarFalaGeral(pedido), salvarFalaGeral(pedido)]);

    expect(armazem.simultaneas).toBe(2);
    expect(await linhasDaOrg()).toHaveLength(2);
  });
});
