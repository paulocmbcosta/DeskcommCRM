// @vitest-environment node
/**
 * OS MENUS DE VOZ — o Zod, a gravação em DUAS FASES e a leitura.
 *
 * O que se prova aqui, num banco em memória que imita a transação (o `begin`
 * fotografa o estado, o `rollback` o devolve):
 *  - recusa barata antes de tudo: tecla repetida, time de fora e menu de outra
 *    organização não leem o Storage nem abrem transação;
 *  - as DUAS falas são conferidas antes de gravar a primeira, e o Storage é lido
 *    ANTES da conexão da transação — nunca com a trava segura;
 *  - a transação tem prazo de trava, trava a linha do menu, DECIDE DE NOVO com a
 *    fala relida sob a trava e grava fala, menu e opções juntos — recusa ou erro
 *    desfazem tudo;
 *  - `55P03` vira `gravacao_em_andamento`, a FK composta do time vira
 *    `time_invalido`, e a conexão com rollback quebrado é descartada;
 *  - D15: o módulo não carrega o cliente da ElevenLabs.
 * O SQL de verdade (FK composta, `for no key update`, "últimos 7 dias" só com ligação
 * encerrada) é medido em Postgres real em tests/invariants/telefonia-menus-no-banco.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { caminhoDaFala, hashDaFala, type ConexaoDaTransacao, type LinhaDaFala } from "./falas";
import {
  arquivarMenu,
  mensagemDoMenuEmUso,
  menuSchema,
  rotuloDoNumero,
  menusDaOrg,
  salvarMenuDaOrg,
  situacaoDoMenuParaNumero,
  teclaRepetida,
  timesValidos,
  travarMenuAtivo,
  type EntradaDoMenu,
} from "./menus";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
/**
 * D15: `lib/channels/telefonia/numeros.ts` importa `menus.ts`. Se ele (ou algo que
 * ele importe) carregasse o cliente da ElevenLabs, o caminho da ligação o alcançaria.
 * A fábrica LANÇA ao ser carregada: este arquivo inteiro ficaria vermelho.
 */
vi.mock("@/lib/telefonia/elevenlabs", () => {
  throw new Error("lib/telefonia/menus.ts carregou o cliente da ElevenLabs (D15)");
});

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const TIME_A = "44444444-4444-4444-8444-44444444444a";
const TIME_B = "44444444-4444-4444-8444-44444444444b";
const TIME_ARQUIVADO = "44444444-4444-4444-8444-44444444444c";
const TIME_DE_FORA = "44444444-4444-4444-8444-44444444444d";
const VOZ = { voice_id: "voz-1", model_id: "eleven_multilingual_v2" };
const TEXTO_MENU = "Para Suporte, digite 1. Para Financeiro, digite 2.";
const HASH_MENU = hashDaFala(TEXTO_MENU, VOZ.voice_id, VOZ.model_id);
const TEXTO_INVALIDA = "Opção inválida.";
const HASH_INVALIDA = hashDaFala(TEXTO_INVALIDA, VOZ.voice_id, VOZ.model_id);

const valido = {
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME_A }],
  time_padrao_id: TIME_A,
  fala: { texto: "Para Suporte, digite 1.", hash: "a".repeat(64) },
  fala_invalida: null,
};

type Fala = LinhaDaFala & { organization_id: string };
interface Menu {
  id: string;
  organization_id: string;
  name: string;
  prompt_id: string | null;
  invalid_prompt_id: string | null;
  default_team_id: string;
  archived: boolean;
}
interface Opcao {
  organization_id: string;
  menu_id: string;
  digit: string;
  team_id: string;
}
interface Estado {
  menus: Map<string, Menu>;
  opcoes: Opcao[];
  falas: Map<string, Fala>;
}
type ErroDoBanco = Error & { code?: string; constraint?: string };

const erroDoBanco = (code: string, constraint?: string): ErroDoBanco =>
  Object.assign(new Error(`erro ${code}`), { code, constraint });

/**
 * O banco em memória: as consultas de `menus.ts` e `falas.ts`, pelo pool (fase 1)
 * e pela conexão (fase 2). `eventos` registra, em ordem, leitura do Storage,
 * conexão, comandos de transação e devolução — é com ele que se prova "Storage
 * antes da conexão".
 */
class Banco {
  times = new Map<string, { org: string; arquivado: boolean; nome: string }>([
    [TIME_A, { org: ORG, arquivado: false, nome: "Suporte" }],
    [TIME_B, { org: ORG, arquivado: false, nome: "Financeiro" }],
    [TIME_ARQUIVADO, { org: ORG, arquivado: true, nome: "Antigo" }],
    [TIME_DE_FORA, { org: OUTRA, arquivado: false, nome: "De fora" }],
  ]);
  vozes = new Map<string, { voice_id: string; model_id: string }>([[ORG, VOZ]]);
  /** Os números (channel_sessions) e o menu que cada um toca. */
  numeros: Array<{ org: string; menu_id: string; nome: string | null; numero: string | null; arquivado: boolean }> = [];
  estado: Estado = { menus: new Map(), opcoes: [], falas: new Map() };
  eventos: string[] = [];
  naTransacao: Array<{ sql: string; params: unknown[] }> = [];
  liberacoes: Array<Error | undefined> = [];
  falhar: { quando: RegExp; erro: ErroDoBanco } | null = null;
  falharRollback = false;
  /** Roda logo ANTES do `select ... for no key update` do menu: o que outra gravação fez entre a conferência e a trava. */
  antesDaTrava: ((e: Estado) => void) | null = null;
  private foto: Estado | null = null;
  private seq = 0;

