/**
 * O CADASTRO DO NÚMERO: a régua do servidor e a senha que não muda de conta.
 *
 * Dois defeitos da revisão de segurança de 2026-09-28, medidos aqui pelo
 * comportamento — o que a função devolve e o que chega ao banco —, não pela
 * presença de um símbolo:
 *
 *  1. O `numeroSchema` aceitava servidor interno (`localhost`, `redis`,
 *     `10.x`, `169.254.169.254`). Agora usa a régua de `conta-sip.ts`, a mesma
 *     do worker.
 *  2. O PATCH trocava o servidor (ou usuário, porta, transporte) mantendo a
 *     senha guardada: quem edita nunca viu a senha, e editar virava o jeito de
 *     mandá-la para outro host. Sem `senha` no corpo, a conta tem de ser a
 *     mesma — e a recusa acontece SEM escrita nenhuma.
 *
 * E, da fase 2, o DESTINO das ligações: um time OU um menu de voz. Apontar para
 * um menu trava a linha dele (`travarMenuAtivo`) numa transação com prazo, ANTES
 * da escrita — o contrato que impede o número de terminar tocando um menu
 * arquivado. O Postgres de verdade prova a corrida em
 * tests/invariants/telefonia-menus-no-banco.test.ts; aqui, a ordem e as recusas.
 */
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import {
  MENSAGEM_DA_FALHA,
  atualizarNumero,
  criarNumero,
  destinoMudou,
  numeroSchema,
  statusDaFalhaDoCadastro,
  type EntradaDoNumero,
} from "./numeros";

const ORG = "00000000-0000-4000-8000-00000000000a";
const NUMERO = "11111111-1111-4111-8111-111111111111";

const base = {
  nome: "Totus 3025",
  numero: "(61) 3686-1503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  time_id: null,
};

describe("numeroSchema — o servidor da tela", () => {
  it.each(["voip.totussistema.com.br", "sip:VOIP.totussistema.com.br:5060", "45.5.156.58"])(
    "aceita %s",
    (servidor) => {
      expect(numeroSchema.safeParse({ ...base, servidor }).success).toBe(true);
    },
  );

  it.each(["localhost", "127.0.0.1", "asterisk", "redis", "10.0.0.5", "172.18.0.3", "192.168.0.10", "169.254.169.254", "0.0.0.0"])(
    "recusa %s, com a explicação no campo",
    (servidor) => {
      const r = numeroSchema.safeParse({ ...base, servidor });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.flatten().fieldErrors.servidor?.[0]).toMatch(/endereço público da operadora/);
      }
    },
  );
});

interface Consulta {
  sql: string;
  params: unknown[];
  /** `pool` = consulta solta; `transacao` = na conexão da transação (`connect()`). */
  onde: "pool" | "transacao";
}

interface Guardada {
  servidor: string;
  porta: number;
  transporte: string;
  usuario: string;
  time_id?: string | null;
  menu_id?: string | null;
}

/** A conta guardada no banco, como `atualizarNumero` a lê. */
const GUARDADA: Guardada = { servidor: "voip.totussistema.com.br", porta: 5060, transporte: "udp", usuario: "6136861503" };

const MENU = "33333333-3333-4333-8333-333333333333";
const TIME = "44444444-4444-4444-8444-444444444444";

type SituacaoDoMenu = "pronto" | "pendente" | "inexistente";

interface OpcoesDoBanco {
  /** O menu que o número quer tocar: `inexistente` = de outra organização, arquivado ou que não existe. */
  menu?: SituacaoDoMenu;
  /** O que a trava do menu lança (ex.: 55P03, o prazo venceu). */
  erroNaTrava?: object;
  /** O que o INSERT/UPDATE do número lança (ex.: a FK composta do menu). */
  erroNaEscrita?: object;
  /** O destino que o UPDATE devolve no `returning`. Padrão: o time do corpo, sem menu. */
  depois?: { time_id: string | null; menu_id: string | null };
}

const vazio = { rows: [], rowCount: 0 };

/**
 * O banco em memória, que só reconhece o FORMATO das consultas. É também o pool
 * da transação: `connect()` devolve uma conexão que responde pelo mesmo roteiro e
 * marca `onde` — o teste sabe o que correu DENTRO da transação, e em que ordem.
 */
