/**
 * OS MENUS DE VOZ NO BANCO DE VERDADE — o SQL de lib/telefonia/menus.ts contra o
 * schema do baseline (migration 0288), com conexões reais.
 *
 * O teste de unidade (menus.test.ts) usa um banco em memória que só reconhece o
 * formato das consultas. Aqui se prova o que só o Postgres sabe:
 *  1. menu, opções e as duas falas saem numa transação só, e a leitura devolve o
 *     que a tela precisa (nomes dos times, falas, pronto);
 *  2. TUDO OU NADA: quando o banco recusa o time de outra organização pela FK
 *     composta no meio da transação, a fala já gravada é desfeita junto — e a
 *     recusa vira `time_invalido`, não um 500;
 *  3. duas edições simultâneas do mesmo menu que dão a ele a fala de tecla
 *     inválida saem com UMA linha dessa fala — a trava da linha do menu
 *     (`for no key update`) e a decisão de novo sob ela; o CONTROLE, sem a trava, mostra
 *     a linha órfã que o teste diz prender;
 *  4. a trava segurada além do `lock_timeout` desiste com `gravacao_em_andamento`;
 *  5. o "últimos 7 dias" soma só ligações ENCERRADAS: quem desligou no menu conta
 *     (e faz o menu "confundir"), a ligação em curso não, um `chosen` sem tecla
 *     conta como escolha mas em tecla nenhuma, a de 8 dias atrás não — e a
 *     consulta alcança o índice `idx_voice_calls_menu_recentes`;
 *  6. menu que atende um número não é arquivado (`menu_em_uso`, com o nome do
 *     número); arquivado some da lista, não serve a número e não é editado;
 *  7. arquivar e apontar um número ao menu AO MESMO TEMPO nunca terminam com o
 *     número tocando um menu arquivado — nas duas ordens e com o encontro forçado,
 *     porque as duas escritas travam a linha do menu (`travarMenuAtivo`) e o
 *     arquivamento confere o uso num comando SEPARADO. O CONTROLE (arquivar num
 *     comando só + apontar só com a FK) mostra o defeito que o teste diz prender;
 *  8. a trava do menu (`for no key update`) NÃO faz a ligação esperar: o INSERT em
 *     `voice_calls` com aquele `menu_id` (a FK pede `key share`) entra na hora —
 *     e o CONTROLE com `for update` mostra a ligação caindo no `lock_timeout`;
 *  9. arquivar apaga as falas do menu na mesma transação; o menu fica, solto delas,
 *     para o histórico das ligações;
 * 10. o `atualizarNumero` DE VERDADE (lib/channels/telefonia/numeros.ts) honra o
 *     contrato do item 7 — e não só a cópia `apontarNumero`: aponta para o menu
 *     pronto, recusa o de outra organização, o arquivado e o de fala pendente,
 *     escolher um time tira o menu, a aba antiga mantém; nas duas ordens contra o
 *     arquivamento, nunca sobra número tocando menu arquivado; e a trava da linha
 *     do número (`for no key update`) não faz a ligação esperar;
 * 11. o `criarNumero` DE VERDADE com número repetido devolve a recusa traduzida
 *     (`numero_ja_existe`), não um 500 — pelo índice único que existe hoje
 *     (recusa no INSERT) e por uma unicidade DEFERRABLE (recusa só no COMMIT, que
 *     `emTransacao` faz dentro do mesmo `try`);
 * 12. a leitura dos números (`numerosDaOrg`, a da tela) diz quando o destino foi
 *     ARQUIVADO — o time (arquivar um time não olha os números) e o menu (o
 *     produto recusa arquivar menu em uso, mas a coluna é gravável fora dele) —,
 *     com o nome, para a tela mostrar por que ninguém recebe as ligações.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  atualizarNumero,
  criarNumero,
  numeroSchema,
  numerosDaOrg,
  type EntradaDoNumero,
} from "@/lib/channels/telefonia/numeros";
import { caminhoDaFala, hashDaFala } from "@/lib/telefonia/falas";
import {
  CONSULTA_DA_SEMANA,
  arquivarMenu,
  menusDaOrg,
  salvarMenuDaOrg,
  situacaoDoMenuParaNumero,
  travarMenuAtivo,
  type EntradaDoMenu,
  type PedidoDeSalvarMenu,
} from "@/lib/telefonia/menus";
import {
  confirmar,
  desfazer,
  emTransacao,
  type ConexaoDaTransacao,
  type PoolDeTransacao,
} from "@/lib/telefonia/transacao";
import { menuConfunde } from "@/lib/telefonia/ultimos-sete-dias";

import { sql } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "c0de0288-8888-4000-8000-00000000000a";
const ORG_B = "c0de0288-8888-4000-8000-00000000000b";
const TIME_A1 = "c0de0288-8888-4000-8000-0000000000a1";
const TIME_A2 = "c0de0288-8888-4000-8000-0000000000a2";
const TIME_B1 = "c0de0288-8888-4000-8000-0000000000b1";
const NUMERO_A = "c0de0288-8888-4000-8000-0000000000c1";
const NUMERO_B = "c0de0288-8888-4000-8000-0000000000c2";
const VOZ = "voz-menus";
const MODELO = "eleven_multilingual_v2";
const TEXTO_MENU = "Para Suporte, digite 1. Para Financeiro, digite 2.";
const HASH_MENU = hashDaFala(TEXTO_MENU, VOZ, MODELO);
const TEXTO_INVALIDA = "Opção inválida.";
const HASH_INVALIDA = hashDaFala(TEXTO_INVALIDA, VOZ, MODELO);
/**
 * A leitura TRAVADA da linha do menu (`travarMenuAtivo`), reconhecida pelo texto
 * normalizado — espaço, quebra de linha e indentação do SQL não mudam a resposta.
 */
const ehTravaDoMenu = (sql: string) =>
  /from phone_menus where id = \$1 and organization_id = \$2 and archived_at is null for no key update$/i.test(
    sql.replace(/\s+/g, " ").trim(),
  );

/** O Storage em memória: as prévias de A estão guardadas; nada de B. */
const armazem = {
  baixar: async (caminho: string) =>
    [caminhoDaFala(ORG_A, HASH_MENU), caminhoDaFala(ORG_A, HASH_INVALIDA)].includes(caminho) ? new Uint8Array(1600) : null,
};