  private clonar(e: Estado): Estado {
    return {
      menus: new Map([...e.menus].map(([k, v]) => [k, { ...v }])),
      opcoes: e.opcoes.map((o) => ({ ...o })),
      falas: new Map([...e.falas].map(([k, v]) => [k, { ...v }])),
    };
  }

  private async executar(sqlBruto: string, p: unknown[], via: "pool" | "conexao") {
    const s = sqlBruto.replace(/\s+/g, " ").trim();
    const vazio = { rows: [] as unknown[], rowCount: 0 };
    const linhas = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (via === "conexao") this.naTransacao.push({ sql: s, params: p });
    if (["begin", "commit", "rollback"].includes(s)) this.eventos.push(s);
    if (this.falhar && this.falhar.quando.test(s)) throw this.falhar.erro;
    const e = this.estado;

    if (s === "begin") {
      this.foto = this.clonar(e);
      return vazio;
    }
    if (s === "commit") {
      this.foto = null;
      return vazio;
    }
    if (s === "rollback") {
      if (this.falharRollback) throw new Error("conexão morta");
      if (this.foto) this.estado = this.foto;
      this.foto = null;
      return vazio;
    }
    if (s.startsWith("set local lock_timeout")) return vazio;
    if (s.startsWith("select count(*)::int as n from attendance_teams")) {
      const ids = p[1] as string[];
      const n = ids.filter((id) => this.times.get(id)?.org === p[0] && !this.times.get(id)?.arquivado).length;
      return linhas([{ n }]);
    }
    if (s.startsWith("select id, prompt_id, invalid_prompt_id from phone_menus")) {
      if (s.endsWith("for no key update")) this.antesDaTrava?.(this.estado);
      const m = this.estado.menus.get(p[0] as string);
      return linhas(m && m.organization_id === p[1] && !m.archived ? [{ id: m.id, prompt_id: m.prompt_id, invalid_prompt_id: m.invalid_prompt_id }] : []);
    }
    if (s.startsWith("select c.display_name as nome, c.phone_number as numero from channel_sessions")) {
      return linhas(
        this.numeros.filter((n) => n.org === p[0] && n.menu_id === p[1] && !n.arquivado).map((n) => ({ nome: n.nome, numero: n.numero })),
      );
    }
    if (s.startsWith("select id, name from attendance_teams")) {
      const ids = p[1] as string[];
      return linhas(ids.filter((id) => this.times.get(id)?.org === p[0]).map((id) => ({ id, name: this.times.get(id)!.nome })));
    }
    if (s.startsWith("delete from phone_prompts where organization_id = $1 and id = any")) {
      const apagadas = (p[1] as string[]).filter((id) => e.falas.get(id)?.organization_id === p[0]);
      for (const id of apagadas) {
        e.falas.delete(id);
        // A FK `set null (coluna)` solta o menu.
        for (const m of e.menus.values()) {
          if (m.prompt_id === id) m.prompt_id = null;
          if (m.invalid_prompt_id === id) m.invalid_prompt_id = null;
        }
      }
      return linhas(apagadas.map((id) => ({ id })));
    }
    if (s.startsWith("update phone_menus set archived_at")) {
      const m = e.menus.get(p[0] as string);
      if (m && m.organization_id === p[1]) m.archived = true;
      return vazio;
    }
    if (s.startsWith("select voice_id, model_id from phone_settings")) {
      const v = this.vozes.get(p[0] as string);
      return linhas(v ? [v] : []);
    }
    if (s.startsWith("select") && s.includes("from phone_prompts where id = $1 and organization_id = $2")) {
      const f = e.falas.get(p[0] as string);
      return linhas(f && f.organization_id === p[1] ? [f] : []);
    }
    if (s.startsWith("insert into phone_prompts")) {
      const f: Fala = {
        id: `fala-${++this.seq}`,
        organization_id: p[0] as string,
        tipo: p[1] as Fala["tipo"],
        texto: p[2] as string,
        voice_id: p[3] as string,
        model_id: p[4] as string,
        content_hash: p[5] as string,
        storage_path: p[6] as string | null,
        duracao_ms: p[7] as number | null,
        status: p[8] as Fala["status"],
        erro: p[9] as string | null,
        atualizada_em: new Date("2026-09-28T13:00:00Z"),
      };
      e.falas.set(f.id, f);
      return linhas([f]);
    }
    if (s.startsWith("update phone_prompts")) {
      const f = e.falas.get(p[0] as string);
      if (!f || f.organization_id !== p[1]) return vazio;
      Object.assign(f, {
        texto: p[2], voice_id: p[3], model_id: p[4], content_hash: p[5],
        storage_path: p[6], duracao_ms: p[7], status: p[8], erro: p[9],
      });
      return linhas([f]);
    }
    if (s.startsWith("delete from phone_prompts")) {
      const f = e.falas.get(p[0] as string);
      if (f && f.organization_id === p[1]) e.falas.delete(f.id);
      return vazio;
    }
    if (s.startsWith("insert into phone_menus")) {
      const m: Menu = {
        id: `menu-${++this.seq}`,
        organization_id: p[0] as string,
        name: p[1] as string,
        default_team_id: p[2] as string,
        prompt_id: p[3] as string | null,
        invalid_prompt_id: p[4] as string | null,
        archived: false,
      };
      e.menus.set(m.id, m);
      return linhas([{ id: m.id }]);
    }
    if (s.startsWith("update phone_menus set name")) {
      const m = e.menus.get(p[0] as string);
      if (!m || m.organization_id !== p[1] || m.archived) return vazio;
      Object.assign(m, { name: p[2], default_team_id: p[3], prompt_id: p[4], invalid_prompt_id: p[5] });
      return linhas([{ id: m.id }]);
    }
    if (s.startsWith("delete from phone_menu_options")) {
      e.opcoes = e.opcoes.filter((o) => !(o.menu_id === p[0] && o.organization_id === p[1]));
      return vazio;
    }
    if (s.startsWith("insert into phone_menu_options")) {
      const novas = JSON.parse(p[2] as string) as Array<{ tecla: string; time_id: string }>;
      for (const o of novas) {
        if (this.times.get(o.time_id)?.org !== p[0]) {
          throw erroDoBanco("23503", "phone_menu_options_organization_id_team_id_fkey");
        }
        if (e.opcoes.some((x) => x.menu_id === p[1] && x.digit === o.tecla)) throw erroDoBanco("23505", "phone_menu_options_pkey");
        e.opcoes.push({ organization_id: p[0] as string, menu_id: p[1] as string, digit: o.tecla, team_id: o.time_id });
      }
      return linhas([]);
    }
    throw new Error(`consulta inesperada: ${s}`);
  }

