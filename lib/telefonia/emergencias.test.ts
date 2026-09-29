// @vitest-environment node
/**
 * O AVISO DE INSTABILIDADE NA CAMADA DE BANCO — o Zod, ligar em DUAS FASES,
 * desligar e a leitura que a faixa e o cartão usam.
 *
 * O que se prova aqui, num banco em memória que imita a transação (o `begin`
 * fotografa o estado, o `rollback` o devolve):
 *  - recusa barata antes de tudo: time de outra organização ou arquivado e prévia
 *    desatualizada não abrem transação; o time de fora nem lê o Storage;
 *  - o texto SALVO, sem mudança, liga sem ir ao Storage (nem que ele trave ou
 *    lance) — num incidente o gerente liga o aviso de qualquer jeito;
 *  - o texto NOVO confere a prévia no Storage com prazo (5 s), e desiste no prazo
 *    com `armazenamento`, abortando o pedido;
 *  - o Storage é lido ANTES da conexão da transação — nunca com a trava segura;
 *  - a transação tem prazo de trava, trava a linha do TIME com `for no key update`,
 *    DECIDE DE NOVO com a fala relida sob a trava (outra gravação no meio não deixa
 *    linha órfã) e grava fala e time juntos — recusa ou erro desfazem tudo;
 *  - `55P03` vira `gravacao_em_andamento`;
 *  - desligar só mexe no aviso VIGENTE (o vencido é da passada do worker), também
 *    no time arquivado;
 *  - a leitura calcula "ativa" contra o relógio pedido, traz o aviso vigente de
 *    time ARQUIVADO (para alguém desligar), só pede o nome de quem ligou um aviso
 *    vigente — e a faixa de quem não é gerente recebe só time, prazo e arquivado;
 *  - D15: o módulo não carrega o cliente da ElevenLabs.
 * O SQL de verdade (a trava que não segura a ligação, a concorrência, o CHECK) é
 * medido em Postgres real em tests/invariants/telefonia-aviso-no-banco.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import {
  PRAZO_DO_STORAGE_AO_LIGAR_MS,
  avisosDaOrg,
  avisosLigados,
  desligarAvisoDoTime,
  ligarAvisoDoTime,
  ligarAvisoSchema,
  naFaixa,
  travarTimeDoAviso,
  type PedidoDeLigarAviso,
} from "./emergencias";
import { caminhoDaFala, hashDaFala, type ConexaoDaTransacao, type LinhaDaFala } from "./falas";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
/** D15: a fábrica LANÇA ao ser carregada — se emergencias.ts a alcançasse, este arquivo inteiro ficaria vermelho. */
vi.mock("@/lib/telefonia/elevenlabs", () => {
  throw new Error("lib/telefonia/emergencias.ts carregou o cliente da ElevenLabs (D15)");
});

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const TIME = "44444444-4444-4444-8444-44444444444a";
const TIME_2 = "44444444-4444-4444-8444-44444444444b";
const TIME_ARQUIVADO = "44444444-4444-4444-8444-44444444444c";
const TIME_DE_FORA = "44444444-4444-4444-8444-44444444444d";
const ANA = "11111111-1111-4111-8111-11111111111a";
const BRUNO = "11111111-1111-4111-8111-11111111111b";
const VOZ = { voice_id: "voz-1", model_id: "eleven_multilingual_v2" };
const TEXTO = "Estamos com instabilidade no sistema. Já estamos resolvendo.";
const HASH = hashDaFala(TEXTO, VOZ.voice_id, VOZ.model_id);
const TEXTO_NOVO = "Instabilidade na internet da região. Previsão de volta: 16h.";
const HASH_NOVO = hashDaFala(TEXTO_NOVO, VOZ.voice_id, VOZ.model_id);
const AGORA = new Date("2026-09-28T13:00:00.000Z");
const DUAS_HORAS = new Date(AGORA.getTime() + 2 * 3_600_000);