const entrada = (e: Partial<EntradaDoMenu> = {}): EntradaDoMenu => ({
  nome: "Principal",
  aceita_ramal: false,
  opcoes: [
    { tecla: "1", time_id: TIME_A1 },
    { tecla: "2", time_id: TIME_A2 },
  ],
  time_padrao_id: TIME_A1,
  fala: { texto: TEXTO_MENU, hash: HASH_MENU },
  fala_invalida: null,
  ...e,
});
const pedido = (e: Partial<EntradaDoMenu> = {}, id: string | null = null, p: PedidoDeSalvarMenu["pool"] = pool): PedidoDeSalvarMenu => ({
  pool: p,
  armazem,
  organizationId: ORG_A,
  userId: null,
  id,
  entrada: entrada(e),
});
const criar = async (e: Partial<EntradaDoMenu> = {}) => {
  const r = await salvarMenuDaOrg(pedido(e));
  if (!r.ok) throw new Error(`criar o menu devia passar: ${JSON.stringify(r)}`);
  return r;
};
const falasDe = async (org: string, kind?: string) =>
  (
    await pool.query<{ id: string; kind: string }>(
      "select id, kind from phone_prompts where organization_id = $1 and ($2::text is null or kind = $2) order by created_at",
      [org, kind ?? null],
    )
  ).rows;
const contar = async (tabela: string, org: string) =>
  Number((await pool.query<{ n: string }>(`select count(*) as n from ${tabela} where organization_id = $1`, [org])).rows[0]!.n);