function bancoFalso(guardada: Guardada | null = GUARDADA, opcoes: OpcoesDoBanco = {}) {
  const consultas: Consulta[] = [];
  let liberadas = 0;
  const responder = async (onde: Consulta["onde"], sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params, onde });
    if (/^\s*(begin|commit|rollback)\s*$/i.test(sql) || /^\s*set local lock_timeout/i.test(sql)) return vazio;
    if (/from phone_menus/.test(sql) && /for no key update/.test(sql)) {
      if (opcoes.erroNaTrava) throw opcoes.erroNaTrava;
      return opcoes.menu && opcoes.menu !== "inexistente"
        ? { rows: [{ id: MENU, prompt_id: "p1", invalid_prompt_id: null }], rowCount: 1 }
        : vazio;
    }
    if (/from phone_menus/.test(sql)) {
      return opcoes.menu && opcoes.menu !== "inexistente" ? { rows: [{ pronto: opcoes.menu === "pronto" }], rowCount: 1 } : vazio;
    }
    if (/from attendance_teams/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (/^\s*select/i.test(sql) && /from channel_sessions/.test(sql)) {
      return { rows: guardada ? [guardada] : [], rowCount: guardada ? 1 : 0 };
    }
    if (/^\s*(update|insert into) channel_sessions/i.test(sql)) {
      if (opcoes.erroNaEscrita) throw opcoes.erroNaEscrita;
      if (/^\s*insert/i.test(sql)) return { rows: [{ id: NUMERO }], rowCount: 1 };
      return { rows: [opcoes.depois ?? { time_id: params[9] ?? null, menu_id: null }], rowCount: 1 };
    }
    throw new Error(`consulta inesperada: ${sql}`);
  };
  const comoQuery = (onde: Consulta["onde"]) =>
    ((sql: string, params?: unknown[]) => responder(onde, sql, params)) as unknown as Queryable["query"];
  const db = {
    query: comoQuery("pool"),
    connect: async () => ({ query: comoQuery("transacao"), release: () => void liberadas++ }),
  };
  const updates = () => consultas.filter((c) => /^\s*update channel_sessions/i.test(c.sql));
  const inserts = () => consultas.filter((c) => /^\s*insert into channel_sessions/i.test(c.sql));
  return { db, consultas, updates, inserts, liberadas: () => liberadas };
}

/**
 * As consultas em rótulos legíveis, na ordem — o roteiro da gravação. Consulta
 * solta leva " (pool)": o que importa é o que corre DENTRO da transação.
 */
function roteiro(consultas: readonly Consulta[]): string[] {
  return consultas.map((c) => {
    const s = c.sql.replace(/\s+/g, " ").trim();
    let rotulo = s;
    if (/^(begin|commit|rollback)$/i.test(s)) rotulo = s.toLowerCase();
    else if (/^set local lock_timeout/i.test(s)) rotulo = s;
    else if (/from phone_menus .*for no key update$/i.test(s)) rotulo = "trava do menu";
    else if (/from phone_menus/i.test(s)) rotulo = "situação do menu";
    else if (/from attendance_teams/i.test(s)) rotulo = "time";
    else if (/^select .*from channel_sessions .*for no key update$/i.test(s)) rotulo = "trava do número";
    else if (/^select .*from channel_sessions/i.test(s)) rotulo = "leitura do número";
    else if (/^update channel_sessions/i.test(s)) rotulo = "update";
    else if (/^insert into channel_sessions/i.test(s)) rotulo = "insert";
    return c.onde === "pool" ? `${rotulo} (pool)` : rotulo;
  });
}

const entrada = (over: Partial<EntradaDoNumero> = {}): EntradaDoNumero =>
  numeroSchema.parse({ ...base, ...over });

/** Posições dos parâmetros do UPDATE de `atualizarNumero` ($11, $12, $13). */
const SENHA = 10;
const MUDA_PREFIXO = 11;
const PREFIXO = 12;

