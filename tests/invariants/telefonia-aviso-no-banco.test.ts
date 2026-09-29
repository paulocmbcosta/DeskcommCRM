/**
 * O AVISO DE INSTABILIDADE NO BANCO DE VERDADE — o SQL de
 * lib/telefonia/emergencias.ts contra o schema do baseline (migration 0288), com
 * conexões reais.
 *
 * O teste de unidade (emergencias.test.ts) usa um banco em memória que só
 * reconhece o formato das consultas. Aqui se prova o que só o Postgres sabe:
 *  1. ligar grava a fala e o aviso numa transação só, e a leitura (`avisosDaOrg`)
 *     o vê vigente — só na organização dele; o time de outra organização não
 *     liga, e o CHECK `attendance_teams_phone_emergency_check` aceita o que ligar grava;
 *  2. duas primeiras ligações simultâneas do mesmo aviso saem com UMA linha de
 *     `phone_prompts` — a trava da linha do time e a decisão de novo sob ela; o
 *     CONTROLE, sem a trava, mostra a linha órfã que o teste diz prender;
 *  3. a trava do time segurada além do `lock_timeout` desiste com
 *     `gravacao_em_andamento`, sem gravar e sem ficar presa;
 *  4. a trava do time (`for no key update`) NÃO faz a LIGAÇÃO esperar: o INSERT em
 *     `voice_calls` com aquele `team_id` (a FK pede `key share`) entra na hora — com
 *     a linha travada e também depois do UPDATE do aviso, na mesma transação — e o
 *     CONTROLE com `for update` mostra a ligação caindo no `lock_timeout`;
 *  5. desligar tira o aviso vigente e deixa o texto salvo no time; o já desligado e
 *     o VENCIDO ainda não varrido não são tocados (o vencido é da passada do worker).
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { avisosDaOrg, desligarAvisoDoTime, ligarAvisoDoTime, type PedidoDeLigarAviso } from "@/lib/telefonia/emergencias";
import { caminhoDaFala, hashDaFala } from "@/lib/telefonia/falas";
import type { ConexaoDaTransacao } from "@/lib/telefonia/transacao";

import { sql } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "c0de0288-ae00-4000-8000-00000000000a";
const ORG_B = "c0de0288-ae00-4000-8000-00000000000b";
const TIME_A = "c0de0288-ae00-4000-8000-0000000000a1";
const TIME_B = "c0de0288-ae00-4000-8000-0000000000b1";
const NUMERO_A = "c0de0288-ae00-4000-8000-0000000000c1";
const GERENTE = "c0de0288-ae00-4000-8000-0000000000d1";
const VOZ = "voz-aviso";
const MODELO = "eleven_multilingual_v2";
const TEXTO = "Estamos com instabilidade no sistema. Já estamos resolvendo.";
const HASH = hashDaFala(TEXTO, VOZ, MODELO);
const HORA = 3_600_000;

/**
 * A leitura TRAVADA da linha do time (`travarTimeDoAviso`), reconhecida pelo texto
 * normalizado — espaço, quebra de linha e indentação do SQL não mudam a resposta.
 */
const ehTravaDoTime = (texto: string) =>
  /from attendance_teams where id = \$1 and organization_id = \$2 for no key update$/i.test(texto.replace(/\s+/g, " ").trim());
/** O UPDATE que liga o aviso — já dentro da transação, com a linha do time escrita. */
const ehLigarNoTime = (texto: string) => /^update attendance_teams set phone_emergency_prompt_id/i.test(texto.replace(/\s+/g, " ").trim());

/** O Storage em memória: a prévia de A está guardada; nada de B. */
const armazem = {
  baixar: async (caminho: string) => (caminho === caminhoDaFala(ORG_A, HASH) ? new Uint8Array(1600) : null),
};
const semNomes = async () => new Map<string, string | null>();

const pedido = (p: Partial<PedidoDeLigarAviso> = {}): PedidoDeLigarAviso => {
  const desde = new Date();
  return {
    pool,
    armazem,
    organizationId: ORG_A,
    userId: GERENTE,
    teamId: TIME_A,
    fala: { texto: TEXTO, hash: HASH },
    desde,
    expiraEm: new Date(desde.getTime() + 2 * HORA),
    ...p,
  };
};
const falasDoAviso = async (org: string) =>
  (await pool.query<{ id: string }>("select id from phone_prompts where organization_id = $1 and kind = 'emergency'", [org])).rows;