  pool = {
    query: ((sql: string, p?: unknown[]) => this.executar(sql, p ?? [], "pool")) as unknown as Queryable["query"],
    connect: async (): Promise<ConexaoDaTransacao> => {
      this.eventos.push("connect");
      return {
        query: ((sql: string, p?: unknown[]) => this.executar(sql, p ?? [], "conexao")) as unknown as Queryable["query"],
        release: (erro?: Error) => {
          this.eventos.push("release");
          this.liberacoes.push(erro);
        },
      };
    },
  };
}

/** O Storage em memória: as prévias guardadas. 1600 bytes de μ-law = 200 ms. */
class Armazem {
  objetos = new Map<string, Uint8Array<ArrayBuffer>>();
  falharBaixar = false;
  constructor(private readonly banco: Banco) {}
  guardar(org: string, hash: string, bytes = 1600) {
    this.objetos.set(caminhoDaFala(org, hash), new Uint8Array(bytes));
  }
  baixar = async (caminho: string) => {
    this.banco.eventos.push(`storage:${caminho}`);
    if (this.falharBaixar) throw new Error("armazem_download: StorageApiError 500");
    return this.objetos.get(caminho) ?? null;
  };
}

let banco: Banco;
let armazem: Armazem;

const entrada = (e: Partial<EntradaDoMenu> = {}): EntradaDoMenu => ({
  nome: "Principal",
  aceita_ramal: false,
  opcoes: [
    { tecla: "1", time_id: TIME_A },
    { tecla: "2", time_id: TIME_B },
  ],
  time_padrao_id: TIME_A,
  fala: { texto: TEXTO_MENU, hash: HASH_MENU },
  fala_invalida: null,
  ...e,
});
const salvar = (e: Partial<EntradaDoMenu> = {}, id: string | null = null, organizationId = ORG) =>
  salvarMenuDaOrg({ pool: banco.pool, armazem, organizationId, userId: "user-1", id, entrada: entrada(e) });
const comandosDaTransacao = () => banco.naTransacao.map((c) => c.sql.split(" ").slice(0, 3).join(" "));

beforeEach(() => {
  banco = new Banco();
  armazem = new Armazem(banco);
  armazem.guardar(ORG, HASH_MENU);
  armazem.guardar(ORG, HASH_INVALIDA, 800);
});

describe("menuSchema", () => {
  it("aceita o menu válido; sem fala de tecla inválida, ela é null", () => {
    expect(menuSchema.parse(valido).fala_invalida).toBeNull();
    expect(menuSchema.parse({ ...valido, fala_invalida: undefined }).fala_invalida).toBeNull();
  });

  it.each([
    ["tecla reservada", { ...valido, opcoes: [{ tecla: "*", time_id: TIME_A }] }],
    ["tecla de dois dígitos", { ...valido, opcoes: [{ tecla: "10", time_id: TIME_A }] }],
    ["sem opção", { ...valido, opcoes: [] }],
    ["campo que não existe", { ...valido, aceita_ramal: true }],
    ["a organização no corpo", { ...valido, organization_id: OUTRA }],
    ["fala vazia", { ...valido, fala: { texto: "  ", hash: "a".repeat(64) } }],
    ["fala sem o hash da prévia", { ...valido, fala: { texto: "Oi." } }],
    ["caminho no lugar do hash", { ...valido, fala: { texto: "Oi.", hash: "outra-org/x.ulaw" } }],
    ["mais de 10 opções", { ...valido, opcoes: Array.from({ length: 11 }, () => ({ tecla: "1", time_id: TIME_A })) }],
    ["time que não é uuid", { ...valido, time_padrao_id: "suporte" }],
    ["nome acima de 80", { ...valido, nome: "x".repeat(81) }],
  ])("recusa: %s", (_caso, e) => {
    expect(menuSchema.safeParse(e).success).toBe(false);
  });
});