describe("atualizarNumero — a senha é da conta", () => {
  it.each([
    ["servidor", { servidor: "sip.outro-lugar.example.com" }],
    ["usuário", { usuario: "outro-usuario" }],
    ["porta", { porta: 5080 }],
    ["transporte", { transporte: "tcp" as const }],
  ])("trocar o %s sem senha é recusado, e nada é gravado", async (_campo, mudanca) => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada(mudanca));

    expect(r).toEqual({ ok: false, motivo: "senha_obrigatoria_na_troca" });
    expect(updates()).toHaveLength(0);
    expect(MENSAGEM_DA_FALHA.senha_obrigatoria_na_troca).toMatch(/digite a senha da conta SIP de novo/);
  });

  it("trocar o servidor COM a senha nova grava, e a senha vai junto", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "sip.outro-lugar.example.com", senha: "nova" }));

    expect(r).toMatchObject({ ok: true });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.params).toContain("nova");
  });

  it("mudar só o nome e o time, sem senha, mantém a guardada e grava", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Novo nome" }));

    expect(r).toMatchObject({ ok: true });
    expect(updates()).toHaveLength(1);
    // A senha vai como NULL: o `case when` do UPDATE mantém a cifrada.
    expect(updates()[0]!.params[SENHA]).toBeNull();
  });

  it("servidor guardado com outra caixa (gravado pela REST) não conta como troca", async () => {
    const { db, updates } = bancoFalso({ ...GUARDADA, servidor: "voip.totussistema.com.br" });

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "VOIP.TotusSistema.com.br" }));

    expect(r).toMatchObject({ ok: true });
    expect(updates()).toHaveLength(1);
  });

  it("o UPDATE repete a regra dentro do comando — edição simultânea não troca a conta sem senha", async () => {
    const { db, updates } = bancoFalso();

    await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Novo nome" }));

    expect(updates()[0]!.sql).toMatch(
      /\$11::text is not null\s+or \(lower\(sip_server\) = \$6 and coalesce\(sip_port, 5060\) = \$7\s+and coalesce\(sip_transport, 'udp'\) = \$8 and sip_username = \$9\)/,
    );
  });

  it("número de outra organização (ou arquivado) é 'não encontrado', sem escrita", async () => {
    const { db, updates } = bancoFalso(null);

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "sip.outro-lugar.example.com" }));

    expect(r).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(updates()).toHaveLength(0);
  });
});

describe("prefixo de discagem — por número, opcional, e não é conta", () => {
  it.each([
    ["0", "0"],
    ["015", "015"],
    [" 0 ", "0"],
    ["", null],
    [null, null],
  ] as const)("o schema aceita %j e guarda %j", (prefixo, guardado) => {
    const r = numeroSchema.safeParse({ ...base, prefixo });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.prefixo).toBe(guardado);
  });

  it("ausente é 'manter o guardado', não 'apagar'", () => {
    const r = numeroSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.prefixo).toBeUndefined();
  });

  it.each(["01234", "0a", "0@10.0.0.5", "0,1", "+55"])("o schema recusa %j, com a explicação no campo", (prefixo) => {
    const r = numeroSchema.safeParse({ ...base, prefixo });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.flatten().fieldErrors.prefixo?.[0]).toMatch(/1 a 4 dígitos/);
  });

  it("mudar SÓ o prefixo, sem senha, grava — e a senha guardada fica", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ prefixo: "0" }));

    expect(r).toMatchObject({ ok: true });
    expect(updates()).toHaveLength(1);
    const p = updates()[0]!.params;
    expect([p[MUDA_PREFIXO], p[PREFIXO], p[SENHA]]).toEqual([true, "0", null]);
    expect(updates()[0]!.sql).toMatch(/sip_dial_prefix = case when \$12::boolean then \$13::text else sip_dial_prefix end/);
  });

  it("apagar o prefixo (campo vazio) grava null", async () => {
    const { db, updates } = bancoFalso();

    await atualizarNumero(db, ORG, NUMERO, entrada({ prefixo: "" }));

    const p = updates()[0]!.params;
    expect([p[MUDA_PREFIXO], p[PREFIXO]]).toEqual([true, null]);
  });

  it("formulário sem o campo (aba antiga) mantém o prefixo guardado", async () => {
    const { db, updates } = bancoFalso();

    await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Outro nome" }));

    expect(updates()[0]!.params[MUDA_PREFIXO]).toBe(false);
  });

  it("o prefixo não abre exceção na regra da senha: trocar o servidor sem senha segue recusado", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ prefixo: "0", servidor: "sip.outro-lugar.example.com" }));

    expect(r).toEqual({ ok: false, motivo: "senha_obrigatoria_na_troca" });
    expect(updates()).toHaveLength(0);
  });
});