type Fala = LinhaDaFala & { organization_id: string };
interface Time {
  org: string;
  nome: string;
  arquivado: boolean;
  falaId: string | null;
  desde: Date | null;
  expira: Date | null;
  ativadoPor: string | null;
}
interface Estado {
  times: Map<string, Time>;
  falas: Map<string, Fala>;
}
type ErroDoBanco = Error & { code?: string };

/**
 * O banco em memória: as consultas de `emergencias.ts` e `falas.ts`, pelo pool
 * (fase 1) e pela conexão (fase 2). `eventos` registra, em ordem, leitura do
 * Storage, conexão, comandos de transação e devolução — é com ele que se prova
 * "Storage antes da conexão".
 */
class Banco {
  estado: Estado = {
    times: new Map<string, Time>([
      [TIME, { org: ORG, nome: "Suporte", arquivado: false, falaId: null, desde: null, expira: null, ativadoPor: null }],
      [TIME_2, { org: ORG, nome: "Financeiro", arquivado: false, falaId: null, desde: null, expira: null, ativadoPor: null }],
      [TIME_ARQUIVADO, { org: ORG, nome: "Antigo", arquivado: true, falaId: null, desde: null, expira: null, ativadoPor: null }],
      [TIME_DE_FORA, { org: OUTRA, nome: "De fora", arquivado: false, falaId: null, desde: null, expira: null, ativadoPor: null }],
    ]),
    falas: new Map(),
  };
  vozes = new Map<string, { voice_id: string; model_id: string }>([[ORG, VOZ]]);
  eventos: string[] = [];
  naTransacao: string[] = [];
  liberacoes: Array<Error | undefined> = [];
  falhar: { quando: RegExp; erro: ErroDoBanco } | null = null;
  /** Roda logo ANTES do `select ... for no key update` do time: o que outra gravação fez entre a conferência e a trava. */
  antesDaTrava: ((e: Estado) => void) | null = null;
  private foto: Estado | null = null;
  private seq = 0;

  private clonar(e: Estado): Estado {
    return {
      times: new Map([...e.times].map(([k, v]) => [k, { ...v }])),
      falas: new Map([...e.falas].map(([k, v]) => [k, { ...v }])),
    };
  }

  novaFala(org: string, texto: string, hash: string, duracao = 200): Fala {
    const f: Fala = {
      id: `fala-${++this.seq}`,
      organization_id: org,
      tipo: "emergency",
      texto,
      voice_id: VOZ.voice_id,
      model_id: VOZ.model_id,
      content_hash: hash,
      storage_path: caminhoDaFala(org, hash),
      duracao_ms: duracao,
      status: "ready",
      erro: null,
      atualizada_em: new Date("2026-09-27T10:00:00Z"),
    };
    this.estado.falas.set(f.id, f);
    return f;
  }