const avisoNoBanco = async (teamId = TIME_A) =>
  (
    await pool.query<{ fala_id: string | null; desde: Date | null; expira: Date | null }>(
      `select phone_emergency_prompt_id as fala_id, phone_emergency_active_since as desde, phone_emergency_expires_at as expira
         from attendance_teams where id = $1`,
      [teamId],
    )
  ).rows[0]!;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * O pool de verdade com um PORTÃO logo depois do comando escolhido (`ehPonto`): a
 * transação para ali, segurando o que já travou, até o caso abrir. `tirarTrava` é
 * a gravação sem o conserto: a mesma leitura, sem `for no key update`.
 */
function poolComPortao(ehPonto: (texto: string) => boolean) {
  let abrir: () => void = () => undefined;
  const portao = new Promise<void>((r) => (abrir = r));
  let avisar: () => void = () => undefined;
  const chegou = new Promise<void>((r) => (avisar = r));
  const embrulhado: PedidoDeLigarAviso["pool"] = {
    query: pool.query.bind(pool) as PedidoDeLigarAviso["pool"]["query"],
    connect: async (): Promise<ConexaoDaTransacao> => {
      const c = await pool.connect();
      return {
        release: (erro?: Error) => c.release(erro),
        query: (async (texto: string, valores?: unknown[]) => {
          const r = await c.query(texto, valores);
          if (ehPonto(texto)) {
            avisar();
            await portao;
          }
          return r;
        }) as ConexaoDaTransacao["query"],
      };
    },
  };
  // Se o código sob teste deixar de passar pelo ponto, o caso fica VERMELHO em segundos, não pendurado.
  const chegouAoPortao = () =>
    Promise.race([
      chegou,
      esperar(5_000).then(() => {
        throw new Error("a transação não chegou ao ponto do portão em 5 s");
      }),
    ]);
  return { pool: embrulhado, chegouAoPortao, abrir };
}

/**
 * O pool de verdade com o ponto de encontro logo DEPOIS da leitura da linha do
 * time na transação — a técnica de telefonia-menus-no-banco.test.ts: sem o
 * encontro, a primeira transação podia terminar antes de a segunda começar, e o
 * teste passaria mesmo sem trava.
 */
function poolComEncontro({ tirarTrava = false, prazoMs = 500 } = {}) {
  let chegaram = 0;
  let liberar: () => void = () => undefined;
  const todosChegaram = new Promise<void>((r) => (liberar = r));
  const encontro = async () => {
    if (++chegaram >= 2) liberar();
    await Promise.race([todosChegaram, esperar(prazoMs)]);
  };
  const embrulhado: PedidoDeLigarAviso["pool"] = {
    query: pool.query.bind(pool) as PedidoDeLigarAviso["pool"]["query"],
    connect: async (): Promise<ConexaoDaTransacao> => {
      const c = await pool.connect();
      return {
        release: (erro?: Error) => c.release(erro),
        query: (async (texto: string, valores?: unknown[]) => {
          const comando = tirarTrava ? texto.replace(/\s+for no key update\s*$/i, "") : texto;
          const r = await c.query(comando, valores);
          if (ehTravaDoTime(texto)) await encontro();
          return r;
        }) as ConexaoDaTransacao["query"],
      };
    },
  };
  return embrulhado;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${GERENTE}', 'gerente-aviso@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aviso-no-banco-a', 'Aviso A', 'Aviso A'), ('${ORG_B}', 'aviso-no-banco-b', 'Aviso B', 'Aviso B')
      on conflict (id) do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A}', '${ORG_A}', 'Suporte', 'suporte-aviso'), ('${TIME_B}', '${ORG_B}', 'Suporte B', 'suporte-aviso')
      on conflict (id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values
      ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'Recepção', '+556130009901',
       'voip.aviso-a.com.br', 5060, 'udp', 'u-aviso-a', '\\x00')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`
    delete from public.voice_calls where organization_id in ('${ORG_A}', '${ORG_B}');
    update public.attendance_teams
       set phone_emergency_prompt_id = null, phone_emergency_active_since = null,
           phone_emergency_expires_at = null, phone_emergency_activated_by = null
     where id in ('${TIME_A}', '${TIME_B}');
    delete from public.phone_prompts where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.phone_settings where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.phone_settings (organization_id, voice_id, model_id) values
      ('${ORG_A}', '${VOZ}', '${MODELO}'), ('${ORG_B}', '${VOZ}', '${MODELO}');
  `);
});