/**
 * O pool de verdade com o ponto de encontro logo DEPOIS da leitura da linha do menu
 * na transação. `tirarTrava` é a gravação sem o conserto: a mesma leitura, sem
 * `for no key update`. Mesma técnica de telefonia-fala-geral-concorrente.test.ts: sem o
 * encontro, a primeira transação podia terminar antes de a segunda começar, e o
 * teste passaria mesmo sem trava.
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
  const embrulhado: PedidoDeSalvarMenu["pool"] = {
    query: pool.query.bind(pool) as PedidoDeSalvarMenu["pool"]["query"],
    connect: async (): Promise<ConexaoDaTransacao> => {
      const c = await pool.connect();
      return {
        release: (erro?: Error) => c.release(erro),
        query: (async (texto: string, valores?: unknown[]) => {
          const comando = tirarTrava ? texto.replace(/\s+for no key update\s*$/i, "") : texto;
          const r = await c.query(comando, valores);
          if (ehTravaDoMenu(texto)) await encontro();
          return r;
        }) as ConexaoDaTransacao["query"],
      };
    },
  };
  return {
    pool: embrulhado,
    get chegadas() {
      return chegaram;
    },
    get simultaneas() {
      return maxDentro;
    },
  };
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'menus-no-banco-a', 'Menus A', 'Menus A'), ('${ORG_B}', 'menus-no-banco-b', 'Menus B', 'Menus B')
      on conflict (id) do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A1}', '${ORG_A}', 'Suporte', 'suporte-menus'), ('${TIME_A2}', '${ORG_A}', 'Financeiro', 'financeiro-menus'),
      ('${TIME_B1}', '${ORG_B}', 'Suporte B', 'suporte-menus')
      on conflict (id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values
      ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'Recepção', '+556130008801',
       'voip.menus-a.com.br', 5060, 'udp', 'u-menus-a', '\\x00'),
      ('${NUMERO_B}', '${ORG_B}', 'sip_trunk', '\\x00', 'STARTING', 'Recepção B', '+556130008802',
       'voip.menus-b.com.br', 5060, 'udp', 'u-menus-b', '\\x00')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`
    update public.channel_sessions set sip_menu_id = null, sip_team_id = null where id in ('${NUMERO_A}', '${NUMERO_B}');
    delete from public.voice_calls where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.phone_menus where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.phone_prompts where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.phone_settings where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.phone_settings (organization_id, voice_id, model_id) values
      ('${ORG_A}', '${VOZ}', '${MODELO}'), ('${ORG_B}', '${VOZ}', '${MODELO}');
  `);
});

afterAll(() => pool.end());

describe("salvarMenuDaOrg no Postgres real", () => {
  it("menu novo: falas, menu e opções numa transação; a leitura devolve nomes dos times, as falas e pronto", async () => {
    const r = await criar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    const [menu] = await menusDaOrg(pool, ORG_A);
    expect(menu).toMatchObject({
      id: r.id,
      nome: "Principal",
      time_padrao_id: TIME_A1,
      time_padrao_nome: "Suporte",
      opcoes: [
        { tecla: "1", time_id: TIME_A1, time_nome: "Suporte" },
        { tecla: "2", time_id: TIME_A2, time_nome: "Financeiro" },
      ],
      fala: { id: r.fala.fala.id, tipo: "menu", hash: HASH_MENU, status: "ready", duracao_ms: 200 },
      fala_invalida: { id: r.falaInvalida!.fala.id, tipo: "invalid", hash: HASH_INVALIDA },
      pronto: true,
      numeros: [],
      ultimos_7_dias: { total: 0 },
    });
    expect(menu!.fala!.atualizada_em).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // O menu que a TRANSAÇÃO devolve é o mesmo que a leitura da lista vê.
    const { ultimos_7_dias: _semana, ...lido } = menu!;
    expect(r.menu).toEqual(lido);
    expect(await situacaoDoMenuParaNumero(pool, ORG_A, r.id)).toBe("pronto");
    // B não enxerga o menu de A.
    expect(await menusDaOrg(pool, ORG_B)).toEqual([]);
    expect(await situacaoDoMenuParaNumero(pool, ORG_B, r.id)).toBe("inexistente");
  });

  it("tudo ou nada: o banco recusa o time de OUTRA organização (FK composta) no meio da transação — time_invalido, e a fala some junto", async () => {
    // A conferência de fora (`timesValidos`) é enganada de propósito, para a recusa vir do BANCO.
    const mentiroso: PedidoDeSalvarMenu["pool"] = {
      query: (async (texto: string, valores?: unknown[]) =>
        /from attendance_teams/.test(texto)
          ? { rows: [{ n: new Set(valores![1] as string[]).size }], rowCount: 1 }
          : pool.query(texto, valores)) as PedidoDeSalvarMenu["pool"]["query"],
      connect: () => pool.connect(),
    };
    for (const e of [{ opcoes: [{ tecla: "1", time_id: TIME_B1 }] }, { time_padrao_id: TIME_B1 }]) {
      const r = await salvarMenuDaOrg(pedido(e, null, mentiroso));
      expect(r, JSON.stringify(e)).toEqual({ ok: false, motivo: "time_invalido" });
    }
    expect(await contar("phone_prompts", ORG_A)).toBe(0);
    expect(await contar("phone_menus", ORG_A)).toBe(0);
    expect(await contar("phone_menu_options", ORG_A)).toBe(0);
  });

  it("a mesma tecla duas vezes, se escapasse do código, é recusada pela chave (menu_id, digit) do banco — tecla_repetida", async () => {
    const r = await salvarMenuDaOrg({
      ...pedido(),
      // `salvarMenuDaOrg` confere a tecla antes; o pedido cru prova que a chave do banco também recusa.
      entrada: { ...entrada(), opcoes: [{ tecla: "1", time_id: TIME_A1 }] },
    });
    expect(r.ok).toBe(true);
    const erro = await pool
      .query("insert into phone_menu_options (organization_id, menu_id, digit, team_id) values ($1, $2, '1', $3)", [
        ORG_A,
        r.ok ? r.id : null,
        TIME_A2,
      ])
      .then(() => null, (e: { code?: string; constraint?: string }) => [e.code, e.constraint]);
    expect(erro).toEqual(["23505", "phone_menu_options_pkey"]);
  });

  it("duas edições simultâneas dão ao menu a fala de tecla inválida: UMA linha, e o menu aponta para ela", async () => {
    const { id } = await criar();
    const e = poolComEncontro();
    const comInvalida = { fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } };

    const [a, b] = await Promise.all([
      salvarMenuDaOrg(pedido(comInvalida, id, e.pool)),
      salvarMenuDaOrg(pedido(comInvalida, id, e.pool)),
    ]);

    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    const invalidas = await falasDe(ORG_A, "invalid");
    expect(invalidas).toHaveLength(1);
    const { rows } = await pool.query<{ invalid_prompt_id: string }>("select invalid_prompt_id from phone_menus where id = $1", [id]);
    expect(rows[0]!.invalid_prompt_id).toBe(invalidas[0]!.id);
    // Uma escreveu; a outra, que esperou a trava, viu que nada mudou.
    expect([a.ok && a.falaInvalida?.mudou, b.ok && b.falaInvalida?.mudou].sort()).toEqual([false, true]);
    expect(e.chegadas).toBe(2);
    expect(e.simultaneas).toBe(1);
  });

  it("CONTROLE — sem a trava, o mesmo encontro deixa a linha órfã (o teste enxerga o defeito que diz prender)", async () => {
    const { id } = await criar();
    const e = poolComEncontro({ tirarTrava: true });
    const comInvalida = { fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } };

    await Promise.all([salvarMenuDaOrg(pedido(comInvalida, id, e.pool)), salvarMenuDaOrg(pedido(comInvalida, id, e.pool))]);

    expect(e.simultaneas).toBe(2);
    expect(await falasDe(ORG_A, "invalid")).toHaveLength(2);
  });

  it("a linha do menu travada por outra transação além de 4 s: gravacao_em_andamento, sem ficar presa nem gravar", async () => {
    const { id } = await criar();
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from phone_menus where id = $1 for no key update", [id]);

      const inicio = Date.now();
      const r = await salvarMenuDaOrg(pedido({ nome: "Outro nome", fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } }, id));
      const esperou = Date.now() - inicio;

      expect(r).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
      expect(esperou).toBeGreaterThanOrEqual(3_500);
      expect(esperou).toBeLessThan(8_000);
    } finally {
      await dono.query("rollback");
      dono.release();
    }
    expect(await falasDe(ORG_A, "invalid")).toHaveLength(0);
    expect((await menusDaOrg(pool, ORG_A))[0]!.nome).toBe("Principal");
    // A conexão voltou ao pool sã: a edição seguinte, sem ninguém na trava, passa.
    expect(await salvarMenuDaOrg(pedido({ nome: "Outro nome" }, id))).toMatchObject({ ok: true });
  });

  it("editar tirando a fala de opção inválida: a linha dela sai, e só ela", async () => {
    const r = await criar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    const editado = await salvarMenuDaOrg(pedido({ fala_invalida: null, opcoes: [{ tecla: "9", time_id: TIME_A2 }] }, r.id));
    expect(editado).toMatchObject({ ok: true, falaInvalidaDescartada: r.falaInvalida!.fala.id });
    expect((await falasDe(ORG_A)).map((f) => f.kind)).toEqual(["menu"]);
    const [menu] = await menusDaOrg(pool, ORG_A);
    expect(menu).toMatchObject({ fala_invalida: null, opcoes: [{ tecla: "9", time_id: TIME_A2 }] });
  });
});

describe("o 'últimos 7 dias' do menu — só ligações ENCERRADAS", () => {
  const ligacao = (org: string, numero: string, menu: string, status: string, outcome: string | null, digito: string | null, dias = 0) =>
    `insert into public.voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status,
        menu_id, menu_outcome, menu_digit, started_at)
     values ('${org}', '${numero}', 'sip_trunk', 'menus-' || gen_random_uuid(), 'inbound', '+5561999998888', '${status}',
             '${menu}', ${outcome ? `'${outcome}'` : "null"}, ${digito ? `'${digito}'` : "null"}, now() - interval '${dias} days');`;

  it("soma escolhas por tecla, sem escolha, tecla errada e quem desligou; ignora a ligação em curso e a antiga", async () => {
    const { id } = await criar();
    const { id: outro } = await criar({ nome: "Outro" });
    sql(
      [
        ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", "1"),
        ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", "1"),
        ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", "1"),
        ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", "2"),
        // `chosen` sem tecla: conta como escolha (total), mas em tecla nenhuma.
        ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", null),
        ligacao(ORG_A, NUMERO_A, id, "ended", "default_no_input", null),
        ligacao(ORG_A, NUMERO_A, id, "ended", "default_invalid", null),
        // Desligou dentro do menu: encerrada, sem desfecho.
        ligacao(ORG_A, NUMERO_A, id, "ended", null, null),
        ligacao(ORG_A, NUMERO_A, id, "ended", null, null),
        // Em curso: ainda pode escolher. NÃO conta — nem como "desligou".
        ligacao(ORG_A, NUMERO_A, id, "connected", null, null),
        ligacao(ORG_A, NUMERO_A, id, "ringing", null, null),
        ligacao(ORG_A, NUMERO_A, id, "starting", null, null),
        // Encerrada há 8 dias: fora da janela.
        ligacao(ORG_A, NUMERO_A, id, "ended", "default_no_input", null, 8),
        // A de outro menu da mesma organização não se mistura.
        ligacao(ORG_A, NUMERO_A, outro, "ended", "default_invalid", null),
      ].join("\n"),
    );

    const menus = await menusDaOrg(pool, ORG_A);
    const u = menus.find((m) => m.id === id)!.ultimos_7_dias;
    expect(u).toEqual({ total: 9, por_tecla: { "1": 3, "2": 1 }, sem_escolha: 1, tecla_errada: 1, desligou_no_menu: 2 });
    // 4 de 9 sem escolher (sem tecla, tecla errada, desligou): o menu confunde.
    expect(menuConfunde(u)).toBe(true);
    expect(menus.find((m) => m.id === outro)!.ultimos_7_dias).toMatchObject({ total: 1, tecla_errada: 1 });

    // CONTROLE — a mesma janela SEM o filtro de encerradas veria as 3 em curso como "desligou no menu".
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from voice_calls
        where organization_id = $1 and menu_id = $2 and menu_outcome is null and started_at >= now() - interval '7 days'`,
      [ORG_A, id],
    );
    expect(rows[0]!.n).toBe(5);
  });

  it("a organização é a da consulta: a ligação de B, no menu de B, não aparece para A", async () => {
    const { id } = await criar();
    sql(`
      insert into public.attendance_teams (id, organization_id, name, slug) values
        ('c0de0288-8888-4000-8000-0000000000b2', '${ORG_B}', 'Padrão B', 'padrao-menus-b') on conflict (id) do nothing;
      insert into public.phone_menus (id, organization_id, name, default_team_id) values
        ('c0de0288-8888-4000-8000-0000000000d2', '${ORG_B}', 'Menu B', 'c0de0288-8888-4000-8000-0000000000b2');
    `);
    sql(ligacao(ORG_B, NUMERO_B, "c0de0288-8888-4000-8000-0000000000d2", "ended", null, null));
    const { rows } = await pool.query(CONSULTA_DA_SEMANA, [ORG_A, [id, "c0de0288-8888-4000-8000-0000000000d2"]]);
    expect(rows).toEqual([]);
  });

  it("com o histórico de uma organização de verdade, a consulta usa o índice parcial idx_voice_calls_menu_recentes", async () => {
    const { id } = await criar();
    // A forma real: milhares de ligações da organização, quase todas sem menu (fase 1,
    // número que vai direto a um time) — e poucas passando por ESTE menu.
    sql(`
      insert into public.voice_calls
        (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, started_at)
      select '${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'massa-' || g, 'inbound', '+5561999997777', 'ended',
             now() - (g % 60) * interval '1 day'
        from generate_series(1, 5000) as g;
      ${Array.from({ length: 5 }, () => ligacao(ORG_A, NUMERO_A, id, "ended", "chosen", "1")).join("\n")}
      analyze public.voice_calls;
    `);
    const plano = (await pool.query<{ "QUERY PLAN": string }>(`explain ${CONSULTA_DA_SEMANA}`, [ORG_A, [id]])).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    expect(plano).toMatch(/idx_voice_calls_menu_recentes/);
    expect((await menusDaOrg(pool, ORG_A))[0]!.ultimos_7_dias.total).toBe(5);
  });
});

describe("arquivarMenu e o destino do número", () => {
  it("menu que atende um número não é arquivado; solto do número, é; arquivado some, não serve a número e não é editado", async () => {
    const { id } = await criar();
    sql(`update public.channel_sessions set sip_team_id = null, sip_menu_id = '${id}' where id = '${NUMERO_A}';`);
    expect((await menusDaOrg(pool, ORG_A))[0]!.numeros).toEqual(["Recepção · (61) 3000-8801"]);

    expect(await arquivarMenu(pool, ORG_A, id)).toEqual({
      ok: false,
      motivo: "menu_em_uso",
      numeros: [{ nome: "Recepção", numero: "+556130008801" }],
    });
    expect(await arquivarMenu(pool, ORG_B, id)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await menusDaOrg(pool, ORG_A)).toHaveLength(1);

    sql(`update public.channel_sessions set sip_menu_id = null where id = '${NUMERO_A}';`);
    expect(await arquivarMenu(pool, ORG_A, id)).toMatchObject({ ok: true });
    expect(await arquivarMenu(pool, ORG_A, id)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await menusDaOrg(pool, ORG_A)).toEqual([]);
    expect(await situacaoDoMenuParaNumero(pool, ORG_A, id)).toBe("inexistente");
    expect(await salvarMenuDaOrg(pedido({ nome: "Ressuscitado" }, id))).toEqual({ ok: false, motivo: "nao_encontrado" });
  });

  it("arquivar apaga as falas do menu na mesma transação: o menu fica (histórico das ligações), solto delas; as de outro menu ficam", async () => {
    const r = await criar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    const outro = await criar({ nome: "Outro" });
    const falasDoMenu = [r.fala.fala.id, r.falaInvalida!.fala.id];
    sql(`
      insert into public.voice_calls
        (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, menu_id, menu_outcome, menu_digit)
      values ('${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'historico-' || gen_random_uuid(), 'inbound', '+5561999995555', 'ended',
              '${r.id}', 'chosen', '1');
    `);

    const a = await arquivarMenu(pool, ORG_A, r.id);

    expect(a.ok && [...a.falasDescartadas].sort()).toEqual([...falasDoMenu].sort());
    const { rows: sobraram } = await pool.query("select id from phone_prompts where id = any($1::uuid[])", [falasDoMenu]);
    expect(sobraram).toEqual([]);
    const { rows: menu } = await pool.query<{ arquivado: boolean; prompt_id: string | null; invalid_prompt_id: string | null }>(
      "select archived_at is not null as arquivado, prompt_id, invalid_prompt_id from phone_menus where id = $1",
      [r.id],
    );
    expect(menu).toEqual([{ arquivado: true, prompt_id: null, invalid_prompt_id: null }]);
    const { rows: ligacoes } = await pool.query("select 1 from voice_calls where menu_id = $1", [r.id]);
    expect(ligacoes).toHaveLength(1);
    const { rows: doOutro } = await pool.query("select 1 from phone_prompts where id = $1", [outro.fala.fala.id]);
    expect(doOutro).toHaveLength(1);
  });

  it("menu com a fala que não está pronta: pendente para número", async () => {
    const { id, fala } = await criar();
    sql(`update public.phone_prompts set status = 'failed', error = 'erro_do_provedor' where id = '${fala.fala.id}';`);
    expect(await situacaoDoMenuParaNumero(pool, ORG_A, id)).toBe("pendente");
    expect((await menusDaOrg(pool, ORG_A))[0]!.pronto).toBe(false);
  });
});

/**
 * Apontar o número para o menu na forma que `lib/channels/telefonia/numeros.ts`
 * usa (contrato de `travarMenuAtivo`): transação com prazo, trava do menu ativo,
 * e a troca do destino num comando SEPARADO depois dela.
 */