describe("destino do número: time OU menu (fase 2)", () => {
  const PRAZO = "set local lock_timeout = '4s'";

  it("o schema aceita menu_id (uuid ou null) e, ausente, deixa undefined — manter o guardado", () => {
    expect(numeroSchema.parse({ ...base, menu_id: MENU }).menu_id).toBe(MENU);
    expect(numeroSchema.parse({ ...base, menu_id: null }).menu_id).toBeNull();
    expect(numeroSchema.parse(base).menu_id).toBeUndefined();
    expect(numeroSchema.safeParse({ ...base, menu_id: "menu-principal" }).success).toBe(false);
  });

  it("time E menu ao mesmo tempo é recusado antes de qualquer consulta", async () => {
    const { db, consultas } = bancoFalso(GUARDADA, { menu: "pronto" });
    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ time_id: TIME, menu_id: MENU }));
    expect(r).toEqual({ ok: false, motivo: "destino_duplo" });
    expect(consultas).toEqual([]);
  });

  it("menu pronto: a trava do menu vem ANTES do UPDATE, na mesma transação com prazo", async () => {
    const { db, consultas, updates, liberadas } = bancoFalso(GUARDADA, { menu: "pronto", depois: { time_id: null, menu_id: MENU } });

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }));

    expect(r).toEqual({ ok: true, destino: { de: { time_id: null, menu_id: null }, para: { time_id: null, menu_id: MENU } } });
    expect(roteiro(consultas)).toEqual(["begin", PRAZO, "trava do número", "trava do menu", "situação do menu", "update", "commit"]);
    const trava = consultas.find((c) => roteiro([c])[0] === "trava do menu")!;
    // A organização da trava é a da sessão (o parâmetro da função), nunca do corpo.
    expect(trava.params).toEqual([MENU, ORG]);
    // O UPDATE grava o menu ($15) e sabe que ele veio ($14).
    expect(updates()[0]!.params[13]).toBe(true);
    expect(updates()[0]!.params[14]).toBe(MENU);
    expect(liberadas()).toBe(1);
  });

  it("menu arquivado, de outra organização ou inexistente: a trava devolve null — menu_invalido, desfeito, sem escrita", async () => {
    const { db, consultas, updates } = bancoFalso(GUARDADA, { menu: "inexistente" });

    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: false, motivo: "menu_invalido" });
    expect(updates()).toHaveLength(0);
    expect(roteiro(consultas)).toEqual(["begin", PRAZO, "trava do número", "trava do menu", "rollback"]);
  });

  it("menu com a fala pendente: conferido SOB a trava, recusado e desfeito, sem escrita", async () => {
    const { db, consultas, updates } = bancoFalso(GUARDADA, { menu: "pendente" });

    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({
      ok: false,
      motivo: "menu_com_fala_pendente",
    });
    expect(updates()).toHaveLength(0);
    expect(roteiro(consultas)).toEqual(["begin", PRAZO, "trava do número", "trava do menu", "situação do menu", "rollback"]);
  });

  it("a trava do menu além do prazo (55P03): gravacao_em_andamento, sem escrita — e a conexão volta ao pool", async () => {
    const { db, updates, liberadas } = bancoFalso(GUARDADA, {
      menu: "pronto",
      erroNaTrava: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    });

    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({
      ok: false,
      motivo: "gravacao_em_andamento",
    });
    expect(updates()).toHaveLength(0);
    expect(liberadas()).toBe(1);
  });

  it("escolher um TIME sem mandar menu_id tira o menu guardado (a regra mora no UPDATE), sem travar menu nenhum", async () => {
    const { db, consultas, updates } = bancoFalso({ ...GUARDADA, menu_id: MENU }, { depois: { time_id: TIME, menu_id: null } });

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ time_id: TIME }));

    expect(r).toEqual({ ok: true, destino: { de: { time_id: null, menu_id: MENU }, para: { time_id: TIME, menu_id: null } } });
    expect(updates()[0]!.params[13]).toBe(false);
    expect(updates()[0]!.sql).toMatch(/when \$10::uuid is not null then null/);
    expect(roteiro(consultas)).toEqual(["time (pool)", "begin", PRAZO, "trava do número", "update", "commit"]);
  });

  it("menu_id ausente (aba antiga) mantém o menu guardado: o UPDATE devolve o destino que ficou", async () => {
    const { db, updates } = bancoFalso({ ...GUARDADA, menu_id: MENU }, { depois: { time_id: null, menu_id: MENU } });

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Outro nome" }));

    expect(r).toMatchObject({ ok: true });
    expect(r.ok && destinoMudou(r.destino)).toBe(false);
    expect(updates()[0]!.params[13]).toBe(false);
    expect(updates()[0]!.sql).toMatch(/else sip_menu_id end/);
  });

  it("número de outra organização (ou arquivado): nao_encontrado, desfeito, sem travar menu", async () => {
    const { db, consultas, updates } = bancoFalso(null, { menu: "pronto" });

    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(updates()).toHaveLength(0);
    expect(roteiro(consultas)).toEqual(["begin", PRAZO, "trava do número", "rollback"]);
  });

  it.each([
    ["a FK composta do menu", { code: "23503", constraint: "channel_sessions_sip_menu_id_org_fkey" }, "menu_invalido"],
    ["a FK do time", { code: "23503", constraint: "channel_sessions_sip_team_id_fkey" }, "time_invalido"],
    ["o CHECK de destino", { code: "23514", constraint: "channel_sessions_sip_destino_check" }, "destino_duplo"],
    ["a unicidade da conta", { code: "23505", constraint: "channel_sessions_sip_conta_unique" }, "conta_ja_usada"],
  ] as const)("o banco recusa pela %s: a recusa vira mensagem, não 500", async (_nome, erro, motivo) => {
    const { db } = bancoFalso(GUARDADA, { menu: "pronto", erroNaEscrita: erro });
    expect(await atualizarNumero(db, ORG, NUMERO, entrada({ menu_id: MENU }))).toEqual({ ok: false, motivo });
  });

  it("criar apontando para um menu pronto: trava do menu antes do INSERT, na transação, e o INSERT leva o menu ($12)", async () => {
    const { db, consultas, inserts } = bancoFalso(GUARDADA, { menu: "pronto" });

    const r = await criarNumero(db, ORG, entrada({ senha: "segredo-de-teste", menu_id: MENU }));

    expect(r).toEqual({ ok: true, id: NUMERO });
    expect(roteiro(consultas)).toEqual(["begin", PRAZO, "trava do menu", "situação do menu", "insert", "commit"]);
    expect(inserts()[0]!.sql).toMatch(/sip_dial_prefix, sip_menu_id\)/);
    expect(inserts()[0]!.params[11]).toBe(MENU);
  });

  it("criar com menu pendente, inexistente ou com time E menu: recusado sem INSERT", async () => {
    for (const [menu, corpo, motivo] of [
      ["pendente", { menu_id: MENU }, "menu_com_fala_pendente"],
      ["inexistente", { menu_id: MENU }, "menu_invalido"],
      ["pronto", { menu_id: MENU, time_id: TIME }, "destino_duplo"],
    ] as const) {
      const { db, inserts } = bancoFalso(GUARDADA, { menu });
      expect(await criarNumero(db, ORG, entrada({ senha: "segredo-de-teste", ...corpo })), menu).toEqual({ ok: false, motivo });
      expect(inserts(), menu).toHaveLength(0);
    }
  });

  it("criar com um time: sem trava de menu, e o INSERT grava menu nulo", async () => {
    const { db, consultas, inserts } = bancoFalso(GUARDADA);

    expect(await criarNumero(db, ORG, entrada({ senha: "segredo-de-teste", time_id: TIME }))).toEqual({ ok: true, id: NUMERO });
    expect(roteiro(consultas)).toEqual(["time (pool)", "begin", PRAZO, "insert", "commit"]);
    expect(inserts()[0]!.params[11]).toBeNull();
  });

  it("destinoMudou compara time e menu", () => {
    const d = (time_id: string | null, menu_id: string | null) => ({ time_id, menu_id });
    expect(destinoMudou({ de: d(TIME, null), para: d(TIME, null) })).toBe(false);
    expect(destinoMudou({ de: d(TIME, null), para: d(null, MENU) })).toBe(true);
    expect(destinoMudou({ de: d(null, MENU), para: d(null, null) })).toBe(true);
  });

  it("as mensagens novas existem, e a trava ocupada é 409", () => {
    expect(MENSAGEM_DA_FALHA.menu_com_fala_pendente).toMatch(/ainda não está pronta/);
    expect(MENSAGEM_DA_FALHA.destino_duplo).toMatch(/um time ou um menu/);
    expect(MENSAGEM_DA_FALHA.menu_invalido).toMatch(/arquivado/);
    expect(MENSAGEM_DA_FALHA.gravacao_em_andamento).toMatch(/Tente de novo/);
    expect(statusDaFalhaDoCadastro("gravacao_em_andamento")).toBe(409);
    expect(statusDaFalhaDoCadastro("nao_encontrado")).toBe(404);
    expect(statusDaFalhaDoCadastro("menu_com_fala_pendente")).toBe(422);
  });
});