describe("teclaRepetida e timesValidos", () => {
  it("a mesma tecla para dois times é repetida", () => {
    expect(teclaRepetida([{ tecla: "1" }, { tecla: "1" }])).toBe(true);
    expect(teclaRepetida([{ tecla: "1" }, { tecla: "2" }])).toBe(false);
  });

  it("time da organização e não arquivado; o time padrão igual ao de uma opção conta uma vez", async () => {
    expect(await timesValidos(banco.pool, ORG, [TIME_A, TIME_B, TIME_A])).toBe(true);
    expect(await timesValidos(banco.pool, ORG, [TIME_A, TIME_ARQUIVADO])).toBe(false);
    expect(await timesValidos(banco.pool, ORG, [TIME_A, TIME_DE_FORA])).toBe(false);
  });
});

describe("salvarMenuDaOrg — conferir fora da transação, gravar tudo junto sob a trava", () => {
  it("tecla repetida, time de fora ou arquivado, menu de outra organização: recusa sem ler o Storage nem abrir transação", async () => {
    expect(await salvar({ opcoes: [{ tecla: "1", time_id: TIME_A }, { tecla: "1", time_id: TIME_B }] })).toEqual({
      ok: false,
      motivo: "tecla_repetida",
    });
    expect(await salvar({ opcoes: [{ tecla: "1", time_id: TIME_DE_FORA }] })).toEqual({ ok: false, motivo: "time_invalido" });
    expect(await salvar({ time_padrao_id: TIME_ARQUIVADO })).toEqual({ ok: false, motivo: "time_invalido" });
    const criado = await salvar();
    expect(criado.ok).toBe(true);
    banco.eventos = [];
    expect(await salvar({}, criado.ok ? criado.id : "", OUTRA)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(banco.eventos).toEqual([]);
  });

  it("a prévia do menu não está no Storage: previa_ausente da fala 'menu', sem transação e nada gravado", async () => {
    armazem.objetos.clear();
    expect(await salvar()).toEqual({ ok: false, motivo: "previa_ausente", fala: "menu" });
    expect(banco.eventos).not.toContain("connect");
    expect(banco.estado.falas.size).toBe(0);
    expect(banco.estado.menus.size).toBe(0);
  });

  it("Storage fora do ar: armazenamento da fala 'menu', sem transação", async () => {
    armazem.falharBaixar = true;
    expect(await salvar()).toEqual({ ok: false, motivo: "armazenamento", fala: "menu" });
    expect(banco.eventos).not.toContain("connect");
  });

  it("a fala de opção inválida não confere: nada gravado, nem a fala do menu — as duas são conferidas antes", async () => {
    const r = await salvar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_MENU } });
    expect(r).toEqual({ ok: false, motivo: "previa_desatualizada", fala: "invalida" });
    expect(banco.eventos).not.toContain("connect");
    expect(banco.estado.falas.size).toBe(0);
  });

  it("menu novo: o Storage é lido ANTES da conexão; a transação tem prazo de trava e grava falas, menu e opções com a organização da sessão", async () => {
    const r = await salvar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    expect(r).toMatchObject({ ok: true, fala: { mudou: true }, falaInvalida: { mudou: true }, falaInvalidaDescartada: null });

    const conexao = banco.eventos.indexOf("connect");
    const leiturasDoStorage = banco.eventos.flatMap((e, i) => (e.startsWith("storage:") ? [i] : []));
    expect(leiturasDoStorage).toHaveLength(2);
    expect(Math.max(...leiturasDoStorage)).toBeLessThan(conexao);
    expect(banco.eventos.slice(conexao)).toEqual(["connect", "begin", "commit", "release"]);
    expect(banco.liberacoes).toEqual([undefined]);

    expect(comandosDaTransacao()).toEqual([
      "begin",
      "set local lock_timeout",
      "insert into phone_prompts",
      "insert into phone_prompts",
      "insert into phone_menus",
      "insert into phone_menu_options",
      "select id, name",
      "commit",
    ]);
    expect(banco.naTransacao[1]!.sql).toBe("set local lock_timeout = '4s'");
    // Toda escrita leva a organização da SESSÃO.
    for (const c of banco.naTransacao.filter((x) => x.sql.startsWith("insert"))) expect(c.params[0]).toBe(ORG);

    const menu = [...banco.estado.menus.values()][0]!;
    const falas = [...banco.estado.falas.values()];
    expect(falas.map((f) => [f.tipo, f.content_hash, f.storage_path, f.duracao_ms])).toEqual([
      ["menu", HASH_MENU, `${ORG}/${HASH_MENU}.ulaw`, 200],
      ["invalid", HASH_INVALIDA, `${ORG}/${HASH_INVALIDA}.ulaw`, 100],
    ]);
    expect(menu).toMatchObject({ prompt_id: falas[0]!.id, invalid_prompt_id: falas[1]!.id, default_team_id: TIME_A });
    expect(banco.estado.opcoes.map((o) => [o.digit, o.team_id])).toEqual([
      ["1", TIME_A],
      ["2", TIME_B],
    ]);
    // O menu da resposta sai da transação, com os nomes dos times e sem número (é novo).
    expect(r.ok && r.menu).toMatchObject({
      id: menu.id,
      nome: "Principal",
      time_padrao_id: TIME_A,
      time_padrao_nome: "Suporte",
      opcoes: [
        { tecla: "1", time_id: TIME_A, time_nome: "Suporte" },
        { tecla: "2", time_id: TIME_B, time_nome: "Financeiro" },
      ],
      fala: { id: falas[0]!.id, hash: HASH_MENU },
      fala_invalida: { id: falas[1]!.id, hash: HASH_INVALIDA },
      pronto: true,
      numeros: [],
    });
    expect(banco.naTransacao.some((c) => c.sql.includes("from channel_sessions"))).toBe(false);
  });

  it("editar: o menu da resposta traz as opções em ordem de tecla e os números que o tocam, lidos na transação", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    banco.numeros.push({ org: ORG, menu_id: id, nome: "Recepção", numero: "+556136861503", arquivado: false });
    const r = await salvar({ opcoes: [{ tecla: "9", time_id: TIME_B }, { tecla: "3", time_id: TIME_A }] }, id);
    expect(r.ok && r.menu.opcoes.map((o) => o.tecla)).toEqual(["3", "9"]);
    expect(r.ok && r.menu.numeros).toEqual(["Recepção · (61) 3686-1503"]);
  });

  it("editar: trava a linha do menu ANTES de ler as falas, regrava a MESMA linha da fala e troca as opções", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    const falaId = criado.ok ? criado.fala.fala.id : "";
    const TEXTO_NOVO = "Para Suporte, digite 3.";
    const HASH_NOVO = hashDaFala(TEXTO_NOVO, VOZ.voice_id, VOZ.model_id);
    armazem.guardar(ORG, HASH_NOVO);
    banco.naTransacao = [];

    const r = await salvar({ fala: { texto: TEXTO_NOVO, hash: HASH_NOVO }, opcoes: [{ tecla: "3", time_id: TIME_B }] }, id);
    expect(r).toMatchObject({ ok: true, id, fala: { mudou: true, fala: { id: falaId, hash: HASH_NOVO } } });
    const sqls = banco.naTransacao.map((c) => c.sql);
    const trava = sqls.findIndex((s) => s.endsWith("for no key update"));
    const leituraDaFala = sqls.findIndex((s) => s.includes("from phone_prompts where id = $1"));
    expect(trava).toBe(2);
    expect(leituraDaFala).toBeGreaterThan(trava);
    expect(banco.naTransacao[trava]!.params).toEqual([id, ORG]);
    expect(banco.estado.falas.size).toBe(1);
    expect(banco.estado.opcoes.map((o) => [o.digit, o.team_id])).toEqual([["3", TIME_B]]);
  });

  it("editar sem mexer na fala (a prévia é a fala em uso): a fala não é escrita (mudou=false)", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    banco.naTransacao = [];
    const r = await salvar({ nome: "Outro nome" }, id);
    expect(r).toMatchObject({ ok: true, fala: { mudou: false } });
    expect(banco.naTransacao.some((c) => /^(insert|update) phone_prompts/.test(c.sql))).toBe(false);
    expect(banco.estado.menus.get(id)!.name).toBe("Outro nome");
  });

  it("editar tirando a fala de opção inválida: a linha dela sai na MESMA transação, depois de o menu soltá-la", async () => {
    const criado = await salvar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    const id = criado.ok ? criado.id : "";
    const invalidaId = criado.ok ? criado.falaInvalida!.fala.id : "";
    banco.naTransacao = [];
    const r = await salvar({ fala_invalida: null }, id);
    expect(r).toMatchObject({ ok: true, falaInvalida: null, falaInvalidaDescartada: invalidaId });
    const comandos = comandosDaTransacao();
    expect(comandos.indexOf("delete from phone_prompts")).toBeGreaterThan(comandos.indexOf("update phone_menus set"));
    expect(comandos.at(-1)).toBe("commit");
    expect(banco.estado.falas.has(invalidaId)).toBe(false);
    expect(banco.estado.menus.get(id)!.invalid_prompt_id).toBeNull();
  });

  it("outra gravação criou a fala de opção inválida entre a conferência e a trava: sob a trava ela é REGRAVADA, não nasce uma segunda", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    banco.antesDaTrava = (e) => {
      const f: Fala = {
        id: "fala-concorrente",
        organization_id: ORG,
        tipo: "invalid",
        texto: "Tecla errada.",
        voice_id: VOZ.voice_id,
        model_id: VOZ.model_id,
        content_hash: "c".repeat(64),
        storage_path: `${ORG}/${"c".repeat(64)}.ulaw`,
        duracao_ms: 300,
        status: "ready",
        erro: null,
        atualizada_em: new Date(),
      };
      e.falas.set(f.id, f);
      e.menus.get(id)!.invalid_prompt_id = f.id;
    };
    const r = await salvar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } }, id);
    expect(r).toMatchObject({ ok: true, falaInvalida: { mudou: true, fala: { id: "fala-concorrente", hash: HASH_INVALIDA } } });
    expect([...banco.estado.falas.values()].filter((f) => f.tipo === "invalid")).toHaveLength(1);
    expect(banco.estado.menus.get(id)!.invalid_prompt_id).toBe("fala-concorrente");
  });

  it("o menu foi arquivado entre a conferência e a trava: desfaz e responde nao_encontrado, sem gravar fala", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    const TEXTO_NOVO = "Para Suporte, digite 3.";
    const HASH_NOVO = hashDaFala(TEXTO_NOVO, VOZ.voice_id, VOZ.model_id);
    armazem.guardar(ORG, HASH_NOVO);
    banco.antesDaTrava = (e) => {
      e.menus.get(id)!.archived = true;
    };
    expect(await salvar({ fala: { texto: TEXTO_NOVO, hash: HASH_NOVO } }, id)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(banco.eventos.at(-2)).toBe("rollback");
    expect([...banco.estado.falas.values()].map((f) => f.content_hash)).toEqual([HASH_MENU]);
  });

  it("a trava está com outra gravação há mais que o prazo (55P03): gravacao_em_andamento, desfeito e a conexão devolvida", async () => {
    const criado = await salvar();
    const id = criado.ok ? criado.id : "";
    banco.falhar = { quando: /for no key update$/, erro: erroDoBanco("55P03") };
    expect(await salvar({ nome: "Outro" }, id)).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
    expect(banco.eventos.slice(-2)).toEqual(["rollback", "release"]);
    expect(banco.liberacoes.at(-1)).toBeUndefined();
    expect(banco.estado.menus.get(id)!.name).toBe("Principal");
  });

  it("o banco recusa o time pela FK composta no meio da transação: time_invalido, e a fala já criada é desfeita junto", async () => {
    banco.falhar = { quando: /^insert into phone_menu_options/, erro: erroDoBanco("23503", "phone_menu_options_organization_id_team_id_fkey") };
    expect(await salvar()).toEqual({ ok: false, motivo: "time_invalido" });
    expect(banco.estado.falas.size).toBe(0);
    expect(banco.estado.menus.size).toBe(0);
  });

  it("outra FK recusada não é disfarçada de time inválido: o erro sobe", async () => {
    banco.falhar = { quando: /^insert into phone_menus/, erro: erroDoBanco("23503", "phone_menus_organization_id_fkey") };
    await expect(salvar()).rejects.toThrow("erro 23503");
    expect(banco.estado.falas.size).toBe(0);
  });

  it("o rollback também falhou (conexão morta): ela é DESCARTADA com release(erro), e sobe o erro original", async () => {
    banco.falhar = { quando: /^insert into phone_menus/, erro: erroDoBanco("08006") };
    banco.falharRollback = true;
    await expect(salvar()).rejects.toThrow("erro 08006");
    expect(banco.liberacoes.at(-1)).toBeInstanceOf(Error);
  });

  it("sem voz escolhida: sem_voz da fala 'menu', sem ler o Storage", async () => {
    banco.vozes.clear();
    expect(await salvar()).toEqual({ ok: false, motivo: "sem_voz", fala: "menu" });
    expect(banco.eventos.some((e) => e.startsWith("storage:"))).toBe(false);
  });
});