async function apontarNumero(
  p: PoolDeTransacao,
  numeroId: string,
  menuId: string,
): Promise<"ok" | "menu_inativo" | "gravacao_em_andamento"> {
  const r = await emTransacao(p, "4s", async (c) => {
    if (!(await travarMenuAtivo(c, ORG_A, menuId))) return desfazer("menu_inativo" as const);
    await c.query("update channel_sessions set sip_team_id = null, sip_menu_id = $3 where id = $1 and organization_id = $2", [
      numeroId,
      ORG_A,
      menuId,
    ]);
    return confirmar("ok" as const);
  });
  return typeof r === "string" ? r : r.motivo;
}

/** O pool de verdade com um PORTÃO logo depois da trava do menu: a transação para ali até `abrir()`. */
function poolComPortao() {
  let abrir: () => void = () => undefined;
  const portao = new Promise<void>((r) => (abrir = r));
  let avisar: () => void = () => undefined;
  const travou = new Promise<void>((r) => (avisar = r));
  const embrulhado: PedidoDeSalvarMenu["pool"] = {
    query: pool.query.bind(pool) as PedidoDeSalvarMenu["pool"]["query"],
    connect: async (): Promise<ConexaoDaTransacao> => {
      const c = await pool.connect();
      return {
        release: (erro?: Error) => c.release(erro),
        query: (async (texto: string, valores?: unknown[]) => {
          const r = await c.query(texto, valores);
          if (ehTravaDoMenu(texto)) {
            avisar();
            await portao;
          }
          return r;
        }) as ConexaoDaTransacao["query"],
      };
    },
  };
  return { pool: embrulhado, travou, abrir };
}