  private async executar(sqlBruto: string, p: unknown[], via: "pool" | "conexao") {
    const s = sqlBruto.replace(/\s+/g, " ").trim();
    const vazio = { rows: [] as unknown[], rowCount: 0 };
    const linhas = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (via === "conexao") this.naTransacao.push(s);
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
      if (this.foto) this.estado = this.foto;
      this.foto = null;
      return vazio;
    }
    if (s.startsWith("set local lock_timeout")) return vazio;
    if (s.startsWith("select id, name as nome, phone_emergency_prompt_id as fala_id")) {
      if (s.endsWith("for no key update")) this.antesDaTrava?.(this.estado);
      const t = this.estado.times.get(p[0] as string);
      if (!t || t.org !== p[1]) return vazio;
      return linhas([
        {
          id: p[0],
          nome: t.nome,
          fala_id: t.falaId,
          desde: t.desde,
          expira_em: t.expira,
          ativado_por: t.ativadoPor,
          arquivado: t.arquivado,
        },
      ]);
    }
    if (s.startsWith("select id as team_id, name as time_nome")) {
      // O time ativo, e o arquivado que ainda tem o aviso na linha (a leitura decide se é vigente).
      const rows = [...e.times]
        .filter(([, t]) => t.org === p[0] && (!t.arquivado || t.desde !== null))
        .sort(([, a], [, b]) => a.nome.localeCompare(b.nome))
        .map(([id, t]) => ({
          team_id: id,
          time_nome: t.nome,
          desde: t.desde,
          expira_em: t.expira,
          ligada_por_id: t.ativadoPor,
          fala_id: t.falaId,
          arquivado: t.arquivado,
        }));
      return linhas(rows);
    }
    if (s.startsWith("select voice_id, model_id from phone_settings")) {
      const v = this.vozes.get(p[0] as string);
      return linhas(v ? [v] : []);
    }
    if (s.startsWith("select") && s.includes("from phone_prompts where id = $1 and organization_id = $2")) {
      const f = e.falas.get(p[0] as string);
      return linhas(f && f.organization_id === p[1] ? [f] : []);
    }
    if (s.startsWith("select") && s.includes("from phone_prompts where organization_id = $1 and id = any")) {
      const ids = p[1] as string[];
      return linhas(ids.map((id) => e.falas.get(id)).filter((f) => f && f.organization_id === p[0]));
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
    if (s.startsWith("update attendance_teams set phone_emergency_prompt_id")) {
      const t = e.times.get(p[0] as string);
      if (!t || t.org !== p[1]) return vazio;
      Object.assign(t, { falaId: p[2], desde: p[3], expira: p[4], ativadoPor: p[5] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("update attendance_teams set phone_emergency_active_since = null")) {
      const t = e.times.get(p[0] as string);
      if (!t || t.org !== p[1]) return vazio;
      Object.assign(t, { desde: null, expira: null, ativadoPor: null });
      return { rows: [], rowCount: 1 };
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
  /** `trava`: o Storage não responde nunca; `lanca`: o Storage falha. */
  modo: "normal" | "trava" | "lanca" = "normal";
  sinais: Array<AbortSignal | undefined> = [];
  chamadas = 0;
  constructor(private readonly banco: Banco) {}
  guardar(org: string, hash: string, bytes = 1600) {
    this.objetos.set(caminhoDaFala(org, hash), new Uint8Array(bytes));
  }
  baixar = async (caminho: string, opcoes?: { signal?: AbortSignal }) => {
    this.chamadas++;
    this.sinais.push(opcoes?.signal);
    this.banco.eventos.push(`storage:${caminho}`);
    if (this.modo === "trava") return new Promise<never>(() => undefined);
    if (this.modo === "lanca") throw new Error("armazem_download: StorageApiError 503");
    return this.objetos.get(caminho) ?? null;
  };
}

let banco: Banco;
let armazem: Armazem;

const pedido = (p: Partial<PedidoDeLigarAviso> = {}): PedidoDeLigarAviso => ({
  pool: banco.pool,
  armazem,
  organizationId: ORG,
  userId: ANA,
  teamId: TIME,
  fala: { texto: TEXTO, hash: HASH },
  desde: AGORA,
  expiraEm: DUAS_HORAS,
  ...p,
});
const falasDoTipo = () => [...banco.estado.falas.values()].filter((f) => f.organization_id === ORG);
const time = (id = TIME) => banco.estado.times.get(id)!;
const comandosDaTransacao = () => banco.naTransacao.map((c) => c.split(" ").slice(0, 3).join(" "));

beforeEach(() => {
  banco = new Banco();
  armazem = new Armazem(banco);
  armazem.guardar(ORG, HASH);
  armazem.guardar(ORG, HASH_NOVO, 800);
});

describe("ligarAvisoSchema", () => {
  it("a duração padrão é 2 h; as quatro da lista passam; outra não", () => {
    const fala = { texto: TEXTO, hash: HASH };
    expect(ligarAvisoSchema.parse({ fala }).duracao).toBe("2h");
    for (const duracao of ["1h", "2h", "4h", "indefinida"]) expect(ligarAvisoSchema.parse({ fala, duracao }).duracao).toBe(duracao);
    expect(ligarAvisoSchema.safeParse({ fala, duracao: "3h" }).success).toBe(false);
  });

  it("strict: organização, time ou caminho no corpo são recusados; texto vazio ou com NUL também", () => {
    const fala = { texto: TEXTO, hash: HASH };
    expect(ligarAvisoSchema.safeParse({ fala, organization_id: OUTRA }).success).toBe(false);
    expect(ligarAvisoSchema.safeParse({ fala, team_id: TIME }).success).toBe(false);
    expect(ligarAvisoSchema.safeParse({ fala: { ...fala, caminho: "x/y.ulaw" } }).success).toBe(false);
    expect(ligarAvisoSchema.safeParse({ fala: { texto: "   ", hash: HASH } }).success).toBe(false);
    expect(ligarAvisoSchema.safeParse({ fala: { texto: "a\u0000b", hash: HASH } }).success).toBe(false);
    expect(ligarAvisoSchema.safeParse({}).success).toBe(false);
  });
});

describe("ligarAvisoDoTime — fase 1, fora da transação", () => {
  it("time de outra organização ou inexistente: nao_encontrado, sem Storage e sem transação", async () => {
    for (const teamId of [TIME_DE_FORA, "44444444-4444-4444-8444-444444444440"]) {
      expect(await ligarAvisoDoTime(pedido({ teamId }))).toEqual({ ok: false, motivo: "nao_encontrado" });
    }
    expect(banco.eventos).toEqual([]);
    expect(time(TIME_DE_FORA).desde).toBeNull();
  });

  it("time ARQUIVADO: recusa própria (time_arquivado), sem Storage e sem transação", async () => {
    expect(await ligarAvisoDoTime(pedido({ teamId: TIME_ARQUIVADO }))).toEqual({ ok: false, motivo: "time_arquivado" });
    expect(banco.eventos).toEqual([]);
    expect(time(TIME_ARQUIVADO).desde).toBeNull();
  });

  it("a prévia é de outro texto (editado depois dela): previa_desatualizada, sem transação", async () => {
    const r = await ligarAvisoDoTime(pedido({ fala: { texto: TEXTO_NOVO, hash: HASH } }));
    expect(r).toEqual({ ok: false, motivo: "previa_desatualizada" });
    expect(banco.eventos).not.toContain("connect");
    expect(time().desde).toBeNull();
  });

  it("a prévia sumiu do Storage: previa_ausente, sem transação — o caminho é o da organização da SESSÃO", async () => {
    armazem.objetos.clear();
    expect(await ligarAvisoDoTime(pedido())).toEqual({ ok: false, motivo: "previa_ausente" });
    expect(banco.eventos).toEqual([`storage:${caminhoDaFala(ORG, HASH)}`]);
  });

  it("organização sem voz escolhida: sem_voz", async () => {
    banco.vozes.clear();
    expect(await ligarAvisoDoTime(pedido())).toEqual({ ok: false, motivo: "sem_voz" });
    expect(banco.eventos).not.toContain("connect");
  });
});

describe("ligarAvisoDoTime — o Storage num incidente", () => {
  const comFalaSalva = () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    time().falaId = f.id;
    return f;
  };

  it.each(["trava", "lanca"] as const)(
    "texto SALVO, sem mudança, com o Storage que %s: liga com a fala em uso e o Storage é chamado 0 vezes",
    async (modo) => {
      const f = comFalaSalva();
      armazem.modo = modo;
      const r = await ligarAvisoDoTime(pedido());
      expect(r).toMatchObject({ ok: true, mudou: false, fala: { id: f.id, hash: HASH } });
      expect(armazem.chamadas).toBe(0);
      expect(time()).toMatchObject({ falaId: f.id, desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    },
  );

  it("texto NOVO com o Storage que não responde: desiste no prazo com `armazenamento`, aborta o pedido e não abre transação", async () => {
    comFalaSalva();
    armazem.modo = "trava";
    const inicio = Date.now();
    const r = await ligarAvisoDoTime(pedido({ fala: { texto: TEXTO_NOVO, hash: HASH_NOVO }, prazoDoStorageMs: 30 }));
    expect(r).toEqual({ ok: false, motivo: "armazenamento" });
    expect(Date.now() - inicio).toBeLessThan(1_000);
    expect(armazem.sinais[0]!.aborted).toBe(true);
    expect(banco.eventos).not.toContain("connect");
    expect(time().desde).toBeNull();
  });

  it("o prazo padrão da conferência é 5 s: aos 4,999 s ainda espera, aos 5 s desiste", async () => {
    expect(PRAZO_DO_STORAGE_AO_LIGAR_MS).toBe(5_000);
    vi.useFakeTimers();
    try {
      armazem.modo = "trava";
      let fim: unknown = "esperando";
      void ligarAvisoDoTime(pedido()).then((r) => (fim = r));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fim).toBe("esperando");
      await vi.advanceTimersByTimeAsync(1);
      expect(fim).toEqual({ ok: false, motivo: "armazenamento" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("texto NOVO com o Storage que falha: `armazenamento`, sem transação", async () => {
    armazem.modo = "lanca";
    expect(await ligarAvisoDoTime(pedido())).toEqual({ ok: false, motivo: "armazenamento" });
    expect(banco.eventos).not.toContain("connect");
  });
});

describe("ligarAvisoDoTime — fase 2, a transação sob a trava do time", () => {
  it("primeira vez: Storage ANTES da conexão; prazo, trava FOR NO KEY UPDATE, fala nova e time ligados juntos", async () => {
    const r = await ligarAvisoDoTime(pedido());
    expect(r).toMatchObject({ ok: true, time: { id: TIME, nome: "Suporte" }, mudou: true, anterior: null });
    if (!r.ok) throw new Error("devia ligar");
    expect(r.fala).toMatchObject({ tipo: "emergency", texto: TEXTO, hash: HASH, status: "ready", duracao_ms: 200 });

    expect(banco.eventos).toEqual([`storage:${caminhoDaFala(ORG, HASH)}`, "connect", "begin", "commit", "release"]);
    expect(banco.naTransacao[1]).toBe("set local lock_timeout = '4s'");
    expect(banco.naTransacao[2]).toMatch(/^select id, name as nome, .* from attendance_teams where id = \$1 and organization_id = \$2 for no key update$/);
    expect(comandosDaTransacao().slice(3)).toEqual(["insert into phone_prompts", "update attendance_teams set", "commit"]);

    expect(time()).toMatchObject({ falaId: r.fala.id, desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    expect(falasDoTipo()).toHaveLength(1);
    expect(banco.liberacoes).toEqual([undefined]);
  });

  it("'até eu desligar': grava o prazo nulo", async () => {
    await ligarAvisoDoTime(pedido({ expiraEm: null }));
    expect(time()).toMatchObject({ desde: AGORA, expira: null });
  });

  it("o texto de antes, com a prévia de antes: liga com a MESMA fala, sem regravar e sem Storage — mudou = false", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    time().falaId = f.id;
    const r = await ligarAvisoDoTime(pedido());
    expect(r).toMatchObject({ ok: true, mudou: false, fala: { id: f.id } });
    expect(banco.eventos).toEqual(["connect", "begin", "commit", "release"]);
    // Sob a trava: relê a fala, aponta o time — e nenhum INSERT/UPDATE em phone_prompts.
    expect(comandosDaTransacao().slice(3)).toEqual(["select id, kind", "update attendance_teams set", "commit"]);
    expect(time()).toMatchObject({ falaId: f.id, desde: AGORA });
  });

  it("texto novo sobre a fala salva: a MESMA linha passa a apontar para o hash novo — nenhuma linha órfã", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    time().falaId = f.id;
    const r = await ligarAvisoDoTime(pedido({ fala: { texto: TEXTO_NOVO, hash: HASH_NOVO } }));
    expect(r).toMatchObject({ ok: true, mudou: true, fala: { id: f.id, hash: HASH_NOVO, duracao_ms: 100 } });
    expect(falasDoTipo()).toHaveLength(1);
    expect(time().falaId).toBe(f.id);
  });

  it("outra gravação criou a fala do time entre a conferência e a trava: a decisão é refeita sob a trava — uma linha só", async () => {
    // Fora da trava, o time não tinha fala: a conferência aprovou "fala nova".
    banco.antesDaTrava = (e) => {
      banco.antesDaTrava = null;
      const outra = banco.novaFala(ORG, TEXTO, HASH);
      e.times.get(TIME)!.falaId = outra.id;
    };
    const r = await ligarAvisoDoTime(pedido());
    // Sob a trava, a fala relida JÁ é esta prévia: nada a gravar, e o time aponta para ela.
    expect(r).toMatchObject({ ok: true, mudou: false });
    expect(falasDoTipo()).toHaveLength(1);
    expect(time().falaId).toBe(falasDoTipo()[0]!.id);
  });

  it("o time foi arquivado entre a conferência e a trava: time_arquivado, e nada gravado (rollback)", async () => {
    banco.antesDaTrava = (e) => {
      e.times.get(TIME)!.arquivado = true;
    };
    expect(await ligarAvisoDoTime(pedido())).toEqual({ ok: false, motivo: "time_arquivado" });
    expect(banco.eventos).toContain("rollback");
    expect(falasDoTipo()).toHaveLength(0);
    expect(time().desde).toBeNull();
  });

  it("a trava do time passou do prazo (55P03): gravacao_em_andamento, sem gravar, e a conexão volta sã ao pool", async () => {
    banco.falhar = { quando: /for no key update$/, erro: Object.assign(new Error("lock timeout"), { code: "55P03" }) };
    expect(await ligarAvisoDoTime(pedido())).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
    expect(falasDoTipo()).toHaveLength(0);
    expect(banco.liberacoes).toEqual([undefined]);
  });

  it("erro no meio (o UPDATE do time falhou): a fala já gravada é desfeita junto, e o erro sobe", async () => {
    banco.falhar = { quando: /^update attendance_teams/, erro: Object.assign(new Error("boom"), { code: "XX000" }) };
    await expect(ligarAvisoDoTime(pedido())).rejects.toThrow("boom");
    expect(falasDoTipo()).toHaveLength(0);
    expect(time().desde).toBeNull();
  });

  it("ligar por cima de um aviso que já estava lá devolve o período de antes, com QUEM o tinha ligado (a rota o audita)", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    const antes = new Date("2026-09-28T10:00:00.000Z");
    const vencia = new Date("2026-09-28T11:00:00.000Z");
    Object.assign(time(), { falaId: f.id, desde: antes, expira: vencia, ativadoPor: BRUNO });
    const r = await ligarAvisoDoTime(pedido());
    expect(r).toMatchObject({
      ok: true,
      anterior: { desde: antes.toISOString(), expiraEm: vencia.toISOString(), ligadoPor: BRUNO },
    });
    expect(time()).toMatchObject({ desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
  });
});

describe("desligarAvisoDoTime", () => {
  it("aviso vigente: trava o time (FOR NO KEY UPDATE), desliga e devolve o período; o texto fica salvo no time", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    Object.assign(time(), { falaId: f.id, desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    const r = await desligarAvisoDoTime(banco.pool, ORG, TIME, new Date(AGORA.getTime() + 60_000));
    expect(r).toEqual({
      ok: true,
      desligado: { desde: AGORA.toISOString(), expiraEm: DUAS_HORAS.toISOString(), ligadoPor: ANA },
    });
    expect(banco.naTransacao[1]).toBe("set local lock_timeout = '4s'");
    expect(banco.naTransacao[2]).toMatch(/from attendance_teams where id = \$1 and organization_id = \$2 for no key update$/);
    expect(time()).toMatchObject({ desde: null, expira: null, ativadoPor: null, falaId: f.id });
  });

  it("'até eu desligar' também desliga", async () => {
    Object.assign(time(), { desde: AGORA, expira: null, ativadoPor: ANA });
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME, DUAS_HORAS)).toEqual({
      ok: true,
      desligado: { desde: AGORA.toISOString(), expiraEm: null, ligadoPor: ANA },
    });
  });

  it("time ARQUIVADO com o aviso vigente: desliga do mesmo jeito (a faixa mostra, alguém tem de conseguir desligar)", async () => {
    Object.assign(time(TIME_ARQUIVADO), { desde: AGORA, expira: null, ativadoPor: BRUNO });
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME_ARQUIVADO, AGORA)).toEqual({
      ok: true,
      desligado: { desde: AGORA.toISOString(), expiraEm: null, ligadoPor: BRUNO },
    });
    expect(time(TIME_ARQUIVADO)).toMatchObject({ desde: null, expira: null, ativadoPor: null });
  });

  it("já estava desligado: nada muda (rollback), desligado = null", async () => {
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME, AGORA)).toEqual({ ok: true, desligado: null });
    expect(banco.naTransacao.some((c) => c.startsWith("update"))).toBe(false);
  });

  it("vencido e ainda não varrido: NÃO é desligado aqui — é da passada do worker, que audita o vencimento e avisa na Central", async () => {
    Object.assign(time(), { desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    const depois = new Date(DUAS_HORAS.getTime() + 1);
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME, depois)).toEqual({ ok: true, desligado: null });
    expect(time()).toMatchObject({ desde: AGORA, expira: DUAS_HORAS });
  });

  it("time de outra organização: nao_encontrado, sem mexer nele", async () => {
    Object.assign(time(TIME_DE_FORA), { desde: AGORA, expira: null, ativadoPor: BRUNO });
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME_DE_FORA, AGORA)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(time(TIME_DE_FORA).desde).toEqual(AGORA);
  });

  it("trava ocupada além do prazo: gravacao_em_andamento", async () => {
    Object.assign(time(), { desde: AGORA, expira: null, ativadoPor: ANA });
    banco.falhar = { quando: /for no key update$/, erro: Object.assign(new Error("lock timeout"), { code: "55P03" }) };
    expect(await desligarAvisoDoTime(banco.pool, ORG, TIME, AGORA)).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
    expect(time().desde).toEqual(AGORA);
  });
});

describe("travarTimeDoAviso", () => {
  it("devolve o time travado com o aviso dele, ou null para o de outra organização", async () => {
    Object.assign(time(), { desde: AGORA, expira: DUAS_HORAS });
    expect(await travarTimeDoAviso(banco.pool, ORG, TIME)).toEqual({
      id: TIME,
      nome: "Suporte",
      falaId: null,
      desde: AGORA,
      expiraEm: DUAS_HORAS,
      ativadoPor: null,
      arquivado: false,
    });
    expect(await travarTimeDoAviso(banco.pool, ORG, TIME_DE_FORA)).toBeNull();
  });
});

describe("avisosDaOrg — o que a faixa e o cartão leem", () => {
  it("todos os times ativos da organização, com a fala salva; 'ativa' contra o relógio pedido; o nome só de quem ligou um VIGENTE", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    Object.assign(time(), { falaId: f.id, desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    // Financeiro: vencido e ainda não varrido pelo worker — já aparece desligado.
    Object.assign(time(TIME_2), { desde: new Date("2026-09-28T09:00:00Z"), expira: new Date("2026-09-28T10:00:00Z"), ativadoPor: BRUNO });
    // O de fora está ligado, mas é de outra organização.
    Object.assign(time(TIME_DE_FORA), { desde: AGORA, expira: null, ativadoPor: BRUNO });
    const nomes = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id === ANA ? "Ana" : "Bruno"] as const)));

    const avisos = await avisosDaOrg(banco.pool, ORG, new Date(AGORA.getTime() + 60_000), nomes, "alguém da equipe");

    // O arquivado SEM aviso vigente fica de fora.
    expect(avisos.map((a) => a.time_nome)).toEqual(["Financeiro", "Suporte"]);
    expect(avisos[0]).toEqual({
      team_id: TIME_2,
      time_nome: "Financeiro",
      arquivado: false,
      ativa: false,
      desde: null,
      expira_em: null,
      ligada_por: null,
      fala: null,
    });
    expect(avisos[1]).toMatchObject({
      team_id: TIME,
      arquivado: false,
      ativa: true,
      desde: AGORA.toISOString(),
      expira_em: DUAS_HORAS.toISOString(),
      ligada_por: "Ana",
      fala: { id: f.id, texto: TEXTO, hash: HASH, tipo: "emergency" },
    });
    expect(nomes).toHaveBeenCalledTimes(1);
    expect(nomes.mock.calls[0]![0]).toEqual([ANA]);
  });

  it("sem aviso vigente, nenhum nome é pedido; sem nome (sem full_name, ou quem ligou saiu), o rótulo genérico — nunca o e-mail", async () => {
    const nomes = vi.fn(async () => new Map<string, string | null>([[ANA, null]]));
    const avisos = await avisosDaOrg(banco.pool, ORG, AGORA, nomes, "alguém da equipe");
    expect(avisos.every((a) => !a.ativa)).toBe(true);
    expect(nomes).not.toHaveBeenCalled();

    Object.assign(time(), { desde: AGORA, expira: null, ativadoPor: ANA });
    Object.assign(time(TIME_2), { desde: AGORA, expira: null, ativadoPor: null });
    const [financeiro, suporte] = await avisosDaOrg(banco.pool, ORG, AGORA, nomes, "alguém da equipe");
    expect(suporte).toMatchObject({ ativa: true, expira_em: null, ligada_por: "alguém da equipe" });
    expect(financeiro).toMatchObject({ ativa: true, ligada_por: "alguém da equipe" });
  });

  it("time ARQUIVADO com aviso vigente entra, marcado `arquivado` — a faixa segue mostrando e alguém consegue desligar", async () => {
    Object.assign(time(TIME_ARQUIVADO), { desde: AGORA, expira: DUAS_HORAS, ativadoPor: BRUNO });
    const nomes = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, "Bruno"] as const)));
    const antigo = (await avisosDaOrg(banco.pool, ORG, AGORA, nomes, "alguém da equipe")).find((a) => a.team_id === TIME_ARQUIVADO);
    expect(antigo).toMatchObject({ arquivado: true, ativa: true, expira_em: DUAS_HORAS.toISOString(), ligada_por: "Bruno" });
    // Vencido, o arquivado sai de novo.
    const depois = new Date(DUAS_HORAS.getTime() + 1);
    expect((await avisosDaOrg(banco.pool, ORG, depois, nomes, "x")).some((a) => a.team_id === TIME_ARQUIVADO)).toBe(false);
  });
});