function dbCom(respostas: Array<Record<string, unknown>[]>) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      const rows = respostas[i++] ?? [];
      return { rows, rowCount: rows.length };
    }) as unknown as Queryable["query"],
  };
  return { db, consultas };
}

const FALA_PRONTA = {
  id: "f1",
  tipo: "menu",
  texto: "Para Suporte, digite 1.",
  voice_id: "voz-1",
  hash: "a".repeat(64),
  status: "ready",
  erro: null,
  duracao_ms: 1500,
  atualizada_em: "2026-09-28T13:00:00.5+00:00",
};

describe("menusDaOrg", () => {
  it("sem menu nenhum, nem consulta as ligações", async () => {
    const { db, consultas } = dbCom([[]]);
    expect(await menusDaOrg(db, ORG)).toEqual([]);
    expect(consultas).toHaveLength(1);
  });

  it("cada menu recebe a SUA semana, somada; pronto só com as falas prontas; a data sai em ISO", async () => {
    const base = { nome: "M", time_padrao_id: TIME_A, time_padrao_nome: "Suporte", opcoes: [], fala_invalida: null, numeros: [] };
    const numeros = [
      { nome: "Recepção", numero: "+556136861503" },
      { nome: null, numero: "+556136861504" },
    ];
    const { db, consultas } = dbCom([
      [
        { ...base, id: "m1", fala: FALA_PRONTA, numeros },
        { ...base, id: "m2", fala: null },
        { ...base, id: "m3", fala: FALA_PRONTA, fala_invalida: { ...FALA_PRONTA, id: "f2", status: "failed" } },
      ],
      [
        { menu_id: "m1", menu_outcome: "chosen", menu_digit: "1", n: 4 },
        { menu_id: "m1", menu_outcome: null, menu_digit: null, n: 2 },
        { menu_id: "m2", menu_outcome: "default_no_input", menu_digit: null, n: 1 },
      ],
    ]);
    const menus = await menusDaOrg(db, ORG);
    expect(menus.map((m) => [m.id, m.pronto])).toEqual([
      ["m1", true],
      ["m2", false],
      ["m3", false],
    ]);
    expect(menus[0]!.ultimos_7_dias).toEqual({ total: 6, por_tecla: { "1": 4 }, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 2 });
    expect(menus[1]!.ultimos_7_dias.sem_escolha).toBe(1);
    expect(menus[2]!.ultimos_7_dias.total).toBe(0);
    expect(menus[0]!.fala!.atualizada_em).toBe("2026-09-28T13:00:00.500Z");
    // A lista traz o RÓTULO pronto de cada número: a tela não recalcula.
    expect(menus[0]!.numeros).toEqual(["Recepção · (61) 3686-1503", "(61) 3686-1504"]);
    expect(menus[1]!.numeros).toEqual([]);
    // As duas consultas são da organização da sessão; a da semana só vê ligações ENCERRADAS.
    expect(consultas.map((c) => c.params[0])).toEqual([ORG, ORG]);
    expect(consultas[1]!.params[1]).toEqual(["m1", "m2", "m3"]);
    expect(consultas[1]!.sql).toMatch(/status = 'ended'/);
  });
});