/** Se a promessa já terminou — para provar que ela está PARADA na trava. */
function acompanhar<T>(p: Promise<T>) {
  let terminou = false;
  void p.then(
    () => (terminou = true),
    () => (terminou = true),
  );
  return () => terminou;
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Espera a transação chegar ao portão, com prazo: se o código sob teste deixar de
 * travar o menu, o portão nunca é alcançado — e o caso tem de ficar VERMELHO em
 * segundos, não pendurado até o timeout.
 */
const chegouAoPortao = (travou: Promise<void>) =>
  Promise.race([
    travou,
    esperar(5_000).then(() => {
      throw new Error("a transação não chegou à trava do menu em 5 s");
    }),
  ]);

const destinoDoNumero = async () =>
  (await pool.query<{ sip_menu_id: string | null }>("select sip_menu_id from channel_sessions where id = $1", [NUMERO_A]))
    .rows[0]!.sip_menu_id;
const arquivado = async (id: string) =>
  (await pool.query<{ a: boolean }>("select archived_at is not null as a from phone_menus where id = $1", [id])).rows[0]!.a;

describe("arquivar × apontar um número ao menu, ao mesmo tempo (Postgres real)", () => {
  it("arquivar trava primeiro: quem aponta espera e, quando o arquivamento confirma, recebe null — o número não toca o menu arquivado", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const arquivando = arquivarMenu(portao.pool, ORG_A, id);
    let apontando: Promise<string> = Promise.resolve("—");
    try {
      await chegouAoPortao(portao.travou);
      apontando = apontarNumero(pool, NUMERO_A, id);
      const apontou = acompanhar(apontando);
      await esperar(300);
      expect(apontou()).toBe(false); // parado na trava do menu
    } finally {
      // Abre sempre: uma asserção vermelha acima não pode deixar a transação presa no portão.
      portao.abrir();
      // E espera as duas terminarem ANTES de o caso acabar: o `beforeEach` seguinte usa
      // `sql()` síncrono, que prende o event loop — com uma transação ainda aberta
      // segurando a trava do menu, o arquivo inteiro pendura em vez de ficar vermelho.
      await Promise.allSettled([arquivando, apontando]);
    }
    expect(await arquivando).toMatchObject({ ok: true });
    expect(await apontando).toBe("menu_inativo");
    expect(await arquivado(id)).toBe(true);
    expect(await destinoDoNumero()).toBeNull();
  });

  it("apontar trava primeiro: o arquivamento espera e, no comando seguinte, vê o número — menu_em_uso, e o menu segue ativo", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const apontando = apontarNumero(portao.pool, NUMERO_A, id);
    let arquivando: ReturnType<typeof arquivarMenu> = Promise.resolve({ ok: false, motivo: "nao_encontrado" });
    try {
      await chegouAoPortao(portao.travou);
      arquivando = arquivarMenu(pool, ORG_A, id);
      const arquivou = acompanhar(arquivando);
      await esperar(300);
      expect(arquivou()).toBe(false); // parado na trava do menu
    } finally {
      portao.abrir();
      await Promise.allSettled([apontando, arquivando]);
    }
    expect(await apontando).toBe("ok");
    expect(await arquivando).toEqual({
      ok: false,
      motivo: "menu_em_uso",
      numeros: [{ nome: "Recepção", numero: "+556130008801" }],
    });
    expect(await arquivado(id)).toBe(false);
    expect(await destinoDoNumero()).toBe(id);
  });

  it("os dois juntos, com o encontro forçado: um só vence, e nunca sobra número tocando menu arquivado", async () => {
    const { id } = await criar();
    const e = poolComEncontro();

    const [a, n] = await Promise.all([arquivarMenu(e.pool, ORG_A, id), apontarNumero(e.pool, NUMERO_A, id)]);

    const fim = { arquivado: await arquivado(id), destino: await destinoDoNumero() };
    expect(fim.arquivado && fim.destino === id, JSON.stringify({ a, n, fim })).toBe(false);
    const venceuArquivar = a.ok && n === "menu_inativo" && fim.arquivado && fim.destino === null;
    const venceuApontar = !a.ok && a.motivo === "menu_em_uso" && n === "ok" && !fim.arquivado && fim.destino === id;
    expect(venceuArquivar !== venceuApontar, JSON.stringify({ a, n, fim })).toBe(true);
    // A trava serializou: os dois passaram por ela, mas nunca juntos.
    expect(e.chegadas).toBe(2);
    expect(e.simultaneas).toBe(1);
  });

  it("CONTROLE — arquivar num comando só (not exists) e apontar só com a FK: o número termina tocando o menu ARQUIVADO", async () => {
    const { id } = await criar();
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      // Aponta o número sem travar o menu: a FK só pega `key share` na linha dele.
      await dono.query("update channel_sessions set sip_team_id = null, sip_menu_id = $2 where id = $1", [NUMERO_A, id]);
      // O arquivamento antigo não espera (key share × no key update não conflitam) e o
      // `not exists` não vê o número ainda não confirmado.
      const antigo = pool.query(
        `update phone_menus m set archived_at = now()
          where m.id = $1 and m.organization_id = $2 and m.archived_at is null
            and not exists (select 1 from channel_sessions c
                             where c.organization_id = m.organization_id and c.sip_menu_id = m.id and c.archived_at is null)
          returning m.id`,
        [id, ORG_A],
      );
      const r = await Promise.race([antigo, esperar(2_000).then(() => "esperou" as const)]);
      expect(r === "esperou" ? r : r.rowCount).toBe(1);
      await dono.query("commit");
    } finally {
      // Depois do commit é um no-op; se uma asserção falhou antes, a transação não volta aberta ao pool.
      await dono.query("rollback").catch(() => undefined);
      dono.release();
    }
    expect(await arquivado(id)).toBe(true);
    expect(await destinoDoNumero()).toBe(id);
  });
});