afterAll(() => pool.end());

describe("ligarAvisoDoTime no Postgres real", () => {
  it("liga: fala e aviso numa transação; a leitura o vê vigente, só na organização dele", async () => {
    const p = pedido();
    const r = await ligarAvisoDoTime(p);
    expect(r).toMatchObject({ ok: true, mudou: true, anterior: null, time: { id: TIME_A, nome: "Suporte" } });
    if (!r.ok) throw new Error("devia ligar");
    const quem = await pool.query<{ ativado_por: string }>(
      "select phone_emergency_activated_by as ativado_por from attendance_teams where id = $1",
      [TIME_A],
    );
    expect(quem.rows[0]!.ativado_por).toBe(GERENTE);

    const noBanco = await avisoNoBanco();
    expect(noBanco.fala_id).toBe(r.fala.id);
    expect(noBanco.desde!.getTime()).toBe(p.desde.getTime());
    expect(noBanco.expira!.getTime()).toBe(p.expiraEm!.getTime());

    const [aviso] = await avisosDaOrg(pool, ORG_A, new Date(), semNomes);
    expect(aviso).toMatchObject({
      team_id: TIME_A,
      ativa: true,
      desde: p.desde.toISOString(),
      expira_em: p.expiraEm!.toISOString(),
      fala: { id: r.fala.id, tipo: "emergency", texto: TEXTO, hash: HASH, status: "ready", duracao_ms: 200 },
    });
    // B não enxerga o aviso de A; o time de B não é ligado por A.
    expect((await avisosDaOrg(pool, ORG_B, new Date(), semNomes)).every((a) => !a.ativa && a.team_id === TIME_B)).toBe(true);
    expect(await ligarAvisoDoTime(pedido({ teamId: TIME_B }))).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect((await avisoNoBanco(TIME_B)).desde).toBeNull();
  });

  it("'até eu desligar': o CHECK aceita o prazo nulo, e a leitura diz vigente sem prazo", async () => {
    expect(await ligarAvisoDoTime(pedido({ expiraEm: null }))).toMatchObject({ ok: true });
    expect((await avisoNoBanco()).expira).toBeNull();
    expect((await avisosDaOrg(pool, ORG_A, new Date(Date.now() + 48 * HORA), semNomes))[0]).toMatchObject({ ativa: true, expira_em: null });
  });

  it("duas primeiras ligações simultâneas do aviso: UMA linha de fala, e o time aponta para ela", async () => {
    const juntos = poolComEncontro();
    const [a, b] = await Promise.all([ligarAvisoDoTime(pedido({ pool: juntos })), ligarAvisoDoTime(pedido({ pool: juntos }))]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    const falas = await falasDoAviso(ORG_A);
    expect(falas).toHaveLength(1);
    expect((await avisoNoBanco()).fala_id).toBe(falas[0]!.id);
  });

  it("CONTROLE — sem a trava, o mesmo encontro deixa a linha órfã (o teste enxerga o defeito que diz prender)", async () => {
    const juntos = poolComEncontro({ tirarTrava: true });
    await Promise.all([ligarAvisoDoTime(pedido({ pool: juntos })), ligarAvisoDoTime(pedido({ pool: juntos }))]);
    expect(await falasDoAviso(ORG_A)).toHaveLength(2);
  });

  it("a linha do time travada por outra transação além de 4 s: gravacao_em_andamento, sem ficar presa nem gravar", async () => {
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from attendance_teams where id = $1 for no key update", [TIME_A]);

      const inicio = Date.now();
      const r = await ligarAvisoDoTime(pedido());
      const esperou = Date.now() - inicio;

      expect(r).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
      expect(esperou).toBeGreaterThanOrEqual(3_500);
      expect(esperou).toBeLessThan(8_000);
    } finally {
      await dono.query("rollback");
      dono.release();
    }
    expect(await falasDoAviso(ORG_A)).toHaveLength(0);
    expect((await avisoNoBanco()).desde).toBeNull();
    // A conexão voltou ao pool sã: ligar de novo, sem ninguém na trava, passa.
    expect(await ligarAvisoDoTime(pedido())).toMatchObject({ ok: true });
  });
});