describe("avisosLigados / naFaixa — o que QUALQUER membro recebe", () => {
  it("só os avisos vigentes (o arquivado inclusive), com time, prazo e arquivado — sem quem ligou, sem texto, sem nome pedido", async () => {
    const f = banco.novaFala(ORG, TEXTO, HASH);
    Object.assign(time(), { falaId: f.id, desde: AGORA, expira: DUAS_HORAS, ativadoPor: ANA });
    Object.assign(time(TIME_ARQUIVADO), { desde: AGORA, expira: null, ativadoPor: BRUNO });
    Object.assign(time(TIME_2), { desde: new Date("2026-09-28T09:00:00Z"), expira: new Date("2026-09-28T10:00:00Z") });

    const ligados = await avisosLigados(banco.pool, ORG, AGORA);
    expect(ligados).toEqual([
      { team_id: TIME_ARQUIVADO, time_nome: "Antigo", expira_em: null, arquivado: true },
      { team_id: TIME, time_nome: "Suporte", expira_em: DUAS_HORAS.toISOString(), arquivado: false },
    ]);
    // É leitura: nem Storage nem transação.
    expect(banco.eventos).toEqual([]);

    // A projeção da lista completa (a do gerente) dá a MESMA faixa.
    const nomes = vi.fn(async () => new Map<string, string | null>());
    expect(naFaixa(await avisosDaOrg(banco.pool, ORG, AGORA, nomes, "alguém da equipe"))).toEqual(ligados);
  });
});