describe("a trava do menu não faz a LIGAÇÃO esperar", () => {
  /** A ligação entrando no menu: o INSERT em voice_calls com `menu_id`, com 1 s de prazo de trava. */
  const inserirLigacao = async (menuId: string): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local lock_timeout = '1s'");
      await c.query(
        `insert into voice_calls (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, menu_id)
         values ($1, $2, 'sip_trunk', 'trava-' || gen_random_uuid(), 'inbound', '+5561999996666', 'ringing', $3)`,
        [ORG_A, NUMERO_A, menuId],
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

  it("com o menu travado por um salvar (for no key update), o INSERT da ligação com aquele menu_id entra na hora", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const salvando = salvarMenuDaOrg(pedido({ nome: "Editado" }, id, portao.pool));
    try {
      await chegouAoPortao(portao.travou);
      const inicio = Date.now();
      expect(await inserirLigacao(id)).toBe("entrou");
      expect(Date.now() - inicio).toBeLessThan(900);
    } finally {
      portao.abrir();
      await Promise.allSettled([salvando]);
    }
    expect(await salvando).toMatchObject({ ok: true });
  });

  it("com o número E o menu travados por um atualizarNumero de verdade (portão), o INSERT da ligação no número entra na hora", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const apontando = atualizarNumero(portao.pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }));
    try {
      await chegouAoPortao(portao.travou);
      const inicio = Date.now();
      expect(await inserirLigacao(id)).toBe("entrou");
      expect(Date.now() - inicio).toBeLessThan(900);
    } finally {
      portao.abrir();
      // Mesmo com a asserção vermelha, a transação termina ANTES do caso acabar: o
      // `beforeEach` seguinte usa `sql()` síncrono, que prende o event loop — com a
      // transação aberta segurando a trava, o arquivo inteiro pendura.
      await Promise.allSettled([apontando]);
    }
    expect(await apontando).toMatchObject({ ok: true });
  });

  it("CONTROLE — com a linha do NÚMERO em for update, o mesmo INSERT espera e cai no lock_timeout (55P03)", async () => {
    const { id } = await criar();
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from channel_sessions where id = $1 for update", [NUMERO_A]);
      expect(await inserirLigacao(id)).toBe("55P03");
    } finally {
      await dono.query("rollback").catch(() => undefined);
      dono.release();
    }
  });

  it("CONTROLE — com o menu em for update (a trava antiga), o mesmo INSERT espera e cai no lock_timeout (55P03)", async () => {
    const { id } = await criar();
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select 1 from phone_menus where id = $1 for update", [id]);
      expect(await inserirLigacao(id)).toBe("55P03");
    } finally {
      await dono.query("rollback").catch(() => undefined);
      dono.release();
    }
  });
});

/** O formulário do número A como a tela o manda: a MESMA conta (sem senha), mais o destino. */
const doNumeroA = (e: Partial<EntradaDoNumero> = {}): EntradaDoNumero =>
  numeroSchema.parse({
    nome: "Recepção",
    numero: "(61) 3000-8801",
    servidor: "voip.menus-a.com.br",
    porta: 5060,
    transporte: "udp",
    usuario: "u-menus-a",
    time_id: null,
    ...e,
  });
const doNumeroB = (e: Partial<EntradaDoNumero> = {}): EntradaDoNumero =>
  numeroSchema.parse({
    nome: "Recepção B",
    numero: "(61) 3000-8802",
    servidor: "voip.menus-b.com.br",
    porta: 5060,
    transporte: "udp",
    usuario: "u-menus-b",
    time_id: null,
    ...e,
  });
const timeDoNumero = async () =>
  (await pool.query<{ sip_team_id: string | null }>("select sip_team_id from channel_sessions where id = $1", [NUMERO_A]))
    .rows[0]!.sip_team_id;