describe("a trava do time não faz a LIGAÇÃO esperar", () => {
  /** A ligação entrando na fila do time: o INSERT em voice_calls com `team_id`, com 1 s de prazo de trava. */
  const inserirLigacao = async (): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local lock_timeout = '1s'");
      await c.query(
        `insert into voice_calls (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, team_id)
         values ($1, $2, 'sip_trunk', 'aviso-' || gen_random_uuid(), 'inbound', '+5561999997777', 'ringing', $3)`,
        [ORG_A, NUMERO_A, TIME_A],
      );
      await c.query("commit");
      return "entrou";
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      return (e as { code?: string }).code ?? "erro";
    } finally {
      c.release();
    }
  };

  for (const [quando, ponto] of [
    ["com a linha do time travada (for no key update)", ehTravaDoTime],
    ["depois do UPDATE que liga o aviso, na mesma transação", ehLigarNoTime],
  ] as const) {
    it(`${quando}: o INSERT da ligação com aquele team_id entra na hora`, async () => {
      const portao = poolComPortao(ponto);
      const ligando = ligarAvisoDoTime(pedido({ pool: portao.pool }));
      try {
        await portao.chegouAoPortao();
        const inicio = Date.now();
        expect(await inserirLigacao()).toBe("entrou");
        expect(Date.now() - inicio).toBeLessThan(900);
      } finally {
        portao.abrir();
        // A transação termina ANTES do caso acabar: o `beforeEach` seguinte usa `sql()`
        // síncrono, que prende o event loop — com a trava segura, o arquivo penduraria.
        await Promise.allSettled([ligando]);
      }
      expect(await ligando).toMatchObject({ ok: true });
    });
  }

  it("CONTROLE — com o time em for update, o mesmo INSERT espera e cai no lock_timeout (55P03)", async () => {
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from attendance_teams where id = $1 for update", [TIME_A]);
      expect(await inserirLigacao()).toBe("55P03");
    } finally {
      await dono.query("rollback").catch(() => undefined);
      dono.release();
    }
  });
});

describe("desligarAvisoDoTime no Postgres real", () => {
  it("vigente: desliga, devolve o período e deixa o texto salvo no time", async () => {
    const p = pedido();
    const r = await ligarAvisoDoTime(p);
    if (!r.ok) throw new Error("devia ligar");
    expect(await desligarAvisoDoTime(pool, ORG_A, TIME_A, new Date())).toEqual({
      ok: true,
      desligado: { desde: p.desde.toISOString(), expiraEm: p.expiraEm!.toISOString() },
    });
    expect(await avisoNoBanco()).toEqual({ fala_id: r.fala.id, desde: null, expira: null });
    // Desligado, a leitura ainda traz a fala — o cartão mostra o texto salvo.
    expect((await avisosDaOrg(pool, ORG_A, new Date(), semNomes))[0]).toMatchObject({ ativa: false, fala: { id: r.fala.id } });
    // Já desligado: nada muda.
    expect(await desligarAvisoDoTime(pool, ORG_A, TIME_A, new Date())).toEqual({ ok: true, desligado: null });
  });

  it("vencido e ainda não varrido: não é tocado (é da passada do worker); de outra organização: nao_encontrado", async () => {
    sql(`
      update public.attendance_teams
         set phone_emergency_active_since = now() - interval '3 hours', phone_emergency_expires_at = now() - interval '1 hour'
       where id = '${TIME_A}';
    `);
    const antes = await avisoNoBanco();
    expect(await desligarAvisoDoTime(pool, ORG_A, TIME_A, new Date())).toEqual({ ok: true, desligado: null });
    expect(await avisoNoBanco()).toEqual(antes);
    expect(await desligarAvisoDoTime(pool, ORG_B, TIME_A, new Date())).toEqual({ ok: false, motivo: "nao_encontrado" });
  });
});