describe("travarMenuAtivo", () => {
  it("trava a linha do menu ativo DESTA organização (for no key update) e o devolve; de fora, arquivado ou inexistente: null", async () => {
    const { db, consultas } = dbCom([[{ id: "m", prompt_id: "f1", invalid_prompt_id: null }], []]);
    expect(await travarMenuAtivo(db, ORG, "m")).toEqual({ id: "m", prompt_id: "f1", invalid_prompt_id: null });
    expect(await travarMenuAtivo(db, OUTRA, "m")).toBeNull();
    expect(consultas[0]!.sql).toMatch(/where id = \$1 and organization_id = \$2 and archived_at is null for no key update$/);
    expect(consultas.map((c) => c.params)).toEqual([
      ["m", ORG],
      ["m", OUTRA],
    ]);
  });
});

describe("arquivarMenu — em transação: trava, confere o uso num comando SEPARADO, arquiva", () => {
  const criar = async () => {
    const r = await salvar();
    if (!r.ok) throw new Error("criar o menu devia passar");
    banco.naTransacao = [];
    banco.eventos = [];
    return r.id;
  };

  it("menu livre: prazo de trava, for no key update, o uso conferido DEPOIS num comando próprio, e só então arquiva", async () => {
    const id = await criar();
    expect(await arquivarMenu(banco.pool, ORG, id)).toMatchObject({ ok: true });
    expect(comandosDaTransacao()).toEqual([
      "begin",
      "set local lock_timeout",
      "select id, prompt_id,",
      "select c.display_name as",
      "update phone_menus set",
      "delete from phone_prompts",
      "commit",
    ]);
    expect(banco.naTransacao[2]!.sql).toMatch(/for no key update$/);
    expect(banco.naTransacao[3]!.params).toEqual([ORG, id]);
    expect(banco.naTransacao[4]!.params).toEqual([id, ORG]);
    expect(banco.estado.menus.get(id)!.archived).toBe(true);
    expect(banco.eventos.slice(-2)).toEqual(["commit", "release"]);
  });

  it("as falas do menu arquivado saem na MESMA transação (e só as dele); o menu fica, solto delas", async () => {
    const criado = await salvar({ fala_invalida: { texto: TEXTO_INVALIDA, hash: HASH_INVALIDA } });
    if (!criado.ok) throw new Error("criar devia passar");
    const outro = await salvar({ nome: "Outro" });
    const falasDoMenu = [criado.fala.fala.id, criado.falaInvalida!.fala.id];

    const r = await arquivarMenu(banco.pool, ORG, criado.id);

    expect(r.ok && [...r.falasDescartadas].sort()).toEqual([...falasDoMenu].sort());
    for (const f of falasDoMenu) expect(banco.estado.falas.has(f)).toBe(false);
    expect(banco.estado.falas.has(outro.ok ? outro.fala.fala.id : "")).toBe(true);
    expect(banco.estado.menus.get(criado.id)).toMatchObject({ archived: true, prompt_id: null, invalid_prompt_id: null });
    const apagar = banco.naTransacao.find((c) => c.sql.startsWith("delete from phone_prompts"))!;
    expect(apagar.params[0]).toBe(ORG);
  });

  it("menu que atende número: menu_em_uso com o nome e o número de cada um, desfeito, nada arquivado nem apagado", async () => {
    const id = await criar();
    banco.numeros.push(
      { org: ORG, menu_id: id, nome: "Recepção", numero: "+556136861503", arquivado: false },
      { org: ORG, menu_id: id, nome: "Antigo", numero: "+556136861504", arquivado: true },
      { org: OUTRA, menu_id: id, nome: "De fora", numero: "+556136861505", arquivado: false },
    );
    const falasAntes = banco.estado.falas.size;
    expect(await arquivarMenu(banco.pool, ORG, id)).toEqual({
      ok: false,
      motivo: "menu_em_uso",
      numeros: [{ nome: "Recepção", numero: "+556136861503" }],
    });
    expect(comandosDaTransacao().at(-1)).toBe("rollback");
    expect(banco.estado.menus.get(id)!.archived).toBe(false);
    expect(banco.estado.falas.size).toBe(falasAntes);
  });

  it("de outra organização, já arquivado ou inexistente: nao_encontrado, desfeito, sem conferir uso", async () => {
    const id = await criar();
    expect(await arquivarMenu(banco.pool, OUTRA, id)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(comandosDaTransacao().slice(-2)).toEqual(["select id, prompt_id,", "rollback"]);
    expect(await arquivarMenu(banco.pool, ORG, id)).toMatchObject({ ok: true });
    expect(await arquivarMenu(banco.pool, ORG, id)).toEqual({ ok: false, motivo: "nao_encontrado" });
  });

  it("a trava está com outra gravação além do prazo (55P03): gravacao_em_andamento, desfeito e a conexão devolvida", async () => {
    const id = await criar();
    banco.falhar = { quando: /for no key update$/, erro: erroDoBanco("55P03") };
    expect(await arquivarMenu(banco.pool, ORG, id)).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
    expect(banco.eventos.slice(-2)).toEqual(["rollback", "release"]);
    expect(banco.liberacoes.at(-1)).toBeUndefined();
  });

  it("o rollback também falhou: a conexão é DESCARTADA e o erro original sobe", async () => {
    const id = await criar();
    banco.falhar = { quando: /^update phone_menus set archived_at/, erro: erroDoBanco("08006") };
    banco.falharRollback = true;
    await expect(arquivarMenu(banco.pool, ORG, id)).rejects.toThrow("erro 08006");
    expect(banco.liberacoes.at(-1)).toBeInstanceOf(Error);
  });
});

describe("rotuloDoNumero e mensagemDoMenuEmUso", () => {
  it("o rótulo mostra o nome e o número, separados por ·, quando há os dois; só um, quando falta o outro ou o nome É o número", () => {
    expect(rotuloDoNumero({ nome: "Recepção", numero: "+556136861503" })).toBe("Recepção · (61) 3686-1503");
    expect(rotuloDoNumero({ nome: null, numero: "+5561999990000" })).toBe("(61) 99999-0000");
    expect(rotuloDoNumero({ nome: "Recepção", numero: null })).toBe("Recepção");
    expect(rotuloDoNumero({ nome: "+556136861503", numero: "+556136861503" })).toBe("(61) 3686-1503");
    expect(rotuloDoNumero({ nome: "  ", numero: "+14155550100" })).toBe("+14155550100");
  });

  it("nomeia o número (ou os números) que usam o menu, no singular e no plural", () => {
    expect(mensagemDoMenuEmUso([{ nome: "Recepção", numero: "+556136861503" }])).toBe(
      "Este menu está em uso por: Recepção · (61) 3686-1503. Troque o destino do número antes de arquivar.",
    );
    expect(
      mensagemDoMenuEmUso([
        { nome: "Recepção", numero: "+556136861503" },
        { nome: null, numero: "+556136861504" },
      ]),
    ).toBe(
      "Este menu está em uso por: Recepção · (61) 3686-1503, (61) 3686-1504. Troque o destino dos números antes de arquivar.",
    );
  });

  it("o nome do número com `$&` e `$\`` sai literal na recusa", () => {
    expect(mensagemDoMenuEmUso([{ nome: "Loja A$&B", numero: null }])).toBe(
      "Este menu está em uso por: Loja A$&B. Troque o destino do número antes de arquivar.",
    );
    expect(
      mensagemDoMenuEmUso([
        { nome: "Ana $` X", numero: null },
        { nome: "Loja A$&B", numero: null },
      ]),
    ).toBe("Este menu está em uso por: Ana $` X, Loja A$&B. Troque o destino dos números antes de arquivar.");
  });

  it("traduz o MODELO antes de pôr o rótulo: a chave do dicionário é o texto com o marcador", () => {
    const vistos: string[] = [];
    const t = (texto: string) => {
      vistos.push(texto);
      return texto.replace("Este menu está em uso por:", "Este menú está en uso por:");
    };
    expect(mensagemDoMenuEmUso([{ nome: "Recepción", numero: null }], t)).toMatch(/^Este menú está en uso por: Recepción\./);
    expect(vistos).toEqual(["Este menu está em uso por: {numero}. Troque o destino do número antes de arquivar."]);
  });
});

describe("situacaoDoMenuParaNumero", () => {
  it("inexistente, pendente ou pronto", async () => {
    expect(await situacaoDoMenuParaNumero(dbCom([[]]).db, ORG, "m")).toBe("inexistente");
    expect(await situacaoDoMenuParaNumero(dbCom([[{ pronto: false }]]).db, ORG, "m")).toBe("pendente");
    expect(await situacaoDoMenuParaNumero(dbCom([[{ pronto: true }]]).db, ORG, "m")).toBe("pronto");
  });
});