describe("o atualizarNumero de verdade e o destino do número (Postgres real)", () => {
  it("aponta para o menu pronto; a aba antiga mantém; escolher um time tira o menu — com o antes e o depois que a transação leu", async () => {
    const { id } = await criar();

    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }))).toEqual({
      ok: true,
      destino: { de: { time_id: null, menu_id: null }, para: { time_id: null, menu_id: id } },
    });
    expect(await destinoDoNumero()).toBe(id);

    // Aba aberta antes da atualização: sem `menu_id` no corpo, o menu guardado fica.
    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ nome: "Recepção" }))).toEqual({
      ok: true,
      destino: { de: { time_id: null, menu_id: id }, para: { time_id: null, menu_id: id } },
    });

    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ time_id: TIME_A1 }))).toEqual({
      ok: true,
      destino: { de: { time_id: null, menu_id: id }, para: { time_id: TIME_A1, menu_id: null } },
    });
    expect([await timeDoNumero(), await destinoDoNumero()]).toEqual([TIME_A1, null]);
  });

  it("recusa, sem escrever: time E menu, menu de OUTRA organização, inexistente, arquivado e com a fala pendente", async () => {
    const { id, fala } = await criar();

    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ time_id: TIME_A1, menu_id: id }))).toEqual({
      ok: false,
      motivo: "destino_duplo",
    });
    // B tenta apontar o número DELE para o menu de A: a trava filtra pela organização da sessão.
    expect(await atualizarNumero(pool, ORG_B, NUMERO_B, doNumeroB({ menu_id: id }))).toEqual({
      ok: false,
      motivo: "menu_invalido",
    });
    expect(
      await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: "c0de0288-8888-4000-8000-0000000000ff" })),
    ).toEqual({ ok: false, motivo: "menu_invalido" });

    sql(`update public.phone_prompts set status = 'failed', error = 'erro_do_provedor' where id = '${fala.fala.id}';`);
    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }))).toEqual({
      ok: false,
      motivo: "menu_com_fala_pendente",
    });
    sql(`update public.phone_prompts set status = 'ready', error = null where id = '${fala.fala.id}';`);

    expect(await arquivarMenu(pool, ORG_A, id)).toMatchObject({ ok: true });
    expect(await atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }))).toEqual({
      ok: false,
      motivo: "menu_invalido",
    });

    expect(await destinoDoNumero()).toBeNull();
    const { rows: b } = await pool.query<{ sip_menu_id: string | null }>("select sip_menu_id from channel_sessions where id = $1", [
      NUMERO_B,
    ]);
    expect(b[0]!.sip_menu_id).toBeNull();
  });

  it("arquivar trava primeiro: o atualizarNumero espera e, quando o arquivamento confirma, recebe menu_invalido — o número não toca o menu arquivado", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const arquivando = arquivarMenu(portao.pool, ORG_A, id);
    let apontando: ReturnType<typeof atualizarNumero> = Promise.resolve({ ok: false, motivo: "nao_encontrado" });
    try {
      await chegouAoPortao(portao.travou);
      apontando = atualizarNumero(pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }));
      const apontou = acompanhar(apontando);
      await esperar(300);
      expect(apontou()).toBe(false); // parado na trava do menu
    } finally {
      portao.abrir();
      await Promise.allSettled([arquivando, apontando]);
    }
    expect(await arquivando).toMatchObject({ ok: true });
    expect(await apontando).toEqual({ ok: false, motivo: "menu_invalido" });
    expect(await arquivado(id)).toBe(true);
    expect(await destinoDoNumero()).toBeNull();
  });

  it("o atualizarNumero trava primeiro: o arquivamento espera e, no comando seguinte, vê o número — menu_em_uso, e o menu segue ativo", async () => {
    const { id } = await criar();
    const portao = poolComPortao();
    const apontando = atualizarNumero(portao.pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id }));
    let arquivando: ReturnType<typeof arquivarMenu> = Promise.resolve({ ok: false, motivo: "nao_encontrado" });
    try {
      await chegouAoPortao(portao.travou);
      arquivando = arquivarMenu(pool, ORG_A, id);
      const arquivou = acompanhar(arquivando);
      await esperar(300);
      expect(arquivou()).toBe(false); // parado na trava do menu
    } finally {
      portao.abrir();
      await Promise.allSettled([apontando, arquivando]);
    }
    expect(await apontando).toMatchObject({ ok: true });
    expect(await arquivando).toEqual({
      ok: false,
      motivo: "menu_em_uso",
      numeros: [{ nome: "Recepção", numero: "+556130008801" }],
    });
    expect(await arquivado(id)).toBe(false);
    expect(await destinoDoNumero()).toBe(id);
  });

  it("os dois juntos, com o encontro forçado: um só vence, e nunca sobra número tocando menu arquivado", async () => {
    const { id } = await criar();
    const e = poolComEncontro();

    const [a, n] = await Promise.all([
      arquivarMenu(e.pool, ORG_A, id),
      atualizarNumero(e.pool, ORG_A, NUMERO_A, doNumeroA({ menu_id: id })),
    ]);

    const fim = { arquivado: await arquivado(id), destino: await destinoDoNumero() };
    expect(fim.arquivado && fim.destino === id, JSON.stringify({ a, n, fim })).toBe(false);
    const venceuArquivar = a.ok && !n.ok && n.motivo === "menu_invalido" && fim.arquivado && fim.destino === null;
    const venceuApontar = !a.ok && a.motivo === "menu_em_uso" && n.ok && !fim.arquivado && fim.destino === id;
    expect(venceuArquivar !== venceuApontar, JSON.stringify({ a, n, fim })).toBe(true);
    expect(e.chegadas).toBe(2);
    expect(e.simultaneas).toBe(1);
  });
});

describe("o criarNumero de verdade e o número repetido (Postgres real)", () => {
  const contarNumeros = async (telefone: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          "select count(*) as n from channel_sessions where organization_id = $1 and phone_number = $2",
          [ORG_A, telefone],
        )
      ).rows[0]!.n,
    );
  /** Um número NOVO para A: outra conta SIP, com senha (a cifra precisa da chave da instalação). */
  const novoNumeroA = (e: Partial<EntradaDoNumero> = {}) =>
    doNumeroA({ usuario: "u-menus-a-novo", servidor: "voip.menus-a-novo.com.br", senha: "segredo-de-teste", ...e });

  beforeAll(() => {
    sql(`insert into private.app_secrets (name, value)
         values ('nuvemshop_oauth_key', 'chave-sintetica-do-invariante-com-32-mais-chars')
         on conflict (name) do nothing;`);
  });

  it("a unicidade de hoje é o índice PARCIAL da telefonia (0292, não deferrable): o repetido é recusado no INSERT — numero_ja_existe, e nada gravado", async () => {
    // Mede a régua, em vez de supor: a constraint DEFERRABLE do snapshot virou índice
    // na 0107, e a 0292 deu ao telefone a trava dele (o número é único por MEIO).
    const { rows: regua } = await pool.query<{ constraint: boolean; indice: string | null }>(
      `select exists (select 1 from pg_constraint where conname like 'channel_sessions%phone_per_org_unique') as constraint,
              (select pg_get_indexdef(i.indexrelid) from pg_index i
                 join pg_class c on c.oid = i.indexrelid
                where c.relname = 'channel_sessions_sip_phone_per_org_unique') as indice`,
    );
    expect(regua[0]!.constraint).toBe(false);
    expect(regua[0]!.indice).toMatch(
      /UNIQUE INDEX .*\(organization_id, phone_number\) WHERE \(\(archived_at IS NULL\) AND \(provider = 'sip_trunk'::text\)\)/,
    );

    expect(await criarNumero(pool, ORG_A, novoNumeroA())).toEqual({ ok: false, motivo: "numero_ja_existe" });
    expect(await contarNumeros("+556130008801")).toBe(1);
  });

  it("o número que a organização já usa no WhatsApp oficial entra como telefone — não é `numero_ja_existe`", async () => {
    // O relato de 2026-10-02: o fixo da empresa atende pelo WhatsApp oficial e é a
    // linha de voz na operadora. São dois MEIOS do mesmo número, e não repetição.
    sql(`insert into public.channel_sessions
           (organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number, meta_phone_number_id)
         values ('${ORG_A}', 'meta_cloud', '\\x00', 'WORKING', 'Oficial', '+556140637232', 'menus-no-banco-oficial');`);
    try {
      const r = await criarNumero(pool, ORG_A, novoNumeroA({ nome: "Fixo", numero: "(61) 4063-7232" }));
      expect(r).toMatchObject({ ok: true });
      expect(await contarNumeros("+556140637232")).toBe(2);
      expect((await numerosDaOrg(pool, ORG_A)).filter((n) => n.numero === "+556140637232")).toHaveLength(1);
    } finally {
      await pool.query("delete from channel_sessions where phone_number = $1 and organization_id = $2", ["+556140637232", ORG_A]);
    }
  });

  it("recusa que só aparece no COMMIT (unicidade DEFERRABLE) também volta traduzida — não um 500", async () => {
    // Sonda: uma unicidade deferível que o número novo viola. O INSERT passa; o
    // COMMIT de `emTransacao` é que estoura — e ele está dentro do mesmo `try`.
    sql(`alter table public.channel_sessions add constraint sonda_unico_deferivel_nome
           unique (organization_id, display_name) deferrable initially deferred;`);
    try {
      const r = await criarNumero(pool, ORG_A, novoNumeroA({ numero: "(61) 3000-8899" }));
      expect(r).toEqual({ ok: false, motivo: "numero_ja_existe" });
      expect(await contarNumeros("+556130008899")).toBe(0);
    } finally {
      sql("alter table public.channel_sessions drop constraint if exists sonda_unico_deferivel_nome;");
    }
  });

  it("controle: número novo, conta nova — cria, com a senha cifrada no banco", async () => {
    const r = await criarNumero(pool, ORG_A, novoNumeroA({ nome: "Novo", numero: "(61) 3000-8898" }));
    expect(r).toMatchObject({ ok: true });
    const { rows } = await pool.query<{ cifrada: boolean }>(
      "select sip_password_encrypted is not null and sip_password_encrypted <> '\\x00'::bytea as cifrada from channel_sessions where phone_number = $1",
      ["+556130008898"],
    );
    expect(rows).toEqual([{ cifrada: true }]);
    await pool.query("delete from channel_sessions where phone_number = $1 and organization_id = $2", ["+556130008898", ORG_A]);
  });
});

describe("a leitura dos números diz quando o destino foi arquivado (Postgres real)", () => {
  const TIME_A3 = "c0de0288-8888-4000-8000-0000000000a3";
  const doA = async () => (await numerosDaOrg(pool, ORG_A)).find((n) => n.id === NUMERO_A)!;

  beforeAll(() => {
    sql(`insert into public.attendance_teams (id, organization_id, name, slug, archived_at)
         values ('${TIME_A3}', '${ORG_A}', 'Cobrança antiga', 'cobranca-antiga-menus', now())
         on conflict (id) do nothing;`);
  });

  it("menu ativo e time ativo: nada arquivado", async () => {
    const { id } = await criar();
    sql(`update public.channel_sessions set sip_menu_id = '${id}' where id = '${NUMERO_A}';`);
    expect(await doA()).toMatchObject({ menu_id: id, menu_nome: "Principal", menu_arquivado: false, time_arquivado: false });

    sql(`update public.channel_sessions set sip_menu_id = null, sip_team_id = '${TIME_A1}' where id = '${NUMERO_A}';`);
    expect(await doA()).toMatchObject({ time_id: TIME_A1, time_nome: "Suporte", time_arquivado: false, menu_arquivado: false });
  });

  it("o menu arquivado por fora do produto: menu_arquivado, com o nome", async () => {
    const { id } = await criar();
    sql(`update public.channel_sessions set sip_menu_id = '${id}' where id = '${NUMERO_A}';
         update public.phone_menus set archived_at = now() where id = '${id}';`);
    expect(await doA()).toMatchObject({ menu_id: id, menu_nome: "Principal", menu_arquivado: true, time_arquivado: false });
  });

  it("o time arquivado com o número apontando para ele: time_arquivado, com o nome", async () => {
    sql(`update public.channel_sessions set sip_team_id = '${TIME_A3}' where id = '${NUMERO_A}';`);
    expect(await doA()).toMatchObject({
      time_id: TIME_A3,
      time_nome: "Cobrança antiga",
      time_arquivado: true,
      menu_id: null,
      menu_arquivado: false,
    });
  });

  it("sem destino: nenhum dos dois arquivado (não nulo)", async () => {
    expect(await doA()).toMatchObject({ time_id: null, menu_id: null, time_arquivado: false, menu_arquivado: false });
  });
});
